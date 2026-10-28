// Comments on part of a message, as in Delta: select text in a message of the thread, and a small Comment button
// appears under the selection; it (or Enter) opens a box right under the paragraph, where ⌘↩ sends a comment
// quoting the selection and Esc drops it.
//
// The thread also has a text cursor, as in Delta: click anywhere in a message and the arrow keys move through the
// text (Shift selects), across messages. Enter comments on the selection, or on the line the cursor is in. The
// thread is contenteditable for the cursor only: every edit is refused, and controls (buttons, cards, code, diffs)
// are islands the cursor steps over.
import type { LineComment } from "../shared/protocol.ts";
import { el } from "./dom.ts";

const ICON = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export class QuoteComments {
	readonly #thread: HTMLElement;
	readonly #send: (comment: LineComment) => void;
	/** The pill or box that's showing, and what it's about. */
	#shown: HTMLElement | undefined;
	#quote: { message: string; text: string; block: HTMLElement } | undefined;

	constructor(thread: HTMLElement, send: (comment: LineComment) => void, toComposer: () => void) {
		this.#thread = thread;
		this.#send = send;
		// Down past the end of the thread goes back to the composer, as the thread and composer read as one text.
		thread.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown" || event.shiftKey || event.target !== thread) return;
			const selection = getSelection();
			const before = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
			requestAnimationFrame(() => {
				const after = getSelection();
				const moved = before === undefined || !after?.rangeCount || after.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, before) !== 0;
				if (!moved) toComposer();
			});
		});
		thread.contentEditable = "true";
		thread.spellcheck = false;
		thread.setAttribute("aria-readonly", "true");
		// A cursor, not an editor: nothing typed, pasted, cut or dropped changes the thread.
		// (Comment boxes inside the thread are real text fields and keep working.)
		const field = (target: EventTarget | null) => target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
		for (const type of ["beforeinput", "paste", "cut", "drop", "dragover"]) {
			thread.addEventListener(type, (event) => {
				if (!field(event.target)) event.preventDefault();
			});
		}
		thread.addEventListener("compositionstart", () => thread.blur());
		this.#islands();
		new MutationObserver(() => this.#islands()).observe(thread, { childList: true, subtree: true });
		document.addEventListener("selectionchange", () => {
			// The pill follows the selection; an open box stays until it's sent or dropped.
			if (this.#shown?.classList.contains("quote-box")) return;
			requestAnimationFrame(() => this.#update());
		});
		document.addEventListener(
			"keydown",
			(event) => {
				// The cursor in the thread: Enter comments where it is.
				if (event.target === thread && event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					if (!this.#shown?.classList.contains("quote-box")) this.#enter();
					return;
				}
				if (this.#shown === undefined) return;
				const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					this.#close(true);
				} else if (event.key === "Enter" && !typing && this.#shown?.classList.contains("quote-pill-row")) {
					event.preventDefault();
					this.#open();
				}
			},
			true,
		);
	}

	/** Moves the cursor to the end of the thread's text, as Up from the composer's first line does. */
	cursorToEnd(): boolean {
		const bodies = [...this.#thread.querySelectorAll<HTMLElement>(".msg[data-key] .msg-body")];
		for (const body of bodies.reverse()) {
			const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) => (node.parentElement?.closest('[contenteditable="false"]') || !node.textContent?.trim() ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT),
			});
			let last: Node | null = null;
			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node;
			if (last === null) continue;
			this.#thread.focus({ preventScroll: true });
			const range = document.createRange();
			range.setStart(last, last.textContent!.length);
			range.collapse(true);
			const selection = getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			last.parentElement?.scrollIntoView({ block: "nearest" });
			return true;
		}
		return false;
	}

	/** Controls and rendered blocks inside the thread are not part of its text. */
	#islands(): void {
		for (const node of this.#thread.querySelectorAll<HTMLElement>(
			".artifact, .fold summary, .tool-group-list, .msg-meta, .avatar, .msg-action, .comment-card, .attached, .viewer, .code-block, .quote-box, .quote-pill-row, .file-link, button, .notice",
		)) {
			if (node.contentEditable !== "false") node.contentEditable = "false";
		}
	}

	/** Enter in the thread: comment on the selection, or on the line the cursor is in. */
	#enter(): boolean {
		const selection = getSelection();
		if (selection === null || selection.rangeCount === 0 || !this.#thread.contains(selection.anchorNode)) return false;
		if (selection.isCollapsed) {
			const at = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
			const message = at?.closest<HTMLElement>(".msg[data-key]");
			const body = message?.querySelector<HTMLElement>(".msg-body");
			if (!message || !body || !body.contains(at!)) return false;
			let block = at as HTMLElement;
			while (block.parentElement && block.parentElement !== body) block = block.parentElement;
			const text = block.textContent?.trim() ?? "";
			if (text === "") return false;
			this.#quote = { message: message.dataset.key!, text, block };
		} else {
			const quote = this.#selected();
			if (quote === undefined) return false;
			this.#quote = quote;
		}
		this.#open();
		return true;
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
		pill.title = "Comment (⌘↩)";
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
		actions.append(el("span", "spacer"));
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
