// Artifacts: the things in a thread worth looking at on their own, beyond the text. Changes the agent made to files,
// files it wrote, and HTML or SVG it produced. Every client finds them the same way; each shows them as well as it
// can (the web view renders them, the terminal UI shows diffs in color and opens the rest in a browser).
import type { Item, ToolItem } from "./thread.ts";

export type ArtifactKind = "diff" | "html" | "svg" | "markdown" | "code" | "image";

export type Artifact = {
	/** Stable across renders: the tool call or message it came from, plus its position there. */
	key: string;
	kind: ArtifactKind;
	/** What to call it: a file path, or e.g. "HTML snippet". */
	title: string;
	/** The project file it belongs to, when it is one (relative or absolute, as the agent wrote it). */
	path?: string;
	/** The text: file contents, a snippet, or a unified patch for diffs. */
	content: string;
	/** Language for highlighting, from the file name or the code fence. */
	lang?: string;
	/** Where it came from: an edit or write by the agent, or a block in a reply. */
	/** "file" is a project file someone opened, not something the agent produced. */
	source: "edit" | "write" | "reply" | "file";
	/** Lines to show selected, "12-16", when a project file is opened from a citation. */
	lines?: string;
};

const EXTENSION_KIND: Record<string, ArtifactKind> = {
	html: "html",
	htm: "html",
	svg: "svg",
	md: "markdown",
	markdown: "markdown",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
};

const FENCE_KIND: Record<string, ArtifactKind> = { html: "html", svg: "svg", xml: "code" };

function extension(path: string): string {
	return path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

/** The kind of artifact a file is, from its name. */
export function kindOfPath(path: string): ArtifactKind {
	return EXTENSION_KIND[extension(path)] ?? "code";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** What a finished tool call produced: a diff for an edit, the file for a write. */
export function toolArtifacts(tool: ToolItem): Artifact[] {
	if (tool.status !== "done") return [];
	const path = str(tool.args.path) ?? str(tool.args.file_path);
	if (path === undefined) return [];
	if (tool.name === "edit") {
		const patch = str((tool.details as { patch?: unknown } | undefined)?.patch);
		if (patch === undefined || patch.length === 0) return [];
		return [{ key: `${tool.key}:diff`, kind: "diff", title: path, path, content: patch, lang: extension(path), source: "edit" }];
	}
	if (tool.name === "write") {
		const content = str(tool.args.content);
		if (content === undefined) return [];
		return [{ key: `${tool.key}:file`, kind: kindOfPath(path), title: path, path, content, lang: extension(path), source: "write" }];
	}
	return [];
}

/** HTML and SVG blocks in a reply (```html / ```svg fences, or a bare <svg> block). */
export function replyArtifacts(key: string, markdown: string): Artifact[] {
	const out: Artifact[] = [];
	const fence = /^```([\w+-]*)[^\n]*\n([\s\S]*?)^```\s*$/gm;
	let n = 0;
	for (const match of markdown.matchAll(fence)) {
		const lang = (match[1] ?? "").toLowerCase();
		const body = match[2] ?? "";
		const kind = FENCE_KIND[lang] ?? (lang === "" && /^\s*<svg[\s>]/i.test(body) ? "svg" : undefined);
		if (kind === undefined || kind === "code") continue;
		out.push({ key: `${key}:block${n++}`, kind, title: kind === "html" ? "HTML snippet" : "SVG image", content: body, lang, source: "reply" });
	}
	return out;
}

/** Every artifact in a thread, oldest first; for a file changed several times, every version. */
export function threadArtifacts(items: readonly Item[]): Artifact[] {
	const out: Artifact[] = [];
	for (const item of items) {
		if (item.kind === "tool") out.push(...toolArtifacts(item));
		else if (item.kind === "assistant" && !item.streaming) out.push(...replyArtifacts(item.key, item.text));
	}
	return out;
}

/** Lines added and removed in a unified patch. */
export function patchStats(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
