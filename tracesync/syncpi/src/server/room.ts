// One session as the server hosts it: its pi-durable Session, the people connected to it, their machines, and its
// HTTP routes. A server holds one room (a local session, or a session with a VM of its own) or many (a shared host
// VM, where each session lives under /<id>/).
//   <base>/ws?token=…              the live thread, presence, setup status and file changes (WebSocket, JSON frames)
//   <base>/api/join                join with an invite (a link, or an email invite plus exe.dev sign-in)
//   <base>/api/exe-login           sign a browser in by its exe.dev email, for existing members
//   <base>/api/cli-login, /cli-login/<code>   a terminal signs in through the browser (email invites)
//   <base>/api/file                read, write (compare-and-swap on the content hash) and delete project files
//   <base>/api/snapshot.tgz        the whole project, for a collaborator's first checkout
//   <base>/, <base>/s/<code>       the web view
//
// Roles are checked here, for every message and request: viewers read, editors also talk to the agent and edit files,
// admins also manage people and invites. The session's creator is an admin who can't be removed or demoted.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { type AgentEvent, type AgentEventStream, LiveDoc } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { hashBytes, listFiles, MAX_FILE_BYTES, safePath } from "../shared/files.ts";
import { type ClientMessage, type ConvName, type InviteInfo, type PiContext, type Presence, parseChannelFrame, ROLES, type Role, type ServerMessage } from "../shared/protocol.ts";
import { type DeviceClient, Devices } from "./devices.ts";
import { context, Session } from "./session.ts";
import { StateFile, type StoredMember, token } from "./state.ts";

type Client = {
	member: StoredMember;
	kind: "cli" | "web";
	ws: WebSocket;
	watches: Partial<Record<ConvName, AgentEventStream>>;
	device?: DeviceClient & { label: string };
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const atLeast = (member: StoredMember, role: Role) => RANK[member.role] >= RANK[role];

/** How many entries from before the current context a client gets when it attaches. */
const HISTORY = 500;

/** WebSocket close code for a member who was removed; clients stop reconnecting. */
export const REMOVED = 4001;

export function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage, url: URL): string | undefined {
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ")) return header.slice(7);
	return url.searchParams.get("token") ?? undefined;
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
	return JSON.parse((await body(req, 64 * 1024)).toString("utf8") || "{}") as T;
}

/**
 * The exe.dev account of the person behind a request, from the headers exe.dev's proxy adds after "Login with exe".
 * The proxy reaches the server over loopback, so a process on the VM could send these headers too; anyone who can run
 * commands on the VM is already trusted that far (see README).
 */
function exeIdentity(req: IncomingMessage): { email: string; userId: string } | undefined {
	const email = req.headers["x-exedev-email"];
	const userId = req.headers["x-exedev-userid"];
	if (typeof email !== "string" || email.length === 0) return undefined;
	return { email: email.trim().toLowerCase(), userId: typeof userId === "string" ? userId : "" };
}

/** exe.dev's sign-in page, returning to `path` (on this VM's domain). */
function exeLogin(path: string): string {
	return `/__exe.dev/login?redirect=${encodeURIComponent(path)}`;
}

function maskEmail(email: string): string {
	const [user = "", domain = ""] = email.split("@");
	return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Leaves out what no client renders: system prompt entries, which carry every tool schema. */
function slim(events: readonly AgentEvent[]): AgentEvent[] {
	const out: AgentEvent[] = [];
	for (const event of events) {
		if (event.type === "snapshot") out.push({ ...event, entries: event.entries.filter((e) => e.kind !== "pi.system") });
		else if (event.type === "message_start" && event.message.role === "system") continue;
		else if ((event.type === "message_end" || event.type === "entry_appended") && event.entry.kind === "pi.system") continue;
		else if (event.type === "submission") continue;
		else out.push(event);
	}
	return out;
}

/** A member's pi setup as their client sent it, bounded and type-checked. */
function piContext(value: unknown): PiContext | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Partial<PiContext>;
	const agents = Array.isArray(v.agents)
		? v.agents.filter((a) => typeof a?.path === "string" && typeof a?.content === "string").slice(0, 20).map((a) => ({ path: a.path.slice(0, 500), content: a.content.slice(0, 64 * 1024) }))
		: [];
	return { skills: typeof v.skills === "string" ? v.skills.slice(0, 48 * 1024) : "", skillCount: Number(v.skillCount) || 0, agents };
}

/** A terminal waiting for its owner to approve the sign-in in a browser. */
type CliLogin = { invite?: string; name?: string; check: string; expires: number; token?: string; error?: string };

export class Room {
	readonly stateDir: string;
	/** URL path prefix of this room: "" on a single-session server, "/<id>" on a shared host. */
	readonly base: string;
	readonly state: StateFile;
	readonly devices: Devices;
	readonly session: Session;
	readonly #webDir: string;
	readonly #clients = new Set<Client>();
	readonly #cliLogins = new Map<string, CliLogin>();
	#lastActive = Date.now();

	constructor(stateDir: string, base: string, webDir: string, faux: boolean) {
		this.stateDir = stateDir;
		this.base = base;
		this.#webDir = webDir;
		// Older versions copied model API keys here. Models now come from pi's login or the exe.dev gateway.
		rmSync(join(stateDir, "env"), { force: true });
		this.state = new StateFile(stateDir);
		this.devices = new Devices(stateDir);
		this.session = new Session(this.state, stateDir, faux, this.devices, {
			target: (label) => this.#broadcast({ type: "target", label }),
			env: (env) => this.#broadcast({ type: "env", env }),
			files: (version, changed) => this.#broadcast({ type: "files", version, changed }),
			branch: () => void this.#rewatchMain(),
		});
	}

	open(): Promise<void> {
		return this.session.open();
	}

	/** Nobody connected, nothing running, and quiet for `ms`: the room can close until someone comes back. */
	async idle(ms: number): Promise<boolean> {
		if (this.#clients.size > 0 || Date.now() - this.#lastActive < ms) return false;
		if (this.state.value.setup.status === "running" || this.state.value.setup.status === "pending") return false;
		const live = await this.session.harness.snapshot(LiveDoc, this.session.main.id, context);
		return live?.run === undefined;
	}

	async close(reason = "closing"): Promise<void> {
		for (const client of this.#clients) client.ws.close(1012, reason);
		await this.session.close().catch(() => {});
		this.devices.close();
	}

	pingClients(): void {
		for (const client of this.#clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
	}

	#send(client: Client, message: ServerMessage): void {
		if (client.ws.readyState !== WebSocket.OPEN) return;
		// A client that stopped reading gets dropped; it reconnects and starts from a fresh snapshot.
		if (client.ws.bufferedAmount > 32 * 1024 * 1024) {
			client.ws.terminate();
			return;
		}
		client.ws.send(JSON.stringify(message));
	}

	#broadcast(message: ServerMessage): void {
		this.#lastActive = Date.now();
		for (const client of this.#clients) this.#send(client, message);
	}

	#presence(): ServerMessage {
		const online: Presence[] = [...this.#clients].map((c) => ({ memberId: c.member.id, name: c.member.name, client: c.kind, device: c.device?.label }));
		return { type: "presence", online, members: this.state.members() };
	}

	#inviteUrl(invite: InviteInfo): string {
		return `${this.state.value.url}/s/${invite.code}`;
	}

	#error(client: Client, message: string): void {
		this.#send(client, { type: "error", message });
	}

	/** Disconnects every client of a member (removed), telling them why. */
	#kick(memberId: string): void {
		for (const client of this.#clients) {
			if (client.member.id !== memberId) continue;
			this.#send(client, { type: "removed" });
			client.ws.close(REMOVED, "removed from the session");
		}
	}

	async #onMessage(client: Client, message: ClientMessage): Promise<void> {
		this.#lastActive = Date.now();
		// The stored member, not the one captured at connect: roles and names change.
		const member = this.state.value.members[client.member.id];
		if (member === undefined) return this.#kick(client.member.id);
		client.member = member;
		switch (message.type) {
			case "submit": {
				if (!atLeast(member, "editor")) return this.#send(client, { type: "error", requestId: message.requestId, message: "viewers can't talk to the agent; ask an admin for the editor role" });
				const text = message.text.trim();
				const comments = Array.isArray(message.comments) ? message.comments : [];
				if (text.length === 0 && !(Array.isArray(message.attachments) && message.attachments.length > 0) && comments.length === 0) return;
				try {
					await this.session.submit(
						member,
						message.requestId,
						text,
						message.mode === "steer" ? "steer" : "followUp",
						message.where === "device" ? "device" : "vm",
						Array.isArray(message.attachments) ? message.attachments : [],
						comments,
					);
                    this.#send(client, { type: "accepted", requestId: message.requestId });
				} catch (error) {
					this.#send(client, { type: "error", message: String((error as Error).message ?? error), requestId: message.requestId });
				}
				return;
			}
			case "abort": {
				const runner = await this.session.runner();
				if (runner === undefined) return;
				if (!atLeast(member, "admin") && runner !== member.id) return this.#error(client, "only admins can stop someone else's request");
				await this.session.abort();
				await this.session.notice(`${member.name} stopped the agent`);
				return;
			}
			case "invite": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can invite people");
				const role = ROLES.includes(message.role as Role) ? (message.role as Role) : "editor";
				const email = message.email?.trim().toLowerCase();
				if (email !== undefined && !EMAIL.test(email)) return this.#error(client, `not an email address: ${message.email}`);
				// Links expire after a week by default, email invites after a month; 0 means never.
				const days = message.expiresInDays ?? (email === undefined ? 7 : 30);
				const invite = this.state.createInvite({
					by: member.id,
					role,
					email,
					expiresAt: days > 0 ? Date.now() + days * 86_400_000 : undefined,
					maxUses: message.maxUses,
				});
				this.#send(client, { type: "invite", url: this.#inviteUrl(invite), invite });
				return;
			}
			case "invites":
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can see invites");
				this.#send(client, { type: "invites", invites: this.state.activeInvites() });
				return;
			case "revoke": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can revoke invites");
				const code = Object.keys(this.state.value.invites).find((c) => c === message.code || (message.code.length >= 4 && c.startsWith(message.code)));
				if (code === undefined || !this.state.revokeInvite(code)) return this.#error(client, `no active invite ${message.code}`);
				this.#send(client, { type: "invites", invites: this.state.activeInvites() });
				return;
			}
			case "setRole": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can change roles");
				const target = this.state.value.members[message.memberId];
				if (target === undefined) return this.#error(client, "no such member");
				if (!ROLES.includes(message.role)) return this.#error(client, `unknown role ${message.role}`);
				if (target.creator) return this.#error(client, `${target.name} created this session and stays an admin`);
				if (target.role === message.role) return;
				target.role = message.role;
				this.state.save();
				// A demoted member's machine no longer runs requests if they can't send any.
				if (!atLeast(target, "editor")) for (const c of this.#clients) if (c.member.id === target.id && c.device) this.devices.unregister(c.device);
				await this.session.notice(`${member.name} made ${target.name} ${target.role === "admin" ? "an admin" : `a${target.role === "editor" ? "n" : ""} ${target.role}`}`);
				this.#broadcast(this.#presence());
				return;
			}
			case "remove": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can remove people");
				const target = this.state.value.members[message.memberId];
				if (target === undefined) return this.#error(client, "no such member");
				if (target.creator) return this.#error(client, `${target.name} created this session and can't be removed`);
				this.state.removeMember(target.id);
				// Invites they made, and invites addressed to them, stop working: a removed person can't walk back in.
				for (const [code, invite] of Object.entries(this.state.value.invites)) {
					if (invite.by === target.id || (target.email !== undefined && invite.email === target.email)) this.state.revokeInvite(code);
				}
				await this.session.withdraw(target.id).catch(() => {});
				this.#kick(target.id);
				await this.session.notice(`${member.name} removed ${target.name} from the session`);
				this.#broadcast(this.#presence());
				return;
			}
			case "rename": {
				const name = message.name.trim().replace(/\s+/g, " ").slice(0, 40);
				if (name.length === 0 || name === member.name) return;
				const before = member.name;
				member.name = name;
				this.state.save();
				for (const c of this.#clients) if (c.member.id === member.id && c.device) c.device.name = name;
				await this.session.notice(`${before} is now ${name}`);
				this.#broadcast(this.#presence());
				return;
			}
			case "ping":
				this.#send(client, { type: "pong" });
				return;
            case "configure":
                if (!atLeast(member, "admin")) return this.#error(client, "only admins can change the model");
                await this.session.configure(message.model, message.thinkingLevel);
                await this.session.notice(`${member.name} selected ${message.model}`);
                return;
			case "compact":
				if (!atLeast(member, "editor")) return this.#error(client, "viewers can't change the agent's context");
				await this.session.compact(message.instructions?.trim().slice(0, 2000) || undefined);
				await this.session.notice(`${member.name} asked the agent to summarize older messages`);
				return;
			case "new":
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can start a new context");
				await this.session.newContext();
				await this.session.notice(`${member.name} started a new context; the agent no longer sees the messages above`);
				return;
			case "branches":
				this.#send(client, { type: "branches", branches: this.session.branches(), current: this.session.branchId });
				return;
			case "fork": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can branch the thread");
				const before = Number(message.before);
				if (!Number.isInteger(before)) return this.#error(client, "that message can't be branched from");
				const info = await this.session.fork(before, member.id);
				await this.session.notice(`${member.name} branched the thread (${info.label}); /tree switches between branches`);
				return;
			}
			case "switchBranch": {
				if (!atLeast(member, "admin")) return this.#error(client, "only admins can switch branches");
				const info = await this.session.switchBranch(message.id);
				await this.session.notice(`${member.name} switched the thread to ${info.label}`);
				return;
			}
			case "device": {
				// Only an editor's terminal runs that editor's requests; the path is theirs, on their machine.
				if (client.kind !== "cli" || !atLeast(member, "editor")) return;
				const info = message.device;
				const device: DeviceClient & { label: string } = {
					memberId: member.id,
					name: member.name,
					ws: client.ws,
					send: (m) => this.#send(client, m),
					label: `${info.hostname} (${info.platform})`,
				};
				client.device = device;
				this.devices.register(device, {
					hostname: String(info.hostname).slice(0, 80),
					platform: String(info.platform),
					arch: String(info.arch),
					dir: String(info.dir),
					context: piContext(info.context),
				});
				this.#broadcast(this.#presence());
				return;
			}
			case "fenceDone":
				this.devices.fenceDone(message.id);
				return;
			case "envClose":
				if (client.device !== undefined) this.devices.clientClosedChannel(client.device, message.channel);
				return;
		}
	}

	/** The member a WebSocket upgrade's token belongs to. */
	member(value: string | undefined): StoredMember | undefined {
		return this.state.memberByToken(value);
	}

	async connect(ws: WebSocket, member: StoredMember, kind: "cli" | "web"): Promise<void> {
		const client: Client = { member, kind, ws, watches: {} };
		this.#clients.add(client);
		this.#lastActive = Date.now();
		const s = this.state.value;
		const me = { id: member.id, name: member.name, email: member.email, role: member.role, creator: member.creator };
		this.#send(client, { type: "welcome", me, session: { id: s.id, name: s.name, url: s.url, workdir: s.workdir, model: s.model, vm: s.vm }, members: this.state.members() });
		this.#send(client, { type: "env", env: this.session.envStatus() });
		this.#send(client, { type: "files", version: this.session.filesVersion, full: true, changed: this.session.manifest() });
		for (const conv of ["main", "setup"] as ConvName[]) await this.#watch(client, conv);
		this.#send(client, { type: "branches", branches: this.session.branches(), current: this.session.branchId });
		this.#broadcast(this.#presence());
		this.#send(client, { type: "target", label: this.session.targetLabel });
		ws.on("message", (data, isBinary) => {
			if (isBinary) {
				if (client.device === undefined) return;
				const { channel, bytes } = parseChannelFrame(data as Buffer);
				this.devices.fromClient(client.device, channel, bytes);
				return;
			}
			let message: ClientMessage;
			try {
				message = JSON.parse(String(data)) as ClientMessage;
			} catch {
				return;
			}
			void this.#onMessage(client, message).catch((error) => this.#send(client, { type: "error", message: String(error) }));
		});
		ws.on("close", () => {
			this.#clients.delete(client);
			this.#lastActive = Date.now();
			if (client.device !== undefined) this.devices.unregister(client.device);
			for (const watch of Object.values(client.watches)) void watch?.stop();
			this.#broadcast(this.#presence());
		});
	}

	/** Attaches a client to a conversation: a fresh snapshot (which replaces what it shows), then every later batch. */
	async #watch(client: Client, conv: ConvName): Promise<void> {
		await client.watches[conv]?.stop();
		const watch = await this.session.watch(conv);
		client.watches[conv] = watch;
		this.#send(client, { type: "events", conv, events: slim([watch.snapshot]) });
		// People see the whole thread, also what came before a /new or a summary; the model only sees the context.
		const oldest = watch.snapshot.entries.reduce((min, e) => Math.min(min, e.id as number), Number.POSITIVE_INFINITY);
		if (Number.isFinite(oldest) && oldest > 1) {
			const page = await this.session.conversation(conv).entries({ maxEntryId: (oldest - 1) as never, order: "descending" }, HISTORY, undefined, context);
			const entries = page.items.filter((e) => e.kind !== "pi.system").reverse();
			if (entries.length > 0) this.#send(client, { type: "history", conv, entries });
		}
		watch.start(async (events) => {
			const out = slim(events);
			if (out.length > 0) this.#send(client, { type: "events", conv, events: out });
		});
	}

	/** The thread switched branches: everyone now sees, and talks to, the new one. */
	async #rewatchMain(): Promise<void> {
		for (const client of this.#clients) await this.#watch(client, "main").catch(() => {});
		this.#broadcast({ type: "branches", branches: this.session.branches(), current: this.session.branchId });
	}

	async #serveStatic(res: ServerResponse, name: string): Promise<void> {
		try {
			let bytes: Buffer | string = await readFile(join(this.#webDir, name));
			// The page's relative URLs (main.js, api/…, ws) resolve against this room's base.
			if (name === "index.html") bytes = bytes.toString("utf8").replace("__BASE__", `${this.base}/`);
			res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream", "cache-control": "no-cache" });
			res.end(bytes);
		} catch {
			res.writeHead(404).end("not found");
		}
	}

	/** The synced files plus the git history, so a collaborator's copy is a working checkout. */
	async #snapshot(res: ServerResponse): Promise<void> {
		const workdir = this.session.workdir;
		const list = await listFiles(workdir);
		if (existsSync(join(workdir, ".git"))) list.push(".git");
		const tar = spawn("tar", ["-czf", "-", "--null", "-T", "-"], { cwd: workdir, stdio: ["pipe", "pipe", "inherit"] });
		res.writeHead(200, { "content-type": "application/gzip" });
		tar.stdout.pipe(res);
		tar.stdin.end(list.join("\0"));
	}

	/**
	 * Admits someone with an invite. An email invite requires the matching exe.dev sign-in, and signing in again later
	 * (another browser, a terminal) gives the same member a new token. Returns the token, or an error for the caller.
	 */
	async #admit(code: string | undefined, name: string | undefined, identity: { email: string } | undefined): Promise<{ token: string; member: StoredMember } | { status: number; error: string; login?: boolean; email?: string }> {
		const invite = this.state.validInvite(code);
		if (invite === undefined) return { status: 403, error: "this invite is no longer valid; ask an admin for a new one" };
		if (invite.email !== undefined) {
			if (identity === undefined) return { status: 401, error: "sign in with exe.dev to use this invite", login: true, email: maskEmail(invite.email) };
			if (identity.email !== invite.email) return { status: 403, error: `this invite is for ${maskEmail(invite.email)}, but you are signed in to exe.dev as ${identity.email}` };
			const existing = this.state.memberByEmail(identity.email);
			if (existing !== undefined) return { token: this.state.issueToken(existing), member: existing };
		}
		const display = (name ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || identity?.email.split("@")[0] || "";
		if (display.length === 0) return { status: 400, error: "name required" };
		const { member, token: value } = this.state.addMember(display, invite.email, invite.role);
		this.state.useInvite(invite.code);
		await this.session.notice(`${display} joined the session${invite.role === "editor" ? "" : ` as ${invite.role === "admin" ? "an admin" : "a viewer"}`}`);
		this.#broadcast(this.#presence());
		return { token: value, member };
	}

	#cliLoginPage(res: ServerResponse, title: string, bodyHtml: string): void {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${this.base}/style.css"></head><body><div class="screen"><div class="card">${bodyHtml}</div></div></body></html>`,
		);
	}

	/** Handles a request whose path, with the room's base removed, is `path`. */
	async http(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
		const session = this.session;
		const state = this.state;
		if (path === "/healthz") return json(res, 200, { ok: true, id: state.value.id });
		if (req.method === "GET" && (path === "/" || path.startsWith("/s/"))) return this.#serveStatic(res, "index.html");
		if (req.method === "GET" && /^\/[\w.-]+\.(js|css|svg)$/.test(path)) return this.#serveStatic(res, path.slice(1));

		// ---- ways in ----
		const inviteInfo = path.match(/^\/api\/invite\/([\w-]+)$/);
		if (req.method === "GET" && inviteInfo !== null) {
			const invite = state.validInvite(inviteInfo[1]);
			if (invite === undefined) return json(res, 404, { error: "this invite is no longer valid; ask an admin for a new one" });
			return json(res, 200, { session: state.value.name, role: invite.role, email: invite.email === undefined ? undefined : maskEmail(invite.email), login: exeLogin(`${this.base}/s/${invite.code}`) });
		}
		if (req.method === "POST" && path === "/api/join") {
			const input = await jsonBody<{ invite?: string; name?: string }>(req);
			const result = await this.#admit(input.invite, input.name, exeIdentity(req));
			if ("error" in result) return json(res, result.status, { ...result, loginUrl: result.login ? exeLogin(`${this.base}/s/${input.invite}`) : undefined });
			return json(res, 200, { token: result.token, member: { id: result.member.id, name: result.member.name, role: result.member.role }, name: state.value.name });
		}
		if (req.method === "POST" && path === "/api/exe-login") {
			const identity = exeIdentity(req);
			if (identity === undefined) return json(res, 401, { error: "not signed in to exe.dev", loginUrl: exeLogin(`${this.base}/`) });
			const member = state.memberByEmail(identity.email);
			if (member === undefined) return json(res, 403, { error: `${identity.email} is not a member of this session` });
			return json(res, 200, { token: state.issueToken(member) });
		}
		// A terminal signs in through the browser: it gets a code, its owner approves it there (signed in with exe.dev,
		// after checking the short code matches), and the terminal collects its token.
		if (req.method === "POST" && path === "/api/cli-login") {
			const input = await jsonBody<{ invite?: string; name?: string }>(req);
			for (const [code, pending] of this.#cliLogins) if (pending.expires < Date.now()) this.#cliLogins.delete(code);
			const code = token(18);
			const check = token(4).replace(/[^A-Za-z0-9]/g, "x").slice(0, 6).toUpperCase();
			this.#cliLogins.set(code, { invite: input.invite, name: input.name, check, expires: Date.now() + 10 * 60_000 });
			return json(res, 200, { code, check, url: `${state.value.url}/cli-login/${code}` });
		}
		const cliPoll = path.match(/^\/api\/cli-login\/([\w-]+)$/);
		if (req.method === "GET" && cliPoll !== null) {
			const pending = this.#cliLogins.get(cliPoll[1]!);
			if (pending === undefined || pending.expires < Date.now()) return json(res, 404, { status: "expired" });
			if (pending.error !== undefined) return json(res, 200, { status: "denied", error: pending.error });
			if (pending.token === undefined) return json(res, 200, { status: "pending" });
			this.#cliLogins.delete(cliPoll[1]!);
			return json(res, 200, { status: "approved", token: pending.token });
		}
		const cliPage = path.match(/^\/cli-login\/([\w-]+)$/);
		if (cliPage !== null && (req.method === "GET" || req.method === "POST")) {
			const pending = this.#cliLogins.get(cliPage[1]!);
			if (pending === undefined || pending.expires < Date.now()) return this.#cliLoginPage(res, "Expired", "<h1>This sign-in expired</h1><p class=\"muted\">Run the command in your terminal again.</p>");
			const identity = exeIdentity(req);
			if (identity === undefined) {
				res.writeHead(302, { location: exeLogin(`${this.base}${path}`) });
				return void res.end();
			}
			if (req.method === "GET") {
				return this.#cliLoginPage(
					res,
					"Sign in your terminal",
					`<h1>Sign in your terminal?</h1><p class="muted">A terminal asked to join <strong>${escapeHtml(state.value.name)}</strong> as <strong>${escapeHtml(identity.email)}</strong>. Approve only if it shows this code:</p><p style="font:600 28px ui-monospace,monospace;letter-spacing:.1em">${pending.check}</p><form method="post"><button type="submit">Approve</button></form>`,
				);
			}
			// A cross-site form can't approve someone's sign-in.
			const origin = req.headers.origin;
			if (origin !== undefined && origin !== new URL(state.value.url).origin) return json(res, 403, { error: "bad origin" });
			const member = state.memberByEmail(identity.email);
			if (pending.invite === undefined && member !== undefined) pending.token = state.issueToken(member);
			else {
				const result = await this.#admit(pending.invite, pending.name, identity);
				if ("error" in result) pending.error = result.error;
				else pending.token = result.token;
			}
			return this.#cliLoginPage(
				res,
				"Done",
				pending.error === undefined ? "<h1>Your terminal is signed in</h1><p class=\"muted\">You can close this tab.</p>" : `<h1>Couldn't sign in</h1><p class="error">${escapeHtml(pending.error)}</p>`,
			);
		}

		// ---- members only ----
		const member = state.memberByToken(bearer(req, url));
		if (member === undefined) return json(res, 401, { error: "unauthorized" });
		this.#lastActive = Date.now();

		if (req.method === "GET" && path === "/api/info") {
			return json(res, 200, { id: state.value.id, name: state.value.name, url: state.value.url, workdir: state.value.workdir, vm: state.value.vm, me: { id: member.id, name: member.name, role: member.role } });
		}
		if (req.method === "POST" && path === "/api/title") {
            if (!atLeast(member, "admin")) return json(res, 403, { error: "only admins can generate thread titles" });
            return json(res, 200, { title: await session.title() });
        }
        if (req.method === "GET" && path === "/api/models") {
            const models = await session.models.getAvailable();
            return json(res, 200, { models: models.map(m => ({ id: `${m.provider}/${m.id}`, name: m.name, reasoning: m.reasoning })) });
        }
        if (req.method === "GET" && path === "/api/manifest") return json(res, 200, { version: session.filesVersion, files: session.manifest() });
		if (req.method === "GET" && path === "/api/snapshot.tgz") return this.#snapshot(res);

		if (path === "/api/file") {
			const rel = safePath(url.searchParams.get("path") ?? "");
			if (rel === undefined) return json(res, 400, { error: "bad path" });
			const full = join(session.workdir, rel);
			// The file as it was before the shared thread's last turn, as in Delta's version picker. Read only.
			if (req.method === "GET" && url.searchParams.get("at") === "before-last-turn") {
				const bytes = await session.history.beforeLastTurn(rel);
				if (bytes === undefined) return json(res, 404, { error: "no turn has run yet", reason: "no-turn" });
				if (bytes === null) return json(res, 404, { error: "the file wasn't there before the last turn", reason: "absent" });
				res.writeHead(200, { "content-type": "application/octet-stream", "x-hash": hashBytes(bytes) });
				return void res.end(bytes);
			}
			if (req.method === "GET") {
				try {
					const bytes = await readFile(full);
					res.writeHead(200, { "content-type": "application/octet-stream", "x-hash": hashBytes(bytes) });
					return void res.end(bytes);
				} catch {
					return json(res, 404, { error: "not found" });
				}
			}
			if (!atLeast(member, "editor")) return json(res, 403, { error: "viewers can't change files" });
			// Writes are compare-and-swap: `base` is the hash the client last saw ("none" for a file that did not exist).
			const base = url.searchParams.get("base") ?? "none";
			const current = (await session.fileHash(rel)) ?? "none";
			if (req.method === "PUT") {
				const bytes = await body(req, MAX_FILE_BYTES);
				const hash = hashBytes(bytes);
				if (current === hash) return json(res, 200, { hash });
				if (current !== base) return json(res, 409, { hash: current === "none" ? null : current });
				mkdirSync(dirname(full), { recursive: true });
				const tmp = `${full}.syncpi-tmp`;
				writeFileSync(tmp, bytes);
				renameSync(tmp, full);
				session.scanSoon();
				return json(res, 200, { hash });
			}
			if (req.method === "DELETE") {
				if (current === "none") return json(res, 200, { hash: null });
				if (current !== base) return json(res, 409, { hash: current });
				rmSync(full, { force: true });
				session.scanSoon();
				return json(res, 200, { hash: null });
			}
		}
		json(res, 404, { error: "not found" });
	}
}
