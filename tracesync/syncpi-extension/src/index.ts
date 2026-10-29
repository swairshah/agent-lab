// syncpi for pi: /sync makes this pi session a syncpi session, so others can join it (from syncpi's web view, its app
// or its terminal) and take turns with you. The session's thread (a pi-durable conversation on the syncpi server) and
// this pi session then hold the same conversation:
//   - pi keeps running your turns, with your model, tools, extensions and modes. Every message it adds (yours, its
//     answers, its tool results) is recorded into the thread, and while it runs, everyone watching sees it live.
//   - Other people's turns run on the syncpi server's agent. They come back into this session as `syncpi` messages:
//     shown in the transcript, and given to the model as the messages they were (the `context` hook below), so your
//     next turn knows them as its own history. They stay after /sync stop, so the session carries on locally.
//   - One agent works at a time. Before pi runs, it asks for the turn: the server's agent finishes first, or is stopped
//     when you may stop it. While pi has the turn, other people's messages wait for it, steer it, or stop it.
// The folder is kept in sync with the session's copy, as with syncpi's own terminal client.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	draftText,
	findByDir,
	fromBase64,
	isCommand,
	type LiveEvent,
	LiveSession,
	openSession,
	type RecordedMessage,
	type ServerMessage,
	type SessionRecord,
	type StartOptions,
	whenReady,
	Y,
} from "syncpi/client";

/** Messages from the thread that this pi didn't write: other people's turns. */
const MESSAGE = "syncpi";
/** This pi session is synced with a syncpi session (`id`), or stopped being (`stopped`). */
const LINK = "syncpi-link";
const STATUS = "syncpi";
/** The widget above the editor that shows who is writing a message. */
const TYPING = "syncpi-typing";
/** How long after someone's last keystroke they still count as typing (then: "has a draft"). */
const TYPING_MS = 4_000;
/** How long the server has to say it heard a request for the turn. */
const ANSWER_MS = 8_000;
/** How long a recording (or an invite) may take before it counts as unanswered. */
const REQUEST_MS = 60_000;
const OLD_SERVER = "the session's server didn't answer. It may be older than /sync; its owner can run `syncpi update`, then /sync again. Until then, pi runs without syncing its turns.";

type Block = { type: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role: "user" | "assistant" | "toolResult"; content: string | Block[]; toolCallId?: string; toolName?: string; isError?: boolean; provider?: string; model?: string };
type Entry = { id: number; kind: string; data?: { author?: string; origin?: string; text?: string }; model?: Message[] };
/** A thread message as this session holds it. */
type Imported = { entryId: number; message: Message; author?: string };
type Link = { id?: string; url?: string; stopped?: boolean };

const textOf = (content: Message["content"]): string => (typeof content === "string" ? content : content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join(""));

/** What of a thread entry this session takes in: the model's messages, unless they came from this pi session. */
function importable(entry: Entry, origin: string): Message[] {
	if (entry.kind === "pi.system" || entry.kind === "pi.reset" || entry.kind === "pi.compaction") return [];
	if (entry.kind === "syncpi.pi" && entry.data?.origin === origin) return [];
	return (entry.model ?? []).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

/** Splits a batch of recorded messages into frames of at most about 4 MB. */
function frames(messages: RecordedMessage[]): RecordedMessage[][] {
	const out: RecordedMessage[][] = [];
	let frame: RecordedMessage[] = [];
	let size = 0;
	for (const m of messages) {
		const bytes = JSON.stringify(m).length;
		if (frame.length > 0 && size + bytes > 4 * 1024 * 1024) {
			out.push(frame);
			frame = [];
			size = 0;
		}
		frame.push(m);
		size += bytes;
	}
	if (frame.length > 0) out.push(frame);
	return out;
}

class Sync {
	readonly live: LiveSession;
	readonly record: SessionRecord;
	/** This pi session's id: what its recorded messages are known by in the thread. */
	readonly origin: string;
	readonly #pi: ExtensionAPI;
	#ctx: ExtensionContext;
	/** The newest thread entry this session has taken in. */
	#seen: number;
	#seenWaiters: { upTo: number; resolve: () => void }[] = [];
	/** Messages of this session already recorded into the thread, by id. */
	readonly #recorded = new Set<string>();
	readonly #requests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	#turn: "none" | "asking" | "held" = "none";
	/** The server didn't answer a request for the turn: it's from before /sync, and pi runs without the turn. */
	#unanswered = false;
	#grant: { requestId: string; resolve: (upTo: number) => void; asked?: boolean } | undefined;
	/** Steers passed to this pi by others, by text: their ids, so the thread knows whose they are. */
	readonly #steers = new Map<string, string>();
	/** The thread's first snapshot and the history before it, taken in together. */
	#first: Entry[] | undefined = [];
	#liveTimer: NodeJS.Timeout | undefined;
	#liveMessage: unknown;
	#target = "";
	#flushing: Promise<void> = Promise.resolve();
	/** Other people's unsent drafts (shared live, as in syncpi's composer), by whose they are. */
	readonly #drafts = new Map<string, { name: string; doc: Y.Doc; changed: number }>();
	#typingTimer: NodeJS.Timeout | undefined;
	/** Drafts arriving whole right after a (re)connect aren't someone typing. */
	#draftsFrom = 0;
	me = "";
	#meId = "";

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, record: SessionRecord) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.record = record;
		this.origin = ctx.sessionManager.getSessionId();
		// Where this session left off: the newest thread entry it took in.
		this.#seen = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom_message" && entry.customType === MESSAGE) this.#seen = Math.max(this.#seen, (entry.details as Imported | undefined)?.entryId ?? 0);
		}
		this.live = new LiveSession(record);
		this.live.onMessage = (message) => this.#onMessage(message);
		this.live.conn.onState = (state) => {
			if (state === "closed") this.live.device.disconnected();
			this.#status();
		};
	}

	set ctx(ctx: ExtensionContext) {
		this.#ctx = ctx;
	}

	start(): void {
		this.live.start();
		this.#status();
	}

	close(): void {
		clearTimeout(this.#liveTimer);
		clearTimeout(this.#typingTimer);
		this.#ctx.ui.setWidget(TYPING, undefined);
		for (const request of this.#requests.values()) request.reject(new Error("syncpi: closed"));
		this.#requests.clear();
		this.live.close();
		this.#ctx.ui.setStatus(STATUS, undefined);
	}

	get holding(): boolean {
		return this.#turn === "held";
	}

	#status(): void {
		const conn = this.live.conn.state;
		const text =
			conn !== "open" ? `syncpi: ${conn === "connecting" ? "connecting" : "offline"}` : this.#turn === "asking" ? `syncpi: waiting for the turn${this.#target ? ` (${this.#target})` : ""}` : this.#target ? `syncpi: ${this.#target}` : "syncpi";
		this.#ctx.ui.setStatus(STATUS, text);
	}

	#onMessage(message: ServerMessage): void {
		switch (message.type) {
			case "welcome":
				this.me = message.me.name;
				this.#meId = message.me.id;
				this.#drafts.clear();
				this.#draftsFrom = Date.now() + 1_000;
				// A fresh snapshot follows: take in what's new since, with the history before it.
				this.#first = [];
				return;
			case "events": {
				if (message.conv !== "main") return;
				for (const event of message.events as { type: string; entries?: Entry[]; entry?: Entry }[]) {
					if (event.type === "snapshot") {
						if (this.#first === undefined) this.#take(event.entries ?? []);
						else {
							this.#first.push(...(event.entries ?? []));
							// The history (from before a /new or a summary) comes right after the snapshot.
							setTimeout(() => this.#takeFirst(), 400);
						}
					} else if (event.entry !== undefined && (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "entry_appended")) this.#take([event.entry]);
				}
				return;
			}
			case "history":
				if (message.conv !== "main") return;
				if (this.#first !== undefined) this.#first.push(...(message.entries as Entry[]));
				else this.#take(message.entries as Entry[]);
				return;
			case "target":
				this.#target = this.#turn === "held" ? "" : message.label.endsWith(`${this.me}'s pi`) ? "" : message.label;
				return this.#status();
			case "turn":
				if (this.#grant?.requestId !== message.requestId) return;
				if (message.upTo === undefined) this.#grant.asked = true;
				else this.#grant.resolve(message.upTo);
				return;
			case "piControl":
				if (message.action === "stop") {
					this.#ctx.ui.notify(`${message.by} stopped this turn`, "warning");
					this.#ctx.abort();
				} else {
					this.#steers.set(message.text, message.id);
					this.#pi.sendUserMessage(message.text, { deliverAs: "steer" });
				}
				return;
			case "draft": {
				if (message.owner === this.#meId) return;
				let draft = this.#drafts.get(message.owner);
				if (draft === undefined) this.#drafts.set(message.owner, (draft = { name: message.name, doc: new Y.Doc(), changed: 0 }));
				draft.name = message.name;
				if (message.update !== undefined) {
					Y.applyUpdate(draft.doc, fromBase64(message.update));
					if (Date.now() > this.#draftsFrom) draft.changed = Date.now();
				}
				return this.#typing();
			}
			case "accepted":
				this.#requests.get(message.requestId)?.resolve();
				this.#requests.delete(message.requestId);
				return;
			case "error":
				if (message.requestId !== undefined && this.#requests.has(message.requestId)) {
					this.#requests.get(message.requestId)!.reject(new Error(message.message));
					this.#requests.delete(message.requestId);
				} else this.#ctx.ui.notify(`syncpi: ${message.message}`, "error");
				return;
			case "notice":
				return this.#ctx.ui.notify(message.text, "info");
			case "invite":
				return this.#ctx.ui.notify(`Share this link: ${message.url}\nOthers open it in a browser, or run: syncpi --url ${message.url}`, "info");
			case "removed":
				this.#ctx.ui.notify("You were removed from the syncpi session.", "warning");
				return this.close();
			default:
				return;
		}
	}

	/**
	 * Who is writing a message, above the editor: "Bob is typing…" and the end of what they've written so far, or
	 * "Bob has a draft" once they pause. Not commands (/…, !…), as in syncpi's own clients.
	 */
	#typing(): void {
		clearTimeout(this.#typingTimer);
		const now = Date.now();
		const lines: string[] = [];
		let typing = false;
		for (const { name, doc, changed } of this.#drafts.values()) {
			const text = draftText(doc).toString().replace(/\s+/g, " ").trim();
			if (text === "" || isCommand(text)) continue;
			const active = now - changed < TYPING_MS;
			typing ||= active;
			lines.push(`${name} ${active ? "is typing…" : "has a draft"}  ${text.length > 80 ? `…${text.slice(-80)}` : text}`);
		}
		this.#ctx.ui.setWidget(TYPING, lines.length > 0 ? lines : undefined);
		// "is typing" becomes "has a draft" when they stop.
		if (typing) this.#typingTimer = setTimeout(() => this.#typing(), TYPING_MS);
	}

	#takeFirst(): void {
		const first = this.#first;
		if (first === undefined) return;
		this.#first = undefined;
		this.#take(first);
		// Now the thread has what this session had before, too (on the first /sync, all of it).
		void this.flush().catch((error: Error) => this.#ctx.ui.notify(`syncpi: ${error.message}`, "error"));
	}

	/** Takes in thread entries this session doesn't have yet: other people's turns. */
	#take(entries: Entry[]): void {
		for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
			if (entry.id <= this.#seen) continue;
			this.#seen = entry.id;
			for (const message of importable(entry, this.origin)) {
				const details: Imported = { entryId: entry.id, message, ...(entry.data?.author ? { author: entry.data.author } : {}) };
				this.#pi.sendMessage({ customType: MESSAGE, content: plain(details), display: true, details }, this.#ctx.isIdle() ? undefined : { deliverAs: "steer" });
			}
		}
		this.#seenWaiters = this.#seenWaiters.filter((w) => (w.upTo <= this.#seen ? (w.resolve(), false) : true));
	}

	#request(message: { type: "record" | "invite"; requestId: string } & Record<string, unknown>): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#requests.set(message.requestId, { resolve, reject });
			this.live.conn.send(message as never);
			setTimeout(() => {
				if (!this.#requests.delete(message.requestId)) return;
				reject(new Error(message.type === "record" ? OLD_SERVER : "the server didn't answer"));
			}, REQUEST_MS);
		});
	}

	/**
	 * Records this session's messages that the thread doesn't have yet, in order. `nextTick`: once pi has saved the
	 * message it's ending (it does right after its message_end handlers), with anything live waiting behind it.
	 */
	flush(nextTick = false): Promise<void> {
		const next = this.#flushing.then(async () => {
			if (nextTick) await new Promise((r) => setTimeout(r, 0));
			await this.#flush();
		});
		this.#flushing = next.catch(() => {});
		return next;
	}

	async #flush(): Promise<void> {
		const out: RecordedMessage[] = [];
		for (const entry of this.#ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			if (entry.type === "custom_message" && entry.customType === MESSAGE) continue;
			convertToLlm(sessionEntryToContextMessages(entry)).forEach((message, i) => {
				const id = i === 0 ? entry.id : `${entry.id}:${i}`;
				// pi's system messages (its prompt and tools) aren't the thread's: the server's agent has its own.
				if (this.#recorded.has(id) || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) return;
				const steer = message.role === "user" ? this.#steers.get(textOf(message.content as Message["content"])) : undefined;
				out.push({ id, message, ...(steer !== undefined ? { steer } : {}) });
			});
		}
		for (const frame of frames(out)) {
			await this.#request({ type: "record", requestId: randomUUID(), origin: this.origin, messages: frame });
			for (const m of frame) {
				this.#recorded.add(m.id);
				if (m.steer !== undefined) this.#steers.delete(textOf((m.message as Message).content));
			}
		}
	}

	/** Takes the turn on the thread before pi runs; resolves once pi may (or right away when offline). */
	async takeTurn(): Promise<void> {
		if (this.#turn !== "none" || this.#unanswered || this.live.conn.state !== "open") return;
		const requestId = randomUUID();
		this.#turn = "asking";
		this.#status();
		try {
			const upTo = await new Promise<number | undefined>((resolve) => {
				this.#grant = { requestId, resolve };
				this.live.conn.send({ type: "turn", requestId, action: "start" });
				// The server says at once that it heard; one from before /sync says nothing.
				setTimeout(() => {
					if (this.#grant?.requestId === requestId && !this.#grant.asked) resolve(undefined);
				}, ANSWER_MS);
			});
			if (upTo === undefined) {
				this.#unanswered = true;
				this.#ctx.ui.notify(`syncpi: ${OLD_SERVER}`, "warning");
				return;
			}
			// What other people's turns added before this one should be in this session first. (Not every entry
			// reaches clients, so this waits at most a moment.)
			await Promise.race([new Promise<void>((resolve) => (upTo <= this.#seen ? resolve() : this.#seenWaiters.push({ upTo, resolve }))), new Promise((r) => setTimeout(r, 2_000))]);
			this.#turn = "held";
			this.#target = "";
		} finally {
			this.#grant = undefined;
			if (this.#turn === "asking") this.#turn = "none";
			this.#status();
		}
	}

	/** pi is done: the thread gets the rest of this turn, then the turn back. */
	async giveBack(): Promise<void> {
		if (this.#turn !== "held") return;
		clearTimeout(this.#liveTimer);
		this.#liveTimer = undefined;
		try {
			await this.flush();
		} finally {
			this.#turn = "none";
			this.live.conn.send({ type: "turn", requestId: randomUUID(), action: "end" });
			this.#status();
		}
	}

	/** While pi has the turn: its partial answer, at most every 100 ms. */
	liveMessage(message: unknown): void {
		if (this.#turn !== "held") return;
		this.#liveMessage = message;
		this.#liveTimer ??= setTimeout(() => {
			this.#liveTimer = undefined;
			this.#sendLive([{ type: "message_update", message: this.#liveMessage }]);
		}, 100);
	}

	liveTool(event: LiveEvent): void {
		if (this.#turn === "held") this.#sendLive([event]);
	}

	/** After what's being recorded: the thread then has the message a tool's call came in before the tool runs. */
	#sendLive(events: LiveEvent[]): void {
		void this.#flushing.then(() => {
			if (this.#turn === "held" && this.live.conn.state === "open") this.live.conn.send({ type: "live", events });
		});
	}

	invite(email?: string): Promise<void> {
		return this.#request({ type: "invite", requestId: randomUUID(), ...(email ? { email } : {}) });
	}
}

/** The text a thread message stands for, if pi ever shows or sends it as is. */
function plain(item: Imported): string {
	const { message, author } = item;
	if (message.role === "toolResult") return `[${message.toolName ?? "tool"} result] ${textOf(message.content)}`;
	if (message.role === "assistant") return textOf(message.content);
	return `${author ? `${author}: ` : ""}${textOf(message.content)}`;
}

/** How a thread message shows in the transcript. */
function render(item: Imported, expanded: boolean, theme: { fg(color: string, text: string): string; bold(text: string): string }): string {
	const { message } = item;
	const clip = (text: string, lines: number) => {
		const all = text.trim().split("\n");
		return expanded || all.length <= lines ? all.join("\n") : `${all.slice(0, lines).join("\n")}\n${theme.fg("dim", `… ${all.length - lines} more lines`)}`;
	};
	if (message.role === "user") {
		// The model sees "[Name, …] text"; people see the name and what they wrote.
		const text = textOf(message.content).replace(/^\[[^\]]*\]\s*/, "");
		return `${theme.bold(theme.fg("accent", item.author ?? "someone"))} ${theme.fg("dim", "· syncpi")}\n${clip(text, 12)}`;
	}
	if (message.role === "assistant") {
		const calls = typeof message.content === "string" ? [] : message.content.filter((b) => b.type === "toolCall");
		const text = textOf(message.content);
		const lines = calls.map((c) => theme.fg("dim", `→ ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 120)}`));
		const by = theme.fg("dim", `syncpi agent${message.model ? ` (${message.provider ? `${message.provider}/` : ""}${message.model})` : ""}`);
		return [by, text ? clip(text, 20) : "", ...lines].filter((l) => l !== "").join("\n");
	}
	const output = textOf(message.content);
	return theme.fg(message.isError ? "error" : "dim", `${message.isError ? "✗" : "✓"} ${message.toolName ?? "tool"}${output ? `\n${clip(output, expanded ? 400 : 3)}` : ""}`);
}

/**
 * `/sync` options: --local (a server on this machine), --faux (a local one with a scripted model), --vm, --model, and
 * --name (yours in the session; git's user.name by default).
 */
function parseOptions(args: string[]): StartOptions {
	const options: StartOptions = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--local") options.local = true;
		else if (args[i] === "--faux") options.faux = true;
		else if (args[i] === "--vm") options.vm = args[++i];
		else if (args[i] === "--model") options.model = args[++i];
		else if (args[i] === "--name") options.owner = { name: args[++i] ?? "" };
	}
	return options;
}

export default function syncpi(pi: ExtensionAPI): void {
	let sync: Sync | undefined;

	const link = (ctx: ExtensionContext): Link | undefined => {
		const entries = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === LINK);
		return (entries.at(-1) as { data?: Link } | undefined)?.data;
	};

	async function connect(ctx: ExtensionContext, options: StartOptions, quiet = false): Promise<void> {
		const dir = realpathSync(ctx.cwd);
		let record = await openSession(dir, { ...options, say: (text) => ctx.ui.notify(text, "info") });
		ctx.ui.setStatus(STATUS, "syncpi: setting up");
		record = await whenReady(record, (step) => ctx.ui.setStatus(STATUS, `syncpi: ${step}`));
		sync?.close();
		sync = new Sync(pi, ctx, record);
		const linked = link(ctx);
		if (linked?.id !== record.id || linked.stopped) pi.appendEntry<Link>(LINK, { id: record.id, url: record.url });
		sync.start();
		if (!quiet) ctx.ui.notify(`Synced with ${record.url}. /session-share makes a link for others to join.`, "info");
	}

	pi.registerCommand("sync", {
		description: "Share this session through syncpi: /sync [--local] [--vm name] · /sync stop · /sync status",
		getArgumentCompletions: (prefix) =>
			["stop", "status", "--local", "--vm"].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words[0] === "stop") {
				if (sync === undefined) return ctx.ui.notify("This session isn't synced.", "info");
				await sync.giveBack().catch(() => {});
				sync.close();
				sync = undefined;
				pi.appendEntry<Link>(LINK, { stopped: true });
				return ctx.ui.notify("Stopped syncing. The session keeps everything so far, and runs locally from here.", "info");
			}
			if (words[0] === "status") {
				if (sync === undefined) return ctx.ui.notify("This session isn't synced. /sync shares it.", "info");
				return ctx.ui.notify(`Synced with ${sync.record.url} (${sync.live.conn.state}) as ${sync.me || "you"}.\nThe web view: ${sync.record.url}/#token=${sync.record.token}`, "info");
			}
			try {
				await connect(ctx, parseOptions(words));
			} catch (error) {
				ctx.ui.setStatus(STATUS, undefined);
				ctx.ui.notify(`syncpi: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("session-share", {
		description: "A link for others to join this synced session (editors, for 7 days)",
		handler: async (_args, ctx) => {
			if (sync === undefined) return ctx.ui.notify("Run /sync first.", "info");
			await sync.invite().catch((error: Error) => ctx.ui.notify(`syncpi: ${error.message}`, "error"));
		},
	});

	pi.registerCommand("invite", {
		description: "Invite someone by email to this synced session (they sign in with exe.dev)",
		handler: async (args, ctx) => {
			if (sync === undefined) return ctx.ui.notify("Run /sync first.", "info");
			const email = args.trim();
			if (!email.includes("@")) return ctx.ui.notify("usage: /invite name@example.com", "info");
			await sync.invite(email).catch((error: Error) => ctx.ui.notify(`syncpi: ${error.message}`, "error"));
		},
	});

	// A session that was synced when it was last open syncs again.
	pi.on("session_start", async (_event, ctx) => {
		const linked = link(ctx);
		if (linked?.id === undefined || linked.stopped) return;
		if (findByDir(realpathSync(ctx.cwd))?.id !== linked.id) return;
		await connect(ctx, {}, true).catch((error: Error) => ctx.ui.notify(`syncpi: couldn't reconnect: ${error.message}`, "warning"));
	});
	pi.on("session_shutdown", () => {
		sync?.close();
		sync = undefined;
	});

	// Before pi runs, it takes the turn on the thread.
	pi.on("input", async (event, ctx) => {
		if (sync === undefined || event.source === "extension" || event.streamingBehavior !== undefined) return { action: "continue" };
		sync.ctx = ctx;
		await sync.takeTurn();
		return { action: "continue" };
	});
	pi.on("agent_start", (_event, ctx) => {
		if (sync === undefined) return;
		sync.ctx = ctx;
		// A run that didn't start from what you typed (another extension's) takes the turn as well.
		if (!sync.holding) void sync.takeTurn();
	});
	pi.on("message_update", (event) => sync?.liveMessage(event.message));
	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId === undefined) sync?.liveTool({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});
	pi.on("tool_execution_update", (event) => {
		if (event.parentToolCallId !== undefined) return;
		const output = textOf(((event.partialResult as { content?: Block[] } | undefined)?.content ?? []) as Block[]);
		sync?.liveTool({ type: "tool_execution_update", toolCallId: event.toolCallId, output });
	});
	// Each message is recorded as soon as pi has saved it (right after this event), so the thread has them in order.
	pi.on("message_end", () => {
		if (sync?.holding) void sync.flush(true).catch(() => {});
	});
	pi.on("agent_settled", async () => {
		await sync?.giveBack().catch(() => {});
	});

	// Other people's turns reach the model as the messages they were.
	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((m) => {
			if (m.role !== "custom" || m.customType !== MESSAGE) return m;
			const message = (m.details as Imported | undefined)?.message;
			if (message === undefined) return m;
			changed = true;
			return message as never;
		});
		return changed ? { messages } : undefined;
	});

	pi.registerMessageRenderer<Imported>(MESSAGE, (message, options, theme) => (message.details ? new Text(render(message.details, options.expanded, theme), 1, 0) : undefined));
}
