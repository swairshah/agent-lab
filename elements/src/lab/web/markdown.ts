// Markdown for messages and replies, as the app renders it (long-horizon-agent/src/web/chat/markdown.ts): model output
// is untrusted, so raw HTML is shown as text, links open in a new tab and cannot run script, images are not loaded.
import { marked } from "marked";

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

marked.use({
	renderer: {
		html: (token) => escapeHtml(token.text),
		link(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, tokens }: { href: string; tokens: unknown[] }) {
			const text = this.parser.parseInline(tokens);
			return /^https?:|^mailto:/i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
		},
		image: ({ text }) => escapeHtml(text),
		code: ({ text }) => `<div class="code-slot"><pre><code>${escapeHtml(text)}</code></pre></div>`,
	},
});

export function renderMarkdown(text: string, options: { breaks?: boolean } = {}): string {
	return marked.parse(text, { async: false, gfm: true, breaks: options.breaks ?? false }) as string;
}

/** A person's color, from their name, as the app gives it (dom.ts). */
export function personColor(name: string): string {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return `hsl(${h % 360} var(--person-s) var(--person-l))`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}
