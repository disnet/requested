import type { Agent } from '@atproto/api';
import {
	DOCUMENT_NSID,
	DOCUMENT_VERSION_NSID,
	type DocumentRecord,
	type DocumentVersionRecord,
	type StrongRef
} from './lexicons';

export type DocumentSummary = {
	uri: string;
	cid: string;
	rkey: string;
	value: DocumentRecord;
};

export type LoadedDocument = {
	uri: string;
	cid: string;
	did: string;
	rkey: string;
	value: DocumentRecord;
	version: { uri: string; cid: string; value: DocumentVersionRecord } | null;
};

// ---------- at-uri helpers ----------

export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
	if (!match) throw new Error(`Invalid at-uri: ${uri}`);
	return { repo: match[1], collection: match[2], rkey: match[3] };
}

// ---------- identity resolution (unauthenticated, works for any handle) ----------

const APPVIEW = 'https://public.api.bsky.app';

export async function resolveHandleToDid(handle: string): Promise<string> {
	if (handle.startsWith('did:')) return handle;
	const url = new URL('/xrpc/com.atproto.identity.resolveHandle', APPVIEW);
	url.searchParams.set('handle', handle);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`resolveHandle ${handle}: ${res.status}`);
	return ((await res.json()) as { did: string }).did;
}

export async function resolvePdsEndpoint(did: string): Promise<string> {
	let docUrl: string;
	if (did.startsWith('did:plc:')) {
		docUrl = `https://plc.directory/${did}`;
	} else if (did.startsWith('did:web:')) {
		const domain = did.slice('did:web:'.length).replaceAll('%3A', ':');
		docUrl = `https://${domain}/.well-known/did.json`;
	} else {
		throw new Error(`Unsupported DID method: ${did}`);
	}
	const res = await fetch(docUrl);
	if (!res.ok) throw new Error(`DID doc ${did}: ${res.status}`);
	const doc = (await res.json()) as {
		service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
	};
	const service = doc.service?.find(
		(s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
	);
	if (!service?.serviceEndpoint) throw new Error(`No atproto PDS in DID doc for ${did}`);
	return service.serviceEndpoint;
}

// ---------- writes (authenticated agent) ----------

// Creating a document is three writes:
//   1. document (without currentVersion)
//   2. documentVersion (referencing the document by uri)
//   3. document (putRecord to set currentVersion)
// See lexicons/*.json for the chicken-and-egg notes that justify the shape.
export async function createDocument(
	agent: Agent,
	did: string,
	title: string,
	body: string
): Promise<{ docUri: string; docRkey: string }> {
	const createdAt = new Date().toISOString();

	const docInitial: DocumentRecord = { title, createdAt };
	const docRes = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: DOCUMENT_NSID,
		record: docInitial
	});

	const versionRecord: DocumentVersionRecord = {
		document: docRes.data.uri,
		body,
		createdAt
	};
	const versionRes = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: DOCUMENT_VERSION_NSID,
		record: versionRecord
	});

	const docFinal: DocumentRecord = {
		title,
		createdAt,
		currentVersion: { uri: versionRes.data.uri, cid: versionRes.data.cid }
	};
	await agent.com.atproto.repo.putRecord({
		repo: did,
		collection: DOCUMENT_NSID,
		rkey: parseAtUri(docRes.data.uri).rkey,
		record: docFinal
	});

	return { docUri: docRes.data.uri, docRkey: parseAtUri(docRes.data.uri).rkey };
}

// Saves an edit: writes a new version chained off the prior one and updates the
// document's currentVersion pointer. Two writes.
export async function saveNewVersion(
	agent: Agent,
	did: string,
	doc: LoadedDocument,
	body: string
): Promise<{ versionUri: string; versionCid: string }> {
	if (!doc.version) throw new Error('Document has no current version to chain from');
	const createdAt = new Date().toISOString();

	const versionRecord: DocumentVersionRecord = {
		document: doc.uri,
		body,
		createdAt,
		previousVersion: { uri: doc.version.uri, cid: doc.version.cid }
	};
	const versionRes = await agent.com.atproto.repo.createRecord({
		repo: did,
		collection: DOCUMENT_VERSION_NSID,
		record: versionRecord
	});

	const docFinal: DocumentRecord = {
		title: doc.value.title,
		createdAt: doc.value.createdAt,
		currentVersion: { uri: versionRes.data.uri, cid: versionRes.data.cid }
	};
	await agent.com.atproto.repo.putRecord({
		repo: did,
		collection: DOCUMENT_NSID,
		rkey: doc.rkey,
		record: docFinal,
		swapRecord: doc.cid
	});

	return { versionUri: versionRes.data.uri, versionCid: versionRes.data.cid };
}

// ---------- reads ----------

export async function listMyDocuments(agent: Agent, did: string): Promise<DocumentSummary[]> {
	const res = await agent.com.atproto.repo.listRecords({
		repo: did,
		collection: DOCUMENT_NSID,
		limit: 100
	});
	return res.data.records.map((r) => ({
		uri: r.uri,
		cid: r.cid,
		rkey: parseAtUri(r.uri).rkey,
		value: r.value as DocumentRecord
	}));
}

type GetRecordResponse<T> = { uri: string; cid: string; value: T };

async function fetchRecord<T>(
	pds: string,
	repo: string,
	collection: string,
	rkey: string
): Promise<GetRecordResponse<T>> {
	const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
	url.searchParams.set('repo', repo);
	url.searchParams.set('collection', collection);
	url.searchParams.set('rkey', rkey);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`getRecord ${collection}/${rkey}: ${res.status}`);
	return res.json();
}

// Fetches an arbitrary documentVersion by AT-URI. Used by the comments UI to
// resolve the body of an older version a comment was anchored to, so we can
// run the shift heuristic against the current text.
export async function getVersionByUri(uri: string): Promise<DocumentVersionRecord> {
	const { repo, collection, rkey } = parseAtUri(uri);
	const pds = await resolvePdsEndpoint(repo);
	const v = await fetchRecord<DocumentVersionRecord>(pds, repo, collection, rkey);
	return v.value;
}

// Reads a document and its current version from any user's PDS (unauthenticated).
// Used by view + edit pages so the same code path works for the signed-in user
// and for visitors viewing someone else's RFC.
export async function getDocument(did: string, rkey: string): Promise<LoadedDocument> {
	const pds = await resolvePdsEndpoint(did);
	const doc = await fetchRecord<DocumentRecord>(pds, did, DOCUMENT_NSID, rkey);

	let version: LoadedDocument['version'] = null;
	if (doc.value.currentVersion) {
		const versionRkey = parseAtUri(doc.value.currentVersion.uri).rkey;
		const v = await fetchRecord<DocumentVersionRecord>(
			pds,
			did,
			DOCUMENT_VERSION_NSID,
			versionRkey
		);
		version = { uri: v.uri, cid: v.cid, value: v.value };
	}

	return { uri: doc.uri, cid: doc.cid, did, rkey, value: doc.value, version };
}

export type { DocumentRecord, DocumentVersionRecord, StrongRef };
