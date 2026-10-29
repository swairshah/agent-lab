// Find (⌘F): a bar at the top of the conversation or the open file that finds text in it, literally, as it's
// shown. Enter and ⇧Enter (⌘G, ⇧⌘G) step through the matches, wrapping; Esc closes it. Views supply what's
// searchable as targets (thread-view.ts, panel.ts); this owns the query, the matches, the current one, the
// highlights and where focus goes back to. It's all local: nothing is sent, stored or shown to anyone else.
// See docs/search-spec.md.
import { type FindMatch, findAll, keepActive, MAX_QUERY, type SearchBlock } from "../shared/search.ts";
import { $ } from "./dom.ts";
import { rangeOf, type TextMap } from "./find-text.ts";

export type FindBlock = SearchBlock & { map: TextMap };

/** Something Find can search: the conversation showing, or the file (at a version, in a view) open in the panel. */
export interface FindTarget {
	/** The query and Match case are remembered per target, for as long as the page is open. */
	readonly id: string;
	/** What the bar says it's searching: "Conversation", "Loaded conversation", a file's path. */
	readonly label: string;
	/** The input's accessible name: "Find in conversation", "Find in file". */
	readonly inputLabel: string;
	/** Why Find can't search this view (a preview, an image), if it can't. */
	readonly unavailable?: string;
	/** The bar goes just before this, at the top of the target's pane. */
	readonly barBefore: Element;
	/** What scrolls the target, where the box around the current match is drawn. */
	readonly scroller: HTMLElement;
	/** Matches in a text area are shown by selecting them (it can't be highlighted). */
	readonly textarea?: HTMLTextAreaElement;
	blocks(): FindBlock[];
	/** Makes a match visible (opening what folds it, showing all of a cut-short output) and gives its live range. */
	reveal(match: FindMatch): Range | undefined;
	/** Whether the target is still on the page. */
	alive(): boolean;
	/** Folds back what reveal opened, unless the person opened or closed it meanwhile. */
	restore(): void;
	/** Holds the view still while Find is open (a streaming reply doesn't scroll it away from a match). */
	hold?(on: boolean): void;
	/** Whether what's shown is still being drawn (code Pierre hasn't drawn yet): Find looks again shortly. */
	pending?(): boolean;
	/** Where a match in a text area is on screen, to draw the box around it (it can't hold a highlight). */
	rects?(match: FindMatch): DOMRect[];
}

const HIGHLIGHT = "syncpi-find";
/** More matches than this, and only those near the view are highlighted. */
const MANY = 1000;
const CURRENT = "syncpi-find-current";
/** The CSS Custom Highlight API, where the webview has it; otherwise boxes are drawn over the visible matches. */
const highlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT}) { background-color: var(--find, rgb(255 213 79 / .55)); color: inherit; }
::highlight(${CURRENT}) { background-color: var(--find-current, rgb(255 150 50 / .7)); color: inherit; }`;
/** Shadow roots (Pierre's code) need the highlight styles inside them. */
const styled = new WeakSet<ShadowRoot>();

export type FindOptions = {
	/** The target for where focus is (or was last), or undefined when there's nothing to search. */
	target: () => FindTarget | undefined;
	/** Find opened or closed (to stop sharing where this person is while they search). */
	onOpen?: (open: boolean) => void;
};

/** Whether a range's text is shown: on the page, and not in a closed fold (<details>, outside its summary) or hidden. */
function shown(range: Range): boolean {
	const node = range.startContainer;
	const element = node instanceof Element ? node : node.parentElement;
	if (element === null || !node.isConnected) return false;
	const fold = element.closest("details");
	if (fold !== null && !fold.open && element.closest("summary")?.parentElement !== fold) return false;
	return typeof element.checkVisibility === "function" ? element.checkVisibility() : element.getClientRects().length > 0;
}

export class Find {
	readonly #options: FindOptions;
	readonly #bar = $("find-bar");
	readonly #input = $<HTMLInputElement>("find-input");
	readonly #count = $("find-count");
	readonly #note = $("find-note");
	readonly #scope = $("find-scope");
	readonly #case = $<HTMLButtonElement>("find-case");
	readonly #memory = new Map<string, { query: string; matchCase: boolean }>();
	#target: FindTarget | undefined;
	#blocks: FindBlock[] = [];
	#order = new Map<string, number>();
	#matches: FindMatch[] = [];
	#active = -1;
	#matchCase = false;
	/** Where focus and the selection were when Find opened. */
	#origin: { focus: HTMLElement | null; range?: Range; input?: [number, number] } | undefined;
	#frame = 0;
	#slow: ReturnType<typeof setTimeout> | undefined;
	#layer: HTMLElement | undefined;
	/** Too many matches to highlight them all: only those near the view are. */
	#partial = false;
	/** Bumped when the query or target changes, so an older reveal doesn't scroll. */
	#generation = 0;

	constructor(options: FindOptions) {
		this.#options = options;
		this.#input.maxLength = MAX_QUERY;
		this.#input.addEventListener("input", () => this.#changed());
		this.#input.addEventListener("keydown", (event) => {
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				this.#step(event.shiftKey ? -1 : 1);
			}
		});
		$("find-next").addEventListener("click", () => this.#step(1));
		$("find-prev").addEventListener("click", () => this.#step(-1));
		$("find-close").addEventListener("click", () => this.close());
		this.#case.addEventListener("click", () => {
			this.#matchCase = !this.#matchCase;
			this.#case.setAttribute("aria-pressed", String(this.#matchCase));
			this.#changed();
			this.#input.focus();
		});
		// Esc closes Find before anything else takes it (the composer stops the agent on Esc), unless a dialog is
		// open (it gets Esc first) or a terminal has focus (it gets its own keys).
		addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || !this.isOpen || event.isComposing) return;
				if (document.querySelector("dialog[open]") !== null) return;
				if ((event.target as Element | null)?.closest?.(".terminal")) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				this.close();
			},
			true,
		);
		addEventListener("resize", () => this.#schedule(false));
	}

	get isOpen(): boolean {
		return !this.#bar.hidden;
	}

	/** Opens Find on the focused pane (or focuses it, keeping the query, when it's open). False when there's nothing
	 *  to search here. */
	open(): boolean {
		const target = this.#options.target();
		if (target === undefined) return false;
		const selection = this.#selectionIn(target);
		// Focus goes back, on closing, to where it was when ⌘F was last pressed outside the bar.
		const focus = document.activeElement as HTMLElement | null;
		if (!this.#bar.contains(focus)) {
			const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).cloneRange() : undefined;
			const input = focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement ? ([focus.selectionStart ?? 0, focus.selectionEnd ?? 0] as [number, number]) : undefined;
			this.#origin = { focus, range, input };
		}
		if (this.isOpen && this.#target?.id === target.id) {
			if (selection !== undefined) this.#setQuery(selection);
			this.#input.focus();
			this.#input.select();
			return true;
		}
		if (this.isOpen) this.#leave();
		this.#target = target;
		this.#generation++;
		const remembered = this.#memory.get(target.id);
		this.#matchCase = remembered?.matchCase ?? this.#matchCase;
		this.#case.setAttribute("aria-pressed", String(this.#matchCase));
		this.#input.value = selection ?? remembered?.query ?? this.#input.value;
		this.#scope.textContent = target.label;
		this.#input.setAttribute("aria-label", target.inputLabel);
		target.barBefore.before(this.#bar);
		this.#bar.hidden = false;
		target.hold?.(true);
		this.#options.onOpen?.(true);
		this.#input.focus();
		this.#input.select();
		this.#compute(true);
		return true;
	}

	/** Next (or previous) match; false when Find is closed, so the key goes on to the page. */
	next(): boolean {
		if (!this.isOpen) return false;
		this.#step(1);
		return true;
	}

	previous(): boolean {
		if (!this.isOpen) return false;
		this.#step(-1);
		return true;
	}

	/** Closes Find: highlights go, folds go back, and focus returns to where it was (unless `keepFocus`, when the page
	 *  is being put away). */
	close(keepFocus = false): void {
		if (!this.isOpen) return;
		const target = this.#target;
		this.#leave();
		this.#bar.hidden = true;
		this.#options.onOpen?.(false);
		const origin = this.#origin;
		this.#origin = undefined;
		if (keepFocus) return;
		const focus = origin?.focus;
		if (focus != null && focus.isConnected && focus !== document.body) {
			focus.focus({ preventScroll: true });
			if (origin?.input !== undefined && (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement)) focus.setSelectionRange(...origin.input);
			else if (origin?.range !== undefined && origin.range.startContainer.isConnected) {
				getSelection()?.removeAllRanges();
				getSelection()?.addRange(origin.range);
			}
		} else if (target !== undefined && !target.alive()) $("input").focus({ preventScroll: true });
	}

	/** What's on the page changed (a reply streaming in, a file reloading): matches are counted again, at most once
	 *  a frame. Closes Find if its target went away. */
	refresh(): void {
		if (!this.isOpen) return;
		if (this.#target !== undefined && !this.#target.alive()) {
			const next = this.#options.target();
			// The same pane with new content (another file version, the thread after a branch switch): follow it.
			if (next !== undefined && next.id !== this.#target.id && next.barBefore === this.#target.barBefore) return void this.#retarget(next);
			return this.close();
		}
		this.#schedule(false);
	}

	/** The pane's content is a different target now (a file's other version): keep Find open on it. */
	#retarget(target: FindTarget): void {
		this.#leave();
		this.#target = target;
		this.#generation++;
		const remembered = this.#memory.get(target.id);
		if (remembered !== undefined) {
			this.#input.value = remembered.query;
			this.#matchCase = remembered.matchCase;
			this.#case.setAttribute("aria-pressed", String(this.#matchCase));
		}
		this.#scope.textContent = target.label;
		this.#input.setAttribute("aria-label", target.inputLabel);
		target.barBefore.before(this.#bar);
		target.hold?.(true);
		this.#compute(true);
	}

	/** Leaves the current target: clears its highlights and folds back what was opened. */
	#leave(): void {
		const target = this.#target;
		if (target === undefined) return;
		this.#memory.set(target.id, { query: this.#input.value, matchCase: this.#matchCase });
		cancelAnimationFrame(this.#frame);
		this.#clearPaint();
		target.restore();
		target.hold?.(false);
		this.#matches = [];
		this.#active = -1;
		this.#target = undefined;
	}

	/** Selected text in the target, to search for: one line, at most 256 characters. */
	#selectionIn(target: FindTarget): string | undefined {
		if (target.textarea !== undefined && document.activeElement === target.textarea) {
			const value = target.textarea.value.slice(target.textarea.selectionStart, target.textarea.selectionEnd);
			return value !== "" && value.length <= 256 && !/[\r\n]/.test(value) ? value : undefined;
		}
		const selection = getSelection();
		if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
		const node = selection.getRangeAt(0).commonAncestorContainer;
		if (!target.scroller.contains(node)) return undefined;
		const value = selection.toString();
		return value !== "" && value.length <= 256 && !/[\r\n]/.test(value) ? value : undefined;
	}

	#setQuery(value: string): void {
		this.#input.value = value;
		this.#changed();
	}

	#changed(): void {
		this.#generation++;
		if (this.#target !== undefined) this.#memory.set(this.#target.id, { query: this.#input.value, matchCase: this.#matchCase });
		this.#schedule(true);
	}

	#schedule(reveal: boolean): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = requestAnimationFrame(() => this.#compute(reveal));
	}

	/** Counts the matches again, keeping the current one where it can, and draws them. */
	#compute(reveal: boolean): void {
		const target = this.#target;
		if (target === undefined) return;
		if (this.#slow === undefined) this.#slow = setTimeout(() => (this.#note.textContent = "Searching…"), 150);
		const query = this.#input.value;
		const previous = this.#matches[this.#active];
		this.#note.textContent = "";
		if (target.unavailable !== undefined) {
			this.#blocks = [];
			this.#matches = [];
			this.#active = -1;
			this.#done(target.unavailable);
			return;
		}
		this.#blocks = target.blocks();
		this.#order = new Map(this.#blocks.map((b, n) => [b.id, n]));
		this.#matches = findAll(this.#blocks, query, this.#matchCase);
		if (target.pending?.()) setTimeout(() => this.#target === target && this.#schedule(reveal), 150);
		this.#active = keepActive(this.#matches, reveal ? undefined : previous, (id) => this.#order.get(id) ?? -1);
		// A new query starts from the first match at or after what's in view, as browsers do.
		if (reveal && this.#matches.length > 0) this.#active = this.#firstInView();
		this.#done(query.length >= MAX_QUERY ? `Searches use the first ${MAX_QUERY} characters.` : this.#matches.length === 0 && query !== "" ? "No matches" : "");
		if (reveal && this.#active >= 0) this.#show(this.#active);
		else {
			// The page was drawn again (the agent working) and folded the current match away (or cut its output short
			// again), as it was before Find showed it: show it again, where it is, without moving the view.
			const current = this.#matches[this.#active];
			const range = current === undefined ? undefined : this.#range(current);
			if (current !== undefined && (range === undefined || !shown(range)) && target.textarea === undefined) {
				target.reveal(current);
				this.#blocks = target.blocks();
				this.#order = new Map(this.#blocks.map((b, n) => [b.id, n]));
			}
			this.#paint();
		}
	}

	#done(note: string): void {
		if (this.#slow !== undefined) clearTimeout(this.#slow);
		this.#slow = undefined;
		this.#note.textContent = note;
		this.#count.textContent = this.#matches.length === 0 ? "0/0" : `${this.#active + 1}/${this.#matches.length}`;
	}

	/** The first match that isn't above the top of the view, or the first. */
	#firstInView(): number {
		const top = this.#target!.scroller.getBoundingClientRect().top;
		// The first block not above the view, then its first match not above it (blocks first: there may be many
		// thousands of matches).
		const at = this.#firstBlockBelow(top);
		if (at >= this.#blocks.length) return 0;
		for (let n = 0; n < this.#matches.length; n++) {
			const match = this.#matches[n]!;
			const order = this.#order.get(match.blockId)!;
			if (order < at) continue;
			if (order > at) return n;
			const rect = this.#range(match)?.getBoundingClientRect();
			if (rect === undefined || rect.bottom >= top) return n;
		}
		return 0;
	}

	/** The blocks on screen (or within a screen of it), when there are too many matches to highlight them all. */
	#visibleBlocks(): Set<string> {
		const frame = this.#target!.scroller.getBoundingClientRect();
		const out = new Set<string>();
		for (let n = this.#firstBlockBelow(frame.top - frame.height); n < this.#blocks.length; n++) {
			const block = this.#blocks[n]!;
			const rect = blockRect(block);
			if (rect === undefined) continue;
			if (rect.top > frame.bottom + frame.height) break;
			out.add(block.id);
		}
		return out;
	}

	/**
	 * The first block whose bottom is at or below `y` on screen. Blocks are in page order, so it's a binary search
	 * (measuring each block would take too long on a long thread); a block not on the page (folded) is skipped for
	 * the next one that is.
	 */
	#firstBlockBelow(y: number): number {
		let lo = 0;
		let hi = this.#blocks.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			let probe = mid;
			let rect: DOMRect | undefined;
			while (probe < hi && (rect = blockRect(this.#blocks[probe]!)) === undefined) probe++;
			if (rect === undefined || rect.bottom >= y) hi = mid;
			else lo = probe + 1;
		}
		return lo;
	}

	#step(by: number): void {
		if (this.#matches.length === 0) return;
		this.#active = (this.#active + by + this.#matches.length) % this.#matches.length;
		this.#count.textContent = `${this.#active + 1}/${this.#matches.length}`;
		this.#show(this.#active);
	}

	/** Reveals match `index` (opening folds), scrolls it to the middle of the view and draws the highlights. */
	#show(index: number): void {
		const target = this.#target;
		const match = this.#matches[index];
		if (target === undefined || match === undefined) return;
		const generation = this.#generation;
		const range = target.reveal(match);
		// Revealing may have put text on the page (a cut-short output in full): read the blocks again, for the
		// highlights. Their text, and so the matches, is the same.
		if (target.textarea === undefined) {
			this.#blocks = target.blocks();
			this.#order = new Map(this.#blocks.map((b, n) => [b.id, n]));
		}
		if (generation !== this.#generation) return;
		const live = range ?? this.#range(match);
		if (live !== undefined && target.textarea === undefined) {
			const box = target.scroller;
			const rect = live.getBoundingClientRect();
			const frame = box.getBoundingClientRect();
			if (rect.top < frame.top + 24 || rect.bottom > frame.bottom - 24) box.scrollTop += rect.top - frame.top - (box.clientHeight - rect.height) / 2;
			if (rect.left < frame.left || rect.right > frame.right) box.scrollLeft += rect.left - frame.left - box.clientWidth / 3;
		}
		this.#paint();
	}

	/** A match's live range; none when its text isn't on the page as text yet (a cut-short output, code being drawn). */
	#range(match: FindMatch): Range | undefined {
		const block = this.#blocks[this.#order.get(match.blockId) ?? -1];
		return block === undefined ? undefined : rangeOf(block.map, match.start, match.end);
	}

	/** Highlights every match, and the current one more strongly with a box around it. */
	#paint(): void {
		this.#clearPaint();
		const target = this.#target;
		if (target === undefined) return;
		const current = this.#matches[this.#active];
		if (target.textarea !== undefined) {
			const layer = this.#layerIn(target.scroller);
			const frame = target.scroller.getBoundingClientRect();
			for (const rect of current === undefined ? [] : (target.rects?.(current) ?? [])) {
				const mark = document.createElement("div");
				mark.className = "find-box current";
				Object.assign(mark.style, { left: `${rect.left - frame.left + target.scroller.scrollLeft}px`, top: `${rect.top - frame.top + target.scroller.scrollTop}px`, width: `${rect.width}px`, height: `${rect.height}px` });
				layer.append(mark);
			}
			return;
		}
		const ranges: Range[] = [];
		let active: Range | undefined;
		// Past a thousand matches, only those in or near view are highlighted (again as it scrolls); the count still
		// covers every one.
		this.#partial = this.#matches.length > MANY;
		const near = this.#partial ? this.#visibleBlocks() : undefined;
		for (const match of this.#matches) {
			if (near !== undefined && match !== current && !near.has(match.blockId)) continue;
			const range = this.#range(match);
			// Text that isn't shown (in a closed fold) isn't painted: WebKit would paint it on the text next to it.
			if (range === undefined || !shown(range)) continue;
			if (match === current) active = range;
			else ranges.push(range);
		}
		if (highlights) {
			for (const range of [...ranges, ...(active ? [active] : [])]) {
				const root = range.startContainer.getRootNode();
				if (root instanceof ShadowRoot && !styled.has(root)) {
					const sheet = new CSSStyleSheet();
					sheet.replaceSync(HIGHLIGHT_CSS);
					root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
					styled.add(root);
				}
			}
			const all = new Highlight();
			for (const range of ranges) all.add(range);
			CSS.highlights.set(HIGHLIGHT, all);
			if (active) CSS.highlights.set(CURRENT, new Highlight(active));
		}
		const layer = this.#layerIn(target.scroller);
		const frame = target.scroller.getBoundingClientRect();
		const box = (range: Range, current: boolean) => {
			for (const rect of range.getClientRects()) {
				if (rect.width === 0 || rect.height === 0) continue;
				const mark = document.createElement("div");
				mark.className = current ? "find-box current" : "find-box";
				mark.style.left = `${rect.left - frame.left + target.scroller.scrollLeft - target.scroller.clientLeft}px`;
				mark.style.top = `${rect.top - frame.top + target.scroller.scrollTop - target.scroller.clientTop}px`;
				mark.style.width = `${rect.width}px`;
				mark.style.height = `${rect.height}px`;
				layer.append(mark);
			}
		};
		// Without the highlight API, boxes mark the matches in view (all of them would cost too much on a long thread).
		if (!highlights) {
			for (const range of ranges) {
				const rect = range.getBoundingClientRect();
				if (rect.bottom >= frame.top - 200 && rect.top <= frame.bottom + 200) box(range, false);
			}
		}
		if (active) box(active, true);
	}

	#layerIn(scroller: HTMLElement): HTMLElement {
		if (this.#layer === undefined) {
			this.#layer = document.createElement("div");
			this.#layer.className = "find-layer";
			this.#layer.setAttribute("aria-hidden", "true");
			// Boxes (without the highlight API), or highlights limited to what's in view, follow the view as it scrolls.
			let queued = false;
			document.addEventListener(
				"scroll",
				() => {
					if (!this.isOpen || (highlights && !this.#partial) || queued) return;
					queued = true;
					requestAnimationFrame(() => {
						queued = false;
						this.#paint();
					});
				},
				{ capture: true, passive: true },
			);
		}
		if (this.#layer.parentElement !== scroller) {
			if (getComputedStyle(scroller).position === "static") scroller.style.position = "relative";
			scroller.append(this.#layer);
		}
		return this.#layer;
	}

	#clearPaint(): void {
		if (highlights) {
			CSS.highlights.delete(HIGHLIGHT);
			CSS.highlights.delete(CURRENT);
		}
		this.#layer?.replaceChildren();
	}
}

/** Where a block is on screen: from its first to its last text node. None when it has none on the page. */
function blockRect(block: FindBlock): DOMRect | undefined {
	const first = block.map.pieces[0];
	const last = block.map.pieces.at(-1);
	if (first === undefined || last === undefined || !first.node.isConnected) return undefined;
	const range = document.createRange();
	range.setStart(first.node, 0);
	range.setEnd(last.node, last.node.data.length);
	const rect = range.getBoundingClientRect();
	return rect.height === 0 && rect.width === 0 ? undefined : rect;
}
