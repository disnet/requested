// TypeScript shapes mirroring /lexicons/fyi.requested.*.json
// See those files for the authoritative schema definitions.

export const DOCUMENT_NSID = 'fyi.requested.document';
export const DOCUMENT_VERSION_NSID = 'fyi.requested.documentVersion';
export const COMMENT_NSID = 'fyi.requested.comment';
export const THREAD_RESOLUTION_NSID = 'fyi.requested.threadResolution';
export const MENTION_NSID = 'fyi.requested.mention';

// Embedded markdown lexicons owned by markpub.at (https://markpub.at). We don't
// author these — like com.atproto.repo.strongRef they're external NSIDs we
// reference. Mirrored in /lexicons/at.markpub.*.json for documentation.
export const MARKPUB_MARKDOWN_NSID = 'at.markpub.markdown';
export const MARKPUB_TEXT_NSID = 'at.markpub.text';

export type StrongRef = {
	uri: string;
	cid: string;
};

// at.markpub.text — the markdown string plus optional rich-text facets/lenses.
// We only ever populate `markdown`; facets/lenses are typed loosely because we
// neither write nor interpret them.
export type MarkpubText = {
	$type?: typeof MARKPUB_TEXT_NSID;
	markdown: string;
	facets?: unknown[];
	lenses?: unknown[];
};

// at.markpub.markdown — a markdown block with metadata about its flavor and
// renderer. Embedded as the body of a documentVersion (see `content` below).
export type MarkpubMarkdown = {
	$type?: typeof MARKPUB_MARKDOWN_NSID;
	text: MarkpubText;
	flavor?: 'gfm' | 'commonmark';
	renderingRules?: string;
	extensions?: string[];
	frontMatter?: unknown[];
};

export type DocumentRecord = {
	$type?: typeof DOCUMENT_NSID;
	title: string;
	createdAt: string;
	currentVersion?: StrongRef;
};

export type DocumentVersionRecord = {
	$type?: typeof DOCUMENT_VERSION_NSID;
	document: string;
	// Canonical body: the markdown lives inside an embedded at.markpub.markdown
	// object so it's portable across the markpub ecosystem. Always written by
	// new versions; absent on pre-markpub records (read those via `body`).
	content?: MarkpubMarkdown;
	// Legacy raw-markdown body. Read-only fallback for versions written before
	// the markpub migration; never written by new code. Use `versionMarkdown`
	// rather than reading either field directly.
	body?: string;
	createdAt: string;
	previousVersion?: StrongRef;
};

// Wraps a raw markdown string in the markpub envelope we write to every new
// documentVersion. We render with `marked` (GFM), so we declare that.
export function buildMarkpubMarkdown(markdown: string): MarkpubMarkdown {
	return {
		$type: MARKPUB_MARKDOWN_NSID,
		text: { $type: MARKPUB_TEXT_NSID, markdown },
		flavor: 'gfm',
		renderingRules: 'marked'
	};
}

// The single source of truth for reading a version's markdown: prefer the
// markpub `content`, fall back to the legacy raw `body`, else empty string.
export function versionMarkdown(value: DocumentVersionRecord): string {
	return value.content?.text?.markdown ?? value.body ?? '';
}

export type CommentSuggestion = {
	before: string;
	target: string;
	after: string;
	replacement: string;
};

export type CommentRecord = {
	$type?: typeof COMMENT_NSID;
	document: string;
	version: StrongRef;
	line?: number;
	body: string;
	parent?: StrongRef;
	suggestion?: CommentSuggestion;
	createdAt: string;
};

export type ThreadResolutionRecord = {
	$type?: typeof THREAD_RESOLUTION_NSID;
	thread: StrongRef;
	document: string;
	appliedIn?: StrongRef;
	createdAt: string;
};

// fyi.requested.mention — written by the document author when they @mention an
// account in a version body. Lives on the author's PDS; the mentioned account
// (subject) discovers it via a Constellation backlink query on `subject`.
export type MentionRecord = {
	$type?: typeof MENTION_NSID;
	subject: string;
	document: string;
	version: StrongRef;
	createdAt: string;
};
