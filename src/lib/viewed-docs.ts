// Per-device tracker for documents the signed-in user has opened (and didn't
// author). Backs the "read" rows in the Activity ledger on `/`. localStorage
// only — there is no PDS surface for "I read this," and we'd rather not
// invent one. Entries are deduped by uri and move to the front on each view;
// the list isn't evicted.

const STORAGE_KEY = 'requested.viewed-docs.v1';

export type ViewedDoc = {
	uri: string;
	did: string;
	rkey: string;
	viewedAt: string;
	// The signed-in DID at the time of viewing. Scopes the list per-identity so
	// a shared browser doesn't attribute user A's reads to user B.
	viewerDid: string;
};

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function read(): ViewedDoc[] {
	if (!isBrowser()) return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(v): v is ViewedDoc =>
				v != null &&
				typeof v === 'object' &&
				typeof (v as ViewedDoc).uri === 'string' &&
				typeof (v as ViewedDoc).did === 'string' &&
				typeof (v as ViewedDoc).rkey === 'string' &&
				typeof (v as ViewedDoc).viewedAt === 'string' &&
				typeof (v as ViewedDoc).viewerDid === 'string'
		);
	} catch {
		return [];
	}
}

function write(list: ViewedDoc[]): void {
	if (!isBrowser()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		// Quota or privacy-mode failure. Silent — view tracking is best-effort.
	}
}

// Returns viewed docs for the given signed-in identity. Entries from other
// identities on this device are filtered out.
export function listViewed(viewerDid: string): ViewedDoc[] {
	return read().filter((v) => v.viewerDid === viewerDid);
}

export function recordView(entry: Omit<ViewedDoc, 'viewedAt'>): void {
	if (!isBrowser()) return;
	const list = read();
	const next: ViewedDoc = { ...entry, viewedAt: new Date().toISOString() };
	// Dedupe per (viewer, doc) so signing in as a different identity later
	// doesn't blow away the previous identity's read of the same doc.
	const filtered = list.filter((v) => !(v.uri === entry.uri && v.viewerDid === entry.viewerDid));
	filtered.unshift(next);
	write(filtered);
}
