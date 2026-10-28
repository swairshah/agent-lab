// Showing artifacts: diffs and code through Pierre's renderers (@pierre/diffs, with Shiki highlighting), HTML and SVG
// in a sandboxed frame, markdown rendered, images loaded through the file API. Pierre is large, so it loads the first
// time something needs it.
//
// HTML from the agent is untrusted. Previews run in an iframe sandboxed without `allow-same-origin`: scripts run, but
// in an opaque origin with no access to this page, its storage, or the session's token.
import { type Artifact, patchStats } from "../shared/artifacts.ts";
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

/** Highlighted, read-only code. */
export function renderCode(host: HTMLElement, name: string, contents: string): void {
	host.classList.add("pierre-host");
	void loadPierre().then(({ File }) => {
		const view = new File({ theme: THEME, themeType: themeType(), overflow: "wrap", disableFileHeader: true });
		view.render({ file: { name, contents }, containerWrapper: host });
		instances.set(host, view);
	});
}

/** A unified diff from a patch. */
export function renderDiff(host: HTMLElement, patch: string): void {
	host.classList.add("pierre-host");
	void loadPierre().then(({ FileDiff, getSingularPatch }) => {
		const view = new FileDiff({ theme: THEME, themeType: themeType(), diffStyle: "unified", overflow: "wrap", disableFileHeader: true });
		view.render({ fileDiff: getSingularPatch(patch), containerWrapper: host });
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

function renderView(host: HTMLElement, artifact: Artifact, view: "preview" | "code" | "diff", loadImage: ImageLoader): void {
	disposeWithin(host);
	host.replaceChildren();
	if (view === "diff") return renderDiff(host, artifact.content);
	if (view === "code") return renderCode(host, artifact.path ?? `snippet.${artifact.lang || artifact.kind}`, artifact.content);
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
	const tabBar = el("div", "artifact-tabs");
	tabBar.setAttribute("role", "tablist");
	const body = el("div", "artifact-body");
	const select = (view: (typeof tabs)[number]) => {
		for (const button of tabBar.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-selected", String(button.dataset.view === view));
		renderView(body, artifact, view, options.loadImage);
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
			select(tabs[0]!);
		},
		{ rootMargin: "400px" },
	);
	observer.observe(card);
	return card;
}
