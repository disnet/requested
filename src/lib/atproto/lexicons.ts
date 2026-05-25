// TypeScript shapes mirroring /lexicons/fyi.requested.*.json
// See those files for the authoritative schema definitions.

export const DOCUMENT_NSID = 'fyi.requested.document';
export const DOCUMENT_VERSION_NSID = 'fyi.requested.documentVersion';
export const COMMENT_NSID = 'fyi.requested.comment';
export const THREAD_RESOLUTION_NSID = 'fyi.requested.threadResolution';

export type StrongRef = {
	uri: string;
	cid: string;
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
	body: string;
	createdAt: string;
	previousVersion?: StrongRef;
};

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
