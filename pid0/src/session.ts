import { spawn } from "node:child_process";
import type { ContentBlock, McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { AcpAgent, AgentExited, type Choice, type NativeState } from "./acp.ts";
import { loadMcpServers, type Settings, updateSettings } from "./config.ts";
import { canonicalHarness, harnessIds, harnessLabel, resolveHarness } from "./harnesses.ts";
import { narrate } from "./narrate.ts";
import { type AssistantData, copySession, type Item, SessionStore, type ToolData, type ToolDiff, type TurnData, type Usage } from "./store.ts";

export type ImageInput = { data: string; mimeType: string };

export type AssistantMessage = { role: "assistant"; content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string })[]; harness: string; model?: string; timestamp: number };
export type UserMessage = { role: "user"; content: string; images?: number; timestamp: number };

export type Pid0Event =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "message_start"; message: UserMessage | AssistantMessage }
	| { type: "message_update"; assistantMessageEvent: { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string } }
	| { type: "message_end"; message: UserMessage | AssistantMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; kind?: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; status: string; partialResult: ToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
	| { type: "plan_update"; entries: { content: string; status: string; priority?: string }[] }
	| { type: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
	| { type: "turn_end"; message?: AssistantMessage; stopReason: string; usage?: Usage; error?: string }
	| { type: "agent_end"; messages: (UserMessage | AssistantMessage)[]; willRetry: false }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level?: string }
	| { type: "model_changed"; harness: string; model?: string }
	| { type: "harness_changed"; harness: string }
	| { type: "mode_changed"; mode?: string }
	| { type: "commands_changed" }
	| { type: "compaction_start"; reason: "manual" | "threshold" }
	| { type: "compaction_end"; summary?: string; error?: string }
	| { type: "shell_end"; command: string; output: string; exitCode: number | null; excluded: boolean }
	| { type: "session_changed"; reason: "new" | "switch" | "fork" | "clone" | "tree" }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string };

export type ToolResult = { content: { type: "text"; text: string }[]; diffs?: ToolDiff[]; locations?: { path: string; line?: number }[] };

export type PermissionPolicy = "ask" | "allow" | "deny";
export type PermissionAsker = (request: RequestPermissionRequest, harness: string) => Promise<RequestPermissionResponse>;

export type SessionOptions = {
	cwd: string;
	root: string;
	settings: Settings;
	store: SessionStore;
	harness?: string;
	model?: string;
	thinking?: string;
	mode?: string;
	scopedModels?: string[];
	permissions?: PermissionPolicy;
	systemPrompt?: string;
	systemPromptMode?: "append" | "override";
	noMcp?: boolean;
	persistPreferences?: boolean;
	log?: (line: string) => void;
};

export type SessionState = {
	harness: string;
	harnessLabel: string;
	connected: boolean;
	model?: string;
	modelName?: string;
	thinkingLevel?: string;
	mode?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	messageCount: number;
	pendingMessageCount: number;
	context?: { used: number; size: number };
	cost?: { amount: number; currency: string };
};

export function parseModelSpec(spec: string, settings: Settings): { harness?: string; model?: string; thinking?: string } {
	let rest = spec.trim();
	let thinking: string | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && !rest.slice(colon + 1).includes("/") && /^[a-z_-]+$/i.test(rest.slice(colon + 1))) {
		thinking = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	const slash = rest.indexOf("/");
	if (slash > 0) {
		const harness = canonicalHarness(rest.slice(0, slash), settings);
		if (harness) return { harness, ...(rest.slice(slash + 1) ? { model: rest.slice(slash + 1) } : {}), ...(thinking ? { thinking } : {}) };
	}
	const alone = canonicalHarness(rest, settings);
	if (alone && harnessIds(settings).includes(rest.toLowerCase())) return { harness: alone, ...(thinking ? { thinking } : {}) };
	return { ...(rest ? { model: rest } : {}), ...(thinking ? { thinking } : {}) };
}

export function matchChoice(choices: Choice[], pattern: string): Choice | undefined {
	const p = pattern.toLowerCase();
	const exact = choices.find((c) => c.id.toLowerCase() === p) ?? choices.find((c) => c.name.toLowerCase() === p);
	if (exact) return exact;
	if (/[*?]/.test(p)) {
		const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
		return choices.find((c) => re.test(c.id.toLowerCase()) || re.test(c.name.toLowerCase()));
	}
	const partial = choices.filter((c) => c.id.toLowerCase().includes(p) || c.name.toLowerCase().includes(p));
	return partial.sort((a, b) => a.id.length - b.id.length)[0];
}

function toMcpServers(cwd: string): McpServer[] {
	const out: McpServer[] = [];
	for (const [name, server] of Object.entries(loadMcpServers(cwd))) {
		if (server.enabled === false) continue;
		if ("command" in server) out.push({ name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([n, value]) => ({ name: n, value })) });
		else out.push({ type: server.type ?? "http", name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([n, value]) => ({ name: n, value })) } as McpServer);
	}
	return out;
}

function usageOf(usage: { totalTokens: number; inputTokens: number; outputTokens: number; cachedReadTokens?: number | null; cachedWriteTokens?: number | null } | null | undefined): Usage | undefined {
	if (!usage) return undefined;
	return { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cachedReadTokens ?? 0, cacheWrite: usage.cachedWriteTokens ?? 0, total: usage.totalTokens };
}

type Turn = {
	agent: AcpAgent;
	text: string;
	thinking: string;
	open: boolean;
	startedAt: number;
	tools: Map<string, ToolData>;
	written: Set<string>;
	terminals?: Map<string, string[]>;
	plan?: { content: string; status: string; priority?: string }[];
	messages: (UserMessage | AssistantMessage)[];
	last?: AssistantMessage;
	capture?: boolean;
};

export class Pid0Session {
	readonly cwd: string;
	readonly root: string;
	readonly settings: Settings;
	store: SessionStore;
	harness: string;
	onPermission: PermissionAsker | undefined;
	permissions: PermissionPolicy;
	scopedModels: string[];
	autoCompact = false;
	followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
	expand: ((text: string) => string) | undefined;

	readonly #options: SessionOptions;
	readonly #agents = new Map<string, AcpAgent>();
	readonly #bindings = new Map<string, string>();
	readonly #listeners = new Set<(event: Pid0Event) => void>();
	readonly #pendingPermissions = new Set<(response: RequestPermissionResponse) => void>();
	#pending: { model?: string; thinking?: string; mode?: string };
	#queue: { text: string; images?: ImageInput[] }[] = [];
	#busy = false;
	#compacting = false;
	#aborted = false;
	#turn: Turn | undefined;
	#writes: Promise<unknown> = Promise.resolve();
	#context: { used: number; size: number } | undefined;
	#cost: { amount: number; currency: string } | undefined;
	#primed = new Set<string>();
	totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

	private constructor(options: SessionOptions, harness: string) {
		this.#options = options;
		this.cwd = options.cwd;
		this.root = options.root;
		this.settings = options.settings;
		this.store = options.store;
		this.harness = harness;
		this.permissions = options.permissions ?? options.settings.permissions ?? "ask";
		this.scopedModels = options.scopedModels ?? options.settings.scopedModels ?? [];
		this.#pending = { ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.mode ? { mode: options.mode } : {}) };
	}

	static async start(options: SessionOptions): Promise<Pid0Session> {
		const natives = await options.store.natives();
		const spec = options.model ? parseModelSpec(options.model, options.settings) : {};
		options = { ...options };
		delete options.model;
		if (spec.model) options.model = spec.model;
		if (spec.thinking && !options.thinking) options.thinking = spec.thinking;
		const wanted = options.harness ?? spec.harness ?? natives.harness ?? options.settings.defaultHarness ?? "claude";
		const harness = canonicalHarness(wanted, options.settings);
		if (!harness) throw new Error(`unknown harness "${wanted}" (known: ${harnessIds(options.settings).join(", ")})`);
		const session = new Pid0Session(options, harness);
		await session.#loadTotals();
		if (natives.harness !== harness) await session.store.updateNatives((n) => void (n.harness = harness));
		return session;
	}

	subscribe(listener: (event: Pid0Event) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: Pid0Event): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch (error) {
				this.#options.log?.(`listener failed: ${(error as Error).message}`);
			}
		}
	}

	notice(level: "info" | "warning" | "error", text: string): void {
		this.#emit({ type: "notice", level, text });
	}

	label(harness = this.harness): string {
		return harnessLabel(harness, this.settings);
	}

	get isStreaming(): boolean {
		return this.#busy;
	}

	get native(): NativeState | undefined {
		const agent = this.#agents.get(this.harness);
		return agent?.alive && this.#bindings.get(this.harness) === this.#key() ? agent.state : undefined;
	}

	get agent(): AcpAgent | undefined {
		return this.#agents.get(this.harness);
	}

	get queued(): string[] {
		return this.#queue.map((q) => q.text);
	}

	get state(): SessionState {
		const native = this.native;
		const model = native?.currentModel ?? this.#pending.model;
		return {
			harness: this.harness,
			harnessLabel: this.label(),
			connected: native !== undefined,
			...(model ? { model, modelName: native?.models.find((m) => m.id === model)?.name ?? model } : {}),
			...(native?.currentThinking ? { thinkingLevel: native.currentThinking } : {}),
			...(native?.currentMode ? { mode: native.currentMode } : {}),
			isStreaming: this.#busy,
			isCompacting: this.#compacting,
			...(this.store.file ? { sessionFile: this.store.file } : {}),
			sessionId: this.store.id,
			...(this.store.meta.name ? { sessionName: this.store.meta.name } : {}),
			cwd: this.cwd,
			messageCount: this.store.meta.messages,
			pendingMessageCount: this.#queue.length,
			...(this.#context ? { context: this.#context } : {}),
			...(this.#cost ? { cost: this.#cost } : {}),
		};
	}

	#key(): string {
		return `${this.store.id}:${this.store.branch}`;
	}

	async #loadTotals(): Promise<void> {
		this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		this.#context = undefined;
		this.#cost = undefined;
		for (const item of await this.store.items()) {
			if (item.kind !== "turn") continue;
			this.#addUsage(item.data.usage);
			if (item.data.harness === this.harness) {
				this.#context = item.data.context;
				this.#cost = item.data.cost;
			}
		}
	}

	#addUsage(usage: Usage | undefined): void {
		if (!usage) return;
		this.totals.input += usage.input;
		this.totals.output += usage.output;
		this.totals.cacheRead += usage.cacheRead;
		this.totals.cacheWrite += usage.cacheWrite;
		this.totals.total += usage.total;
	}

	async #permission(request: RequestPermissionRequest, harness: string): Promise<RequestPermissionResponse> {
		const pick = (...kinds: string[]) => {
			for (const kind of kinds) {
				const option = request.options.find((o) => o.kind === kind);
				if (option) return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
			}
			return { outcome: { outcome: "cancelled" as const } };
		};
		if (this.permissions === "allow") return pick("allow_once", "allow_always");
		if (this.permissions === "deny" || !this.onPermission) return pick("reject_once", "reject_always");
		return new Promise<RequestPermissionResponse>((resolve) => {
			const done = (response: RequestPermissionResponse) => {
				this.#pendingPermissions.delete(done);
				resolve(response);
			};
			this.#pendingPermissions.add(done);
			this.onPermission!(request, harness).then(done, () => done({ outcome: { outcome: "cancelled" } }));
		});
	}

	async #agentFor(harness: string): Promise<AcpAgent> {
		let agent = this.#agents.get(harness);
		if (agent && !agent.alive) {
			this.#agents.delete(harness);
			this.#bindings.delete(harness);
			agent = undefined;
		}
		if (!agent) {
			agent = await AcpAgent.start(resolveHarness(harness, this.settings), this.cwd, {
				permission: (request) => this.#permission(request, harness),
				...(this.#options.log ? { log: this.#options.log } : {}),
			});
			agent.onUpdate = (update) => this.#onUpdate(harness, update);
			agent.onExit = () => {
				this.#bindings.delete(harness);
			};
			this.#agents.set(harness, agent);
		}
		return agent;
	}

	#connectLine: Promise<unknown> = Promise.resolve();

	connect(): Promise<NativeState> {
		const run = this.#connectLine.then(
			() => this.#connect(),
			() => this.#connect(),
		);
		this.#connectLine = run.catch(() => {});
		return run;
	}

	async #connect(): Promise<NativeState> {
		const harness = this.harness;
		const agent = await this.#agentFor(harness);
		if (agent.state && this.#bindings.get(harness) === this.#key()) return agent.state;
		const natives = await this.store.natives();
		const info = natives.agents[harness];
		const options = {
			cwd: this.cwd,
			mcpServers: this.#options.noMcp ? [] : toMcpServers(this.cwd),
			...(this.#options.systemPrompt ? { systemPrompt: this.#options.systemPrompt, systemPromptMode: this.#options.systemPromptMode ?? "append" } : {}),
		};
		let state = info?.sessionId ? await agent.resumeSession(info.sessionId, options) : undefined;
		const resumed = state !== undefined;
		state ??= await agent.newSession(options);
		this.#bindings.set(harness, this.#key());
		const sessionId = state.sessionId;
		await this.store.updateNatives((n) => {
			n.agents[harness] ??= { seen: 0 };
			const entry = n.agents[harness]!;
			entry.sessionId = sessionId;
			if (!resumed) entry.seen = 0;
		});
		if (!resumed) this.#primed.delete(`${harness}:${sessionId}`);
		else this.#primed.add(`${harness}:${sessionId}`);
		const wantModel = this.#pending.model ?? info?.model ?? this.settings.defaultModels?.[harness];
		const wantThinking = this.#pending.thinking ?? info?.thinking ?? this.settings.defaultThinking?.[harness];
		const wantMode = this.#pending.mode ?? info?.mode ?? this.settings.defaultModes?.[harness];
		const explicit = { ...this.#pending };
		this.#pending = {};
		await this.#apply(agent, state, "model", wantModel, explicit.model !== undefined);
		await this.#apply(agent, state, "thinking", wantThinking, explicit.thinking !== undefined);
		await this.#apply(agent, state, "mode", wantMode, explicit.mode !== undefined);
		this.#emit({ type: "model_changed", harness, ...(state.currentModel ? { model: state.currentModel } : {}) });
		this.#emit({ type: "commands_changed" });
		return state;
	}

	async #apply(agent: AcpAgent, state: NativeState, what: "model" | "thinking" | "mode", wanted: string | undefined, explicit: boolean): Promise<void> {
		if (!wanted) return;
		const choices = what === "model" ? state.models : what === "thinking" ? state.thinking : state.modes;
		const current = what === "model" ? state.currentModel : what === "thinking" ? state.currentThinking : state.currentMode;
		const choice = matchChoice(choices, wanted);
		if (!choice) {
			if (explicit) {
				const known = choices.map((c) => c.id).join(", ");
				this.notice("warning", choices.length ? `${agent.harness.label} has no ${what} matching "${wanted}" (it offers: ${known})` : `${agent.harness.label} does not offer a ${what} choice over ACP`);
			}
			return;
		}
		if (choice.id === current) return;
		try {
			if (what === "model") await agent.setModel(choice.id);
			else if (what === "thinking") await agent.setThinking(choice.id);
			else await agent.setMode(choice.id);
			if (explicit) await this.#remember(agent.harness.id, what, choice.id);
		} catch (error) {
			this.notice("warning", `${agent.harness.label} refused ${what} "${choice.id}": ${(error as Error).message}`);
		}
	}

	async #remember(harness: string, what: "model" | "thinking" | "mode", id: string): Promise<void> {
		await this.store.updateNatives((n) => {
			n.agents[harness] ??= { seen: 0 };
			n.agents[harness]![what] = id;
		});
		if (this.#options.persistPreferences) {
			updateSettings((settings) => {
				const key = what === "model" ? "defaultModels" : what === "thinking" ? "defaultThinking" : "defaultModes";
				(settings[key] ??= {})[harness] = id;
				settings.defaultHarness = harness;
			});
		}
	}

	async setHarness(name: string): Promise<void> {
		if (this.#busy) throw new Error("wait for the current turn to finish (or press Esc) before switching harness");
		const harness = canonicalHarness(name, this.settings);
		if (!harness) throw new Error(`unknown harness "${name}" (known: ${harnessIds(this.settings).join(", ")})`);
		if (harness === this.harness) return;
		const from = this.harness;
		this.harness = harness;
		await this.store.updateNatives((n) => void (n.harness = harness));
		if (this.store.meta.messages > 0) await this.store.append("switch", { harness, from, at: Date.now() });
		this.#context = undefined;
		this.#cost = undefined;
		if (this.#options.persistPreferences) updateSettings((settings) => void (settings.defaultHarness = harness));
		this.#emit({ type: "harness_changed", harness });
	}

	async setModel(spec: string): Promise<{ harness: string; model?: string }> {
		const parsed = parseModelSpec(spec, this.settings);
		if (parsed.harness && parsed.harness !== this.harness) await this.setHarness(parsed.harness);
		const state = await this.connect();
		const agent = this.#agents.get(this.harness)!;
		if (parsed.model) {
			const choice = matchChoice(state.models, parsed.model);
			if (!choice) throw new Error(state.models.length ? `${this.label()} has no model matching "${parsed.model}" (it offers: ${state.models.map((m) => m.id).join(", ")})` : `${this.label()} does not offer a model choice over ACP`);
			if (choice.id !== state.currentModel) await agent.setModel(choice.id);
			await this.#remember(this.harness, "model", choice.id);
		}
		if (parsed.thinking) await this.setThinking(parsed.thinking);
		this.#emit({ type: "model_changed", harness: this.harness, ...(state.currentModel ? { model: state.currentModel } : {}) });
		return { harness: this.harness, ...(state.currentModel ? { model: state.currentModel } : {}) };
	}

	async setThinking(level: string): Promise<string> {
		const state = await this.connect();
		const choice = matchChoice(state.thinking, level);
		if (!choice) throw new Error(state.thinking.length ? `${this.label()} has no thinking level "${level}" (it offers: ${state.thinking.map((m) => m.id).join(", ")})` : `${this.label()} does not offer thinking levels over ACP`);
		if (choice.id !== state.currentThinking) await this.#agents.get(this.harness)!.setThinking(choice.id);
		await this.#remember(this.harness, "thinking", choice.id);
		this.#emit({ type: "thinking_level_changed", level: choice.id });
		return choice.id;
	}

	async cycleThinking(): Promise<string | undefined> {
		const state = await this.connect();
		if (state.thinking.length === 0) return undefined;
		const index = state.thinking.findIndex((c) => c.id === state.currentThinking);
		return this.setThinking(state.thinking[(index + 1) % state.thinking.length]!.id);
	}

	async setMode(mode: string): Promise<string> {
		const state = await this.connect();
		const choice = matchChoice(state.modes, mode);
		if (!choice) throw new Error(state.modes.length ? `${this.label()} has no mode "${mode}" (it offers: ${state.modes.map((m) => m.id).join(", ")})` : `${this.label()} does not offer modes over ACP`);
		if (choice.id !== state.currentMode) await this.#agents.get(this.harness)!.setMode(choice.id);
		await this.#remember(this.harness, "mode", choice.id);
		this.#emit({ type: "mode_changed", mode: choice.id });
		return choice.id;
	}

	async cycleModel(direction: 1 | -1 = 1): Promise<{ harness: string; model?: string } | undefined> {
		if (this.scopedModels.length > 0) {
			const specs = this.scopedModels;
			const state = this.native;
			const index = specs.findIndex((spec) => {
				const parsed = parseModelSpec(spec, this.settings);
				if ((parsed.harness ?? this.harness) !== this.harness) return false;
				return !parsed.model || (state ? matchChoice(state.models, parsed.model)?.id === state.currentModel : false);
			});
			const next = specs[(index + direction + specs.length) % specs.length]!;
			return this.setModel(next);
		}
		const state = await this.connect();
		if (state.models.length < 2) return undefined;
		const index = state.models.findIndex((c) => c.id === state.currentModel);
		return this.setModel(`${this.harness}/${state.models[(index + direction + state.models.length) % state.models.length]!.id}`);
	}

	async availableModels(harnesses: string[] = [this.harness]): Promise<{ harness: string; models: Choice[]; current?: string; error?: string }[]> {
		const out = [];
		for (const harness of harnesses) {
			try {
				if (harness === this.harness) {
					const state = await this.connect();
					out.push({ harness, models: state.models, ...(state.currentModel ? { current: state.currentModel } : {}) });
				} else {
					const agent = await this.#agentFor(harness);
					const state = agent.state ?? (await agent.newSession({ cwd: this.cwd, mcpServers: [] }));
					this.#bindings.delete(harness);
					out.push({ harness, models: state.models, ...(state.currentModel ? { current: state.currentModel } : {}) });
				}
			} catch (error) {
				out.push({ harness, models: [], error: (error as Error).message.split("\n")[0]! });
			}
		}
		return out;
	}

	async prompt(raw: string, options: { images?: ImageInput[]; behavior?: "steer" | "followUp" } = {}): Promise<"started" | "queued"> {
		const text = this.expand ? this.expand(raw) : raw;
		if (this.#busy) {
			this.#queue.push({ text, ...(options.images ? { images: options.images } : {}) });
			this.#emitQueue();
			return "queued";
		}
		this.#busy = true;
		this.#aborted = false;
		void this.#run({ text, ...(options.images ? { images: options.images } : {}) });
		return "started";
	}

	async promptAndWait(text: string, options: { images?: ImageInput[] } = {}): Promise<void> {
		const settled = this.waitForSettled();
		await this.prompt(text, options);
		await settled;
	}

	waitForSettled(): Promise<{ aborted: boolean }> {
		return new Promise((resolve) => {
			const stop = this.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				stop();
				resolve({ aborted: event.aborted });
			});
		});
	}

	#emitQueue(): void {
		this.#emit({ type: "queue_update", steering: [], followUp: this.queued });
	}

	takeQueue(): string[] {
		const texts = this.queued;
		this.#queue = [];
		this.#emitQueue();
		return texts;
	}

	async #run(first: { text: string; images?: ImageInput[] }): Promise<void> {
		let next: { text: string; images?: ImageInput[] } | undefined = first;
		while (next) {
			await this.#oneTurn(next.text, next.images ?? []);
			if (this.#aborted) break;
			if (this.followUpMode === "all" && this.#queue.length > 1) {
				const all = this.#queue.splice(0);
				next = { text: all.map((q) => q.text).join("\n\n"), images: all.flatMap((q) => q.images ?? []) };
			} else next = this.#queue.shift();
			if (next) this.#emitQueue();
		}
		const context = this.#context;
		if (this.autoCompact && !this.#aborted && context && context.size > 0 && context.used / context.size >= 0.9) {
			await this.#compactNow(undefined, "threshold").catch((error) => this.notice("warning", `auto-compaction failed: ${(error as Error).message}`));
		}
		this.#busy = false;
		this.#emit({ type: "agent_settled", aborted: this.#aborted });
	}

	async abort(): Promise<void> {
		if (!this.#busy && !this.#compacting) return;
		this.#aborted = true;
		for (const done of [...this.#pendingPermissions]) done({ outcome: { outcome: "cancelled" } });
		await this.#turn?.agent.cancel();
	}

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#writes.then(work, work);
		this.#writes = run.catch(() => {});
		return run;
	}

	async #preface(agent: AcpAgent, state: NativeState): Promise<ContentBlock[]> {
		const harness = agent.harness.id;
		const blocks: ContentBlock[] = [];
		const primedKey = `${harness}:${state.sessionId}`;
		const seen = (await this.store.natives()).agents[harness]?.seen ?? 0;
		const unseen = (await this.store.contextItems()).filter((item) => item.id > seen);
		const told = narrate(unseen, (h) => this.label(h), seen === 0);
		if (told) blocks.push({ type: "text", text: told });
		if (!this.#primed.has(primedKey)) {
			this.#primed.add(primedKey);
			if (this.#options.systemPrompt && !agent.supportsSystemPrompt) blocks.push({ type: "text", text: `<instructions>\n${this.#options.systemPrompt}\n</instructions>` });
		}
		return blocks;
	}

	async #oneTurn(text: string, images: ImageInput[]): Promise<void> {
		const startedAt = Date.now();
		const harness = this.harness;
		this.#emit({ type: "agent_start" });
		this.#emit({ type: "turn_start" });
		const user: UserMessage = { role: "user", content: text, ...(images.length ? { images: images.length } : {}), timestamp: startedAt };
		let turn: Turn | undefined;
		let stopReason = "error";
		let usage: Usage | undefined;
		let failure: string | undefined;
		try {
			const state = await this.connect();
			const agent = this.#agents.get(harness)!;
			const preface = await this.#preface(agent, state);
			await this.store.append("user", { text, ...(images.length ? { images: images.length } : {}), harness, ...(state.currentModel ? { model: state.currentModel } : {}), at: startedAt });
			this.#emit({ type: "message_start", message: user });
			this.#emit({ type: "message_end", message: user });
			turn = { agent, text: "", thinking: "", open: false, startedAt, tools: new Map(), written: new Set(), messages: [user] };
			this.#turn = turn;
			const canImage = agent.capabilities.promptCapabilities?.image;
			if (images.length && !canImage) this.notice("warning", `${agent.harness.label} does not accept images; they were left out`);
			const blocks: ContentBlock[] = [...preface, { type: "text", text }, ...(canImage ? images.map((image): ContentBlock => ({ type: "image", data: image.data, mimeType: image.mimeType })) : [])];
			const response = await agent.prompt(blocks);
			stopReason = response.stopReason;
			usage = usageOf(response.usage);
		} catch (error) {
			failure = (error as Error).message ?? String(error);
			if (error instanceof AgentExited) this.#bindings.delete(harness);
			if (!turn) {
				this.#emit({ type: "message_start", message: user });
				this.#emit({ type: "message_end", message: user });
			}
		}
		if (this.#aborted && stopReason === "error") stopReason = "cancelled";
		if (turn) {
			const t = turn;
			await this.#serial(async () => {
				await this.#flushAssistant(t);
				for (const [id, tool] of t.tools) if (!t.written.has(id)) await this.#writeTool(t, { ...tool, status: tool.status === "completed" || tool.status === "failed" ? tool.status : "cancelled" });
				if (t.plan) await this.store.append("plan", { entries: t.plan, harness, at: Date.now() });
			});
		}
		this.#turn = undefined;
		this.#addUsage(usage);
		const model = this.native?.currentModel;
		const data: TurnData = {
			harness,
			...(model ? { model } : {}),
			stopReason,
			...(failure && stopReason !== "cancelled" ? { error: failure } : {}),
			...(usage ? { usage } : {}),
			...(this.#context ? { context: this.#context } : {}),
			...(this.#cost ? { cost: this.#cost } : {}),
			durationMs: Date.now() - startedAt,
			at: Date.now(),
		};
		const last = await this.store.append("turn", data);
		if (turn) await this.store.updateNatives((n) => {
				n.agents[harness] ??= { seen: 0 };
				n.agents[harness]!.seen = last;
			});
		if (failure && stopReason !== "cancelled") this.notice("error", failure);
		this.#emit({ type: "turn_end", ...(turn?.last ? { message: turn.last } : {}), stopReason, ...(usage ? { usage } : {}), ...(data.error ? { error: data.error } : {}) });
		this.#emit({ type: "agent_end", messages: turn?.messages ?? [user], willRetry: false });
		if (failure && stopReason !== "cancelled") this.#aborted = true;
	}

	async #flushAssistant(turn: Turn): Promise<void> {
		if (!turn.text && !turn.thinking) return;
		const data: AssistantData = { text: turn.text, ...(turn.thinking ? { thinking: turn.thinking } : {}), harness: turn.agent.harness.id, ...(turn.agent.state?.currentModel ? { model: turn.agent.state.currentModel } : {}), at: Date.now() };
		const message: AssistantMessage = {
			role: "assistant",
			content: [...(data.thinking ? [{ type: "thinking" as const, thinking: data.thinking }] : []), ...(data.text ? [{ type: "text" as const, text: data.text }] : [])],
			harness: data.harness,
			...(data.model ? { model: data.model } : {}),
			timestamp: data.at,
		};
		turn.text = "";
		turn.thinking = "";
		turn.open = false;
		turn.last = message;
		turn.messages.push(message);
		if (!turn.capture) await this.store.append("assistant", data);
		this.#emit({ type: "message_end", message });
	}

	async #writeTool(turn: Turn, tool: ToolData): Promise<void> {
		turn.written.add(tool.toolCallId);
		await this.store.append("tool", tool);
		this.#emit({ type: "tool_execution_end", toolCallId: tool.toolCallId, toolName: tool.title, result: this.#toolResult(tool), isError: tool.status !== "completed" });
	}

	#toolResult(tool: ToolData): ToolResult {
		return { content: tool.output ? [{ type: "text", text: tool.output }] : [], ...(tool.diffs ? { diffs: tool.diffs } : {}), ...(tool.locations ? { locations: tool.locations } : {}) };
	}

	#mergeTool(turn: Turn, tool: ToolData, update: Record<string, any>): void {
		if (update.title) tool.title = update.title;
		if (update.kind) tool.kind = update.kind;
		if (update.status) tool.status = update.status;
		if (update.rawInput !== undefined) tool.input = update.rawInput;
		if (update.locations) tool.locations = update.locations.map((l: { path: string; line?: number | null }) => ({ path: l.path, ...(l.line != null ? { line: l.line } : {}) }));
		if (update.content) {
			const texts: string[] = [];
			const diffs: ToolDiff[] = [];
			for (const c of update.content as Record<string, any>[]) {
				if (c.type === "content" && c.content?.type === "text") texts.push(c.content.text);
				else if (c.type === "diff") diffs.push({ path: c.path, ...(c.oldText != null ? { oldText: c.oldText } : {}), newText: c.newText });
				else if (c.type === "terminal") {
					turn.terminals ??= new Map();
					turn.terminals.set(tool.toolCallId, [...(turn.terminals.get(tool.toolCallId) ?? []), c.terminalId]);
				}
			}
			for (const id of turn.terminals?.get(tool.toolCallId) ?? []) texts.push(turn.agent.terminalOutput(id) ?? "");
			const output = texts.join("\n");
			if (output) tool.output = output.length > 50_000 ? `${output.slice(0, 50_000)}\n… (truncated)` : output;
			if (diffs.length) tool.diffs = diffs;
		}
		if (!update.content) {
			const live = (turn.terminals?.get(tool.toolCallId) ?? []).map((id) => turn.agent.terminalOutput(id) ?? "").join("\n");
			if (live) tool.output = live.length > 50_000 ? `${live.slice(0, 50_000)}\n… (truncated)` : live;
		}
		if (!tool.output && update.rawOutput !== undefined && update.rawOutput !== null) {
			const raw = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
			tool.output = raw.length > 50_000 ? `${raw.slice(0, 50_000)}\n… (truncated)` : raw;
		}
	}

	#onUpdate(harness: string, update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "available_commands_update":
				this.#emit({ type: "commands_changed" });
				return;
			case "current_mode_update":
				this.#emit({ type: "mode_changed", mode: update.currentModeId });
				return;
			case "config_option_update": {
				const state = this.#agents.get(harness)?.state;
				this.#emit({ type: "model_changed", harness, ...(state?.currentModel ? { model: state.currentModel } : {}) });
				return;
			}
			case "usage_update":
				if (harness === this.harness) {
					this.#context = { used: update.used, size: update.size };
					if (update.cost) this.#cost = update.cost;
				}
				this.#emit({ type: "usage_update", used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) });
				return;
		}
		const turn = this.#turn;
		if (!turn || turn.agent.harness.id !== harness) return;
		const open = () => {
			if (turn.open) return;
			turn.open = true;
			this.#emit({ type: "message_start", message: { role: "assistant", content: [], harness, ...(turn.agent.state?.currentModel ? { model: turn.agent.state.currentModel } : {}), timestamp: Date.now() } });
		};
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const content = update.content;
				const delta = content.type === "text" ? content.text : content.type === "resource_link" ? `[${content.name}](${content.uri})` : "";
				if (!delta) return;
				open();
				if (update.sessionUpdate === "agent_message_chunk") {
					turn.text += delta;
					this.#emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: turn.thinking ? 1 : 0, delta } });
				} else {
					turn.thinking += delta;
					this.#emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } });
				}
				return;
			}
			case "tool_call": {
				if (turn.capture) return;
				void this.#serial(() => this.#flushAssistant(turn));
				const tool: ToolData = { toolCallId: update.toolCallId, title: update.title, status: update.status ?? "pending", harness, at: Date.now() };
				this.#mergeTool(turn, tool, update);
				turn.tools.set(tool.toolCallId, tool);
				this.#emit({ type: "tool_execution_start", toolCallId: tool.toolCallId, toolName: tool.title, ...(tool.kind ? { kind: tool.kind } : {}), args: tool.input ?? null });
				if (tool.status === "completed" || tool.status === "failed") void this.#serial(() => this.#writeTool(turn, { ...tool }));
				return;
			}
			case "tool_call_update": {
				if (turn.capture) return;
				let tool = turn.tools.get(update.toolCallId);
				if (!tool) {
					void this.#serial(() => this.#flushAssistant(turn));
					tool = { toolCallId: update.toolCallId, title: update.title ?? "tool", status: update.status ?? "in_progress", harness, at: Date.now() };
					turn.tools.set(tool.toolCallId, tool);
					this.#emit({ type: "tool_execution_start", toolCallId: tool.toolCallId, toolName: tool.title, args: update.rawInput ?? null });
				}
				if (turn.written.has(tool.toolCallId)) return;
				this.#mergeTool(turn, tool, update);
				if (tool.status === "completed" || tool.status === "failed") {
					const done = { ...tool };
					turn.written.add(done.toolCallId);
					void this.#serial(() => this.#writeTool(turn, done));
				} else this.#emit({ type: "tool_execution_update", toolCallId: tool.toolCallId, toolName: tool.title, args: tool.input ?? null, status: tool.status, partialResult: this.#toolResult(tool) });
				return;
			}
			case "plan":
				if (turn.capture) return;
				turn.plan = update.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority }));
				this.#emit({ type: "plan_update", entries: turn.plan });
				return;
		}
	}

	async compact(instructions?: string): Promise<string | undefined> {
		if (this.#busy) throw new Error("wait for the current turn to finish before compacting");
		this.#busy = true;
		this.#aborted = false;
		try {
			return await this.#compactNow(instructions, "manual");
		} finally {
			this.#busy = false;
		}
	}

	async #compactNow(instructions: string | undefined, reason: "manual" | "threshold"): Promise<string | undefined> {
		this.#compacting = true;
		this.#emit({ type: "compaction_start", reason });
		let summary: string | undefined;
		let failure: string | undefined;
		try {
			const state = await this.connect();
			const agent = this.#agents.get(this.harness)!;
			const preface = await this.#preface(agent, state);
			const turn: Turn = { agent, text: "", thinking: "", open: true, startedAt: Date.now(), tools: new Map(), written: new Set(), messages: [], capture: true };
			this.#turn = turn;
			const ask = `Write a handoff summary of this whole conversation so far, for an agent that will continue the work without seeing it. Cover the goal, decisions made, the state of the files touched, what was verified, and what remains. Do not use tools; reply with the summary only.${instructions ? `\n\nAlso: ${instructions}` : ""}`;
			const response = await agent.prompt([...preface, { type: "text", text: ask }]);
			summary = turn.text.trim();
			if (response.stopReason === "cancelled" || !summary) throw new Error(response.stopReason === "cancelled" ? "compaction was cancelled" : `${this.label()} returned no summary`);
			await this.store.reset(summary);
			this.#bindings.clear();
			this.#context = undefined;
		} catch (error) {
			failure = (error as Error).message;
			summary = undefined;
		} finally {
			this.#turn = undefined;
			this.#compacting = false;
		}
		this.#emit({ type: "compaction_end", ...(summary ? { summary } : {}), ...(failure ? { error: failure } : {}) });
		if (failure) throw new Error(failure);
		return summary;
	}

	shell(command: string, excluded: boolean, onData?: (chunk: string) => void): Promise<{ output: string; exitCode: number | null }> {
		return new Promise((resolve) => {
			const child = spawn(command, { cwd: this.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			const take = (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				output += text;
				onData?.(text);
			};
			child.stdout.on("data", take);
			child.stderr.on("data", take);
			child.on("error", (error) => take(Buffer.from(`${error.message}\n`)));
			child.on("close", async (exitCode) => {
				if (output.length > 100_000) output = `${output.slice(0, 100_000)}\n… (truncated)`;
				await this.store.append("shell", { command, output, exitCode, excluded, at: Date.now() });
				this.#emit({ type: "shell_end", command, output, exitCode, excluded });
				resolve({ output, exitCode });
			});
		});
	}

	async setName(name: string | undefined): Promise<void> {
		await this.store.setName(name);
		this.#emit({ type: "session_info_changed", ...(name ? { name } : {}) });
	}

	async #swap(store: SessionStore, reason: "new" | "switch" | "fork" | "clone" | "tree"): Promise<void> {
		if (store !== this.store) {
			const old = this.store;
			this.store = store;
			await old.close();
		}
		this.#queue = [];
		const natives = await this.store.natives();
		const harness = natives.harness ? canonicalHarness(natives.harness, this.settings) : undefined;
		if (harness && reason === "switch") this.harness = harness;
		else if (natives.harness !== this.harness) await this.store.updateNatives((n) => void (n.harness = this.harness));
		await this.#loadTotals();
		this.#emit({ type: "session_changed", reason });
	}

	#idle(what: string): void {
		if (this.#busy) throw new Error(`wait for the current turn to finish before ${what}`);
	}

	get persistent(): boolean {
		return this.store.file !== undefined;
	}

	async newSession(): Promise<void> {
		this.#idle("starting a new session");
		const store = await SessionStore.create({ root: this.root, cwd: this.cwd, memory: !this.persistent });
		await this.#carryPrefs(store);
		await this.#swap(store, "new");
	}

	async #carryPrefs(store: SessionStore): Promise<void> {
		const prefs = await this.store.natives();
		await store.updateNatives((n) => {
			n.harness = this.harness;
			for (const [harness, info] of Object.entries(prefs.agents)) {
				n.agents[harness] = { seen: 0, ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}), ...(info.mode ? { mode: info.mode } : {}) };
			}
		});
	}

	async switchSession(file: string): Promise<void> {
		this.#idle("switching sessions");
		if (file === this.store.file) return;
		const store = await SessionStore.open(file);
		await this.#swap(store, "switch");
	}

	async navigate(entryId: number | undefined): Promise<void> {
		this.#idle("moving in the session tree");
		await this.store.branchAt(entryId);
		await this.#swap(this.store, "tree");
	}

	async clone(entryId?: number | "empty"): Promise<string> {
		this.#idle("cloning the session");
		if (!this.store.file) throw new Error("this session is not saved (--no-session), so it cannot be forked or cloned");
		const file = await copySession(this.store.file, { root: this.root, cwd: this.cwd, open: this.store });
		const store = await SessionStore.open(file);
		if (entryId !== undefined) await store.branchAt(entryId === "empty" ? undefined : entryId);
		await this.#swap(store, entryId === undefined ? "clone" : "fork");
		return file;
	}

	async messages(): Promise<Item[]> {
		return this.store.items();
	}

	async lastAssistantText(): Promise<string | undefined> {
		for (const item of (await this.store.items()).reverse()) if (item.kind === "assistant" && item.data.text) return item.data.text;
		return undefined;
	}

	async dispose(): Promise<void> {
		for (const agent of this.#agents.values()) agent.close();
		this.#agents.clear();
		await this.#writes;
		await this.store.close();
	}
}
