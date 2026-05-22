// Thin wrapper over Constellation (https://constellation.microcosm.blue/), a
// public backlink indexer for atproto. We use it to discover comment records
// pointing at one of our documents that live on PDSes other than the signed-in
// user's — without it, the view page can only see the signed-in user's own
// comments via listRecords on their repo.
//
// The relevant endpoint is XRPC-shaped but lives outside atproto-core:
//   GET /xrpc/blue.microcosm.links.getBacklinks
//     ?subject=<at-uri of the thing being linked to>
//     &source=<collection>:<dotted.path.in.the.record>
//     &limit=&cursor=
//
// Response shape (observed):
//   { total: number, records: [{did, collection, rkey}], cursor?: string }

const CONSTELLATION = 'https://constellation.microcosm.blue';

// Constellation's host owner asks API consumers to identify themselves in the
// User-Agent. Harmless for browsers (the header is already set by fetch) but
// included as a comment so future maintainers know the social contract exists.

export type Backlink = {
	did: string;
	collection: string;
	rkey: string;
	uri: string;
};

export type BacklinkSource = {
	collection: string;
	path: string;
};

export async function listBacklinks(
	subject: string,
	source: BacklinkSource,
	options: { signal?: AbortSignal; maxRecords?: number } = {}
): Promise<Backlink[]> {
	const cap = options.maxRecords ?? 500;
	const out: Backlink[] = [];
	let cursor: string | undefined;

	do {
		const url = new URL('/xrpc/blue.microcosm.links.getBacklinks', CONSTELLATION);
		url.searchParams.set('subject', subject);
		url.searchParams.set('source', `${source.collection}:${source.path}`);
		url.searchParams.set('limit', String(Math.min(100, cap - out.length)));
		if (cursor) url.searchParams.set('cursor', cursor);

		const res = await fetch(url, { signal: options.signal });
		if (!res.ok) throw new Error(`constellation getBacklinks: ${res.status} ${res.statusText}`);
		const body = (await res.json()) as {
			records: Array<{ did: string; collection: string; rkey: string }>;
			cursor?: string;
		};

		for (const r of body.records) {
			out.push({
				did: r.did,
				collection: r.collection,
				rkey: r.rkey,
				uri: `at://${r.did}/${r.collection}/${r.rkey}`
			});
			if (out.length >= cap) return out;
		}
		cursor = body.cursor;
	} while (cursor);

	return out;
}
