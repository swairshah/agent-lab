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
		link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, tokens }: Tokens.Link) {
			// The link's own Markdown, so [`cart.js`](cart.js) shows as code, not with backticks.
			const text = this.parser.parseInline(tokens);
			if (/^https?:|^mailto:/i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
			// A project file the agent cites, as Delta has it: `path`, `path#L10-L20` or `path#heading`. It opens in the panel.
			const file = fileLink(href);
			return file ? `<button type="button" class="file-link cite" data-path="${escapeHtml(file.path)}"${file.lines ? ` data-lines="${file.lines}"` : ""}>${text}</button>` : text;
		},
		image: ({ text }) => escapeHtml(text),
		code: ({ text, lang }) => {
			const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			// Placeholders the thread view fills with highlighted code, or with an artifact card for HTML/SVG.
			return `<div class="code-slot" data-lang="${escapeHtml(language)}"><pre><code>${escapeHtml(text)}</code></pre></div>`;
		},
	},
});

/** A link to a project file: a relative path without a scheme or "..", with lines from a `#L10` or `#L10-L20` anchor. */
export function fileLink(href: string): { path: string; lines?: string } | undefined {
	const [path = "", anchor = ""] = href.trim().split("#");
	if (path === "" || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(path) || path.split("/").includes("..")) return undefined;
	const lines = anchor.match(/^L(\d+)(?:-L?(\d+))?$/);
	return { path: decodeURI(path.replace(/^\.\//, "").replace(/^\//, "")), lines: lines ? `${lines[1]}-${lines[2] ?? lines[1]}` : undefined };
}

/** `breaks` keeps single line breaks, as people write messages. */
export function renderMarkdown(text: string, options: { breaks?: boolean } = {}): string {
	return marked.parse(text, { async: false, breaks: options.breaks ?? false });
}
