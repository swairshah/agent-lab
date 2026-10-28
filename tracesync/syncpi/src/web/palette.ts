// The command palette, as in Delta: ⌘K searches everything, ⌘⇧P opens on commands, ⌘P on files, ⌘T on threads (in
// the app). ⌘1–⌘4 switch tabs while it's open; arrows move, Enter runs, Esc closes. Commands and their shortcuts come from
// src/shared/keymap.json, so the desktop app offers the same ones; each app supplies what a command does.
// The same box picks the agent's model (⌘⌥/): models grouped by the provider serving them, with the thinking level.
import { type App, type Command, commandsFor, formatKeys, matchesKeys } from "../shared/keymap.ts";
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

type Row = { key: string; title: string; detail?: string; keys?: string; section: string; icon?: string; current?: boolean; run(): void };

export type ModelPick = {
	models: { id: string; name: string; reasoning?: boolean }[];
	current: string;
	thinking: string;
	choose(model: string, thinking: string): void;
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Subsequence match, scored so that earlier, contiguous and word-start matches rank first. -1 when no match. */
export function score(text: string, query: string): number {
	if (query === "") return 0;
	const t = text.toLowerCase();
	const q = query.toLowerCase();
	const at = t.indexOf(q);
	if (at >= 0) return 1000 - at - (at > 0 && /\w/.test(t[at - 1]!) ? 50 : 0);
	let i = 0;
	let points = 0;
	let last = -2;
	for (const ch of q) {
		const found = t.indexOf(ch, i);
		if (found < 0) return -1;
		points += found === last + 1 ? 5 : 1;
		if (found === 0 || /[\s/._-]/.test(t[found - 1]!)) points += 3;
		last = found;
		i = found + 1;
	}
	// Letters scattered across the text match nearly anything; keep runs and word starts.
	return points >= q.length * 3 ? points : -1;
}

/** The positions in `text` that `query` matched, as score() matches them, for highlighting. */
export function matchPositions(text: string, query: string): number[] {
	if (query === "") return [];
	const t = text.toLowerCase();
	const q = query.toLowerCase();
	const at = t.indexOf(q);
	if (at >= 0) return [...q].map((_, n) => at + n);
	const out: number[] = [];
	let i = 0;
	for (const ch of q) {
		const found = t.indexOf(ch, i);
		if (found < 0) return [];
		out.push(found);
		i = found + 1;
	}
	return out;
}

function highlight(text: string, query: string): string {
	const marks = new Set(matchPositions(text, query));
	return [...text].map((ch, n) => (marks.has(n) ? `<mark>${escapeHtml(ch)}</mark>` : escapeHtml(ch))).join("");
}

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>';
const THREAD_ICON = '<svg viewBox="0 0 24 24"><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></svg>';

export class Palette {
	readonly #dialog: HTMLDialogElement;
	readonly #input: HTMLInputElement;
	readonly #list: HTMLElement;
	readonly #commands: Command[];
	readonly #handlers: Record<string, () => void>;
	readonly #files: () => string[];
	readonly #openFile: (path: string) => void;
	readonly #threads: (() => ThreadRow[]) | undefined;
	readonly #createFile: ((path: string) => void) | undefined;
	readonly #openThread: (id: string) => void;
	readonly #tabs: { tab: Tab; label: string }[];
	#tab: Tab = "all";
	/** Set while the box is picking a model rather than running commands. */
	#pick: ModelPick | undefined;
	#thinking = "medium";
	#rows: Row[] = [];
	#selected = 0;
	#quietUntil = 0;

	constructor(options: {
		handlers: Record<string, () => void>;
		files: () => string[];
		openFile: (path: string) => void;
		app?: App;
		threads?: () => ThreadRow[];
		openThread?: (id: string) => void;
		createFile?: (path: string) => void;
	}) {
		this.#createFile = options.createFile;
		this.#handlers = options.handlers;
		this.#files = options.files;
		this.#openFile = options.openFile;
		this.#threads = options.threads;
		this.#openThread = options.openThread ?? (() => {});
		this.#tabs = ALL_TABS.filter((t) => t.tab !== "threads" || this.#threads !== undefined);
		// Only commands this app can carry out.
		this.#commands = commandsFor(options.app ?? "web").filter((c) => c.id in options.handlers);
		this.#dialog = $<HTMLDialogElement>("palette");
		this.#input = $<HTMLInputElement>("palette-input");
		this.#list = $("palette-list");
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
	}

	get isOpen(): boolean {
		return this.#dialog.open;
	}

	open(tab: Tab): void {
		this.#pick = undefined;
		this.#renderTabs();
		this.#input.value = "";
		if (!this.#dialog.open) this.#dialog.showModal();
		this.#show(tab);
	}

	/** The model picker: search, models under their provider, the current one checked, thinking level chips. */
	pickModel(pick: ModelPick): void {
		this.#pick = pick;
		this.#thinking = pick.thinking || "medium";
		this.#renderThinking();
		this.#input.value = "";
		this.#input.placeholder = "Select a model…";
		if (!this.#dialog.open) this.#dialog.showModal();
		this.#input.focus();
		this.#render();
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
	handler(id: string): (() => void) | undefined {
		return this.#commands.some((c) => c.id === id) || id.startsWith("palette.") ? this.#handlers[id] : undefined;
	}

	/** Runs the command a key press is the shortcut for. Returns whether one ran. */
	handleKey(event: KeyboardEvent): boolean {
		const command = this.#commands.find((c) => c.keys !== undefined && matchesKeys(event, c.keys));
		if (command === undefined) return false;
		event.preventDefault();
		this.#handlers[command.id]!();
		return true;
	}

	#show(tab: Tab): void {
		this.#tab = tab;
		for (const button of $("palette-tabs").querySelectorAll<HTMLElement>("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
		this.#input.placeholder =
			tab === "files" ? "Go to a file…" : tab === "commands" ? "Run a command…" : tab === "threads" ? "Go to a thread…" : this.#threads ? "Search threads, commands and files…" : "Search commands and files…";
		this.#input.focus();
		this.#render();
	}

	#commandRows(query: string, section: string): Row[] {
		return this.#commands
			.map((c) => ({ c, s: Math.max(score(c.title, query), score(c.group, query) - 10) }))
			.filter(({ s }) => s >= 0)
			.sort((a, b) => (query ? b.s - a.s : 0))
			.map(({ c }) => ({ key: c.id, title: c.title, detail: c.group, keys: c.keys, section, run: () => this.#handlers[c.id]!() }));
	}

	#fileRows(query: string, limit: number): Row[] {
		return this.#files()
			.map((path) => ({ path, s: score(path, query) + (score(path.split("/").pop()!, query) > 0 ? 200 : 0) }))
			.filter(({ s }) => s >= 0)
			.sort((a, b) => b.s - a.s || a.path.length - b.path.length)
			.slice(0, limit)
			.map(({ path }) => {
				const slash = path.lastIndexOf("/");
				return { key: `file:${path}`, title: path.slice(slash + 1), detail: slash > 0 ? `${path.slice(0, slash)}/` : undefined, section: "Files", icon: FILE_ICON, run: () => this.#openFile(path) };
			});
	}

	#threadRows(query: string, limit: number): Row[] {
		return (this.#threads?.() ?? [])
			.map((t) => ({ t, s: Math.max(score(t.title, query), score(t.project, query) - 20) }))
			.filter(({ s }) => s >= 0)
			.sort((a, b) => (query ? b.s - a.s : 0))
			.slice(0, limit)
			.map(({ t }) => ({ key: `thread:${t.id}`, title: t.title, detail: t.project, section: "Threads", icon: THREAD_ICON, current: t.current, run: () => this.#openThread(t.id) }));
	}

	#modelRows(query: string): Row[] {
		const pick = this.#pick!;
		return pick.models
			.map((m) => ({ m, s: Math.max(score(m.name, query), score(m.id, query) - 5) }))
			.filter(({ s }) => s >= 0)
			.sort((a, b) => (query ? b.s - a.s : 0))
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

	#render(): void {
		const query = this.#input.value.trim();
		if (this.#pick !== undefined) this.#rows = this.#modelRows(query);
		else if (this.#tab === "commands") this.#rows = this.#commandRows(query, "Commands");
		else if (this.#tab === "files") {
			this.#rows = this.#fileRows(query, 60);
			// A path that isn't a file yet can be made.
			const path = query.replace(/^\/+/, "");
			if (this.#createFile !== undefined && path && !path.endsWith("/") && !this.#files().includes(path))
				this.#rows.push({ key: `new:${path}`, title: `Create ${path}`, section: "New file", icon: FILE_ICON, run: () => this.#createFile!(path) });
		}
		else if (this.#tab === "threads") this.#rows = this.#threadRows(query, 80);
		else if (query === "") {
			const quick = this.#commands.filter((c) => c.quick);
			this.#rows = [
				...quick.map((c) => ({ key: c.id, title: c.title, keys: c.keys, section: "Quick actions", run: () => this.#handlers[c.id]!() })),
				...this.#commandRows("", "Commands").filter((r) => !quick.some((c) => c.id === r.key)),
			];
		} else this.#rows = [...this.#threadRows(query, 6), ...this.#commandRows(query, "Commands").slice(0, 8), ...this.#fileRows(query, 12)];
		// The model picker opens on the model in use.
		this.#selected = this.#pick !== undefined && query === "" ? Math.max(0, this.#rows.findIndex((r) => r.current)) : 0;
		this.#list.replaceChildren();
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
				this.#list.append(el("div", "palette-section", section));
			}
			const item = el("div", "palette-row");
			item.dataset.index = String(n);
			item.setAttribute("role", "option");
			item.setAttribute("aria-selected", String(n === this.#selected));
			// row.icon is one of our bundled vendor marks, not user content.
			item.innerHTML = `${row.icon !== undefined ? `<span class="palette-icon">${row.icon}</span>` : ""}<span class="palette-title">${highlight(row.title, query)}</span>${
				row.detail ? `<span class="palette-detail">${escapeHtml(row.detail)}</span>` : ""
			}${row.keys ? `<kbd>${escapeHtml(formatKeys(row.keys))}</kbd>` : ""}${row.current ? `<span class="palette-check">✓</span>` : ""}`;
			this.#list.append(item);
		});
		this.#quietUntil = performance.now() + 250;
		this.#list.querySelector<HTMLElement>(`[data-index="${this.#selected}"]`)?.scrollIntoView({ block: "center" });
	}

	#select(index: number): void {
		this.#selected = index;
		for (const row of this.#list.querySelectorAll<HTMLElement>("[data-index]")) row.setAttribute("aria-selected", String(Number(row.dataset.index) === index));
		this.#quietUntil = performance.now() + 250;
		this.#list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}

	#run(index: number): void {
		const row = this.#rows[index];
		if (row === undefined) return;
		this.close();
		row.run();
	}

	#key(event: KeyboardEvent): void {
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
