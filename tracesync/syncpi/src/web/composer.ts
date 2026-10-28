// The composer: the next row of the thread. Enter starts a new line, ⌘↩ (Ctrl+Enter) sends. `/` completes commands,
// `@` completes project files, and files can be dropped, pasted or attached: images go to the model as images, text
// files go in the message. The draft survives reloads. Commands mirror the terminal UI's.
import { parseInvite } from "../shared/commands.ts";
import { ATTACHMENT_LIMITS, type Attachment, IMAGE_TYPES, type Role, type Where } from "../shared/protocol.ts";
import { $, escapeHtml, storage } from "./dom.ts";
import type { SessionClient } from "./session.ts";
import type { Section } from "./settings.ts";

export type CommandContext = {
	session: SessionClient;
	/** True inside an app that can run requests on this machine; false in a plain browser. */
	embedded: boolean;
	notify(text: string, tone?: "info" | "error"): void;
	showSetup(): void;
	togglePanel(): void;
	openSettings(section?: Section): void;
	confirm(id: "compact" | "reset"): void;
	/** Asks the embedding app to do something only it can (open a terminal). */
	toHost(action: string, data?: unknown): void;
	fork(key: string, text: string): void;
	where(): Where;
	setWhere(where: Where): void;
};

type Command = { name: string; description: string; run(arg: string, words: string[], c: CommandContext): void };

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
	{ name: "steer", description: "Join the current run instead of queueing", run: (arg, _w, c) => arg && c.session.submit(arg, "steer", c.where()) },
	{ name: "stop", description: "Stop the agent", run: (_a, _w, c) => c.session.send({ type: "abort" }) },
	{ name: "env", description: "The setup agent's thread", run: (_a, _w, c) => c.showSetup() },
	{ name: "changes", description: "Changes and artifacts", run: (_a, _w, c) => c.togglePanel() },
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

/** A touch screen without a fine pointer: a phone or tablet. */
const TOUCH = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

export class Composer {
	readonly #c: CommandContext;
	readonly #input: HTMLTextAreaElement;
	readonly #draftKey: string;
	#attachments: Attachment[] = [];
	/** Prompt template names offered by an embedding app; they expand there. */
	prompts: string[] = [];

	constructor(context: CommandContext, draftKey: string) {
		this.#c = context;
		this.#input = $<HTMLTextAreaElement>("input");
		if (TOUCH) {
			this.#input.placeholder = "@ for files, / for commands";
			this.#input.enterKeyHint = "send";
		}
		this.#draftKey = `draft:${draftKey}`;
		const input = this.#input;
		input.value = storage.get(this.#draftKey) ?? "";
		this.#fit();
		window.addEventListener("pagehide", () => this.#saveDraft());

		input.addEventListener("input", () => {
			this.#saveDraft();
			this.#fit();
			this.#complete();
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
		this.#saveDraft();
		this.#fit();
		this.#input.focus();
	}

	get text(): string {
		return this.#input.value;
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

	submit(): void {
		const text = this.#input.value.trim();
		if (!text && this.#attachments.length === 0) return;
		if (text.startsWith("!") && this.#c.embedded) {
			this.#c.toHost("terminal", text.slice(1).trim());
		} else if (text.startsWith("/") && this.#attachments.length === 0) {
			const [name = "", ...words] = text.slice(1).split(/\s+/);
			const command = COMMANDS.find((c) => c.name === name);
			// Prompt templates expand in an embedding app; elsewhere an unknown command stays in the box.
			if (command === undefined && !this.prompts.includes(name)) return this.#c.notify(`Unknown command /${name}. Type / to see commands.`, "error");
			if (command !== undefined) command.run(words.join(" "), words, this.#c);
			else this.#c.session.submit(text, "followUp", this.#c.where());
		} else {
			this.#c.session.submit(text, "followUp", this.#c.where(), this.#attachments);
			this.#attachments = [];
			this.#renderAttachments();
		}
		this.#input.value = "";
		this.#saveDraft();
		this.#fit();
		this.#hideCompletions();
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

	#saveDraft(): void {
		storage.set(this.#draftKey, this.#input.value);
	}

	#complete(): void {
		const before = this.#input.value.slice(0, this.#input.selectionStart);
		const match = before.match(/(?:^|\s)([@/])([^\s]*)$/);
		// Commands only at the start of the message.
		if (match === null || (match[1] === "/" && before.trimStart().indexOf("/") !== 0)) return this.#hideCompletions();
		const query = match[2]!.toLowerCase();
		const options: { name: string; description: string }[] =
			match[1] === "@"
				? this.#c.session.files.filter((f) => f.toLowerCase().includes(query)).slice(0, 40).map((name) => ({ name, description: "" }))
				: [...COMMANDS.map(({ name, description }) => ({ name, description })), ...this.prompts.map((name) => ({ name, description: "prompt template" }))].filter((c) =>
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
		this.#saveDraft();
		input.focus();
	}

	#hideCompletions(): void {
		$("completions").hidden = true;
	}
}

