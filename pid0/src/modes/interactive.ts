import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	fuzzyFilter,
	Input,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SlashCommand,
	Spacer,
	type Terminal,
	Text,
	truncateToWidth,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { settingsPath, VERSION } from "../config.ts";
import { exportSession } from "../export.ts";
import { harnessStatus } from "../harnesses.ts";
import type { Pid0Event, Pid0Session } from "../session.ts";
import { type Item, listSessions, type SessionInfo, type ToolData } from "../store.ts";
import type { Prompt } from "./print.ts";
import { editorTheme, markdownTheme, selectTheme, style } from "./theme.ts";

export type InteractiveOptions = { prompts: Prompt[]; verbose: boolean; tuiMode?: "regular" | "fullscreen"; terminal?: Terminal };

const BUILTIN_COMMANDS: SlashCommand[] = [
	{ name: "harness", description: "Switch harness: claude, codex, antigravity, pi", argumentHint: "[name]" },
	{ name: "model", description: "Select a model of the harness", argumentHint: "[harness/model]" },
	{ name: "thinking", description: "Set the thinking level", argumentHint: "[level]" },
	{ name: "mode", description: "Set the harness mode (plan, accept edits, ...)", argumentHint: "[mode]" },
	{ name: "permissions", description: "How tool permission requests are answered", argumentHint: "[ask|allow|deny]" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "Resume another session" },
	{ name: "name", description: "Set the session display name", argumentHint: "[name]" },
	{ name: "session", description: "Show session information and statistics" },
	{ name: "tree", description: "Navigate the session tree" },
	{ name: "fork", description: "Create a new session from an earlier user message" },
	{ name: "clone", description: "Duplicate the current session" },
	{ name: "compact", description: "Compact the context into a summary", argumentHint: "[instructions]" },
	{ name: "copy", description: "Copy the last assistant message" },
	{ name: "export", description: "Export the session as HTML or JSONL", argumentHint: "[path]" },
	{ name: "login", description: "Sign in to the harness", argumentHint: "[method]" },
	{ name: "mcp", description: "List the MCP servers handed to the harness" },
	{ name: "settings", description: "Show where settings live" },
	{ name: "hotkeys", description: "Show keyboard shortcuts" },
	{ name: "quit", description: "Quit pid0" },
];

const HOTKEYS = `**Keys**

| Key | Action |
|---|---|
| Enter | Send (queues while the agent works) |
| Shift+Enter / Alt+Enter | New line |
| Esc | Stop the current turn; queued messages return to the editor |
| Ctrl+C | Clear the editor; twice to quit |
| Ctrl+D | Quit (empty editor) |
| Ctrl+L | Model selector |
| Ctrl+P | Cycle models (the --models scope, else the harness's models) |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Expand or collapse tool output |
| Ctrl+T | Show or hide thinking |
| Ctrl+G | Edit the prompt in $VISUAL / $EDITOR |
| @ / Tab | File search and path completion |
| !cmd / !!cmd | Run a shell command (!! keeps it from the agent) |`;

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function statusColor(status: string): (text: string) => string {
	return status === "completed" ? style.green : status === "failed" ? style.red : status === "cancelled" ? style.gray : style.yellow;
}

export function toolLines(tool: Pick<ToolData, "title" | "status" | "output" | "diffs" | "kind">, expanded: boolean): string {
	const lines = [`${statusColor(tool.status)("●")} ${style.bold(tool.title)}${tool.status === "completed" ? "" : style.gray(` ${tool.status.replace("_", " ")}`)}`];
	for (const diff of tool.diffs ?? []) {
		const added = diff.newText.split("\n").length;
		const removed = diff.oldText ? diff.oldText.split("\n").length : 0;
		lines.push(`  ${style.green(`+${added}`)} ${style.red(`-${removed}`)} ${diff.path}`);
		if (expanded) for (const line of diff.newText.split("\n").slice(0, 200)) lines.push(style.green(`  + ${line}`));
	}
	const output = tool.output?.replace(/\s+$/, "");
	if (output) {
		const all = output.split("\n");
		const shown = expanded ? all : all.slice(0, 5);
		for (const line of shown) lines.push(style.gray(`  ${line.replace(/\t/g, "    ")}`));
		if (all.length > shown.length) lines.push(style.gray(`  … ${all.length - shown.length} more lines (Ctrl+O)`));
	}
	return lines.join("\n");
}

class ToolBlock extends Text {
	tool: Pick<ToolData, "title" | "status" | "output" | "diffs" | "kind">;
	constructor(tool: ToolBlock["tool"], expanded: boolean) {
		super(toolLines(tool, expanded), 1, 0);
		this.tool = tool;
	}
	refresh(expanded: boolean): void {
		this.setText(toolLines(this.tool, expanded));
	}
}

class AssistantBlock extends Container {
	text = "";
	thinking = "";
	readonly #thinkingView = new Text("", 1, 0);
	readonly #body = new Markdown("", 1, 0, markdownTheme);
	#hasThinking = false;
	#hasBody = false;

	refresh(showThinking: boolean): void {
		if (this.thinking) {
			if (!this.#hasThinking) {
				this.children.unshift(this.#thinkingView);
				this.#hasThinking = true;
			}
			this.#thinkingView.setText(showThinking ? style.gray(style.italic(this.thinking.trim())) : style.gray(style.italic("Thinking…")));
		}
		if (this.text) {
			if (!this.#hasBody) {
				this.addChild(this.#body);
				this.#hasBody = true;
			}
			this.#body.setText(this.text.trim());
		}
		this.invalidate();
	}
}

class Selector implements Component {
	readonly #title: string;
	readonly #items: SelectItem[];
	readonly #input = new Input({ prompt: style.gray("search: ") });
	#list: SelectList;
	readonly #hint: string;
	onSelect: (item: SelectItem) => void = () => {};
	onCancel: () => void = () => {};
	readonly capturesViewportInput = true;

	constructor(title: string, items: SelectItem[], hint = "") {
		this.#title = title;
		this.#items = items;
		this.#hint = hint;
		this.#list = this.#build(items);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 12, selectTheme);
		list.onSelect = (item) => this.onSelect(item);
		list.onCancel = () => this.onCancel();
		return list;
	}

	select(value: string): void {
		const index = this.#items.findIndex((item) => item.value === value);
		if (index >= 0) this.#list.setSelectedIndex(index);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+c")) {
			if (matchesKey(data, "ctrl+c")) this.onCancel();
			else this.#list.handleInput(data);
			return;
		}
		const before = this.#input.getValue();
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		if (query !== before) this.#list = this.#build(query ? fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.description ?? ""}`) : this.#items);
	}

	invalidate(): void {
		this.#list.invalidate();
		this.#input.invalidate();
	}

	render(width: number): string[] {
		const rule = style.gray("─".repeat(Math.max(1, width)));
		return [rule, truncateToWidth(` ${style.bold(this.#title)}${this.#hint ? style.gray(`  ${this.#hint}`) : ""}`, width), ...(this.#items.length > 8 ? this.#input.render(width) : []), ...this.#list.render(width), rule];
	}
}

class Footer implements Component {
	readonly #session: Pid0Session;
	branch: string | undefined;

	constructor(session: Pid0Session) {
		this.#session = session;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const s = this.#session.state;
		const where = `${shortPath(s.cwd)}${this.branch ? ` (${this.branch})` : ""}${s.sessionName ? ` • ${s.sessionName}` : ""}`;
		const totals = this.#session.totals;
		const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
		const usage = [
			totals.total ? `↑${fmt(totals.input)} ↓${fmt(totals.output)}` : "",
			s.cost ? `${s.cost.currency === "USD" ? "$" : ""}${s.cost.amount.toFixed(3)}` : "",
			s.context?.size ? `${((s.context.used / s.context.size) * 100).toFixed(1)}%/${fmt(s.context.size)}` : "",
		].filter(Boolean).join(" ");
		const model = [s.harnessLabel, s.modelName ?? (s.connected ? "default model" : "not connected yet"), s.thinkingLevel, s.mode && s.mode !== "default" ? s.mode : "", this.#session.permissions !== "ask" ? `permissions: ${this.#session.permissions}` : ""].filter(Boolean).join(" • ");
		const gap = Math.max(1, width - visibleWidth(usage) - visibleWidth(model));
		return [style.gray(truncateToWidth(where, width)), truncateToWidth(`${style.gray(usage)}${" ".repeat(gap)}${style.gray(model)}`, width)];
	}
}

function sessionItems(sessions: SessionInfo[], cwd: string): SelectItem[] {
	return sessions.map((s) => ({
		value: s.file,
		label: (s.name ?? s.first?.split("\n")[0] ?? "(empty)").slice(0, 70),
		description: `${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")} · ${s.messages} msgs${s.cwd === cwd ? "" : ` · ${shortPath(s.cwd)}`}`,
	}));
}

function makeTui(terminal: Terminal, mode: "regular" | "fullscreen" | undefined): TUI {
	return mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
}

async function standalone<T>(build: (tui: TUI, done: (value: T) => void) => Component): Promise<T> {
	const tui = makeTui(new ProcessTerminal(), "regular");
	return new Promise<T>((resolve) => {
		const component = build(tui, (value) => {
			tui.stop();
			resolve(value);
		});
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
	});
}

export function confirm(question: string): Promise<boolean> {
	return standalone<boolean>((_tui, done) => {
		const selector = new Selector(question, [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
		selector.onSelect = (item) => done(item.value === "yes");
		selector.onCancel = () => done(false);
		return selector;
	});
}

export async function pickSession(root: string, cwd: string): Promise<SessionInfo | undefined> {
	const local = await listSessions(root, cwd);
	const all = await listSessions(root);
	const sessions = [...local, ...all.filter((s) => !local.some((l) => l.file === s.file))];
	if (sessions.length === 0) {
		process.stderr.write("pid0: no sessions to resume yet\n");
		return undefined;
	}
	return standalone<SessionInfo | undefined>((_tui, done) => {
		const selector = new Selector("Resume a session", sessionItems(sessions, cwd), "type to search · enter to open · esc to cancel");
		selector.onSelect = (item) => done(sessions.find((s) => s.file === item.value));
		selector.onCancel = () => done(undefined);
		return selector;
	});
}

export class InteractiveApp {
	readonly tui: TUI;
	readonly session: Pid0Session;
	readonly editor: Editor;
	readonly chat = new Container();
	readonly #pending = new Container();
	readonly #status = new Container();
	readonly #editorSlot = new Container();
	readonly #footer: Footer;
	readonly #loader: Loader;
	readonly #tools = new Map<string, ToolBlock>();
	readonly #allTools: ToolBlock[] = [];
	readonly #assistants: AssistantBlock[] = [];
	#assistant: AssistantBlock | undefined;
	#selector: Selector | undefined;
	#selectorLine: Promise<unknown> = Promise.resolve();
	#expanded = false;
	#showThinking: boolean;
	#lastCtrlC = 0;
	#done: (code: number) => void = () => {};
	readonly #options: InteractiveOptions;
	readonly finished: Promise<number>;

	constructor(session: Pid0Session, options: InteractiveOptions) {
		this.session = session;
		this.#options = options;
		this.#showThinking = !session.settings.hideThinking;
		this.tui = makeTui(options.terminal ?? new ProcessTerminal(), options.tuiMode ?? session.settings.tuiMode);
		this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		this.#footer = new Footer(session);
		this.#loader = new Loader(this.tui, style.cyan, style.gray, "Working… (esc to interrupt)");
		this.finished = new Promise((resolve) => (this.#done = resolve));
		this.tui.addChild(this.chat);
		this.tui.addChild(this.#pending);
		this.tui.addChild(this.#status);
		this.tui.addChild(this.#editorSlot);
		this.tui.addChild(this.#footer);
		this.#editorSlot.addChild(this.editor);
		this.editor.onSubmit = (text) => void this.submit(text);
		this.tui.addInputListener((data) => this.#key(data));
		session.subscribe((event) => this.#onEvent(event));
		session.onPermission = (request, harness) => this.#askPermission(request, harness);
		this.#refreshCommands();
		try {
			const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.cwd, encoding: "utf8" });
			if (head.status === 0) this.#footer.branch = head.stdout.trim();
		} catch {}
	}

	async start(): Promise<void> {
		if (!this.session.settings.quietStartup) {
			this.info(`${style.bold("pid0")} ${VERSION} · ${this.session.label()} over ACP · /harness and /model to switch · /hotkeys for keys`);
		}
		await this.#replay();
		this.tui.setFocus(this.editor);
		this.tui.start();
		void this.session.connect().then(
			() => this.tui.requestRender(),
			(error) => this.#error(error),
		);
		for (const prompt of this.#options.prompts) await this.session.promptAndWait(prompt.text, prompt.images ? { images: prompt.images } : {});
	}

	stop(code = 0): void {
		this.#loader.stop();
		this.tui.stop();
		if (this.session.persistent && this.session.store.meta.messages > 0) process.stdout.write(`\nResume this session with: pid0 --session ${this.session.store.id.slice(0, 8)}\n`);
		this.#done(code);
	}

	info(text: string): void {
		this.chat.addChild(new Text(style.gray(text), 1, 0));
		this.tui.requestRender();
	}

	#error(error: unknown): void {
		this.chat.addChild(new Text(style.red((error as Error).message ?? String(error)), 1, 0));
		this.tui.requestRender();
	}

	markdown(text: string): void {
		this.chat.addChild(new Markdown(text, 1, 0, markdownTheme));
		this.tui.requestRender();
	}

	#refreshCommands(): void {
		const harness: SlashCommand[] = (this.session.native?.commands ?? []).filter((c) => !BUILTIN_COMMANDS.some((b) => b.name === c.name)).map((c) => ({ name: c.name, description: `${c.description} (${this.session.label()})` }));
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...BUILTIN_COMMANDS, ...harness], this.session.cwd));
	}

	#user(text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(text, 1, 1, style.userBg));
	}

	#item(item: Item): void {
		switch (item.kind) {
			case "user":
				this.#user(item.data.text);
				break;
			case "assistant": {
				const block = new AssistantBlock();
				block.text = item.data.text;
				block.thinking = item.data.thinking ?? "";
				block.refresh(this.#showThinking);
				this.#assistants.push(block);
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(block);
				break;
			}
			case "tool": {
				const block = new ToolBlock(item.data, this.#expanded);
				this.#allTools.push(block);
				this.chat.addChild(block);
				break;
			}
			case "plan":
				this.#plan(item.data.entries);
				break;
			case "shell":
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(new Text(`${style.bold(`$ ${item.data.command}`)}${item.data.excluded ? style.gray(" (not shared with the agent)") : ""}\n${style.gray(item.data.output.replace(/\s+$/, ""))}`, 1, 0));
				break;
			case "switch":
				this.chat.addChild(new Text(style.gray(`— switched to ${this.session.label(item.data.harness)}`), 1, 0));
				break;
			case "reset":
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(new Text(style.gray(`— compacted; the conversation continues from this summary:\n${item.data.summary ?? ""}`), 1, 0));
				break;
			case "turn":
				if (item.data.error) this.chat.addChild(new Text(style.red(item.data.error), 1, 0));
				else if (item.data.stopReason === "cancelled") this.chat.addChild(new Text(style.gray("— stopped"), 1, 0));
				break;
		}
	}

	#plan(entries: { content: string; status: string }[]): void {
		const mark = (status: string) => (status === "completed" ? style.green("✓") : status === "in_progress" ? style.yellow("▸") : style.gray("○"));
		this.chat.addChild(new Text(entries.map((e) => `${mark(e.status)} ${e.status === "completed" ? style.gray(e.content) : e.content}`).join("\n"), 1, 0));
	}

	async #replay(): Promise<void> {
		const keep = this.chat.children.slice(0, this.session.settings.quietStartup ? 0 : 1);
		this.chat.clear();
		for (const child of keep) this.chat.addChild(child);
		this.#tools.clear();
		this.#allTools.length = 0;
		this.#assistants.length = 0;
		this.#assistant = undefined;
		for (const item of await this.session.messages()) this.#item(item);
		this.tui.requestRender(true);
	}

	#setBusy(busy: boolean): void {
		this.#status.clear();
		if (busy) {
			this.#status.addChild(new Spacer(1));
			this.#status.addChild(this.#loader);
			this.#loader.start();
		} else this.#loader.stop();
		this.tui.terminal.setProgress?.(busy);
	}

	#renderQueue(): void {
		this.#pending.clear();
		for (const text of this.session.queued) this.#pending.addChild(new Text(style.gray(`queued: ${text.split("\n")[0]!.slice(0, 100)}`), 1, 0));
	}

	#onEvent(event: Pid0Event): void {
		switch (event.type) {
			case "agent_start":
				this.#setBusy(true);
				break;
			case "agent_settled":
				this.#setBusy(false);
				break;
			case "message_start":
				if (event.message.role === "user") this.#user(event.message.content);
				else {
					this.#assistant = new AssistantBlock();
					this.#assistants.push(this.#assistant);
					this.chat.addChild(new Spacer(1));
					this.chat.addChild(this.#assistant);
				}
				break;
			case "message_update": {
				if (!this.#assistant) break;
				if (event.assistantMessageEvent.type === "text_delta") this.#assistant.text += event.assistantMessageEvent.delta;
				else this.#assistant.thinking += event.assistantMessageEvent.delta;
				this.#assistant.refresh(this.#showThinking);
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") this.#assistant = undefined;
				break;
			case "tool_execution_start": {
				const block = new ToolBlock({ title: event.toolName, status: "pending", ...(event.kind ? { kind: event.kind } : {}) }, this.#expanded);
				this.#tools.set(event.toolCallId, block);
				this.#allTools.push(block);
				this.chat.addChild(block);
				break;
			}
			case "tool_execution_update":
			case "tool_execution_end": {
				const block = this.#tools.get(event.toolCallId);
				if (!block) break;
				const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
				const output = result.content.map((c) => c.text).join("\n");
				block.tool = {
					...block.tool,
					title: event.toolName,
					status: event.type === "tool_execution_end" ? (event.isError ? (this.session.state.isStreaming && !output ? "cancelled" : "failed") : "completed") : event.status,
					...(output ? { output } : {}),
					...(result.diffs ? { diffs: result.diffs } : {}),
				};
				block.refresh(this.#expanded);
				break;
			}
			case "plan_update":
				this.#plan(event.entries);
				break;
			case "turn_end":
				if (event.stopReason === "cancelled") this.chat.addChild(new Text(style.gray("— stopped"), 1, 0));
				else if (event.stopReason !== "end_turn" && event.stopReason !== "error") this.chat.addChild(new Text(style.yellow(`— ${event.stopReason.replace(/_/g, " ")}`), 1, 0));
				break;
			case "queue_update":
				this.#renderQueue();
				break;
			case "notice":
				this.chat.addChild(new Text((event.level === "error" ? style.red : event.level === "warning" ? style.yellow : style.gray)(event.text), 1, 0));
				break;
			case "commands_changed":
				this.#refreshCommands();
				break;
			case "compaction_start":
				this.#setBusy(true);
				this.#loader.setMessage("Compacting… (esc to cancel)");
				break;
			case "compaction_end":
				this.#setBusy(false);
				this.#loader.setMessage("Working… (esc to interrupt)");
				break;
			case "shell_end":
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(new Text(`${style.bold(`$ ${event.command}`)}${event.excluded ? style.gray(" (not shared with the agent)") : ""}\n${style.gray(event.output.replace(/\s+$/, ""))}${event.exitCode ? style.red(`\nexit ${event.exitCode}`) : ""}`, 1, 0));
				break;
			case "session_changed":
				void this.#replay();
				this.#renderQueue();
				break;
			case "harness_changed":
				this.#refreshCommands();
				break;
		}
		this.tui.requestRender();
	}

	#key(data: string): { consume?: boolean } | undefined {
		if (this.#selector) return undefined;
		if (matchesKey(data, "ctrl+c")) {
			if (this.editor.getText()) {
				this.editor.setText("");
				this.#lastCtrlC = 0;
			} else if (Date.now() - this.#lastCtrlC < 800) this.stop();
			else {
				this.#lastCtrlC = Date.now();
				this.info("press Ctrl+C again to quit");
			}
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !this.editor.getText()) {
			this.stop();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete() && (this.session.isStreaming || this.session.state.isCompacting)) {
			const queued = this.session.takeQueue();
			if (queued.length) this.editor.setText([...queued, this.editor.getText()].filter(Boolean).join("\n\n"));
			void this.session.abort();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+l")) return this.#run(() => this.#command("model", ""));
		if (matchesKey(data, "ctrl+p")) {
			return this.#run(async () => {
				const next = await this.session.cycleModel();
				if (!next) this.info(`${this.session.label()} offers no other model`);
			});
		}
		if (matchesKey(data, "shift+tab")) {
			return this.#run(async () => {
				const level = await this.session.cycleThinking();
				if (!level) this.info(`${this.session.label()} does not offer thinking levels over ACP`);
			});
		}
		if (matchesKey(data, "ctrl+o")) {
			this.#expanded = !this.#expanded;
			for (const block of this.#allTools) block.refresh(this.#expanded);
			this.tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+t")) {
			this.#showThinking = !this.#showThinking;
			for (const block of this.#assistants) block.refresh(this.#showThinking);
			this.tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+g")) {
			this.#externalEditor();
			return { consume: true };
		}
		return undefined;
	}

	#run(work: () => Promise<unknown>): { consume: boolean } {
		work().then(
			() => this.tui.requestRender(),
			(error) => this.#error(error),
		);
		return { consume: true };
	}

	#externalEditor(): void {
		const command = process.env.VISUAL ?? process.env.EDITOR;
		if (!command) {
			this.info("set $VISUAL or $EDITOR to edit the prompt in an external editor");
			return;
		}
		const file = join(mkdtempSync(join(tmpdir(), "pid0-edit-")), "prompt.md");
		writeFileSync(file, this.editor.getText());
		this.tui.stop();
		spawnSync(command, [file], { stdio: "inherit", shell: true });
		this.tui.start();
		this.editor.setText(readFileSync(file, "utf8").replace(/\n$/, ""));
		this.tui.requestRender(true);
	}

	select(title: string, items: SelectItem[], options: { current?: string; hint?: string } = {}): Promise<string | undefined> {
		const run = this.#selectorLine.then(
			() =>
				new Promise<string | undefined>((resolve) => {
					const selector = new Selector(title, items, options.hint ?? "enter to choose · esc to cancel");
					if (options.current) selector.select(options.current);
					const close = (value: string | undefined) => {
						this.#selector = undefined;
						this.#editorSlot.clear();
						this.#editorSlot.addChild(this.editor);
						this.tui.setFocus(this.editor);
						this.tui.requestRender();
						resolve(value);
					};
					selector.onSelect = (item) => close(item.value);
					selector.onCancel = () => close(undefined);
					this.#selector = selector;
					this.#editorSlot.clear();
					this.#editorSlot.addChild(selector);
					this.tui.setFocus(selector);
					this.tui.requestRender();
				}),
		);
		this.#selectorLine = run.catch(() => {});
		return run;
	}

	async #askPermission(request: RequestPermissionRequest, harness: string): Promise<RequestPermissionResponse> {
		const title = `${this.session.label(harness)} asks to run: ${request.toolCall.title ?? "a tool"}`;
		const chosen = await this.select(title, request.options.map((o) => ({ value: o.optionId, label: o.name, description: o.kind.replace(/_/g, " ") })), { hint: "enter to answer · esc to reject" });
		return chosen ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } };
	}

	async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.setText("");
		this.editor.addToHistory(text);
		try {
			if (text.startsWith("!")) {
				const excluded = text.startsWith("!!");
				const command = text.slice(excluded ? 2 : 1).trim();
				if (command) await this.session.shell(command, excluded);
				return;
			}
			if (text.startsWith("/")) {
				const space = text.search(/\s/);
				const name = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
				if (BUILTIN_COMMANDS.some((c) => c.name === name) || name === "help" || name === "exit") {
					await this.#command(name, space < 0 ? "" : text.slice(space + 1).trim());
					this.tui.requestRender();
					return;
				}
			}
			await this.session.prompt(text);
		} catch (error) {
			this.#error(error);
		}
	}

	async #command(name: string, arg: string): Promise<void> {
		const session = this.session;
		switch (name) {
			case "quit":
			case "exit":
				this.stop();
				return;
			case "help":
			case "hotkeys":
				this.markdown(`${HOTKEYS}\n\n**Commands**\n\n${BUILTIN_COMMANDS.map((c) => `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\`: ${c.description}`).join("\n")}`);
				return;
			case "harness": {
				let target = arg;
				if (!target) {
					const items = harnessStatus(session.settings).map((h) => ({ value: h.harness.id, label: h.harness.label, description: h.available ? (h.harness.id === session.harness ? "current" : h.note) : `not installed: ${h.harness.install}` }));
					target = (await this.select("Harness", items, { current: session.harness })) ?? "";
				}
				if (!target) return;
				await session.setHarness(target);
				this.info(`— now talking to ${session.label()}; it is told what happened so far with its next prompt`);
				await session.connect();
				return;
			}
			case "model": {
				if (arg) {
					const set = await session.setModel(arg);
					this.info(`— ${session.label(set.harness)} · ${set.model ?? "default model"}`);
					return;
				}
				const state = await session.connect();
				const items: SelectItem[] = state.models.map((m) => ({ value: `${session.harness}/${m.id}`, label: m.name, description: m.description ?? m.id }));
				for (const h of harnessStatus(session.settings)) if (h.harness.id !== session.harness) items.push({ value: `@${h.harness.id}`, label: `→ ${h.harness.label}`, description: h.available ? "switch harness, then choose its model" : "not installed" });
				const chosen = await this.select(`Model (${session.label()})`, items, state.currentModel ? { current: `${session.harness}/${state.currentModel}` } : {});
				if (!chosen) return;
				if (chosen.startsWith("@")) {
					await this.#command("harness", chosen.slice(1));
					await this.#command("model", "");
					return;
				}
				const set = await session.setModel(chosen);
				this.info(`— ${session.label(set.harness)} · ${set.model ?? "default model"}`);
				return;
			}
			case "thinking": {
				const state = await session.connect();
				if (state.thinking.length === 0) throw new Error(`${session.label()} does not offer thinking levels over ACP`);
				const level = arg || (await this.select("Thinking level", state.thinking.map((t) => ({ value: t.id, label: t.name, ...(t.description ? { description: t.description } : {}) })), state.currentThinking ? { current: state.currentThinking } : {}));
				if (level) this.info(`— thinking: ${await session.setThinking(level)}`);
				return;
			}
			case "mode": {
				const state = await session.connect();
				if (state.modes.length === 0) throw new Error(`${session.label()} does not offer modes over ACP`);
				const mode = arg || (await this.select("Mode", state.modes.map((t) => ({ value: t.id, label: t.name, ...(t.description ? { description: t.description } : {}) })), state.currentMode ? { current: state.currentMode } : {}));
				if (mode) this.info(`— mode: ${await session.setMode(mode)}`);
				return;
			}
			case "permissions": {
				const policy = arg || (await this.select("Tool permission requests", [{ value: "ask", label: "Ask", description: "show each request" }, { value: "allow", label: "Allow", description: "approve every request" }, { value: "deny", label: "Deny", description: "reject every request" }], { current: session.permissions }));
				if (!policy) return;
				if (policy !== "ask" && policy !== "allow" && policy !== "deny") throw new Error("permissions are ask, allow or deny");
				session.permissions = policy;
				this.info(`— permission requests: ${policy}`);
				return;
			}
			case "new":
				await session.newSession();
				this.info("— new session");
				return;
			case "resume": {
				const local = await listSessions(session.root, session.cwd);
				const sessions = [...local, ...(await listSessions(session.root)).filter((s) => !local.some((l) => l.file === s.file))].filter((s) => s.file !== session.store.file);
				if (sessions.length === 0) {
					this.info("no other sessions yet");
					return;
				}
				const file = await this.select("Resume a session", sessionItems(sessions, session.cwd), { hint: "type to search · enter to open · esc to cancel" });
				if (file) await session.switchSession(file);
				return;
			}
			case "name":
				if (!arg) this.info(session.store.meta.name ? `session name: ${session.store.meta.name}` : "this session has no name; /name <name> sets one");
				else await session.setName(arg);
				return;
			case "session": {
				const s = session.state;
				const items = await session.messages();
				const count = (kind: string) => items.filter((i) => i.kind === kind).length;
				const native = session.native;
				this.markdown(
					[
						"**Session**",
						"",
						`- File: \`${s.sessionFile ?? "(in memory)"}\``,
						`- ID: \`${s.sessionId}\`${s.sessionName ? ` (${s.sessionName})` : ""}`,
						`- Branch: conversation ${session.store.branch} of ${(await session.store.branches()).length}`,
						`- Harness: ${s.harnessLabel}${native ? ` (native session \`${native.sessionId}\`)` : ""}; model ${s.modelName ?? "default"}`,
						`- Messages: ${count("user")} user, ${count("assistant")} assistant, ${count("tool")} tool calls`,
						`- Tokens: ${session.totals.input} in, ${session.totals.output} out, ${session.totals.total} total${s.cost ? `; cost ${s.cost.amount.toFixed(4)} ${s.cost.currency}` : ""}`,
						...(s.context ? [`- Context: ${s.context.used} of ${s.context.size}`] : []),
					].join("\n"),
				);
				return;
			}
			case "tree": {
				const tree = await session.store.tree();
				const active = new Set((await session.messages()).map((i) => i.id));
				const depth = new Map<number, number>();
				for (const b of tree.branches) depth.set(b.id, b.parent === undefined ? 0 : (depth.get(b.parent) ?? 0) + 1);
				const rows = tree.items.filter((i) => i.kind === "user" || i.kind === "assistant" || i.kind === "reset");
				if (rows.length === 0) {
					this.info("nothing to navigate yet");
					return;
				}
				const items = rows.map((i) => ({
					value: String(i.id),
					label: `${"  ".repeat(depth.get(i.conversation) ?? 0)}${active.has(i.id) ? "●" : "○"} ${i.kind === "user" ? "you: " : i.kind === "assistant" ? `${session.label(i.data.harness)}: ` : "summary: "}${(i.kind === "reset" ? (i.data.summary ?? "") : i.data.text).split("\n")[0]!.slice(0, 80)}`,
				}));
				const chosen = await this.select("Session tree", items, { hint: "● is the branch you are on · a user message is put back in the editor · esc to cancel" });
				if (!chosen) return;
				const picked = rows.find((i) => String(i.id) === chosen)!;
				if (picked.kind === "user") {
					const before = tree.items.findLast((i) => i.id < picked.id && this.#visibleFrom(tree, picked, i));
					await session.navigate(before?.id);
					this.editor.setText(picked.data.text);
				} else {
					const turnEnd = tree.items.find((i) => i.id > picked.id && i.kind === "turn" && i.conversation === picked.conversation);
					const next = tree.items.find((i) => i.id > picked.id && i.conversation === picked.conversation && (i.kind === "user" || i.kind === "assistant"));
					await session.navigate(turnEnd && (!next || turnEnd.id < next.id) ? turnEnd.id : picked.id);
				}
				return;
			}
			case "fork": {
				const items = await session.messages();
				const users = items.filter((i) => i.kind === "user");
				if (users.length === 0) {
					this.info("no messages to fork from yet");
					return;
				}
				const chosen = await this.select("Fork from a message (creates a new session)", users.map((i) => ({ value: String(i.id), label: (i.kind === "user" ? i.data.text : "").split("\n")[0]!.slice(0, 90) })));
				if (!chosen) return;
				const index = items.findIndex((i) => String(i.id) === chosen);
				const text = (items[index] as Extract<Item, { kind: "user" }>).data.text;
				await session.clone(index === 0 ? "empty" : items[index - 1]!.id);
				this.editor.setText(text);
				return;
			}
			case "clone":
				await session.clone();
				this.info("— this is a copy of the session; the original is unchanged");
				return;
			case "compact":
				await session.compact(arg || undefined);
				await this.#replay();
				return;
			case "copy": {
				const text = await session.lastAssistantText();
				if (!text) {
					this.info("no assistant message to copy yet");
					return;
				}
				this.tui.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
				this.info("copied the last assistant message");
				return;
			}
			case "export": {
				const path = exportSession(session.store.meta, await session.messages(), (h) => session.label(h), arg || `pid0-session-${session.store.id}.html`);
				this.info(`exported to ${path}`);
				return;
			}
			case "login": {
				await session.connect().catch(() => {});
				const agent = session.agent;
				const methods = agent?.authMethods ?? [];
				if (!agent || methods.length === 0) {
					this.info(`${session.label()} offers no sign-in over ACP; sign in with its own CLI. From a shell: pid0 auth login ${session.harness}`);
					return;
				}
				const method = arg || (await this.select(`Sign in to ${session.label()}`, methods.map((m) => ({ value: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) }))));
				if (!method) return;
				const chosen = methods.find((m) => m.id === method) as { id: string; type?: string } | undefined;
				if (!chosen) throw new Error(`no sign-in method "${method}"`);
				if (chosen.type === "terminal") this.info(`this sign-in runs in a terminal; quit and run: pid0 auth login ${session.harness} ${chosen.id}`);
				else {
					await agent.authenticate(chosen.id);
					this.info(`signed in to ${session.label()}`);
				}
				return;
			}
			case "mcp": {
				const { loadMcpServers } = await import("../config.ts");
				const servers = Object.entries(loadMcpServers(session.cwd));
				this.markdown(servers.length ? `**MCP servers handed to every harness**\n\n${servers.map(([n, s]) => `- \`${n}\`: ${"command" in s ? [s.command, ...(s.args ?? [])].join(" ") : s.url}`).join("\n")}\n\nChange them with \`pid0 mcp add|remove\`.` : "No MCP servers. Add one from a shell: `pid0 mcp add <name> -- <command> [args...]`.");
				return;
			}
			case "settings":
				this.markdown(`Settings live in \`${settingsPath()}\` (and \`.pid0/settings.json\` in a project): \`defaultHarness\`, \`defaultModels\`, \`scopedModels\`, \`harnesses\`, \`permissions\`, \`hideThinking\`, \`tuiMode\`, \`sessionDir\`.`);
				return;
		}
	}

	#visibleFrom(tree: { branches: { id: number; parent?: number; at?: number }[] }, target: Item, candidate: Item): boolean {
		let conversation: number | undefined = target.conversation;
		let limit = target.id - 1;
		while (conversation !== undefined) {
			if (candidate.conversation === conversation) return candidate.id <= limit;
			const branch = tree.branches.find((b) => b.id === conversation);
			if (!branch || branch.parent === undefined) return false;
			limit = Math.min(limit, branch.at ?? 0);
			conversation = branch.parent;
		}
		return false;
	}
}

export async function runInteractive(session: Pid0Session, options: InteractiveOptions): Promise<number> {
	const app = new InteractiveApp(session, options);
	const quiet = (...parts: unknown[]) => {
		if (options.verbose) app.info(parts.map(String).join(" "));
	};
	const saved = { error: console.error, warn: console.warn, log: console.log };
	console.error = quiet;
	console.warn = quiet;
	console.log = quiet;
	try {
		await app.start();
		return await app.finished;
	} finally {
		Object.assign(console, saved);
	}
}
