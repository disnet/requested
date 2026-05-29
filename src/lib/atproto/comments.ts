import type { Agent } from '@atproto/api';
import { fetchRecord, getVersionByUri, parseAtUri, resolvePdsEndpoint } from './documents';
import {
	COMMENT_NSID,
	THREAD_RESOLUTION_NSID,
	versionMarkdown,
	type CommentRecord,
	type CommentSuggestion,
	type StrongRef,
	type ThreadResolutionRecord
} from './lexicons';
import { listBacklinks } from './constellation';

export type LoadedComment = {
	uri: string;
	cid: string;
	rkey: string;
	did: string;
	value: CommentRecord;
};

export type LoadedResolution = {
	uri: string;
	cid: string;
	rkey: string;
	did: string;
	value: ThreadResolutionRecord;
};

// ---------- writes ----------

export async function createComment(
	agent: Agent,
	did: string,
	target: {
		documentUri: string;
		version: StrongRef;
	},
	body: string,
	options: { line?: number; parent?: StrongRef; suggestion?: CommentSuggestion } = {}
): Promise<{ uri: string; cid: string }> {
	const record: CommentRecord = {
		document: target.documentUri,
		version: target.version,
		body,
		createdAt: new Date().toISOString()
	};
	if (options.line != null) record.line = options.line;
	if (options.parent) record.parent = options.parent;
	if (options.suggestion) record.suggestion = options.suggestion;

	const res = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: COMMENT_NSID,
		record
	});
	return { uri: res.data.uri, cid: res.data.cid };
}

// ---------- reads ----------

// Lists every document the signed-in user has commented on, with the latest
// comment date per document. Used by the Activity ledger on `/`. Walks their
// own comment collection once and folds by `document` uri.
export async function listMyCommentedDocs(agent: Agent, did: string): Promise<Map<string, string>> {
	const latest = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const res = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection: COMMENT_NSID,
			limit: 100,
			cursor
		});
		for (const r of res.data.records) {
			const v = r.value as CommentRecord;
			const prev = latest.get(v.document);
			if (!prev || v.createdAt > prev) latest.set(v.document, v.createdAt);
		}
		cursor = res.data.cursor;
	} while (cursor);
	return latest;
}

// Lists the signed-in user's own comments on a given document by scanning their
// own repo. This is the latency-free path — Constellation's index can lag a
// freshly-written comment by tens of seconds, so listAllCommentsOn unions this
// in when an agent is available.
export async function listMyCommentsOn(
	agent: Agent,
	did: string,
	documentUri: string
): Promise<LoadedComment[]> {
	const res = await agent.com.atproto.repo.listRecords({
		repo: did,
		collection: COMMENT_NSID,
		limit: 100
	});
	return res.data.records
		.map((r) => ({
			uri: r.uri,
			cid: r.cid,
			rkey: parseAtUri(r.uri).rkey,
			did,
			value: r.value as CommentRecord
		}))
		.filter((c) => c.value.document === documentUri);
}

// Lists all comments on a document across atproto, by asking Constellation for
// every record in fyi.requested.comment whose `document` field points at the
// document's at-uri, then hydrating each one from its home PDS.
//
// Per-record failures (commenter's PDS down, record deleted between the index
// snapshot and our read, etc.) are swallowed so a single broken PDS can't take
// the whole comment list down.
export async function listCommentsViaConstellation(
	documentUri: string,
	options: { signal?: AbortSignal; maxComments?: number } = {}
): Promise<LoadedComment[]> {
	const backlinks = await listBacklinks(
		documentUri,
		{ collection: COMMENT_NSID, path: 'document' },
		{ signal: options.signal, maxRecords: options.maxComments }
	);

	const settled = await Promise.allSettled(
		backlinks.map(async (b): Promise<LoadedComment> => {
			const pds = await resolvePdsEndpoint(b.did);
			const rec = await fetchRecord<CommentRecord>(pds, b.did, b.collection, b.rkey);
			return { uri: rec.uri, cid: rec.cid, rkey: b.rkey, did: b.did, value: rec.value };
		})
	);

	return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

// Cross-PDS comment list: Constellation as the primary source, unioned with the
// signed-in user's own listRecords (when available) to mask indexing latency on
// just-posted comments. Dedupe is by at-uri.
export async function listAllCommentsOn(
	documentUri: string,
	options: { agent?: Agent | null; myDid?: string | null; signal?: AbortSignal } = {}
): Promise<LoadedComment[]> {
	const [remote, mine] = await Promise.all([
		listCommentsViaConstellation(documentUri, { signal: options.signal }),
		options.agent && options.myDid
			? listMyCommentsOn(options.agent, options.myDid, documentUri).catch(() => [])
			: Promise.resolve([] as LoadedComment[])
	]);

	const byUri = new Map<string, LoadedComment>();
	for (const c of remote) byUri.set(c.uri, c);
	for (const c of mine) byUri.set(c.uri, c);
	return [...byUri.values()];
}

// ---------- shift heuristic ----------
//
// When a comment's pinned version differs from the document's current version,
// we try to figure out where (if anywhere) the original line lives now. The
// result is purely informational — we never rewrite the comment record.

export type LineShift =
	| { kind: 'unchanged'; line: number }
	| { kind: 'shifted'; from: number; to: number; text: string }
	| { kind: 'lost'; from: number; text: string };

export function resolveLineShift(
	oldBody: string,
	newBody: string,
	originalLine: number
): LineShift {
	const oldLines = oldBody.split('\n');
	const newLines = newBody.split('\n');
	const idx = originalLine - 1;
	const oldText = oldLines[idx] ?? '';

	if (newLines[idx] === oldText) {
		return { kind: 'unchanged', line: originalLine };
	}

	// Bias toward an exact match near the original position to avoid jumping
	// to an unrelated duplicate line elsewhere in a long document.
	if (oldText.trim().length > 0) {
		let best = -1;
		let bestDist = Infinity;
		for (let i = 0; i < newLines.length; i++) {
			if (newLines[i] === oldText) {
				const dist = Math.abs(i - idx);
				if (dist < bestDist) {
					bestDist = dist;
					best = i;
				}
			}
		}
		if (best !== -1) {
			return { kind: 'shifted', from: originalLine, to: best + 1, text: oldText };
		}
	}

	return { kind: 'lost', from: originalLine, text: oldText };
}

// ---------- suggestion anchors ----------
//
// Suggestions anchor to a `before` + `target` + `after` text window rather than
// to a line number, so applying one suggestion (which mutates line offsets)
// doesn't invalidate the others. Anchors are built at write time from the
// pinned version's body and resolved against the current body at apply time.

// Default amount of surrounding context (in characters, not graphemes —
// matching the lexicon's maxLength bound) captured on each side of the target.
// Enough to make most anchors unique without bloating records; expand if the
// match isn't unique at write time.
const SUGGESTION_CONTEXT = 48;

// Builds an anchor for replacing a contiguous run of lines. Captures the lines
// between `startLine` and `endLine` (1-indexed, inclusive) as `target` and up
// to SUGGESTION_CONTEXT chars on either side from the surrounding body
// (including the separating newlines). `endLine` defaults to `startLine` for
// the common single-line case. Replacement is passed through verbatim.
export function buildSuggestionAnchor(
	body: string,
	startLine: number,
	replacement: string,
	endLine: number = startLine
): CommentSuggestion {
	const lines = body.split('\n');
	const startIdx = startLine - 1;
	const endIdx = endLine - 1;
	const target = lines.slice(startIdx, endIdx + 1).join('\n');
	const beforeFull = startIdx <= 0 ? '' : lines.slice(0, startIdx).join('\n') + '\n';
	const afterFull = endIdx >= lines.length - 1 ? '' : '\n' + lines.slice(endIdx + 1).join('\n');
	const before = beforeFull.slice(-SUGGESTION_CONTEXT);
	const after = afterFull.slice(0, SUGGESTION_CONTEXT);
	return { before, target, after, replacement };
}

// Locates the suggestion in `body`. Returns the span of `target` iff the
// combined needle (before+target+after) occurs exactly once; null otherwise
// (no match or multiple matches — both block automatic apply).
export function findSuggestionAnchor(
	body: string,
	sugg: CommentSuggestion
): { start: number; end: number } | null {
	// An all-empty target with empty context is meaningless — refuse outright
	// rather than pretending to match the empty string at offset 0.
	if (sugg.target.length === 0 && sugg.before.length === 0 && sugg.after.length === 0) {
		return null;
	}
	const needle = sugg.before + sugg.target + sugg.after;
	const first = body.indexOf(needle);
	if (first === -1) return null;
	if (body.indexOf(needle, first + 1) !== -1) return null;
	const start = first + sugg.before.length;
	return { start, end: start + sugg.target.length };
}

// Produces the body that results from applying `sugg` to `body`. Throws if the
// suggestion no longer anchors uniquely — callers should gate the action on
// `findSuggestionAnchor` first so the error path is unreachable in normal use.
export function applySuggestion(body: string, sugg: CommentSuggestion): string {
	const loc = findSuggestionAnchor(body, sugg);
	if (!loc) throw new Error('Suggestion no longer anchors uniquely to the current document.');
	return body.slice(0, loc.start) + sugg.replacement + body.slice(loc.end);
}

// ---------- threading ----------

export type Thread = {
	// The comment with no `parent` field that anchors this thread. If the actual
	// root record can't be hydrated (cross-PDS lag, deletion), the earliest
	// orphan in the chain stands in as the root so replies are never lost.
	root: LoadedComment;
	// All non-root descendants, regardless of parent depth. Sorted by createdAt
	// ascending. Per the design brief, replies render flat under the root —
	// `parent` is still authoritative in the record, but the view doesn't render
	// nested indents.
	replies: LoadedComment[];
};

// Folds a flat comment list into threads by walking each comment's `parent`
// strongRef chain until it reaches a comment with no parent (a true root) or
// an unresolvable parent (treat the current node as the root — orphan reply).
// Comments are grouped under their resolved root and replies are sorted by
// createdAt. The thread list itself is sorted by root createdAt.
export function foldThreads(comments: LoadedComment[]): Thread[] {
	const byCid = new Map<string, LoadedComment>();
	for (const c of comments) byCid.set(c.cid, c);

	function findRoot(c: LoadedComment): LoadedComment {
		let cur = c;
		const seen = new Set<string>();
		while (cur.value.parent) {
			if (seen.has(cur.cid)) break;
			seen.add(cur.cid);
			const parent = byCid.get(cur.value.parent.cid);
			if (!parent) break;
			cur = parent;
		}
		return cur;
	}

	const byRootUri = new Map<string, Thread>();
	for (const c of comments) {
		const root = findRoot(c);
		let thread = byRootUri.get(root.uri);
		if (!thread) {
			thread = { root, replies: [] };
			byRootUri.set(root.uri, thread);
		}
		if (c.uri !== root.uri) thread.replies.push(c);
	}

	for (const t of byRootUri.values()) {
		t.replies.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
	}

	return [...byRootUri.values()].sort((a, b) =>
		a.root.value.createdAt.localeCompare(b.root.value.createdAt)
	);
}

// ---------- thread resolution ----------

export async function createResolution(
	agent: Agent,
	did: string,
	thread: StrongRef,
	documentUri: string,
	options: { appliedIn?: StrongRef } = {}
): Promise<{ uri: string; cid: string }> {
	const record: ThreadResolutionRecord = {
		thread,
		document: documentUri,
		createdAt: new Date().toISOString()
	};
	if (options.appliedIn) record.appliedIn = options.appliedIn;
	const res = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: THREAD_RESOLUTION_NSID,
		record
	});
	return { uri: res.data.uri, cid: res.data.cid };
}

export async function deleteResolution(agent: Agent, did: string, rkey: string): Promise<void> {
	await agent.com.atproto.repo.deleteRecord({
		repo: did,
		collection: THREAD_RESOLUTION_NSID,
		rkey
	});
}

export async function listMyResolutionsOn(
	agent: Agent,
	did: string,
	documentUri: string
): Promise<LoadedResolution[]> {
	const res = await agent.com.atproto.repo.listRecords({
		repo: did,
		collection: THREAD_RESOLUTION_NSID,
		limit: 100
	});
	return res.data.records
		.map((r) => ({
			uri: r.uri,
			cid: r.cid,
			rkey: parseAtUri(r.uri).rkey,
			did,
			value: r.value as ThreadResolutionRecord
		}))
		.filter((r) => r.value.document === documentUri);
}

export async function listResolutionsViaConstellation(
	documentUri: string,
	options: { signal?: AbortSignal; maxRecords?: number } = {}
): Promise<LoadedResolution[]> {
	const backlinks = await listBacklinks(
		documentUri,
		{ collection: THREAD_RESOLUTION_NSID, path: 'document' },
		{ signal: options.signal, maxRecords: options.maxRecords }
	);
	const settled = await Promise.allSettled(
		backlinks.map(async (b): Promise<LoadedResolution> => {
			const pds = await resolvePdsEndpoint(b.did);
			const rec = await fetchRecord<ThreadResolutionRecord>(pds, b.did, b.collection, b.rkey);
			return { uri: rec.uri, cid: rec.cid, rkey: b.rkey, did: b.did, value: rec.value };
		})
	);
	return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

// Discover resolutions on a document across atproto, masking Constellation
// indexing latency with the signed-in user's own listRecords output. Same
// dedupe-by-uri pattern as listAllCommentsOn.
export async function listAllResolutionsOn(
	documentUri: string,
	options: { agent?: Agent | null; myDid?: string | null; signal?: AbortSignal } = {}
): Promise<LoadedResolution[]> {
	const [remote, mine] = await Promise.all([
		listResolutionsViaConstellation(documentUri, { signal: options.signal }),
		options.agent && options.myDid
			? listMyResolutionsOn(options.agent, options.myDid, documentUri).catch(() => [])
			: Promise.resolve([] as LoadedResolution[])
	]);
	const byUri = new Map<string, LoadedResolution>();
	for (const r of remote) byUri.set(r.uri, r);
	for (const r of mine) byUri.set(r.uri, r);
	return [...byUri.values()];
}

// Picks the resolution that authoritatively governs a thread's resolved state.
// Anyone can write a record with `thread = <root>`; readers only honor records
// authored by the thread's root commenter or by the document author. Among
// authorized records (both principals could resolve independently), we pick
// the most recent so the surface answers "who resolved this most recently" in
// a stable way.
export function authoritativeResolution(
	resolutions: LoadedResolution[],
	threadRoot: LoadedComment,
	documentAuthorDid: string
): LoadedResolution | null {
	const authorized = resolutions
		.filter((r) => r.value.thread.uri === threadRoot.uri)
		.filter((r) => r.did === threadRoot.did || r.did === documentAuthorDid);
	if (authorized.length === 0) return null;
	authorized.sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
	return authorized[0];
}

// The resolution record (if any) on the signed-in user's repo for this thread.
// Used by the unresolve action — you can only delete your own records, so even
// if a thread is "resolved" by someone else, the signed-in user can only
// unresolve when their own DID is the one that wrote the record.
export function myResolutionFor(
	resolutions: LoadedResolution[],
	threadRoot: LoadedComment,
	myDid: string | null
): LoadedResolution | null {
	if (!myDid) return null;
	return resolutions.find((r) => r.did === myDid && r.value.thread.uri === threadRoot.uri) ?? null;
}

// ---------- comment version state ----------

export type CommentVersionState =
	| { kind: 'current' }
	| { kind: 'doc-level-stale' }
	| { kind: 'line-stale'; shift: LineShift };

export async function describeCommentVersionState(
	comment: CommentRecord,
	currentVersion: { uri: string; cid: string; body: string }
): Promise<CommentVersionState> {
	if (comment.version.cid === currentVersion.cid) return { kind: 'current' };
	if (comment.line == null) return { kind: 'doc-level-stale' };

	try {
		const old = await getVersionByUri(comment.version.uri);
		return {
			kind: 'line-stale',
			shift: resolveLineShift(versionMarkdown(old), currentVersion.body, comment.line)
		};
	} catch {
		// Old version unreachable (deleted, PDS down) — fall back to "lost".
		return {
			kind: 'line-stale',
			shift: { kind: 'lost', from: comment.line, text: '' }
		};
	}
}
