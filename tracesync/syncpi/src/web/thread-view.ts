// The thread: people's messages, the agent's replies, its tool calls and their artifacts, and notices. Each row has an
// avatar column and its content, as in a conversation; thinking and tool calls are one quiet line until opened.
// Items are rendered once per revision and replaced in place when they change, so a long thread stays cheap.
import { type Artifact, kindOfPath, patchStats, replyArtifacts, toolArtifacts } from "../shared/artifacts.ts";
import type { LineComment } from "../shared/protocol.ts";
import type { Item, ToolItem, UserItem } from "../shared/thread.ts";
import { isQuietTool, toolGroupSummary, toolSummary } from "../shared/thread.ts";
import { artifactCard, type CommentHandler, disposeWithin, type ImageLoader, renderCode } from "./artifacts.ts";
import { renderDiagram } from "./diagrams.ts";
import { el, escapeHtml, initials, personColor } from "./dom.ts";
import { modelAvatar } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import type { SessionClient } from "./session.ts";

export type ThreadViewOptions = {
	onOpenArtifact: (artifact: Artifact) => void;
	onFork: (key: string, text: string) => void;
	/** Opens a project file in the side panel, with lines selected when given ("12-16"). */
	onOpenFile: (path: string, lines?: string) => void;
	loadImage: ImageLoader;
	/** Sends a comment on lines of a file, from a diff or file in the thread. */
	onComment: CommentHandler;
};

const TOOL_VERB: Record<string, string> = { bash: "Ran", edit: "Edited", write: "Wrote", read: "Read" };

export function avatarHtml(name: string): string {
	return `<span class="avatar" style="--person:${personColor(name)}" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</span>`;
}

/** Copies a code block's text; shows on hover in its corner. */
function copyButton(code: string): HTMLButtonElement {
	const button = el("button", "copy-code", "Copy");
	button.type = "button";
	button.contentEditable = "false";
	button.addEventListener("click", () => {
		void navigator.clipboard?.writeText(code).then(() => {
			button.textContent = "Copied";
			setTimeout(() => (button.textContent = "Copy"), 1200);
		});
	});
	return button;
}

export class ThreadView {
	readonly #box: HTMLElement;
	readonly #scroller: HTMLElement;
	readonly #session: SessionClient;
	readonly #options: ThreadViewOptions;
	#rendered: { key: string; sig: string; el: HTMLElement }[] = [];
	#conv: "main" | "setup" = "main";

	constructor(box: HTMLElement, scroller: HTMLElement, session: SessionClient, options: ThreadViewOptions) {
		this.#box = box;
		this.#scroller = scroller;
		this.#session = session;
		this.#options = options;
		// File links in replies (citations and file names in backticks).
		box.addEventListener("click", (event) => {
			const link = (event.target as HTMLElement).closest<HTMLElement>(".cite[data-path]");
			if (link) options.onOpenFile(link.dataset.path!, link.dataset.lines);
		});
	}

	show(conv: "main" | "setup"): void {
		this.#conv = conv;
		this.reset();
	}

	/** Scrolls to a message (by its key) and flashes it, as the inbox does. Returns whether it's in the thread. */
	reveal(key: string): boolean {
		if (this.#conv !== "main") this.show("main");
		const node = this.#box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		if (node === null) return false;
		node.scrollIntoView({ block: "center", behavior: "smooth" });
		node.classList.remove("flash");
		void node.offsetWidth;
		node.classList.add("flash");
		return true;
	}

	/** "@Name" for members of the session, in a message's text: marked, and more strongly when it's you. */
	#markMentions(body: HTMLElement): void {
		const names = [...this.#session.names.values()].filter(Boolean).sort((a, b) => b.length - a.length);
		if (names.length === 0) return;
		const me = this.#session.me?.name.toLowerCase();
		const pattern = new RegExp(`(^|[^\\w@])@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])`, "gi");
		const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest("pre, code, a, .mention") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
		const texts: Text[] = [];
		for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n as Text);
		for (const node of texts) {
			const text = node.textContent ?? "";
			pattern.lastIndex = 0;
			if (!pattern.test(text)) continue;
			pattern.lastIndex = 0;
			const out = document.createDocumentFragment();
			let at = 0;
			for (const m of text.matchAll(pattern)) {
				const start = m.index! + m[1]!.length;
				out.append(text.slice(at, start));
				const span = el("span", m[2]!.toLowerCase() === me ? "mention me" : "mention", `@${m[2]}`);
				out.append(span);
				at = start + 1 + m[2]!.length;
			}
			out.append(text.slice(at));
			node.replaceWith(out);
		}
	}

	/** Re-renders everything, e.g. after a rename (authors show current names) or a role change. */
	reset(): void {
		disposeWithin(this.#box);
		this.#box.replaceChildren();
		this.#rendered = [];
		this.render();
	}

	render(): void {
		const box = this.#box;
		const scroller = this.#scroller;
		const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
		const items = this.#session.threads[this.#conv].state.items;
		const units = displayUnits(items);
		// Comments on messages, by the message they're on: they show there, inline, as in Delta.
		const marks = new Map<string, { excerpt: string; text: string; name: string }[]>();
		for (const item of items) {
			if (item.kind !== "user") continue;
			for (const c of item.comments ?? []) {
				if (c.message === undefined) continue;
				const name = this.#session.nameOf(item.memberId, item.author ?? "someone");
				marks.set(c.message, [...(marks.get(c.message) ?? []), { excerpt: c.excerpt, text: c.text, name }]);
			}
		}
		for (let i = 0; i < units.length; i++) {
			const unit = units[i]!;
			const have = this.#rendered[i];
			const sig = `${unit.sig}|${marks.get(unit.key)?.length ?? 0}`;
			if (have !== undefined && have.key === unit.key && have.sig === sig) continue;
			const node = unit.tools.length > 1 ? this.#agentRow(this.#group(unit.tools, unit.key), this.#modelBefore(items, unit.index), false) : this.#item(items[unit.index]!, items, unit.index);
			// Messages can be commented on by selecting their text (quote-comments.ts).
			if (unit.tools.length === 0) node.dataset.key = unit.key;
			for (const mark of marks.get(unit.key) ?? []) this.#mark(node, mark);
			// A folded row keeps its open/closed state across updates once its tool has finished; not the state it had
			// while running (an edit has no diff to show until it's done, and opens then).
			const before = have?.el.querySelector<HTMLDetailsElement>(":scope .tool");
			const after = node.querySelector<HTMLDetailsElement>(":scope .tool");
			const settled = unit.tools.every((t) => t.status !== "running" && t.status !== "pending");
			if (after) after.dataset.settled = String(settled);
			if (before && after && have?.key === unit.key && unit.tools.length > 0 && settled && before.dataset.settled === "true") after.open = before.open;
			if (have === undefined) {
				// New items go above the messages still waiting to be sent.
				const pending = box.querySelector(":scope > .pending");
				if (pending !== null) pending.before(node);
				else box.append(node);
			} else {
				disposeWithin(have.el);
				have.el.replaceWith(node);
			}
			this.#rendered[i] = { key: unit.key, sig, el: node };
		}
		for (const extra of this.#rendered.splice(units.length)) {
			disposeWithin(extra.el);
			extra.el.remove();
		}
		this.#renderPending();
		if (follow) scroller.scrollTop = scroller.scrollHeight;
	}

	/** Messages sent from this browser that the server hasn't acknowledged yet. */
	#renderPending(): void {
		for (const old of this.#box.querySelectorAll(":scope > .pending")) old.remove();
		if (this.#conv !== "main") return;
		for (const message of this.#session.outbox.values()) {
			const node = this.#user(this.#session.me?.name ?? "you", message.text, (message.attachments ?? []).map((a) => ({ name: a.name, kind: a.mimeType.startsWith("image/") ? "image" : "text" })), "sending…");
			node.classList.add("pending");
			this.#box.append(node);
		}
	}

	#item(item: Item, items: readonly Item[], index: number): HTMLElement {
		switch (item.kind) {
			case "user": {
				const name = this.#session.nameOf(item.memberId, item.author ?? "someone");
				const node = this.#user(name, item.text, item.attachments ?? [], undefined, item.comments);
				if (this.#session.role === "admin" && this.#conv === "main" && /^\d+$/.test(item.key)) {
					const fork = el("button", "msg-action", "Edit & fork");
					fork.type = "button";
					fork.title = "Branch the thread just before this message and edit it";
					fork.onclick = () => this.#options.onFork(item.key, item.text);
					node.querySelector(".msg-meta")!.append(fork);
				}
				return node;
			}
			case "assistant":
				// A turn that only called tools has nothing to show of its own.
				if (!item.text && !item.thinking && !item.error && !item.streaming) return Object.assign(el("div"), { hidden: true });
				return this.#agentRow(this.#assistant(item), item.model, item.streaming);
			case "tool":
				return this.#agentRow(this.#tool(item), this.#modelBefore(items, index), false);
			case "notice":
				return el("div", "notice", item.text);
		}
	}

	/** A comment shown where it was made: the commented text tinted and underlined, the note under its paragraph. */
	#mark(node: HTMLElement, mark: { excerpt: string; text: string; name: string }): void {
		const body = node.querySelector<HTMLElement>(".msg-body");
		if (body === null) return;
		// The text nodes of the message, as one string with offsets back into them.
		const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => (n.parentElement?.closest(".inline-comment, pre, .artifact, .viewer, .copy-code") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
		});
		const nodes: { node: Text; start: number }[] = [];
		let full = "";
		for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
			nodes.push({ node: n as Text, start: full.length });
			full += n.textContent;
		}
		const squash = (s: string) => s.replace(/\s+/g, " ").trim();
		const lines = mark.excerpt.split("\n").map(squash).filter(Boolean);
		let block: Element | null = null;
		for (const line of lines) {
			const at = full.replace(/\s/g, " ").indexOf(line.slice(0, 200));
			if (at < 0) continue;
			const end = at + Math.min(line.length, 200);
			// Wrap the matched range, text node by text node.
			for (const { node: t, start } of nodes) {
				const from = Math.max(at, start);
				const to = Math.min(end, start + (t.textContent?.length ?? 0));
				if (from >= to) continue;
				const range = document.createRange();
				range.setStart(t, from - start);
				range.setEnd(t, to - start);
				const tint = el("mark", "commented");
				range.surroundContents(tint);
				let b: Element = tint;
				while (b.parentElement && b.parentElement !== body) b = b.parentElement;
				block = b;
				break;
			}
		}
		const note = el("div", "inline-comment");
		note.contentEditable = "false";
		note.innerHTML = avatarHtml(mark.name);
		note.append(el("span", "inline-comment-text", mark.text));
		if (block !== null) block.after(note);
		else body.append(note);
	}

	/** A comment on file lines, as Delta shows it: the file and lines (opening the file), the lines, the note. */
	#comment(c: LineComment, name: string): HTMLElement {
		const card = el("div", "comment-card");
		// On part of a message: the quote and the note.
		if (c.message !== undefined) {
			card.append(el("div", "comment-on", "On a message"), el("blockquote", "quote-excerpt", c.excerpt));
			const note = el("div", "comment-note");
			note.innerHTML = avatarHtml(name);
			note.append(el("div", "comment-text", c.text));
			card.append(note);
			return card;
		}
		const where = el("button", "file-link comment-where", `${c.path}:${c.start === c.end ? c.start : `${c.start}-${c.end}`}`);
		where.type = "button";
		where.onclick = () => this.#options.onOpenFile(c.path);
		const lines = el("div", "comment-lines");
		const shown = c.excerpt.split("\n");
		for (const [n, line] of shown.slice(0, 6).entries()) {
			const row = el("div", "comment-line");
			row.append(el("span", "comment-number", String(c.start + n)), el("span", "comment-code", line || " "));
			lines.append(row);
		}
		if (shown.length > 6) lines.append(el("div", "comment-more", `${shown.length - 6} more lines`));
		const note = el("div", "comment-note");
		note.innerHTML = avatarHtml(name);
		note.append(el("div", "comment-text", c.text));
		card.append(where, lines, note);
		return card;
	}

	#user(name: string, text: string, attachments: NonNullable<UserItem["attachments"]>, status?: string, comments: LineComment[] = []): HTMLElement {
		const node = el("article", "msg msg-user");
		node.style.setProperty("--person", personColor(name));
		node.innerHTML = `${avatarHtml(name)}<div class="msg-content"><div class="msg-meta"><span class="author">${escapeHtml(name)}</span>${
			status ? `<span>${escapeHtml(status)}</span>` : ""
		}</div>${text ? `<div class="msg-body prose">${renderMarkdown(text, { breaks: true })}</div>` : ""}</div>`;
		const body = node.querySelector<HTMLElement>(".msg-body");
		if (body !== null) {
			this.#linkFileNames(body);
			this.#markMentions(body);
		}
		if (comments.length > 0) {
			const box = el("details", "fold comments");
			box.open = true;
			box.innerHTML = `<summary>${comments.length === 1 ? "1 comment" : `${comments.length} comments`}</summary>`;
			for (const c of comments) box.append(this.#comment(c, name));
			// The comments first, then what was written with them, as Delta shows it.
			if (body !== null) body.before(box);
			else node.querySelector(".msg-content")!.append(box);
		}
		if (attachments.length > 0) {
			const box = el("div", "attached");
			for (const a of attachments) {
				if (a.url !== undefined) box.append(Object.assign(el("img"), { src: a.url, alt: a.name, title: a.name }));
				else box.append(el("span", "file-chip", a.name));
			}
			node.querySelector(".msg-content")!.append(box);
		}
		return node;
	}

	/** A tool call belongs to the reply that made it. */
	#modelBefore(items: readonly Item[], index: number): string | undefined {
		for (let i = index - 1; i >= 0; i--) {
			const item = items[i]!;
			if (item.kind === "assistant") return item.model;
			if (item.kind === "user") break;
		}
		return this.#session.threads[this.#conv].state.model;
	}

	/** The agent's rows share one avatar column, showing the model's mark once per run of rows. */
	#agentRow(content: HTMLElement, model: string | undefined, streaming: boolean): HTMLElement {
		const node = el("article", `msg msg-agent${streaming ? " streaming" : ""}`);
		node.innerHTML = modelAvatar(model);
		content.classList.add("msg-content");
		node.append(content);
		return node;
	}

	#assistant(item: Extract<Item, { kind: "assistant" }>): HTMLElement {
		const content = el("div");
		if (item.thinking) {
			const thinking = el("details", "fold thinking");
			thinking.innerHTML = `<summary>${item.streaming && !item.text ? "Thinking…" : "Thinking"}</summary><div class="thinking-body">${escapeHtml(item.thinking)}</div>`;
			content.append(thinking);
		}
		if (item.text) {
			const body = el("div", "msg-body prose");
			body.innerHTML = renderMarkdown(item.text);
			this.#linkFileNames(body);
			content.append(body);
			if (!item.streaming) this.#upgradeCode(body, item.key, item.text);
		}
		if (item.error) content.append(el("div", "msg-error", item.error));
		return content;
	}

	/** File names in backticks that are project files become links, as in Delta. */
	#linkFileNames(body: HTMLElement): void {
		const files = new Set(this.#session.files);
		if (files.size === 0) return;
		for (const code of body.querySelectorAll<HTMLElement>(":not(pre) > code")) {
			const name = code.textContent?.trim() ?? "";
			const path = files.has(name) ? name : files.has(name.replace(/^\.\//, "")) ? name.replace(/^\.\//, "") : undefined;
			if (path === undefined) continue;
			code.classList.add("cite");
			code.dataset.path = path;
		}
	}

	/** Code blocks get highlighting; HTML and SVG blocks become artifact cards with a live preview; mermaid blocks
	 *  become diagrams. */
	#upgradeCode(body: HTMLElement, key: string, text: string): void {
		const artifacts = replyArtifacts(key, text);
		let next = 0;
		for (const slot of body.querySelectorAll<HTMLElement>(".code-slot")) {
			const lang = slot.dataset.lang ?? "";
			const code = slot.textContent ?? "";
			const isArtifact = lang === "html" || lang === "svg" || (lang === "" && /^\s*<svg[\s>]/i.test(code));
			const artifact = isArtifact ? artifacts[next++] : undefined;
			if (lang === "mermaid") {
				const host = el("div");
				slot.replaceWith(host);
				renderDiagram(host, code);
			} else if (artifact !== undefined) {
				slot.replaceWith(artifactCard(artifact, { size: "inline", onOpen: this.#options.onOpenArtifact, loadImage: this.#options.loadImage, onComment: this.#options.onComment }));
			} else if (lang !== "" && code.split("\n").length > 1) {
				const host = el("div", "code-block");
				slot.replaceWith(host);
				renderCode(host, `snippet.${lang}`, code.replace(/\n$/, ""));
				host.append(copyButton(code.replace(/\n$/, "")));
			} else slot.append(copyButton(code.replace(/\n$/, "")));
		}
	}

	/** A run of quiet tool calls: one summary line ("Listed 6 directories, read 5 files"), opening to one line per
	 *  call, with file names that open the file. */
	#group(tools: ToolItem[], key: string): HTMLElement {
		const content = el("div");
		const node = el("details", "fold tool tool-group");
		const running = tools.some((t) => t.status === "running" || t.status === "pending");
		node.innerHTML = `<summary><span class="tool-verb">${escapeHtml(toolGroupSummary(tools))}</span>${running ? '<span class="tool-spinner"></span>' : ""}</summary>`;
		const list = el("div", "tool-group-list");
		for (const tool of tools) {
			if (tool.name === "bash") {
				list.append(this.#tool(tool));
				continue;
			}
			const line = el("div", "tool-line");
			const target = toolSummary(tool);
			line.append(el("span", "tool-verb", tool.name === "read" ? "Read" : tool.name === "ls" ? "List directory" : tool.name === "find" ? "Find files" : "Search"));
			const path = typeof tool.args.path === "string" ? tool.args.path : undefined;
			if (tool.name === "read" && path !== undefined) {
				const link = el("button", "file-link", path);
				link.type = "button";
				link.onclick = () => this.#options.onOpenFile(path);
				line.append(link);
			} else line.append(el("span", "tool-arg", target));
			list.append(line);
		}
		node.append(list);
		node.dataset.group = key;
		content.append(node);
		return content;
	}

	#tool(item: ToolItem): HTMLElement {
		const content = el("div");
		const node = el("details", `fold tool tool-${item.status}`);
		const verb = TOOL_VERB[item.name] ?? item.name;
		const artifacts = toolArtifacts(item);
		const diff = artifacts.find((a) => a.kind === "diff");
		const stats = diff ? patchStats(diff.content) : undefined;
		node.innerHTML = `<summary><span class="tool-verb">${escapeHtml(verb)}</span><span class="tool-arg">${escapeHtml(toolSummary(item))}</span>${
			stats ? `<span class="diff-stats"><span class="added">+${stats.added}</span> <span class="removed">−${stats.removed}</span></span>` : ""
		}</summary>`;
		const body = el("div", "tool-body");
		if (artifacts.length > 0) {
			for (const artifact of artifacts) body.append(artifactCard(artifact, { size: "inline", onOpen: this.#options.onOpenArtifact, loadImage: this.#options.loadImage, onComment: this.#options.onComment }));
			// Changes are what people come to see: shown open.
			node.open = true;
		} else if (item.name === "read" && item.status === "done") {
			const path = String(item.args.path ?? "");
			body.append(el("div", "tool-note", kindOfPath(path) === "image" ? "image" : `${item.output.split("\n").length} lines`));
		} else if (item.output.trim()) {
			// Long output shows its end, where the result is, as in Delta; the rest is a click away.
			const lines = item.output.trimEnd().slice(-20_000).split("\n");
			const pre = el("pre", "tool-output");
			const TAIL = 10;
			if (lines.length > TAIL + 3) {
				const more = el("button", "tool-more", `Show ${lines.length - TAIL} more lines`);
				more.type = "button";
				more.contentEditable = "false";
				more.addEventListener("click", () => {
					pre.textContent = lines.join("\n");
					more.remove();
				});
				pre.textContent = lines.slice(-TAIL).join("\n");
				body.append(more, pre);
			} else {
				pre.textContent = lines.join("\n");
				body.append(pre);
			}
		}
		node.append(body);
		if (item.status === "error") node.open = true;
		content.append(node);
		return content;
	}
}

/** What the thread shows, in order: each item on its own, except that a run of quiet tool calls (and the empty
 *  tool-only turns between them) becomes one group. `sig` changes whenever anything in the unit does. */
type Unit = { key: string; sig: string; index: number; tools: ToolItem[] };

function displayUnits(items: readonly Item[]): Unit[] {
	const units: Unit[] = [];
	let group: Unit | undefined;
	const silent = (item: Item) => item.kind === "assistant" && !item.text && !item.thinking && !item.error && !item.streaming;
	items.forEach((item, index) => {
		if (item.kind === "tool" && isQuietTool(item)) {
			if (group === undefined) {
				group = { key: `group:${item.key}`, sig: "", index, tools: [] };
				units.push(group);
			}
			group.tools.push(item);
			group.sig += `${item.key}.${item.rev};`;
			return;
		}
		// An empty turn between quiet calls doesn't end the run.
		if (group !== undefined && silent(item)) return;
		group = undefined;
		units.push({ key: item.key, sig: String(item.rev), index, tools: item.kind === "tool" ? [item] : [] });
	});
	// A run of one is shown as the call itself.
	return units.map((u) => (u.tools.length === 1 && u.key.startsWith("group:") ? { ...u, key: u.tools[0]!.key, sig: String(u.tools[0]!.rev) } : u));
}
