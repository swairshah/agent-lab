// The composer: the next row of the thread. Enter starts a new line, ⌘↩ (Ctrl+Enter) sends, stopping the agent's
// current run for it, as in Delta (/steer joins the run instead, /stop stops it). `/` completes commands, `@` people
// and project files, and files can be dropped, pasted or attached: images go to the model as images, text files go in
// the message. Commands mirror the terminal UI's.
//
// What's written here is a shared draft (shared/drafts.ts): the others see it as it's written, with your cursor. Tag
// someone in it (@name) and it's in their inbox; they can join it and write it with you, their cursor showing here,
// and whichever of you sends it sends it for both. The draft survives reloads.
import { parseInvite } from "../shared/commands.ts";
import { draftText, fromBase64, isCommand, toBase64, Y } from "../shared/drafts.ts";
import { mentioned } from "../shared/mentions.ts";
import { ATTACHMENT_LIMITS, type Attachment, IMAGE_TYPES, type Role, type Where } from "../shared/protocol.ts";
import { $, escapeHtml, storage } from "./dom.ts";
import { peersHtml, peersIn } from "./peers.ts";
import type { SessionClient } from "./session.ts";
import type { Section } from "./settings.ts";

export type CommandContext = {
	session: SessionClient;
	/** True inside an app that can run requests on this machine; false in a plain browser. */
	embedded: boolean;
	notify(text: string, tone?: "info" | "error"): void;
	showSetup(): void;
	/** Which thread the composer talks to: the shared thread, or the land subthread being shown. */
	conv(): "main" | "land";
	/** Lands the thread's changes (asks first), or shows the land in progress. */
	land(): void;
	togglePanel(): void;
	openSettings(section?: Section): void;
	confirm(id: "compact" | "reset"): void;
	/** Asks the embedding app to do something only it can. */
	toHost(action: string, data?: unknown): void;
	/** In the app: runs a command in a new terminal (`!cmd`), and runs the app's own commands (`/sync`, `/quit`, …). */
	terminal?: (command: string) => void;
	app?: (command: string) => void;
	/** In the app: the VM this thread's server runs on, for /ssh. */
	vm?: () => string | undefined;
	fork(key: string, text: string): void;
	where(): Where;
	setWhere(where: Where): void;
};

type Command = { name: string; description: string; app?: boolean; run(arg: string, words: string[], c: CommandContext): void };

const COMMANDS: Command[] = [
	{ name: "invite", description: "Invite by email, or make a link: [email] [role] [7d|never]", run: (arg, _w, c) => {
		const invite = parseInvite(arg);
		if (typeof invite === "string") c.notify(invite, "error");
		else c.session.send({ type: "invite", ...invite });
	} },
	{ name: "session-share", description: "Make a share link", run: (_a, _w, c) => c.session.send({ type: "invite" }) },
	{ name: "members", description: "People, roles and invites", run: (_a, _w, c) => c.openSettings("people") },
	{ name: "name", description: "Change your name", run: (arg, _w, c) => arg && c.session.send({ type: "rename", name: arg }) },
	{ name: "role", description: "Change someone's role: <name> <admin|editor|viewer>", run: (_a, words, c) => c.session.send({ type: "setRole", memberId: memberId(c, words[0] ?? ""), role: words[1] as Role }) },
	{ name: "remove", description: "Remove someone from the session", run: (arg, _w, c) => c.session.send({ type: "remove", memberId: memberId(c, arg) }) },
	{ name: "links", description: "Invites that still work", run: (_a, _w, c) => c.openSettings("people") },
	{ name: "revoke", description: "Revoke an invite", run: (arg, _w, c) => c.session.send({ type: "revoke", code: arg }) },
	{ name: "compact", description: "Summarize older messages now", run: (arg, _w, c) => (arg ? c.session.send({ type: "compact", instructions: arg }) : c.confirm("compact")) },
	{ name: "new", description: "Start a new context (admins)", run: (_a, _w, c) => c.confirm("reset") },
	{ name: "tree", description: "Branches; /tree <n> branches before message n", run: (arg, _w, c) => {
		if (/^b\d+$/.test(arg)) {
			const branch = c.session.branches[Number(arg.slice(1))];
			if (branch) c.session.send({ type: "switchBranch", id: branch.id });
		} else if (/^\d+$/.test(arg)) {
			const users = c.session.threads.main.state.items.filter((i) => i.kind === "user" && /^\d+$/.test(i.key));
			const item = users[Number(arg) - 1];
			if (item?.kind === "user") c.fork(item.key, item.text);
		} else c.openSettings("branches");
	} },
	{ name: "model", description: "Change the agent's model (admins)", run: (_a, _w, c) => c.openSettings("general") },
	{ name: "settings", description: "Settings (⌘,)", run: (_a, _w, c) => c.openSettings() },
	{ name: "remote", description: "Run this request on the session VM (keeps going if you close the app): /remote <task>", run: (arg, _w, c) => {
		if (!arg) return c.notify("Say what to do: /remote <task>");
		c.session.submit(arg, "interrupt", "vm");
	} },
	{ name: "steer", description: "Add to what the agent is doing, without stopping it: /steer <message>", run: (arg, _w, c) => arg && c.session.submit(arg, "steer", c.where()) },
	{ name: "queue", description: "Send after the agent's current run, without stopping it: /queue <message>", run: (arg, _w, c) => arg && c.session.submit(arg, "followUp", c.where()) },
	{ name: "stop", description: "Stop the agent", run: (_a, _w, c) => c.session.send({ type: "abort" }) },
	{ name: "env", description: "The setup agent's thread", run: (_a, _w, c) => c.showSetup() },
	{ name: "land", description: "Land this thread's changes on main (the project's land skill)", run: (_a, _w, c) => c.land() },
	{ name: "changes", description: "Changes and artifacts", run: (_a, _w, c) => c.togglePanel() },
	{ name: "sync", description: "Sync the project with this machine now", app: true, run: (_a, _w, c) => c.app?.("project.sync") },
	{ name: "web", description: "Open the thread in a browser", app: true, run: (_a, _w, c) => c.app?.("project.web") },
	{ name: "ssh", description: "A terminal on the thread's VM", app: true, run: (_a, _w, c) => {
		const vm = c.vm?.();
		if (vm) c.terminal?.(`ssh ${vm}.exe.xyz`);
		else c.notify("This thread runs on this machine, not a VM.");
	} },
	{ name: "quit", description: "Quit SyncPi", app: true, run: (_a, _w, c) => c.app?.("app.quit") },
	{ name: "where", description: "Run your requests here or on the VM", run: (arg, _w, c) => {
		if (arg === "vm") c.setWhere("vm");
		else if (c.embedded && (arg === "here" || arg === "device")) c.setWhere("device");
		else c.notify(c.embedded ? "Use /where here or /where vm" : "Requests from a browser run on the session VM");
	} },
];

function memberId(c: CommandContext, query: string): string {
	return c.session.members.find((m) => m.name === query || m.email === query || m.id === query)?.id ?? query;
}

function base64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

/** Reads a file as an attachment, or says why it can't be one. */
async function toAttachment(file: File): Promise<Attachment | string> {
	if (IMAGE_TYPES.includes(file.type)) {
		if (file.size > ATTACHMENT_LIMITS.imageBytes) return `${file.name} is larger than ${ATTACHMENT_LIMITS.imageBytes / 1024 / 1024} MB`;
		return { name: file.name, mimeType: file.type, data: base64(await file.arrayBuffer()) };
	}
	if (file.size > ATTACHMENT_LIMITS.textBytes) return `${file.name} is larger than ${ATTACHMENT_LIMITS.textBytes / 1024} KB`;
	const buffer = await file.arrayBuffer();
	if (new Uint8Array(buffer).includes(0)) return `${file.name} isn't text or an image (PNG, JPEG, GIF, WebP)`;
	return { name: file.name, mimeType: file.type || "text/plain", data: base64(buffer) };
}

/** The textarea's styles a layer over it copies, so its text lines up with the textarea's (peers' cursors). */
const MIRROR = ["boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent", "textTransform"] as const;

/** A touch screen without a fine pointer: a phone or tablet. */
const TOUCH = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

export class Composer {
	readonly #c: CommandContext;
	readonly #input: HTMLTextAreaElement;
	readonly #draftKey: string;
	#attachments: Attachment[] = [];
	/** Whose draft this composer writes: yours, or one you joined. Unset until the session says who you are. */
	#owner: string | undefined;
	#text: Y.Text | undefined;
	#unbind: (() => void) | undefined;
	/** People already tagged in this draft, and the wait before tagging someone whose name was just typed. */
	#tagged = new Set<string>();
	#tagTimer: ReturnType<typeof setTimeout> | undefined;
	#caretFrame = 0;
	readonly #peers: HTMLElement;
	/** Prompt template names offered by an embedding app; they expand there. */
	prompts: string[] = [];

	constructor(context: CommandContext, draftKey: string) {
		this.#c = context;
		this.#input = $<HTMLTextAreaElement>("input");
		if (TOUCH) {
			this.#input.placeholder = "@ for people and files, / for commands";
			this.#input.enterKeyHint = "send";
		}
		this.#draftKey = `draft:${draftKey}`;
		const input = this.#input;
		input.value = storage.get(this.#draftKey) ?? "";
		this.#peers = document.createElement("div");
		this.#peers.className = "peer-layer";
		this.#peers.setAttribute("aria-hidden", "true");
		input.after(this.#peers);
		this.#fit();
		const session = context.session;
		// Your own draft, once the session says who you are; as you left it, merged with what the server has.
		session.on("session", () => {
			if (this.#owner === undefined && session.me !== undefined) this.#bindOwn();
		});
		session.on("connection", () => this.#shareCaret());
		session.on("drafts", () => {
			this.#renderPeers();
			this.#renderWith();
		});
		session.on("people", () => this.#renderWith());
		session.onDraftSent = (owner, by) => {
			if (by === session.me?.id) return;
			if (owner === this.#owner && owner !== session.me?.id) {
				this.#bindOwn();
				this.#c.notify(`${session.nameOf(by)} sent ${session.nameOf(owner)}'s draft`);
			} else if (owner === session.me?.id) this.#c.notify(`${session.nameOf(by)} sent your draft`);
		};

		input.addEventListener("input", () => {
			this.#changed();
			this.#complete();
		});
		for (const type of ["keyup", "mouseup", "focus", "select"]) input.addEventListener(type, () => this.#shareCaret());
		document.addEventListener("selectionchange", () => {
			if (document.activeElement === input) this.#shareCaret();
		});
		input.addEventListener("scroll", () => this.#renderPeers());
		$("draft-with").addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("[data-leave]")) this.leave();
		});
		input.addEventListener("keydown", (event) => this.#key(event));
		input.addEventListener("paste", (event) => {
			const files = [...(event.clipboardData?.files ?? [])];
			if (files.length === 0) return;
			event.preventDefault();
			void this.addFiles(files);
		});
		$("composer").addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});
		$("send").addEventListener("click", () => this.submit());
		$("attach").addEventListener("click", () => $<HTMLInputElement>("file-input").click());
		$<HTMLInputElement>("file-input").addEventListener("change", (event) => {
			const picker = event.target as HTMLInputElement;
			void this.addFiles([...(picker.files ?? [])]);
			picker.value = "";
		});
		$("attachments").addEventListener("click", (event) => {
			const index = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
			if (index === undefined) return;
			this.#attachments.splice(Number(index), 1);
			this.#renderAttachments();
		});
		$("completions").addEventListener("mousedown", (event) => {
			event.preventDefault();
			const name = (event.target as HTMLElement).closest<HTMLElement>("[data-complete]")?.dataset.complete;
			if (name !== undefined) this.#accept(name);
		});
		this.#wireDrop();
	}

	focus(): void {
		this.#input.focus();
	}

	/** Puts text in the composer to edit, e.g. a message being branched from. */
	setText(text: string): void {
		this.#input.value = text;
		this.#changed();
		this.#input.focus();
	}

	/** Whose draft this composer is writing. */
	get owner(): string | undefined {
		return this.#owner;
	}

	/** Writes `owner`'s draft with them, from here; your own draft waits, as you left it. */
	join(owner: string): void {
		const session = this.#c.session;
		if (owner === session.me?.id || session.me === undefined) return this.leave();
		if (session.role === "viewer") return this.#c.notify("Viewers can't write in drafts; ask an admin to make you an editor.", "error");
		const entry = session.drafts.get(owner);
		if (entry === undefined || draftText(entry.doc).toString().trim() === "") return this.#c.notify(`${session.nameOf(owner)}'s draft was sent or cleared.`);
		this.#bind(owner);
		const input = this.#input;
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		this.#shareCaret();
	}

	/** Back to your own draft. */
	leave(): void {
		if (this.#c.session.me === undefined) return;
		this.#bindOwn();
		this.#shareCaret();
		this.#input.focus();
	}

	get text(): string {
		return this.#input.value;
	}

	/** Takes what's written (it goes out with a comment), leaving the composer empty. */
	takeText(): string {
		const text = this.#input.value.trim();
		this.#input.value = "";
		this.#changed();
		return text;
	}

	async addFiles(files: File[]): Promise<void> {
		for (const file of files) {
			if (this.#attachments.length >= ATTACHMENT_LIMITS.count) {
				this.#c.notify(`At most ${ATTACHMENT_LIMITS.count} attachments per message`, "error");
				break;
			}
			const attachment = await toAttachment(file);
			if (typeof attachment === "string") this.#c.notify(attachment, "error");
			else this.#attachments.push(attachment);
		}
		this.#renderAttachments();
		this.#input.focus();
	}

	/** The slash commands here: the app's own only in the app. */
	#commands(): Command[] {
		return COMMANDS.filter((c) => !c.app || this.#c.app !== undefined);
	}

	submit(): void {
		const text = this.#input.value.trim();
		if (!text && this.#attachments.length === 0) return;
		if (text.startsWith("!") && this.#c.terminal) {
			this.#c.terminal(text.slice(1).trim());
		} else if (text.startsWith("/") && this.#attachments.length === 0) {
			const [name = "", ...words] = text.slice(1).split(/\s+/);
			const command = this.#commands().find((c) => c.name === name);
			// Prompt templates expand in an embedding app; elsewhere an unknown command stays in the box.
			if (command === undefined && !this.prompts.includes(name)) return this.#c.notify(`Unknown command /${name}. Type / to see commands.`, "error");
			if (command !== undefined) command.run(words.join(" "), words, this.#c);
			else this.#c.session.submit(text, "interrupt", this.#c.where());
		} else {
			const land = this.#c.conv() === "land";
			this.#c.session.submit(text, land ? "followUp" : "interrupt", this.#c.where(), this.#attachments, [], this.#owner, land ? "land" : undefined);
			this.#attachments = [];
			this.#renderAttachments();
		}
		const joined = this.#owner !== this.#c.session.me?.id;
		this.#input.value = "";
		this.#changed();
		this.#hideCompletions();
		// A draft you joined is sent: back to yours.
		if (joined && this.#c.session.me !== undefined) this.#bindOwn();
	}

	#key(event: KeyboardEvent): void {
		const open = !$("completions").hidden;
		// Phone keyboards have no ⌘: there Enter sends and Shift+Enter starts a new line.
		const send = event.key === "Enter" && !event.isComposing && (event.metaKey || event.ctrlKey || (TOUCH && !event.shiftKey && !open));
		if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			this.#moveSelection(event.key === "ArrowDown" ? 1 : -1);
		} else if (open && !send && (event.key === "Tab" || event.key === "Enter")) {
			event.preventDefault();
			const selected = $("completions").querySelector<HTMLElement>("[aria-selected=true]");
			if (selected?.dataset.complete !== undefined) this.#accept(selected.dataset.complete);
		} else if (send) {
			event.preventDefault();
			this.submit();
		} else if (event.key === "Escape") {
			if (open) this.#hideCompletions();
			else if (this.#c.conv() === "land" && this.#c.session.threads.land.state.busy) this.#c.session.send({ type: "abort", conv: "land" });
			else if (this.#c.session.threads.main.state.busy) this.#c.session.send({ type: "abort" });
		}
	}

	/** Dropping files anywhere on the conversation adds them to the message. */
	#wireDrop(): void {
		const center = document.querySelector<HTMLElement>(".center")!;
		let depth = 0;
		const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
		center.addEventListener("dragenter", (event) => {
			if (!hasFiles(event)) return;
			depth++;
			$("drop").hidden = false;
		});
		center.addEventListener("dragleave", () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) $("drop").hidden = true;
		});
		center.addEventListener("dragover", (event) => {
			if (hasFiles(event)) event.preventDefault();
		});
		center.addEventListener("drop", (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth = 0;
			$("drop").hidden = true;
			void this.addFiles([...(event.dataTransfer?.files ?? [])]);
		});
	}

	#renderAttachments(): void {
		const box = $("attachments");
		box.hidden = this.#attachments.length === 0;
		box.innerHTML = this.#attachments
			.map((a, n) => {
				const thumb = IMAGE_TYPES.includes(a.mimeType) ? `<img alt="" src="data:${escapeHtml(a.mimeType)};base64,${a.data}">` : "";
				return `<span class="attachment" title="${escapeHtml(a.name)}">${thumb}<span>${escapeHtml(a.name)}</span><button type="button" data-remove="${n}" aria-label="Remove ${escapeHtml(a.name)}">×</button></span>`;
			})
			.join("");
	}

	#fit(): void {
		const input = this.#input;
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	}

	/** Your own draft: restored from this browser, kept here as it changes, and written from the composer. */
	#bindOwn(): void {
		const session = this.#c.session;
		const me = session.me!.id;
		const doc = session.draft(me);
		if (!this.#restored) {
			this.#restored = true;
			const saved = storage.get(`y${this.#draftKey}`);
			const text = draftText(doc);
			try {
				if (saved) Y.applyUpdate(doc, fromBase64(saved));
				else if (text.length === 0 && this.#input.value) text.insert(0, this.#input.value);
			} catch {}
			doc.on("update", () => {
				storage.set(`y${this.#draftKey}`, toBase64(Y.encodeStateAsUpdate(doc)));
				storage.set(this.#draftKey, text.toString());
			});
		}
		this.#bind(me);
	}

	#restored = false;

	/** Writes `owner`'s draft from here: the textarea shows it, and what's typed goes into it. */
	#bind(owner: string): void {
		this.#unbind?.();
		const text = draftText(this.#c.session.draft(owner));
		this.#owner = owner;
		this.#text = text;
		this.#tagged = new Set();
		const observe = (event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.origin !== this) this.#remote(event);
		};
		text.observe(observe);
		this.#unbind = () => text.unobserve(observe);
		this.#input.value = text.toString();
		this.#fit();
		this.#renderPeers();
		this.#renderWith();
	}

	/** Someone else changed the draft: show it, keeping your cursor where it was in the text. */
	#remote(event: Y.YTextEvent): void {
		const input = this.#input;
		let start = input.selectionStart;
		let end = input.selectionEnd;
		let at = 0;
		for (const op of event.delta) {
			if (op.retain !== undefined) at += op.retain;
			else if (typeof op.insert === "string") {
				const n = op.insert.length;
				if (at < start) start += n;
				if (at < end) end += n;
				at += n;
			} else if (op.delete !== undefined) {
				start -= Math.max(0, Math.min(op.delete, start - at));
				end -= Math.max(0, Math.min(op.delete, end - at));
			}
		}
		const focused = document.activeElement === input;
		input.value = this.#text!.toString();
		if (focused) input.setSelectionRange(start, end);
		if (input.value.trim() === "") this.#tagged.clear();
		this.#fit();
		this.#renderPeers();
	}

	/** The textarea changed here: the same change goes into the draft, for everyone. */
	#changed(): void {
		this.#fit();
		const text = this.#text;
		if (text === undefined) return storage.set(this.#draftKey, this.#input.value);
		const before = text.toString();
		const after = this.#input.value;
		if (before === after) return;
		// One replaced span: what's between the common start and the common end. The end can't reach left of the cursor,
		// so typing a letter that repeats the next one inserts it where it was typed.
		const most = Math.min(before.length, after.length);
		let start = 0;
		while (start < most && before[start] === after[start]) start++;
		const tail = Math.min(most - start, Math.max(0, after.length - this.#input.selectionEnd));
		let end = 0;
		while (end < tail && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
		text.doc!.transact(() => {
			if (before.length - start - end > 0) text.delete(start, before.length - start - end);
			if (after.length - start - end > 0) text.insert(start, after.slice(start, after.length - end));
		}, this);
		if (after.trim() === "") this.#tagged.clear();
		clearTimeout(this.#tagTimer);
		this.#tagTimer = setTimeout(() => this.#tag(), 1500);
		this.#renderPeers();
		this.#shareCaret();
	}

	/** Your cursor, for the others: in this draft, at most once a frame. */
	#shareCaret(): void {
		if (this.#caretFrame !== 0) return;
		this.#caretFrame = requestAnimationFrame(() => {
			this.#caretFrame = 0;
			const text = this.#text;
			if (text === undefined || this.#owner === undefined) return;
			const at = (index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
			this.#c.session.send({ type: "caret", owner: this.#owner, anchor: at(this.#input.selectionStart), head: at(this.#input.selectionEnd) });
		});
	}

	/**
	 * People named in the draft (@name) are tagged: it's in their inbox, and they can join it. Each once per draft;
	 * a name that's still being typed waits a moment (`now` when it was picked from the list).
	 */
	#tag(): void {
		clearTimeout(this.#tagTimer);
		const session = this.#c.session;
		const text = this.#text?.toString() ?? "";
		if (this.#owner === undefined || text.trim() === "" || isCommand(text) || session.role === "viewer") return;
		const others = session.members.filter((m) => m.id !== session.me?.id);
		const named = new Set(mentioned(text, others.map((m) => m.name)));
		const fresh = others.filter((m) => named.has(m.name) && !this.#tagged.has(m.id)).map((m) => m.id);
		if (fresh.length === 0) return;
		for (const id of fresh) this.#tagged.add(id);
		session.send({ type: "tag", owner: this.#owner, memberIds: fresh });
	}

	/** The others' cursors and selections, drawn over the textarea in a layer that lines up with its text. */
	#renderPeers(): void {
		const layer = this.#peers;
		const peers = this.#owner === undefined ? [] : peersIn(this.#c.session, this.#owner);
		layer.hidden = peers.length === 0;
		if (peers.length === 0) return;
		const input = this.#input;
		const style = getComputedStyle(input);
		for (const prop of MIRROR) layer.style[prop] = style[prop];
		layer.style.top = `${input.offsetTop}px`;
		layer.style.left = `${input.offsetLeft}px`;
		// Names above the first line show outside the textarea, so the layer doesn't clip; it scrolls with it instead.
		layer.innerHTML = `<div style="transform: translateY(${-input.scrollTop}px)">${peersHtml(input.value, peers)}</div>`;
	}

	/** Who's writing this draft with you, above it; and whose draft it is when it isn't yours. */
	#renderWith(): void {
		const session = this.#c.session;
		const box = $("draft-with");
		const owner = this.#owner;
		const me = session.me?.id;
		if (owner === undefined || me === undefined) return void (box.hidden = true);
		const others = [...session.carets].filter(([id, c]) => c.owner === owner && id !== owner).map(([id, c]) => session.nameOf(id, c.name));
		const mine = owner === me;
		box.hidden = mine && others.length === 0;
		if (box.hidden) return;
		const names = (list: string[]) => list.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(", ");
		box.innerHTML = mine
			? `${names(others)} ${others.length === 1 ? "is" : "are"} writing this with you`
			: `Writing <strong>${escapeHtml(session.nameOf(owner))}</strong>'s draft${others.length > 0 ? ` with ${names(others)}` : ""}. ⌘↩ sends it for everyone who wrote it. <button type="button" class="link" data-leave>Back to yours</button>`;
	}

	#complete(): void {
		const before = this.#input.value.slice(0, this.#input.selectionStart);
		const match = before.match(/(?:^|\s)([@/])([^\s]*)$/);
		// Commands only at the start of the message.
		if (match === null || (match[1] === "/" && before.trimStart().indexOf("/") !== 0)) return this.#hideCompletions();
		const query = match[2]!.toLowerCase();
		// @ completes people (to mention them; they get it in their inbox), then files.
		const people = this.#c.session.members
			.filter((m) => m.id !== this.#c.session.me?.id && m.name.toLowerCase().startsWith(query))
			.map((m) => ({ name: m.name, description: "mention" }));
		const options: { name: string; description: string }[] =
			match[1] === "@"
				? [...people, ...this.#c.session.files.filter((f) => f.toLowerCase().includes(query)).slice(0, 40).map((name) => ({ name, description: "" }))]
				: [...this.#commands().map(({ name, description }) => ({ name, description })), ...this.prompts.map((name) => ({ name, description: "prompt template" }))].filter((c) =>
						c.name.toLowerCase().startsWith(query),
					);
		if (options.length === 0) return this.#hideCompletions();
		const list = $("completions");
		list.innerHTML = options
			.slice(0, 9)
			.map(
				(o, n) =>
					`<div class="completion" role="option" aria-selected="${n === 0}" data-complete="${escapeHtml(o.name)}"><span class="completion-name">${match[1]}${escapeHtml(o.name)}</span>${
						o.description ? `<span class="completion-desc">${escapeHtml(o.description)}</span>` : ""
					}</div>`,
			)
			.join("");
		// Just under the composer, aligned with the text.
		const composer = $("composer");
		list.style.top = `${composer.offsetTop + composer.offsetHeight + 4}px`;
		list.style.left = `${composer.offsetLeft + 44}px`;
		list.hidden = false;
	}

	#moveSelection(step: number): void {
		const options = [...$("completions").querySelectorAll<HTMLElement>("[role=option]")];
		const current = options.findIndex((o) => o.getAttribute("aria-selected") === "true");
		const next = (current + step + options.length) % options.length;
		options.forEach((o, n) => o.setAttribute("aria-selected", String(n === next)));
	}

	#accept(name: string): void {
		const input = this.#input;
		const before = input.value.slice(0, input.selectionStart);
		const match = before.match(/([@/])[^\s]*$/);
		if (match === null) return;
		input.setRangeText(`${match[1]}${name} `, before.length - match[0].length, input.selectionStart, "end");
		this.#hideCompletions();
		this.#changed();
		// Picking a person tags them now.
		if (match[1] === "@" && this.#c.session.members.some((m) => m.name === name)) this.#tag();
		input.focus();
	}

	#hideCompletions(): void {
		$("completions").hidden = true;
	}
}

