import type { PageLoad } from './$types';
import { getDocument, type LoadedDocument } from '$lib/atproto/documents';
import { fetchProfile, type Profile } from '$lib/atproto/profile';

// Universal load: runs on the Cloudflare Worker in SSR builds (so the initial
// HTML ships rendered) and in the browser in SPA builds. We return the load
// error rather than throwing so the page keeps control of its own error UI
// instead of falling through to SvelteKit's generic error page.
export type DocPageData = {
	doc: LoadedDocument | null;
	profile: Profile | null;
	loadError: string | null;
};

export const load: PageLoad = async ({ params }): Promise<DocPageData> => {
	const { did, rkey } = params;
	try {
		const [doc, profile] = await Promise.all([
			getDocument(did, rkey),
			fetchProfile(did).catch(() => null)
		]);
		return { doc, profile, loadError: null };
	} catch (err) {
		return {
			doc: null,
			profile: null,
			loadError: err instanceof Error ? err.message : String(err)
		};
	}
};
