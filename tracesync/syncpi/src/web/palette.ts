// The command palette, as in Delta: ⌘K searches everything, ⌘⇧P opens on commands, ⌘P on files. ⌘1–⌘3 switch
// tabs while it's open; arrows move, Enter runs, Esc closes. Commands and their shortcuts come from
// src/shared/keymap.json, so the desktop app offers the same ones; each app supplies what a command does.
import { type Command, commandsFor, formatKeys, matchesKeys } from "../shared/keymap.ts";
import { $, el, escapeHtml } from "./dom.ts";

export type Tab = "all" | "commands" | "files";
const TABS: { tab: Tab; label: string }[] = [
	{ tab: "all", label: "All" },
	{ tab: "commands", label: "Commands" },
	{ tab: "files", label: "Files" },
];

type Row = { key: string; title: string; detail?: string; keys?: string; section: string; run(): void };

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
	return points;
}

export class Palette {
	readonly #dialog: HTMLDialogElement;
	readonly #input: HTMLInputElement;
	readonly #list: HTMLElement;
	readonly #commands: Command[];
	readonly #handlers: Record<string, () => void>;
	readonly #files: () => string[];
	readonly #openFile: (path: string) => void;
	#tab: Tab = "all";
	#rows: Row[] = [];
	#selected = 0;

	constructor(options: { handlers: Record<string, () => void>; files: () => string[]; openFile: (path: string) => void }) {
		this.#handlers = options.handlers;
		this.#files = options.files;
		this.#openFile = options.openFile;
		// Only commands this app can carry out.
		this.#commands = commandsFor("web").filter((c) => c.id in options.handlers);
		this.#dialog = $<HTMLDialogElement>("palette");
		this.#input = $<HTMLInputElement>("palette-input");
		this.#list = $("palette-list");
		$("palette-tabs").innerHTML = TABS.map((t, n) => `<button type="button" role="tab" data-tab="${t.tab}">${t.label}<kbd>${formatKeys(`cmd-${n + 1}`)}</kbd></button>`).join("");
		$("palette-tabs").addEventListener("click", (event) => {
			const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
			if (tab) this.#show(tab);
		});
		this.#input.addEventListener("input", () => this.#render());
		this.#input.addEventListener("keydown", (event) => this.#key(event));
		this.#list.addEventListener("mousemove", (event) => {
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
		this.#input.value = "";
		if (!this.#dialog.open) this.#dialog.showModal();
		this.#show(tab);
	}

	close(): void {
		this.#dialog.close();
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
		this.#input.placeholder = tab === "files" ? "Go to a file…" : tab === "commands" ? "Run a command…" : "Search commands and files…";
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
				return { key: `file:${path}`, title: path.slice(slash + 1), detail: slash > 0 ? path.slice(0, slash) : undefined, section: "Files", run: () => this.#openFile(path) };
			});
	}

	#render(): void {
		const query = this.#input.value.trim();
		if (this.#tab === "commands") this.#rows = this.#commandRows(query, "Commands");
		else if (this.#tab === "files") this.#rows = this.#fileRows(query, 60);
		else if (query === "") {
			const quick = this.#commands.filter((c) => c.quick);
			this.#rows = [
				...quick.map((c) => ({ key: c.id, title: c.title, keys: c.keys, section: "Quick actions", run: () => this.#handlers[c.id]!() })),
				...this.#commandRows("", "Commands").filter((r) => !quick.some((c) => c.id === r.key)),
			];
		} else this.#rows = [...this.#commandRows(query, "Commands").slice(0, 8), ...this.#fileRows(query, 12)];
		this.#selected = 0;
		this.#list.replaceChildren();
		if (this.#rows.length === 0) {
			this.#list.append(el("div", "palette-empty", this.#tab === "files" && this.#files().length === 0 ? "No project files yet." : "Nothing matches."));
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
			item.setAttribute("aria-selected", String(n === 0));
			item.innerHTML = `<span class="palette-title">${escapeHtml(row.title)}</span>${row.detail ? `<span class="palette-detail">${escapeHtml(row.detail)}</span>` : ""}${
				row.keys ? `<kbd>${escapeHtml(formatKeys(row.keys))}</kbd>` : ""
			}`;
			this.#list.append(item);
		});
	}

	#select(index: number): void {
		this.#selected = index;
		for (const row of this.#list.querySelectorAll<HTMLElement>("[data-index]")) row.setAttribute("aria-selected", String(Number(row.dataset.index) === index));
		this.#list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}

	#run(index: number): void {
		const row = this.#rows[index];
		if (row === undefined) return;
		this.close();
		row.run();
	}

	#key(event: KeyboardEvent): void {
		const tab = TABS.findIndex((_, n) => matchesKeys(event, `cmd-${n + 1}`));
		if (tab >= 0) {
			event.preventDefault();
			return this.#show(TABS[tab]!.tab);
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
