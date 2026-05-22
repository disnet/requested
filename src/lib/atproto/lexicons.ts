// TypeScript shapes mirroring /lexicons/dev.disnet.atrfc.*.json
// See those files for the authoritative schema definitions.

export const DOCUMENT_NSID = 'dev.disnet.atrfc.document';
export const DOCUMENT_VERSION_NSID = 'dev.disnet.atrfc.documentVersion';
export const COMMENT_NSID = 'dev.disnet.atrfc.comment';

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

export type CommentRecord = {
	$type?: typeof COMMENT_NSID;
	document: string;
	version: StrongRef;
	line?: number;
	body: string;
	parent?: StrongRef;
	createdAt: string;
};
