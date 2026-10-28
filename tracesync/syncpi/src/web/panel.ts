// The side panel: every artifact in the thread (changes to files, files written, HTML and SVG), and the selected one
// shown large. Opening an artifact from the thread selects it here.
import { type Artifact, patchStats, threadArtifacts } from "../shared/artifacts.ts";
import { artifactCard, type CommentHandler, disposeWithin, type ImageLoader } from "./artifacts.ts";
import { $, el, escapeHtml } from "./dom.ts";
import type { SessionClient } from "./session.ts";

export class ArtifactPanel {
	readonly #session: SessionClient;
	readonly #loadImage: ImageLoader;
	readonly #onComment: CommentHandler;
	#artifacts: Artifact[] = [];
	/** Project files opened by hand (Go to file), listed with the thread's artifacts. */
	#files: Artifact[] = [];
	#selected: string | undefined;
	/** The list of changes is showing; it folds away while one is open, so the change gets the room. */
	#browsing = true;
	#signature = "";

	constructor(session: SessionClient, loadImage: ImageLoader, onComment: CommentHandler) {
		this.#session = session;
		this.#loadImage = loadImage;
		this.#onComment = onComment;
		$("panel-list").addEventListener("click", (event) => {
			const key = (event.target as HTMLElement).closest<HTMLElement>("[data-artifact]")?.dataset.artifact;
			if (key !== undefined) this.select(key);
		});
		$("panel-close").addEventListener("click", () => this.toggle(false));
		$("panel-browse").addEventListener("click", () => this.#browse(!this.#browsing));
	}

	toggle(open?: boolean): void {
		document.documentElement.classList.toggle("panel-open", open);
	}

	/** Shows an artifact large, opening the panel. */
	open(artifact: Artifact): void {
		this.update();
		this.select(artifact.key);
		this.toggle(true);
	}

	/** Shows a project file, e.g. one picked in the palette. */
	openFile(file: Artifact): void {
		this.#files = [...this.#files.filter((f) => f.key !== file.key), file];
		this.#signature = "";
		this.open(file);
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
		view.replaceChildren(artifactCard(artifact, { size: "panel", loadImage: this.#loadImage, onComment: this.#onComment }));
	}

	/** Renders the selected artifact again, e.g. after a theme change. */
	refresh(): void {
		if (this.#selected !== undefined) this.select(this.#selected);
	}

	/** Re-reads the thread's artifacts; cheap when nothing changed. */
	update(): void {
		const artifacts = [...threadArtifacts(this.#session.threads.main.state.items), ...this.#files];
		const signature = artifacts.map((a) => a.key).join("|");
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#artifacts = artifacts;
		$("panel-count").textContent = artifacts.length === 0 ? "" : String(artifacts.length);
		$("panel-browse-count").textContent = artifacts.length === 0 ? "" : String(artifacts.length);
		$("panel-toggle").hidden = artifacts.length === 0;
		this.#renderList();
		if (this.#selected !== undefined && !artifacts.some((a) => a.key === this.#selected)) {
			this.#selected = undefined;
			this.#browse(true);
		}
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
				const label = artifact.source === "reply" ? artifact.title : artifact.source === "file" ? "Current file" : artifact.kind === "diff" ? "Edit" : "Written";
				row.innerHTML = `<span class="panel-row-kind kind-${artifact.kind}"></span><span class="panel-row-label">${escapeHtml(label)}${
					n === 0 && artifacts.length > 1 ? ' <span class="muted">latest</span>' : ""
				}</span>${stats ? `<span class="diff-stats"><span class="added">+${stats.added}</span> <span class="removed">−${stats.removed}</span></span>` : ""}`;
				section.append(row);
			});
			list.append(section);
		}
	}
}
