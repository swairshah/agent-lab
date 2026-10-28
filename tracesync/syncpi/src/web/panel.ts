// The side panel, laid out as Delta's: tabs along the top (Changes, then one per open project file), the open tab
// below them, and the project tree beside it (⇧⌘E). The Changes tab lists every artifact in the thread (changes to
// files, files written, HTML and SVG) and shows the selected one large; opening an artifact from the thread selects
// it there. A file tab shows the file as it is now, rendered when it's Markdown, and follows changes to it.
import { type Artifact, kindOfPath, patchStats, threadArtifacts } from "../shared/artifacts.ts";
import { fileKey } from "../shared/drafts.ts";
import { artifactCard, type CommentHandler, disposeWithin, type ImageLoader } from "./artifacts.ts";
import { $, el, escapeHtml, storage } from "./dom.ts";
import { FilesTree } from "./files-tree.ts";
import type { FindTarget } from "./find.ts";
import { rangeOf, readText, type TextMap } from "./find-text.ts";
import type { SessionClient } from "./session.ts";
import { TextBinding } from "./text-binding.ts";

/** Reads a project file as an artifact, or says why it couldn't. */
export type FileLoader = (path: string, lines?: string) => Promise<Artifact | undefined>;

/**
 * An open file. `version` is what Delta's picker offers: the file now, or as it was before the thread's last turn
 * (`before`: the file, or why it can't be shown).
 */
type FileTab = { path: string; artifact?: Artifact; lines?: string; missing?: boolean; version: "latest" | "before"; before?: Artifact | string };

const CHANGES = "changes";

/** `path` relative to the folder `dir` ("" or ending in "/"), or undefined when it climbs out of the project. */
function resolve(dir: string, path: string): string | undefined {
	const parts: string[] = [];
	for (const part of `${dir}${path}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") parts.push(part);
		else if (parts.pop() === undefined) return undefined;
	}
	return parts.join("/");
}

export class ArtifactPanel {
	readonly #session: SessionClient;
	readonly #loadImage: ImageLoader;
	readonly #onComment: CommentHandler;
	readonly #loadFile: FileLoader;
	readonly tree = new FilesTree();
	/** Saves an edited project file (see CardOptions.onSave). */
	onSave: ((path: string, text: string, base: string) => Promise<string | undefined>) | undefined;
	/** The file being edited here, live, if any; onEditing says when that changes (for people following). */
	editing: string | undefined;
	onEditing: () => void = () => {};
	#artifacts: Artifact[] = [];
	#selected: string | undefined;
	/** The list of changes is showing; it folds away while one is open, so the change gets the room. */
	#browsing = true;
	#signature = "";
	#tabs: FileTab[] = [];
	/** CHANGES, or the path of the open file tab. */
	#active = CHANGES;
	#tabsKey = "";
	#busy = false;
	/** Files marked seen, as in Delta: each file's path, with its newest change when it was marked. Kept here. */
	#seen: Record<string, string> = {};
	#seenKey = "";

	constructor(session: SessionClient, loadImage: ImageLoader, onComment: CommentHandler, loadFile: FileLoader) {
		this.#session = session;
		this.#loadImage = loadImage;
		this.#onComment = onComment;
		this.#loadFile = loadFile;
		$("panel-list").addEventListener("click", (event) => {
			const key = (event.target as HTMLElement).closest<HTMLElement>("[data-artifact]")?.dataset.artifact;
			if (key !== undefined) this.select(key);
		});
		$("panel-list").addEventListener("change", (event) => {
			const box = event.target as HTMLInputElement;
			if (box.dataset.seen !== undefined) this.#markSeen(box.dataset.seen, box.checked);
		});
		$("panel-close").addEventListener("click", () => this.toggle(false));
		$("panel-browse").addEventListener("click", () => this.#browse(!this.#browsing));
		$("tree-toggle").addEventListener("click", () => this.toggleTree());
		const tabs = $("panel-tabs");
		tabs.addEventListener("click", (event) => {
			const target = event.target as HTMLElement;
			const tab = target.closest<HTMLElement>("[data-tab]");
			if (tab === null) return;
			if (target.closest(".tab-close") !== null) return this.closeTab(tab.dataset.tab!);
			this.#activate(tab.dataset.tab!);
		});
		// A middle click closes a file tab, as in a browser or an editor.
		tabs.addEventListener("auxclick", (event) => {
			const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]");
			if (event.button === 1 && tab !== null && tab.dataset.tab !== CHANGES) this.closeTab(tab.dataset.tab!);
		});
		tabs.addEventListener("keydown", (event) => {
			const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]");
			if (tab === null) return;
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.#activate(tab.dataset.tab!);
			} else if ((event.key === "Backspace" || event.key === "Delete") && tab.dataset.tab !== CHANGES) {
				event.preventDefault();
				this.closeTab(tab.dataset.tab!);
			}
		});
		// A link in a rendered Markdown file opens what it points to, in its own tab, as in Delta. Links are relative to
		// the file's folder; a citation the agent wrote is relative to the project.
		for (const id of ["panel-file", "panel-view"]) {
			$(id).addEventListener("click", (event) => {
				const link = (event.target as HTMLElement).closest<HTMLElement>(".cite[data-path]");
				if (link === null) return;
				const path = link.dataset.path!;
				const from = id === "panel-file" ? this.#active : "";
				const nearby = resolve(from.slice(0, from.lastIndexOf("/") + 1), path);
				void this.openPath(nearby !== undefined && this.#session.hashes.has(nearby) ? nearby : path, link.dataset.lines);
			});
		}
		this.tree.onOpen = (path) => {
			void this.openPath(path);
			// On a phone the tree covers the file; picking one shows it.
			if (matchMedia("(max-width: 900px)").matches) this.toggleTree(false);
		};
		this.tree.onChangesOnly = (on) => on && this.#activate(CHANGES);
		session.on("files", () => this.#filesChanged());
		document.documentElement.classList.toggle("tree-open", storage.get("syncpi-tree-open") === "1");
		$("tree-toggle").setAttribute("aria-pressed", String(document.documentElement.classList.contains("tree-open")));
	}

	toggle(open?: boolean): void {
		document.documentElement.classList.toggle("panel-open", open);
	}

	/** Shows or hides the project tree (⇧⌘E), opening the panel to show it. */
	toggleTree(open?: boolean): void {
		const root = document.documentElement;
		const show = open ?? !(root.classList.contains("tree-open") && root.classList.contains("panel-open"));
		root.classList.toggle("tree-open", show);
		if (show) this.toggle(true);
		storage.set("syncpi-tree-open", show ? "1" : "0");
		$("tree-toggle").setAttribute("aria-pressed", String(show));
	}

	/** The session's id and name are known: its open tabs come back, and the tree its open folders. */
	setSession(id: string, name: string): void {
		this.tree.setSession(id, name);
		if (this.#seenKey !== `syncpi-seen:${id}`) {
			this.#seenKey = `syncpi-seen:${id}`;
			try {
				this.#seen = JSON.parse(storage.get(this.#seenKey) ?? "{}") as Record<string, string>;
			} catch {}
			this.#renderList();
			this.#renderTabs();
		}
		if (this.#tabsKey === `syncpi-tabs:${id}`) return;
		this.#tabsKey = `syncpi-tabs:${id}`;
		try {
			const saved = JSON.parse(storage.get(this.#tabsKey) ?? "{}") as { open?: string[]; active?: string };
			this.#tabs = (saved.open ?? []).map((path) => ({ path, version: "latest" as const }));
			this.#active = saved.active !== undefined && this.#tabs.some((t) => t.path === saved.active) ? saved.active : CHANGES;
		} catch {}
		this.#renderTabs();
		if (this.#active !== CHANGES) this.#activate(this.#active);
	}

	/** Opens the panel on the list of the thread's changes. */
	showChanges(): void {
		this.#activate(CHANGES);
		this.#browse(true);
		this.toggle(true);
	}

	/** The newest change of each file the thread changed, by path. */
	#newest(): Map<string, string> {
		const out = new Map<string, string>();
		for (const a of this.#artifacts) if (a.path !== undefined && a.source !== "reply") out.set(a.path, a.key);
		return out;
	}

	/** Files changed since they were marked seen (or never marked). */
	#unseen(): string[] {
		return [...this.#newest()].filter(([path, key]) => this.#seen[path] !== key).map(([path]) => path);
	}

	/** Marks a file seen as it is now; a later change shows it again. */
	#markSeen(path: string, seen: boolean): void {
		const key = this.#newest().get(path);
		if (seen && key !== undefined) this.#seen[path] = key;
		else delete this.#seen[path];
		if (this.#seenKey !== "") storage.set(this.#seenKey, JSON.stringify(this.#seen));
		this.#renderList();
		this.#renderTabs();
	}

	/** Shows an artifact large in the Changes tab, opening the panel. */
	open(artifact: Artifact): void {
		if (artifact.source === "file" && artifact.path !== undefined) return this.openFile(artifact);
		this.update();
		this.#activate(CHANGES);
		this.select(artifact.key);
		this.toggle(true);
	}

	/** Shows a project file already read, in its own tab. */
	openFile(file: Artifact): void {
		const path = file.path!;
		const tab = this.#tabs.find((t) => t.path === path) ?? this.#addTab(path);
		tab.artifact = file;
		tab.lines = file.lines;
		tab.missing = false;
		this.#activate(path);
		this.toggle(true);
	}

	/** Opens a project file in its own tab (or the tab it's already in), reading it first. */
	async openPath(path: string, lines?: string): Promise<void> {
		const tab = this.#tabs.find((t) => t.path === path) ?? this.#addTab(path);
		if (lines !== undefined || tab.artifact === undefined) {
			tab.lines = lines;
			tab.artifact = undefined;
		}
		this.#activate(path);
		this.toggle(true);
	}

	closeTab(path: string): void {
		const at = this.#tabs.findIndex((t) => t.path === path);
		if (at === -1) return;
		this.#tabs.splice(at, 1);
		// The tab to its left takes over, as in an editor; the last one hands back to Changes.
		if (this.#active === path) this.#activate(this.#tabs[Math.max(0, at - 1)]?.path ?? CHANGES);
		else this.#renderTabs();
		this.#saveTabs();
	}

	#addTab(path: string): FileTab {
		const tab: FileTab = { path, version: "latest" };
		// After the open tab, where the eye already is.
		const at = this.#tabs.findIndex((t) => t.path === this.#active);
		this.#tabs.splice(at === -1 ? this.#tabs.length : at + 1, 0, tab);
		return tab;
	}

	#saveTabs(): void {
		if (this.#tabsKey !== "") storage.set(this.#tabsKey, JSON.stringify({ open: this.#tabs.map((t) => t.path), active: this.#active }));
	}

	#activate(id: string): void {
		const tab = this.#tabs.find((t) => t.path === id);
		this.#active = tab === undefined ? CHANGES : id;
		this.#renderTabs();
		this.#saveTabs();
		$("panel-changes").hidden = this.#active !== CHANGES;
		$("panel-file").hidden = this.#active === CHANGES;
		this.tree.select(tab?.path);
		if (tab === undefined) return;
		if (tab.artifact === undefined && !tab.missing) void this.#load(tab);
		this.#showFile(tab);
	}

	async #load(tab: FileTab): Promise<void> {
		const artifact = await this.#loadFile(tab.path, tab.lines);
		if (!this.#tabs.includes(tab)) return;
		tab.artifact = artifact;
		tab.missing = artifact === undefined;
		if (this.#active === tab.path) this.#showFile(tab);
	}

	#showFile(tab: FileTab): void {
		const view = $("panel-file");
		disposeWithin(view);
		const picker = this.#picker(tab);
		// An earlier version is for reading: no edits, and no comments on lines that may not exist any more.
		const shown = tab.version === "before" ? tab.before : tab.artifact;
		if (typeof shown === "object") {
			view.replaceChildren(artifactCard(shown, tab.version === "before" ? { size: "panel", loadImage: this.#loadImage, extra: picker } : { size: "panel", loadImage: this.#loadImage, onComment: this.#onComment, onSave: this.onSave, liveEdit: this.#liveEdit, extra: picker }));
			return;
		}
		const note =
			tab.version === "before" ? (shown ?? "Loading…") : tab.missing ? `${tab.path} isn't in the project.` : `Opening ${tab.path}…`;
		const bar = el("div", "file-note");
		bar.append(el("span", "artifact-title", tab.path), picker);
		view.replaceChildren(bar, el("p", "panel-empty", note));
	}

	/** A file edited live with everyone who has it open (text-binding.ts); afterwards the tab shows it as it is now. */
	#liveEdit = (path: string, area: HTMLTextAreaElement): (() => void) => {
		this.#session.openFile(path);
		const binding = new TextBinding(area, this.#session, fileKey(path));
		area.readOnly = this.#session.role === "viewer";
		this.editing = path;
		this.onEditing();
		return () => {
			binding.dispose();
			this.#session.closeFile(path);
			if (this.editing === path) {
				this.editing = undefined;
				this.onEditing();
			}
			const tab = this.#tabs.find((t) => t.path === path);
			if (tab !== undefined) {
				tab.artifact = undefined;
				if (this.#active === path) void this.#load(tab);
			}
		};
	};

	/** Opens a file in its editor, as someone being followed has it. */
	async editPath(path: string): Promise<void> {
		if (this.editing === path) return;
		await this.openPath(path);
		for (let i = 0; i < 40 && this.#active === path; i++) {
			const button = $("panel-file").querySelector<HTMLButtonElement>("[data-edit]:not([hidden])");
			if (button !== null) return button.click();
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/** Leaves the editor, if a file is being edited here. */
	stopEditing(): void {
		$("panel-file").querySelector<HTMLButtonElement>(".file-editor-bar .button")?.click();
	}

	/**
	 * Find's view of the open tab (find.ts): the file or change as it's shown, at the version showing, in the view
	 * showing (source, rendered Markdown, the diff), or the text being edited, unsaved edits and all. Previews and
	 * images can't be searched.
	 */
	findTarget(): FindTarget | undefined {
		const changes = this.#active === CHANGES;
		const view = changes ? $("panel-view") : $("panel-file");
		const card = view.querySelector<HTMLElement>(":scope > .artifact");
		const body = card?.querySelector<HTMLElement>(":scope > .artifact-body");
		if (card == null || body == null) return undefined;
		const tab = this.#tabs.find((t) => t.path === this.#active);
		const artifact = changes ? this.#artifacts.find((a) => a.key === this.#selected) : undefined;
		const area = body.querySelector<HTMLTextAreaElement>(":scope > textarea.file-editor") ?? undefined;
		const mode = area !== undefined ? "edit" : (card.querySelector<HTMLElement>(".artifact-tabs [aria-selected='true']")?.dataset.view ?? "view");
		const id = `${changes ? `change:${this.#selected}` : `file:${tab?.path}@${tab?.version}`}:${mode}`;
		const label = changes ? (artifact?.title ?? "Change") : `${tab?.path ?? "File"}${tab?.version === "before" ? " · before the last turn" : ""}${area !== undefined ? " · editing" : ""}`;
		const searchable = area !== undefined || body.querySelector(".pierre-host, .markdown-preview") !== null;
		let map: TextMap = { text: "", pieces: [], mapped: true };
		let revision = 0;
		const current = () => {
			const now = view.querySelector<HTMLElement>(":scope > .artifact");
			const nowArea = now?.querySelector(":scope > .artifact-body > textarea.file-editor") ?? undefined;
			const nowMode = nowArea !== undefined ? "edit" : (now?.querySelector<HTMLElement>(".artifact-tabs [aria-selected='true']")?.dataset.view ?? "view");
			return now === card && nowMode === mode && (changes ? this.#active === CHANGES : this.#active === tab?.path);
		};
		return {
			id,
			label,
			inputLabel: "Find in file",
			unavailable: searchable ? undefined : "Find isn't available for this view.",
			barBefore: view,
			scroller: body,
			textarea: area,
			blocks: () => {
				// The text area's text as it is now, saved or not; otherwise the view as drawn.
				map = area !== undefined ? { text: area.value, pieces: [], mapped: false } : readText(body);
				return [{ id: "file", revision: ++revision, text: map.text, map }];
			},
			reveal: (match) => {
				if (area === undefined) return rangeOf(map, match.start, match.end);
				// Select it (without taking focus from the Find bar) and scroll it to the middle.
				area.setSelectionRange(match.start, match.end);
				const at = caretRect(area, match.start, match.end);
				if (at !== undefined) area.scrollTop += at.top - area.getBoundingClientRect().top - area.clientHeight / 2;
				return undefined;
			},
			rects: (match) => {
				const at = area === undefined ? undefined : caretRect(area, match.start, match.end);
				return at === undefined ? [] : [at];
			},
			alive: () => current(),
			restore: () => {},
			pending: () => body.querySelector(".pierre-host") !== null && map.text === "",
		};
	}

	/** The open tab: "changes", a file's path, or null when the panel is closed. */
	get shown(): string | null {
		return document.documentElement.classList.contains("panel-open") ? this.#active : null;
	}

	/** How far down the open tab is, 0 to 1. */
	get scroll(): number {
		const box = this.#scrollBox();
		return box === null || box.scrollHeight <= box.clientHeight ? 0 : box.scrollTop / (box.scrollHeight - box.clientHeight);
	}

	set scroll(ratio: number) {
		const box = this.#scrollBox();
		if (box !== null) box.scrollTop = ratio * (box.scrollHeight - box.clientHeight);
	}

	/** What scrolls in the open tab: the file's editor or view, or the list of changes. */
	#scrollBox(): HTMLElement | null {
		if (this.#active === CHANGES) return $("panel-changes");
		const view = $("panel-file");
		return view.querySelector<HTMLElement>(".file-editor") ?? [view, ...view.querySelectorAll<HTMLElement>("*")].find((n) => n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== "visible") ?? null;
	}

	/** Delta's version picker: the file now, or as it was before the thread's last turn. */
	#picker(tab: FileTab): HTMLSelectElement {
		const select = el("select", "version-select");
		select.setAttribute("aria-label", "Version");
		select.innerHTML = '<option value="latest">Latest</option><option value="before">Before last turn</option>';
		select.value = tab.version;
		select.onchange = () => {
			tab.version = select.value === "before" ? "before" : "latest";
			if (tab.version === "before" && tab.before === undefined) void this.#loadBefore(tab);
			this.#showFile(tab);
		};
		return select;
	}

	async #loadBefore(tab: FileTab): Promise<void> {
		const res = await fetch(`api/file?path=${encodeURIComponent(tab.path)}&at=before-last-turn`, { headers: { authorization: `Bearer ${this.#session.token}` } }).catch(() => undefined);
		let before: Artifact | string;
		if (res?.ok) {
			const kind = kindOfPath(tab.path);
			before = { key: `before:${tab.path}`, kind, title: tab.path, path: tab.path, content: kind === "image" ? "" : await res.text(), lang: tab.path.split(".").pop(), source: "file" };
		} else {
			const reason = res === undefined ? "" : ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
			before = reason === "no-turn" ? "The agent hasn't taken a turn yet." : reason === "absent" ? `${tab.path} didn't exist before the last turn.` : "Couldn't load the earlier version.";
		}
		if (!this.#tabs.includes(tab)) return;
		tab.before = before;
		if (this.#active === tab.path && tab.version === "before") this.#showFile(tab);
	}

	/** A file someone (or the agent) changed reloads in its tab, unless it's being edited there. */
	#filesChanged(): void {
		this.#updateTree();
		for (const tab of this.#tabs) {
			const hash = this.#session.hashes.get(tab.path);
			if (tab.artifact === undefined || tab.artifact.hash === undefined || hash === tab.artifact.hash) continue;
			if (this.#active === tab.path && $("panel-file").querySelector(".editing") !== null) continue;
			tab.artifact = undefined;
			tab.missing = false;
			if (this.#active === tab.path) void this.#load(tab);
		}
	}

	#renderTabs(): void {
		// Files not yet seen.
		const count = this.#unseen().length;
		const html = [
			`<div role="tab" tabindex="0" class="panel-tab" data-tab="${CHANGES}" aria-selected="${this.#active === CHANGES}" title="${count} file${count === 1 ? "" : "s"} not marked seen"><span class="tab-label">Changes</span>${count > 0 ? `<span class="tab-count">${count}</span>` : ""}</div>`,
		];
		for (const tab of this.#tabs) {
			const name = tab.path.slice(tab.path.lastIndexOf("/") + 1);
			html.push(
				`<div role="tab" tabindex="0" class="panel-tab" data-tab="${escapeHtml(tab.path)}" title="${escapeHtml(tab.path)}" aria-selected="${this.#active === tab.path}"><span class="tab-label">${escapeHtml(name)}</span><button type="button" class="tab-close" tabindex="-1" aria-label="Close ${escapeHtml(name)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></div>`,
			);
		}
		const bar = $("panel-tabs");
		bar.innerHTML = html.join("");
		bar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	#browse(open: boolean): void {
		// Nothing open: the list is all there is to show.
		this.#browsing = open || this.#selected === undefined;
		$("panel-list").hidden = !this.#browsing;
		$("panel-browse").setAttribute("aria-expanded", String(this.#browsing));
	}

	select(key: string): void {
		const artifact = this.#artifacts.find((a) => a.key === key);
		if (artifact === undefined) return;
		this.#selected = key;
		this.#browse(false);
		for (const row of $("panel-list").querySelectorAll<HTMLElement>("[data-artifact]")) row.setAttribute("aria-current", String(row.dataset.artifact === key));
		const view = $("panel-view");
		disposeWithin(view);
		view.replaceChildren(artifactCard(artifact, { size: "panel", loadImage: this.#loadImage, onComment: this.#onComment, onSave: this.onSave }));
	}

	/** Renders what's showing again, e.g. after a theme change. */
	refresh(): void {
		if (this.#selected !== undefined) this.select(this.#selected);
		const tab = this.#tabs.find((t) => t.path === this.#active);
		if (tab !== undefined) this.#showFile(tab);
	}

	/** Re-reads the thread's artifacts; cheap when nothing changed. */
	update(): void {
		// A new turn moves "before the last turn": earlier versions read so far are out of date.
		const busy = this.#session.threads.main.state.busy;
		if (busy && !this.#busy) {
			for (const tab of this.#tabs) tab.before = undefined;
			const tab = this.#tabs.find((t) => t.path === this.#active && t.version === "before");
			if (tab !== undefined) void this.#loadBefore(tab);
		}
		this.#busy = busy;
		const artifacts = threadArtifacts(this.#session.threads.main.state.items);
		const signature = artifacts.map((a) => a.key).join("|");
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#artifacts = artifacts;
		$("panel-browse-count").textContent = artifacts.length === 0 ? "" : String(artifacts.length);
		this.#renderTotals();
		this.#renderList();
		this.#renderTabs();
		this.#updateTree();
		if (this.#selected !== undefined && !artifacts.some((a) => a.key === this.#selected)) {
			this.#selected = undefined;
			this.#browse(true);
		}
	}

	/** The tree marks the files the thread changed. The agent may name them by absolute path, so match on the end. */
	#updateTree(): void {
		const files = this.#session.files;
		const known = new Set(files);
		const changed = new Set<string>();
		for (const artifact of this.#artifacts) {
			const path = artifact.path;
			if (path === undefined || artifact.source === "reply") continue;
			if (known.has(path)) changed.add(path);
			else {
				const match = files.filter((f) => path.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0];
				if (match !== undefined) changed.add(match);
			}
		}
		this.tree.update(files, changed);
	}

	/** "+N −M" in the status bar: every line the thread's changes added and removed (a new file's lines are added). */
	#renderTotals(): void {
		let added = 0;
		let removed = 0;
		for (const a of this.#artifacts) {
			if (a.source === "edit") {
				const stats = patchStats(a.content);
				added += stats.added;
				removed += stats.removed;
			} else if (a.source === "write") added += a.content.split("\n").length - (a.content.endsWith("\n") ? 1 : 0);
		}
		const chip = $("diff-chip");
		chip.hidden = added === 0 && removed === 0;
		chip.innerHTML = `<span class="added">+${added}</span> <span class="removed">−${removed}</span>`;
		const files = this.#newest().size;
		chip.title = `This thread changed ${files} file${files === 1 ? "" : "s"}: ${added} lines added, ${removed} removed. Click to see the changes.`;
	}

	/** Grouped by file, newest change first; snippets from replies at the end. Files marked seen fold away. */
	#renderList(): void {
		const groups = new Map<string, Artifact[]>();
		for (const artifact of [...this.#artifacts].reverse()) {
			const group = artifact.path ?? "Snippets";
			groups.set(group, [...(groups.get(group) ?? []), artifact]);
		}
		const list = $("panel-list");
		list.replaceChildren();
		if (groups.size === 0) {
			list.append(el("p", "panel-empty", "Changes the agent makes, files it writes, and HTML or SVG it produces show up here."));
			return;
		}
		const newest = this.#newest();
		for (const [group, artifacts] of groups) {
			const seen = newest.has(group) && this.#seen[group] === newest.get(group);
			const section = el("div", `panel-group${seen ? " seen" : ""}`);
			const head = el("div", "panel-group-head");
			head.append(el("span", "panel-group-name", group));
			if (newest.has(group)) {
				const label = el("label", "seen-toggle");
				label.title = seen ? "Seen; a new change shows it again" : "Mark file as seen";
				label.innerHTML = `<input type="checkbox" data-seen="${escapeHtml(group)}"${seen ? " checked" : ""}>Seen`;
				head.append(label);
			}
			section.append(head);
			if (seen) {
				list.append(section);
				continue;
			}
			artifacts.forEach((artifact, n) => {
				const row = el("button", "panel-row");
				row.type = "button";
				row.dataset.artifact = artifact.key;
				row.setAttribute("aria-current", String(artifact.key === this.#selected));
				const stats = artifact.kind === "diff" ? patchStats(artifact.content) : undefined;
				const label = artifact.source === "reply" ? artifact.title : artifact.kind === "diff" ? "Edit" : "Written";
				row.innerHTML = `<span class="panel-row-kind kind-${artifact.kind}"></span><span class="panel-row-label">${escapeHtml(label)}${
					n === 0 && artifacts.length > 1 ? ' <span class="muted">latest</span>' : ""
				}</span>${stats ? `<span class="diff-stats"><span class="added">+${stats.added}</span> <span class="removed">−${stats.removed}</span></span>` : ""}`;
				section.append(row);
			});
			list.append(section);
		}
	}
}

/** Where text in a text area is on screen: measured on a copy laid out the same way (a text area has no ranges). */
function caretRect(area: HTMLTextAreaElement, start: number, end: number): DOMRect | undefined {
	if (!area.isConnected) return undefined;
	const style = getComputedStyle(area);
	const mirror = document.createElement("div");
	for (const prop of ["font", "lineHeight", "letterSpacing", "tabSize", "paddingLeft", "paddingRight", "paddingTop", "textIndent", "wordSpacing"] as const) mirror.style[prop] = style[prop];
	// The same width for text as the area's (inside its padding, beside any scrollbar), so lines wrap alike.
	const inner = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
	Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", boxSizing: "content-box", border: "0", width: `${inner}px`, top: "0", left: "-9999px" });
	mirror.textContent = area.value.slice(0, start);
	const mark = document.createElement("span");
	mark.textContent = area.value.slice(start, end) || "\u200b";
	mirror.append(mark);
	document.body.append(mirror);
	const box = area.getBoundingClientRect();
	const rect = new DOMRect(box.left + area.clientLeft + mark.offsetLeft - area.scrollLeft, box.top + area.clientTop + mark.offsetTop - area.scrollTop, mark.offsetWidth, mark.offsetHeight);
	mirror.remove();
	return rect;
}
