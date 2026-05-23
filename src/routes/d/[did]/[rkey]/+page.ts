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

export const load: PageLoad = async ({ params, setHeaders }): Promise<DocPageData> => {
	const { did, rkey } = params;
	try {
		const [doc, profile] = await Promise.all([
			getDocument(did, rkey),
			fetchProfile(did).catch(() => null)
		]);
		// SSR-only: no-op in the browser. Edge serves cached HTML for 60s and a
		// stale copy while revalidating for the next 10min after that.
		setHeaders({
			'cache-control': 'public, s-maxage=60, stale-while-revalidate=600'
		});
		return { doc, profile, loadError: null };
	} catch (err) {
		return {
			doc: null,
			profile: null,
			loadError: err instanceof Error ? err.message : String(err)
		};
	}
};
