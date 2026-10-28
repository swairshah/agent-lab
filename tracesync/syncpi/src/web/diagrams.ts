// Mermaid diagrams in replies (```mermaid blocks), in a viewer as in Delta: Preview and Source tabs, drag to pan,
// ⌘-scroll or pinch to zoom (plain scrolling still scrolls the thread), buttons to recenter, zoom and copy the
// source. Mermaid is large, so it loads only when a diagram first appears. It runs with securityLevel "strict":
// labels can't carry HTML or script, and its output is sanitized before it reaches the page.
import { renderCode } from "./artifacts.ts";
import { el } from "./dom.ts";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | undefined;
let configured = "";
let next = 0;

const ICONS = {
	center: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
	in: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
	out: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
	copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
};
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const MAX_HEIGHT = 520;

function token(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Loads mermaid and themes it from the CSS tokens; again when the theme changed since. */
async function mermaid(): Promise<Mermaid> {
	loading ??= import("mermaid").then((m) => m.default);
	const m = await loading;
	const theme = [token("--paper"), token("--ink"), token("--accent")].join();
	if (theme !== configured) {
		configured = theme;
		m.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: "base",
			fontFamily: token("--sans"),
			themeVariables: {
				background: token("--raised"),
				primaryColor: token("--surface"),
				primaryTextColor: token("--ink"),
				primaryBorderColor: token("--rule-strong"),
				secondaryColor: token("--sunken"),
				tertiaryColor: token("--paper"),
				lineColor: token("--muted"),
				textColor: token("--ink"),
				mainBkg: token("--surface"),
				nodeBorder: token("--rule-strong"),
				clusterBkg: token("--sunken"),
				noteBkgColor: token("--accent-soft"),
				noteTextColor: token("--ink"),
				fontSize: "14px",
			},
		});
	}
	return m;
}

/** Pan and zoom over the drawn diagram. */
class PanZoom {
	readonly #stage: HTMLElement;
	readonly #canvas: HTMLElement;
	readonly #width: number;
	readonly #height: number;
	#zoom = 1;
	#x = 0;
	#y = 0;
	/** Whether the person has panned or zoomed; until then the diagram stays fitted when the frame resizes. */
	#moved = false;

	constructor(stage: HTMLElement, canvas: HTMLElement, width: number, height: number) {
		this.#stage = stage;
		this.#canvas = canvas;
		this.#width = width;
		this.#height = height;
		let drag: { x: number; y: number; id: number } | undefined;
		stage.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			drag = { x: event.clientX - this.#x, y: event.clientY - this.#y, id: event.pointerId };
			stage.setPointerCapture(event.pointerId);
			stage.classList.add("dragging");
		});
		stage.addEventListener("pointermove", (event) => {
			if (drag?.id !== event.pointerId) return;
			this.#x = event.clientX - drag.x;
			this.#y = event.clientY - drag.y;
			this.#moved = true;
			this.#apply();
		});
		const end = () => {
			drag = undefined;
			stage.classList.remove("dragging");
		};
		stage.addEventListener("pointerup", end);
		stage.addEventListener("pointercancel", end);
		// A trackpad pinch arrives as a wheel event with ctrlKey; ⌘-scroll zooms too. Plain scrolling is the page's.
		stage.addEventListener(
			"wheel",
			(event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				const box = stage.getBoundingClientRect();
				this.zoomBy(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
			},
			{ passive: false },
		);
		// A side panel opening narrows the thread: keep the diagram in view, not centered for the old width.
		let frame = 0;
		new ResizeObserver(() => {
			if (stage.clientWidth === frame) return;
			frame = stage.clientWidth;
			if (!this.#moved) this.recenter();
		}).observe(stage);
	}

	/** Fits the whole diagram in the frame, never larger than its natural size, centered. */
	recenter(): void {
		this.#moved = false;
		const box = this.#stage.getBoundingClientRect();
		this.#zoom = Math.min(1, (box.width - 32) / this.#width, (box.height - 32) / this.#height);
		this.#x = (box.width - this.#width * this.#zoom) / 2;
		this.#y = (box.height - this.#height * this.#zoom) / 2;
		this.#apply();
	}

	/** Zooms by `factor` around a point in the frame (its center by default). */
	zoomBy(factor: number, cx?: number, cy?: number): void {
		const box = this.#stage.getBoundingClientRect();
		const px = cx ?? box.width / 2;
		const py = cy ?? box.height / 2;
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.#zoom * factor));
		this.#moved = true;
		this.#x = px - ((px - this.#x) * zoom) / this.#zoom;
		this.#y = py - ((py - this.#y) * zoom) / this.#zoom;
		this.#zoom = zoom;
		this.#apply();
	}

	#apply(): void {
		this.#canvas.style.transform = `translate(${this.#x}px, ${this.#y}px) scale(${this.#zoom})`;
	}
}

function button(name: keyof typeof ICONS, title: string): HTMLButtonElement {
	const b = el("button", "viewer-button");
	b.type = "button";
	b.title = title;
	b.setAttribute("aria-label", title);
	b.innerHTML = ICONS[name];
	return b;
}

/** Draws `source` into `host` as a viewer; a diagram that doesn't parse opens on its source with the reason. */
export function renderDiagram(host: HTMLElement, source: string): void {
	host.className = "viewer";
	const preview = el("button", "tab", "Preview");
	const code = el("button", "tab", "Source");
	const tabs = el("div", "artifact-tabs");
	tabs.append(preview, code);
	const center = button("center", "Recenter");
	const zoomIn = button("in", "Zoom in");
	const zoomOut = button("out", "Zoom out");
	const copy = button("copy", "Copy source");
	const head = el("div", "viewer-head");
	head.append(tabs, el("span", "spacer"), center, zoomIn, zoomOut, copy);
	const stage = el("div", "viewer-stage");
	const canvas = el("div", "viewer-canvas");
	stage.append(canvas);
	const sourceView = el("div", "viewer-source");
	const note = el("div", "diagram-error");
	note.hidden = true;
	host.replaceChildren(head, note, stage, sourceView);

	let panZoom: PanZoom | undefined;
	let sourceRendered = false;
	const show = (tab: "preview" | "source") => {
		preview.setAttribute("aria-selected", String(tab === "preview"));
		code.setAttribute("aria-selected", String(tab === "source"));
		stage.hidden = tab !== "preview";
		sourceView.hidden = tab !== "source";
		for (const b of [center, zoomIn, zoomOut]) b.hidden = tab !== "preview";
		if (tab === "source" && !sourceRendered) {
			sourceRendered = true;
			renderCode(sourceView, "diagram.mmd", source);
		}
	};
	preview.onclick = () => show("preview");
	code.onclick = () => show("source");
	center.onclick = () => panZoom?.recenter();
	zoomIn.onclick = () => panZoom?.zoomBy(1.25);
	zoomOut.onclick = () => panZoom?.zoomBy(0.8);
	copy.onclick = () => {
		void navigator.clipboard?.writeText(source).then(() => {
			copy.classList.add("done");
			setTimeout(() => copy.classList.remove("done"), 1200);
		});
	};
	show("preview");

	void mermaid()
		.then((m) => m.render(`diagram-${++next}`, source))
		.then(({ svg }) => {
			// Mermaid's output, sanitized by it under securityLevel "strict".
			canvas.innerHTML = svg;
			const drawing = canvas.querySelector("svg");
			const box = drawing?.viewBox.baseVal;
			const width = box?.width || 600;
			const height = box?.height || 300;
			// Inline sizes: the icons' global svg rule would otherwise win over the attributes.
			drawing?.style.setProperty("width", `${width}px`);
			drawing?.style.setProperty("height", `${height}px`);
			drawing?.style.setProperty("max-width", "none");
			stage.style.height = `${Math.min(MAX_HEIGHT, height + 48)}px`;
			panZoom = new PanZoom(stage, canvas, width, height);
			// Fit once the frame has its size.
			requestAnimationFrame(() => panZoom?.recenter());
		})
		.catch((error: unknown) => {
			note.textContent = `Couldn't draw this diagram: ${error instanceof Error ? error.message.split("\n")[0]! : String(error)}`;
			note.hidden = false;
			preview.disabled = true;
			show("source");
		});
}
