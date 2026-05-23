// Ambient module declaration for the `@sanitize-server` alias resolved by
// vite.config.ts. The same export surface is provided by both the SSR impl
// (src/lib/sanitize-server.ssr.ts) and the SPA stub (sanitize-server.stub.ts);
// vite picks one at build time based on PUBLIC_BUILD_MODE.
declare module '@sanitize-server' {
	export function sanitizeOnServer(html: string): string;
}
