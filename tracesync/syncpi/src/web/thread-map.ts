// The scrollbar as a map of the thread, as in Delta: a mark for each turn (who asked, in their colour) where it sits
// in the thread, and the part on screen. Hovering a mark says what that turn was: who asked what, what the agent
// did and with which model; click a mark to go there, or drag along the map to scroll. Turns can be bookmarked from
// there; bookmarks are kept in this browser.
import { type Item, toolGroupSummary } from "../shared/thread.ts";
import { el, escapeHtml, personColor, relativeTime, storage } from "./dom.ts";
import { modelAvatar } from "./icons.ts";
import type { SessionClient } from "./session.ts";

type Turn = { key: string; name: string; text: string; at?: number; did: string; model?: string };

/** Each user message and what the agent did until the next one. */
function turns(items: readonly Item[], nameOf: (id: string | undefined, fallback: string) => string): Turn[] {
	const out: Turn[] = [];
	let tools: { name: string }[] = [];
	const close = () => {
		const turn = out.at(-1);
		if (turn !== undefined) turn.did = tools.length > 0 ? toolGroupSummary(tools) : turn.did;
		tools = [];
	};
	for (const item of items) {
		if (item.kind === "user") {
			close();
			out.push({ key: item.key, name: nameOf(item.memberId, item.author ?? "someone"), text: item.text, at: item.at, did: "" });
		} else if (item.kind === "tool") tools.push(item);
		else if (item.kind === "assistant" && out.length > 0) {
			const turn = out.at(-1)!;
			if (item.model) turn.model = item.model;
			if (!turn.did && item.text) turn.did = "Answered";
		}
	}
	close();
	return out;
}

export class ThreadMap {
	readonly #session: SessionClient;
	readonly #scroller: HTMLElement;
	readonly #box: HTMLElement;
	readonly #map = el("nav", "thread-map");
	readonly #view = el("div", "thread-map-view");
	readonly #tip = el("div", "thread-map-tip");
	#turns: Turn[] = [];
	#bookmarks = new Set<string>();
	#bookmarksKey = "";
	#frame = 0;
	/** Off while another conversation (the setup agent's) is showing. */
	enabled = true;
	#hideTip: ReturnType<typeof setTimeout> | undefined;

	constructor(session: SessionClient, scroller: HTMLElement, box: HTMLElement) {
		this.#session = session;
		this.#scroller = scroller;
		this.#box = box;
		this.#map.setAttribute("aria-label", "Turns in this thread");
		this.#map.append(this.#view);
		this.#tip.hidden = true;
		scroller.after(this.#map, this.#tip);
		scroller.addEventListener("scroll", () => this.#placeView(), { passive: true });
		new ResizeObserver(() => this.update()).observe(box);
		new ResizeObserver(() => this.update()).observe(scroller);
		// Drag along the map to scroll; a click on a mark goes to its turn.
		this.#map.addEventListener("pointerdown", (event) => {
			const mark = (event.target as HTMLElement).closest<HTMLElement>("[data-turn]");
			if (mark !== null) return;
			event.preventDefault();
			this.#map.setPointerCapture(event.pointerId);
			const move = (e: PointerEvent) => this.#scrollTo(e.clientY);
			move(event);
			this.#map.addEventListener("pointermove", move);
			this.#map.addEventListener("pointerup", () => this.#map.removeEventListener("pointermove", move), { once: true });
		});
		this.#map.addEventListener("click", (event) => {
			const key = (event.target as HTMLElement).closest<HTMLElement>("[data-turn]")?.dataset.turn;
			if (key !== undefined) this.#jump(key);
		});
		this.#map.addEventListener("pointerover", (event) => {
			const mark = (event.target as HTMLElement).closest<HTMLElement>("[data-turn]");
			if (mark !== null) this.#showTip(mark);
		});
		this.#map.addEventListener("pointerleave", () => this.#tipLater());
		this.#tip.addEventListener("pointerenter", () => clearTimeout(this.#hideTip));
		this.#tip.addEventListener("pointerleave", () => this.#tipLater());
		this.#tip.addEventListener("click", (event) => {
			const target = event.target as HTMLElement;
			const key = this.#tip.dataset.turn;
			if (key === undefined) return;
			if (target.closest("[data-bookmark]")) this.#toggleBookmark(key);
			else this.#jump(key);
		});
	}

	/** The thread changed or was laid out again: marks move to where their turns are now. */
	update(): void {
		if (this.#frame !== 0) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#render();
		});
	}

	#render(): void {
		const id = this.#session.info?.id;
		if (id !== undefined && this.#bookmarksKey !== `syncpi-bookmarks:${id}`) {
			this.#bookmarksKey = `syncpi-bookmarks:${id}`;
			try {
				this.#bookmarks = new Set(JSON.parse(storage.get(this.#bookmarksKey) ?? "[]") as string[]);
			} catch {}
		}
		const scroller = this.#scroller;
		this.#turns = turns(this.#session.threads.main.state.items, (m, f) => this.#session.nameOf(m, f));
		const long = scroller.scrollHeight > scroller.clientHeight + 40;
		const show = long && this.#turns.length > 0 && this.enabled;
		this.#map.hidden = !show;
		document.documentElement.classList.toggle("thread-map-on", show);
		if (!show) return;
		this.#map.style.top = `${scroller.offsetTop}px`;
		this.#map.style.height = `${scroller.clientHeight}px`;
		const height = scroller.clientHeight;
		const total = scroller.scrollHeight;
		const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
		for (const old of this.#map.querySelectorAll("[data-turn]")) old.remove();
		for (const turn of this.#turns) {
			const node = this.#box.querySelector<HTMLElement>(`[data-key="${CSS.escape(turn.key)}"]`);
			if (node === null) continue;
			const y = ((node.getBoundingClientRect().top - top) / total) * height;
			const mark = el("button", `thread-map-mark${this.#bookmarks.has(turn.key) ? " bookmarked" : ""}`);
			mark.type = "button";
			mark.dataset.turn = turn.key;
			mark.style.top = `${Math.max(0, Math.min(height - 4, y))}px`;
			mark.style.setProperty("--person", personColor(turn.name));
			mark.setAttribute("aria-label", `${turn.name}: ${turn.text.slice(0, 80)}`);
			this.#map.append(mark);
		}
		this.#placeView();
	}

	/** The part of the thread on screen, as a band on the map. */
	#placeView(): void {
		const s = this.#scroller;
		if (this.#map.hidden || s.scrollHeight === 0) return;
		const height = s.clientHeight;
		this.#view.style.top = `${(s.scrollTop / s.scrollHeight) * height}px`;
		this.#view.style.height = `${Math.max(12, (s.clientHeight / s.scrollHeight) * height)}px`;
	}

	#scrollTo(clientY: number): void {
		const s = this.#scroller;
		const ratio = (clientY - this.#map.getBoundingClientRect().top) / s.clientHeight;
		s.scrollTop = ratio * s.scrollHeight - s.clientHeight / 2;
	}

	#jump(key: string): void {
		const node = this.#box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		if (node === null) return;
		node.scrollIntoView({ block: "start", behavior: "smooth" });
		node.classList.remove("flash");
		void node.offsetWidth;
		node.classList.add("flash");
	}

	#showTip(mark: HTMLElement): void {
		clearTimeout(this.#hideTip);
		const turn = this.#turns.find((t) => t.key === mark.dataset.turn);
		if (turn === undefined) return;
		const marked = this.#bookmarks.has(turn.key);
		const first = turn.text.split("\n").find((l) => l.trim()) ?? "";
		this.#tip.dataset.turn = turn.key;
		this.#tip.innerHTML = `<div class="thread-map-tip-head"><strong>${escapeHtml(turn.name)}</strong>${turn.at ? `<span>${escapeHtml(relativeTime(turn.at))}</span>` : ""}<button type="button" class="link" data-bookmark>${marked ? "Remove bookmark" : "Bookmark"}</button></div><div class="thread-map-tip-text">${escapeHtml(first.slice(0, 160))}</div>${
			turn.did || turn.model ? `<div class="thread-map-tip-did">${turn.model ? modelAvatar(turn.model) : ""}<span>${escapeHtml(turn.did || "Working…")}</span></div>` : ""
		}`;
		this.#tip.hidden = false;
		const map = this.#map.getBoundingClientRect();
		const parent = this.#map.offsetParent?.getBoundingClientRect() ?? map;
		const y = mark.getBoundingClientRect().top - parent.top;
		this.#tip.style.top = `${Math.max(8, Math.min(y - 20, parent.height - this.#tip.offsetHeight - 8))}px`;
	}

	#tipLater(): void {
		clearTimeout(this.#hideTip);
		this.#hideTip = setTimeout(() => (this.#tip.hidden = true), 250);
	}

	#toggleBookmark(key: string): void {
		if (!this.#bookmarks.delete(key)) this.#bookmarks.add(key);
		if (this.#bookmarksKey !== "") storage.set(this.#bookmarksKey, JSON.stringify([...this.#bookmarks]));
		this.#render();
		const mark = this.#map.querySelector<HTMLElement>(`[data-turn="${CSS.escape(key)}"]`);
		if (mark !== null) this.#showTip(mark);
	}
}
