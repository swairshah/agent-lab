// The project panel, as in Delta (⇧⌘E): the session's files as a tree beside the file pane. Folders open in place,
// a file opens in its own tab, and files the thread changed are marked. ± narrows the tree to those files.
import { $, el, escapeHtml, storage } from "./dom.ts";

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] };

function build(paths: readonly string[]): Dir {
	const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
	for (const path of paths) {
		const parts = path.split("/");
		let dir = root;
		for (const part of parts.slice(0, -1)) {
			let next = dir.dirs.get(part);
			if (next === undefined) dir.dirs.set(part, (next = { name: part, path: dir.path === "" ? part : `${dir.path}/${part}`, dirs: new Map(), files: [] }));
			dir = next;
		}
		dir.files.push(path);
	}
	return root;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A small glyph for a file, by its name: what Delta's tree shows, drawn in the app's line style. */
function fileIcon(name: string): string {
	const lower = name.toLowerCase();
	const ext = lower.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
	if (lower === ".gitignore" || lower === ".gitattributes") return '<svg viewBox="0 0 20 20"><circle cx="6" cy="5" r="1.8"/><circle cx="6" cy="15" r="1.8"/><circle cx="14" cy="8" r="1.8"/><path d="M6 6.8v6.4M14 9.8c0 2.5-3 2.6-6.5 4"/></svg>';
	if (ext === "md" || ext === "markdown" || ext === "txt") return '<svg viewBox="0 0 20 20"><path d="M4 4.5h5a1.5 1.5 0 0 1 1.5 1.5v10a1.2 1.2 0 0 0-1.2-1.2H4zM16 4.5h-5a1.5 1.5 0 0 0-1.5 1.5v10a1.2 1.2 0 0 1 1.2-1.2H16z"/></svg>';
	if (ext === "json" || ext === "jsonc") return '<svg viewBox="0 0 20 20"><path d="M7.5 4.5C6 4.5 6 5.5 6 7s-.5 3-2 3c1.5 0 2 1.5 2 3s0 2.5 1.5 2.5M12.5 4.5c1.5 0 1.5 1 1.5 2.5s.5 3 2 3c-1.5 0-2 1.5-2 3s0 2.5-1.5 2.5"/></svg>';
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return '<svg viewBox="0 0 20 20"><rect x="3.5" y="4.5" width="13" height="11" rx="1.5"/><circle cx="8" cy="8.5" r="1.3"/><path d="m4 14 4-3.5 3 2.5 2-1.5 3 2.5"/></svg>';
	if (["yml", "yaml", "toml", "lock"].includes(ext)) return '<svg viewBox="0 0 20 20"><path d="M5 6h10M5 10h10M5 14h6"/></svg>';
	return '<svg viewBox="0 0 20 20"><path d="M5.5 3.5h6l3 3v10h-9z"/><path d="M11.5 3.5v3h3"/></svg>';
}

const FOLDER = '<svg viewBox="0 0 20 20"><path d="M3 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 7.8v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/></svg>';
const FOLDER_OPEN = '<svg viewBox="0 0 20 20"><path d="M3 14.5V6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h5.2A1.5 1.5 0 0 1 16 7.8V9"/><path d="M3 14.5 5 9.5h12.5l-2 5.3a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 14.5z"/></svg>';

export class FilesTree {
	/** A file was picked: open it in a tab. */
	onOpen: (path: string) => void = () => {};
	/** ± was switched on: Delta shows the changes alongside the changed files. */
	onChangesOnly: (on: boolean) => void = () => {};
	readonly #root = $("tree-rows");
	#name = "";
	#paths: readonly string[] = [];
	#changed = new Set<string>();
	#expanded = new Set<string>();
	#selected: string | undefined;
	#changesOnly = false;
	#storageKey = "";
	#signature = "";

	constructor() {
		this.#root.addEventListener("click", (event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>("[data-path]");
			if (row !== null) this.#activate(row);
		});
		this.#root.addEventListener("keydown", (event) => this.#key(event));
		$("tree-changes").addEventListener("click", () => this.changesOnly(!this.#changesOnly));
	}

	/** The session the tree belongs to: folders opened earlier in it open again. */
	setSession(id: string, name: string): void {
		if (this.#storageKey === `syncpi-tree:${id}`) return;
		this.#storageKey = `syncpi-tree:${id}`;
		this.#name = name;
		try {
			this.#expanded = new Set(JSON.parse(storage.get(this.#storageKey) ?? "[]") as string[]);
		} catch {
			this.#expanded = new Set();
		}
		this.#render(true);
	}

	/** The project's files, and the ones the thread changed (as paths relative to the project). */
	update(paths: readonly string[], changed: Set<string>): void {
		this.#paths = paths;
		this.#changed = changed;
		this.#render();
	}

	/** Marks the open file, opening the folders above it so it shows. */
	select(path: string | undefined): void {
		if (path === this.#selected) return;
		this.#selected = path;
		if (path !== undefined) {
			const parts = path.split("/");
			for (let n = 1; n < parts.length; n++) this.#expanded.add(parts.slice(0, n).join("/"));
		}
		this.#render(true);
		this.#root.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
	}

	changesOnly(on: boolean): void {
		this.#changesOnly = on;
		$("tree-changes").setAttribute("aria-pressed", String(on));
		this.#render(true);
		this.onChangesOnly(on);
	}

	#save(): void {
		if (this.#storageKey !== "") storage.set(this.#storageKey, JSON.stringify([...this.#expanded]));
	}

	#activate(row: HTMLElement): void {
		const path = row.dataset.path!;
		if (row.dataset.dir !== undefined) {
			if (this.#expanded.has(path)) this.#expanded.delete(path);
			else this.#expanded.add(path);
			this.#save();
			this.#render(true);
			this.#root.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
			return;
		}
		this.onOpen(path);
	}

	/** Arrows move through the rows, right and left open and close folders, as in Delta's project panel. */
	#key(event: KeyboardEvent): void {
		const rows = [...this.#root.querySelectorAll<HTMLElement>("[data-path]")];
		const row = (event.target as HTMLElement).closest<HTMLElement>("[data-path]");
		if (row === null) return;
		const at = rows.indexOf(row);
		const path = row.dataset.path!;
		const dir = row.dataset.dir !== undefined;
		let next: HTMLElement | undefined;
		switch (event.key) {
			case "ArrowDown":
				next = rows[at + 1];
				break;
			case "ArrowUp":
				next = rows[at - 1];
				break;
			case "ArrowRight":
				if (dir && !this.#expanded.has(path)) return (event.preventDefault(), this.#activate(row));
				next = dir ? rows[at + 1] : undefined;
				break;
			case "ArrowLeft":
				if (dir && this.#expanded.has(path)) return (event.preventDefault(), this.#activate(row));
				// To the folder it's in.
				next = rows.find((r) => r.dataset.dir !== undefined && r.dataset.path === path.slice(0, path.lastIndexOf("/")));
				break;
			default:
				return;
		}
		event.preventDefault();
		next?.focus();
	}

	#visible(): readonly string[] {
		if (!this.#changesOnly) return this.#paths;
		return this.#paths.filter((p) => this.#changed.has(p));
	}

	#render(force = false): void {
		const paths = this.#visible();
		const signature = `${paths.length}|${paths.join("\n")}|${[...this.#changed].join("\n")}`;
		if (!force && signature === this.#signature) return;
		this.#signature = signature;
		$("tree-name").textContent = this.#name;
		const html: string[] = [];
		const changedUnder = (dir: Dir): boolean => dir.files.some((f) => this.#changed.has(f)) || [...dir.dirs.values()].some(changedUnder);
		const walk = (dir: Dir, depth: number) => {
			for (const sub of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
				// In "changes only" every folder on the way is open: the point is to see the files.
				const open = this.#changesOnly || this.#expanded.has(sub.path);
				html.push(
					`<button type="button" class="tree-row" data-path="${escapeHtml(sub.path)}" data-dir aria-expanded="${open}" style="--depth:${depth}">${open ? FOLDER_OPEN : FOLDER}<span class="tree-label">${escapeHtml(sub.name)}</span>${
						!open && changedUnder(sub) ? '<span class="tree-dot" title="Changed in this thread"></span>' : ""
					}</button>`,
				);
				if (open) walk(sub, depth + 1);
			}
			for (const file of [...dir.files].sort((a, b) => byName(base(a), base(b)))) {
				const changed = this.#changed.has(file);
				html.push(
					`<button type="button" class="tree-row${changed ? " changed" : ""}" data-path="${escapeHtml(file)}" aria-current="${file === this.#selected}" style="--depth:${depth}" title="${escapeHtml(file)}">${fileIcon(base(file))}<span class="tree-label">${escapeHtml(base(file))}</span>${
						changed ? '<span class="tree-dot" title="Changed in this thread"></span>' : ""
					}</button>`,
				);
			}
		};
		walk(build(paths), 0);
		if (html.length === 0) html.push(`<p class="panel-empty">${this.#changesOnly ? "Nothing changed in this thread yet." : "No files yet."}</p>`);
		this.#root.innerHTML = html.join("");
	}
}
