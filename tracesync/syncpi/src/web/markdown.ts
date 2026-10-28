// Markdown for replies. Model output is untrusted: raw HTML is shown as text, links can't run script, and remote
// images aren't loaded. HTML and SVG code blocks become artifact cards (see artifacts.ts), placed where they occur.
import { marked } from "marked";
import { escapeHtml } from "./dom.ts";

marked.use({
	renderer: {
		html: (token) => escapeHtml(token.text),
		link: ({ href, text }) => (/^https?:|^mailto:/i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text)),
		image: ({ text }) => escapeHtml(text),
		code: ({ text, lang }) => {
			const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			// Placeholders the thread view fills with highlighted code, or with an artifact card for HTML/SVG.
			return `<div class="code-slot" data-lang="${escapeHtml(language)}"><pre><code>${escapeHtml(text)}</code></pre></div>`;
		},
	},
});

export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false });
}
