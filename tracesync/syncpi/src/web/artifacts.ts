// Showing artifacts: diffs and code through Pierre's renderers (@pierre/diffs, with Shiki highlighting), HTML and SVG
// in a sandboxed frame, markdown rendered, images loaded through the file API. Pierre is large, so it loads the first
// time something needs it.
//
// HTML from the agent is untrusted. Previews run in an iframe sandboxed without `allow-same-origin`: scripts run, but
// in an opaque origin with no access to this page, its storage, or the session's token.
import { type Artifact, patchStats } from "../shared/artifacts.ts";
import type { LineComment } from "../shared/protocol.ts";
import { el, escapeHtml } from "./dom.ts";
import { renderMarkdown } from "./markdown.ts";

type Pierre = typeof import("@pierre/diffs");
let pierre: Promise<Pierre> | undefined;
const loadPierre = () => (pierre ??= import("@pierre/diffs"));

/** Things rendered by Pierre, so they can be released when their element goes away. */
const instances = new WeakMap<Element, { cleanUp(): void }>();

function themeType(): "light" | "dark" | "system" {
	const set = document.documentElement.dataset.theme;
	return set === "light" || set === "dark" ? set : "system";
}

const THEME = { light: "pierre-light", dark: "pierre-dark" } as const;

/** Sends a comment on lines of a file to the thread. */
export type CommentHandler = (comment: LineComment) => void;

type Range = { start: number; end: number; side?: "additions" | "deletions" };

/** The view whose lines were selected last, so ⌥⌘M can comment on them. */
let active: (() => void) | undefined;
/** Drops the selection and comment box that are open, so Esc works wherever focus is. */
let dropOpen: (() => void) | undefined;
addEventListener(
	"keydown",
	(event) => {
		if (event.key !== "Escape" || dropOpen === undefined || document.querySelector("dialog[open]")) return;
		event.preventDefault();
		event.stopPropagation();
		dropOpen();
	},
	true,
);

/** Opens the comment box on the lines selected last. Returns whether there were any. */
export function commentOnSelection(): boolean {
	active?.();
	return active !== undefined;
}

/**
 * Line comments on a Pierre view, as in Delta and the desktop app: selecting lines (click or drag the line numbers,
 * shift-click to extend) shows a small Comment button under the selection; it opens a box right under the lines,
 * where ⌘↩ sends the comment and Esc drops it. `excerpt` gives the text of the selected lines.
 */
function lineComments(path: string, onComment: CommentHandler, excerpt: (range: Range) => string, draw: (annotations: { lineNumber: number; side?: Range["side"]; metadata: { range: Range; box: boolean } }[]) => void, clear: () => void) {
	let selection: Range | undefined;
	let box = false;
	const redraw = () => draw(selection ? [{ lineNumber: selection.end, side: selection.side, metadata: { range: selection, box } }] : []);
	const open = () => {
		if (selection === undefined) return;
		box = true;
		redraw();
	};
	const drop = () => {
		selection = undefined;
		box = false;
		if (active === open) active = undefined;
		if (dropOpen === drop) dropOpen = undefined;
		redraw();
		clear();
	};
	const label = (r: Range) => `${r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`}${r.side === "deletions" ? " (removed)" : ""}`;
	return {
		onLineSelectionEnd(range: (Range & { endSide?: Range["side"] }) | null) {
			if (range === null) return drop();
			selection = { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), side: range.endSide ?? range.side };
			box = false;
			active = open;
			dropOpen = drop;
			redraw();
		},
		renderAnnotation(annotation: { metadata?: { range: Range; box: boolean } }): HTMLElement | undefined {
			const meta = annotation.metadata;
			if (meta === undefined) return undefined;
			if (!meta.box) {
				const pill = el("button", "comment-pill");
				pill.type = "button";
				pill.title = "Comment on these lines (⌥⌘M)";
				pill.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Comment`;
				pill.onclick = open;
				const row = el("div", "comment-pill-row");
				row.append(pill);
				return row;
			}
			const form = el("div", "line-comment");
			const input = el("textarea");
			input.rows = 2;
			input.placeholder = `Comment on ${label(meta.range)}`;
			const send = () => {
				const text = input.value.trim();
				if (!text) return;
				const prefix = meta.range.side === "deletions" ? "(on removed lines) " : "";
				onComment({ path, start: meta.range.start, end: meta.range.end, excerpt: excerpt(meta.range), text: prefix + text });
				drop();
			};
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					send();
				}
			});
			const actions = el("div", "line-comment-actions");
			actions.append(el("span", "muted", "⌘↩ to send, Esc to cancel"));
			const cancel = el("button", "text-button", "Cancel");
			cancel.type = "button";
			cancel.onclick = drop;
			const ok = el("button", "button primary", "Comment");
			ok.type = "button";
			ok.onclick = send;
			actions.append(cancel, ok);
			form.append(input, actions);
			requestAnimationFrame(() => input.focus());
			return form;
		},
	};
}

/** The text of each old and new line a patch shows, by line number. */
function patchLines(patch: string): { additions: Map<number, string>; deletions: Map<number, string> } {
	const additions = new Map<number, string>();
	const deletions = new Map<number, string>();
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split("\n")) {
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
		} else if (line.startsWith("+") && !line.startsWith("+++")) additions.set(newLine++, line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("---")) deletions.set(oldLine++, line.slice(1));
		else if (line.startsWith(" ")) {
			additions.set(newLine++, line.slice(1));
			deletions.set(oldLine++, line.slice(1));
		}
	}
	return { additions, deletions };
}

/** Highlighted, read-only code. With `onComment`, lines can be commented on (see lineComments). */
export function renderCode(host: HTMLElement, name: string, contents: string, onComment?: CommentHandler, lines?: string): void {
	host.classList.add("pierre-host");
	void loadPierre().then(({ File }) => {
		const file = { name, contents };
		let annotations: { lineNumber: number; metadata: { range: Range; box: boolean } }[] = [];
		const comments = onComment
			? lineComments(
					name,
					onComment,
					(r) => contents.split("\n").slice(r.start - 1, r.end).join("\n"),
					(next) => {
						annotations = next;
						view.render({ file, lineAnnotations: annotations, containerWrapper: host });
					},
					() => view.setSelectedLines(null),
				)
			: undefined;
		const view = new File<{ range: Range; box: boolean }>({
			theme: THEME,
			themeType: themeType(),
			overflow: "wrap",
			disableFileHeader: true,
			...(comments ? { enableLineSelection: true, onLineSelectionEnd: comments.onLineSelectionEnd, renderAnnotation: comments.renderAnnotation } : {}),
		});
		view.render({ file, lineAnnotations: annotations, containerWrapper: host });
		// Opened from a citation: show those lines selected, in view.
		const [start, end] = (lines ?? "").split("-").map(Number);
		if (start) {
			view.setSelectedLines({ start, end: end || start });
			requestAnimationFrame(() => host.querySelector("diffs-container")?.shadowRoot?.querySelector(`[data-column-number="${start}"]`)?.scrollIntoView({ block: "center" }));
		}
		instances.set(host, view);
	});
}

/** A unified diff from a patch. With `path` and `onComment`, its lines can be commented on too. */
export function renderDiff(host: HTMLElement, patch: string, path?: string, onComment?: CommentHandler): void {
	host.classList.add("pierre-host");
	void loadPierre().then(({ FileDiff, getSingularPatch }) => {
		const fileDiff = getSingularPatch(patch);
		const text = patchLines(patch);
		let annotations: { side: Range["side"] & string; lineNumber: number; metadata: { range: Range; box: boolean } }[] = [];
		const comments =
			onComment && path
				? lineComments(
						path,
						onComment,
						(r) => {
							const side = text[r.side ?? "additions"];
							const out: string[] = [];
							for (let n = r.start; n <= r.end; n++) if (side.has(n)) out.push(side.get(n)!);
							return out.join("\n");
						},
						(next) => {
							annotations = next.map((a) => ({ ...a, side: a.side ?? "additions" }));
							view.render({ fileDiff, lineAnnotations: annotations, containerWrapper: host });
						},
						() => view.setSelectedLines(null),
					)
				: undefined;
		const view = new FileDiff<{ range: Range; box: boolean }>({
			theme: THEME,
			themeType: themeType(),
			diffStyle: "unified",
			overflow: "wrap",
			disableFileHeader: true,
			...(comments ? { enableLineSelection: true, onLineSelectionEnd: comments.onLineSelectionEnd, renderAnnotation: comments.renderAnnotation } : {}),
		});
		view.render({ fileDiff, lineAnnotations: annotations, containerWrapper: host });
		instances.set(host, view);
	});
}

/** Releases Pierre renderers inside an element that is being removed. */
export function disposeWithin(root: Element): void {
	for (const host of root.querySelectorAll(".pierre-host")) {
		instances.get(host)?.cleanUp();
		instances.delete(host);
	}
}

function previewDocument(artifact: Artifact): string {
	if (artifact.kind === "svg") {
		// An SVG with only a viewBox would fill the frame; keep it at a readable size, centered.
		return `<!doctype html><html><head><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;padding:16px;box-sizing:border-box}svg{max-width:min(100%,520px);max-height:calc(100vh - 32px);height:auto}</style></head><body>${artifact.content}</body></html>`;
	}
	return artifact.content;
}

/** A sandboxed live preview of HTML or SVG. */
export function renderPreview(host: HTMLElement, artifact: Artifact): void {
	const frame = el("iframe", "preview-frame");
	frame.setAttribute("sandbox", "allow-scripts allow-popups allow-forms");
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.title = `Preview of ${artifact.title}`;
	frame.srcdoc = previewDocument(artifact);
	host.replaceChildren(frame);
}

export type ImageLoader = (path: string) => Promise<string | undefined>;

const KIND_LABEL: Record<Artifact["kind"], string> = { diff: "Diff", html: "HTML", svg: "SVG", markdown: "Markdown", code: "Code", image: "Image" };

/** The tabs an artifact offers, first one shown by default. */
function views(artifact: Artifact): ("preview" | "code" | "diff")[] {
	switch (artifact.kind) {
		case "diff":
			return ["diff"];
		case "html":
		case "svg":
		case "markdown":
			return ["preview", "code"];
		case "image":
			return ["preview"];
		default:
			return ["code"];
	}
}

function renderView(host: HTMLElement, artifact: Artifact, view: "preview" | "code" | "diff", loadImage: ImageLoader, onComment?: CommentHandler): void {
	disposeWithin(host);
	host.replaceChildren();
	// Any view of a project file can be commented on: the file, a file the agent wrote, or the lines of an edit.
	const commentable = artifact.path !== undefined ? onComment : undefined;
	if (view === "diff") return renderDiff(host, artifact.content, artifact.path, commentable);
	if (view === "code") return renderCode(host, artifact.path ?? `snippet.${artifact.lang || artifact.kind}`, artifact.content, commentable, artifact.lines);
	if (artifact.kind === "markdown") {
		host.innerHTML = `<div class="markdown-preview prose">${renderMarkdown(artifact.content)}</div>`;
		return;
	}
	if (artifact.kind === "image") {
		if (artifact.path === undefined) return;
		void loadImage(artifact.path).then((src) => {
			if (src === undefined) host.textContent = "This image isn't available.";
			else host.replaceChildren(Object.assign(el("img", "artifact-image"), { src, alt: artifact.title }));
		});
		return;
	}
	renderPreview(host, artifact);
}

export type CardOptions = {
	/** "inline" sits in the thread, "panel" fills the side panel. */
	size: "inline" | "panel";
	onOpen?: (artifact: Artifact) => void;
	loadImage: ImageLoader;
	/** Lets lines of a project file be commented on. */
	onComment?: CommentHandler;
	/** Saves an edited project file; resolves to its new hash, or undefined when it couldn't be saved. */
	onSave?: (path: string, text: string, base: string) => Promise<string | undefined>;
};

/** A card for one artifact: a header with its name and kind, tabs where it has several views, and the view. */
export function artifactCard(artifact: Artifact, options: CardOptions): HTMLElement {
	const card = el("section", `artifact artifact-${artifact.kind} artifact-${options.size}`);
	const tabs = views(artifact);
	const stats = artifact.kind === "diff" ? patchStats(artifact.content) : undefined;
	const head = el("header", "artifact-head");
	head.innerHTML = `<span class="artifact-kind">${KIND_LABEL[artifact.kind]}</span><span class="artifact-title" title="${escapeHtml(artifact.title)}">${escapeHtml(artifact.title)}</span>${
		stats ? `<span class="diff-stats"><span class="added">+${stats.added}</span> <span class="removed">−${stats.removed}</span></span>` : ""
	}`;
	// Where comments are possible, say how, as long as there's room for it.
	if (options.onComment !== undefined && artifact.path !== undefined && artifact.kind !== "image") {
		head.append(el("span", "artifact-hint", "Select line numbers to comment"));
	}
	const tabBar = el("div", "artifact-tabs");
	// A project file can be edited and saved, as on the desktop. The save is refused if the file changed meanwhile.
	if (options.onSave !== undefined && artifact.source === "file" && artifact.path !== undefined && artifact.kind !== "image") {
		const editButton = el("button", "artifact-open", "Edit");
		editButton.type = "button";
		editButton.onclick = () => {
			const area = el("textarea", "file-editor");
			area.value = artifact.content;
			area.spellcheck = false;
			const save = el("button", "button primary", "Save");
			save.type = "button";
			const cancel = el("button", "text-button", "Cancel");
			cancel.type = "button";
			const bar = el("div", "file-editor-bar");
			bar.append(el("span", "muted", "⌘S to save, Esc to cancel"), cancel, save);
			const done = () => {
				body.classList.remove("editing");
				editButton.hidden = false;
				select(tabs.includes("code") ? "code" : tabs[0]!);
			};
			const doSave = async () => {
				save.disabled = true;
				const hash = await options.onSave!(artifact.path!, area.value, artifact.hash ?? "none");
				save.disabled = false;
				if (hash === undefined) return;
				artifact.content = area.value;
				artifact.hash = hash;
				done();
			};
			save.onclick = () => void doSave();
			cancel.onclick = done;
			area.addEventListener("keydown", (event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "s") {
					event.preventDefault();
					void doSave();
				} else if (event.key === "Escape") {
					event.preventDefault();
					done();
				} else if (event.key === "Tab") {
					// A tab in the file, not a jump to the next button.
					event.preventDefault();
					area.setRangeText("\t", area.selectionStart, area.selectionEnd, "end");
				}
			});
			disposeWithin(body);
			body.classList.add("editing");
			body.replaceChildren(area, bar);
			editButton.hidden = true;
			area.focus();
		};
		head.append(editButton);
	}
	tabBar.setAttribute("role", "tablist");
	const body = el("div", "artifact-body");
	const select = (view: (typeof tabs)[number]) => {
		for (const button of tabBar.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-selected", String(button.dataset.view === view));
		renderView(body, artifact, view, options.loadImage, options.onComment);
	};
	if (tabs.length > 1) {
		for (const view of tabs) {
			const button = el("button", "tab", view === "preview" ? "Preview" : view === "code" ? "Code" : "Diff");
			button.type = "button";
			button.dataset.view = view;
			button.setAttribute("role", "tab");
			button.onclick = () => select(view);
			tabBar.append(button);
		}
		head.append(tabBar);
	}
	if (options.onOpen !== undefined) {
		const open = el("button", "artifact-open", "Open");
		open.type = "button";
		open.title = "Open in the side panel";
		open.onclick = () => options.onOpen!(artifact);
		head.append(open);
	}
	card.append(head, body);
	// Rendering waits until the card is near the screen: long threads can hold many artifacts.
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			observer.disconnect();
			select(artifact.lines !== undefined && tabs.includes("code") ? "code" : tabs[0]!);
		},
		{ rootMargin: "400px" },
	);
	observer.observe(card);
	return card;
}
