import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Item, type SessionMeta, SessionStore } from "./store.ts";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function block(item: Item, label: (harness: string) => string): string {
	switch (item.kind) {
		case "user":
			return `<section class="user"><h3>You</h3><pre>${esc(item.data.text)}</pre></section>`;
		case "assistant":
			return `<section class="assistant"><h3>${esc(label(item.data.harness))}${item.data.model ? ` <small>${esc(item.data.model)}</small>` : ""}</h3>${item.data.thinking ? `<details><summary>thinking</summary><pre>${esc(item.data.thinking)}</pre></details>` : ""}<pre>${esc(item.data.text)}</pre></section>`;
		case "tool": {
			const diffs = (item.data.diffs ?? []).map((d) => `<div class="diff"><b>${esc(d.path)}</b><pre>${esc(d.newText)}</pre></div>`).join("");
			return `<section class="tool ${esc(item.data.status)}"><details><summary>${esc(item.data.title)} <small>${esc(item.data.status)}</small></summary>${item.data.input !== undefined ? `<pre>${esc(JSON.stringify(item.data.input, null, 2))}</pre>` : ""}${item.data.output ? `<pre>${esc(item.data.output)}</pre>` : ""}${diffs}</details></section>`;
		}
		case "plan":
			return `<section class="plan"><h3>Plan</h3><ul>${item.data.entries.map((e) => `<li class="${esc(e.status)}">${esc(e.content)} <small>${esc(e.status)}</small></li>`).join("")}</ul></section>`;
		case "shell":
			return `<section class="shell"><h3>$ ${esc(item.data.command)}</h3><pre>${esc(item.data.output)}</pre></section>`;
		case "switch":
			return `<p class="meta">switched to ${esc(label(item.data.harness))}</p>`;
		case "note":
			return item.data.display ? `<section class="tool"><h3>${esc(item.data.customType)}</h3><pre>${esc(item.data.content)}</pre></section>` : "";
		case "custom":
			return "";
		case "summary":
			return `<section class="reset"><h3>Branch summary</h3><pre>${esc(item.data.text)}</pre></section>`;
		case "reset":
			return `<section class="reset"><h3>Compacted</h3><pre>${esc(item.data.summary ?? "")}</pre></section>`;
		case "turn":
			return item.data.error ? `<p class="meta error">${esc(item.data.error)}</p>` : item.data.stopReason !== "end_turn" ? `<p class="meta">${esc(item.data.stopReason)}</p>` : "";
	}
}

export function renderHtml(meta: SessionMeta, items: Item[], label: (harness: string) => string): string {
	const title = esc(meta.name ?? meta.first ?? meta.id);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1f2328; --dim: #6b7280; --line: #e4e4e0; --user: #eef3ff; --tool: #f3f3ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181c; --fg: #e6e6e3; --dim: #9aa0aa; --line: #2c2f36; --user: #1d2536; --tool: #1e2024; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
h1 { font-size: 20px; margin: 0 0 4px; } header p { color: var(--dim); margin: 0 0 24px; font-size: 13px; }
section { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 12px 0; }
section.user { background: var(--user); } section.tool, section.shell { background: var(--tool); font-size: 13px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); margin: 0 0 6px; } h3 small, summary small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--dim); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 13px/1.5 ui-monospace, monospace; } section.user pre, section.assistant > pre, section.reset pre { font: inherit; }
details pre { margin-top: 8px; } .meta { color: var(--dim); font-size: 12px; text-align: center; } .error { color: #c0392b; }
</style></head><body>
<header><h1>${title}</h1><p>${esc(meta.cwd)} · ${new Date(meta.created).toISOString()} · session ${esc(meta.id)}</p></header>
${items.map((item) => block(item, label)).filter(Boolean).join("\n")}
</body></html>
`;
}

export function exportSession(meta: SessionMeta, items: Item[], label: (harness: string) => string, output: string): string {
	const path = resolve(output);
	if (path.endsWith(".jsonl")) writeFileSync(path, `${[{ type: "session", version: 1, ...meta }, ...items].map((line) => JSON.stringify(line)).join("\n")}\n`);
	else writeFileSync(path, renderHtml(meta, items, label));
	return path;
}

export async function importSession(input: string, root: string, cwd: string): Promise<string> {
	const lines = readFileSync(resolve(input), "utf8").split("\n").filter((line) => line.trim());
	const header = JSON.parse(lines[0] ?? "{}") as Partial<SessionMeta> & { type?: string };
	if (header.type !== "session") throw new Error(`${input} is not a pid0 session export (its first line is not a session header)`);
	const store = await SessionStore.create({ root, cwd, ...(header.name ? { name: header.name } : {}), ...(header.id ? { parentSession: header.id } : {}) });
	try {
		for (const line of lines.slice(1)) {
			const item = JSON.parse(line) as Item;
			if (item.kind === "reset") await store.reset(item.data.summary);
			else await store.append(item.kind, item.data as never);
		}
	} finally {
		await store.close();
	}
	return store.file!;
}
