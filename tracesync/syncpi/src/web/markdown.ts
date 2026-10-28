// Markdown for replies. Model output is untrusted: raw HTML is shown as text, links can't run script, and remote
// images aren't loaded. HTML and SVG code blocks become artifact cards (see artifacts.ts), placed where they occur;
// mermaid blocks become diagrams (diagrams.ts). GitHub alerts (> [!WARNING] ...) get a titled box.
import { marked, type Tokens } from "marked";
import { escapeHtml } from "./dom.ts";

const ALERTS: Record<string, string> = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

marked.use({
	renderer: {
		blockquote(this: { parser: { parse(tokens: Tokens.Generic[]): string } }, { tokens }: Tokens.Blockquote) {
			const body = this.parser.parse(tokens);
			const alert = body.match(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
			if (alert === null) return `<blockquote>${body}</blockquote>`;
			const kind = alert[1]!;
			return `<div class="alert alert-${kind.toLowerCase()}"><div class="alert-title">${ALERTS[kind]}</div><p>${body.slice(alert[0].length)}</div>`;
		},
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
