// @mention notifications. When a document author writes `@handle.tld` in a
// version body, we write a fyi.requested.mention record (on the author's PDS)
// whose `subject` is the mentioned account's DID. The mentioned account
// discovers it via a Constellation backlink query keyed on `subject` — see
// listMentionsForSubject. The record is informational and best-effort: a failed
// write (bad handle, PDS hiccup) never blocks saving the document.

import type { Agent } from '@atproto/api';
import { marked, type Token } from 'marked';
import { fetchRecord, resolveHandleToDid, resolvePdsEndpoint } from './documents';
import { MENTION_NSID, type MentionRecord, type StrongRef } from './lexicons';
import { listBacklinks } from './constellation';

export { MENTION_NSID };
export type { MentionRecord };

export type LoadedMention = {
	uri: string;
	cid: string;
	rkey: string;
	did: string;
	value: MentionRecord;
};

// Cap on handle resolutions per save. Generous for normal docs; bounds the
// fan-out of resolveHandleToDid calls on a pathological body full of @tokens.
const MAX_MENTIONS_PER_SAVE = 20;

// Matches `@handle.tld` inside prose. The leading group rejects matches
// preceded by a word char, `@`, `.`, `/`, or `-` so we skip email local-parts
// (`name@domain`), `@@`, and handles embedded in URLs/paths. The handle itself
// is one-or-more dot-separated labels ending in an alphabetic (≥2) TLD, which
// guarantees at least one dot.
const MENTION_RE =
	/(^|[^\w@./-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/g;

// Token types whose text is not prose we want to scan for mentions: fenced /
// inline code, raw HTML, link labels + URLs, image alt/URLs, and link ref defs.
const SKIP_TOKEN_TYPES = new Set(['code', 'codespan', 'html', 'link', 'image', 'def']);

function collectFromText(text: string, out: Set<string>): void {
	MENTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MENTION_RE.exec(text)) !== null) {
		out.add(m[2].toLowerCase());
	}
}

function walkTokens(tokens: Token[] | undefined, out: Set<string>): void {
	if (!tokens) return;
	for (const token of tokens) {
		if (SKIP_TOKEN_TYPES.has(token.type)) continue;
		// If markdown.ts's inline `mention` extension is registered on the global
		// marked, `@handle` arrives as a typed token carrying the handle. Collect
		// it directly so extraction matches the rendered set regardless of whether
		// the extension has been loaded in this context.
		if (token.type === 'mention') {
			const handle = (token as { handle?: string }).handle;
			if (typeof handle === 'string') out.add(handle.toLowerCase());
			continue;
		}
		const children = (token as { tokens?: Token[] }).tokens;
		if (children && children.length > 0) {
			walkTokens(children, out);
		} else if (token.type === 'text') {
			const text = (token as { text?: string }).text;
			if (typeof text === 'string') collectFromText(text, out);
		}
	}
}

// Extract the distinct `@handle.tld` mentions from a markdown body, skipping
// code spans, link labels/URLs, and raw HTML by walking the marked token tree
// rather than regexing the raw source. Returned handles are lowercased and
// de-duplicated; they are not yet resolved to DIDs.
export function extractHandleMentions(markdown: string): string[] {
	const out = new Set<string>();
	walkTokens(marked.lexer(markdown), out);
	return [...out];
}

// Loads the author's existing mention records, folded into a map of
// document at-uri → set of already-notified subject DIDs. Used to dedupe so a
// re-save that doesn't change the mention set writes nothing.
export async function listMyMentionRecords(
	agent: Agent,
	did: string
): Promise<Map<string, Set<string>>> {
	const byDoc = new Map<string, Set<string>>();
	let cursor: string | undefined;
	do {
		const res = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection: MENTION_NSID,
			limit: 100,
			cursor
		});
		for (const r of res.data.records) {
			const v = r.value as MentionRecord;
			let set = byDoc.get(v.document);
			if (!set) {
				set = new Set<string>();
				byDoc.set(v.document, set);
			}
			set.add(v.subject);
		}
		cursor = res.data.cursor;
	} while (cursor);
	return byDoc;
}

export async function createMentionRecord(
	agent: Agent,
	did: string,
	subjectDid: string,
	documentUri: string,
	versionRef: StrongRef
): Promise<{ uri: string; cid: string }> {
	const record: MentionRecord = {
		subject: subjectDid,
		document: documentUri,
		version: versionRef,
		createdAt: new Date().toISOString()
	};
	const res = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: MENTION_NSID,
		record
	});
	return { uri: res.data.uri, cid: res.data.cid };
}

export type SyncMentionsResult = { created: string[]; failed: string[] };

// Best-effort: extract mentions from `body`, resolve each handle to a DID,
// skip the author (no self-notify) and any subject already notified for this
// document, and write a mention record for the rest. Per-handle failures are
// swallowed and reported in `failed` so a bad handle never blocks the save.
export async function syncMentionsForVersion(
	agent: Agent,
	authorDid: string,
	documentUri: string,
	versionRef: StrongRef,
	body: string
): Promise<SyncMentionsResult> {
	const handles = extractHandleMentions(body).slice(0, MAX_MENTIONS_PER_SAVE);
	if (handles.length === 0) return { created: [], failed: [] };

	const resolved = await Promise.allSettled(handles.map((h) => resolveHandleToDid(h)));

	// Distinct target DIDs, dropping the author (self-mention) and unresolvable
	// handles. Track failed handles for the caller to log.
	const targets = new Set<string>();
	const failed: string[] = [];
	for (let i = 0; i < handles.length; i++) {
		const r = resolved[i];
		if (r.status === 'fulfilled' && r.value && r.value !== authorDid) {
			targets.add(r.value);
		} else if (r.status === 'rejected') {
			failed.push(handles[i]);
		}
	}
	if (targets.size === 0) return { created: [], failed };

	// Dedupe against what we've already written for this document.
	const existing = await listMyMentionRecords(agent, authorDid).catch(
		() => new Map<string, Set<string>>()
	);
	const already = existing.get(documentUri) ?? new Set<string>();

	const created: string[] = [];
	const writes = await Promise.allSettled(
		[...targets]
			.filter((did) => !already.has(did))
			.map(async (subjectDid) => {
				await createMentionRecord(agent, authorDid, subjectDid, documentUri, versionRef);
				return subjectDid;
			})
	);
	for (const w of writes) {
		if (w.status === 'fulfilled') created.push(w.value);
	}
	return { created, failed };
}

// Discovers mentions of `subjectDid` across atproto by asking Constellation for
// every fyi.requested.mention record whose `subject` field points at the DID,
// then hydrating each from its author's PDS. Per-record failures are swallowed
// so one broken PDS can't blank the set.
export async function listMentionsForSubject(
	subjectDid: string,
	options: { signal?: AbortSignal; maxRecords?: number } = {}
): Promise<LoadedMention[]> {
	const backlinks = await listBacklinks(
		subjectDid,
		{ collection: MENTION_NSID, path: 'subject' },
		{ signal: options.signal, maxRecords: options.maxRecords }
	);
	const settled = await Promise.allSettled(
		backlinks.map(async (b): Promise<LoadedMention> => {
			const pds = await resolvePdsEndpoint(b.did);
			const rec = await fetchRecord<MentionRecord>(pds, b.did, b.collection, b.rkey);
			return { uri: rec.uri, cid: rec.cid, rkey: b.rkey, did: b.did, value: rec.value };
		})
	);
	return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}
