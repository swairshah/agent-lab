// A textarea written together: it shows a shared text (drafts.ts) and puts what's typed into it, keeps the cursor
// where it was in the text when someone else's change arrives, says where this person's cursor is, and draws the
// others' cursors and selections over it. The composer binds drafts with it, the file editor files.
import { draftText, replaceText, Y } from "../shared/drafts.ts";
import { peersHtml, peersIn } from "./peers.ts";
import type { SessionClient } from "./session.ts";

/** The textarea's styles the layer over it copies, so its text lines up with the textarea's. */
const MIRROR = ["boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent", "textTransform", "whiteSpace"] as const;

export class TextBinding {
	readonly key: string;
	text: Y.Text;
	readonly #input: HTMLTextAreaElement;
	readonly #session: SessionClient;
	readonly #layer = document.createElement("div");
	readonly #onRemote: () => void;
	readonly #cleanup: (() => void)[] = [];
	#frame = 0;

	/** `key`: whose draft, or "file:<path>". `onRemote`: after someone else's change is shown. */
	constructor(input: HTMLTextAreaElement, session: SessionClient, key: string, onRemote: () => void = () => {}) {
		this.#input = input;
		this.#session = session;
		this.key = key;
		this.text = draftText(session.doc(key));
		this.#onRemote = onRemote;
		this.#unobserve = this.#observe();
		this.#layer.className = "peer-layer";
		this.#layer.setAttribute("aria-hidden", "true");
		this.#layer.hidden = true;
		input.after(this.#layer);
		const listen = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K | string, fn: () => void) => {
			target.addEventListener(type, fn);
			this.#cleanup.push(() => target.removeEventListener(type, fn));
		};
		listen(input, "input", () => this.changed());
		for (const type of ["keyup", "mouseup", "focus", "select"]) listen(input, type, () => this.shareCaret());
		listen(document, "selectionchange", () => document.activeElement === input && this.shareCaret());
		listen(input, "scroll", () => this.renderPeers());
		this.#cleanup.push(() => this.#unobserve());
		const peers = () => this.renderPeers();
		session.on("drafts", peers);
		this.#cleanup.push(() => session.off("drafts", peers));
		// After a reconnect a file's document is a new one: follow it instead.
		const docs = () => {
			const text = draftText(session.doc(key));
			if (text === this.text) return;
			this.#unobserve();
			this.text = text;
			this.#unobserve = this.#observe();
		};
		session.on("docs", docs);
		this.#cleanup.push(() => session.off("docs", docs));
		input.value = this.text.toString();
		this.renderPeers();
	}

	#unobserve: () => void;

	#observe(): () => void {
		const text = this.text;
		const observe = (event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.origin !== this) this.#remote(event);
		};
		text.observe(observe);
		return () => text.unobserve(observe);
	}

	dispose(): void {
		cancelAnimationFrame(this.#frame);
		for (const fn of this.#cleanup) fn();
		this.#layer.remove();
	}

	/** The textarea changed here (typed, or set by code): the same change goes into the text, for everyone. */
	changed(): void {
		replaceText(this.text, this.#input.value, this, this.#input.selectionEnd);
		this.renderPeers();
		this.shareCaret();
	}

	/** This person's cursor, for the others: in this text, at most once a frame. */
	shareCaret(): void {
		if (this.#frame !== 0) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			const at = (index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, index));
			this.#session.send({ type: "caret", owner: this.key, anchor: at(this.#input.selectionStart), head: at(this.#input.selectionEnd) });
		});
	}

	/** Someone else changed the text: show it, keeping this person's cursor where it was in the text. */
	#remote(event: Y.YTextEvent): void {
		const input = this.#input;
		let start = input.selectionStart;
		let end = input.selectionEnd;
		let at = 0;
		for (const op of event.delta) {
			if (op.retain !== undefined) at += op.retain;
			else if (typeof op.insert === "string") {
				const n = op.insert.length;
				if (at < start) start += n;
				if (at < end) end += n;
				at += n;
			} else if (op.delete !== undefined) {
				start -= Math.max(0, Math.min(op.delete, start - at));
				end -= Math.max(0, Math.min(op.delete, end - at));
			}
		}
		const focused = document.activeElement === input;
		const scroll = input.scrollTop;
		input.value = this.text.toString();
		if (focused) input.setSelectionRange(start, end);
		input.scrollTop = scroll;
		this.renderPeers();
		this.#onRemote();
	}

	/** The others' cursors and selections, in a layer over the textarea that lines up with its text. */
	renderPeers(): void {
		const layer = this.#layer;
		const peers = peersIn(this.#session, this.key);
		layer.hidden = peers.length === 0;
		if (peers.length === 0) return;
		const input = this.#input;
		const style = getComputedStyle(input);
		for (const prop of MIRROR) layer.style[prop] = style[prop];
		layer.style.top = `${input.offsetTop}px`;
		layer.style.left = `${input.offsetLeft}px`;
		// Names above the first line show outside the textarea, so the layer doesn't clip; it scrolls with it instead.
		layer.innerHTML = `<div style="transform: translate(${-input.scrollLeft}px, ${-input.scrollTop}px)">${peersHtml(input.value, peers)}</div>`;
	}
}
