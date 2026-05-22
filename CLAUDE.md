# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server. Bound to **`127.0.0.1:5173` with `strictPort`** (see `vite.config.ts`); the atproto OAuth loopback client requires the literal `127.0.0.1`, not `localhost`. Don't change the host.
- `npm run build` — production build via `@sveltejs/adapter-static` into `build/` (SPA, `fallback: 'index.html'`).
- `npm run preview` — serve the built SPA.
- `npm run check` — `svelte-kit sync && svelte-check` (typecheck + Svelte diagnostics). There is no test runner configured.
- `npm run lint` — `prettier --check . && eslint .`
- `npm run format` — `prettier --write .`

## Architecture

AT-RFC is a **pure browser SvelteKit app** for publishing markdown RFCs and threaded line-comments to atproto. There is no server runtime and no central database — every persistent record lives on the relevant user's own PDS.

### Static SPA / no SSR

`src/routes/+layout.ts` sets `ssr = false` and `prerender = false` globally. Every route is rendered client-side off the SPA shell (`build/index.html`). Don't introduce `+page.server.ts` / `+layout.server.ts` files or anything that assumes a Node runtime — there is no server.

Svelte 5 **runes mode is forced** for all project files (`svelte.config.js`). Use `$state`, `$derived`, `$effect`, `$props`, etc.; don't fall back to legacy `let`-as-reactive or `$:` syntax. Stateful stores are written as classes with rune-typed fields in `*.svelte.ts` files (see `src/lib/atproto/auth.svelte.ts` — exported as the singleton `auth`).

### atproto data model (`src/lib/atproto/`)

Three NSIDs, all under `dev.disnet.atrfc.*`. The JSON lexicons in `/lexicons` are authoritative; `src/lib/atproto/lexicons.ts` mirrors them as TypeScript types and exports the NSID constants.

- **`document`** — title + `currentVersion` strongRef. Mutable (pointer moves on every edit).
- **`documentVersion`** — immutable body snapshot, chained via `previousVersion` strongRef. The split exists so comments can pin to an immutable CID while the document pointer keeps moving.
- **`comment`** — lives on the **commenter's** PDS, not the document author's. References the `document` by plain at-uri (mutable target) and the `documentVersion` by strongRef (immutable snapshot the commenter actually saw). Optional `line` for line-anchored comments; optional `parent` strongRef for threading.

Creating a document is **three writes** (`createDocument` in `documents.ts`): create doc without `currentVersion` → create version pointing at the doc → `putRecord` the doc to set `currentVersion`. Editing is two writes (new version → `putRecord` doc with `swapRecord` guard).

### Cross-PDS reads

`document` and `documentVersion` records are read **unauthenticated** so visitors can view any user's RFC. The flow is `resolveHandleToDid` (via public Bluesky appview) → `resolvePdsEndpoint` (via plc.directory or did:web `.well-known/did.json`) → raw `com.atproto.repo.getRecord` fetch (`fetchRecord` in `documents.ts`). Don't route these through the authenticated `Agent`.

Comments are discovered via **Constellation** (`https://constellation.microcosm.blue`), a public atproto backlink indexer (`src/lib/atproto/constellation.ts`). `listAllCommentsOn` unions Constellation's index with the signed-in user's own `listRecords` results, because Constellation can lag a freshly-written comment by tens of seconds.

### Comment version drift

Comments pin to a specific `documentVersion` CID. When the document moves on, `describeCommentVersionState` + `resolveLineShift` (`comments.ts`) try to map the original line to its new position in the current body using a nearest-exact-match heuristic. This is **purely informational** — the comment record is never rewritten.

### OAuth scopes (important)

`src/lib/atproto/client.ts` builds a loopback OAuth client with **granular scopes only**: `atproto` plus one `repo:<NSID>` per collection the app writes. **Do not** request `transition:generic` — the consent screen must list only what the app actually touches. Memory note: `feedback-atproto-oauth-scopes`.

When adding a new writable NSID:
1. Add a `repo:<NSID>` entry to `SCOPES` in `client.ts`.
2. The loopback `client_id` encodes scope as a query param, so changing `SCOPES` invalidates existing sessions — users must sign out and back in.

For unauthenticated appview reads (e.g. profiles in `profile.ts`), hit `https://public.api.bsky.app` directly rather than requesting an `rpc:` scope.

### Markdown rendering

`src/lib/markdown.ts` renders with `marked` and **always** runs the output through DOMPurify. Bodies come from arbitrary users' PDSes — never render untrusted markdown/HTML without sanitizing.

### Routes

- `/` — sign-in form when signed-out, list of signed-in user's documents otherwise.
- `/new` — create a new document.
- `/d/[handle]/[rkey]` — view a document (works for any user's handle/DID).
- `/d/[handle]/[rkey]/edit` — edit (only meaningful when signed in as the author).
- `/d/[handle]/[rkey]/history` — version chain walk.
- `/d/[handle]/[rkey]/v/[vrkey]` — view a specific version.
- `/d/[handle]/[rkey]/diff` — diff between versions.

The `[handle]` segment may be either a handle or a DID; resolve with `resolveHandleToDid` before talking to a PDS.
