// Per-device tracker for inbox item URIs the signed-in user has dismissed.
// Items are at-uris — comments and @mention records alike (at-uris are unique
// across collections, so one Set covers both). Mirrors viewed-docs.ts:
// per-viewer scoping (so a shared browser doesn't bleed dismissals across
// identities), silent on quota failures.
//
// "Dismissed" is local-only by design — no PDS surface, no cross-device sync.
// Re-signing in on a fresh device starts the inbox at "everything's new again,"
// which is the right default given the lack of a server-side read-state record.

const STORAGE_KEY = 'requested.dismissed-comments.v1';

export type DismissedComment = {
	commentUri: string;
	viewerDid: string;
	dismissedAt: string;
};

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function read(): DismissedComment[] {
	if (!isBrowser()) return [];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(v): v is DismissedComment =>
				v != null &&
				typeof v === 'object' &&
				typeof (v as DismissedComment).commentUri === 'string' &&
				typeof (v as DismissedComment).viewerDid === 'string' &&
				typeof (v as DismissedComment).dismissedAt === 'string'
		);
	} catch {
		return [];
	}
}

function write(list: DismissedComment[]): void {
	if (!isBrowser()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		// Quota or privacy-mode failure. Silent — dismissals are best-effort.
	}
}

// Returns the set of dismissed comment URIs for the given viewer identity. Set
// because callers always do membership checks; avoids O(n²) filters in the
// inbox loader's hot loop.
export function listDismissedSet(viewerDid: string): Set<string> {
	const out = new Set<string>();
	for (const d of read()) {
		if (d.viewerDid === viewerDid) out.add(d.commentUri);
	}
	return out;
}

export function dismissComment(commentUri: string, viewerDid: string): void {
	if (!isBrowser()) return;
	const list = read();
	if (list.some((d) => d.commentUri === commentUri && d.viewerDid === viewerDid)) return;
	list.unshift({
		commentUri,
		viewerDid,
		dismissedAt: new Date().toISOString()
	});
	write(list);
}

export function dismissComments(commentUris: string[], viewerDid: string): void {
	if (!isBrowser() || commentUris.length === 0) return;
	const list = read();
	const existing = new Set(list.filter((d) => d.viewerDid === viewerDid).map((d) => d.commentUri));
	const now = new Date().toISOString();
	for (const uri of commentUris) {
		if (existing.has(uri)) continue;
		list.unshift({ commentUri: uri, viewerDid, dismissedAt: now });
		existing.add(uri);
	}
	write(list);
}
