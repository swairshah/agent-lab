// Comments on part of a graphic: an image, an HTML or SVG preview, a Mermaid diagram, a screenshot from the VM.
//
// The Comment button on a graphic turns on comment mode: click to mark a point, or drag to mark an area, and write the
// comment in the box that opens there (Enter adds it, Esc drops it; a second Esc leaves comment mode). Comments
// aren't sent one by one: they wait on the graphic, numbered, with a bar under it to Send them all. Everyone in the
// session sees them as they're made, and as they're written. Send (anyone's, or ⌘↩ in a box) puts them in the
// thread as one message, with a picture of the graphic marked with them, and takes them off the graphic for everyone.
//
// A mark is a point or an area in fractions of the graphic's box (protocol.ts Mark), so it lands on the same spot on
// every screen, and moves with a diagram as it's panned and zoomed. The server keeps them until they're sent; in
// memory, like drafts.
import { type Attachment, type Mark, PRIVATE_MARKS, type SharedMark } from "../shared/protocol.ts";
import { el, escapeHtml, personColor } from "./dom.ts";
import type { SessionClient } from "./session.ts";

const ICON = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export type Graphic = {
	/** The graphic's key, the same on every screen (a file's path, a tool call, a reply's block). */
	key: string;
	/** What it is, for the message ("the image logo.png"). */
	title: string;
	/** The box marks are placed in, as fractions of it; it holds the layer of marks. */
	surface: HTMLElement;
	/** Where the Comment button sits (its top right corner), and what the send bar follows. Defaults to `surface`. */
	frame?: HTMLElement;
	/** The graphic as pixels, exactly the surface's box (at any resolution). */
	capture(): Promise<HTMLCanvasElement>;
};

export type AnnotationOptions = {
	/** Sends the comments: the message's text, and the marked picture when it could be made. */
	send(text: string, image: Attachment | undefined, key: string): void;
	/** The key's prefix for a graphic shown in this person's side thread (private), or "". */
	scope(surface: HTMLElement): string;
	toast(text: string, tone?: "info" | "error"): void;
};

/**
 * The comment being written here: on which graphic, its mark (kept here, as the server may not have sent it back yet),
 * and its box. `shared`: the server has sent it back, so if it goes from the graphic, someone sent or removed it.
 */
type Editing = { graphic: Attached; mark: Mark; shared: boolean; box: HTMLElement; area: HTMLTextAreaElement; timer?: ReturnType<typeof setTimeout> };

type Attached = Graphic & { frame: HTMLElement; shared: string; layer: HTMLElement; toggle: HTMLButtonElement; bar: HTMLElement; on: boolean };

let current: Annotations | undefined;

/** Makes a graphic commentable, when the page has comments (the web view and the app do). */
export function annotatable(graphic: Graphic): void {
	current?.attach(graphic);
}

export class Annotations {
	readonly #session: SessionClient;
	readonly #options: AnnotationOptions;
	readonly #graphics = new Set<Attached>();
	/** Graphics in comment mode, by key: a graphic drawn again (its reply finished, its card was redrawn) stays in it. */
	readonly #commenting = new Set<string>();
	#editing: Editing | undefined;

	constructor(session: SessionClient, options: AnnotationOptions) {
		this.#session = session;
		this.#options = options;
		current = this;
		session.on("marks", () => this.#renderAll());
		session.on("people", () => this.#renderAll());
		addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
				if (this.#editing !== undefined) {
					event.preventDefault();
					event.stopPropagation();
					this.#close(false);
					return;
				}
				const on = [...this.#graphics].find((g) => g.on && g.frame.isConnected);
				if (on === undefined) return;
				event.preventDefault();
				event.stopPropagation();
				this.#mode(on, false);
			},
			true,
		);
		// The open box follows its mark as the thread scrolls or a diagram moves.
		addEventListener("scroll", () => this.#place(), true);
		addEventListener("resize", () => this.#place());
	}

	get #mayComment(): boolean {
		return this.#session.role === "editor" || this.#session.role === "admin";
	}

	attach(graphic: Graphic): void {
		const frame = graphic.frame ?? graphic.surface;
		frame.classList.add("graphic-frame");
		graphic.surface.classList.add("graphic-surface");
		graphic.surface.querySelector(":scope > .marks-layer")?.remove();
		const layer = el("div", "marks-layer");
		graphic.surface.append(layer);
		const toggle = el("button", "mark-toggle");
		toggle.type = "button";
		toggle.innerHTML = `${ICON}<span>Comment</span>`;
		toggle.title = "Comment on part of this: click a point or drag an area";
		toggle.setAttribute("aria-pressed", "false");
		toggle.contentEditable = "false";
		frame.querySelector(":scope > .mark-toggle")?.remove();
		frame.append(toggle);
		const bar = el("div", "marks-bar");
		bar.contentEditable = "false";
		const g: Attached = { ...graphic, frame, shared: "", layer, toggle, bar, on: false };
		g.shared = this.#options.scope(graphic.surface) + graphic.key;
		toggle.onclick = (event) => {
			event.stopPropagation();
			this.#mode(g, !g.on);
		};
		// A diagram's stage takes the pointer to pan on pointerdown; the button keeps it.
		toggle.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.#drawing(g);
		for (const old of this.#graphics) if (!old.frame.isConnected) this.#graphics.delete(old);
		this.#graphics.add(g);
		if (this.#commenting.has(g.shared)) this.#mode(g, true);
		// The comment being written was on this graphic as it was drawn before: it follows.
		if (this.#editing !== undefined && this.#editing.graphic.shared === g.shared && !this.#editing.graphic.frame.isConnected) this.#editing.graphic = g;
		this.#render(g);
		this.#place();
	}

	/** Turns comment mode on or off for a graphic. */
	#mode(g: Attached, on: boolean): void {
		if (on && !this.#mayComment) return this.#options.toast("Viewers can't comment; ask an admin to make you an editor.", "error");
		if (!on && this.#editing?.graphic === g) this.#close(false);
		g.on = on;
		if (on) this.#commenting.add(g.shared);
		else this.#commenting.delete(g.shared);
		g.frame.classList.toggle("commenting", on);
		g.toggle.setAttribute("aria-pressed", String(on));
	}

	/** Click for a point, drag for an area, while comment mode is on. */
	#drawing(g: Attached): void {
		let start: { x: number; y: number; id: number } | undefined;
		let box: HTMLElement | undefined;
		const at = (event: PointerEvent) => {
			const r = g.surface.getBoundingClientRect();
			return { x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height) };
		};
		g.layer.addEventListener("pointerdown", (event) => {
			if (!g.on || event.button !== 0 || (event.target as HTMLElement).closest(".mark")) return;
			// A diagram would pan, a link would open: the mark comes first.
			event.preventDefault();
			event.stopPropagation();
			if (this.#editing !== undefined) this.#close(true);
			start = { ...at(event), id: event.pointerId };
			g.layer.setPointerCapture(event.pointerId);
		});
		g.layer.addEventListener("pointermove", (event) => {
			if (start?.id !== event.pointerId) return;
			const p = at(event);
			box ??= g.layer.appendChild(el("div", "mark-drag"));
			Object.assign(box.style, rect(Math.min(start.x, p.x), Math.min(start.y, p.y), Math.abs(p.x - start.x), Math.abs(p.y - start.y)));
		});
		const end = (event: PointerEvent) => {
			if (start?.id !== event.pointerId) return;
			const p = at(event);
			const r = g.surface.getBoundingClientRect();
			// A few pixels of movement is still a click.
			const dragged = Math.abs(p.x - start.x) * r.width > 6 || Math.abs(p.y - start.y) * r.height > 6;
			const mark: Mark = dragged
				? { id: crypto.randomUUID(), x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y), text: "" }
				: { id: crypto.randomUUID(), x: start.x, y: start.y, text: "" };
			start = undefined;
			box?.remove();
			box = undefined;
			if (event.type === "pointercancel") return;
			this.#session.send({ type: "mark", key: g.shared, mark });
			this.#open(g, mark);
		};
		g.layer.addEventListener("pointerup", end);
		g.layer.addEventListener("pointercancel", end);
		// Nor does focus move: the thread has a text cursor, which would take it from the comment box.
		g.layer.addEventListener("mousedown", (event) => {
			if (g.on) event.preventDefault();
		});
		// Clicks in comment mode don't reach the graphic (a screenshot's link, a diagram's stage).
		g.layer.addEventListener("click", (event) => {
			if (g.on) event.preventDefault();
			event.stopPropagation();
		});
	}

	#marks(g: Attached): SharedMark[] {
		return this.#session.marks.get(g.shared) ?? [];
	}

	#renderAll(): void {
		for (const g of this.#graphics) {
			if (!g.frame.isConnected) this.#graphics.delete(g);
			else this.#render(g);
		}
		// A mark being written that someone sent or removed meanwhile: its box goes.
		const editing = this.#editing;
		if (editing !== undefined) {
			const there = this.#marks(editing.graphic).some((m) => m.id === editing.mark.id);
			if (there) editing.shared = true;
			else if (editing.shared) this.#close(false, true);
		}
		this.#place();
	}

	/** Draws a graphic's marks (numbered among those written so far) and its send bar. */
	#render(g: Attached): void {
		const marks = this.#marks(g);
		const me = this.#session.me?.id;
		const seen = new Set<string>();
		let n = 0;
		for (const m of marks) {
			seen.add(m.id);
			let node = g.layer.querySelector<HTMLElement>(`:scope > .mark[data-id="${CSS.escape(m.id)}"]`);
			if (node === null) {
				node = el("div", "mark");
				node.dataset.id = m.id;
				node.append(el("span", "mark-pin"));
				node.addEventListener("pointerdown", (event) => event.stopPropagation());
				node.addEventListener("mousedown", (event) => event.preventDefault());
				node.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const mark = this.#marks(g).find((x) => x.id === m.id);
					if (mark !== undefined && mark.memberId === this.#session.me?.id) this.#open(g, { id: mark.id, x: mark.x, y: mark.y, w: mark.w, h: mark.h, text: mark.text });
				});
				g.layer.append(node);
			}
			const name = this.#session.nameOf(m.memberId, m.name);
			const written = m.text.trim() !== "";
			node.classList.toggle("area", m.w !== undefined);
			node.classList.toggle("mine", m.memberId === me);
			node.classList.toggle("writing", !written);
			Object.assign(node.style, rect(m.x, m.y, m.w ?? 0, m.h ?? 0));
			node.style.setProperty("--person", personColor(name));
			node.querySelector(".mark-pin")!.textContent = written ? String(++n) : "…";
			node.title = written ? `${name}: ${m.text}` : `${name} is writing a comment`;
		}
		for (const node of g.layer.querySelectorAll<HTMLElement>(":scope > .mark")) if (!seen.has(node.dataset.id!)) node.remove();
		g.frame.classList.toggle("has-marks", marks.length > 0);
		this.#renderBar(g, marks);
	}

	/** Under the graphic: the comments waiting on it, and Send. */
	#renderBar(g: Attached, marks: SharedMark[]): void {
		const written = marks.filter((m) => m.text.trim() !== "");
		const writing = marks.filter((m) => m.text.trim() === "" && m.memberId !== this.#session.me?.id);
		if (marks.length === 0) {
			g.bar.remove();
			return;
		}
		if (!g.bar.isConnected) g.frame.after(g.bar);
		const list = written
			.map((m, i) => {
				const name = this.#session.nameOf(m.memberId, m.name);
				return `<li style="--person:${personColor(name)}"><span class="mark-pin">${i + 1}</span><b>${escapeHtml(name)}</b> ${escapeHtml(m.text)}</li>`;
			})
			.join("");
		const others = writing.map((m) => escapeHtml(this.#session.nameOf(m.memberId, m.name)));
		g.bar.innerHTML = `<ol class="marks-list">${list}</ol><div class="marks-actions"><span class="muted">${
			others.length > 0 ? `${[...new Set(others)].join(", ")} ${others.length === 1 ? "is" : "are"} writing a comment` : `${written.length} ${written.length === 1 ? "comment" : "comments"}, not sent yet`
		}</span><span class="spacer"></span></div>`;
		const actions = g.bar.querySelector(".marks-actions")!;
		const mine = marks.filter((m) => m.memberId === this.#session.me?.id);
		if (mine.length > 0) {
			const discard = el("button", "marks-discard", mine.length === marks.length ? "Discard" : "Discard mine");
			discard.type = "button";
			discard.onclick = () => {
				if (this.#editing?.graphic === g) this.#close(false, true);
				for (const m of mine) this.#session.send({ type: "mark", key: g.shared, remove: m.id });
			};
			actions.append(discard);
		}
		const send = el("button", "marks-send", written.length > 1 ? `Send ${written.length} comments` : "Send");
		send.type = "button";
		send.disabled = written.length === 0 || !this.#mayComment;
		send.onclick = () => void this.#send(g);
		actions.append(send);
	}

	/** Opens the box to write a mark's comment. */
	#open(g: Attached, mark: Mark): void {
		if (this.#editing !== undefined) this.#close(true);
		const box = el("div", "mark-editor");
		const area = el("textarea");
		area.placeholder = "Comment on this… (Enter adds it, ⌘↩ sends all)";
		area.rows = 2;
		area.value = mark.text;
		const remove = el("button", "mark-remove", "Remove");
		remove.type = "button";
		box.append(area, remove);
		document.body.append(box);
		const editing: Editing = { graphic: g, mark, shared: this.#marks(g).some((m) => m.id === mark.id), box, area };
		this.#editing = editing;
		const update = () => this.#session.send({ type: "mark", key: g.shared, mark: { ...mark, text: area.value } });
		// Others see it as it's written, a few times a second.
		area.addEventListener("input", () => {
			clearTimeout(editing.timer);
			editing.timer = setTimeout(update, 150);
		});
		area.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				const written = { ...mark, text: area.value };
				this.#close(true);
				void this.#send(g, written);
			} else if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.#close(true);
			}
		});
		remove.onclick = () => {
			this.#session.send({ type: "mark", key: g.shared, remove: mark.id });
			this.#close(false, true);
		};
		this.#place();
		area.focus();
	}

	/** Closes the box: `keep` sends what was written (an empty comment is dropped either way). */
	#close(keep: boolean, gone = false): void {
		const editing = this.#editing;
		if (editing === undefined) return;
		this.#editing = undefined;
		clearTimeout(editing.timer);
		editing.box.remove();
		if (gone) return;
		const { graphic: g, mark, area } = editing;
		// Dropped, or left empty: an empty comment goes, and a dropped edit leaves a written one as it was.
		if (area.value.trim() === "" || !keep) {
			const sent = this.#marks(g).find((m) => m.id === mark.id)?.text ?? mark.text;
			if (area.value.trim() === "" || sent.trim() === "") this.#session.send({ type: "mark", key: g.shared, remove: mark.id });
			return;
		}
		this.#session.send({ type: "mark", key: g.shared, mark: { ...mark, text: area.value } });
	}

	/** Puts the open box under its mark (or above it, near the bottom of the window). */
	#place(): void {
		const editing = this.#editing;
		if (editing === undefined) return;
		const node = editing.graphic.layer.querySelector<HTMLElement>(`.mark[data-id="${CSS.escape(editing.mark.id)}"]`);
		const r = (node ?? editing.graphic.surface).getBoundingClientRect();
		const box = editing.box;
		const width = Math.min(320, innerWidth - 16);
		box.style.width = `${width}px`;
		box.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, r.left))}px`;
		const below = r.bottom + 8;
		const height = box.offsetHeight || 90;
		box.style.top = `${below + height < innerHeight - 8 ? below : Math.max(8, r.top - height - 8)}px`;
	}

	/**
	 * Sends a graphic's written comments as one message, with the graphic marked with them. `writing`: the comment in
	 * the box as it is now (the server may not have it yet).
	 */
	async #send(g: Attached, writing?: Mark): Promise<void> {
		const me = this.#session.me;
		const shared = this.#marks(g);
		const all: SharedMark[] =
			writing === undefined || me === undefined
				? shared
				: shared.some((m) => m.id === writing.id)
					? shared.map((m) => (m.id === writing.id ? { ...m, text: writing.text } : m))
					: [...shared, { ...writing, memberId: me.id, name: me.name, at: Date.now() }];
		const marks = all.filter((m) => m.text.trim() !== "");
		if (marks.length === 0) return;
		const names = marks.map((m) => this.#session.nameOf(m.memberId, m.name));
		let image: Attachment | undefined;
		try {
			const canvas = await g.capture();
			drawMarks(canvas, marks, names);
			image = encode(canvas, `${g.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "graphic"}-comments`);
		} catch (error) {
			this.#options.toast(`Couldn't take a picture of it (${error instanceof Error ? error.message : String(error)}); sending the comments without it.`, "error");
		}
		this.#options.send(commentsText(g.title, marks, names, image !== undefined), image, g.shared);
		this.#session.send({ type: "mark", key: g.shared, sent: marks.map((m) => m.id) });
		this.#mode(g, false);
	}
}

function clamp(n: number): number {
	return Math.min(1, Math.max(0, n));
}

function rect(x: number, y: number, w: number, h: number): Partial<CSSStyleDeclaration> {
	return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` };
}

const percent = (n: number) => `${Math.round(n * 100)}%`;

/** The message: each comment numbered as on the picture, by whom, and where (for a reader without the picture). */
export function commentsText(title: string, marks: Mark[], names: string[], pictured: boolean): string {
	const lines = marks.map((m, i) => {
		const where = m.w !== undefined && m.h !== undefined ? `on the area ${percent(m.x)}–${percent(m.x + m.w)} across, ${percent(m.y)}–${percent(m.y + m.h)} down` : `at ${percent(m.x)} across, ${percent(m.y)} down`;
		return `${i + 1}. ${names[i]}, ${where}: ${m.text.trim()}`;
	});
	return `Comments on ${title}${pictured ? ", numbered on the attached picture" : ""}:\n${lines.join("\n")}`;
}

/** Draws the marks on the picture: areas outlined, and each comment's number in its author's color. */
export function drawMarks(canvas: HTMLCanvasElement, marks: Mark[], names: string[]): void {
	const ctx = canvas.getContext("2d")!;
	const { width, height } = canvas;
	// Sized by the longer side, so a wide, short graphic's numbers are still easy to see.
	const unit = Math.max(1, Math.max(width, height) / 700);
	marks.forEach((m, i) => {
		const color = personColor(names[i] ?? "");
		const x = m.x * width;
		const y = m.y * height;
		if (m.w !== undefined && m.h !== undefined) {
			ctx.fillStyle = color.replace(")", " / 0.12)");
			ctx.fillRect(x, y, m.w * width, m.h * height);
			ctx.strokeStyle = color;
			ctx.lineWidth = 2.5 * unit;
			ctx.strokeRect(x, y, m.w * width, m.h * height);
		}
		const r = 11 * unit;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.fill();
		ctx.lineWidth = 2 * unit;
		ctx.strokeStyle = "#ffffff";
		ctx.stroke();
		ctx.fillStyle = "#ffffff";
		ctx.font = `600 ${12 * unit}px -apple-system, system-ui, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(i + 1), x, y + 0.5 * unit);
	});
}

/** The picture as an attachment: at most 2000 pixels a side, PNG, or JPEG when that's over the image limit. */
function encode(source: HTMLCanvasElement, name: string): Attachment {
	const scale = Math.min(1, 2000 / Math.max(source.width, source.height));
	let canvas = source;
	if (scale < 1) {
		canvas = document.createElement("canvas");
		canvas.width = Math.round(source.width * scale);
		canvas.height = Math.round(source.height * scale);
		canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
	}
	let url = canvas.toDataURL("image/png");
	let mimeType = "image/png";
	if (url.length * 0.75 > 4.5 * 1024 * 1024) {
		url = canvas.toDataURL("image/jpeg", 0.85);
		mimeType = "image/jpeg";
	}
	return { name: `${name}.${mimeType === "image/png" ? "png" : "jpg"}`, mimeType, data: url.slice(url.indexOf(",") + 1) };
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(width));
	canvas.height = Math.max(1, Math.round(height));
	return canvas;
}

function loaded(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("the picture didn't load"));
		image.src = src;
	});
}

/** An image as shown: at its own resolution. */
export async function captureImage(image: HTMLImageElement): Promise<HTMLCanvasElement> {
	if (!image.complete || image.naturalWidth === 0) await new Promise((r) => image.addEventListener("load", r, { once: true }));
	const canvas = canvasOf(image.naturalWidth, image.naturalHeight);
	canvas.getContext("2d")!.drawImage(image, 0, 0);
	return canvas;
}

/** An SVG drawing in the page (a diagram), at twice its size, on the page's background. */
export async function captureSvg(svg: SVGSVGElement, width: number, height: number): Promise<HTMLCanvasElement> {
	const copy = svg.cloneNode(true) as SVGSVGElement;
	copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	copy.setAttribute("width", String(width));
	copy.setAttribute("height", String(height));
	copy.style.removeProperty("max-width");
	const image = await loaded(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`);
	const canvas = canvasOf(width * 2, height * 2);
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	return canvas;
}

/** A preview's frame, as it shows now: drawn inside the frame (capture-frame.ts), which sends it back. */
export function captureFrame(frame: HTMLIFrameElement): Promise<HTMLCanvasElement> {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const timer = setTimeout(() => {
			removeEventListener("message", onMessage);
			reject(new Error("the preview didn't answer"));
		}, 10_000);
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { syncpi?: string; id?: string; url?: string; error?: string } | null;
			if (event.source !== frame.contentWindow || data?.syncpi !== "captured" || data.id !== id) return;
			clearTimeout(timer);
			removeEventListener("message", onMessage);
			if (typeof data.url !== "string" || !data.url.startsWith("data:image/png;base64,")) return reject(new Error(data.error ?? "the preview sent no picture"));
			void loaded(data.url).then((image) => {
				const canvas = canvasOf(image.naturalWidth, image.naturalHeight);
				canvas.getContext("2d")!.drawImage(image, 0, 0);
				resolve(canvas);
			}, reject);
		};
		addEventListener("message", onMessage);
		frame.contentWindow?.postMessage({ syncpi: "capture", id }, "*");
	});
}

/** The key's prefix for a graphic in `who`'s side thread: its marks are theirs alone (protocol.ts). */
export function privateScope(who: string): string {
	return `${PRIVATE_MARKS}${who}:`;
}
