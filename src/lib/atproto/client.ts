import {
	BrowserOAuthClient,
	buildAtprotoLoopbackClientMetadata
} from '@atproto/oauth-client-browser';
import {
	COMMENT_NSID,
	DOCUMENT_NSID,
	DOCUMENT_VERSION_NSID,
	THREAD_RESOLUTION_NSID
} from './lexicons';

// Granular atproto OAuth scopes per the Permissions spec:
//   - `atproto` is always required (base identity scope)
//   - `repo:<NSID>` grants create/update/delete on that record collection
//     in the user's own repo. Omitting `?action=...` allows all actions.
// We intentionally avoid the transitional `transition:generic` blanket grant —
// users are only ever asked to authorize the collections this app actually writes.
const SCOPES = [
	'atproto',
	`repo:${DOCUMENT_NSID}`,
	`repo:${DOCUMENT_VERSION_NSID}`,
	`repo:${COMMENT_NSID}`,
	`repo:${THREAD_RESOLUTION_NSID}`
].join(' ');

let client: BrowserOAuthClient | undefined;

export function getOAuthClient(): BrowserOAuthClient {
	if (typeof window === 'undefined') {
		throw new Error('getOAuthClient() must be called in the browser');
	}
	if (!client) {
		const redirectUri = `${window.location.origin}/`;
		const clientMetadata = buildAtprotoLoopbackClientMetadata({
			scope: SCOPES,
			redirect_uris: [redirectUri]
		});
		client = new BrowserOAuthClient({
			clientMetadata,
			handleResolver: 'https://bsky.social'
		});
	}
	return client;
}
