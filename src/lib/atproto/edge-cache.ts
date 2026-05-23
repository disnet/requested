// Cloudflare edge-cache hints for unauthenticated upstream fetches (PDS,
// plc.directory, appview). The `cf` property only takes effect on Workers; in
// the browser (SPA build, dev) it's silently ignored, so this is safe to use
// from universal `+page.ts` loads. TTLs are tuned by record mutability.

export const CACHE_TTL = {
	// PLC directory + did:web docs — change on key rotation / domain move.
	DID_DOC: 3600,
	// documentVersion records are immutable by design.
	IMMUTABLE_RECORD: 86400,
	// document records change on every edit; page-level SWR carries the rest.
	MUTABLE_RECORD: 30,
	// Bluesky profiles (display name / avatar).
	PROFILE: 60
} as const;

// `cf` is a Workers-only RequestInit extension; cast through DOM lib types.
export function edgeCache(ttl: number): RequestInit {
	return { cf: { cacheTtl: ttl, cacheEverything: true } } as RequestInit;
}
