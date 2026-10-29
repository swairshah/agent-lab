// Runs inside an HTML or SVG preview's sandboxed frame (artifacts.ts adds it to the preview): when the page asks, it
// draws what the frame shows as a picture, so comments on the preview can be sent with it (annotate.ts). The frame is
// an opaque origin the page can't read, so the picture comes back by postMessage; the page checks that it came from
// this frame. Built on its own, as a classic script (build.mjs).
import { domToCanvas } from "modern-screenshot";

addEventListener("message", (event) => {
	const data = event.data as { syncpi?: string; id?: string } | null;
	if (data?.syncpi !== "capture" || event.source !== parent) return;
	void capture().then(
		(url) => parent.postMessage({ syncpi: "captured", id: data.id, url }, "*"),
		(error: unknown) => parent.postMessage({ syncpi: "captured", id: data.id, error: String(error) }, "*"),
	);
});

/** What the frame shows now: its viewport, scrolled as it is. */
async function capture(): Promise<string> {
	// modern-screenshot reads default styles from a frame of its own, to leave them out of the picture's styles. In
	// this sandboxed frame, that frame is another opaque origin it can't read, so while drawing it gets no window, and
	// does without (every style is kept, which only makes the picture's source larger).
	const contentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!;
	Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
		configurable: true,
		get(this: HTMLIFrameElement) {
			return this.id.startsWith("__SANDBOX__") ? null : contentWindow.get!.call(this);
		},
	});
	try {
		return await draw();
	} finally {
		Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", contentWindow);
	}
}

async function draw(): Promise<string> {
	const root = document.documentElement;
	const background = [getComputedStyle(document.body ?? root).backgroundColor, getComputedStyle(root).backgroundColor].find((c) => c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") ?? "#ffffff";
	const canvas = await domToCanvas(root, {
		width: innerWidth,
		height: innerHeight,
		scale: Math.min(2, devicePixelRatio || 1),
		backgroundColor: background,
		style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
	});
	return canvas.toDataURL("image/png");
}
