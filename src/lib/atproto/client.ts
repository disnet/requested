import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import type { OAuthClientMetadataInput } from '@atproto/oauth-types';
import {
	COMMENT_NSID,
	DOCUMENT_NSID,
	DOCUMENT_VERSION_NSID,
	MENTION_NSID,
	THREAD_RESOLUTION_NSID
} from './lexicons';

// Granular atproto OAuth scopes per the Permissions spec:
//   - `atproto` is always required (base identity scope)
//   - `repo:<NSID>` grants create/update/delete on that record collection
//     in the user's own repo. Omitting `?action=...` allows all actions.
// We intentionally avoid the transitional `transition:generic` blanket grant —
// users are only ever asked to authorize the collections this app actually writes.
//
// Keep in sync with /static/client-metadata.json — the production auth server
// fetches that file by URL and uses its `scope` field.
const SCOPES = [
	'atproto',
	`repo:${DOCUMENT_NSID}`,
	`repo:${DOCUMENT_VERSION_NSID}`,
	`repo:${COMMENT_NSID}`,
	`repo:${THREAD_RESOLUTION_NSID}`,
	`repo:${MENTION_NSID}`
].join(' ');

const PROD_ORIGIN = 'https://requested.fyi';

let client: BrowserOAuthClient | undefined;

// `@atproto/oauth-client-browser` touches `BroadcastChannel` at module-init,
// which crashes on the Cloudflare Worker. We avoid the static import and load
// the package lazily — this function is only ever called from the browser
// (gated by the `typeof window` check), so the dynamic import never runs on
// the Worker. Type-only imports above are erased by tsc and don't generate
// runtime references.
export async function getOAuthClient(): Promise<BrowserOAuthClient> {
	if (typeof window === 'undefined') {
		throw new Error('getOAuthClient() must be called in the browser');
	}
	if (!client) {
		const { BrowserOAuthClient } = await import('@atproto/oauth-client-browser');
		client = new BrowserOAuthClient({
			clientMetadata: await buildClientMetadata(),
			handleResolver: 'https://bsky.social'
		});
	}
	return client;
}

async function buildClientMetadata(): Promise<OAuthClientMetadataInput> {
	if (window.location.origin === PROD_ORIGIN) {
		// Production: `client_id` MUST be the public URL where the atproto
		// authorization server fetches this metadata. These fields MUST stay
		// byte-identical to /static/client-metadata.json.
		return {
			client_id: `${PROD_ORIGIN}/client-metadata.json`,
			client_name: 'Requested',
			client_uri: PROD_ORIGIN,
			redirect_uris: [`${PROD_ORIGIN}/`],
			scope: SCOPES,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			application_type: 'web',
			token_endpoint_auth_method: 'none',
			dpop_bound_access_tokens: true
		};
	}
	// Dev / loopback: synthetic `client_id` derived from scope per the atproto
	// loopback-client convention. Requires the dev server to bind 127.0.0.1.
	const { buildAtprotoLoopbackClientMetadata } = await import('@atproto/oauth-client-browser');
	return buildAtprotoLoopbackClientMetadata({
		scope: SCOPES,
		redirect_uris: [`${window.location.origin}/`]
	});
}
