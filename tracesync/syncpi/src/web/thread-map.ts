// The timeline beside the thread, as in Delta: a short line for each turn, stacked compactly at the thread's right
// edge, the turn on screen darker and a turn with a milestone in the accent colour. Hovering a line says what that
// turn was: what was asked, what happened (the milestone the agent marked in it, src/server/milestone.ts, or else the
// start of its answer), who asked, the model and when. Click a line to go there, ⌘-click to bookmark it (bookmarks
// are kept in this browser), ⌥-scroll over the thread to step from turn to turn.
import { type Item, type Milestone, milestoneOf, toolGroupSummary } from "../shared/thread.ts";
import { el, escapeHtml, initials, personColor, relativeTime, storage } from "./dom.ts";
import { modelAvatar, providerName } from "./icons.ts";
import type { SessionClient } from "./session.ts";
import { FLAG } from "./thread-view.ts";

type Turn = { key: string; name: string; text: string; at?: number; did: string; model?: string; answer: string; milestones: Milestone[] };

/** Each user message and what the agent did until the next one. */
function turns(items: readonly Item[], nameOf: (id: string | undefined, fallback: string) => string): Turn[] {
	const out: Turn[] = [];
	let tools: { name: string }[] = [];
	const close = () => {
		const turn = out.at(-1);
		if (turn !== undefined && tools.length > 0) turn.did = toolGroupSummary(tools);
		tools = [];
	};
	for (const item of items) {
		if (item.kind === "user") {
			close();
			out.push({ key: item.key, name: nameOf(item.memberId, item.author ?? "someone"), text: item.text, at: item.at, did: "", answer: "", milestones: [] });
			continue;
		}
		const turn = out.at(-1);
		if (turn === undefined) continue;
		const milestone = milestoneOf(item);
		if (milestone !== undefined) turn.milestones.push(milestone);
		else if (item.kind === "tool") tools.push(item);
		else if (item.kind === "assistant") {
			if (item.model) turn.model = item.model;
			if (item.text.trim()) turn.answer = item.text;
		}
	}
	close();
	return out;
}

/** The opening of an answer as plain text: its first paragraph, without code or Markdown marks. */
function opening(markdown: string): string {
	const text = markdown
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/<reply to="\d+">|<\/reply>/g, " ")
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.find((p) => p.length > 0 && !/^[-*|>#]/.test(p)) ?? "";
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** "11 hours ago (Today at 1:10 AM)". */
function when(at: number): string {
	const date = new Date(at);
	const today = new Date();
	const yesterday = new Date(today.getTime() - 86_400_000);
	const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
	const day = same(date, today) ? "Today" : same(date, yesterday) ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${relativeTime(at)} (${day} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})`;
}

const CLOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

export class ThreadMap {
	readonly #session: SessionClient;
	readonly #scroller: HTMLElement;
	readonly #box: HTMLElement;
	readonly #map = el("nav", "thread-map");
	readonly #tip = el("div", "thread-map-tip");
	#turns: Turn[] = [];
	#nodes: (HTMLElement | null)[] = [];
	#current = -1;
	#bookmarks = new Set<string>();
	#bookmarksKey = "";
	#sig = "";
	#frame = 0;
	#scrollFrame = 0;
	/** ⌥-scroll: how far the wheel has gone toward the next step, and the turn the last step went to. */
	#wheel = 0;
	#stepped = { index: -1, at: 0 };
	/** Off while another conversation (the setup agent's) is showing. */
	enabled = true;

	constructor(session: SessionClient, scroller: HTMLElement, box: HTMLElement) {
		this.#session = session;
		this.#scroller = scroller;
		this.#box = box;
		this.#map.setAttribute("aria-label", "Turns in this thread");
		this.#tip.hidden = true;
		this.#tip.setAttribute("role", "tooltip");
		scroller.after(this.#map, this.#tip);
		scroller.addEventListener("scroll", () => this.#onScroll(), { passive: true });
		new ResizeObserver(() => this.update()).observe(box);
		new ResizeObserver(() => this.update()).observe(scroller);
		this.#map.addEventListener("click", (event) => {
			const key = (event.target as HTMLElement).closest<HTMLElement>("[data-turn]")?.dataset.turn;
			if (key === undefined) return;
			if (event.metaKey || event.ctrlKey) this.#toggleBookmark(key);
			else this.#jump(key);
		});
		const tipFor = (event: Event) => {
			const mark = (event.target as HTMLElement).closest<HTMLElement>("[data-turn]");
			if (mark !== null) this.#showTip(mark);
		};
		this.#map.addEventListener("pointerover", tipFor);
		this.#map.addEventListener("focusin", tipFor);
		this.#map.addEventListener("pointerleave", () => (this.#tip.hidden = true));
		this.#map.addEventListener("focusout", () => (this.#tip.hidden = true));
		// ⌥-scroll over the thread steps from turn to turn.
		scroller.addEventListener(
			"wheel",
			(event) => {
				if (!event.altKey || this.#map.hidden) return;
				event.preventDefault();
				this.#wheel += event.deltaY;
				if (Math.abs(this.#wheel) < 24) return;
				const by = Math.sign(this.#wheel);
				this.#wheel = 0;
				this.#step(by);
			},
			{ passive: false },
		);
	}

	/** The thread changed or was laid out again. */
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
		if (!show) {
			this.#tip.hidden = true;
			return;
		}
		// Up to 10px a line, closer together when there are many, centred beside the thread.
		const room = scroller.clientHeight - 64;
		const gap = Math.max(3, Math.min(10, room / this.#turns.length));
		const height = gap * this.#turns.length;
		this.#map.style.setProperty("--gap", `${gap}px`);
		this.#map.style.top = `${scroller.offsetTop + Math.max(8, (scroller.clientHeight - height) / 2)}px`;
		this.#nodes = this.#turns.map((t) => this.#box.querySelector<HTMLElement>(`[data-key="${CSS.escape(t.key)}"]`));
		// Marks are rebuilt only when they change, not on every streamed word (the one under the pointer stays).
		const sig = this.#turns.map((t) => `${t.key}:${t.milestones.length}:${this.#bookmarks.has(t.key) ? 1 : 0}`).join(",");
		if (sig !== this.#sig) {
			this.#sig = sig;
			this.#buildMarks();
		}
		this.#markCurrent();
		// A tip that's showing keeps up with its turn (an answer arriving, a milestone).
		const shown = this.#tip.hidden ? undefined : this.#map.querySelector<HTMLElement>(`[data-turn="${CSS.escape(this.#tip.dataset.turn ?? "")}"]`);
		if (shown) this.#showTip(shown);
	}

	#buildMarks(): void {
		const marks = this.#turns.map((turn) => {
			const mark = el("button", "thread-map-mark");
			mark.type = "button";
			mark.dataset.turn = turn.key;
			mark.classList.toggle("bookmarked", this.#bookmarks.has(turn.key));
			mark.classList.toggle("milestone-turn", turn.milestones.length > 0);
			const about = turn.milestones[0]?.title ?? turn.text.slice(0, 80);
			mark.setAttribute("aria-label", `${turn.name}: ${about}`);
			return mark;
		});
		this.#map.replaceChildren(...marks);
		this.#current = -1;
	}

	#onScroll(): void {
		if (this.#scrollFrame !== 0) return;
		this.#scrollFrame = requestAnimationFrame(() => {
			this.#scrollFrame = 0;
			this.#markCurrent();
		});
	}

	/** The turn being read: the first at the top of the thread, the last at its end, and otherwise the last one that
	 *  starts above a line near the top. */
	#markCurrent(): void {
		if (this.#map.hidden) return;
		const s = this.#scroller;
		const line = s.getBoundingClientRect().top + Math.min(120, s.clientHeight / 4);
		let current = 0;
		if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) current = this.#turns.length - 1;
		else if (s.scrollTop > 0)
			this.#nodes.forEach((node, i) => {
				if (node !== null && node.getBoundingClientRect().top <= line) current = i;
			});
		if (current === this.#current) return;
		this.#current = current;
		this.#map.querySelectorAll(".thread-map-mark").forEach((mark, i) => mark.classList.toggle("current", i === current));
	}

	/** The next (1) or previous (-1) turn; quick steps count from where the last one went, not where the smooth
	 *  scroll has got to. */
	#step(by: number): void {
		const from = Date.now() - this.#stepped.at < 600 ? this.#stepped.index : this.#current;
		const index = Math.max(0, Math.min(this.#turns.length - 1, from + by));
		this.#stepped = { index, at: Date.now() };
		const turn = this.#turns[index];
		if (turn !== undefined) this.#jump(turn.key, false);
	}

	/** Scrolls the thread (not the page around it) to a turn, and flashes it. */
	#jump(key: string, flash = true): void {
		const node = this.#box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		if (node === null) return;
		const s = this.#scroller;
		s.scrollTo({ top: node.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 12, behavior: "smooth" });
		if (!flash) return;
		node.classList.remove("flash");
		void node.offsetWidth;
		node.classList.add("flash");
	}

	#showTip(mark: HTMLElement): void {
		const turn = this.#turns.find((t) => t.key === mark.dataset.turn);
		if (turn === undefined) return;
		const ask = turn.text.trim().split("\n").filter((l) => l.trim()).join(" ");
		const happened = turn.milestones.length
			? turn.milestones.map((m) => `<div class="tm-milestone">${FLAG}<span>${escapeHtml(m.title)}</span></div>${m.summary ? `<div class="tm-summary">${escapeHtml(m.summary)}</div>` : ""}`).join("")
			: turn.answer
				? `<div class="tm-summary">${escapeHtml(opening(turn.answer).slice(0, 320))}</div>`
				: "";
		const did = turn.did ? `<div class="tm-did">${escapeHtml(turn.did)}</div>` : "";
		const [provider = "", modelId = turn.model ?? ""] = (turn.model ?? "").split(/\/(.*)/);
		const rows = [
			`<div class="tm-row"><span class="avatar" style="--person:${personColor(turn.name)}">${escapeHtml(initials(turn.name))}</span>${escapeHtml(turn.name)}</div>`,
			turn.model ? `<div class="tm-row">${modelAvatar(turn.model)}<span>${escapeHtml(modelId)}</span>${provider ? `<span class="tm-faint">via ${escapeHtml(providerName(provider))}</span>` : ""}</div>` : "",
			turn.at ? `<div class="tm-row">${CLOCK}<span>${escapeHtml(when(turn.at))}</span></div>` : "",
		].join("");
		const marked = this.#bookmarks.has(turn.key);
		this.#tip.dataset.turn = turn.key;
		this.#tip.innerHTML = [
			`<section><div class="tm-ask">${escapeHtml(ask)}</div></section>`,
			happened || did ? `<section>${happened}${did}</section>` : "",
			`<section>${rows}</section>`,
			`<section class="tm-hints"><div>${marked ? "Bookmarked · ⌘ + click to remove" : "⌘ + click to bookmark"}</div><div>⌥ + scroll by marker</div></section>`,
		].join("");
		this.#tip.hidden = false;
		const parent = this.#map.offsetParent?.getBoundingClientRect() ?? this.#map.getBoundingClientRect();
		const y = mark.getBoundingClientRect().top + mark.offsetHeight / 2 - parent.top;
		this.#tip.style.top = `${Math.max(8, Math.min(y - 28, parent.height - this.#tip.offsetHeight - 8))}px`;
	}

	#toggleBookmark(key: string): void {
		if (!this.#bookmarks.delete(key)) this.#bookmarks.add(key);
		if (this.#bookmarksKey !== "") storage.set(this.#bookmarksKey, JSON.stringify([...this.#bookmarks]));
		this.#render();
	}
}
