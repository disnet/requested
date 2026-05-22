import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

export type RenderOptions = {
	/** Strip the leading H1 from the rendered output. Used by the reader, which
	 *  already displays the document title in the metadata block, to avoid
	 *  double-rendering when authors begin their markdown with `# Title`. */
	stripLeadingH1?: boolean;
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 80);
}

// Render arbitrary markdown to safe HTML. Bodies come from other users' PDS
// records, so sanitizing is mandatory — DOMPurify strips scripts, event
// handlers, and dangerous URIs from the marked output.
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
	let body = src;
	if (opts.stripLeadingH1) {
		body = body.replace(/^\s*#\s+.*?\n/, '');
	}

	// Slug-ids on every heading so the in-document table of contents and
	// deep-links can target sections directly.
	const renderer = new marked.Renderer();
	const baseHeading = renderer.heading.bind(renderer);
	renderer.heading = function (token: Tokens.Heading) {
		const html = baseHeading(token);
		const id = slugify(token.text);
		return html.replace(/^<h([1-6])>/, `<h$1 id="${id}">`);
	};

	const rawHtml = marked.parse(body, { async: false, renderer }) as string;
	return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['id'] });
}
