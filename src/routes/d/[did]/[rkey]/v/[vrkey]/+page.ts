import type { PageLoad } from './$types';
import {
	getDocument,
	getVersion,
	listVersionChain,
	type LoadedDocument,
	type LoadedVersion
} from '$lib/atproto/documents';
import { fetchProfile, type Profile } from '$lib/atproto/profile';

export type VersionPageData = {
	doc: LoadedDocument | null;
	version: LoadedVersion | null;
	profile: Profile | null;
	versionIndex: { n: number; total: number } | null;
	loadError: string | null;
};

export const load: PageLoad = async ({ params, setHeaders }): Promise<VersionPageData> => {
	const { did, rkey, vrkey } = params;
	try {
		const [doc, version, profile, chain] = await Promise.all([
			getDocument(did, rkey),
			getVersion(did, vrkey),
			fetchProfile(did).catch(() => null),
			listVersionChain(did, rkey).catch((): LoadedVersion[] => [])
		]);
		let versionIndex: { n: number; total: number } | null = null;
		if (chain.length > 0) {
			const idx = chain.findIndex((cv) => cv.rkey === vrkey);
			if (idx >= 0) versionIndex = { n: chain.length - idx, total: chain.length };
		}
		setHeaders({
			'cache-control': 'public, s-maxage=60, stale-while-revalidate=600'
		});
		return { doc, version, profile, versionIndex, loadError: null };
	} catch (err) {
		return {
			doc: null,
			version: null,
			profile: null,
			versionIndex: null,
			loadError: err instanceof Error ? err.message : String(err)
		};
	}
};
