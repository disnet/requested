import { BUILD_MODE } from '$lib/build-mode';

// In the SPA build (default), every route is client-rendered off the static
// shell — same as the original pure-browser design. In the SSR build, public
// read routes server-render on the Cloudflare Worker so first paint ships
// HTML; routes that need the in-browser OAuth agent opt out via their own
// +page.ts (see /, /new, /d/[did]/[rkey]/edit). BUILD_MODE folds to a literal
// at build time, so this comparison dead-code-eliminates.
export const ssr = BUILD_MODE === 'ssr';

// Document content is per-DID and unbounded — we can't enumerate paths to
// prerender. Worker renders on demand in SSR; SPA shell loads on demand in
// the browser.
export const prerender = false;

// Routes still resolve client-side after the initial paint; we just don't
// require a trailing slash to be present in the URL.
export const trailingSlash = 'never';
