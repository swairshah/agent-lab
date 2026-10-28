// The thread: people's messages, the agent's replies, its tool calls and their artifacts, and notices. Each row has an
// avatar column and its content, as in a conversation; thinking and tool calls are one quiet line until opened.
// Items are rendered once per revision and replaced in place when they change, so a long thread stays cheap.
import { type Artifact, kindOfPath, patchStats, replyArtifacts, toolArtifacts } from "../shared/artifacts.ts";
import type { Item, ToolItem, UserItem } from "../shared/thread.ts";
import { toolSummary } from "../shared/thread.ts";
import { artifactCard, disposeWithin, type ImageLoader, renderCode } from "./artifacts.ts";
import { renderDiagram } from "./diagrams.ts";
import { el, escapeHtml, initials, personColor } from "./dom.ts";
import { modelAvatar } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import type { SessionClient } from "./session.ts";

export type ThreadViewOptions = {
	onOpenArtifact: (artifact: Artifact) => void;
	onFork: (key: string, text: string) => void;
	loadImage: ImageLoader;
};

const TOOL_VERB: Record<string, string> = { bash: "Ran", edit: "Edited", write: "Wrote", read: "Read" };

export function avatarHtml(name: string): string {
	return `<span class="avatar" style="--person:${personColor(name)}" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</span>`;
}

export class ThreadView {
	readonly #box: HTMLElement;
	readonly #scroller: HTMLElement;
	readonly #session: SessionClient;
	readonly #options: ThreadViewOptions;
	#rendered: { key: string; rev: number; el: HTMLElement }[] = [];
	#conv: "main" | "setup" = "main";

	constructor(box: HTMLElement, scroller: HTMLElement, session: SessionClient, options: ThreadViewOptions) {
		this.#box = box;
		this.#scroller = scroller;
		this.#session = session;
		this.#options = options;
	}

	show(conv: "main" | "setup"): void {
		this.#conv = conv;
		this.reset();
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
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const have = this.#rendered[i];
			if (have !== undefined && have.key === item.key && have.rev === item.rev) continue;
			const node = this.#item(item, items, i);
			// A folded row keeps its open/closed state across updates once its tool has finished.
			const before = have?.el.querySelector<HTMLDetailsElement>(":scope .tool");
			const after = node.querySelector<HTMLDetailsElement>(":scope .tool");
			if (before && after && have?.key === item.key && item.kind === "tool" && item.status !== "running") after.open = before.open;
			if (have === undefined) {
				// New items go above the messages still waiting to be sent.
				const pending = box.querySelector(":scope > .pending");
				if (pending !== null) pending.before(node);
				else box.append(node);
			} else {
				disposeWithin(have.el);
				have.el.replaceWith(node);
			}
			this.#rendered[i] = { key: item.key, rev: item.rev, el: node };
		}
		for (const extra of this.#rendered.splice(items.length)) {
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
				const node = this.#user(name, item.text, item.attachments ?? []);
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

	#user(name: string, text: string, attachments: NonNullable<UserItem["attachments"]>, status?: string): HTMLElement {
		const node = el("article", "msg msg-user");
		node.style.setProperty("--person", personColor(name));
		node.innerHTML = `${avatarHtml(name)}<div class="msg-content"><div class="msg-meta"><span class="author">${escapeHtml(name)}</span>${
			status ? `<span>${escapeHtml(status)}</span>` : ""
		}</div>${text ? `<div class="msg-body">${escapeHtml(text)}</div>` : ""}</div>`;
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
			content.append(body);
			if (!item.streaming) this.#upgradeCode(body, item.key, item.text);
		}
		if (item.error) content.append(el("div", "msg-error", item.error));
		return content;
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
				slot.replaceWith(artifactCard(artifact, { size: "inline", onOpen: this.#options.onOpenArtifact, loadImage: this.#options.loadImage }));
			} else if (lang !== "" && code.split("\n").length > 1) {
				const host = el("div", "code-block");
				slot.replaceWith(host);
				renderCode(host, `snippet.${lang}`, code.replace(/\n$/, ""));
			}
		}
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
			for (const artifact of artifacts) body.append(artifactCard(artifact, { size: "inline", onOpen: this.#options.onOpenArtifact, loadImage: this.#options.loadImage }));
			// Changes are what people come to see: shown open.
			node.open = true;
		} else if (item.name === "read" && item.status === "done") {
			const path = String(item.args.path ?? "");
			body.append(el("div", "tool-note", kindOfPath(path) === "image" ? "image" : `${item.output.split("\n").length} lines`));
		} else if (item.output.trim()) {
			const pre = el("pre", "tool-output");
			pre.textContent = item.output.trimEnd().slice(-20_000);
			body.append(pre);
		}
		node.append(body);
		if (item.status === "error") node.open = true;
		content.append(node);
		return content;
	}
}
