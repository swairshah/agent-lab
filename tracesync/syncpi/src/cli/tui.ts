import { parseInvite } from "../shared/commands.ts";
// The terminal view of a session: the shared thread, who is here, the setup agent's progress and sync activity, and
// an editor to talk to the agent. It renders the same Thread state as the web view.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CombinedAutocompleteProvider,
	type Component,
	Editor,
	type EditorTheme,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type TUI,
	TuiMainScreen,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type BranchInfo, type ConvName, type EnvStatus, type InviteInfo, type Member, type Presence, ROLES, type Role, type ServerMessage, type SessionInfo, type SideInfo } from "../shared/protocol.ts";
import { type Artifact, patchStats, replyArtifacts, threadArtifacts, toolArtifacts } from "../shared/artifacts.ts";
import { draftText, fromBase64, isCommand, Y } from "../shared/drafts.ts";
import { type Item, milestoneOf, Thread, toolSummary } from "../shared/thread.ts";
import type { Connection, ConnectionState } from "./client.ts";
import { home, type SessionRecord } from "./store.ts";
import type { LocalDevice } from "./device.ts";
import { expandTemplate, type LoadedPiContext, type PromptTemplateInfo } from "./pi-context.ts";
import type { Mirror } from "./sync.ts";

// ---------- colors ----------

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const c = {
	dim: esc("2"),
	bold: esc("1"),
	italic: esc("3"),
	underline: esc("4"),
	strike: esc("9"),
	red: esc("31"),
	green: esc("32"),
	yellow: esc("33"),
	blue: esc("34"),
	magenta: esc("35"),
	cyan: esc("36"),
	gray: esc("90"),
	accent: esc("38;5;110"),
};
const PEOPLE = [esc("38;5;180"), esc("38;5;150"), esc("38;5;175"), esc("38;5;117"), esc("38;5;216"), esc("38;5;146")];
function personColor(name: string): (s: string) => string {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return PEOPLE[h % PEOPLE.length]!;
}

const markdownTheme: MarkdownTheme = {
	heading: (t) => c.bold(c.accent(t)),
	link: c.cyan,
	linkUrl: c.gray,
	code: c.yellow,
	codeBlock: (t) => t,
	codeBlockBorder: c.gray,
	quote: c.italic,
	quoteBorder: c.gray,
	hr: c.gray,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: c.strike,
	underline: c.underline,
};

const editorTheme: EditorTheme = {
	borderColor: c.gray,
	selectList: { selectedPrefix: c.accent, selectedText: c.accent, description: c.gray, scrollInfo: c.gray, noMatch: c.gray },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------- the transcript ----------

/** Renders a Thread's items, caching each one by its revision and the width. */
/** Artifact kinds a terminal can't show; they get a number to open with /open. */
const OPENABLE = new Set(["html", "svg", "markdown", "image"]);

/** The first lines of a patch, colored like `git diff`. */
function diffLines(patch: string, width: number, keep = 12): string[] {
	const body = patch.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("Index:") && !l.startsWith("====") && l.length > 0);
	const shown = body.slice(0, keep).map((l) => {
		const text = truncateToWidth(l.replace(/\t/g, "  "), Math.max(10, width - 4));
		return `  ${l.startsWith("+") ? c.green(text) : l.startsWith("-") ? c.red(text) : l.startsWith("@@") ? c.cyan(text) : c.gray(text)}`;
	});
	if (body.length > keep) shown.push(c.gray(`  … ${body.length - keep} more lines`));
	return shown;
}

class ThreadView implements Component {
	thread: Thread;
	me = "";
	/** Numbers of the artifacts /open can show, by artifact key. */
	artifactNumbers = new Map<string, number>();
	/** Current names by member id, so a renamed person shows under their new name everywhere. */
	names = new Map<string, string>();
	#cache = new Map<string, { rev: number; width: number; lines: string[] }>();
	#markdown = new Map<string, Markdown>();
	frame = 0;

	constructor(thread: Thread) {
		this.thread = thread;
	}

	invalidate(): void {
		this.#cache.clear();
	}

	render(width: number): string[] {
		const out: string[] = [];
		for (const item of this.thread.state.items) {
			const animated = item.kind === "tool" && item.status === "running";
			const cached = this.#cache.get(item.key);
			let lines: string[];
			if (!animated && cached !== undefined && cached.rev === item.rev && cached.width === width) lines = cached.lines;
			else {
				lines = this.#item(item, width);
				if (!animated) this.#cache.set(item.key, { rev: item.rev, width, lines });
			}
			out.push(...lines);
		}
		return out;
	}

	#item(item: Item, width: number): string[] {
		switch (item.kind) {
			case "user": {
				const name = (item.memberId !== undefined ? this.names.get(item.memberId) : undefined) ?? item.author ?? "someone";
				const color = personColor(name);
				const head = `${color("▍")} ${c.bold(color(name))}`;
				const body = wrapTextWithAnsi(item.text, Math.max(10, width - 2)).map((l) => `${color("▍")} ${l}`);
				return ["", head, ...body];
			}
			case "assistant": {
				// A reply that only calls tools shows as its tool lines.
				if (!item.text && !item.thinking && !item.error) return [];
				const lines: string[] = [""];
				if (item.thinking && !item.text) lines.push(c.gray(c.italic(truncateToWidth(`thinking… ${item.thinking.replace(/\s+/g, " ").slice(-200)}`, width))));
				if (item.text) {
					let md = this.#markdown.get(item.key);
					if (md === undefined) {
						md = new Markdown(item.text, 0, 0, markdownTheme);
						this.#markdown.set(item.key, md);
					} else md.setText(item.text);
					lines.push(...md.render(width));
				}
				if (item.error) lines.push(c.red(`✗ ${item.error}`));
				if (!item.streaming) for (const artifact of replyArtifacts(item.key, item.text)) lines.push(this.#openable(artifact));
				return lines;
			}
			case "tool": {
				const milestone = milestoneOf(item);
				if (milestone !== undefined) {
					const wrapped = wrapTextWithAnsi(c.gray(milestone.summary), Math.max(10, width - 4)).map((l) => `  ${l}`);
					return ["", `${c.accent("⚑")} ${c.bold(milestone.title)}`, ...wrapped];
				}
				const icon =
					item.status === "running"
						? c.yellow(SPINNER[this.frame % SPINNER.length]!)
						: item.status === "error"
							? c.red("✗")
							: item.status === "done"
								? c.green("✓")
								: c.gray("○");
				const summary = toolSummary(item);
				const head = `${icon} ${c.bold(item.name)} ${c.gray(truncateToWidth(summary, Math.max(10, width - visibleWidth(item.name) - 4)))}`;
				const artifacts = toolArtifacts(item);
				const diff = artifacts.find((a) => a.kind === "diff");
				if (diff !== undefined) {
					const { added, removed } = patchStats(diff.content);
					return [`${head} ${c.green(`+${added}`)} ${c.red(`−${removed}`)}`, ...diffLines(diff.content, width)];
				}
				const openable = artifacts.filter((a) => OPENABLE.has(a.kind));
				if (openable.length > 0) return [head, ...openable.map((a) => this.#openable(a))];
				const showOutput = item.status === "running" || item.status === "error" || item.name === "bash";
				const tail = showOutput ? item.output.trimEnd().split("\n").filter((l) => l.length > 0) : [];
				const keep = item.status === "done" ? 3 : 8;
				const shown = tail.slice(-keep).map((l) => c.gray(`  │ ${truncateToWidth(l.replace(/\t/g, "  "), Math.max(10, width - 4))}`));
				if (tail.length > keep) shown.unshift(c.gray(`  │ … ${tail.length - keep} more lines`));
				return [head, ...shown];
			}
			case "notice":
				return ["", c.gray(c.italic(`  — ${item.text}`))];
		}
	}

	#openable(artifact: Artifact): string {
		const n = this.artifactNumbers.get(artifact.key);
		return `  ${c.accent("◆")} ${artifact.title} ${c.gray(`${artifact.kind}${n !== undefined ? ` · /open ${n}` : ""}`)}`;
	}
}

class Lines implements Component {
	lines: string[] = [];
	invalidate(): void {}
	render(width: number): string[] {
		return this.lines.map((l) => truncateToWidth(l, width));
	}
}

// ---------- the app ----------

const COMMANDS = [
	{ name: "invite", description: "Invite someone: an email (they sign in with exe.dev), or a link anyone can use", argumentHint: "[email] [admin|editor|viewer] [7d|never] [--uses N]" },
	{ name: "session-share", description: "Create a link others can open in a browser or with syncpi --url" },
	{ name: "members", description: "People in this session, their roles, who is online" },
	{ name: "role", description: "Change someone's role (admins)", argumentHint: "<name|email> <admin|editor|viewer>" },
	{ name: "remove", description: "Remove someone from the session (admins)", argumentHint: "<name|email>" },
	{ name: "links", description: "Invites that still work (admins)" },
	{ name: "revoke", description: "Revoke an invite (admins)", argumentHint: "<code>" },
	{ name: "name", description: "Change your name", argumentHint: "<new name>" },
	{ name: "open", description: "Open an artifact (HTML, SVG, markdown, image) in your browser; no number lists them", argumentHint: "[n]" },
	{ name: "compact", description: "Summarize older messages now (it also happens on its own)", argumentHint: "[instructions]" },
	{ name: "new", description: "Start a new context; the agent no longer sees the messages above (admins)" },
	{ name: "tree", description: "Messages and branches; /tree <n> branches before message n, /tree b<k> switches (admins)", argumentHint: "[n | b<k>]" },
	{ name: "web", description: "Open this session in your browser" },
	{ name: "env", description: "Show or hide the setup agent's thread" },
	{ name: "steer", description: "Add to what the agent is doing, without stopping it", argumentHint: "<message>" },
	{ name: "queue", description: "Send after the agent's current run, without stopping it", argumentHint: "<message>" },
	{ name: "side", description: "Your private side thread, forked from this one, to ask about it (/side new forks it again)", argumentHint: "[question]" },
	{ name: "land", description: "Land this thread's changes on main (the project's land skill; runs where yours do)" },
	{ name: "remote", description: "Run this request on the session VM; it keeps going if you quit", argumentHint: "<task>" },
	{ name: "stop", description: "Stop the agent (also Esc)" },
	{ name: "sync", description: "File sync status" },
	{ name: "where", description: "Run your requests here (your machine) or on the session VM", argumentHint: "here|vm" },
	{ name: "ssh", description: "How to get a shell on the VM" },
	{ name: "quit", description: "Leave; the session keeps running" },
];

export class App {
	readonly #tui: TUI;
	readonly #conn: Connection;
	readonly #record: SessionRecord;
	readonly #mirror: Mirror | undefined;
	readonly #device: LocalDevice | undefined;
	/** Where requests sent from this terminal run. */
	#where: "device" | "vm";
	/** Where the shared thread's current run executes, as the server reports it. */
	#target = "";
	#localTools = 0;
	readonly #threads: Record<ConvName, Thread> = { main: new Thread(), setup: new Thread(), land: new Thread(), side: new Thread() };
	readonly #view: ThreadView;
	readonly #header = new Lines();
	readonly #notes = new Lines();
	readonly #status = new Lines();
	readonly #editor: Editor;
	#showing: ConvName = "main";
	/** This person's side thread (a private fork of the thread), if they have one. */
	#side: SideInfo | null = null;
	/** The /side request this terminal sent last: its answer opens the side thread here. */
	#sideRequest: string | undefined;
	#session: SessionInfo | undefined;
	#me: Member | undefined;
	#online: Presence[] = [];
	/** Drafts being written (from the web or desktop app), by their writer's member id; shown as they're typed. */
	#drafts = new Map<string, { name: string; doc: Y.Doc }>();
	#members: Member[] = [];
	#env: EnvStatus = { status: "pending" };
	#connState: ConnectionState = "connecting";
	/** While the session's server is being created: what is happening, or why it failed. */
	#setup: { step?: string; error?: string } | undefined = { step: "starting" };
	#connDetail: string | undefined;
	#frame = 0;
	#notesTimer: NodeJS.Timeout | undefined;
	#spinner: NodeJS.Timeout | undefined;
	#done: () => void = () => {};

	#branches: BranchInfo[] = [];
	/** Openable artifacts in thread order; /open <n> uses this numbering. */
	#artifacts: Artifact[] = [];
	#branch = 0;
	/** Your pi prompt templates: `/name args` expands before sending, as in pi. */
	#templates: PromptTemplateInfo[] = [];

	constructor(record: SessionRecord, conn: Connection, mirror: Mirror | undefined, device: LocalDevice | undefined, piContext?: Promise<LoadedPiContext>) {
		this.#record = record;
		this.#conn = conn;
		this.#mirror = mirror;
		this.#device = device;
		this.#where = device === undefined ? "vm" : "device";
		if (device !== undefined) {
			device.onActivity = (running) => {
				this.#localTools = running;
				this.#refresh();
			};
		}
		this.#tui = new TuiMainScreen(new ProcessTerminal());
		this.#view = new ThreadView(this.#threads.main);
		this.#editor = new Editor(this.#tui, editorTheme, { paddingX: 1 });
		this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, mirror?.dir ?? process.cwd()));
		void piContext?.then((context) => {
			this.#templates = context.prompts;
			const templates = context.prompts.map((p) => ({ name: p.name, description: `${p.description} (prompt template)`, argumentHint: p.argumentHint }));
			this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...COMMANDS, ...templates], mirror?.dir ?? process.cwd()));
			if (device !== undefined && (context.skillCount > 0 || context.agents.length > 0)) {
				this.#note(c.gray(`your pi setup joins your requests: ${context.skillCount} skills, ${context.agents.length} AGENTS file${context.agents.length === 1 ? "" : "s"}${context.prompts.length ? `, ${context.prompts.length} prompt templates` : ""}`), 8_000);
			}
		});
		this.#editor.onSubmit = (text) => this.#submit(text);
		this.#tui.addChild(this.#header);
		this.#tui.addChild(this.#view);
		this.#tui.addChild(this.#notes);
		this.#tui.addChild(this.#status);
		this.#tui.addChild(this.#editor);
		this.#tui.setFocus(this.#editor);
		this.#tui.addInputListener((data) => this.#key(data));
	}

	run(): Promise<void> {
		this.#conn.onMessage = (message) => this.#onMessage(message);
		this.#conn.onState = (state, detail) => {
			if (state === "closed") this.#device?.disconnected();
			this.#connState = state;
			this.#connDetail = detail;
			this.#refresh();
		};
		if (this.#mirror !== undefined) {
			this.#mirror.onEvent = (event) => {
				if (event.type === "conflict") this.#note(c.yellow(`⚠ ${event.path} changed on both sides; kept yours, theirs is in ${event.saved}`), 20_000);
				else if (event.type === "error") this.#note(c.red(`sync: ${event.message}`), 8_000);
				this.#refresh();
			};
		}
		this.#spinner = setInterval(() => {
			const busy = this.#setup !== undefined || this.#threads[this.#showing].state.busy || this.#threads[this.#showing].state.items.some((i) => i.kind === "tool" && i.status === "running");
			if (!busy) return;
			this.#frame++;
			this.#view.frame = this.#frame;
			this.#refresh();
		}, 120);
		this.#tui.start();
		this.#refresh();
		return new Promise((resolve) => (this.#done = resolve));
	}

	/** Progress of the server's creation; undefined once it is up (the caller then starts the connection). */
	setup(state: { step?: string; error?: string } | undefined): void {
		this.#setup = state;
		this.#refresh();
	}

	stop(): void {
		if (this.#spinner !== undefined) clearInterval(this.#spinner);
		this.#tui.stop();
		this.#done();
	}

	#key(data: string): { consume: boolean } | undefined {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			if (this.#editor.getText().length > 0 && matchesKey(data, "ctrl+c")) {
				this.#editor.setText("");
				return { consume: true };
			}
			this.stop();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && !this.#editor.isShowingAutocomplete()) {
			if (this.#showing === "setup") {
				this.#show("main");
				return { consume: true };
			}
			// In your side thread Esc stops its run, or else goes back to the shared thread.
			if (this.#showing === "side") {
				if (this.#threads.side.state.busy) {
					this.#conn.send({ type: "abort", conv: "side" });
					this.#note(c.gray("stopping your side thread's agent…"), 3_000);
				} else this.#show("main");
				return { consume: true };
			}
			if (this.#threads.main.state.busy) {
				this.#conn.send({ type: "abort" });
				this.#note(c.gray("stopping the agent…"), 3_000);
				return { consume: true };
			}
		}
		return undefined;
	}

	#onMessage(message: ServerMessage): void {
		if (this.#device?.handle(message)) return;
		switch (message.type) {
			case "target":
				this.#target = message.label;
				break;
			case "welcome":
				this.#session = message.session;
				this.#me = message.me;
				this.#setMembers(message.members);
				break;
			case "events":
				this.#threads[message.conv].apply(message.events);
				if (message.conv === "main") this.#numberArtifacts();
				break;
			case "history":
				this.#threads[message.conv].prepend(message.entries);
				if (message.conv === "main") this.#numberArtifacts();
				this.#view.invalidate();
				break;
			case "side":
				this.#side = message.side;
				if (message.requestId !== undefined && message.requestId === this.#sideRequest) this.#show("side");
				else if (this.#side === null && this.#showing === "side") this.#show("main");
				break;
			case "draft": {
				let draft = this.#drafts.get(message.owner);
				if (draft === undefined) this.#drafts.set(message.owner, (draft = { name: message.name, doc: new Y.Doc() }));
				draft.name = message.name;
				if (message.update !== undefined) Y.applyUpdate(draft.doc, fromBase64(message.update));
				break;
			}
			case "presence":
				this.#online = message.online;
				this.#setMembers(message.members);
				break;
			case "env":
				this.#env = message.env;
				break;
			case "files":
				this.#mirror?.remoteChanged(message.full === true, message.changed, message.version);
				break;
			case "invite":
				this.#shareLink(message.url, message.invite);
				break;
			case "invites":
				this.#showInvites(message.invites);
				break;
			case "branches":
				this.#branches = message.branches;
				this.#branch = message.current;
				break;
			case "removed":
				this.#note(c.red("you were removed from this session; your local copy stays where it is"), 600_000);
				break;
			case "notice":
				this.#note(message.text, 8_000);
				break;
			case "error":
				this.#note(c.red(`error: ${message.message}`), 10_000);
				break;
			case "pong":
				break;
		}
		this.#refresh();
	}

	#submit(raw: string): void {
		const text = raw.trim();
		if (text.length === 0) return;
		this.#editor.addToHistory(text);
		const expanded = text.startsWith("/") ? expandTemplate(text, this.#templates) : undefined;
		if (expanded !== undefined) return this.#send(expanded);
		if (text.startsWith("/")) return this.#command(text);
		this.#send(text);
	}

	#send(text: string): void {
		if (this.#me?.role === "viewer") return this.#note(c.gray("you're a viewer in this session; an admin can make you an editor"), 6_000);
		if (this.#showing === "setup") this.#show("main");
		// As in Delta, a new message stops the agent's current run and starts its own (/steer and /queue don't). In
		// your side thread, it goes there.
		this.#conn.send({ type: "submit", requestId: randomUUID(), text, mode: "interrupt", where: this.#where, ...this.#sideConv() });
	}

	/** Messages and /stop go to your side thread while it's shown. */
	#sideConv(): { conv?: "side" } {
		return this.#showing === "side" ? { conv: "side" } : {};
	}

	#command(text: string): void {
		const [name = "", ...rest] = text.slice(1).split(" ");
		const arg = rest.join(" ").trim();
		switch (name) {
			case "session-share":
			case "share":
			case "invite": {
				const parsed = parseInvite(name === "invite" ? arg : "");
				if (typeof parsed === "string") return this.#note(c.gray(parsed), 6_000);
				this.#conn.send({ type: "invite", ...parsed });
				this.#note(c.gray(parsed.email ? `inviting ${parsed.email}…` : "creating a link…"), 5_000);
				return;
			}
			case "links":
				this.#conn.send({ type: "invites" });
				return;
			case "revoke":
				if (arg.length === 0) return this.#note(c.gray("usage: /revoke <code> (see /links)"), 4_000);
				this.#conn.send({ type: "revoke", code: arg });
				return;
			case "open":
				return this.#open(arg);
			case "compact":
				this.#conn.send({ type: "compact", instructions: arg || undefined });
				return;
			case "new":
				this.#conn.send({ type: "new" });
				return;
			case "tree":
				return this.#tree(arg);
			case "name":
				if (arg.length === 0) return this.#note(c.gray("usage: /name <new name>"), 4_000);
				this.#conn.send({ type: "rename", name: arg });
				return;
			case "role": {
				const parts = arg.split(/\s+/);
				const role = parts.pop() as Role;
				const target = this.#findMember(parts.join(" "));
				if (!ROLES.includes(role) || target === undefined) return this.#note(c.gray("usage: /role <name|email> <admin|editor|viewer> (see /members)"), 5_000);
				this.#conn.send({ type: "setRole", memberId: target.id, role });
				return;
			}
			case "remove": {
				const target = this.#findMember(arg);
				if (target === undefined) return this.#note(c.gray("usage: /remove <name|email> (see /members)"), 5_000);
				this.#conn.send({ type: "remove", memberId: target.id });
				return;
			}
			case "web": {
				if (this.#setup !== undefined) return this.#note(c.gray("the web view is available once the session is up"), 4_000);
				const url = `${this.#record.url}/#token=${this.#record.token}`;
				openUrl(url);
				this.#note(`opened the web view ${c.gray(`(${this.#record.url})`)}`, 6_000);
				return;
			}
			case "env":
				this.#show(this.#showing === "main" ? "setup" : "main");
				return;
			case "who":
			case "members": {
				const online = new Set(this.#online.map((p) => p.memberId));
				const lines = this.#members.map((m) => {
					const where = this.#online.filter((p) => p.memberId === m.id).map((p) => p.client);
					const role = m.creator ? "admin, created the session" : m.role;
					return `  ${online.has(m.id) ? c.green("●") : c.gray("○")} ${personColor(m.name)(m.name)}${m.email ? c.gray(` <${m.email}>`) : ""} ${c.gray(role)}${m.id === this.#me?.id ? c.gray(" (you)") : ""}${where.length ? c.gray(` · ${[...new Set(where)].join(", ")}`) : ""}`;
				});
				this.#note([c.bold("people"), ...lines].join("\n"), 20_000);
				return;
			}
			case "remote":
				if (arg.length === 0) return this.#note(c.gray("usage: /remote <task>"), 4_000);
				this.#conn.send({ type: "submit", requestId: randomUUID(), text: arg, mode: "interrupt", where: "vm" });
				return;
			case "land":
				if (this.#me?.role === "viewer") return this.#note(c.gray("viewers can't land changes"), 4_000);
				this.#conn.send({ type: "land", where: this.#where });
				return this.#note(c.gray("landing: an agent commits, rebases, runs the checks and pushes to main; its progress shows here"), 8_000);
			case "queue":
				if (arg.length === 0) return this.#note(c.gray("usage: /queue <message>"), 4_000);
				this.#conn.send({ type: "submit", requestId: randomUUID(), text: arg, mode: "followUp", where: this.#where, ...this.#sideConv() });
				return;
			case "steer":
				if (arg.length === 0) return this.#note(c.gray("usage: /steer <message>"), 4_000);
				this.#conn.send({ type: "submit", requestId: randomUUID(), text: arg, mode: "steer", where: this.#where, ...this.#sideConv() });
				return;
			case "stop":
				this.#conn.send({ type: "abort", ...this.#sideConv() });
				return;
			case "side": {
				if (this.#me?.role === "viewer") return this.#note(c.gray("viewers can't start a side thread"), 4_000);
				const fresh = arg === "new";
				if (this.#side !== null && !fresh && arg.length === 0) return this.#show("side");
				this.#sideRequest = randomUUID();
				this.#conn.send({ type: "side", requestId: this.#sideRequest, ...(fresh ? { fresh } : {}), ...(arg.length > 0 && !fresh ? { text: arg } : {}), where: this.#where });
				return this.#note(c.gray("your side thread: a private fork of this one, which can look but not change files. Esc goes back"), 6_000);
			}
			case "where": {
				if (arg === "vm") this.#where = "vm";
				else if (arg === "here" || arg === "local") {
					if (this.#device === undefined) return this.#note(c.gray("file sync is off (--no-sync), so requests can only run on the VM"), 5_000);
					this.#where = "device";
				} else if (arg.length > 0) return this.#note(c.gray("usage: /where here|vm"), 4_000);
				this.#note(`your requests run ${this.#where === "device" ? "on this machine, in " + (this.#mirror?.dir ?? "") : "on the session VM"}`, 6_000);
				return;
			}
			case "sync": {
				const m = this.#mirror;
				if (m === undefined) return this.#note("file sync is off", 5_000);
				const conflicts = m.conflicts.length > 0 ? `\n  conflicts: ${m.conflicts.join(", ")}` : "";
				this.#note(`sync ${m.dir}\n  pulled ${m.pulled}, pushed ${m.pushed}, pending ${m.pending}${conflicts}`, 12_000);
				return;
			}
			case "ssh":
				if (this.#record.vm === undefined) return this.#note("this session does not run on an exe.dev VM", 5_000);
				this.#note(this.#record.role === "owner" ? `ssh ${this.#record.vm}.exe.xyz   (project in ${this.#session?.workdir ?? "~"})` : "only the owner has shell access to the VM", 12_000);
				return;
			case "quit":
			case "exit":
				this.stop();
				return;
			default:
				this.#note(c.gray(`unknown command /${name}`), 4_000);
		}
	}

	/** Numbers the thread's openable artifacts in order, for /open and the ◆ lines. */
	#numberArtifacts(): void {
		this.#artifacts = threadArtifacts(this.#threads.main.state.items).filter((a) => OPENABLE.has(a.kind));
		const numbers = new Map(this.#artifacts.map((a, n) => [a.key, n + 1]));
		if ([...numbers].some(([k, n]) => this.#view.artifactNumbers.get(k) !== n)) {
			this.#view.artifactNumbers = numbers;
			this.#view.invalidate();
		}
	}

	/**
	 * Opens an artifact in your browser (or default app): a project file from your synced copy, a snippet from a reply
	 * from a file written for it under ~/.syncpi/artifacts.
	 */
	#open(arg: string): void {
		if (!/^\d+$/.test(arg)) {
			if (this.#artifacts.length === 0) return this.#note(c.gray("no HTML, SVG, markdown or image artifacts in this thread yet"), 6_000);
			const lines = this.#artifacts.map((a, n) => `  ${c.bold(String(n + 1).padStart(3))}  ${a.title} ${c.gray(a.kind)}`);
			return this.#note([c.bold("artifacts") + c.gray("  (/open <n> opens one)"), ...lines].join("\n"), 30_000);
		}
		const artifact = this.#artifacts[Number(arg) - 1];
		if (artifact === undefined) return this.#note(c.gray(`no artifact ${arg}; /open lists them`), 5_000);
		let file: string | undefined;
		if (artifact.path !== undefined && this.#mirror !== undefined) {
			const local = isAbsolute(artifact.path) ? artifact.path : join(this.#mirror.dir, artifact.path);
			if (existsSync(local)) file = local;
		}
		if (file === undefined) {
			const dir = join(home, "artifacts", this.#record.id);
			mkdirSync(dir, { recursive: true });
			const ext = artifact.kind === "markdown" ? "md" : artifact.kind === "image" ? "txt" : artifact.kind;
			file = join(dir, `${artifact.key.replace(/[^\w.-]/g, "_")}.${ext}`);
			writeFileSync(file, artifact.content);
		}
		openUrl(file);
		this.#note(c.gray(`opened ${file}`), 5_000);
	}

	/** The messages you can branch before, numbered, from the newest context. */
	#points(): { n: number; key: string; text: string; author: string }[] {
		return this.#threads.main.state.items
			.filter((i) => i.kind === "user" && /^\d+$/.test(i.key))
			.map((i, n) => {
				const item = i as Extract<typeof i, { kind: "user" }>;
				return { n: n + 1, key: item.key, text: item.text, author: (item.memberId ? this.#view.names.get(item.memberId) : undefined) ?? item.author ?? "?" };
			});
	}

	#tree(arg: string): void {
		const points = this.#points();
		const branch = arg.match(/^b(\d+)$/);
		if (branch !== null) {
			const target = this.#branches[Number(branch[1])];
			if (target === undefined) return this.#note(c.gray(`no branch b${branch[1]}; /tree lists them`), 5_000);
			this.#conn.send({ type: "switchBranch", id: target.id });
			return;
		}
		if (/^\d+$/.test(arg)) {
			const point = points.find((p) => p.n === Number(arg));
			if (point === undefined) return this.#note(c.gray(`no message ${arg}; /tree lists them`), 5_000);
			this.#conn.send({ type: "fork", before: point.key });
			// As in pi: the message comes back into the editor, to edit and send on the new branch.
			this.#editor.setText(point.text);
			return;
		}
		const lines = [c.bold("messages") + c.gray("  (/tree <n> branches just before one and puts it back in your editor)")];
		for (const p of points.slice(-15)) lines.push(`  ${c.bold(String(p.n).padStart(3))}  ${personColor(p.author)(p.author)} ${c.gray(truncateToWidth(p.text.replace(/\s+/g, " "), 70))}`);
		if (points.length > 15) lines.splice(1, 0, c.gray(`  … ${points.length - 15} earlier`));
		lines.push(c.bold("branches") + c.gray("  (/tree b<k> switches everyone to one)"));
		this.#branches.forEach((b, k) => {
			const by = b.by ? this.#view.names.get(b.by) : undefined;
			lines.push(`  ${b.id === this.#branch ? c.green("●") : c.gray("○")} ${c.bold(`b${k}`)} ${b.label}${by ? c.gray(` · by ${by}`) : ""}${c.gray(` · ${new Date(b.at).toLocaleString()}`)}`);
		});
		this.#note(lines.join("\n"), 40_000);
	}

	#setMembers(members: Member[]): void {
		this.#members = members;
		const mine = members.find((m) => m.id === this.#me?.id);
		if (mine !== undefined) this.#me = mine;
		if (this.#mirror !== undefined) this.#mirror.readOnly = this.#me?.role === "viewer";
		const names = new Map(members.map((m) => [m.id, m.name]));
		if ([...names].some(([id, n]) => this.#view.names.get(id) !== n)) {
			this.#view.names = names;
			this.#view.invalidate();
		}
		this.#view.me = this.#me?.name ?? "";
	}

	/** A member by name, email or id prefix, for /role and /remove. */
	#findMember(query: string): Member | undefined {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return undefined;
		const exact = this.#members.filter((m) => m.name.toLowerCase() === q || m.email === q || m.id === q);
		if (exact.length === 1) return exact[0];
		const prefix = this.#members.filter((m) => m.name.toLowerCase().startsWith(q));
		return prefix.length === 1 ? prefix[0] : undefined;
	}

	#shareLink(url: string, invite: InviteInfo): void {
		copy(url);
		const expires = invite.expiresAt === undefined ? "never expires" : `expires ${new Date(invite.expiresAt).toLocaleDateString()}`;
		const who = invite.email ? `only ${invite.email}, after signing in with exe.dev` : `anyone with the link${invite.maxUses ? `, ${invite.maxUses} use${invite.maxUses > 1 ? "s" : ""}` : ""}`;
		this.#note(
			[
				`${c.bold(invite.email ? `invite for ${invite.email}` : "invite link")} ${c.gray(`(copied) · joins as ${invite.role} · ${who} · ${expires}`)}`,
				`  ${c.cyan(url)}`,
				c.gray("  opens in a browser, or join from a terminal with:"),
				`  syncpi --url ${url}`,
			].join("\n"),
			60_000,
		);
	}

	#showInvites(invites: InviteInfo[]): void {
		if (invites.length === 0) return this.#note(c.gray("no active invites"), 6_000);
		const lines = invites.map((i) => {
			const expires = i.expiresAt === undefined ? "no expiry" : `until ${new Date(i.expiresAt).toLocaleDateString()}`;
			return `  ${c.bold(i.code.slice(0, 6))}  ${i.email ?? "link"} ${c.gray(`· ${i.role} · used ${i.uses}${i.maxUses ? `/${i.maxUses}` : ""} · ${expires}`)}`;
		});
		this.#note([c.bold("invites"), ...lines, c.gray("  /revoke <code> stops one")].join("\n"), 30_000);
	}

	#show(conv: ConvName): void {
		this.#showing = conv;
		this.#view.thread = this.#threads[conv];
		this.#view.invalidate();
		this.#refresh();
	}

	#note(text: string, ms: number): void {
		this.#notes.lines = text.split("\n");
		if (this.#notesTimer !== undefined) clearTimeout(this.#notesTimer);
		this.#notesTimer = setTimeout(() => {
			this.#notes.lines = [];
			this.#refresh();
		}, ms);
		this.#refresh();
	}

	#refresh(): void {
		const s = this.#session;
		const name = s?.name ?? this.#record.name;
		const people = [...new Map(this.#online.map((p) => [p.memberId, p])).values()].map((p) => personColor(p.name)(`● ${p.name}`)).join(" ");
		const waiting = this.#setup !== undefined ? c.gray("the session is being created; type away, messages are sent once it is up") : c.gray("connecting…");
		const title = this.#showing === "setup" ? c.yellow(" · setup agent (Esc to go back)") : this.#showing === "side" ? c.yellow(" · your side thread, only you see it (Esc to go back)") : "";
		const me = this.#me === undefined ? "" : c.gray(` · you: ${this.#me.name}, ${this.#me.role}`);
		const branchInfo = this.#branches.find((b) => b.id === this.#branch);
		const branchLabel = branchInfo !== undefined && this.#branches.length > 1 ? c.yellow(` · ${branchInfo.label}`) : "";
		this.#header.lines = [`${c.bold(c.accent("syncpi"))} ${c.bold(name)} ${c.gray(this.#record.url)}${branchLabel}${me}${title}`, people || waiting];

		const thread = this.#threads[this.#showing].state;
		const parts: string[] = [];
		if (this.#setup?.error !== undefined) parts.push(c.red(`setup failed: ${this.#setup.error}`));
		else if (this.#setup !== undefined) {
			const queued = this.#conn.queued;
			parts.push(c.yellow(`${SPINNER[this.#frame % SPINNER.length]} setting up: ${this.#setup.step}${queued > 0 ? ` · ${queued} message${queued > 1 ? "s" : ""} waiting` : ""}`));
		} else if (this.#connState !== "open") parts.push(c.yellow(`${this.#connState}${this.#connDetail ? ` (${this.#connDetail})` : ""}`));
		if (thread.retry) parts.push(c.yellow(`retrying: ${thread.retry}`));
		else if (thread.busy) parts.push(c.accent(`${SPINNER[this.#frame % SPINNER.length]} working${this.#showing === "main" || this.#showing === "side" ? " · Esc to stop" : ""}`));
		if (thread.compacting) parts.push(c.accent("summarizing older messages…"));
		if (thread.queued > 0) parts.push(`${thread.queued} queued`);
		if (this.#setup === undefined) parts.push(envLabel(this.#env));
		if (this.#mirror !== undefined) parts.push(c.gray(`sync ↓${this.#mirror.pulled} ↑${this.#mirror.pushed}${this.#mirror.conflicts.length ? c.yellow(` ⚠${this.#mirror.conflicts.length}`) : ""}`));
		if (this.#setup === undefined) {
			parts.push(c.gray(`yours run ${this.#where === "device" ? "here" : "on the VM"}`));
			if (thread.busy && this.#target) parts.push(this.#localTools > 0 ? c.accent(`tools on this machine`) : c.gray(`tools on ${this.#target}`));
		}
		// Others' drafts as they type them: the end of what they're writing.
		for (const [owner, draft] of this.#drafts) {
			const text = draftText(draft.doc).toString().trim();
			if (owner === this.#me?.id || text === "" || isCommand(text)) continue;
			const tail = text.replace(/\s+/g, " ");
			parts.push(`${c.gray(`${draft.name}:`)} ${tail.length > 48 ? `…${tail.slice(-47)}` : tail}${c.accent("▍")}`);
		}
		if (thread.cost > 0) parts.push(c.gray(`$${thread.cost.toFixed(2)}`));
		if (thread.model) parts.push(c.gray(thread.model));
		this.#status.lines = ["", parts.join(c.gray(" · "))];
		this.#tui.requestRender();
	}
}

/** `/invite [email] [role] [7d|12h|never] [--uses N] [--link]`: everything optional; no email makes a link. */
export { parseInvite } from "../shared/commands.ts";

function envLabel(env: EnvStatus): string {
	switch (env.status) {
		case "ready":
			return c.green("env ready");
		case "failed":
			return c.red("env setup failed (/env)");
		case "running":
			return c.yellow(`env: ${env.activity ? truncateToWidth(env.activity, 40) : "setting up"} (/env)`);
		default:
			return c.gray("env: pending");
	}
}

function openUrl(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	execFile(cmd, [url], () => {});
}

function copy(text: string): void {
	if (process.platform !== "darwin") return;
	const child = execFile("pbcopy", () => {});
	child.stdin?.end(text);
}
