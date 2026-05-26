import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { browser } from '$app/environment';

// Sanitize marked output. DOMPurify is the canonical implementation but
// requires a DOM, so on the Cloudflare Worker we route through sanitize-html
// via the @sanitize-server alias (stubbed out in SPA builds at build time).
//
// `browser` is replaced with a literal `true` (client) / `false` (server) by
// SvelteKit, so the dynamic import in the !browser branch tree-shakes out of
// the client bundle. Without this, every SSR build would ship ~80KB of
// sanitize-html down to readers' browsers.
let sanitizeOnServer: ((html: string) => string) | null = null;
if (!browser) {
	sanitizeOnServer = (await import('@sanitize-server')).sanitizeOnServer;
}

function sanitize(html: string): string {
	if (browser) {
		return DOMPurify.sanitize(html, { ADD_ATTR: ['id'] });
	}
	// Non-null on the server branch; only the `browser` path executes in the
	// client bundle (and DCE drops the import above on that side).
	return sanitizeOnServer!(html);
}

export type RenderedBlock = {
	/** 1-indexed source line where this top-level block starts. Counted against
	 *  the body source so it matches the line numbers stored on comment
	 *  records. */
	line: number;
	/** 1-indexed source line where this top-level block's content ends
	 *  (inclusive). Equal to `line` for single-source-line blocks. Used to scope
	 *  the inline suggest-edit editor so the editable region matches the rendered
	 *  block, even when the block spans multiple source lines (a hard-wrapped
	 *  paragraph, a multi-line blockquote). Trailing blank lines that separate
	 *  this block from the next are excluded. */
	endLine: number;
	html: string;
	/** Additional source lines exposed as `[data-md-line]` sub-anchors inside
	 *  `html` — list items, table rows, code-block lines. Empty for blocks with
	 *  no granular sub-anchors. Consumers can use this to suppress the
	 *  block-level affordance for composite blocks (so a list's "[+] comment"
	 *  isn't a duplicate of its first item's), and to aggregate comment counts
	 *  across the block. */
	subLines: number[];
	/** Discriminant for the kind of top-level block. `'simple'` covers
	 *  paragraphs, headings, blockquotes, hr, etc. — anything with no sub-
	 *  anchors. The reader uses this to special-case lists (sub-anchors are
	 *  `<li>` elements that can host block-level descendants — see the mobile
	 *  inline-thread portal). */
	kind: 'simple' | 'list' | 'table' | 'code';
	/** Markdown heading depth (1–6) when this block is a heading, else null.
	 *  The reader uses it to group blocks into foldable sections in the body. */
	headingDepth: number | null;
};

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 80);
}

// Normalized heading depth: 1 for the shallowest heading the author actually
// used, 2 for the next, etc. A doc that opens with `#` and a doc that opens
// with `##` should both number as 1 / 1.1 / 1.1.1, so numbering and section
// styling key off this rather than the raw tag.
function findTopHeadingDepth(tokens: Token[]): number | null {
	let min: number | null = null;
	for (const t of tokens) {
		if (t.type === 'heading') {
			const d = (t as Tokens.Heading).depth;
			if (min == null || d < min) min = d;
		}
	}
	return min;
}

// GitHub-style slug dedupe: first occurrence keeps the bare slug, subsequent
// ones get `-2`, `-3`, ... appended. Both the renderer and `extractToc` share
// this helper (with a fresh `seen` set per render/extract) so TOC `href`s line
// up with the rendered heading `id`s — without dedupe, two headings sharing
// text would emit the same `id` and the TOC link would always scroll to the
// first one.
function uniqueSlug(base: string, seen: Set<string>): string {
	if (!seen.has(base)) {
		seen.add(base);
		return base;
	}
	let n = 2;
	while (seen.has(`${base}-${n}`)) n += 1;
	const out = `${base}-${n}`;
	seen.add(out);
	return out;
}

function createRenderer(topDepth: number | null, seenSlugs: Set<string>) {
	const renderer = new marked.Renderer();
	const baseHeading = renderer.heading.bind(renderer);
	renderer.heading = function (token: Tokens.Heading) {
		const html = baseHeading(token);
		const id = uniqueSlug(slugify(token.text), seenSlugs);
		const norm = topDepth != null ? token.depth - topDepth + 1 : null;
		const normAttr = norm != null ? ` data-h-norm="${norm}"` : '';
		return html.replace(/^<h([1-6])>/, `<h$1 id="${id}"${normAttr}>`);
	};
	return renderer;
}

// Render arbitrary markdown to safe HTML. Bodies come from other users' PDS
// records, so sanitizing is mandatory — DOMPurify strips scripts, event
// handlers, and dangerous URIs from the marked output.
export function renderMarkdown(src: string): string {
	const tokens = marked.lexer(src);
	const topDepth = findTopHeadingDepth(tokens);
	const rawHtml = marked.parser(tokens, { renderer: createRenderer(topDepth, new Set()) });
	return sanitize(rawHtml);
}

// Same as renderMarkdown but returns one entry per top-level block, each
// tagged with its starting source line. Used by the reader to hang a per-line
// "add comment" affordance off every block without losing the markdown
// pipeline. Line numbers are counted against the body source so they line up
// with the line field on comment records.
//
// Composite blocks (lists, tables, fenced/indented code) are additionally
// post-processed to expose per-item / per-row / per-line sub-anchors: each
// gets `[data-md-line]` + `class="md-sub"` and an injected `[+]` button. The
// reader uses these to let users comment on a specific list item, table row,
// or code line rather than the whole block.
//
// All output is sanitized through DOMPurify before being returned, including
// any per-anchor markup we inject. The bodies arrive from arbitrary PDSes,
// so the sanitize step is non-negotiable.
export function renderMarkdownBlocks(src: string): RenderedBlock[] {
	const tokens = marked.lexer(src);
	const topDepth = findTopHeadingDepth(tokens);
	const renderer = createRenderer(topDepth, new Set());
	const links = (tokens as unknown as { links?: Record<string, unknown> }).links;

	const blocks: RenderedBlock[] = [];
	let line = 1;

	for (const token of tokens) {
		const startLine = line;
		const raw = (token as { raw?: string }).raw ?? '';
		const rawNewlines = countNewlines(raw);
		line += rawNewlines;

		if (token.type === 'space') continue;

		// Strip trailing blank lines (the separator between this block and the
		// next) so endLine points at the block's last *content* source line.
		// `line` has already advanced past the separator above; that's fine for
		// the next iteration but we don't want those blank lines counted into
		// this block's range.
		const trimmedRaw = raw.replace(/\n*$/, '');
		const contentLines = trimmedRaw === '' ? 1 : countNewlines(trimmedRaw) + 1;
		const endLine = startLine + Math.max(0, contentLines - 1);

		// marked.parser reads ref-style links off the token list's `links`
		// property; re-attach the parent lexer's table so references inside a
		// single token still resolve.
		const sub: Token[] = [token];
		(sub as unknown as { links: typeof links }).links = links;
		const rawHtml = marked.parser(sub, { renderer });

		let html = rawHtml;
		let subLines: number[] = [];
		let kind: RenderedBlock['kind'] = 'simple';
		if (token.type === 'list') {
			({ html, subLines } = annotateList(token as Tokens.List, html, startLine));
			kind = 'list';
		} else if (token.type === 'table') {
			({ html, subLines } = annotateTable(token as Tokens.Table, html, startLine));
			kind = 'table';
		} else if (token.type === 'code') {
			({ html, subLines } = annotateCode(token as Tokens.Code, html, startLine));
			kind = 'code';
		}

		const headingDepth = token.type === 'heading' ? (token as Tokens.Heading).depth : null;

		blocks.push({
			line: startLine,
			endLine,
			html: sanitize(html),
			subLines,
			kind,
			headingDepth
		});
	}

	return blocks;
}

function countNewlines(s: string | undefined): number {
	return s ? (s.match(/\n/g) ?? []).length : 0;
}

export type TocEntry = {
	/** Normalized 1-based depth. 1 = the shallowest heading the author actually
	 *  used, regardless of whether they opened with `#` or `##`. Mirrors the
	 *  `data-h-norm` attribute the renderer puts on each heading so the TOC
	 *  numbering scheme always matches the body's CSS counters. */
	depth: number;
	/** Heading text with inline markdown markers stripped (no `**`/`_`/backticks). */
	text: string;
	/** Slug used as the `id` on the rendered heading and the `href` from the
	 *  TOC. Deduped via `uniqueSlug` so two headings sharing text still get
	 *  distinct anchors that line up with the renderer's IDs. */
	slug: string;
	/** Dotted section number that mirrors the body's CSS counters (norm 1 →
	 *  `N`, norm 2 → `N.M`, norm 3 → `N.M.O`). Empty string for normalized
	 *  depths 4+ since the body's counter rules don't number those either. */
	number: string;
};

// marked stores `heading.text` as the raw inline source — `## The **foo** API`
// keeps the literal `**` markers. The parsed inline tree on `heading.tokens`
// is what actually drops the markers, so we walk it and concatenate each leaf
// token's `.text` to recover the rendered plain text. Codespans contribute
// their body without backticks; links/strong/em/etc. recurse through their
// nested `tokens`.
function inlineTokensToPlainText(tokens: Token[] | undefined): string {
	if (!tokens) return '';
	let out = '';
	for (const t of tokens) {
		const children = (t as { tokens?: Token[] }).tokens;
		if (children && children.length > 0) {
			out += inlineTokensToPlainText(children);
		} else if (typeof (t as { text?: unknown }).text === 'string') {
			out += (t as { text: string }).text;
		}
	}
	return out;
}

// Walk the lexer output, surface every heading as a TOC entry, and assign each
// a number that matches the body's CSS counter scheme exactly (see the
// `.prose [data-h-norm='1'/'2'/'3']::before` rules on the reader + version-view
// pages). Slugs share the same `uniqueSlug` dedupe scheme as
// `renderMarkdown`/`renderMarkdownBlocks`, so a TOC `href` always lands on
// the matching heading `id`.
export function extractToc(src: string): TocEntry[] {
	const tokens = marked.lexer(src);
	const topDepth = findTopHeadingDepth(tokens);
	if (topDepth == null) return [];
	const seen = new Set<string>();
	const entries: TocEntry[] = [];
	// Counters keyed on normalized depth, mirroring the body's CSS `counter-reset`
	// rules: a new norm-1 heading resets norms 2 and 3; a new norm-2 resets
	// norm 3. Deeper normalized levels (4+) aren't numbered.
	const counters: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
	for (const token of tokens) {
		if (token.type !== 'heading') continue;
		const heading = token as Tokens.Heading;
		const norm = heading.depth - topDepth + 1;
		// Keep slug computation byte-identical to the renderer's: same `slugify`
		// input (`heading.text`), same `uniqueSlug` dedupe ordering.
		const slug = uniqueSlug(slugify(heading.text), seen);
		if (norm === 1) {
			counters[1] += 1;
			counters[2] = 0;
			counters[3] = 0;
		} else if (norm === 2) {
			counters[2] += 1;
			counters[3] = 0;
		} else if (norm === 3) {
			counters[3] += 1;
		}
		let number = '';
		if (norm === 1) number = `${counters[1]}`;
		else if (norm === 2) number = `${counters[1]}.${counters[2]}`;
		else if (norm === 3) number = `${counters[1]}.${counters[2]}.${counters[3]}`;
		entries.push({
			depth: norm,
			text: inlineTokensToPlainText(heading.tokens),
			slug,
			number
		});
	}
	return entries;
}

// The annotation helpers below splice per-anchor markup into already-rendered
// (marked-escaped) HTML. They never write untrusted user text through DOM
// innerHTML — string surgery happens on the marked output, the result is
// handed to DOMPurify at the end of renderMarkdownBlocks. No XSS surface.

// Build the [+] button HTML for a given source line. The button is hidden by
// CSS until the row is hovered (and when the user is signed out — gated via a
// `.can-comment` ancestor class). Click handling is delegated at the article
// level in the reader page.
function commentButtonHtml(line: number, extraClass = ''): string {
	const cls = `md-comment-btn md-sub-btn${extraClass ? ' ' + extraClass : ''}`;
	return (
		`<button type="button" class="${cls}" data-md-add="${line}" tabindex="-1" ` +
		`aria-label="Comment on line ${line}" title="Comment on line ${line}">[+]</button>`
	);
}

// Permalink glyph next to the [+] button. Renders as an <a> so right-click /
// middle-click / cmd-click flow through to the browser's normal link handling;
// plain left-click is intercepted by the reader page to copy the URL and pin
// a highlight on the target line. Unlike [+], this is visible to all viewers,
// signed-in or not.
function linkButtonHtml(line: number, extraClass = ''): string {
	const cls = `md-link-btn md-sub-link${extraClass ? ' ' + extraClass : ''}`;
	return (
		`<a href="#L${line}" class="${cls}" data-md-link="${line}" tabindex="-1" ` +
		`aria-label="Link to line ${line}" title="Copy link to line ${line}">¶</a>`
	);
}

// Sub-anchor [~] button — opens an inline source editor on the target line so
// the viewer can propose a textual replacement without going through the
// comment composer. Same visibility rules as [+] (hidden when signed-out via
// the `.can-comment` ancestor class). Click handling is delegated at the
// article level alongside the [+] handler.
function editButtonHtml(line: number, extraClass = ''): string {
	const cls = `md-edit-btn md-sub-edit-btn${extraClass ? ' ' + extraClass : ''}`;
	return (
		`<button type="button" class="${cls}" data-md-edit="${line}" tabindex="-1" ` +
		`aria-label="Suggest an edit to line ${line}" title="Suggest an edit to line ${line}">[~]</button>`
	);
}

// Add `data-md-line` and `class="md-sub"` to an existing `<tag ...>` open
// string. If a class attribute already exists, append; otherwise add one.
// `extraStyle` is an optional `style` attribute body — assumes the tag has no
// pre-existing style attribute (true for marked's <li>/<tr> output).
function addSubAttrs(openTag: string, line: number, extraStyle?: string): string {
	let out = openTag;
	if (/\sclass\s*=\s*"[^"]*"/.test(out)) {
		out = out.replace(/\sclass\s*=\s*"([^"]*)"/, (_, c) => ` class="${c} md-sub"`);
	} else {
		out = out.replace(/^<([a-zA-Z][\w-]*)/, (_, t) => `<${t} class="md-sub"`);
	}
	out = out.replace(/^<([a-zA-Z][\w-]*)/, (_, t) => `<${t} data-md-line="${line}"`);
	if (extraStyle) {
		out = out.replace(/^<([a-zA-Z][\w-]*)/, (_, t) => `<${t} style="${extraStyle}"`);
	}
	return out;
}

// Walk top-level `<childTag>` elements in a serialized container, calling
// `each` with the opening tag, inner body, and zero-based index. Nested
// containers of the same tag are not descended into. Returns the rebuilt
// HTML, or null if the input shape is unexpected (in which case the caller
// should leave it untouched).
function mapTopLevelChildren(
	innerHtml: string,
	childTag: string,
	each: (openTag: string, inner: string, index: number) => { open: string; inner: string }
): string | null {
	const openPrefix = `<${childTag}`;
	const closeTag = `</${childTag}>`;
	const out: string[] = [];
	let pos = 0;
	let idx = 0;
	while (pos < innerHtml.length) {
		const openStart = indexOfTagOpen(innerHtml, openPrefix, pos);
		if (openStart === -1) {
			out.push(innerHtml.slice(pos));
			break;
		}
		const openEnd = innerHtml.indexOf('>', openStart);
		if (openEnd === -1) return null;
		// Emit text between previous match and this one untouched.
		out.push(innerHtml.slice(pos, openStart));
		const openTag = innerHtml.slice(openStart, openEnd + 1);

		// Find the matching close at the same depth.
		let depth = 1;
		let scan = openEnd + 1;
		const innerStart = scan;
		while (depth > 0) {
			const nextOpen = indexOfTagOpen(innerHtml, openPrefix, scan);
			const nextClose = innerHtml.indexOf(closeTag, scan);
			if (nextClose === -1) return null;
			if (nextOpen !== -1 && nextOpen < nextClose) {
				depth += 1;
				const innerEnd = innerHtml.indexOf('>', nextOpen);
				if (innerEnd === -1) return null;
				scan = innerEnd + 1;
			} else {
				depth -= 1;
				scan = nextClose + closeTag.length;
				if (depth === 0) {
					const childInner = innerHtml.slice(innerStart, nextClose);
					const transformed = each(openTag, childInner, idx);
					out.push(transformed.open, transformed.inner, closeTag);
					pos = scan;
					idx += 1;
				}
			}
		}
	}
	return out.join('');
}

// indexOf an opening `<tag` whose next character is whitespace or `>` (so a
// search for `<li` doesn't accidentally match `<link>`).
function indexOfTagOpen(html: string, prefix: string, from: number): number {
	let at = from;
	while (true) {
		const i = html.indexOf(prefix, at);
		if (i === -1) return -1;
		const next = html.charAt(i + prefix.length);
		if (next === '' || next === '>' || /\s/.test(next)) return i;
		at = i + prefix.length;
	}
}

function annotateList(
	token: Tokens.List,
	html: string,
	startLine: number
): { html: string; subLines: number[] } {
	const subLines: number[] = [];
	const result = annotateListInto(token, html, startLine, subLines, 1);
	return { html: result ?? html, subLines };
}

// Recursive worker that annotates a list's <li> children and walks into each
// item's nested <ul>/<ol> so deeper items become their own sub-anchors too.
// Pushes every annotated line into `subLinesOut` (flat, depth-independent).
// `depth` is 1 for the outermost list and increments for each nesting level —
// emitted as a `--md-list-depth` CSS custom property on each `<li>` so the
// gutter buttons can subtract the cumulative `<ul>` padding (~2.5ch per level)
// and land in the same column as the block-level gutter regardless of nesting.
// Returns null when the HTML shape is unexpected so the caller can bail.
function annotateListInto(
	token: Tokens.List,
	html: string,
	startLine: number,
	subLinesOut: number[],
	depth: number
): string | null {
	const openMatch = html.match(/^\s*<(ul|ol)\b[^>]*>/i);
	if (!openMatch) return null;
	const tag = openMatch[1].toLowerCase();
	const closeIdx = html.lastIndexOf(`</${tag}>`);
	if (closeIdx <= openMatch[0].length) return null;

	const head = html.slice(0, openMatch[0].length);
	const innerHtml = html.slice(openMatch[0].length, closeIdx);
	const tail = html.slice(closeIdx);

	let line = startLine;
	const remapped = mapTopLevelChildren(innerHtml, 'li', (openTag, inner, i) => {
		const item = token.items[i];
		if (!item) return { open: openTag, inner };

		const itemLine = line;
		line += countNewlines(item.raw);
		subLinesOut.push(itemLine);

		// Walk this item's child tokens to find any nested list tokens with
		// their start lines (cursor accumulates newlines from each preceding
		// inline / block token's raw). Then splice annotated versions back
		// into the item's inner HTML — nested <ul>/<ol> render as direct
		// children of the parent <li> in marked's output.
		const nestedInfo = collectNestedLists(item, itemLine);
		const processedInner =
			nestedInfo.length > 0
				? annotateNestedLists(inner, nestedInfo, subLinesOut, depth + 1)
				: inner;

		return {
			open: addSubAttrs(openTag, itemLine, `--md-list-depth: ${depth}`),
			inner:
				linkButtonHtml(itemLine) +
				commentButtonHtml(itemLine) +
				editButtonHtml(itemLine) +
				processedInner
		};
	});
	if (remapped == null) return null;
	return head + remapped + tail;
}

type NestedListInfo = { token: Tokens.List; line: number };

function collectNestedLists(item: Tokens.ListItem, itemLine: number): NestedListInfo[] {
	const nested: NestedListInfo[] = [];
	let cursor = itemLine;
	for (const t of item.tokens) {
		if (t.type === 'list') {
			nested.push({ token: t as Tokens.List, line: cursor });
		}
		cursor += countNewlines((t as { raw?: string }).raw);
	}
	return nested;
}

// Walk `innerHtml` left-to-right; for each top-level <ul>/<ol>, pair it with
// the next entry in `nestedInfo` and replace with its annotated form. Stops
// pairing once nestedInfo is exhausted — extra lists in the HTML (rare; would
// indicate a token/HTML mismatch) are left untouched.
function annotateNestedLists(
	innerHtml: string,
	nestedInfo: NestedListInfo[],
	subLinesOut: number[],
	depth: number
): string {
	const out: string[] = [];
	let pos = 0;
	let idx = 0;
	while (pos < innerHtml.length && idx < nestedInfo.length) {
		const next = findNextTopList(innerHtml, pos);
		if (!next) break;
		out.push(innerHtml.slice(pos, next.start));
		const fullList = innerHtml.slice(next.start, next.end);
		const { token, line } = nestedInfo[idx];
		const annotated = annotateListInto(token, fullList, line, subLinesOut, depth);
		out.push(annotated ?? fullList);
		pos = next.end;
		idx += 1;
	}
	out.push(innerHtml.slice(pos));
	return out.join('');
}

// Find the next top-level <ul> or <ol> (whichever comes first) in `html`
// starting at `from`. Returns its byte bounds, or null if none is found.
function findNextTopList(html: string, from: number): { start: number; end: number } | null {
	const ulIdx = indexOfTagOpen(html, '<ul', from);
	const olIdx = indexOfTagOpen(html, '<ol', from);
	let start: number;
	let tag: 'ul' | 'ol';
	if (ulIdx === -1 && olIdx === -1) return null;
	if (ulIdx === -1) {
		start = olIdx;
		tag = 'ol';
	} else if (olIdx === -1) {
		start = ulIdx;
		tag = 'ul';
	} else if (ulIdx < olIdx) {
		start = ulIdx;
		tag = 'ul';
	} else {
		start = olIdx;
		tag = 'ol';
	}

	const closeTag = `</${tag}>`;
	const openEnd = html.indexOf('>', start);
	if (openEnd === -1) return null;
	let depth = 1;
	let scan = openEnd + 1;
	while (depth > 0) {
		const nextOpen = indexOfTagOpen(html, `<${tag}`, scan);
		const nextClose = html.indexOf(closeTag, scan);
		if (nextClose === -1) return null;
		if (nextOpen !== -1 && nextOpen < nextClose) {
			depth += 1;
			const ne = html.indexOf('>', nextOpen);
			if (ne === -1) return null;
			scan = ne + 1;
		} else {
			depth -= 1;
			scan = nextClose + closeTag.length;
			if (depth === 0) return { start, end: scan };
		}
	}
	return null;
}

function annotateTable(
	token: Tokens.Table,
	html: string,
	startLine: number
): { html: string; subLines: number[] } {
	// GFM tables put the header on the token's first line and the alignment
	// separator on the second; body rows start two lines in, one per source
	// line (cells can't wrap across lines in GFM).
	const tbodyMatch = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
	if (!tbodyMatch || tbodyMatch.index === undefined) return { html, subLines: [] };

	const subLines: number[] = [];
	const remapped = mapTopLevelChildren(tbodyMatch[1], 'tr', (openTag, inner, i) => {
		const rowLine = startLine + 2 + i;
		if (i >= token.rows.length) return { open: openTag, inner };
		subLines.push(rowLine);
		// Inject the [+] inside the first <td>/<th> so it can be positioned
		// against the row from a real positioned container — a <tr> isn't
		// reliable for absolutely-positioned descendants.
		const cellMatch = inner.match(/^\s*<(td|th)\b[^>]*>/i);
		const buttons = linkButtonHtml(rowLine) + commentButtonHtml(rowLine) + editButtonHtml(rowLine);
		const innerWithBtn = cellMatch
			? inner.slice(0, cellMatch[0].length) + buttons + inner.slice(cellMatch[0].length)
			: buttons + inner;
		return {
			open: addSubAttrs(openTag, rowLine),
			inner: innerWithBtn
		};
	});
	if (remapped == null) return { html, subLines: [] };
	const out =
		html.slice(0, tbodyMatch.index) +
		`<tbody>${remapped}</tbody>` +
		html.slice(tbodyMatch.index + tbodyMatch[0].length);
	return { html: out, subLines };
}

function annotateCode(
	token: Tokens.Code,
	html: string,
	startLine: number
): { html: string; subLines: number[] } {
	// The rendered code block looks like `<pre><code [class="..."]>BODY</code></pre>`.
	// Pull out the body so we can split it line-by-line and re-wrap each line
	// in a sub-anchor span.
	const codeMatch = html.match(/^(\s*<pre[^>]*><code\b[^>]*>)([\s\S]*?)(<\/code><\/pre>\s*)$/i);
	if (!codeMatch) return { html, subLines: [] };

	const head = codeMatch[1];
	const body = codeMatch[2];
	const tail = codeMatch[3];

	// marked normalizes a trailing newline onto the code body; preserve it so
	// the rendered <pre> still ends cleanly.
	const trailing = body.endsWith('\n') ? '\n' : '';
	const trimmed = trailing ? body.slice(0, -1) : body;
	const lines = trimmed.split('\n');

	// Fenced code: token.raw includes the opening fence line, so content
	// starts on startLine + 1. Indented code has no fence — content lines map
	// 1:1 with source lines.
	const contentLine = token.codeBlockStyle === 'indented' ? startLine : startLine + 1;

	const subLines: number[] = [];
	const wrapped = lines.map((rawLine, i) => {
		const lineNum = contentLine + i;
		subLines.push(lineNum);
		// `<span>` is `display:block` via CSS — a per-line block so the gutter
		// [+] can position absolutely against it. Empty lines still emit an
		// empty span so hover targets the right source line.
		// `--md-li` carries the 0-based line index so the per-line [+]/¶ can
		// compute its own `top` against `.md-block` (a positioning context that
		// lives *outside* `<pre>`'s `overflow-x: auto`). Positioning against
		// `.md-code-line` (inside `<pre>`) would let the scroll container clip
		// the buttons against the negative gutter.
		return (
			`<span class="md-sub md-code-line" data-md-line="${lineNum}" style="--md-li: ${i}">` +
			linkButtonHtml(lineNum, 'md-sub-link-code') +
			commentButtonHtml(lineNum, 'md-sub-btn-code') +
			editButtonHtml(lineNum, 'md-sub-edit-btn-code') +
			rawLine +
			`</span>`
		);
	});

	// Join with no separator: each span is `display:block`, so visual line
	// breaks come from layout. A literal `\n` between spans would, under
	// `<pre>`'s `white-space: pre`, materialize as an extra blank line between
	// each row and double the block's height — and offset the gutter-button
	// `top` calc by one line per row.
	return { html: head + wrapped.join('') + trailing + tail, subLines };
}
