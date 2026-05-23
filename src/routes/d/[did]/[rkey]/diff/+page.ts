import type { PageLoad } from './$types';
import {
	getDocument,
	getVersion,
	parseAtUri,
	type LoadedDocument,
	type LoadedVersion
} from '$lib/atproto/documents';

export type DiffPageData = {
	doc: LoadedDocument | null;
	from: LoadedVersion | null;
	to: LoadedVersion | null;
	loadError: string | null;
};

export const load: PageLoad = async ({ params, url, setHeaders }): Promise<DiffPageData> => {
	const { did, rkey } = params;
	const fromRkey = url.searchParams.get('from');
	const toRkey = url.searchParams.get('to');
	try {
		const doc = await getDocument(did, rkey);
		if (!doc.version) {
			return { doc, from: null, to: null, loadError: 'This document has no versions.' };
		}

		const toV = toRkey
			? await getVersion(did, toRkey)
			: { ...doc.version, rkey: parseAtUri(doc.version.uri).rkey };

		let fromV: LoadedVersion | null = null;
		if (fromRkey) {
			fromV = await getVersion(did, fromRkey);
		} else if (toV.value.previousVersion) {
			const prevRkey = parseAtUri(toV.value.previousVersion.uri).rkey;
			fromV = await getVersion(did, prevRkey);
		}

		if (!fromV) {
			return {
				doc,
				from: null,
				to: toV,
				loadError: 'No earlier version to diff against — this is the first version.'
			};
		}
		setHeaders({
			'cache-control': 'public, s-maxage=60, stale-while-revalidate=600'
		});
		return { doc, from: fromV, to: toV, loadError: null };
	} catch (err) {
		return {
			doc: null,
			from: null,
			to: null,
			loadError: err instanceof Error ? err.message : String(err)
		};
	}
};
