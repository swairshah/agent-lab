// What the app's shell (shell.ts) offers the thread pages it shows, and what both share: the commands the shell owns
// and the text size. A thread's page reaches the shell as `parent.syncpiShell` (same origin).
import { storage } from "./dom.ts";

/** Commands that span threads or reach the system; the shell carries them out wherever they're pressed. */
export const SHELL_COMMANDS = [
	"palette.threads",
	"inbox.toggle",
	"thread.new",
	"project.add",
	"thread.join",
	"thread.next",
	"thread.previous",
	"thread.rename",
	"thread.title",
	"thread.pin",
	"thread.archive",
	"thread.bookmark",
	"thread.tags",
	"thread.archives",
	"view.sidebar",
	"app.zoomIn",
	"app.zoomOut",
	"app.zoomReset",
	"app.quit",
	"project.sync",
	"project.reveal",
	"project.zed",
	"project.web",
	"project.preview",
	"project.update",
] as const;

export type ShellThread = {
	id: string;
	dir: string;
	role: string;
	vm?: string;
	sync?: { pushed: number; pulled: number; conflicts: string[]; error: string };
};

export interface Shell {
	command(id: string): boolean;
	threads(): { id: string; title: string; project: string; current: boolean }[];
	open(id: string): void;
	session(id: string): ShellThread | undefined;
	activity(id: string, busy: boolean): void;
	titled(id: string, title: string): void;
	openUrl(url: string): void;
	toast(text: string, tone?: "info" | "error"): void;
}

/** The shell, when this page is a thread shown in the app. */
export function shell(): Shell | undefined {
	try {
		return window.parent !== window ? (window.parent as Window & { syncpiShell?: Shell }).syncpiShell : undefined;
	} catch {
		return undefined;
	}
}

/** Drags the app's window from a bar of this page (a press on its empty part); a double click zooms the window. */
export function dragWindow(bar: HTMLElement): void {
	const top = window.top as (Window & { __TAURI__?: { window?: { getCurrentWindow(): { startDragging(): Promise<void>; toggleMaximize(): Promise<void> } } } }) | null;
	const win = top?.__TAURI__?.window?.getCurrentWindow();
	if (win === undefined) return;
	const empty = (event: MouseEvent) => event.button === 0 && !(event.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable='true'], .presence");
	bar.addEventListener("mousedown", (event) => {
		if (empty(event) && event.detail === 1) void win.startDragging();
	});
	bar.addEventListener("dblclick", (event) => {
		if (empty(event)) void win.toggleMaximize();
	});
}

const ZOOM = "syncpi-zoom";

type Webview = { setZoom(scale: number): Promise<void> };

/** The app's webview, which zooms natively; undefined in a browser. */
function webview(): Webview | undefined {
	try {
		return (window.top as (Window & { __TAURI__?: { webview?: { getCurrentWebview(): Webview } } }) | null)?.__TAURI__?.webview?.getCurrentWebview();
	} catch {
		return undefined;
	}
}

/**
 * Text size, 80% to 150%, kept for the app and every thread's page. The app zooms its webview, as a browser's ⌘+
 * does: CSS `zoom` in WebKit makes a page inside a frame larger than the frame, so jumping to a message scrolled the
 * whole page and cut off its top bar, left edge and composer. A browser (no webview) uses CSS `zoom`.
 */
export function applyZoom(doc: Document): void {
	const stored = Number(storage.get(ZOOM) ?? "1");
	const zoom = Number.isFinite(stored) && stored > 0 ? stored : 1;
	const native = webview();
	if (native === undefined) return doc.documentElement.style.setProperty("zoom", String(zoom));
	doc.documentElement.style.removeProperty("zoom");
	if (doc === window.top?.document) void native.setZoom(zoom).catch(() => {});
}

/** Changes the text size by `by` (0 resets it), here and in every thread's page. */
export function zoomBy(by: number): void {
	const now = Number(storage.get(ZOOM) ?? "1") || 1;
	const next = by === 0 ? 1 : Math.round(Math.min(1.5, Math.max(0.8, now + by)) * 10) / 10;
	storage.set(ZOOM, String(next));
	const top = window.top ?? window;
	applyZoom(top.document);
	for (const frame of top.document.querySelectorAll("iframe")) {
		try {
			if (frame.contentDocument) applyZoom(frame.contentDocument);
		} catch {}
	}
}
