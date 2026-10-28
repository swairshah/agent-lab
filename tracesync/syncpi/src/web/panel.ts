// The side panel, laid out as Delta's: tabs along the top (Changes, then one per open project file), the open tab
// below them, and the project tree beside it (⇧⌘E). The Changes tab lists every artifact in the thread (changes to
// files, files written, HTML and SVG) and shows the selected one large; opening an artifact from the thread selects
// it there. A file tab shows the file as it is now, rendered when it's Markdown, and follows changes to it.
import { type Artifact, patchStats, threadArtifacts } from "../shared/artifacts.ts";
import { artifactCard, type CommentHandler, disposeWithin, type ImageLoader } from "./artifacts.ts";
import { $, el, escapeHtml, storage } from "./dom.ts";
import { FilesTree } from "./files-tree.ts";
import type { SessionClient } from "./session.ts";

/** Reads a project file as an artifact, or says why it couldn't. */
export type FileLoader = (path: string, lines?: string) => Promise<Artifact | undefined>;

type FileTab = { path: string; artifact?: Artifact; lines?: string; missing?: boolean };

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
	#artifacts: Artifact[] = [];
	#selected: string | undefined;
	/** The list of changes is showing; it folds away while one is open, so the change gets the room. */
	#browsing = true;
	#signature = "";
	#tabs: FileTab[] = [];
	/** CHANGES, or the path of the open file tab. */
	#active = CHANGES;
	#tabsKey = "";

	constructor(session: SessionClient, loadImage: ImageLoader, onComment: CommentHandler, loadFile: FileLoader) {
		this.#session = session;
		this.#loadImage = loadImage;
		this.#onComment = onComment;
		this.#loadFile = loadFile;
		$("panel-list").addEventListener("click", (event) => {
			const key = (event.target as HTMLElement).closest<HTMLElement>("[data-artifact]")?.dataset.artifact;
			if (key !== undefined) this.select(key);
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
		if (this.#tabsKey === `syncpi-tabs:${id}`) return;
		this.#tabsKey = `syncpi-tabs:${id}`;
		try {
			const saved = JSON.parse(storage.get(this.#tabsKey) ?? "{}") as { open?: string[]; active?: string };
			this.#tabs = (saved.open ?? []).map((path) => ({ path }));
			this.#active = saved.active !== undefined && this.#tabs.some((t) => t.path === saved.active) ? saved.active : CHANGES;
		} catch {}
		this.#renderTabs();
		if (this.#active !== CHANGES) this.#activate(this.#active);
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
		const tab: FileTab = { path };
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
		if (tab.artifact === undefined) {
			view.replaceChildren(el("p", "panel-empty", tab.missing ? `${tab.path} isn't in the project.` : `Opening ${tab.path}…`));
			return;
		}
		view.replaceChildren(artifactCard(tab.artifact, { size: "panel", loadImage: this.#loadImage, onComment: this.#onComment, onSave: this.onSave }));
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
		const count = this.#artifacts.length;
		const html = [
			`<div role="tab" tabindex="0" class="panel-tab" data-tab="${CHANGES}" aria-selected="${this.#active === CHANGES}"><span class="tab-label">Changes</span>${count > 0 ? `<span class="tab-count">${count}</span>` : ""}</div>`,
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
		const artifacts = threadArtifacts(this.#session.threads.main.state.items);
		const signature = artifacts.map((a) => a.key).join("|");
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#artifacts = artifacts;
		$("panel-count").textContent = artifacts.length === 0 ? "" : String(artifacts.length);
		$("panel-browse-count").textContent = artifacts.length === 0 ? "" : String(artifacts.length);
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

	/** Grouped by file, newest change first; snippets from replies at the end. */
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
		for (const [group, artifacts] of groups) {
			const section = el("div", "panel-group");
			section.append(el("div", "panel-group-name", group));
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
