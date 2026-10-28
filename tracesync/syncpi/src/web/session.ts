// The web view's live session: one WebSocket (reconnecting, each time from a fresh snapshot), the state it carries,
// and an outbox so a message typed while offline is sent once the connection is back. Views subscribe to the parts
// they show; this module knows nothing about the DOM.
import type { Attachment, BranchInfo, ClientMessage, ConvName, EnvStatus, InviteInfo, Member, Presence, ServerMessage, SessionInfo, Where } from "../shared/protocol.ts";
import { Thread } from "../shared/thread.ts";
import { storage } from "./dom.ts";

export type Change = "session" | "thread" | "people" | "env" | "invites" | "branches" | "files" | "connection" | "target";

type Submit = Extract<ClientMessage, { type: "submit" }>;

/** WebSocket close code for a member who was removed. */
const REMOVED = 4001;

export class SessionClient {
	readonly threads: Record<ConvName, Thread> = { main: new Thread(), setup: new Thread() };
	info: SessionInfo | undefined;
	me: Member | undefined;
	members: Member[] = [];
	online: Presence[] = [];
	env: EnvStatus = { status: "pending" };
	invites: InviteInfo[] = [];
	branches: BranchInfo[] = [];
	currentBranch = 0;
	/** Project files, for @ completion. */
	files: string[] = [];
	/** Where the current run's tools execute. */
	target = "";
	connection: "connecting" | "open" | "reconnecting" | "removed" = "connecting";
	/** Messages sent but not yet acknowledged by the server; resent after a reconnect, kept across reloads. */
	readonly outbox = new Map<string, Submit>();
	/** Current names by member id, so a renamed person shows under their new name everywhere. */
	names = new Map<string, string>();

	onInvite: (url: string, invite: InviteInfo) => void = () => {};
	onNotice: (text: string) => void = () => {};
	onError: (message: string) => void = () => {};

	readonly #token: string;
	readonly #storageKey: string;
	readonly #listeners = new Map<Change, Set<() => void>>();
	#ws: WebSocket | undefined;
	#retry = 0;

	constructor(token: string, storageKey: string) {
		this.#token = token;
		this.#storageKey = storageKey;
		try {
			for (const m of JSON.parse(storage.get(`outbox:${storageKey}`) ?? "[]") as Submit[]) this.outbox.set(m.requestId, m);
		} catch {}
	}

	on(change: Change, fn: () => void): void {
		let set = this.#listeners.get(change);
		if (set === undefined) this.#listeners.set(change, (set = new Set()));
		set.add(fn);
	}

	#emit(...changes: Change[]): void {
		for (const change of changes) for (const fn of this.#listeners.get(change) ?? []) fn();
	}

	/** This browser's member token, for the session's HTTP API (files, models). */
	get token(): string {
		return this.#token;
	}

	get role(): Member["role"] | undefined {
		return this.me?.role;
	}

	nameOf(memberId: string | undefined, fallback = "someone"): string {
		return (memberId !== undefined ? this.names.get(memberId) : undefined) ?? fallback;
	}

	connect(): void {
		const url = new URL(`ws?client=web&token=${encodeURIComponent(this.#token)}`, document.baseURI);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		this.#ws = ws;
		ws.onopen = () => {
			this.#retry = 0;
			this.#setConnection("open");
			for (const m of this.outbox.values()) this.send(m);
		};
		ws.onmessage = (event) => this.#receive(JSON.parse(String(event.data)) as ServerMessage);
		ws.onclose = (event) => {
			if (this.#ws !== ws) return;
			if (event.code === REMOVED) {
				storage.remove(this.#storageKey);
				this.#setConnection("removed");
				return;
			}
			this.#setConnection("reconnecting");
			setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** this.#retry++));
		};
	}

	#setConnection(state: SessionClient["connection"]): void {
		this.connection = state;
		this.#emit("connection");
	}

	send(message: ClientMessage): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
	}

	/** Sends a message to the agent; it stays in the outbox until the server acknowledges it. */
	submit(text: string, mode: "followUp" | "steer", where: Where, attachments: Attachment[] = []): void {
		const message: Submit = { type: "submit", requestId: crypto.randomUUID(), text, mode, where, ...(attachments.length > 0 ? { attachments } : {}) };
		this.outbox.set(message.requestId, message);
		this.#saveOutbox();
		this.send(message);
		this.#emit("thread");
	}

	/** Survives a reload, except messages with attachments: those can be megabytes, more than storage holds. */
	#saveOutbox(): void {
		storage.set(`outbox:${this.#storageKey}`, JSON.stringify([...this.outbox.values()].filter((m) => !m.attachments?.length)));
	}

	#settle(requestId: string | undefined): void {
		if (requestId === undefined || !this.outbox.delete(requestId)) return;
		this.#saveOutbox();
		this.#emit("thread");
	}

	#setMembers(list: Member[]): void {
		this.members = list;
		const mine = list.find((m) => m.id === this.me?.id);
		if (mine !== undefined) this.me = mine;
		this.names = new Map(list.map((m) => [m.id, m.name]));
	}

	#receive(message: ServerMessage): void {
		switch (message.type) {
			case "welcome":
				this.info = message.session;
				this.me = message.me;
				this.#setMembers(message.members);
				return this.#emit("session", "people");
			case "events":
				this.threads[message.conv].apply(message.events);
				return this.#emit("thread");
			case "history":
				this.threads[message.conv].prepend(message.entries);
				return this.#emit("thread");
			case "presence":
				this.online = message.online;
				this.#setMembers(message.members);
				return this.#emit("people", "thread");
			case "env":
				this.env = message.env;
				return this.#emit("env");
			case "files": {
				const names = new Set(message.full ? [] : this.files);
				for (const [path, hash] of Object.entries(message.changed)) {
					if (hash === null) names.delete(path);
					else names.add(path);
				}
				this.files = [...names].sort();
				return this.#emit("files");
			}
			case "invite":
				this.onInvite(message.url, message.invite);
				return this.send({ type: "invites" });
			case "invites":
				this.invites = message.invites;
				return this.#emit("invites");
			case "branches":
				this.branches = message.branches;
				this.currentBranch = message.current;
				return this.#emit("branches");
			case "target":
				this.target = message.label;
				return this.#emit("target");
			case "accepted":
				return this.#settle(message.requestId);
			case "notice":
				return this.onNotice(message.text);
			case "error":
				this.#settle(message.requestId);
				return this.onError(message.message);
			case "removed":
				return;
			default:
				return;
		}
	}
}
