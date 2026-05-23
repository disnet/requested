import { PUBLIC_BUILD_MODE } from '$env/static/public';

// Selects whether this build ships as a pure-static SPA or a Cloudflare Worker
// with SSR. Driven by the `PUBLIC_BUILD_MODE` env var at build time; SvelteKit
// inlines `$env/static/public` to literal strings, so downstream
// `BUILD_MODE === 'ssr'` checks fold to constants and dead-code-eliminate.
// (Plain `import.meta.env.PUBLIC_BUILD_MODE` does NOT work — Vite only auto-
// exposes vars matching its `envPrefix`, which defaults to `VITE_*`.)
//
// - 'spa' (default): adapter-static, ssr disabled everywhere. Today's behaviour.
//   Deploys anywhere that serves static files. Easy fork target.
// - 'ssr': adapter-cloudflare. Public read routes server-render on the Worker;
//   auth-required routes (sign-in, new, edit) stay client-only because they
//   need the in-browser OAuth + DPoP agent.
export type BuildMode = 'spa' | 'ssr';

export const BUILD_MODE: BuildMode = (PUBLIC_BUILD_MODE as BuildMode | '') || 'spa';
