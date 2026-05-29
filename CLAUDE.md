# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (SPA mode). Bound to **`127.0.0.1:5173` with `strictPort`** (see `vite.config.ts`); the atproto OAuth loopback client requires the literal `127.0.0.1`, not `localhost`. Don't change the host.
- `npm run dev:ssr` — Vite dev with SSR enabled (Node-simulated, not Workers). Fast HMR; useful for iterating on SSR logic. Won't catch Workers-API quirks.
- `npm run build` — SPA build (adapter-static into `build/`). The default for forks and static-host deploys.
- `npm run build:ssr` — Worker build (adapter-cloudflare into `.svelte-kit/cloudflare/`). What CI ships.
- `npm run preview` — serve the built SPA.
- `npm run preview:ssr` — `build:ssr` + `wrangler pages dev`. Production-faithful (real workerd runtime, `nodejs_compat` enabled) but no HMR. Use this to verify SSR before pushing.
- `npm run check` — `svelte-kit sync && svelte-check` (typecheck + Svelte diagnostics). There is no test runner configured.
- `npm run lint` — `prettier --check . && eslint .`
- `npm run format` — `prettier --write .`

## Architecture

Requested is a SvelteKit app for publishing markdown RFCs and threaded line-comments to atproto. There is no central database — every persistent record lives on the relevant user's own PDS. The app has **two build modes** (see below), but in both cases data is fetched from PDSes on demand; we never persist to a backend of our own.

### Dual build modes

A single build-mode env var (`PUBLIC_BUILD_MODE`) toggles between two output shapes:

- **`spa` (default)** — `adapter-static`, no server runtime, output in `build/`. Identical to the pre-SSR design. Deploys anywhere that serves static files (S3, GitHub Pages, etc.). Kept as the fork-friendly fallback.
- **`ssr`** — `adapter-cloudflare`, output in `.svelte-kit/cloudflare/`. Public read routes (`/d/[did]/[rkey]`, `/history`, `/v/[vrkey]`, `/diff`) server-render on the Worker so first paint ships HTML; auth-required routes (`/`, `/new`, `/d/[did]/[rkey]/edit`) opt out via their own `+page.ts` (`export const ssr = false`) because they need the in-browser OAuth + DPoP agent.

The CI deploy workflow (`.github/workflows/deploy.yml`) builds in SSR mode (`PUBLIC_BUILD_MODE=ssr`). `npm run build` with no env still produces the SPA — exercise both before changes that touch routing, data loading, or imports.

Build mode is read at runtime via `src/lib/build-mode.ts` (Vite inlines `import.meta.env.PUBLIC_BUILD_MODE` to a literal). `src/routes/+layout.ts` sets `ssr = BUILD_MODE === 'ssr'`.

### Data loading

Public read routes use **universal `+page.ts` `load` functions** (not `+page.server.ts`). Universal load runs on the Worker in SSR builds and in the browser in SPA builds — same source, no fork. Don't introduce `.server.ts` route files: they tie us to SSR and break the SPA fallback.

The load function pattern returns `{ ..., loadError: string | null }` rather than throwing, so the page keeps control of its error UI.

Svelte 5 **runes mode is forced** for all project files (`svelte.config.js`). Use `$state`, `$derived`, `$effect`, `$props`, etc.; don't fall back to legacy `let`-as-reactive or `$:` syntax. Stateful stores are written as classes with rune-typed fields in `*.svelte.ts` files (see `src/lib/atproto/auth.svelte.ts` — exported as the singleton `auth`). `auth.svelte.ts` imports `@atproto/oauth-client-browser` at module load; that's import-safe on the Worker (a console warning about Locks API appears but is harmless), and the actual OAuth client is only instantiated inside `onMount` in the client.

### atproto data model (`src/lib/atproto/`)

Our own NSIDs all live under `fyi.requested.*` (reverse domain of `requested.fyi`). The JSON lexicons in `/lexicons` are authoritative; `src/lib/atproto/lexicons.ts` mirrors them as TypeScript types and exports the NSID constants. We also embed two **external** lexicons owned by markpub.at (`at.markpub.markdown`, `at.markpub.text`) — `/lexicons/at.markpub.*.json` are local mirrors for documentation only (we don't author them, same as `com.atproto.repo.strongRef`).

- **`document`** — title + `currentVersion` strongRef. Mutable (pointer moves on every edit).
- **`documentVersion`** — immutable body snapshot, chained via `previousVersion` strongRef. The split exists so comments can pin to an immutable CID while the document pointer keeps moving. The body is stored in `content`, an embedded **`at.markpub.markdown`** object (markpub.at's markdown lexicon — `content.text.markdown` holds the raw GFM source, `flavor: gfm`, `renderingRules: marked`), so the markdown is portable across the markpub ecosystem. A legacy raw-string `body` field is read-only fallback for pre-markpub versions. **Never read `.body` directly** — use `versionMarkdown(value)` from `lexicons.ts`, which prefers `content` and falls back to `body`. New versions are written via `buildMarkpubMarkdown`.
- **`comment`** — lives on the **commenter's** PDS, not the document author's. References the `document` by plain at-uri (mutable target) and the `documentVersion` by strongRef (immutable snapshot the commenter actually saw). Optional `line` for line-anchored comments; optional `parent` strongRef for threading.

Creating a document is **three writes** (`createDocument` in `documents.ts`): create doc without `currentVersion` → create version pointing at the doc → `putRecord` the doc to set `currentVersion`. Editing is two writes (new version → `putRecord` doc with `swapRecord` guard).

### Cross-PDS reads

`document` and `documentVersion` records are read **unauthenticated** so visitors can view any user's RFC. The flow is `resolveHandleToDid` (via public Bluesky appview) → `resolvePdsEndpoint` (via plc.directory or did:web `.well-known/did.json`) → raw `com.atproto.repo.getRecord` fetch (`fetchRecord` in `documents.ts`). Don't route these through the authenticated `Agent`.

Comments are discovered via **Constellation** (`https://constellation.microcosm.blue`), a public atproto backlink indexer (`src/lib/atproto/constellation.ts`). `listAllCommentsOn` unions Constellation's index with the signed-in user's own `listRecords` results, because Constellation can lag a freshly-written comment by tens of seconds.

### Comment version drift

Comments pin to a specific `documentVersion` CID. When the document moves on, `describeCommentVersionState` + `resolveLineShift` (`comments.ts`) try to map the original line to its new position in the current body using a nearest-exact-match heuristic. This is **purely informational** — the comment record is never rewritten.

### OAuth scopes (important)

`src/lib/atproto/client.ts` builds an OAuth client with **granular scopes only**: `atproto` plus one `repo:<NSID>` per collection the app writes. **Do not** request `transition:generic` — the consent screen must list only what the app actually touches. Memory note: `feedback-atproto-oauth-scopes`.

The same file picks between **two client metadata shapes** at runtime based on `window.location.origin`:

- **Dev / loopback** (`127.0.0.1`): synthetic metadata via `buildAtprotoLoopbackClientMetadata`. The `client_id` is derived from scope per the atproto loopback-client convention.
- **Production** (`https://requested.fyi`): a literal metadata object whose `client_id` is `https://requested.fyi/client-metadata.json`. The atproto authorization server fetches that URL directly, so the file at **`static/client-metadata.json`** must stay byte-identical to the literal in `client.ts` — `SCOPES`, `redirect_uris`, all of it.

When adding a new writable NSID:

1. Add a `repo:<NSID>` entry to `SCOPES` in `client.ts`.
2. Add the same `repo:<NSID>` token to the `scope` string in `static/client-metadata.json`.
3. Changing scope changes the loopback `client_id` (it encodes scope as a query param), which invalidates existing dev sessions — users must sign out and back in. Prod sessions only invalidate if you also change the metadata file's `client_id`.

For unauthenticated appview reads (e.g. profiles in `profile.ts`), hit `https://public.api.bsky.app` directly rather than requesting an `rpc:` scope.

### Deployment

Production is **Cloudflare Pages** at `requested.fyi`. `.github/workflows/deploy.yml` runs on push to `main`: `npm ci` → `npm run check` → `npm run lint` → `PUBLIC_BUILD_MODE=ssr npm run build` → `cloudflare/wrangler-action@v3` deploys `.svelte-kit/cloudflare/` to the Pages project named `requested`. Requires repo secrets `CLOUDFLARE_API_TOKEN` (Pages: Edit token) and `CLOUDFLARE_ACCOUNT_ID`.

There is no `static/_redirects` file — adapter-cloudflare handles routing through the Worker. If forking and deploying the SPA build to Cloudflare Pages, add `static/_redirects` containing `/* /index.html 200` so unknown paths fall back to the SPA shell.

### Markdown rendering

`src/lib/markdown.ts` renders with `marked` and **always** sanitizes the output. The sanitizer is environment-aware: DOMPurify in the browser, `sanitize-html` on the Worker (via the `@sanitize-server` Vite alias, which resolves to `src/lib/sanitize-server.ssr.ts` in SSR builds and a throw-only stub in SPA builds — see `vite.config.ts`). Bodies come from arbitrary users' PDSes — never render untrusted markdown/HTML without sanitizing. The server-side import is dynamic and gated on `$app/environment.browser` so sanitize-html doesn't ship to the client bundle.

### Routes

- `/` — sign-in form when signed-out, list of signed-in user's documents otherwise.
- `/new` — create a new document.
- `/d/[did]/[rkey]` — view a document.
- `/d/[did]/[rkey]/edit` — edit (only meaningful when signed in as the author).
- `/d/[did]/[rkey]/history` — version chain walk.
- `/d/[did]/[rkey]/v/[vrkey]` — view a specific version.
- `/d/[did]/[rkey]/diff` — diff between versions.

URLs use the author's DID (not handle) so shared/written-down links stay stable across handle renames — we have no appview to maintain handle→DID redirects. `resolveHandleToDid` is still used at sign-in (users enter a handle there) but route pages pass `page.params.did` straight to the PDS.
