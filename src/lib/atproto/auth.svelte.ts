import { Agent } from '@atproto/api';
import type { OAuthSession } from '@atproto/oauth-client-browser';
import { getOAuthClient } from './client';
import { fetchProfile, type Profile } from './profile';

type Status = 'loading' | 'signed-in' | 'signed-out';

class AuthStore {
	status = $state<Status>('loading');
	session = $state<OAuthSession | null>(null);
	profile = $state<Profile | null>(null);
	error = $state<string | null>(null);

	get did(): string | null {
		return this.session?.did ?? null;
	}

	get agent(): Agent | null {
		return this.session ? new Agent(this.session) : null;
	}

	async init(): Promise<void> {
		try {
			const client = getOAuthClient();
			const result = await client.init();
			if (result?.session) {
				this.session = result.session;
				this.status = 'signed-in';
				void this.loadProfile();
			} else {
				this.status = 'signed-out';
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.status = 'signed-out';
		}
	}

	async signIn(handleOrDid: string): Promise<void> {
		this.error = null;
		const client = getOAuthClient();
		// signInRedirect navigates away; the promise never resolves on success.
		await client.signInRedirect(handleOrDid.trim());
	}

	async signOut(): Promise<void> {
		if (!this.session) return;
		try {
			await this.session.signOut();
		} finally {
			this.session = null;
			this.profile = null;
			this.status = 'signed-out';
		}
	}

	private async loadProfile(): Promise<void> {
		if (!this.did) return;
		try {
			this.profile = await fetchProfile(this.did);
		} catch (err) {
			// Non-fatal: header just falls back to showing the DID.
			console.error('Failed to load profile', err);
		}
	}
}

export const auth = new AuthStore();
