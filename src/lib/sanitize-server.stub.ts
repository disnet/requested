// Stub used in the SPA build via vite.config.ts alias. The SPA build runs
// only in the browser, so this code path is unreachable — but keeping the
// export surface symmetric with sanitize-server.ssr.ts lets markdown.ts
// import the same name unconditionally without conditional logic at the
// import site.
export function sanitizeOnServer(html: string): string {
	void html;
	throw new Error('sanitizeOnServer should never be called in SPA build');
}
