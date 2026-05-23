// Loads the unread-comments inbox shown on the home page. Builds the tracked
// document set from three sources (authored, commented on, viewed in this
// browser), fans out a Constellation lookup per doc to discover comments from
// any PDS, filters out the signed-in user's own comments and anything they've
// dismissed, then groups the survivors by document.
//
// The fetch is intentionally home-page-only — the header badge in
// +layout.svelte reads the cached result so it stays fast and never triggers
// a Constellation fan-out on every signed-in route.

import type { Agent } from '@atproto/api';
import { listAllCommentsOn, type LoadedComment } from './atproto/comments';
import {
	fetchDocumentSummary,
	listMyDocuments,
	parseAtUri,
	type DocumentSummary
} from './atproto/documents';
import { listMyCommentedDocs } from './atproto/comments';
import { fetchProfile, type Profile } from './atproto/profile';
import { listViewed } from './viewed-docs';
import { listDismissedSet } from './dismissed-comments';

export type InboxComment = {
	uri: string;
	cid: string;
	commenterDid: string;
	commenterHandle: string;
	body: string;
	snippet: string;
	line: number | null;
	createdAt: string;
};

export type InboxGroup = {
	docUri: string;
	docDid: string;
	docRkey: string;
	docTitle: string;
	authorHandle: string;
	comments: InboxComment[];
	mostRecentAt: string;
};

export type InboxResult = {
	groups: InboxGroup[];
	totalUnread: number;
	loadedAt: string;
	cacheKey: string;
};

const SNIPPET_MAX = 90;

// Strip the minimum amount of markdown noise so a snippet reads as one line of
// prose. We never render this as HTML — Svelte text interpolation is safe —
// so we don't need to fully sanitize, just to make it legible.
function toSnippet(body: string): string {
	const flat = body
		.replace(/```[\s\S]*?```/g, ' ') // fenced code
		.replace(/`([^`]+)`/g, '$1') // inline code
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
		.replace(/[#>*_~]/g, ' ') // markdown punctuation
		.replace(/\s+/g, ' ')
		.trim();
	if (flat.length <= SNIPPET_MAX) return flat;
	return flat.slice(0, SNIPPET_MAX - 1).trimEnd() + '…';
}

// Stable hash over the tracked-doc set; cache key combines it with viewer DID
// so a new sign-in invalidates without an explicit purge.
function hashUris(uris: string[]): string {
	const sorted = [...uris].sort();
	let h = 5381;
	for (const u of sorted) {
		for (let i = 0; i < u.length; i++) {
			h = ((h << 5) + h + u.charCodeAt(i)) | 0;
		}
	}
	return (h >>> 0).toString(36);
}

async function buildTrackedDocSet(agent: Agent, myDid: string): Promise<string[]> {
	const [authored, commented] = await Promise.all([
		listMyDocuments(agent, myDid).catch(() => [] as DocumentSummary[]),
		listMyCommentedDocs(agent, myDid).catch(() => new Map<string, string>())
	]);
	const viewed = listViewed(myDid);

	const set = new Set<string>();
	for (const d of authored) set.add(d.uri);
	for (const uri of commented.keys()) set.add(uri);
	for (const v of viewed) set.add(v.uri);
	return [...set];
}

export async function loadInbox(agent: Agent, myDid: string): Promise<InboxResult> {
	const docUris = await buildTrackedDocSet(agent, myDid);
	const dismissed = listDismissedSet(myDid);

	// Fan out per doc. Per-doc failures (PDS down, doc deleted, Constellation
	// hiccup) are isolated so one broken record can't blank the whole inbox.
	const settled = await Promise.allSettled(
		docUris.map(async (docUri): Promise<InboxGroup | null> => {
			const comments = await listAllCommentsOn(docUri, { agent, myDid });
			const unread = comments.filter((c) => c.did !== myDid && !dismissed.has(c.uri));
			if (unread.length === 0) return null;

			const { repo: docDid, rkey: docRkey } = parseAtUri(docUri);
			const [doc, authorProfile] = await Promise.all([
				fetchDocumentSummary(docDid, docRkey),
				fetchProfile(docDid).catch(() => null as Profile | null)
			]);

			// Hydrate commenter handles once per unique commenter, not per comment.
			const uniqueCommenters = [...new Set(unread.map((c) => c.did))];
			const commenterProfiles = await Promise.all(
				uniqueCommenters.map((did) => fetchProfile(did).catch(() => null as Profile | null))
			);
			const handleByDid = new Map<string, string>();
			for (let i = 0; i < uniqueCommenters.length; i++) {
				const did = uniqueCommenters[i];
				handleByDid.set(did, commenterProfiles[i]?.handle ?? did);
			}

			unread.sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));

			const inboxComments: InboxComment[] = unread.map((c: LoadedComment) => ({
				uri: c.uri,
				cid: c.cid,
				commenterDid: c.did,
				commenterHandle: handleByDid.get(c.did) ?? c.did,
				body: c.value.body,
				snippet: toSnippet(c.value.body),
				line: typeof c.value.line === 'number' ? c.value.line : null,
				createdAt: c.value.createdAt
			}));

			return {
				docUri,
				docDid,
				docRkey,
				docTitle: doc.value.title,
				authorHandle: authorProfile?.handle ?? docDid,
				comments: inboxComments,
				mostRecentAt: inboxComments[0].createdAt
			};
		})
	);

	const groups = settled
		.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
		.sort((a, b) => b.mostRecentAt.localeCompare(a.mostRecentAt));

	const totalUnread = groups.reduce((sum, g) => sum + g.comments.length, 0);

	return {
		groups,
		totalUnread,
		loadedAt: new Date().toISOString(),
		cacheKey: `${myDid}:${hashUris(docUris)}`
	};
}
