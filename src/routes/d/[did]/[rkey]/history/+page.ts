import type { PageLoad } from './$types';
import {
	getDocument,
	listVersionChain,
	type LoadedDocument,
	type LoadedVersion
} from '$lib/atproto/documents';

export type HistoryPageData = {
	doc: LoadedDocument | null;
	versions: LoadedVersion[];
	loadError: string | null;
};

export const load: PageLoad = async ({ params }): Promise<HistoryPageData> => {
	const { did, rkey } = params;
	try {
		const [doc, versions] = await Promise.all([
			getDocument(did, rkey),
			listVersionChain(did, rkey)
		]);
		return { doc, versions, loadError: null };
	} catch (err) {
		return {
			doc: null,
			versions: [],
			loadError: err instanceof Error ? err.message : String(err)
		};
	}
};
