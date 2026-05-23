// Server-side HTML sanitizer used by markdown.ts when running on the
// Cloudflare Worker (SSR build). Mirrors DOMPurify's defaults closely enough
// that pre-rendered HTML matches what the browser would have produced — same
// element/attribute allowlist, same handling of dangerous URI schemes.
//
// In SPA builds this file is replaced via vite.config.ts alias with the stub
// at sanitize-server.stub.ts, so `sanitize-html` is never bundled into the
// static client.
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
	// Headings + paragraphs
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'p',
	// Inline
	'a',
	'em',
	'strong',
	'del',
	's',
	'i',
	'b',
	'u',
	'code',
	'br',
	'span',
	'sub',
	'sup',
	'mark',
	'small',
	// Block
	'blockquote',
	'pre',
	'hr',
	// Lists
	'ul',
	'ol',
	'li',
	// Tables
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'th',
	'td',
	// Buttons we inject for the comment / permalink affordances. These never
	// originate from user input — markdown.ts builds them inline after marked's
	// HTML pass, before handing the string to the sanitizer.
	'button',
	'img'
];

const ALLOWED_ATTRS: Record<string, string[]> = {
	'*': ['id', 'class', 'data-md-line', 'data-md-add', 'data-md-link', 'style'],
	a: ['href', 'title', 'name', 'tabindex', 'aria-label'],
	button: ['type', 'tabindex', 'aria-label', 'title'],
	img: ['src', 'alt', 'title'],
	th: ['align', 'scope'],
	td: ['align']
};

export function sanitizeOnServer(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: ALLOWED_ATTRS,
		allowedSchemes: ['http', 'https', 'mailto'],
		// Same hash-only fragment links DOMPurify allows by default — used by the
		// `¶` permalink glyphs (`href="#L<n>"`).
		allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
		allowProtocolRelative: false,
		// `style` is allowed at all (we inject `--md-li: <n>` on per-line code
		// spans), but cap what can appear inside.
		allowedStyles: {
			'*': {
				// CSS custom property used by the per-line code gutter button.
				'--md-li': [/^\d+$/]
			}
		}
	});
}
