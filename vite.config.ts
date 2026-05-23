import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Pick the server-side sanitizer at build time. SSR builds get the real
// sanitize-html-backed impl (used by the Worker when rendering markdown
// server-side); SPA builds get a stub so sanitize-html is never bundled into
// the static client. The runtime branch in markdown.ts (`typeof window`) makes
// the stub branch unreachable in SPA.
//
// The alias name deliberately does NOT use the `$lib/` prefix so it isn't
// shadowed by SvelteKit's broader `$lib/*` alias.
const buildMode = process.env.PUBLIC_BUILD_MODE ?? 'spa';
const sanitizeServerImpl = fileURLToPath(
	new URL(
		buildMode === 'ssr' ? './src/lib/sanitize-server.ssr.ts' : './src/lib/sanitize-server.stub.ts',
		import.meta.url
	)
);

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		alias: { '@sanitize-server': sanitizeServerImpl }
	},
	// atproto OAuth loopback clients require 127.0.0.1 (not localhost).
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true
	}
});
