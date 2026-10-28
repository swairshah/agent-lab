// The web view's live session: one WebSocket (reconnecting, each time from a fresh snapshot), the state it carries,
// and an outbox so a message typed while offline is sent once the connection is back. Views subscribe to the parts
// they show; this module knows nothing about the DOM.
import type { Attachment, BranchInfo, ClientMessage, LineComment, ConvName, EnvStatus, InviteInfo, LandInfo, Member, Presence, ServerMessage, SessionInfo, View, Where } from "../shared/protocol.ts";
import { draftText, fromBase64, replaceText, toBase64, Y } from "../shared/drafts.ts";
import { Thread } from "../shared/thread.ts";
import { storage } from "./dom.ts";

export type Change = "session" | "thread" | "people" | "env" | "invites" | "branches" | "files" | "connection" | "target" | "drafts" | "land" | "views" | "docs";

type Submit = Extract<ClientMessage, { type: "submit" }>;

/** WebSocket close code for a member who was removed. */
const REMOVED = 4001;

/** The origin of draft changes that came from the server, so they aren't sent back. */
const REMOTE = Symbol("remote");

/** `at`: when it last moved here, so its name can show for a moment, then fade. */
export type Caret = { name: string; owner: string; anchor?: unknown; head?: unknown; at: number };

export class SessionClient {
	readonly threads: Record<ConvName, Thread> = { main: new Thread(), setup: new Thread(), land: new Thread() };
	info: SessionInfo | undefined;
	me: Member | undefined;
	members: Member[] = [];
	online: Presence[] = [];
	env: EnvStatus = { status: "pending" };
	invites: InviteInfo[] = [];
	branches: BranchInfo[] = [];
	currentBranch = 0;
	/** Project files, for @ completion and the project tree. */
	files: string[] = [];
	/** Each project file's content hash, so an open file can tell it changed. */
	readonly hashes = new Map<string, string>();
	/** The latest land subthread and how it went; null before the first. */
	land: LandInfo | null = null;
	/** Where the current run's tools execute. */
	target = "";
	connection: "connecting" | "open" | "reconnecting" | "removed" = "connecting";
	/** Messages sent but not yet acknowledged by the server; resent after a reconnect, kept across reloads. */
	readonly outbox = new Map<string, Submit>();
	/** Unsent drafts, everyone's, by their writer's member id (shared/drafts.ts). */
	readonly drafts = new Map<string, { name: string; doc: Y.Doc }>();
	/** Where other people's cursors are, by member id: in whose draft, or which file ("file:<path>"). */
	readonly carets = new Map<string, Caret>();
	/** Project files being written together that this page has open, by path (drafts.ts), and how many uses each. */
	readonly fileDocs = new Map<string, { doc: Y.Doc; uses: number; pending?: string }>();
	/** Where other people are in the app, by member id, for following them. */
	readonly views = new Map<string, { name: string; view: View }>();
	/** Current names by member id, so a renamed person shows under their new name everywhere. */
	names = new Map<string, string>();

	onInvite: (url: string, invite: InviteInfo) => void = () => {};
	onNotice: (text: string) => void = () => {};
	onError: (message: string) => void = () => {};
	/** Someone (`by`) sent `owner`'s draft to the agent. */
	onDraftSent: (owner: string, by: string) => void = () => {};

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

	off(change: Change, fn: () => void): void {
		this.#listeners.get(change)?.delete(fn);
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
			// The server may have restarted, or missed changes made offline: it merges each draft whole.
			for (const [owner, { doc }] of this.drafts) if (draftText(doc).length > 0 || owner === this.me?.id) this.send({ type: "draft", owner, update: toBase64(Y.encodeStateAsUpdate(doc)) });
			// Files open to edit start again from the server's document (it may have made a new one from the file), and
			// what was typed here meanwhile goes in as a change to it.
			for (const [path, entry] of this.fileDocs) {
				entry.pending = draftText(entry.doc).toString();
				entry.doc.destroy();
				entry.doc = this.#fileDoc(path);
				this.send({ type: "fileDoc", path, open: true });
			}
			if (this.fileDocs.size > 0) this.#emit("docs");
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

	/** The shared text named `key`: a member's draft (by member id), or a file being edited ("file:<path>"). */
	doc(key: string): Y.Doc {
		return key.startsWith("file:") ? this.openFile(key.slice(5), false) : this.draft(key);
	}

	/**
	 * A project file's live document, to edit with everyone who has it open: it fills in from the server, and changes
	 * made here go to the file. `use`: one more use of it here; closeFile() ends it.
	 */
	openFile(path: string, use = true): Y.Doc {
		let entry = this.fileDocs.get(path);
		if (entry === undefined) {
			this.fileDocs.set(path, (entry = { doc: this.#fileDoc(path), uses: 0 }));
			this.send({ type: "fileDoc", path, open: true });
		}
		if (use) entry.uses++;
		return entry.doc;
	}

	#fileDoc(path: string): Y.Doc {
		const doc = new Y.Doc();
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) this.send({ type: "fileDoc", path, update: toBase64(update) });
		});
		return doc;
	}

	closeFile(path: string): void {
		const entry = this.fileDocs.get(path);
		if (entry === undefined || --entry.uses > 0) return;
		this.fileDocs.delete(path);
		entry.doc.destroy();
		this.send({ type: "fileDoc", path, open: false });
	}

	/** A member's draft, to read and to write in: changes made here go to everyone. */
	draft(owner: string): Y.Doc {
		let entry = this.drafts.get(owner);
		if (entry === undefined) {
			const doc = new Y.Doc();
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin !== REMOTE) this.send({ type: "draft", owner, update: toBase64(update) });
				this.#emit("drafts");
			});
			this.drafts.set(owner, (entry = { name: this.nameOf(owner), doc }));
		}
		return entry.doc;
	}

	/**
	 * Sends a message to the agent; it stays in the outbox until the server acknowledges it. "interrupt" stops the
	 * current run for it (as in Delta). `draft`: whose shared draft it was.
	 */
	submit(text: string, mode: "interrupt" | "followUp" | "steer", where: Where, attachments: Attachment[] = [], comments: LineComment[] = [], draft?: string, conv?: "land"): void {
		const message: Submit = {
			type: "submit",
			requestId: crypto.randomUUID(),
			text,
			mode,
			where,
			...(draft !== undefined ? { draft } : {}),
			...(conv !== undefined ? { conv } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
			...(comments.length > 0 ? { comments } : {}),
		};
		this.outbox.set(message.requestId, message);
		this.#saveOutbox();
		this.send(message);
		this.#emit("thread");
	}

	/** Survives a reload, except messages with attachments: those can be megabytes, more than storage holds. */
	#saveOutbox(): void {
		storage.set(`outbox:${this.#storageKey}`, JSON.stringify([...this.outbox.values()].filter((m) => !m.attachments?.length)));
	}

	/** Messages already in the thread are sent, acknowledged or not (an acknowledgment can be lost on a reconnect). */
	#arrived(): void {
		if (this.outbox.size === 0) return;
		let changed = false;
		for (const item of this.threads.main.state.items) {
			if (item.kind === "user" && item.requestId !== undefined && this.outbox.delete(item.requestId)) changed = true;
		}
		if (changed) this.#saveOutbox();
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
				// The server sends the cursors and views again after this; drafts are merged, so they stay.
				this.carets.clear();
				this.views.clear();
				this.info = message.session;
				this.me = message.me;
				this.#setMembers(message.members);
				return this.#emit("session", "people");
			case "events":
				this.threads[message.conv].apply(message.events);
				this.#arrived();
				return this.#emit("thread");
			case "history":
				this.threads[message.conv].prepend(message.entries);
				this.#arrived();
				return this.#emit("thread");
			case "draft": {
				const doc = this.draft(message.owner);
				this.drafts.get(message.owner)!.name = message.name;
				if (message.update !== undefined) Y.applyUpdate(doc, fromBase64(message.update), REMOTE);
				if (message.sent !== undefined) this.onDraftSent(message.owner, message.sent);
				return this.#emit("drafts");
			}
			case "fileDoc": {
				const entry = this.fileDocs.get(message.path);
				if (entry === undefined) return;
				Y.applyUpdate(entry.doc, fromBase64(message.update), REMOTE);
				// Back after a reconnect: what was typed here meanwhile.
				if (entry.pending !== undefined) {
					const typed = entry.pending;
					entry.pending = undefined;
					replaceText(draftText(entry.doc), typed, "offline");
				}
				return this.#emit("drafts");
			}
			case "view":
				if (message.view === null) this.views.delete(message.memberId);
				else this.views.set(message.memberId, { name: message.name, view: message.view });
				return this.#emit("views");
			case "caret":
				if (message.memberId === this.me?.id) return;
				if (message.owner === undefined) this.carets.delete(message.memberId);
				else this.carets.set(message.memberId, { name: message.name, owner: message.owner, anchor: message.anchor, head: message.head, at: Date.now() });
				return this.#emit("drafts");
			case "presence":
				this.online = message.online;
				this.#setMembers(message.members);
				return this.#emit("people", "thread");
			case "env":
				this.env = message.env;
				return this.#emit("env");
			case "land":
				this.land = message.land;
				return this.#emit("land");
			case "files": {
				const names = new Set(message.full ? [] : this.files);
				if (message.full) this.hashes.clear();
				for (const [path, hash] of Object.entries(message.changed)) {
					if (hash === null) {
						names.delete(path);
						this.hashes.delete(path);
					} else {
						names.add(path);
						this.hashes.set(path, hash);
					}
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
