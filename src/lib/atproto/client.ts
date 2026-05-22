import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

let client: BrowserOAuthClient | undefined;

// Lazy singleton: only instantiate in the browser, because BrowserOAuthClient
// touches WebCrypto, IndexedDB, and window.location at construction time.
export function getOAuthClient(): BrowserOAuthClient {
	if (typeof window === 'undefined') {
		throw new Error('getOAuthClient() must be called in the browser');
	}
	if (!client) {
		client = new BrowserOAuthClient({
			// No clientMetadata: BrowserOAuthClient derives a loopback client id
			// from window.location (requires host = 127.0.0.1 in dev — see vite.config.ts).
			handleResolver: 'https://bsky.social'
		});
	}
	return client;
}
