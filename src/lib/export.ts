import { slugify } from './markdown';

// Browser-only: triggers a `.md` file download in the visitor's browser. The
// document body comes from the PDS verbatim; we only prepend `# Title` when
// the body doesn't already lead with a top-level heading, so the exported
// file is self-contained.
export function downloadMarkdown(title: string, body: string, fallbackName: string): void {
	if (typeof document === 'undefined') return;

	const hasLeadingH1 = /^\s*#\s+/.test(body);
	const content = hasLeadingH1 ? body : `# ${title}\n\n${body}`;
	const name = `${slugify(title) || fallbackName}.md`;

	const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
