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
	/** Additional source lines exposed as `[data-md-line]` sub-anchors inside
	 *  `html` — list items, table rows, code-block lines. Empty for blocks with
	 *  no granular sub-anchors. Consumers can use this to suppress the
	 *  block-level affordance for composite blocks (so a list's "[+] comment"
	 *  isn't a duplicate of its first item's), and to aggregate comment counts
	 *  across the block. */
	subLines: number[];
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
export function renderMarkdownBlocks(src: string, opts: RenderOptions = {}): RenderedBlock[] {
	const renderer = createRenderer();
	const tokens = marked.lexer(src);
	const links = (tokens as unknown as { links?: Record<string, unknown> }).links;

	const blocks: RenderedBlock[] = [];
	let line = 1;
	let skippedH1 = false;

	for (const token of tokens) {
		const startLine = line;
		const rawNewlines = countNewlines((token as { raw?: string }).raw);
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

		let html = rawHtml;
		let subLines: number[] = [];
		if (token.type === 'list') {
			({ html, subLines } = annotateList(token as Tokens.List, html, startLine));
		} else if (token.type === 'table') {
			({ html, subLines } = annotateTable(token as Tokens.Table, html, startLine));
		} else if (token.type === 'code') {
			({ html, subLines } = annotateCode(token as Tokens.Code, html, startLine));
		}

		blocks.push({
			line: startLine,
			html: DOMPurify.sanitize(html, { ADD_ATTR: ['id'] }),
			subLines
		});
	}

	return blocks;
}

function countNewlines(s: string | undefined): number {
	return s ? (s.match(/\n/g) ?? []).length : 0;
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

// Add `data-md-line` and `class="md-sub"` to an existing `<tag ...>` open
// string. If a class attribute already exists, append; otherwise add one.
function addSubAttrs(openTag: string, line: number): string {
	let out = openTag;
	if (/\sclass\s*=\s*"[^"]*"/.test(out)) {
		out = out.replace(/\sclass\s*=\s*"([^"]*)"/, (_, c) => ` class="${c} md-sub"`);
	} else {
		out = out.replace(/^<([a-zA-Z][\w-]*)/, (_, t) => `<${t} class="md-sub"`);
	}
	out = out.replace(/^<([a-zA-Z][\w-]*)/, (_, t) => `<${t} data-md-line="${line}"`);
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
	const result = annotateListInto(token, html, startLine, subLines);
	return { html: result ?? html, subLines };
}

// Recursive worker that annotates a list's <li> children and walks into each
// item's nested <ul>/<ol> so deeper items become their own sub-anchors too.
// Pushes every annotated line into `subLinesOut` (flat, depth-independent).
// Returns null when the HTML shape is unexpected so the caller can bail.
function annotateListInto(
	token: Tokens.List,
	html: string,
	startLine: number,
	subLinesOut: number[]
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
			nestedInfo.length > 0 ? annotateNestedLists(inner, nestedInfo, subLinesOut) : inner;

		return {
			open: addSubAttrs(openTag, itemLine),
			inner: linkButtonHtml(itemLine) + commentButtonHtml(itemLine) + processedInner
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
	subLinesOut: number[]
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
		const annotated = annotateListInto(token, fullList, line, subLinesOut);
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
		const buttons = linkButtonHtml(rowLine) + commentButtonHtml(rowLine);
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
