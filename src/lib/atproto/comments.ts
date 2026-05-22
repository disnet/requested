import type { Agent } from '@atproto/api';
import { fetchRecord, getVersionByUri, parseAtUri, resolvePdsEndpoint } from './documents';
import { COMMENT_NSID, type CommentRecord, type StrongRef } from './lexicons';
import { listBacklinks } from './constellation';

export type LoadedComment = {
	uri: string;
	cid: string;
	rkey: string;
	did: string;
	value: CommentRecord;
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
	options: { line?: number; parent?: StrongRef } = {}
): Promise<{ uri: string; cid: string }> {
	const record: CommentRecord = {
		document: target.documentUri,
		version: target.version,
		body,
		createdAt: new Date().toISOString()
	};
	if (options.line != null) record.line = options.line;
	if (options.parent) record.parent = options.parent;

	const res = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: COMMENT_NSID,
		record
	});
	return { uri: res.data.uri, cid: res.data.cid };
}

// ---------- reads ----------

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
// every record in dev.disnet.atrfc.comment whose `document` field points at the
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
		return { kind: 'line-stale', shift: resolveLineShift(old.body, currentVersion.body, comment.line) };
	} catch {
		// Old version unreachable (deleted, PDS down) — fall back to "lost".
		return {
			kind: 'line-stale',
			shift: { kind: 'lost', from: comment.line, text: '' }
		};
	}
}

