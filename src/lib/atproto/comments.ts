import type { Agent } from '@atproto/api';
import { getVersionByUri, parseAtUri } from './documents';
import { COMMENT_NSID, type CommentRecord, type StrongRef } from './lexicons';

export type LoadedComment = {
	uri: string;
	cid: string;
	rkey: string;
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

// Lists the signed-in user's own comments on a given document. Comments on
// other people's documents that are scattered across foreign PDSes need a
// backlink indexer (Constellation) — that comes in a later slice.
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
			value: r.value as CommentRecord
		}))
		.filter((c) => c.value.document === documentUri);
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

