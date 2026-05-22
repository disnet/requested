// Public, unauthenticated profile lookup via the Bluesky appview.
// Used for display only (avatar + handle). Avoids needing the `transition:generic`
// OAuth scope — see ~/.claude memory `feedback-atproto-oauth-scopes`.

export type Profile = {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
};

const APPVIEW = 'https://public.api.bsky.app';

export async function fetchProfile(actor: string, signal?: AbortSignal): Promise<Profile> {
	const url = new URL('/xrpc/app.bsky.actor.getProfile', APPVIEW);
	url.searchParams.set('actor', actor);
	const res = await fetch(url, { signal });
	if (!res.ok) {
		throw new Error(`getProfile ${actor}: ${res.status} ${res.statusText}`);
	}
	return res.json();
}
