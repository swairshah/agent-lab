// Comments on part of a message, as in Delta: select text in a message of the thread, and a small Comment button
// appears under the selection; it (or Enter) opens a box right under the paragraph, where ⌘↩ sends a comment
// quoting the selection and Esc drops it.
import type { LineComment } from "../shared/protocol.ts";
import { el } from "./dom.ts";

const ICON = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export class QuoteComments {
	readonly #thread: HTMLElement;
	readonly #send: (comment: LineComment) => void;
	/** The pill or box that's showing, and what it's about. */
	#shown: HTMLElement | undefined;
	#quote: { message: string; text: string; block: HTMLElement } | undefined;

	constructor(thread: HTMLElement, send: (comment: LineComment) => void) {
		this.#thread = thread;
		this.#send = send;
		document.addEventListener("selectionchange", () => {
			// The pill follows the selection; an open box stays until it's sent or dropped.
			if (this.#shown?.classList.contains("quote-box")) return;
			requestAnimationFrame(() => this.#update());
		});
		document.addEventListener(
			"keydown",
			(event) => {
				if (this.#shown === undefined) return;
				const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					this.#close(true);
				} else if (event.key === "Enter" && !typing && this.#shown.classList.contains("quote-pill-row")) {
					event.preventDefault();
					this.#open();
				}
			},
			true,
		);
	}

	/** The message a selection is in, when it's within one message's text. */
	#selected(): { message: string; text: string; block: HTMLElement } | undefined {
		const selection = getSelection();
		if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
		const text = selection.toString().trim();
		if (text === "") return undefined;
		const range = selection.getRangeAt(0);
		const at = (node: Node) => (node instanceof Element ? node : node.parentElement);
		const start = at(range.startContainer)?.closest<HTMLElement>(".msg[data-key]");
		const end = at(range.endContainer)?.closest<HTMLElement>(".msg[data-key]");
		if (!start || start !== end || !this.#thread.contains(start)) return undefined;
		// The block the box goes under: the paragraph, list item, table or heading the selection ends in.
		const body = start.querySelector<HTMLElement>(".msg-body") ?? start;
		let block = at(range.endContainer) as HTMLElement;
		while (block.parentElement && block.parentElement !== body) block = block.parentElement;
		if (!body.contains(block)) return undefined;
		return { message: start.dataset.key!, text, block };
	}

	#update(): void {
		const quote = this.#selected();
		this.#close(false);
		if (quote === undefined) return;
		this.#quote = quote;
		const row = el("div", "quote-pill-row");
		const pill = el("button", "comment-pill");
		pill.type = "button";
		pill.title = "Comment on this (Enter)";
		pill.innerHTML = `${ICON}Comment`;
		// Keep the selection: a mousedown on the button would otherwise clear it.
		pill.addEventListener("mousedown", (event) => event.preventDefault());
		pill.onclick = () => this.#open();
		row.append(pill);
		quote.block.after(row);
		this.#shown = row;
	}

	#open(): void {
		const quote = this.#quote;
		if (quote === undefined) return;
		this.#close(false);
		this.#quote = quote;
		const box = el("div", "quote-box line-comment");
		const shown = quote.text.length > 140 ? `${quote.text.slice(0, 140)}…` : quote.text;
		box.append(el("blockquote", "quote-excerpt", shown));
		const input = el("textarea");
		input.rows = 2;
		input.placeholder = "Comment on this";
		const send = () => {
			const text = input.value.trim();
			if (!text) return;
			this.#send({ path: "", start: 0, end: 0, excerpt: quote.text, text, message: quote.message });
			this.#close(true);
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				send();
			}
		});
		const actions = el("div", "line-comment-actions");
		actions.append(el("span", "muted", "⌘↩ to send, Esc to cancel"));
		const cancel = el("button", "text-button", "Cancel");
		cancel.type = "button";
		cancel.onclick = () => this.#close(true);
		const ok = el("button", "button primary", "Comment");
		ok.type = "button";
		ok.onclick = send;
		actions.append(cancel, ok);
		box.append(input, actions);
		quote.block.after(box);
		this.#shown = box;
		input.focus();
	}

	/** Removes the pill or box; `clear` also drops the text selection. */
	#close(clear: boolean): void {
		this.#shown?.remove();
		this.#shown = undefined;
		this.#quote = undefined;
		if (clear) getSelection()?.removeAllRanges();
	}
}
