import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Render arbitrary markdown to safe HTML. Bodies come from other users' PDS
// records, so sanitizing is mandatory — DOMPurify strips scripts, event
// handlers, and dangerous URIs from the marked output.
export function renderMarkdown(src: string): string {
	const rawHtml = marked.parse(src, { async: false }) as string;
	return DOMPurify.sanitize(rawHtml);
}
