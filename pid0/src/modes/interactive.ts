import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CompactionSummaryMessageComponent,
	copyToClipboard,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	CustomEditor,
	DynamicBorder,
	ExtensionInputComponent,
	generateDiffString,
	getMarkdownTheme,
	getSelectListTheme,
	keyHint,
	keyText,
	rawKeyHint,
	SessionSelectorComponent,
	type SettingsCallbacks,
	SettingsSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	TreeSelectorComponent,
	UserMessageComponent,
	UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Input,
	isViewportTUI,
	Loader,
	Markdown,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SlashCommand,
	Spacer,
	type Terminal,
	Text,
	TruncatedText,
	truncateToWidth,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { loadMcpServers, updateSettings, VERSION } from "../config.ts";
import { exportSession, importSession } from "../export.ts";
import { harnessStatus } from "../harnesses.ts";
import { type AppKeybindings, clipboardImage, keybindingsModule, ScopedModelsSelectorComponent, theme, themes, ui, viewport } from "../pi.ts";
import { Resources } from "../resources.ts";
import type { ImageInput, Pid0Event, Pid0Session } from "../session.ts";
import { type Item, listSessions, type SessionInfo, SessionStore, type ToolData } from "../store.ts";
import type { Prompt } from "./print.ts";

export type InteractiveOptions = { prompts: Prompt[]; verbose: boolean; tuiMode?: "regular" | "fullscreen"; terminal?: Terminal; resources?: Resources; themeName?: string };

const COMMANDS: SlashCommand[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "harness", description: "Switch harness (Claude Code, Codex, Antigravity, pi)", argumentHint: "[name]" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "[harness/model]" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "thinking", description: "Select thinking level", argumentHint: "[level]" },
	{ name: "mode", description: "Select the harness mode (plan, accept edits, ...)", argumentHint: "[mode]" },
	{ name: "handoff", description: "Whether a harness you switch to is told which agents came before", argumentHint: "[anonymous|named]" },
	{ name: "permissions", description: "How tool permission requests are answered", argumentHint: "[ask|allow|deny]" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", argumentHint: "[path]" },
	{ name: "import", description: "Import and resume a session from a JSONL file", argumentHint: "<path>" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name", argumentHint: "[name]" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Sign in to the harness", argumentHint: "[method]" },
	{ name: "logout", description: "Sign out of the harness" },
	{ name: "mcp", description: "List the MCP servers handed to the harness" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, skills, prompts, themes, and settings" },
	{ name: "debug", description: "Write the rendered screen and session to a debug log" },
	{ name: "quit", description: "Quit pid0" },
];

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

type ToolView = Pick<ToolData, "title" | "status" | "kind" | "input" | "output" | "diffs" | "locations">;

function pathOf(tool: ToolView): string | undefined {
	const input = (tool.input ?? {}) as Record<string, unknown>;
	const path = input.path ?? input.file_path ?? input.filePath ?? input.abs_path ?? tool.locations?.[0]?.path;
	return typeof path === "string" ? path : undefined;
}

export function piTool(tool: ToolView, cwd: string): { name: string; args: unknown; definition: unknown; details?: unknown } {
	const input = (tool.input ?? {}) as Record<string, unknown>;
	const diff = tool.diffs?.[0];
	if (diff) {
		if (diff.oldText === undefined) return { name: "write", args: { path: diff.path, content: diff.newText }, definition: createWriteToolDefinition(cwd) };
		const generated = generateDiffString(diff.oldText, diff.newText);
		return { name: "edit", args: { path: diff.path, edits: [{ oldText: diff.oldText, newText: diff.newText }] }, definition: createEditToolDefinition(cwd), details: { diff: generated.diff, firstChangedLine: generated.firstChangedLine } };
	}
	if (tool.kind === "execute") {
		const raw = input.command ?? input.cmd;
		const command = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : tool.title;
		return { name: "bash", args: { command }, definition: createBashToolDefinition(cwd) };
	}
	const path = pathOf(tool);
	if (tool.kind === "read" && path) return { name: "read", args: { path, ...(typeof input.offset === "number" ? { offset: input.offset } : {}), ...(typeof input.limit === "number" ? { limit: input.limit } : {}) }, definition: createReadToolDefinition(cwd) };
	return { name: tool.title, args: tool.input ?? {}, definition: undefined };
}

class ToolBlock extends Container {
	tool: ToolView;
	readonly #tui: TUI;
	readonly #cwd: string;
	#expanded: boolean;
	#outputPad: number;

	constructor(tool: ToolView, tui: TUI, cwd: string, expanded: boolean, outputPad: number) {
		super();
		this.tool = tool;
		this.#tui = tui;
		this.#cwd = cwd;
		this.#expanded = expanded;
		this.#outputPad = outputPad;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.rebuild();
	}

	setOutputPad(pad: number): void {
		this.#outputPad = pad;
		this.rebuild();
	}

	rebuild(): void {
		const tool = this.tool;
		const mapped = piTool(tool, this.#cwd);
		const component = new ToolExecutionComponent(mapped.name, "tool", mapped.args, { outputPad: this.#outputPad }, mapped.definition as never, this.#tui, this.#cwd);
		component.setArgsComplete();
		if (tool.status !== "pending") component.markExecutionStarted();
		const done = tool.status === "completed" || tool.status === "failed" || tool.status === "cancelled";
		if (done || tool.output) {
			const text = tool.output ?? (tool.status === "cancelled" ? "(cancelled)" : "");
			component.updateResult({ content: text ? [{ type: "text", text }] : [], details: mapped.details, isError: tool.status === "failed" || tool.status === "cancelled" }, !done);
		}
		component.setExpanded(this.#expanded);
		this.clear();
		this.addChild(component);
		this.invalidate();
	}
}

class ListSelector implements Component {
	readonly #title: string;
	readonly #items: SelectItem[];
	readonly #input = new Input();
	readonly #border = new DynamicBorder();
	#list: SelectList;
	readonly #hint: string;
	readonly #search: boolean;
	onSelect: (item: SelectItem) => void = () => {};
	onCancel: () => void = () => {};
	readonly capturesViewportInput = true;

	constructor(title: string, items: SelectItem[], options: { hint?: string; search?: boolean; current?: string } = {}) {
		this.#title = title;
		this.#items = items;
		this.#hint = options.hint ?? `${rawKeyHint("enter", "to select")}  ${rawKeyHint("esc", "to cancel")}`;
		this.#search = options.search ?? items.length > 8;
		this.#list = this.#build(items);
		const index = options.current === undefined ? -1 : items.findIndex((item) => item.value === options.current);
		if (index >= 0) this.#list.setSelectedIndex(index);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, getSelectListTheme());
		list.onSelect = (item) => this.onSelect(item);
		list.onCancel = () => this.onCancel();
		return list;
	}

	handleInput(data: string): void {
		const kb = ui.keys;
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			this.#list.handleInput(data);
			return;
		}
		if (kb.matches(data, "app.clear")) {
			this.onCancel();
			return;
		}
		if (!this.#search) return;
		const before = this.#input.getValue();
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		if (query !== before) this.#list = this.#build(query ? fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.description ?? ""}`) : this.#items);
	}

	invalidate(): void {
		this.#list.invalidate();
		this.#input.invalidate();
		this.#border.invalidate();
	}

	render(width: number): string[] {
		return [
			...this.#border.render(width),
			"",
			truncateToWidth(` ${theme.bold(theme.fg("accent", this.#title))}`, width),
			"",
			...(this.#search ? [...this.#input.render(width), ""] : []),
			...this.#list.render(width),
			"",
			truncateToWidth(` ${this.#hint}`, width),
			...this.#border.render(width),
		];
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
		let pwd = shortPath(s.cwd);
		if (this.branch) pwd = `${pwd} (${this.branch})`;
		if (s.sessionName) pwd = `${pwd} • ${s.sessionName}`;
		const totals = this.#session.totals;
		const parts: string[] = [];
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if (s.cost) parts.push(`${s.cost.currency === "USD" ? "$" : ""}${s.cost.amount.toFixed(3)}`);
		if (s.context?.size) {
			const percent = (s.context.used / s.context.size) * 100;
			const text = `${percent.toFixed(1)}%/${formatTokens(s.context.size)}${this.#session.autoCompact ? " (auto)" : ""}`;
			parts.push(percent > 90 ? theme.fg("error", text) : percent > 70 ? theme.fg("warning", text) : text);
		}
		let left = parts.join(" ");
		if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
		const model = s.modelName ?? (s.connected ? "default" : "connecting");
		let right = `(${s.harness}) ${model}${s.thinkingLevel ? ` • ${s.thinkingLevel}` : ""}${s.mode && s.mode !== "default" ? ` • ${s.mode}` : ""}`;
		const room = width - visibleWidth(left) - 2;
		if (visibleWidth(right) > room) right = room > 0 ? truncateToWidth(right, room, "") : "";
		const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
		return [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), theme.fg("dim", left) + theme.fg("dim", padding + right)];
	}
}

function toPiSession(s: SessionInfo) {
	return { path: s.file, id: s.id, cwd: s.cwd, ...(s.name ? { name: s.name } : {}), created: new Date(s.created), modified: new Date(s.modified), messageCount: s.messages, firstMessage: s.first ?? "(no messages)", allMessagesText: s.first ?? "" };
}

function deleteSessionFiles(file: string): void {
	for (const suffix of ["", "-wal", "-shm", ".lock"]) rmSync(file + suffix, { force: true });
}

function sessionSelector(root: string, cwd: string, tui: TUI, current: string | undefined, onSelect: (file: string) => void, onCancel: () => void): SessionSelectorComponent {
	const rename = async (path: string, currentName: string | undefined) => {
		const name = await new Promise<string | undefined>((resolve) => {
			const close = (value: string | undefined) => {
				overlay.hide();
				resolve(value);
			};
			const input = new ExtensionInputComponent("Session name", undefined, (value) => close(value), () => close(undefined), { tui, ...(currentName ? { initialValue: currentName } : {}) });
			const overlay = tui.showOverlay(input, { width: "60%" });
		});
		if (name === undefined) return;
		const store = await SessionStore.open(path);
		await store.setName(name.trim() || undefined);
		await store.close();
	};
	const selector = new SessionSelectorComponent(
		async () => (await listSessions(root, cwd)).map(toPiSession),
		async () => (await listSessions(root)).map(toPiSession),
		onSelect,
		onCancel,
		onCancel,
		() => tui.requestRender(),
		{ renameSession: rename, showRenameHint: true, keybindings: ui.keys as never },
		current,
	);
	selector.getSessionList().onDeleteSession = async (path) => {
		if (path === current) throw new Error("cannot delete the session that is open");
		deleteSessionFiles(path);
	};
	return selector;
}

function makeTui(terminal: Terminal, mode: "regular" | "fullscreen"): TUI {
	return mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
}

async function prepareUi(cwd: string, resources?: Resources, themeName?: string): Promise<Resources> {
	const loaded = resources ?? (await Resources.load(cwd));
	ui.keys = keybindingsModule.KeybindingsManager.create(loaded.agentDir);
	const { setKeybindings } = await import("@earendil-works/pi-tui");
	setKeybindings(ui.keys);
	themes.initTheme(themeName ?? loaded.settings.getTheme(), false);
	return loaded;
}

async function standalone<T>(cwd: string, build: (tui: TUI, done: (value: T) => void) => Component): Promise<T> {
	await prepareUi(cwd);
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
	return standalone<boolean>(process.cwd(), (_tui, done) => {
		const selector = new ListSelector(question, [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
		selector.onSelect = (item) => done(item.value === "yes");
		selector.onCancel = () => done(false);
		return selector;
	});
}

export async function pickSession(root: string, cwd: string): Promise<SessionInfo | undefined> {
	const file = await standalone<string | undefined>(cwd, (tui, done) => sessionSelector(root, cwd, tui, undefined, (path) => done(path), () => done(undefined)));
	if (!file) return undefined;
	return (await listSessions(root)).find((s) => s.file === file);
}

export class InteractiveApp {
	readonly tui: TUI;
	readonly session: Pid0Session;
	readonly resources: Resources;
	readonly editor: CustomEditor;
	readonly chat = new Container();
	readonly #header = new Container();
	readonly #document = new Container();
	readonly #pending = new Container();
	readonly #status = new Container();
	readonly #editorSlot = new Container();
	readonly #footerSlot = new Container();
	readonly #footer: Footer;
	readonly #keys: AppKeybindings;
	readonly #tools = new Map<string, ToolBlock>();
	readonly #toolBlocks: ToolBlock[] = [];
	readonly #assistants: AssistantMessageComponent[] = [];
	readonly #bashes: BashExecutionComponent[] = [];
	#assistant: { component: AssistantMessageComponent; text: string; thinking: string } | undefined;
	#loader: Loader | undefined;
	#closeSelector: (() => void) | undefined;
	#selectorLine: Promise<unknown> = Promise.resolve();
	#expanded = false;
	#hideThinking: boolean;
	#outputPad: number;
	#lastCtrlC = 0;
	#lastEscape = 0;
	#bashMode = false;
	#images: ImageInput[] = [];
	#done: (code: number) => void = () => {};
	readonly #options: InteractiveOptions;
	readonly finished: Promise<number>;

	constructor(session: Pid0Session, resources: Resources, options: InteractiveOptions) {
		this.session = session;
		this.resources = resources;
		this.#options = options;
		this.#keys = ui.keys;
		const settings = resources.settings;
		this.#hideThinking = settings.getHideThinkingBlock();
		this.#outputPad = settings.getOutputPad();
		session.autoCompact = settings.getCompactionEnabled();
		session.followUpMode = settings.getFollowUpMode();
		session.expand = (text) => resources.expand(text);
		const mode = options.tuiMode ?? settings.getTuiMode();
		this.tui = makeTui(options.terminal ?? new ProcessTerminal(), mode);
		this.tui.setShowHardwareCursor(settings.getShowHardwareCursor());
		this.tui.setClearOnShrink(settings.getClearOnShrink());
		this.editor = new CustomEditor(this.tui, themes.getEditorTheme(), this.#keys as never, { paddingX: settings.getEditorPaddingX(), autocompleteMaxVisible: settings.getAutocompleteMaxVisible() });
		this.#footer = new Footer(session);
		this.finished = new Promise((resolve) => (this.#done = resolve));
		this.#document.addChild(this.#header);
		this.#document.addChild(this.chat);
		this.#editorSlot.addChild(this.editor);
		this.#footerSlot.addChild(this.#footer);
		for (const part of [this.#document, this.#pending, this.#status, this.#editorSlot, this.#footerSlot]) this.tui.addChild(part);
		if (isViewportTUI(this.tui)) {
			const layout = viewport.createChatViewport({
				document: this.#document,
				pendingMessages: this.#pending,
				status: this.#status,
				editor: this.#editorSlot,
				footer: this.#footerSlot,
				scrollbar: settings.getFullscreenScrollbar(),
				scrollbarTrackStyle: (text: string) => theme.fg("scrollbarTrack" as never, text),
				scrollbarThumbStyle: (text: string) => theme.fg("scrollbarThumb" as never, text),
			});
			this.tui.setLayoutRoot(layout.root);
		}
		this.#wireEditor();
		session.subscribe((event) => this.#onEvent(event));
		session.onPermission = (request, harness) => this.#askPermission(request, harness);
		this.#refreshCommands();
		this.#refreshBorder();
		themes.onThemeChange(() => {
			this.tui.invalidate();
			this.#refreshBorder();
			this.tui.requestRender();
		});
		try {
			const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.cwd, encoding: "utf8" });
			if (head.status === 0) this.#footer.branch = head.stdout.trim();
		} catch {}
	}

	static async create(session: Pid0Session, options: InteractiveOptions): Promise<InteractiveApp> {
		const resources = await prepareUi(session.cwd, options.resources, options.themeName);
		return new InteractiveApp(session, resources, options);
	}

	#buildHeader(): void {
		this.#header.clear();
		if (this.resources.settings.getQuietStartup() === true) return;
		const hints = [keyHint("app.interrupt", "interrupt"), rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"), rawKeyHint("/", "commands"), rawKeyHint("!", "bash"), keyHint("app.tools.expand", "more")].join(theme.fg("muted", " · "));
		const loaded = [this.resources.templates.length ? `${this.resources.templates.length} prompt templates` : "", this.resources.skills.length ? `${this.resources.skills.length} skills` : ""].filter(Boolean).join(", ");
		const lines = [
			`${theme.bold(theme.fg("accent", "pid0"))} ${theme.fg("dim", `v${VERSION}`)}`,
			hints,
			"",
			theme.fg("dim", `pid0 drives Claude Code, Codex, Antigravity and pi over ACP. ${keyText("app.model.select")} or /model picks the model, /harness the harness.`),
			...(loaded ? [theme.fg("dim", `Loaded ${loaded}.`)] : []),
		];
		this.#header.addChild(new Spacer(1));
		this.#header.addChild(new Text(lines.join("\n"), 1, 0));
		this.#header.addChild(new Spacer(1));
	}

	async start(): Promise<void> {
		this.#buildHeader();
		await this.#replay();
		this.tui.setFocus(this.editor);
		this.tui.start();
		for (const line of this.resources.diagnostics) this.warn(line);
		void this.session.connect().then(
			() => {
				this.#refreshBorder();
				this.tui.requestRender();
			},
			(error) => this.error(error),
		);
		for (const prompt of this.#options.prompts) await this.session.promptAndWait(prompt.text, prompt.images ? { images: prompt.images } : {});
	}

	stop(code = 0): void {
		this.#loader?.stop();
		this.tui.stop();
		themes.stopThemeWatcher();
		if (this.session.persistent && this.session.store.meta.messages > 0) process.stdout.write(`\nResume this session with: pid0 --session ${this.session.store.id.slice(0, 8)}\n`);
		this.#done(code);
	}

	status(text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(theme.fg("dim", text), 1, 0));
		this.tui.requestRender();
	}

	info(text: string): void {
		this.status(text);
	}

	warn(text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(theme.fg("warning", `Warning: ${text}`), 1, 0));
		this.tui.requestRender();
	}

	error(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(theme.fg("error", `Error: ${message}`), this.#outputPad, 0));
		this.tui.requestRender();
	}

	markdown(text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new DynamicBorder());
		this.chat.addChild(new Markdown(text, 1, 1, getMarkdownTheme()));
		this.chat.addChild(new DynamicBorder());
		this.tui.requestRender();
	}

	#refreshCommands(): void {
		const taken = new Set(COMMANDS.map((c) => c.name));
		const templates: SlashCommand[] = this.resources.templates.filter((t) => !taken.has(t.name)).map((t) => ({ name: t.name, description: `${t.description} (prompt)`, ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}) }));
		const skills: SlashCommand[] = this.resources.skillCommands ? this.resources.skills.map((s) => ({ name: `skill:${s.name}`, description: `${s.description} (skill)` })) : [];
		for (const c of [...templates, ...skills]) taken.add(c.name);
		const harness: SlashCommand[] = (this.session.native?.commands ?? []).filter((c) => !taken.has(c.name)).map((c) => ({ name: c.name, description: `${c.description} (${this.session.label()})` }));
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...COMMANDS, ...templates, ...skills, ...harness], this.session.cwd));
	}

	#refreshBorder(): void {
		if (this.#bashMode) this.editor.borderColor = theme.getBashModeBorderColor();
		else {
			const level = this.session.state.thinkingLevel ?? "off";
			this.editor.borderColor = theme.getThinkingBorderColor((PI_LEVELS.includes(level) ? level : "off") as never);
		}
		this.tui.requestRender();
	}

	#wireEditor(): void {
		const editor = this.editor;
		editor.onSubmit = (text) => void this.submit(text);
		editor.onChange = (text) => {
			const bash = text.trimStart().startsWith("!");
			if (bash !== this.#bashMode) {
				this.#bashMode = bash;
				this.#refreshBorder();
			}
		};
		editor.onEscape = () => {
			if (this.session.isStreaming || this.session.state.isCompacting) {
				this.#dequeue();
				void this.session.abort();
			} else if (this.#bashMode) {
				editor.setText("");
			} else if (!editor.getText().trim()) {
				const action = this.resources.settings.getDoubleEscapeAction();
				if (action === "none") return;
				const now = Date.now();
				if (now - this.#lastEscape < 500) {
					this.#lastEscape = 0;
					this.#run(() => this.command(action === "tree" ? "tree" : "fork", ""));
				} else this.#lastEscape = now;
			}
		};
		editor.onCtrlD = () => this.stop();
		editor.onPasteImage = () => this.#run(() => this.#pasteImage());
		editor.onAction("app.clear", () => {
			if (editor.getText()) {
				editor.setText("");
				this.#lastCtrlC = 0;
			} else if (Date.now() - this.#lastCtrlC < 500) this.stop();
			else this.#lastCtrlC = Date.now();
			this.tui.requestRender();
		});
		editor.onAction("app.thinking.cycle", () =>
			this.#run(async () => {
				const level = await this.session.cycleThinking();
				if (level) this.status(`Thinking level: ${level}`);
				else this.status(`${this.session.label()} does not offer thinking levels`);
			}),
		);
		editor.onAction("app.model.cycleForward", () => this.#run(() => this.#cycleModel(1)));
		editor.onAction("app.model.cycleBackward", () => this.#run(() => this.#cycleModel(-1)));
		editor.onAction("app.model.select", () => this.#run(() => this.command("model", "")));
		editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const block of this.#toolBlocks) block.setExpanded(this.#expanded);
			for (const block of this.#bashes) block.setExpanded(this.#expanded);
			this.tui.requestRender(true);
		});
		editor.onAction("app.thinking.toggle", () => {
			this.#hideThinking = !this.#hideThinking;
			for (const block of this.#assistants) block.setHideThinkingBlock(this.#hideThinking);
			this.status(`Thinking blocks: ${this.#hideThinking ? "hidden" : "visible"}`);
			this.tui.requestRender(true);
		});
		editor.onAction("app.editor.external", () => this.#externalEditor());
		editor.onAction("app.message.copy", () => this.#run(() => this.command("copy", "")));
		editor.onAction("app.message.followUp", () => {
			const text = editor.getText().trim();
			if (text) void this.submit(text);
		});
		editor.onAction("app.message.dequeue", () => this.#dequeue());
		editor.onAction("app.suspend", () => {
			this.tui.stop();
			process.once("SIGCONT", () => {
				this.tui.start();
				this.tui.requestRender(true);
			});
			process.kill(process.pid, "SIGTSTP");
		});
		for (const [action, name] of [["app.session.new", "new"], ["app.session.tree", "tree"], ["app.session.fork", "fork"], ["app.session.resume", "resume"]] as const) {
			editor.onAction(action as never, () => this.#run(() => this.command(name, "")));
		}
	}

	async #cycleModel(direction: 1 | -1): Promise<void> {
		const next = await this.session.cycleModel(direction);
		if (!next) this.status(`Only one model available on ${this.session.label()}`);
		else this.status(`Switched to ${next.model ?? "default"} (${next.harness})`);
		this.#refreshBorder();
	}

	#dequeue(): void {
		const queued = this.session.takeQueue();
		if (queued.length) this.editor.setText([...queued, this.editor.getText()].filter(Boolean).join("\n\n"));
		this.tui.requestRender();
	}

	async #pasteImage(): Promise<void> {
		const image = await clipboardImage?.readClipboardImage();
		if (!image) return;
		this.#images.push({ data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType });
		this.editor.insertTextAtCursor(`[image #${this.#images.length}] `);
	}

	#run(work: () => Promise<unknown>): void {
		work().then(
			() => this.tui.requestRender(),
			(error) => this.error(error),
		);
	}

	#externalEditor(): void {
		const command = this.resources.settings.getExternalEditorCommand?.() ?? process.env.VISUAL ?? process.env.EDITOR;
		if (!command) {
			this.warn("No editor configured. Set $VISUAL or $EDITOR.");
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "pid0-edit-"));
		const file = join(dir, "prompt.md");
		writeFileSync(file, this.editor.getText());
		this.tui.stop();
		const result = spawnSync(command, [file], { stdio: "inherit", shell: true });
		this.tui.start();
		if (result.status === 0) this.editor.setText(readFileSync(file, "utf8").replace(/\n$/, ""));
		rmSync(dir, { recursive: true, force: true });
		this.tui.requestRender(true);
	}

	#user(text: string): void {
		if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), this.#outputPad));
	}

	#assistantMessage(text: string, thinking: string, harness: string, model?: string): Record<string, unknown> {
		return {
			role: "assistant",
			content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : [])],
			api: "acp",
			provider: harness,
			model: model ?? "default",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	#addAssistant(): AssistantMessageComponent {
		const component = new AssistantMessageComponent(undefined, this.#hideThinking, getMarkdownTheme(), undefined, this.#outputPad);
		this.#assistants.push(component);
		this.chat.addChild(component);
		return component;
	}

	#addTool(tool: ToolView): ToolBlock {
		const block = new ToolBlock(tool, this.tui, this.session.cwd, this.#expanded, this.#outputPad);
		this.#toolBlocks.push(block);
		this.chat.addChild(block);
		return block;
	}

	#addBash(command: string, output: string, exitCode: number | null, excluded: boolean): void {
		const bash = new BashExecutionComponent(command, this.tui, excluded, this.#outputPad);
		if (output) bash.appendOutput(output);
		bash.setComplete(exitCode ?? undefined, false);
		bash.setExpanded(this.#expanded);
		this.#bashes.push(bash);
		this.chat.addChild(bash);
	}

	#item(item: Item): void {
		switch (item.kind) {
			case "user":
				this.#user(item.data.text);
				break;
			case "assistant":
				this.#addAssistant().updateContent(this.#assistantMessage(item.data.text, item.data.thinking ?? "", item.data.harness, item.data.model) as never);
				break;
			case "tool":
				this.#addTool(item.data);
				break;
			case "plan":
				this.#plan(item.data.entries);
				break;
			case "shell":
				this.#addBash(item.data.command, item.data.output, item.data.exitCode, item.data.excluded);
				break;
			case "switch":
				this.status(`Switched to ${this.session.label(item.data.harness)}`);
				break;
			case "reset": {
				const summary = new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: item.data.summary ?? "", tokensBefore: 0, timestamp: item.data.at } as never, getMarkdownTheme(), this.#outputPad);
				summary.setExpanded(this.#expanded);
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(summary);
				break;
			}
			case "turn":
				if (item.data.error) this.error(item.data.error);
				else if (item.data.stopReason === "cancelled") this.chat.addChild(new Text(theme.fg("error", "Operation aborted"), this.#outputPad, 0));
				break;
		}
	}

	#plan(entries: { content: string; status: string }[]): void {
		const mark = (status: string) => (status === "completed" ? theme.fg("success", "✓") : status === "in_progress" ? theme.fg("accent", "▸") : theme.fg("dim", "○"));
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(entries.map((e) => `${mark(e.status)} ${e.status === "completed" ? theme.fg("dim", e.content) : e.content}`).join("\n"), 1, 0));
	}

	async #replay(): Promise<void> {
		this.chat.clear();
		this.#tools.clear();
		this.#toolBlocks.length = 0;
		this.#assistants.length = 0;
		this.#bashes.length = 0;
		this.#assistant = undefined;
		for (const item of await this.session.messages()) this.#item(item);
		this.tui.requestRender(true);
	}

	#setBusy(busy: boolean, message = "Working..."): void {
		this.#status.clear();
		this.#loader?.stop();
		this.#loader = undefined;
		if (busy) {
			this.#loader = new Loader(this.tui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), `${message} (${keyText("app.interrupt")} to interrupt)`);
			this.#status.addChild(this.#loader);
			this.#loader.start();
		}
		if (this.resources.settings.getShowTerminalProgress()) this.tui.terminal.setProgress?.(busy);
	}

	#renderQueue(): void {
		this.#pending.clear();
		const queued = this.session.queued;
		if (queued.length === 0) return;
		this.#pending.addChild(new Spacer(1));
		for (const text of queued) this.#pending.addChild(new TruncatedText(theme.fg("dim", `Follow-up: ${text.split("\n")[0]}`), 1, 0));
		this.#pending.addChild(new TruncatedText(theme.fg("dim", `↳ ${keyText("app.message.dequeue")} to edit all queued messages`), 1, 0));
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
				else this.#assistant = { component: this.#addAssistant(), text: "", thinking: "" };
				break;
			case "message_update": {
				const live = this.#assistant;
				if (!live) break;
				if (event.assistantMessageEvent.type === "text_delta") live.text += event.assistantMessageEvent.delta;
				else live.thinking += event.assistantMessageEvent.delta;
				live.component.updateContent(this.#assistantMessage(live.text, live.thinking, this.session.harness) as never, true);
				break;
			}
			case "message_end":
				if (event.message.role === "assistant" && this.#assistant) {
					this.#assistant.component.updateContent(this.#assistantMessage(this.#assistant.text, this.#assistant.thinking, event.message.harness, event.message.model) as never, false);
					this.#assistant = undefined;
				}
				break;
			case "tool_execution_start":
				this.#tools.set(event.toolCallId, this.#addTool({ title: event.toolName, status: "pending", ...(event.kind ? { kind: event.kind } : {}), ...(event.args !== null ? { input: event.args } : {}) }));
				break;
			case "tool_execution_update":
			case "tool_execution_end": {
				const block = this.#tools.get(event.toolCallId);
				if (!block) break;
				const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
				const output = result.content.map((c) => c.text).join("\n");
				block.tool = {
					...block.tool,
					title: event.toolName,
					status: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : event.status,
					...(event.type === "tool_execution_update" && event.args !== null ? { input: event.args } : {}),
					...(output ? { output } : {}),
					...(result.diffs ? { diffs: result.diffs } : {}),
					...(result.locations ? { locations: result.locations } : {}),
				};
				block.rebuild();
				break;
			}
			case "plan_update":
				this.#plan(event.entries);
				break;
			case "turn_end":
				if (event.stopReason === "cancelled") this.chat.addChild(new Text(theme.fg("error", "Operation aborted"), this.#outputPad, 0));
				else if (event.stopReason !== "end_turn" && event.stopReason !== "error") this.warn(`The turn ended early: ${event.stopReason.replace(/_/g, " ")}`);
				break;
			case "queue_update":
				this.#renderQueue();
				break;
			case "notice":
				if (event.level === "error") this.error(event.text);
				else if (event.level === "warning") this.warn(event.text);
				else this.status(event.text);
				break;
			case "commands_changed":
			case "harness_changed":
				this.#refreshCommands();
				break;
			case "model_changed":
			case "thinking_level_changed":
				this.#refreshBorder();
				break;
			case "compaction_start":
				this.#setBusy(true, event.reason === "threshold" ? "Auto-compacting..." : "Compacting context...");
				break;
			case "compaction_end":
				this.#setBusy(false);
				if (event.summary) void this.#replay();
				break;
			case "session_changed":
				void this.#replay();
				this.#renderQueue();
				void this.session.connect().then(
					() => this.#refreshBorder(),
					(error) => this.error(error),
				);
				break;
		}
		this.tui.requestRender();
	}

	showSelector<T extends Component>(create: (done: () => void) => { component: T; focus?: Component; dispose?: () => void }): void {
		const done = () => {
			created.dispose?.();
			if (this.#closeSelector !== done) return;
			this.#closeSelector = undefined;
			this.#editorSlot.clear();
			this.#editorSlot.addChild(this.editor);
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		const created = create(done);
		this.#closeSelector?.();
		this.#closeSelector = done;
		this.#editorSlot.clear();
		this.#editorSlot.addChild(created.component);
		this.tui.setFocus(created.focus ?? created.component);
		this.tui.requestRender();
	}

	select(title: string, items: SelectItem[], options: { current?: string; hint?: string; search?: boolean } = {}): Promise<string | undefined> {
		const run = this.#selectorLine.then(
			() =>
				new Promise<string | undefined>((resolve) => {
					this.showSelector((done) => {
						const selector = new ListSelector(title, items, options);
						selector.onSelect = (item) => {
							done();
							resolve(item.value);
						};
						selector.onCancel = () => {
							done();
							resolve(undefined);
						};
						return { component: selector };
					});
				}),
		);
		this.#selectorLine = run.catch(() => {});
		return run;
	}

	async #askPermission(request: RequestPermissionRequest, harness: string): Promise<RequestPermissionResponse> {
		const title = `${this.session.label(harness)} wants to run: ${request.toolCall.title ?? "a tool"}`;
		const chosen = await this.select(title, request.options.map((o) => ({ value: o.optionId, label: o.name, description: o.kind.replace(/_/g, " ") })), { search: false, hint: `${rawKeyHint("enter", "to answer")}  ${rawKeyHint("esc", "to reject")}` });
		return chosen ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } };
	}

	async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.setText("");
		this.editor.addToHistory(text);
		const images = this.#images.splice(0);
		try {
			if (text.startsWith("!")) {
				const excluded = text.startsWith("!!");
				const command = text.slice(excluded ? 2 : 1).trim();
				if (!command) return;
				const bash = new BashExecutionComponent(command, this.tui, excluded, this.#outputPad);
				bash.setExpanded(this.#expanded);
				this.#bashes.push(bash);
				this.chat.addChild(bash);
				this.tui.requestRender();
				const result = await this.session.shell(command, excluded, (chunk) => {
					bash.appendOutput(chunk);
					this.tui.requestRender();
				});
				bash.setComplete(result.exitCode ?? undefined, false);
				this.tui.requestRender();
				return;
			}
			if (text.startsWith("/")) {
				const space = text.search(/\s/);
				const name = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
				if (COMMANDS.some((c) => c.name === name) || ["trust", "bug"].includes(name)) {
					await this.command(name, space < 0 ? "" : text.slice(space + 1).trim());
					this.tui.requestRender();
					return;
				}
			}
			await this.session.prompt(text, images.length ? { images } : {});
		} catch (error) {
			this.error(error);
		}
	}

	async command(name: string, arg: string): Promise<void> {
		const session = this.session;
		switch (name) {
			case "quit":
				this.stop();
				return;
			case "settings":
				this.#settings();
				return;
			case "hotkeys":
				this.#hotkeys();
				return;
			case "harness": {
				let target = arg;
				if (!target) {
					const items = harnessStatus(session.settings).map((h) => ({ value: h.harness.id, label: h.harness.label, description: h.available ? (h.harness.id === session.harness ? "current" : h.note) : `not installed: ${h.harness.install}` }));
					target = (await this.select("Select harness", items, { current: session.harness, search: false })) ?? "";
				}
				if (!target) return;
				await session.setHarness(target);
				this.status(`Harness: ${session.label()}. It gets the conversation so far with its next prompt.`);
				await session.connect();
				this.#refreshBorder();
				return;
			}
			case "model": {
				if (arg) {
					const set = await session.setModel(arg);
					this.status(`Model: ${set.model ?? "default"} (${set.harness})`);
					this.#refreshBorder();
					return;
				}
				const state = await session.connect();
				const items: SelectItem[] = state.models.map((m) => ({ value: `${session.harness}/${m.id}`, label: m.id === state.currentModel ? `${m.name} ${theme.fg("success", "✓")}` : m.name, description: `[${session.harness}] ${m.description ?? m.id}` }));
				for (const h of harnessStatus(session.settings)) if (h.harness.id !== session.harness) items.push({ value: `@${h.harness.id}`, label: `→ ${h.harness.label}`, description: h.available ? "switch harness, then pick its model" : "not installed" });
				const chosen = await this.select(`Select model (${session.label()})`, items, { ...(state.currentModel ? { current: `${session.harness}/${state.currentModel}` } : {}), search: true });
				if (!chosen) return;
				if (chosen.startsWith("@")) {
					await this.command("harness", chosen.slice(1));
					await this.command("model", "");
					return;
				}
				const set = await session.setModel(chosen);
				this.status(`Model: ${set.model ?? "default"} (${set.harness})`);
				this.#refreshBorder();
				return;
			}
			case "scoped-models":
				await this.#scopedModels();
				return;
			case "thinking": {
				const state = await session.connect();
				if (state.thinking.length === 0) throw new Error(`${session.label()} does not offer thinking levels over ACP`);
				if (arg) {
					this.status(`Thinking level: ${await session.setThinking(arg)}`);
					this.#refreshBorder();
					return;
				}
				this.showSelector((done) => {
					const selector = new ThinkingSelectorComponent(
						(state.currentThinking ?? state.thinking[0]!.id) as never,
						state.thinking.map((t) => t.id) as never,
						(level) => {
							done();
							this.#run(async () => {
								this.status(`Thinking level: ${await session.setThinking(level)}`);
								this.#refreshBorder();
							});
						},
						() => done(),
					);
					return { component: selector, focus: selector.getSelectList() };
				});
				return;
			}
			case "mode": {
				const state = await session.connect();
				if (state.modes.length === 0) throw new Error(`${session.label()} does not offer modes over ACP`);
				const mode = arg || (await this.select("Select mode", state.modes.map((t) => ({ value: t.id, label: t.name, ...(t.description ? { description: t.description } : {}) })), { ...(state.currentMode ? { current: state.currentMode } : {}), search: false }));
				if (mode) this.status(`Mode: ${await session.setMode(mode)}`);
				return;
			}
			case "handoff": {
				const current = session.settings.handoff ?? "anonymous";
				const mode = arg || (await this.select("Handoff when switching harness", [{ value: "anonymous", label: "anonymous", description: "earlier replies are the assistant's; the switch is not mentioned" }, { value: "named", label: "named", description: "earlier replies are labelled with the agent that wrote them" }], { current, search: false }));
				if (!mode) return;
				if (mode !== "anonymous" && mode !== "named") throw new Error("handoff is anonymous or named");
				session.settings.handoff = mode;
				updateSettings((s) => void (s.handoff = mode));
				this.status(`Handoff: ${mode}`);
				return;
			}
			case "permissions": {
				const policy = arg || (await this.select("Tool permission requests", [{ value: "ask", label: "ask", description: "show each request" }, { value: "allow", label: "allow", description: "approve every request" }, { value: "deny", label: "deny", description: "reject every request" }], { current: session.permissions, search: false }));
				if (!policy) return;
				if (policy !== "ask" && policy !== "allow" && policy !== "deny") throw new Error("permissions are ask, allow or deny");
				session.permissions = policy;
				updateSettings((s) => void (s.permissions = policy));
				this.status(`Permission requests: ${policy}`);
				return;
			}
			case "new":
				await session.newSession();
				this.status("New session started");
				return;
			case "resume":
				this.showSelector((done) => {
					const selector = sessionSelector(session.root, session.cwd, this.tui, session.store.file, (file) => {
						done();
						this.#run(async () => {
							await session.switchSession(file);
							this.status("Resumed session");
						});
					}, () => done());
					return { component: selector, focus: selector };
				});
				return;
			case "name":
				if (!arg) this.status(session.store.meta.name ? `Session name: ${session.store.meta.name}` : "Usage: /name <name>");
				else {
					await session.setName(arg);
					this.status(`Session name set: ${arg}`);
				}
				return;
			case "session":
				await this.#sessionInfo();
				return;
			case "tree":
				await this.#tree();
				return;
			case "fork": {
				const items = await session.messages();
				const users = items.filter((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
				if (users.length === 0) {
					this.status("No messages to fork from");
					return;
				}
				this.showSelector((done) => {
					const selector = new UserMessageSelectorComponent(
						users.map((u) => ({ id: String(u.id), text: u.data.text })),
						(entryId) => {
							done();
							this.#run(async () => {
								const index = items.findIndex((i) => String(i.id) === entryId);
								const text = (items[index] as Extract<Item, { kind: "user" }>).data.text;
								await session.clone(index === 0 ? "empty" : items[index - 1]!.id);
								this.editor.setText(text);
								this.status("Forked to new session");
							});
						},
						() => done(),
					);
					return { component: selector, focus: selector.getMessageList() };
				});
				return;
			}
			case "clone":
				await session.clone();
				this.status("Cloned to new session");
				return;
			case "compact":
				await session.compact(arg || undefined);
				return;
			case "copy": {
				const text = await session.lastAssistantText();
				if (!text) {
					this.status("No agent messages to copy yet.");
					return;
				}
				await copyToClipboard(text);
				this.status("Copied last agent message to clipboard");
				return;
			}
			case "export": {
				const path = exportSession(session.store.meta, await session.messages(), (h) => session.label(h), arg || `pid0-session-${session.store.id}.html`);
				this.status(`Session exported to: ${path}`);
				return;
			}
			case "import": {
				if (!arg) throw new Error("Usage: /import <path.jsonl>");
				const file = await importSession(arg.replace(/^["']|["']$/g, ""), session.root, session.cwd);
				await session.switchSession(file);
				this.status(`Session imported from: ${arg}`);
				return;
			}
			case "share": {
				const dir = mkdtempSync(join(tmpdir(), "pid0-share-"));
				const html = exportSession(session.store.meta, await session.messages(), (h) => session.label(h), join(dir, "session.html"));
				try {
					const url = execFileSync("gh", ["gist", "create", "--public=false", html], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
					this.status(`Share URL: ${url}`);
				} catch (error) {
					throw new Error(`could not create a gist with the GitHub CLI (gh): ${(error as Error).message.split("\n")[0]}`);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
				return;
			}
			case "login": {
				await session.connect().catch(() => {});
				const agent = session.agent;
				const methods = agent?.authMethods ?? [];
				if (!agent || methods.length === 0) {
					this.status(`${session.label()} offers no sign-in over ACP; sign in with its own CLI. From a shell: pid0 auth login ${session.harness}`);
					return;
				}
				const method = arg || (await this.select(`Sign in to ${session.label()}`, methods.map((m) => ({ value: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) })), { search: false }));
				if (!method) return;
				const chosen = methods.find((m) => m.id === method) as { id: string; type?: string } | undefined;
				if (!chosen) throw new Error(`no sign-in method "${method}"`);
				if (chosen.type === "terminal") this.status(`This sign-in runs in a terminal. Quit and run: pid0 auth login ${session.harness} ${chosen.id}`);
				else {
					await agent.authenticate(chosen.id);
					this.status(`Signed in to ${session.label()}`);
				}
				return;
			}
			case "logout": {
				await session.connect().catch(() => {});
				const agent = session.agent;
				if (!agent?.capabilities.auth?.logout) throw new Error(`${session.label()} does not offer sign-out over ACP; sign out with its own CLI`);
				await agent.logout();
				this.status(`Signed out of ${session.label()}`);
				return;
			}
			case "mcp": {
				const servers = Object.entries(loadMcpServers(session.cwd));
				this.markdown(servers.length ? `**MCP servers handed to every harness**\n\n${servers.map(([n, s]) => `- \`${n}\`: ${"command" in s ? [s.command, ...(s.args ?? [])].join(" ") : s.url}`).join("\n")}\n\nChange them with \`pid0 mcp add|remove\`.` : "No MCP servers. Add one from a shell: `pid0 mcp add <name> -- <command> [args...]`.");
				return;
			}
			case "reload": {
				await this.resources.reload();
				this.#keys.reload();
				themes.setTheme(this.#options.themeName ?? this.resources.settings.getTheme() ?? "dark", false);
				this.#applySettings();
				this.#refreshCommands();
				this.#buildHeader();
				this.tui.invalidate();
				this.status("Reloaded keybindings, skills, prompts, themes, and settings");
				for (const line of this.resources.diagnostics) this.warn(line);
				return;
			}
			case "changelog":
				this.markdown(`**pid0 ${VERSION}**\n\n- Drives Claude Code, Codex, Antigravity and pi over ACP; sessions in pi-durable.\n- The terminal UI uses pi's own components, themes, keybindings, settings, prompt templates and skills.`);
				return;
			case "debug": {
				const path = join(this.resources.agentDir, "pid0-debug.log");
				writeFileSync(path, `${this.tui.render(this.tui.terminal.columns).join("\n")}\n\n${JSON.stringify(await session.messages(), null, 2)}\n`);
				this.status(`Debug log written to ${path}`);
				return;
			}
			case "trust":
				this.status("Project trust is decided inside each harness; pid0 loads no project code of its own.");
				return;
			case "bug":
				this.status("/bug sends reports to pi's developers and does not apply to pid0. Use /debug to write a log you can attach to an issue.");
				return;
		}
	}

	#applySettings(): void {
		const settings = this.resources.settings;
		this.#outputPad = settings.getOutputPad();
		this.editor.setPaddingX(settings.getEditorPaddingX());
		this.editor.setAutocompleteMaxVisible(settings.getAutocompleteMaxVisible());
		this.tui.setShowHardwareCursor(settings.getShowHardwareCursor());
		this.tui.setClearOnShrink(settings.getClearOnShrink());
		this.session.autoCompact = settings.getCompactionEnabled();
		this.session.followUpMode = settings.getFollowUpMode();
		for (const block of this.#assistants) block.setOutputPad(this.#outputPad);
		for (const block of this.#toolBlocks) block.setOutputPad(this.#outputPad);
		for (const block of this.#bashes) block.setOutputPad(this.#outputPad);
		this.tui.requestRender(true);
	}

	#settings(): void {
		const settings = this.resources.settings;
		const state = this.session.state;
		const native = this.session.native;
		const apply = (change: () => void) => () => {
			change();
			this.#applySettings();
		};
		const set = <T>(setter: (value: T) => void) => (value: T) => apply(() => setter.call(settings, value))();
		this.showSelector((done) => {
			const callbacks: SettingsCallbacks = {
					onAutoCompactChange: set(settings.setCompactionEnabled),
					onShowImagesChange: set(settings.setShowImages),
					onImageWidthCellsChange: set(settings.setImageWidthCells),
					onAutoResizeImagesChange: set(settings.setImageAutoResize),
					onBlockImagesChange: set(settings.setBlockImages),
					onEnableSkillCommandsChange: (enabled) => {
						settings.setEnableSkillCommands(enabled);
						this.#refreshCommands();
					},
					onSteeringModeChange: set(settings.setSteeringMode),
					onFollowUpModeChange: set(settings.setFollowUpMode),
					onTransportChange: set(settings.setTransport),
					onSessionShareDestinationChange: set(settings.setSessionShareDestination),
					onHttpIdleTimeoutMsChange: set(settings.setHttpIdleTimeoutMs),
					onCacheWarmingModeChange: set(settings.setCacheWarmingMode),
					onModelThinkingLevelChange: (provider, modelId, level) => settings.setModelThinkingLevel(provider, modelId, level),
					onModelThinkingLevelRemove: (provider, modelId) => settings.removeModelThinkingLevel(provider, modelId),
					onThemeChange: (name) => {
						const result = themes.setTheme(name, false);
						settings.setTheme(name);
						this.tui.invalidate();
						if (!result.success) this.error(`Failed to load theme "${name}": ${result.error}`);
						this.#refreshBorder();
					},
					onThemePreview: (name) => {
						if (themes.setTheme(name, false).success) {
							this.tui.invalidate();
							this.tui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.#hideThinking = hidden;
						settings.setHideThinkingBlock(hidden);
						for (const block of this.#assistants) block.setHideThinkingBlock(hidden);
						this.tui.requestRender(true);
					},
					onMermaidRenderingModeChange: set(settings.setMermaidRenderingMode),
					onShowCacheMissNoticesChange: set(settings.setShowCacheMissNotices),
					onCollapseChangelogChange: set(settings.setCollapseChangelog),
					onEnableInstallTelemetryChange: set(settings.setEnableInstallTelemetry),
					onDoubleEscapeActionChange: set(settings.setDoubleEscapeAction),
					onTreeFilterModeChange: set(settings.setTreeFilterMode),
					onShowHardwareCursorChange: set(settings.setShowHardwareCursor),
					onEditorPaddingXChange: set(settings.setEditorPaddingX),
					onOutputPadChange: set(settings.setOutputPad),
					onAutocompleteMaxVisibleChange: set(settings.setAutocompleteMaxVisible),
					onQuietStartupChange: set(settings.setQuietStartup),
					onDefaultProjectTrustChange: set(settings.setDefaultProjectTrust),
					onClearOnShrinkChange: set(settings.setClearOnShrink),
					onShowTerminalProgressChange: set(settings.setShowTerminalProgress),
					onTuiModeChange: (mode) => {
						settings.setTuiMode(mode);
						this.status(`Terminal mode: ${mode}. It applies the next time pid0 starts.`);
					},
					onFullscreenExitOutputChange: set(settings.setFullscreenExitOutput),
					onFullscreenScrollbarChange: set(settings.setFullscreenScrollbar),
					onFullscreenCopyOnSelectChange: set(settings.setFullscreenCopyOnSelect),
					onFullscreenWheelScrollLinesChange: set(settings.setFullscreenWheelScrollLines),
					onWarningsChange: set(settings.setWarnings),
					onCancel: () => done(),
			};
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: settings.getCompactionEnabled(),
					defaultModel: `${state.harness}/${state.model ?? "default"}`,
					availableDefaultModels: [],
					showImages: settings.getShowImages(),
					imageWidthCells: settings.getImageWidthCells(),
					autoResizeImages: settings.getImageAutoResize(),
					blockImages: settings.getBlockImages(),
					enableSkillCommands: settings.getEnableSkillCommands(),
					steeringMode: settings.getSteeringMode(),
					followUpMode: settings.getFollowUpMode(),
					transport: settings.getTransport(),
					sessionShareDestination: settings.getSessionShareDestination(),
					httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
					cacheWarmingMode: settings.getCacheWarmingMode(),
					thinkingLevel: (PI_LEVELS.includes(state.thinkingLevel ?? "") ? state.thinkingLevel : "off") as never,
					availableThinkingLevels: (native?.thinking.map((t) => t.id).filter((id) => PI_LEVELS.includes(id)) ?? []) as never,
					modelThinkingLevels: settings.getAllModelThinkingLevels(),
					currentTheme: settings.getThemeSetting() ?? "dark",
					terminalTheme: themes.getTerminalTheme(),
					availableThemes: themes.getAvailableThemes(),
					hideThinkingBlock: this.#hideThinking,
					mermaidRenderingMode: settings.getMermaidRenderingMode(),
					showCacheMissNotices: settings.getShowCacheMissNotices(),
					collapseChangelog: settings.getCollapseChangelog(),
					enableInstallTelemetry: settings.getEnableInstallTelemetry(),
					doubleEscapeAction: settings.getDoubleEscapeAction(),
					treeFilterMode: settings.getTreeFilterMode(),
					showHardwareCursor: settings.getShowHardwareCursor(),
					editorPaddingX: settings.getEditorPaddingX(),
					outputPad: settings.getOutputPad() as 0 | 1,
					autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
					quietStartup: settings.getQuietStartup(),
					defaultProjectTrust: settings.getDefaultProjectTrust(),
					clearOnShrink: settings.getClearOnShrink(),
					showTerminalProgress: settings.getShowTerminalProgress(),
					tuiMode: settings.getTuiMode(),
					fullscreenExitOutput: settings.getFullscreenExitOutput(),
					fullscreenScrollbar: settings.getFullscreenScrollbar(),
					fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
					fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
					warnings: settings.getWarnings(),
				} as never,
				callbacks,
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	async #scopedModels(): Promise<void> {
		const session = this.session;
		const state = await session.connect();
		const fake = (harness: string, id: string, name: string) => ({ provider: harness, id, name, api: "acp", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 });
		const all = state.models.map((m) => fake(session.harness, m.id, m.name));
		for (const spec of session.scopedModels) {
			const slash = spec.indexOf("/");
			if (slash > 0 && !all.some((m) => `${m.provider}/${m.id}` === spec)) all.push(fake(spec.slice(0, slash), spec.slice(slash + 1), spec.slice(slash + 1)));
		}
		const enabled = session.scopedModels.length ? session.scopedModels.filter((spec) => all.some((m) => `${m.provider}/${m.id}` === spec)) : null;
		this.showSelector((done) => {
			const apply = (ids: string[] | null) => {
				session.scopedModels = ids ?? [];
			};
			const selector = new ScopedModelsSelectorComponent(
				{ allModels: all, enabledModelIds: enabled },
				{
					onChange: apply,
					onPersist: (ids) => {
						apply(ids);
						updateSettings((s) => {
							if (ids?.length) s.scopedModels = ids;
							else delete s.scopedModels;
						});
						this.status("Model scope saved to settings");
					},
					onCancel: () => done(),
				},
			);
			return { component: selector, focus: selector };
		});
	}

	#hotkeys(): void {
		const k = (id: string) => {
			const keys = this.#keys.getKeys(id as never);
			return keys.length ? keys.map((key) => `\`${key}\``).join(" / ") : "(unbound)";
		};
		const table = (title: string, rows: [string, string][]) => `**${title}**\n\n| Key | Action |\n|---|---|\n${rows.map(([keys, action]) => `| ${keys} | ${action} |`).join("\n")}`;
		const text = [
			table("Navigation", [[k("tui.editor.cursorUp"), "Move cursor up / history"], [k("tui.editor.cursorWordLeft"), "Move by word (left)"], [k("tui.editor.cursorWordRight"), "Move by word (right)"], [k("tui.editor.cursorLineStart"), "Start of line"], [k("tui.editor.cursorLineEnd"), "End of line"], [k("tui.editor.jumpForward"), "Jump forward to character"], [k("tui.editor.pageUp"), "Scroll by page"]]),
			table("Editing", [[k("tui.input.submit"), "Send message"], [k("tui.input.newLine"), "New line"], [k("tui.editor.deleteWordBackward"), "Delete word backwards"], [k("tui.editor.deleteToLineStart"), "Delete to start of line"], [k("tui.editor.deleteToLineEnd"), "Delete to end of line"], [k("tui.editor.yank"), "Paste the most recently deleted text"], [k("tui.editor.undo"), "Undo"]]),
			table("Other", [
				[k("tui.input.tab"), "Path completion / accept autocomplete"],
				[k("app.interrupt"), "Cancel autocomplete / abort the turn"],
				[k("app.clear"), "Clear editor (first) / exit (second)"],
				[k("app.exit"), "Exit (when editor is empty)"],
				[k("app.suspend"), "Suspend to background"],
				[k("app.thinking.cycle"), "Cycle thinking level"],
				[`${k("app.model.cycleForward")} / ${k("app.model.cycleBackward")}`, "Cycle models"],
				[k("app.model.select"), "Open model selector"],
				[k("app.tools.expand"), "Toggle tool output expansion"],
				[k("app.thinking.toggle"), "Toggle thinking block visibility"],
				[k("app.editor.external"), "Edit message in external editor"],
				[k("app.message.copy"), "Copy last agent message"],
				[k("app.message.followUp"), "Queue follow-up message"],
				[k("app.message.dequeue"), "Restore queued messages"],
				[k("app.clipboard.pasteImage"), "Paste image from clipboard"],
				["`/`", "Slash commands"],
				["`!`", "Run bash command"],
				["`!!`", "Run bash command (excluded from context)"],
			]),
		].join("\n\n");
		this.markdown(text);
	}

	async #sessionInfo(): Promise<void> {
		const session = this.session;
		const s = session.state;
		const items = await session.messages();
		const count = (kind: string) => items.filter((i) => i.kind === kind).length;
		const dim = (text: string) => theme.fg("dim", text);
		const totals = session.totals;
		let info = `${theme.bold("Session Info")}\n\n`;
		if (s.sessionName) info += `${dim("Name:")} ${s.sessionName}\n`;
		info += `${dim("File:")} ${s.sessionFile ?? "In-memory"}\n`;
		info += `${dim("ID:")} ${s.sessionId}\n`;
		info += `${dim("Branch:")} conversation ${session.store.branch} of ${(await session.store.branches()).length}\n`;
		info += `${dim("Harness:")} ${s.harnessLabel}${session.native ? ` (native session ${session.native.sessionId})` : ""}\n`;
		info += `${dim("Model:")} ${s.modelName ?? "default"}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${dim("Total:")} ${count("user") + count("assistant")}\n${dim("User:")} ${count("user")}\n${dim("Assistant:")} ${count("assistant")}\n${dim("Tools:")} ${count("tool")} calls\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${dim("Input:")} ${totals.input.toLocaleString()}\n${dim("Output:")} ${totals.output.toLocaleString()}\n${dim("Total:")} ${totals.total.toLocaleString()}`;
		if (s.context) info += `\n${dim("Context:")} ${s.context.used.toLocaleString()} of ${s.context.size.toLocaleString()}`;
		if (s.cost) info += `\n\n${theme.bold("Cost")}\n${dim("Total:")} ${s.cost.currency === "USD" ? "$" : ""}${s.cost.amount.toFixed(3)}`;
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(info, 1, 0));
		this.tui.requestRender();
	}

	async #tree(): Promise<void> {
		const session = this.session;
		const tree = await session.store.tree();
		const shown = tree.items.filter((i) => i.kind === "user" || i.kind === "assistant" || i.kind === "reset" || i.kind === "tool");
		if (shown.length === 0) {
			this.status("No entries in session");
			return;
		}
		const active = await session.messages();
		const branchOf = new Map(tree.branches.map((b) => [b.id, b]));
		type Node = { entry: Record<string, unknown>; children: Node[] };
		const nodes = new Map<number, Node>();
		const last = new Map<number, number>();
		const roots: Node[] = [];
		for (const item of shown) {
			const iso = new Date("at" in item.data ? item.data.at : 0).toISOString();
			let entry: Record<string, unknown>;
			if (item.kind === "user") entry = { type: "message", message: { role: "user", content: item.data.text, timestamp: item.data.at } };
			else if (item.kind === "assistant") entry = { type: "message", message: this.#assistantMessage(item.data.text, "", item.data.harness, item.data.model) };
			else if (item.kind === "tool") entry = { type: "message", message: { role: "toolResult", toolCallId: item.data.toolCallId, toolName: item.data.title, content: [{ type: "text", text: item.data.output ?? "" }], isError: item.data.status === "failed", timestamp: item.data.at } };
			else entry = { type: "compaction", summary: item.data.summary ?? "", firstKeptEntryId: String(item.id), tokensBefore: 0 };
			let parent = last.get(item.conversation);
			if (parent === undefined) {
				let branch = branchOf.get(item.conversation);
				while (branch?.parent !== undefined && parent === undefined) {
					const at = branch.at ?? 0;
					parent = shown.findLast((i) => i.conversation === branch!.parent && i.id <= at)?.id;
					branch = branchOf.get(branch.parent);
				}
			}
			const node: Node = { entry: { ...entry, id: String(item.id), parentId: parent === undefined ? null : String(parent), timestamp: iso }, children: [] };
			nodes.set(item.id, node);
			last.set(item.conversation, item.id);
			if (parent === undefined) roots.push(node);
			else nodes.get(parent)!.children.push(node);
		}
		const leaf = active.findLast((i) => nodes.has(i.id));
		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				roots as never,
				leaf ? String(leaf.id) : null,
				this.tui.terminal.rows,
				(entryId) => {
					done();
					this.#run(async () => {
						const picked = shown.find((i) => String(i.id) === entryId)!;
						if (picked.kind === "user") {
							const parentId = nodes.get(picked.id)!.entry.parentId as string | null;
							const before = parentId === null ? undefined : tree.items.findLast((i) => i.id < picked.id && i.id >= Number(parentId) && this.#sameLine(tree, picked, i));
							await session.navigate(before?.id);
							this.editor.setText(picked.data.text);
						} else {
							const next = tree.items.find((i) => i.id > picked.id && i.conversation === picked.conversation && (i.kind === "user" || i.kind === "assistant" || i.kind === "tool"));
							const end = tree.items.findLast((i) => i.conversation === picked.conversation && i.id > picked.id && (!next || i.id < next.id));
							await session.navigate(end?.id ?? picked.id);
						}
						this.status("Navigated to selected point");
					});
				},
				() => done(),
				undefined,
				leaf ? String(leaf.id) : undefined,
				this.resources.settings.getTreeFilterMode(),
			);
			selector.onCopy = (text) => {
				if (text) void copyToClipboard(text);
			};
			return { component: selector, focus: selector };
		});
	}

	#sameLine(tree: { branches: { id: number; parent?: number; at?: number }[] }, target: Item, candidate: Item): boolean {
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
	const app = await InteractiveApp.create(session, options);
	const quiet = (...parts: unknown[]) => {
		if (options.verbose) app.status(parts.map(String).join(" "));
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

