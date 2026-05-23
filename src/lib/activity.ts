// Activity ledger backing the home page: merges the signed-in user's own
// comment records (queried per-PDS) with the per-device viewed-docs list, then
// fans out doc + author lookups so each row carries a real title and handle.

import type { Agent } from '@atproto/api';
import { listMyCommentedDocs } from './atproto/comments';
import { fetchDocumentSummary, parseAtUri } from './atproto/documents';
import { fetchProfile, type Profile } from './atproto/profile';
import { listViewed } from './viewed-docs';

export type ActivityEntry = {
	uri: string;
	did: string;
	rkey: string;
	title: string;
	authorHandle: string;
	tag: 'comment' | 'read';
	interactedAt: string;
};

export async function loadActivity(agent: Agent, myDid: string): Promise<ActivityEntry[]> {
	const [commented, viewed] = await Promise.all([
		listMyCommentedDocs(agent, myDid).catch(() => new Map<string, string>()),
		Promise.resolve(listViewed(myDid))
	]);

	type Candidate = { uri: string; tag: 'comment' | 'read'; interactedAt: string };
	const byUri = new Map<string, Candidate>();
	for (const v of viewed) {
		byUri.set(v.uri, { uri: v.uri, tag: 'read', interactedAt: v.viewedAt });
	}
	// Commented overrides any 'read' entry for the same uri.
	for (const [uri, createdAt] of commented) {
		byUri.set(uri, { uri, tag: 'comment', interactedAt: createdAt });
	}

	const candidates = [...byUri.values()].filter((c) => {
		try {
			return parseAtUri(c.uri).repo !== myDid;
		} catch {
			return false;
		}
	});

	const settled = await Promise.allSettled(
		candidates.map(async (c): Promise<ActivityEntry> => {
			const { repo: did, rkey } = parseAtUri(c.uri);
			const [doc, profile] = await Promise.all([
				fetchDocumentSummary(did, rkey),
				fetchProfile(did).catch(() => null as Profile | null)
			]);
			return {
				uri: c.uri,
				did,
				rkey,
				title: doc.value.title,
				authorHandle: profile?.handle ?? did,
				tag: c.tag,
				interactedAt: c.interactedAt
			};
		})
	);

	const rows = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
	rows.sort((a, b) => b.interactedAt.localeCompare(a.interactedAt));
	return rows;
}
