import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// atproto OAuth loopback clients require 127.0.0.1 (not localhost).
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true
	}
});
