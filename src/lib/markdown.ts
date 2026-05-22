import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

export type RenderOptions = {
	/** Strip the leading H1 from the rendered output. Used by the reader, which
	 *  already displays the document title in the metadata block, to avoid
	 *  double-rendering when authors begin their markdown with `# Title`. */
	stripLeadingH1?: boolean;
};

export type RenderedBlock = {
	/** 1-indexed source line where this top-level block starts. Counted against
	 *  the *original* body so it matches the line numbers stored on comment
	 *  records, even when stripLeadingH1 hides the title from the output. */
	line: number;
	html: string;
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

function createRenderer() {
	const renderer = new marked.Renderer();
	const baseHeading = renderer.heading.bind(renderer);
	renderer.heading = function (token: Tokens.Heading) {
		const html = baseHeading(token);
		const id = slugify(token.text);
		return html.replace(/^<h([1-6])>/, `<h$1 id="${id}">`);
	};
	return renderer;
}

// Render arbitrary markdown to safe HTML. Bodies come from other users' PDS
// records, so sanitizing is mandatory — DOMPurify strips scripts, event
// handlers, and dangerous URIs from the marked output.
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
	let body = src;
	if (opts.stripLeadingH1) {
		body = body.replace(/^\s*#\s+.*?\n/, '');
	}
	const rawHtml = marked.parse(body, { async: false, renderer: createRenderer() }) as string;
	return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['id'] });
}

// Same as renderMarkdown but returns one entry per top-level block, each
// tagged with its starting source line. Used by the reader to hang a per-line
// "add comment" affordance off every block without losing the markdown
// pipeline. Line numbers are counted against the original (pre-strip) body so
// they line up with the line field on comment records.
export function renderMarkdownBlocks(src: string, opts: RenderOptions = {}): RenderedBlock[] {
	const renderer = createRenderer();
	const tokens = marked.lexer(src);
	const links = (tokens as unknown as { links?: Record<string, unknown> }).links;

	const blocks: RenderedBlock[] = [];
	let line = 1;
	let skippedH1 = false;

	for (const token of tokens) {
		const startLine = line;
		const rawNewlines = ((token as { raw?: string }).raw?.match(/\n/g) ?? []).length;
		line += rawNewlines;

		if (token.type === 'space') continue;
		if (
			opts.stripLeadingH1 &&
			!skippedH1 &&
			token.type === 'heading' &&
			(token as Tokens.Heading).depth === 1
		) {
			skippedH1 = true;
			continue;
		}

		// marked.parser reads ref-style links off the token list's `links`
		// property; re-attach the parent lexer's table so references inside a
		// single token still resolve.
		const sub: Token[] = [token];
		(sub as unknown as { links: typeof links }).links = links;
		const rawHtml = marked.parser(sub, { renderer });
		blocks.push({
			line: startLine,
			html: DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['id'] })
		});
	}

	return blocks;
}
