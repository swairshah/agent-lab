// When an app embeds this view (a desktop shell showing the session in a webview or an iframe), the two talk through
// this bridge. The app opens the session URL with `?embedded=1` (or serves the page with `data-embedded="true"` on
// <html>).
//
//   page → app:  { type: "syncpi", event: "activity" | "title" | "action", ... }
//                through `window.ipc.postMessage` (native webviews such as wry) or `parent.postMessage` (an iframe)
//   app → page:  { type: "syncpi-action", action: "theme" | "share" | "people" | "panel" | "setup" | "compact"
//                  | "new-context" | "branches" | "model" | "mention", data? }
//                as a window message from the parent, or by calling `window.syncpiAction(action, data)`.
//
// In a plain browser none of this is active.

declare global {
	interface Window {
		ipc?: { postMessage(message: string): void };
		syncpiAction?: (action: string, data?: unknown) => void;
	}
}

export const embedded =
	new URLSearchParams(location.search).get("embedded") === "1" ||
	document.documentElement.dataset.embedded === "true" ||
	document.documentElement.dataset.desktop === "true";

export function toHost(event: string, payload: Record<string, unknown> = {}): void {
	if (!embedded) return;
	const message = { type: "syncpi", event, ...payload };
	// A page in an iframe talks to the page around it (the app's shell), even if a native webview's IPC is present.
	if (window.parent !== window) window.parent.postMessage(message, location.origin);
	else if (window.ipc !== undefined) window.ipc.postMessage(JSON.stringify(message));
}

export function onHostAction(handler: (action: string, data: unknown) => void): void {
	if (!embedded) return;
	window.syncpiAction = handler;
	window.addEventListener("message", (event) => {
		if (event.origin !== location.origin || event.source !== window.parent) return;
		const data = event.data as { type?: string; action?: string; data?: unknown };
		if (data?.type === "syncpi-action" && typeof data.action === "string") handler(data.action, data.data);
	});
}
