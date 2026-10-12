import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const PAGE_CHARS = 20_000;

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const fetchUrl = defineTool({
	name: "fetch_url",
	description:
		"Fetch a web page or raw file over HTTP(S) and return it as text. HTML is reduced to readable text. " +
		`Long pages are paged: pass offset to continue reading (${PAGE_CHARS} characters per call).`,
	parameters: Type.Object({
		url: Type.String({ description: "Absolute http(s) URL" }),
		offset: Type.Optional(Type.Number({ description: "Character offset to start reading from" })),
	}),
	replay: "safe",
	execute: async (args, _api, context) => {
		const response = await fetch(args.url, {
			signal: context.abortSignal,
			headers: { "user-agent": "frontdesk-worker/0.1", accept: "text/html,text/plain,application/json,*/*" },
		});
		const raw = await response.text();
		const type = response.headers.get("content-type") ?? "";
		const text = type.includes("html") ? htmlToText(raw) : raw;
		const offset = Math.max(0, Math.floor(args.offset ?? 0));
		const page = text.slice(offset, offset + PAGE_CHARS);
		const end = offset + page.length;
		const footer =
			end < text.length ? `\n\n[showing ${offset}-${end} of ${text.length} chars; continue with offset ${end}]` : "";
		return {
			content: [{ type: "text", text: `HTTP ${response.status} ${args.url}\n\n${page}${footer}` }],
		};
	},
});

export const WebTools = defineExtension({ name: "web-tools", tools: [fetchUrl] });
