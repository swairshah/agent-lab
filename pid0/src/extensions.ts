import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import { ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { VERSION } from "./config.ts";
import type { Resources } from "./resources.ts";
import type { ImageInput, Pid0Event, Pid0Session } from "./session.ts";
import type { Item } from "./store.ts";

type Runner = InstanceType<typeof ExtensionRunner>;
type UIContext = Parameters<Runner["setUIContext"]>[0];
type Core = Parameters<Runner["bindCore"]>[0];
type Ctx = Parameters<Runner["bindCore"]>[1];
type Cmd = NonNullable<Parameters<Runner["bindCommandContext"]>[0]>;
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export type HostOptions = { mode: ExtensionMode; flags: Map<string, string | true>; shutdown: () => void; reload?: () => Promise<void> };

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).join("");
	return "";
}

export class ExtensionHost {
	readonly runner: Runner;
	readonly session: Pid0Session;
	readonly resources: Resources;
	readonly mirror: SessionManager;
	readonly errors: string[] = [];
	onError: ((message: string) => void) | undefined;
	readonly #options: HostOptions;
	#line: Promise<unknown> = Promise.resolve();
	#turn = 0;
	#server: Server | undefined;
	#mcp: McpServer | undefined;
	#token = randomUUID();
	#abort: AbortController | undefined;

	private constructor(session: Pid0Session, resources: Resources, runner: Runner, mirror: SessionManager, options: HostOptions) {
		this.session = session;
		this.resources = resources;
		this.runner = runner;
		this.mirror = mirror;
		this.#options = options;
	}

	static async load(session: Pid0Session, resources: Resources, options: HostOptions): Promise<ExtensionHost | undefined> {
		const loaded = resources.extensions;
		if (!loaded || loaded.extensions.length === 0) {
			if (options.flags.size) throw new Error(`unknown option --${[...options.flags.keys()][0]} (see pid0 --help)`);
			return undefined;
		}
		const mirror = SessionManager.inMemory(session.cwd);
		const runtime = await ModelRuntime.create({ allowModelNetwork: false });
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, session.cwd, mirror, new ModelRegistry(runtime));
		const host = new ExtensionHost(session, resources, runner, mirror, options);
		const known = runner.getFlags();
		for (const [name, value] of options.flags) {
			const flag = known.get(name);
			if (!flag) throw new Error(`unknown option --${name} (no loaded extension registers it; see pid0 --help)`);
			runner.setFlagValue(name, flag.type === "boolean" ? value !== "false" : String(value));
		}
		host.#bind();
		await host.#rebuildMirror();
		runner.onError((error) => host.#report(`extension ${error.extensionPath} failed in ${error.event}: ${error.error}`));
		session.subscribe((event) => host.#onEvent(event));
		session.intercept = (text, images) => host.#input(text, images);
		session.beforeTurn = (text, images) => host.#beforeTurn(text, images);
		if (runner.getAllRegisteredTools().length > 0) {
			await host.#startMcp();
			session.extraMcpServers = () => (host.#mcp ? [host.#mcp] : []);
		}
		return host;
	}

	#report(message: string): void {
		this.errors.push(message);
		if (this.onError) this.onError(message);
		else this.session.notice("warning", message);
	}

	#model(): Record<string, unknown> | undefined {
		const s = this.session.state;
		if (!s.model) return undefined;
		return { provider: s.harness, id: s.model, name: s.modelName ?? s.model, api: "acp", baseUrl: "", reasoning: Boolean(this.session.native?.thinking.length), input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: s.context?.size ?? 0, maxTokens: 0 };
	}

	#bind(): void {
		const session = this.session;
		const runner = this.runner;
		const settle = () => (session.isStreaming ? session.waitForSettled().then(() => {}) : Promise.resolve());
		const core: Partial<Record<keyof Core, unknown>> & Pick<Core, "sendMessage" | "sendUserMessage" | "appendEntry" | "setSessionName" | "setModel" | "setThinkingLevel"> = {
				sendMessage: (message, options) => {
					const content = textOf(message.content);
					this.#queue(async () => {
						await session.addEntry("note", { customType: message.customType, content, display: message.display, details: message.details });
						if (options?.triggerTurn) await session.prompt(content);
					});
				},
				sendUserMessage: (content) => {
					this.#queue(() => session.prompt(textOf(content)));
				},
				appendEntry: (customType, data) => {
					this.#queue(() => session.addEntry("custom", { customType, data }));
				},
				setSessionName: (name) => {
					this.#queue(() => session.setName(name));
				},
				getSessionName: () => session.store.meta.name,
				setLabel: () => {},
				getActiveTools: () => runner.getAllRegisteredTools().map((t) => t.definition.name),
				getAllTools: () => runner.getAllRegisteredTools().map((t) => ({ name: t.definition.name, description: t.definition.description, parameters: t.definition.parameters, exposure: "direct", sourceInfo: t.sourceInfo })) as never,
				getSettings: () => this.resources.settings.getSettings(),
				setActiveTools: () => {},
				refreshTools: () => {},
				getCommands: () => runner.getRegisteredCommands().map((c) => ({ name: c.invocationName, ...(c.description ? { description: c.description } : {}), source: "extension", sourceInfo: c.sourceInfo })) as never,
				setModel: async (model) => {
					try {
						await session.setModel(`${model.provider}/${model.id}`);
						return true;
					} catch {
						return false;
					}
				},
				getThinkingLevel: () => (session.state.thinkingLevel ?? "off") as never,
				setThinkingLevel: (level) => {
					this.#queue(() => session.setThinking(level));
				},
		};
		const ctx: Partial<Record<keyof Ctx, unknown>> & Pick<Ctx, "compact"> = {
				getModel: () => this.#model() as never,
				getScopedModels: () => [],
				isIdle: () => !session.isStreaming,
				isProjectTrusted: () => this.resources.settings.isProjectTrusted(),
				getSignal: () => this.#abort?.signal,
				abort: () => void session.abort(),
				hasPendingMessages: () => session.queued.length > 0,
				shutdown: () => this.#options.shutdown(),
				getContextUsage: () => {
					const c = session.contextUsage;
					return c ? { tokens: c.used, contextWindow: c.size, percent: c.size ? (c.used / c.size) * 100 : null } : undefined;
				},
				compact: (options) => {
					this.#queue(async () => {
						await settle();
						await session.compact(options?.customInstructions);
					});
				},
				getSystemPrompt: () => "",
		};
		runner.bindCore(core as Core, ctx as Ctx);
		const commands: Cmd = {
			waitForIdle: settle,
			newSession: async () => {
				await session.newSession();
				return { cancelled: false };
			},
			fork: async (entryId) => {
				const items = await session.messages();
				const index = items.findIndex((i) => String(i.id) === entryId);
				if (index < 0) throw new Error(`no entry ${entryId}`);
				await session.clone(index === 0 ? "empty" : items[index - 1]!.id);
				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigate(Number(targetId), { ...(options?.summarize ? { summarize: true } : {}), ...(options?.customInstructions ? { instructions: options.customInstructions } : {}) });
				return { cancelled: result.aborted };
			},
			switchSession: async (path) => {
				await session.switchSession(path);
				return { cancelled: false };
			},
			reload: async () => {
				await this.#options.reload?.();
			},
		};
		runner.bindCommandContext(commands);
	}

	setUI(ui: UIContext): void {
		this.runner.setUIContext(ui, this.#options.mode);
	}

	async start(): Promise<void> {
		await this.#emit({ type: "session_start", reason: "startup" });
	}

	#queue(work: () => Promise<unknown>): void {
		this.#line = this.#line.then(work).catch((error) => this.#report((error as Error).message));
	}

	async #emit(event: Record<string, unknown>): Promise<unknown> {
		try {
			return await this.runner.emit(event as never);
		} catch (error) {
			this.#report(`extension event ${String(event.type)} failed: ${(error as Error).message}`);
			return undefined;
		}
	}

	#mirrorItem(item: Item): void {
		try {
			if (item.kind === "user") this.mirror.appendMessage({ role: "user", content: item.data.text, timestamp: item.data.at } as never);
			else if (item.kind === "assistant") this.mirror.appendMessage(this.#assistant(item.data.text, item.data.harness, item.data.model, item.data.at) as never);
			else if (item.kind === "custom") this.mirror.appendCustomEntry(item.data.customType, item.data.data);
			else if (item.kind === "note") this.mirror.appendCustomMessageEntry(item.data.customType, item.data.content, item.data.display, item.data.details);
		} catch {}
	}

	#assistant(text: string, harness: string, model: string | undefined, timestamp: number): Record<string, unknown> {
		return { role: "assistant", content: text ? [{ type: "text", text }] : [], api: "acp", provider: harness, model: model ?? "default", usage: ZERO_USAGE, stopReason: "stop", timestamp };
	}

	async #rebuildMirror(): Promise<void> {
		this.mirror.newSession({ id: this.session.store.id });
		if (this.session.store.meta.name) this.mirror.appendSessionInfo(this.session.store.meta.name);
		for (const item of await this.session.messages()) this.#mirrorItem(item);
	}

	#onEvent(event: Pid0Event): void {
		switch (event.type) {
			case "agent_start":
				this.#abort = new AbortController();
				this.#queue(() => this.#emit({ type: "agent_start" }));
				break;
			case "turn_start":
				this.#queue(() => this.#emit({ type: "turn_start", turnIndex: this.#turn, timestamp: Date.now() }));
				break;
			case "message_start":
			case "message_end": {
				const m = event.message;
				const message = m.role === "user" ? { role: "user", content: m.content, timestamp: m.timestamp } : this.#assistant(m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), m.harness, m.model, m.timestamp);
				if (event.type === "message_end") {
					try {
						this.mirror.appendMessage(message as never);
					} catch {}
				}
				this.#queue(() => this.#emit({ type: event.type, message }));
				break;
			}
			case "entry_appended":
				if (event.item.kind === "custom" || event.item.kind === "note") this.#mirrorItem(event.item);
				break;
			case "tool_execution_start":
				this.#queue(() => this.#emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }));
				break;
			case "tool_execution_end":
				this.#queue(() => this.#emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: { content: event.result.content, details: {} }, isError: event.isError }));
				break;
			case "agent_end":
				this.#turn++;
				this.#queue(() => this.#emit({ type: "agent_end", messages: [] }));
				break;
			case "agent_settled":
				this.#abort = undefined;
				break;
			case "model_changed":
				this.#queue(async () => {
					const model = this.#model();
					if (model) await this.#emit({ type: "model_select", model, previousModel: undefined, source: "set" });
				});
				break;
			case "compaction_end":
				if (event.summary) this.#queue(() => this.#emit({ type: "session_compact", compactionEntry: { type: "compaction", summary: event.summary }, fromExtension: false }));
				break;
			case "session_changed":
				this.#queue(async () => {
					await this.#rebuildMirror();
					await this.#emit({ type: "session_start", reason: event.reason === "new" ? "new" : event.reason === "switch" ? "resume" : "fork" });
				});
				break;
		}
	}

	async #input(text: string, images: ImageInput[]): Promise<{ action: "continue" } | { action: "handled" } | { action: "transform"; text: string; images?: ImageInput[] }> {
		if (text.startsWith("/")) {
			const space = text.search(/\s/);
			const name = space < 0 ? text.slice(1) : text.slice(1, space);
			if (await this.runCommand(name, space < 0 ? "" : text.slice(space + 1).trim())) return { action: "handled" };
		}
		if (!this.runner.hasHandlers("input")) return { action: "continue" };
		const result = (await this.runner.emitInput(text, images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) as never, "interactive" as never)) as { action: string; text?: string; images?: { data: string; mimeType: string }[] };
		if (result.action === "handled") return { action: "handled" };
		if (result.action === "transform" && typeof result.text === "string") return { action: "transform", text: result.text, ...(result.images ? { images: result.images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}) };
		return { action: "continue" };
	}

	async #beforeTurn(text: string, images: ImageInput[]): Promise<void> {
		if (!this.runner.hasHandlers("before_agent_start")) return;
		const result = await this.runner.emitBeforeAgentStart({ messageType: "user", prompt: text, images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } as never, { forceSystemPrompt: "", cwd: this.session.cwd } as never);
		const added = (result?.systemPromptOptions as { forceSystemPrompt?: string } | undefined)?.forceSystemPrompt?.trim();
		this.session.extraInstructions = added || undefined;
		for (const message of result?.messages ?? []) {
			await this.session.addEntry("note", { customType: message.customType, content: textOf(message.content), display: message.display, details: message.details });
		}
	}

	commands(): { name: string; description?: string }[] {
		return this.runner.getRegisteredCommands().map((c) => ({ name: c.invocationName, ...(c.description ? { description: c.description } : {}) }));
	}

	async runCommand(name: string, args: string): Promise<boolean> {
		const command = this.runner.getCommand(name);
		if (!command) return false;
		try {
			await command.handler(args, this.runner.createCommandContext());
		} catch (error) {
			this.#report(`extension command /${name} failed: ${(error as Error).message}`);
		}
		return true;
	}

	async #startMcp(): Promise<void> {
		const server = createServer((request, response) => {
			if (request.headers.authorization !== `Bearer ${this.#token}`) {
				response.writeHead(401).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405, { Allow: "POST" }).end();
				return;
			}
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				void (async () => {
					let payload: unknown;
					try {
						payload = JSON.parse(body);
					} catch {
						response.writeHead(400).end();
						return;
					}
					const batch = Array.isArray(payload) ? payload : [payload];
					const replies = (await Promise.all(batch.map((message) => this.#rpc(message as Record<string, unknown>)))).filter((r) => r !== undefined);
					if (replies.length === 0) {
						response.writeHead(202).end();
						return;
					}
					response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
				})();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		server.unref();
		this.#server = server;
		const port = (server.address() as AddressInfo).port;
		this.#mcp = { type: "http", name: "pi-extensions", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${this.#token}` }] } as McpServer;
	}

	async #rpc(message: Record<string, unknown>): Promise<unknown> {
		const id = message.id;
		const reply = (result: unknown) => (id === undefined ? undefined : { jsonrpc: "2.0", id, result });
		const params = (message.params ?? {}) as Record<string, unknown>;
		switch (message.method) {
			case "initialize":
				return reply({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pid0-pi-extensions", version: VERSION } });
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: this.runner.getAllRegisteredTools().map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.parameters ?? { type: "object", properties: {} } })) });
			case "tools/call": {
				const tool = this.runner.getToolDefinition(String(params.name));
				if (!tool) return reply({ content: [{ type: "text", text: `unknown tool ${String(params.name)}` }], isError: true });
				const callId = `ext_${randomUUID()}`;
				try {
					const result = await tool.execute(callId, (params.arguments ?? {}) as never, this.#abort?.signal, undefined, this.runner.createToolContext(callId, this.#abort?.signal));
					const content = (result.content ?? []).map((c: { type: string; text?: string; data?: string; mimeType?: string }) => (c.type === "image" ? { type: "image", data: c.data, mimeType: c.mimeType } : { type: "text", text: c.text ?? "" }));
					return reply({ content, isError: false });
				} catch (error) {
					return reply({ content: [{ type: "text", text: (error as Error).message }], isError: true });
				}
			}
			default:
				return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
		}
	}

	get mcpUrl(): string | undefined {
		return (this.#mcp as { url?: string } | undefined)?.url;
	}

	get mcpToken(): string {
		return this.#token;
	}

	async dispose(): Promise<void> {
		await this.#line;
		await this.#emit({ type: "session_shutdown", reason: "quit" });
		this.runner.shutdown();
		this.#server?.close();
	}
}
