import adapterStatic from '@sveltejs/adapter-static';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';

// Dual-build setup. See src/lib/build-mode.ts for the runtime side.
//   PUBLIC_BUILD_MODE=spa (default) → adapter-static, no server runtime.
//   PUBLIC_BUILD_MODE=ssr           → adapter-cloudflare, Worker-rendered.
// The same env var is read by Vite at build time and inlined into client code,
// so the bundle and the runtime agree on which mode they're in.
const mode = process.env.PUBLIC_BUILD_MODE ?? 'spa';

const adapter = mode === 'ssr' ? adapterCloudflare() : adapterStatic({ fallback: 'index.html' });

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter
		// Sanitizer alias lives in vite.config.ts — SvelteKit's $lib/* glob alias
		// otherwise shadows any per-file $lib/<name> alias we try to add here.
	}
};

export default config;
