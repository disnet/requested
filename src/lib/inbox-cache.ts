// In-tab cache for the unread-comments inbox. Lives in sessionStorage so a
// home-page fetch can prime the header badge on /d/[did]/[rkey] without a
// re-fetch, and a tab close starts fresh next time. Cross-tab consistency is
// intentionally not provided here — the dismiss path also calls
// updateCachedInbox in-tab, which is good enough for v1 (see Open Questions
// in the shape brief).

import type { InboxResult } from './inbox';

const STORAGE_KEY = 'requested.inbox-cache.v1';
const TTL_MS = 5 * 60 * 1000;

// Same-tab change notification. The `storage` event only fires in *other* tabs,
// so a dismiss in this tab would otherwise wait for the badge's 4s poll to
// pick up the new count. Dispatch a custom event after every cache write so
// in-tab listeners (the header badge) can refresh immediately.
export const INBOX_CHANGED_EVENT = 'requested:inbox-changed';

function broadcastChange(): void {
	if (!isBrowser()) return;
	window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
}

type Cached = {
	viewerDid: string;
	loadedAt: string; // ISO; also used to derive age for the "as of" stamp.
	result: InboxResult;
};

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function read(): Cached | null {
	if (!isBrowser()) return null;
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Cached;
		if (typeof parsed?.viewerDid !== 'string' || typeof parsed?.loadedAt !== 'string') {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function write(c: Cached): void {
	if (!isBrowser()) return;
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
	} catch {
		// Quota or privacy-mode failure. Silent — the cache is an optimization.
	}
}

export function getCachedInbox(viewerDid: string): InboxResult | null {
	const c = read();
	if (!c || c.viewerDid !== viewerDid) return null;
	const age = Date.now() - Date.parse(c.loadedAt);
	if (Number.isNaN(age) || age > TTL_MS) return null;
	return c.result;
}

export function setCachedInbox(viewerDid: string, result: InboxResult): void {
	write({ viewerDid, loadedAt: result.loadedAt, result });
	broadcastChange();
}

// Mutate-in-place after a dismiss. Avoids a full Constellation re-fetch just to
// reflect the user's own click. Drops empty groups so the section can hide.
export function updateCachedInbox(
	viewerDid: string,
	mutate: (result: InboxResult) => InboxResult
): InboxResult | null {
	const c = read();
	if (!c || c.viewerDid !== viewerDid) return null;
	const next = mutate(c.result);
	write({ viewerDid, loadedAt: c.loadedAt, result: next });
	broadcastChange();
	return next;
}

export function clearCachedInbox(): void {
	if (!isBrowser()) return;
	try {
		window.sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		/* best-effort */
	}
	broadcastChange();
}

// Human-readable freshness for the "as of ..." stamp in the subsection header.
export function formatAge(loadedAt: string, now = Date.now()): string {
	const ageMs = now - Date.parse(loadedAt);
	if (Number.isNaN(ageMs) || ageMs < 0) return 'just now';
	const secs = Math.round(ageMs / 1000);
	if (secs < 45) return 'just now';
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return `${days} d ago`;
}
