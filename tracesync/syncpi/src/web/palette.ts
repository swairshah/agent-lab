// The command palette, as in Delta: ⌘K searches everything, ⌘⇧P opens on commands, ⌘P on files, ⌘T on threads (in
// the app). ⌘1–⌘4 switch tabs while it's open; arrows move, Enter runs, Esc closes. Commands and their shortcuts come from
// src/shared/keymap.json, so the desktop app offers the same ones; each app supplies what a command does.
// The same box picks the agent's model (⌘⌥/): models grouped by the provider serving them, with the thinking level.
import { type App, type Command, commandsFor, formatKeys, matchesKeys } from "../shared/keymap.ts";
import { byRank, fileMatch, fuzzy, markPositions } from "../shared/search.ts";
import { $, el, escapeHtml } from "./dom.ts";
import { modelVendor, providerName } from "./icons.ts";

export type Tab = "all" | "threads" | "commands" | "files";
const ALL_TABS: { tab: Tab; label: string }[] = [
	{ tab: "all", label: "All" },
	{ tab: "threads", label: "Threads" },
	{ tab: "commands", label: "Commands" },
	{ tab: "files", label: "Files" },
];

/** A thread the palette can go to (in the app, which has more than one). */
export type ThreadRow = { id: string; title: string; project: string; current: boolean };

/** A result. Where the query matched is marked in the title or the detail, whichever it matched. */
type Row = { key: string; title: string; detail?: string; titleMarks?: number[]; detailMarks?: number[]; keys?: string; section: string; icon?: string; current?: boolean; run(): void };

/** What the All tab shows of each kind before "Show all"; the Threads and Files tabs stop at their own caps. */
const ALL_CAPS = { threads: 6, commands: 8, files: 12 };
const TAB_CAPS = { threads: 80, files: 60 };

export type ModelPick = {
	models: { id: string; name: string; reasoning?: boolean }[];
	current: string;
	thinking: string;
	choose(model: string, thinking: string): void;
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Text with the characters at `positions` marked, escaped. */
function highlight(text: string, positions: readonly number[]): string {
	return markPositions(text, positions)
		.map((part) => (part.marked ? `<mark>${escapeHtml(part.text)}</mark>` : escapeHtml(part.text)))
		.join("");
}

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>';
const THREAD_ICON = '<svg viewBox="0 0 24 24"><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></svg>';

export class Palette {
	readonly #dialog: HTMLDialogElement;
	readonly #input: HTMLInputElement;
	readonly #list: HTMLElement;
	readonly #status: HTMLElement;
	readonly #commands: Command[];
	readonly #handlers: Record<string, () => void | boolean>;
	readonly #files: () => string[];
	readonly #openFile: (path: string) => void;
	readonly #threads: (() => ThreadRow[]) | undefined;
	readonly #createFile: ((path: string) => void) | undefined;
	readonly #canCreate: () => boolean;
	readonly #openThread: (id: string) => void;
	readonly #tabs: { tab: Tab; label: string }[];
	#tab: Tab = "all";
	/** Set while the box is picking a model rather than running commands. */
	#pick: ModelPick | undefined;
	#thinking = "medium";
	#rows: Row[] = [];
	#selected = 0;
	#quietUntil = 0;
	/** Where focus and the selection were before the box opened, to put them back when it's dismissed. */
	#before: { focus: HTMLElement | null; range?: Range; input?: [number, number] } | undefined;
	#ran = false;
	/** Option ids by row key, stable across redraws (aria-activedescendant names one). */
	readonly #ids = new Map<string, string>();
	#announce: ReturnType<typeof setTimeout> | undefined;

	constructor(options: {
		/** What each command does; one returning false didn't apply here (its key goes on to the page). */
		handlers: Record<string, () => void | boolean>;
		files: () => string[];
		openFile: (path: string) => void;
		app?: App;
		threads?: () => ThreadRow[];
		openThread?: (id: string) => void;
		createFile?: (path: string) => void;
		/** Whether this member may make files now (not a viewer); asked each time the list is drawn. */
		canCreate?: () => boolean;
	}) {
		this.#createFile = options.createFile;
		this.#canCreate = options.canCreate ?? (() => true);
		this.#handlers = options.handlers;
		this.#files = options.files;
		this.#openFile = options.openFile;
		this.#threads = options.threads;
		this.#openThread = options.openThread ?? (() => {});
		// No Threads tab without threads to go to (a thread in a browser).
		this.#tabs = ALL_TABS.filter((t) => t.tab !== "threads" || this.#threads !== undefined);
		// Only commands this app can carry out.
		this.#commands = commandsFor(options.app ?? "web")
			.filter((c) => c.id in options.handlers)
			.map((c) => (c.id === "palette.all" && this.#threads === undefined ? { ...c, title: "Search commands and files" } : c));
		this.#dialog = $<HTMLDialogElement>("palette");
		this.#input = $<HTMLInputElement>("palette-input");
		this.#list = $("palette-list");
		this.#status = $("palette-status");
		$("palette-heading").textContent = this.#threads ? "Search commands, threads and files" : "Search commands and files";
		this.#renderTabs();
		$("palette-tabs").addEventListener("click", (event) => {
			const target = event.target as HTMLElement;
			const thinking = target.closest<HTMLElement>("[data-thinking]")?.dataset.thinking;
			if (thinking !== undefined) {
				this.#thinking = thinking;
				this.#renderThinking();
				return this.#input.focus();
			}
			const tab = target.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
			if (tab) this.#show(tab);
		});
		this.#input.addEventListener("input", () => this.#render());
		this.#input.addEventListener("keydown", (event) => this.#key(event));
		// Hover selects, but not just after the list was redrawn or scrolled for the keyboard: that moves rows under
		// a still pointer, and browsers report it as a mousemove.
		this.#list.addEventListener("mousemove", (event) => {
			if (performance.now() < this.#quietUntil) return;
			const index = (event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
			if (index !== undefined && Number(index) !== this.#selected) this.#select(Number(index));
		});
		this.#list.addEventListener("click", (event) => {
			const index = (event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
			if (index !== undefined) this.#run(Number(index));
		});
		// Clicking outside the box closes it.
		this.#dialog.addEventListener("click", (event) => {
			if (event.target === this.#dialog) this.close();
		});
		// Dismissed (Esc, a click outside): focus and the selection go back where they were. After running a row, what
		// it opened has focus instead.
		this.#dialog.addEventListener("close", () => {
			const before = this.#before;
			this.#before = undefined;
			this.#input.setAttribute("aria-expanded", "false");
			if (this.#ran || before?.focus == null || !before.focus.isConnected) return;
			before.focus.focus({ preventScroll: true });
			if (before.input !== undefined && (before.focus instanceof HTMLInputElement || before.focus instanceof HTMLTextAreaElement)) before.focus.setSelectionRange(...before.input);
			else if (before.range !== undefined && before.range.startContainer.isConnected) {
				const selection = getSelection();
				selection?.removeAllRanges();
				selection?.addRange(before.range);
			}
		});
	}

	get isOpen(): boolean {
		return this.#dialog.open;
	}

	open(tab: Tab): void {
		this.#pick = undefined;
		this.#renderTabs();
		this.#input.value = "";
		this.#showModal();
		this.#show(tab);
	}

	/** The model picker: search, models under their provider, the current one checked, thinking level chips. */
	pickModel(pick: ModelPick): void {
		this.#pick = pick;
		this.#thinking = pick.thinking || "medium";
		this.#renderThinking();
		this.#input.value = "";
		this.#input.placeholder = "Select a model…";
		this.#input.setAttribute("aria-label", "Select a model");
		this.#showModal();
		this.#input.focus();
		this.#render();
	}

	#showModal(): void {
		this.#ran = false;
		if (this.#dialog.open) return;
		const focus = document.activeElement as HTMLElement | null;
		const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).cloneRange() : undefined;
		const input = focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement ? ([focus.selectionStart ?? 0, focus.selectionEnd ?? 0] as [number, number]) : undefined;
		this.#before = { focus, range, input };
		this.#dialog.showModal();
		this.#input.setAttribute("aria-expanded", "true");
	}

	#renderTabs(): void {
		$("palette-tabs").innerHTML = this.#tabs.map((t, n) => `<button type="button" role="tab" data-tab="${t.tab}">${t.label}<kbd>${formatKeys(`cmd-${n + 1}`)}</kbd></button>`).join("");
	}

	#renderThinking(): void {
		$("palette-tabs").innerHTML =
			`<span class="palette-label">Thinking</span>` +
			THINKING.map((level) => `<button type="button" data-thinking="${level}" aria-selected="${level === this.#thinking}">${level}</button>`).join("");
	}

	close(): void {
		this.#dialog.close();
	}

	/** What command `id` does here, if this app does it. */
	handler(id: string): (() => void | boolean) | undefined {
		return this.#commands.some((c) => c.id === id) || id.startsWith("palette.") ? this.#handlers[id] : undefined;
	}

	/** Runs the command a key press is the shortcut for. Returns whether one ran. */
	handleKey(event: KeyboardEvent): boolean {
		if (event.isComposing) return false;
		const command = this.#commands.find((c) => c.keys !== undefined && matchesKeys(event, c.keys));
		if (command === undefined) return false;
		if (this.#handlers[command.id]!() === false) return false;
		event.preventDefault();
		return true;
	}

	#show(tab: Tab): void {
		this.#tab = tab;
		for (const button of $("palette-tabs").querySelectorAll<HTMLElement>("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
		const label =
			tab === "files" ? "Go to a file" : tab === "commands" ? "Run a command" : tab === "threads" ? "Go to a thread" : this.#threads ? "Search commands, threads and files" : "Search commands and files";
		this.#input.placeholder = `${label}…`;
		this.#input.setAttribute("aria-label", label);
		this.#input.focus();
		this.#render();
	}

	/** Commands match on their title, or (less) their group. With no query, in the keymap's order. */
	#commandRows(query: string, section: string): Row[] {
		const rows = this.#commands.flatMap((c) => {
			const title = fuzzy(c.title, query);
			const group = fuzzy(c.group, query);
			const score = Math.max(title.score, group.score >= 0 ? group.score - 10 : -1);
			if (score < 0) return [];
			const row: Row = { key: c.id, title: c.title, detail: c.group, keys: c.keys, section, run: () => void this.#handlers[c.id]!() };
			if (title.score >= 0 && title.score >= group.score - 10) row.titleMarks = title.positions;
			else row.detailMarks = group.positions;
			return [{ row, score, label: c.title, id: c.id }];
		});
		if (query !== "") rows.sort(byRank);
		return rows.map((r) => r.row);
	}

	/** Files by the better of their path and their name; the detail is the folder, marked when that's what matched. */
	#fileRows(query: string): Row[] {
		return this.#files()
			.flatMap((path) => {
				const match = fileMatch(path, query);
				return match === undefined ? [] : [{ path, match, score: match.score, label: path, id: path }];
			})
			.sort(byRank)
			.map(({ path, match }) => {
				const slash = path.lastIndexOf("/");
				const row: Row = { key: `file:${path}`, title: path.slice(slash + 1), detail: slash > 0 ? `${path.slice(0, slash)}/` : undefined, section: "Files", icon: FILE_ICON, run: () => this.#openFile(path) };
				if (match.field === "name") row.titleMarks = match.positions;
				else {
					// A match in the full path: the part in the folder marks the detail, the rest the name.
					row.detailMarks = match.positions.filter((p) => p <= slash);
					row.titleMarks = match.positions.filter((p) => p > slash).map((p) => p - slash - 1);
				}
				return row;
			});
	}

	/** Threads by title, or (less) by their project's name. With no query, in the sidebar's order. */
	#threadRows(query: string): Row[] {
		const rows = (this.#threads?.() ?? []).flatMap((t) => {
			const title = fuzzy(t.title, query);
			const project = fuzzy(t.project, query);
			const score = Math.max(title.score, project.score >= 0 ? project.score - 20 : -1);
			if (score < 0) return [];
			const row: Row = { key: `thread:${t.id}`, title: t.title, detail: t.project, section: "Threads", icon: THREAD_ICON, current: t.current, run: () => this.#openThread(t.id) };
			if (title.score >= 0 && title.score >= project.score - 20) row.titleMarks = title.positions;
			else row.detailMarks = project.positions;
			return [{ row, score, label: t.title, id: t.id }];
		});
		if (query !== "") rows.sort(byRank);
		return rows.map((r) => r.row);
	}

	#modelRows(query: string): Row[] {
		const pick = this.#pick!;
		return pick.models
			.flatMap((m) => {
				const name = fuzzy(m.name, query);
				const id = fuzzy(m.id, query);
				const score = Math.max(name.score, id.score >= 0 ? id.score - 5 : -1);
				return score < 0 ? [] : [{ m, score, label: m.name, id: m.id }];
			})
			.sort((a, b) => (query ? byRank(a, b) : 0))
			.map(({ m }) => {
				const provider = m.id.split("/")[0]!;
				const vendor = modelVendor(m.id);
				return {
					key: `model:${m.id}`,
					title: vendor ? `${vendor.name}: ${m.name}` : m.name,
					detail: m.id,
					section: providerName(provider),
					icon: vendor?.svg ?? "",
					current: m.id === pick.current,
					run: () => pick.choose(m.id, this.#thinking),
				};
			})
			.sort((a, b) => a.section.localeCompare(b.section));
	}

	/** A row that opens a tab with the same query, after a capped section of the All tab. */
	#more(tab: Tab, total: number, noun: string): Row {
		return { key: `more:${tab}`, title: `Show all ${total} ${noun}`, section: "", run: () => this.#show(tab) };
	}

	#render(): void {
		const query = this.#input.value.trim();
		/** Below the list: how many there are past a tab's cap. */
		let note: string | undefined;
		const capped = (rows: Row[], cap: number, noun: string) => {
			if (rows.length > cap) note = `Showing ${cap} of ${rows.length} ${noun}. Type more to narrow them down.`;
			return rows.slice(0, cap);
		};
		if (this.#pick !== undefined) this.#rows = this.#modelRows(query);
		else if (this.#tab === "commands") this.#rows = this.#commandRows(query, "Commands");
		else if (this.#tab === "files") this.#rows = capped(this.#fileRows(query), TAB_CAPS.files, "files");
		else if (this.#tab === "threads") this.#rows = capped(this.#threadRows(query), TAB_CAPS.threads, "threads");
		else if (query === "") {
			const quick = this.#commands.filter((c) => c.quick);
			this.#rows = [
				...quick.map((c) => ({ key: c.id, title: c.title, keys: c.keys, section: "Quick actions", run: () => void this.#handlers[c.id]!() })),
				...this.#commandRows("", "Commands").filter((r) => !quick.some((c) => c.id === r.key)),
			];
		} else {
			// Threads, then commands, then files: each kind ranked on its own, never against each other.
			this.#rows = [];
			for (const [rows, cap, tab, noun] of [
				[this.#threadRows(query), ALL_CAPS.threads, "threads", "threads"],
				[this.#commandRows(query, "Commands"), ALL_CAPS.commands, "commands", "commands"],
				[this.#fileRows(query), ALL_CAPS.files, "files", "files"],
			] as const) {
				this.#rows.push(...rows.slice(0, cap));
				if (rows.length > cap) this.#rows.push({ ...this.#more(tab, rows.length, noun), section: rows[0]!.section });
			}
		}
		// Making a file is its own section, apart from what matched, and only for members who can.
		if (this.#tab === "files" && this.#pick === undefined && this.#createFile !== undefined && this.#canCreate()) {
			const path = query.replace(/^\/+/, "");
			if (path && !path.endsWith("/") && !this.#files().includes(path))
				this.#rows.push({ key: `new:${path}`, title: `Create ${path}`, section: "New file", icon: FILE_ICON, run: () => this.#createFile!(path) });
		}
		// The model picker opens on the model in use.
		this.#selected = this.#pick !== undefined && query === "" ? Math.max(0, this.#rows.findIndex((r) => r.current)) : 0;
		this.#list.replaceChildren();
		this.#input.removeAttribute("aria-activedescendant");
		this.#say(this.#rows.length === 0 ? "No results" : `${this.#rows.length} result${this.#rows.length === 1 ? "" : "s"}`);
		if (this.#rows.length === 0) {
			this.#list.append(
				el("div", "palette-empty", this.#tab === "files" && this.#files().length === 0 ? "No project files yet." : this.#tab === "threads" && !this.#threads?.().length ? "No threads yet." : "Nothing matches."),
			);
			return;
		}
		let section = "";
		this.#rows.forEach((row, n) => {
			if (row.section !== section) {
				section = row.section;
				const heading = el("div", "palette-section", section);
				heading.setAttribute("role", "presentation");
				this.#list.append(heading);
			}
			const item = el("div", `palette-row${row.key.startsWith("more:") ? " palette-more" : ""}`);
			item.id = this.#idOf(row.key);
			item.dataset.index = String(n);
			item.setAttribute("role", "option");
			item.setAttribute("aria-selected", String(n === this.#selected));
			// row.icon is one of our bundled marks, not user content; everything else is escaped.
			item.innerHTML = `${row.icon !== undefined ? `<span class="palette-icon" aria-hidden="true">${row.icon}</span>` : ""}<span class="palette-title">${highlight(row.title, row.titleMarks ?? [])}</span>${
				row.detail ? `<span class="palette-detail">${highlight(row.detail, row.detailMarks ?? [])}</span>` : ""
			}${row.keys ? `<kbd>${escapeHtml(formatKeys(row.keys))}</kbd>` : ""}${row.current ? `<span class="palette-check" aria-label="current">✓</span>` : ""}`;
			this.#list.append(item);
		});
		if (note !== undefined) this.#list.append(el("div", "palette-note", note));
		this.#quietUntil = performance.now() + 250;
		this.#input.setAttribute("aria-activedescendant", this.#idOf(this.#rows[this.#selected]!.key));
		this.#list.querySelector<HTMLElement>(`[data-index="${this.#selected}"]`)?.scrollIntoView({ block: "center" });
	}

	#idOf(key: string): string {
		let id = this.#ids.get(key);
		if (id === undefined) {
			id = `palette-option-${this.#ids.size + 1}`;
			this.#ids.set(key, id);
		}
		return id;
	}

	/** Says how many results there are to a screen reader, once typing pauses rather than on every key. */
	#say(text: string): void {
		if (this.#announce !== undefined) clearTimeout(this.#announce);
		this.#announce = setTimeout(() => (this.#status.textContent = text), 500);
	}

	#select(index: number): void {
		this.#selected = index;
		for (const row of this.#list.querySelectorAll<HTMLElement>("[data-index]")) row.setAttribute("aria-selected", String(Number(row.dataset.index) === index));
		const row = this.#rows[index];
		if (row !== undefined) this.#input.setAttribute("aria-activedescendant", this.#idOf(row.key));
		this.#quietUntil = performance.now() + 250;
		this.#list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}

	#run(index: number): void {
		const row = this.#rows[index];
		if (row === undefined) return;
		// "Show all" keeps the box open on that tab.
		if (row.key.startsWith("more:")) return row.run();
		this.#ran = true;
		this.close();
		row.run();
	}

	#key(event: KeyboardEvent): void {
		if (event.isComposing) return;
		const tab = this.#pick === undefined ? this.#tabs.findIndex((_, n) => matchesKeys(event, `cmd-${n + 1}`)) : -1;
		if (tab >= 0) {
			event.preventDefault();
			return this.#show(this.#tabs[tab]!.tab);
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (this.#rows.length > 0) this.#select((this.#selected + (event.key === "ArrowDown" ? 1 : -1) + this.#rows.length) % this.#rows.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			this.#run(this.#selected);
		}
	}
}
