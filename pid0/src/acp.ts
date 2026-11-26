import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type AgentCapabilities,
	type AuthMethod,
	type AvailableCommand,
	type ClientConnection,
	type ContentBlock,
	client,
	type McpServer,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";
import { VERSION } from "./config.ts";
import type { ResolvedHarness } from "./harnesses.ts";
import { Terminals } from "./terminals.ts";

export type Choice = { id: string; name: string; description?: string };

export type NativeState = {
	sessionId: string;
	models: Choice[];
	currentModel?: string;
	modelVia?: { kind: "config"; configId: string } | { kind: "legacy" };
	thinking: Choice[];
	currentThinking?: string;
	thinkingConfigId?: string;
	modes: Choice[];
	currentMode?: string;
	modeVia?: { kind: "config"; configId: string } | { kind: "modes" };
	configOptions: SessionConfigOption[];
	commands: AvailableCommand[];
	resumed: boolean;
};

export type SessionOptions = {
	cwd: string;
	mcpServers: McpServer[];
	systemPrompt?: string;
};

export type AcpHost = {
	permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
	log?(line: string): void;
};

export class AgentExited extends Error {}

export class AuthRequired extends Error {
	readonly methods: AuthMethod[];
	constructor(harness: ResolvedHarness, methods: AuthMethod[], cause: string) {
		const how = methods.map((m) => `  ${m.id}: ${m.name}${m.description ? ` (${m.description})` : ""}`).join("\n");
		super(`${harness.label} needs you to sign in: ${cause}\n${harness.auth}${how ? `\nSign-in methods it offers (pid0 auth login ${harness.id} [method]):\n${how}` : ""}`);
		this.methods = methods;
	}
}

function flattenOptions(option: SessionConfigOption): Choice[] {
	if (option.type !== "select") return [];
	const out: Choice[] = [];
	for (const item of option.options as unknown[]) {
		const o = item as { value?: string; name: string; description?: string | null; options?: { value: string; name: string; description?: string | null }[] };
		if (Array.isArray(o.options)) for (const sub of o.options) out.push({ id: sub.value, name: sub.name, ...(sub.description ? { description: sub.description } : {}) });
		else if (o.value !== undefined) out.push({ id: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) });
	}
	return out;
}

type LegacyModels = { currentModelId?: string; availableModels?: { modelId: string; name?: string; description?: string | null }[] };

export function readNativeState(sessionId: string, response: Record<string, unknown>, previous?: NativeState): NativeState {
	const state: NativeState = { sessionId, models: [], thinking: [], modes: [], configOptions: [], commands: previous?.commands ?? [], resumed: previous?.resumed ?? false };
	applyConfigOptions(state, (response.configOptions as SessionConfigOption[] | null | undefined) ?? []);
	const legacy = response.models as LegacyModels | null | undefined;
	if (state.modelVia === undefined && legacy?.availableModels?.length) {
		state.models = legacy.availableModels.map((m) => ({ id: m.modelId, name: m.name ?? m.modelId, ...(m.description ? { description: m.description } : {}) }));
		if (legacy.currentModelId !== undefined) state.currentModel = legacy.currentModelId;
		state.modelVia = { kind: "legacy" };
	}
	const modes = response.modes as { currentModeId: string; availableModes: { id: string; name: string; description?: string | null }[] } | null | undefined;
	if (modes?.availableModes?.length) {
		state.modes = modes.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
		state.currentMode = modes.currentModeId;
		state.modeVia = { kind: "modes" };
	}
	return state;
}

export function applyConfigOptions(state: NativeState, options: SessionConfigOption[]): void {
	state.configOptions = options;
	for (const option of options) {
		if (option.type !== "select") continue;
		if (option.category === "model") {
			state.models = flattenOptions(option);
			state.currentModel = option.currentValue;
			state.modelVia = { kind: "config", configId: option.id };
		} else if (option.category === "thought_level") {
			state.thinking = flattenOptions(option);
			state.currentThinking = option.currentValue;
			state.thinkingConfigId = option.id;
		} else if (option.category === "mode" && state.modeVia?.kind !== "modes") {
			state.modes = flattenOptions(option);
			state.currentMode = option.currentValue;
			state.modeVia = { kind: "config", configId: option.id };
		}
	}
}

export class AcpAgent {
	readonly harness: ResolvedHarness;
	readonly cwd: string;
	capabilities: AgentCapabilities = {};
	authMethods: AuthMethod[] = [];
	info: { name: string; version?: string } = { name: "" };
	state: NativeState | undefined;
	onUpdate: ((update: SessionUpdate) => void) | undefined;
	onExit: ((error: Error) => void) | undefined;

	readonly #child: ChildProcess;
	readonly #connection: ClientConnection;
	readonly #host: AcpHost;
	readonly #terminals: Terminals;
	readonly #stderr: string[] = [];
	#exited: Error | undefined;
	#muted = false;

	private constructor(harness: ResolvedHarness, cwd: string, host: AcpHost) {
		this.harness = harness;
		this.cwd = cwd;
		this.#host = host;
		this.#terminals = new Terminals(cwd);
		const [command, ...args] = harness.command;
		this.#child = spawn(command!, args, { cwd, env: { ...process.env, ...harness.env }, stdio: ["pipe", "pipe", "pipe"] });
		this.#child.stderr!.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				this.#stderr.push(line);
				if (this.#stderr.length > 200) this.#stderr.shift();
				host.log?.(`[${harness.id}] ${line}`);
			}
		});
		const exited = new Promise<never>((_, reject) => {
			this.#child.on("error", (error: NodeJS.ErrnoException) => {
				const missing = error.code === "ENOENT";
				this.#exited = new AgentExited(missing ? `${harness.label}: cannot run \`${harness.command.join(" ")}\` (${command} was not found). ${harness.install}` : `${harness.label}: ${error.message}`);
				reject(this.#exited);
			});
			this.#child.on("exit", (code, signal) => {
				this.#exited ??= new AgentExited(`${harness.label} exited (${signal ?? `code ${code}`})${this.#stderr.length ? `:\n${this.#stderr.slice(-12).join("\n")}` : ""}`);
				reject(this.#exited);
				this.onExit?.(this.#exited);
			});
		});
		exited.catch(() => {});
		this.#exitedPromise = exited;
		this.#child.stdin!.on("error", () => {});

		const app = client({ name: "pid0" })
			.onNotification(methods.client.session.update, ({ params }) => this.#update(params.sessionId, params.update))
			.onNotification("*", () => {})
			.onRequest(methods.client.session.requestPermission, ({ params }) => this.#host.permission(params))
			.onRequest(methods.client.fs.readTextFile, ({ params }) => {
				const text = readFileSync(this.#path(params.path), "utf8");
				if (params.line == null && params.limit == null) return { content: text };
				const lines = text.split("\n");
				const start = Math.max(0, (params.line ?? 1) - 1);
				return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join("\n") };
			})
			.onRequest(methods.client.fs.writeTextFile, ({ params }) => {
				const path = this.#path(params.path);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, params.content);
				return {};
			})
			.onRequest(methods.client.terminal.create, ({ params }) => ({ terminalId: this.#terminals.create(params) }))
			.onRequest(methods.client.terminal.output, ({ params }) => this.#terminals.output(params.terminalId))
			.onRequest(methods.client.terminal.waitForExit, ({ params }) => this.#terminals.waitForExit(params.terminalId))
			.onRequest(methods.client.terminal.kill, ({ params }) => {
				this.#terminals.kill(params.terminalId);
				return {};
			})
			.onRequest(methods.client.terminal.release, ({ params }) => {
				this.#terminals.release(params.terminalId);
				return {};
			});
		this.#connection = app.connect(ndJsonStream(Writable.toWeb(this.#child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.#child.stdout!) as ReadableStream<Uint8Array>));
		this.#connection.closed.catch(() => {});
	}

	readonly #exitedPromise: Promise<never>;

	static async start(harness: ResolvedHarness, cwd: string, host: AcpHost): Promise<AcpAgent> {
		const agent = new AcpAgent(harness, cwd, host);
		try {
			const init = await agent.#call<Record<string, any>>(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientInfo: { name: "pid0", title: "pid0", version: VERSION },
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } },
			});
			agent.capabilities = init.agentCapabilities ?? {};
			agent.authMethods = init.authMethods ?? [];
			agent.info = { name: init.agentInfo?.title ?? init.agentInfo?.name ?? harness.label, ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}) };
			return agent;
		} catch (error) {
			agent.close();
			throw error;
		}
	}

	get alive(): boolean {
		return this.#exited === undefined;
	}

	terminalOutput(id: string): string | undefined {
		return this.#terminals.peek(id);
	}

	#path(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}

	#call<T>(method: string, params: unknown): Promise<T> {
		if (this.#exited) return Promise.reject(this.#exited);
		return Promise.race([this.#connection.agent.request<T>(method, params), this.#exitedPromise]);
	}

	#update(sessionId: string, update: SessionUpdate): void {
		const state = this.state;
		if (!state || sessionId !== state.sessionId) return;
		switch (update.sessionUpdate) {
			case "available_commands_update":
				state.commands = update.availableCommands;
				break;
			case "current_mode_update":
				state.currentMode = update.currentModeId;
				break;
			case "config_option_update":
				applyConfigOptions(state, update.configOptions);
				break;
		}
		if (!this.#muted) this.onUpdate?.(update);
	}

	#sessionParams(options: SessionOptions): Record<string, unknown> {
		const mcp = this.capabilities.mcpCapabilities;
		const mcpServers = options.mcpServers.filter((s) => !("type" in s) || (s.type === "http" && mcp?.http) || (s.type === "sse" && mcp?.sse));
		return {
			cwd: options.cwd,
			mcpServers,
			...(options.systemPrompt && this.capabilities.sessionCapabilities?.systemPrompt ? { systemPrompt: { mode: "append", content: [{ type: "text", text: options.systemPrompt }] } } : {}),
		};
	}

	get supportsSystemPrompt(): boolean {
		return Boolean(this.capabilities.sessionCapabilities?.systemPrompt);
	}

	async newSession(options: SessionOptions): Promise<NativeState> {
		let response: Record<string, unknown>;
		try {
			response = await this.#call(methods.agent.session.new, this.#sessionParams(options));
		} catch (error) {
			if ((error as { code?: number }).code === -32000) throw new AuthRequired(this.harness, this.authMethods, (error as Error).message);
			throw error;
		}
		this.state = readNativeState(response.sessionId as string, response);
		return this.state;
	}

	async resumeSession(sessionId: string, options: SessionOptions): Promise<NativeState | undefined> {
		const canResume = Boolean(this.capabilities.sessionCapabilities?.resume);
		if (!canResume && !this.capabilities.loadSession) return undefined;
		const params = { ...this.#sessionParams(options), sessionId };
		this.state = readNativeState(sessionId, {});
		this.#muted = true;
		try {
			const response = await this.#call<Record<string, unknown> | null>(canResume ? methods.agent.session.resume : methods.agent.session.load, params);
			this.state = readNativeState(sessionId, response ?? {}, this.state);
			this.state.resumed = true;
			return this.state;
		} catch (error) {
			this.state = undefined;
			if (error instanceof AgentExited) throw error;
			return undefined;
		} finally {
			this.#muted = false;
		}
	}

	prompt(prompt: ContentBlock[]): Promise<PromptResponse> {
		return this.#call(methods.agent.session.prompt, { sessionId: this.#session().sessionId, prompt });
	}

	async cancel(): Promise<void> {
		if (!this.state || this.#exited) return;
		await this.#connection.agent.notify(methods.agent.session.cancel, { sessionId: this.state.sessionId }).catch(() => {});
	}

	#session(): NativeState {
		if (!this.state) throw new Error(`${this.harness.label} has no session yet`);
		return this.state;
	}

	async setConfigOption(configId: string, value: string | boolean): Promise<void> {
		const state = this.#session();
		const response = await this.#call<{ configOptions?: SessionConfigOption[] }>(methods.agent.session.setConfigOption, {
			sessionId: state.sessionId,
			configId,
			...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
		});
		if (response?.configOptions) applyConfigOptions(state, response.configOptions);
	}

	async setModel(id: string): Promise<void> {
		const state = this.#session();
		if (state.modelVia?.kind === "config") await this.setConfigOption(state.modelVia.configId, id);
		else if (state.modelVia?.kind === "legacy") {
			await this.#call("session/set_model", { sessionId: state.sessionId, modelId: id });
			state.currentModel = id;
		} else throw new Error(`${this.harness.label} does not offer a model choice over ACP`);
	}

	async setThinking(id: string): Promise<void> {
		const state = this.#session();
		if (!state.thinkingConfigId) throw new Error(`${this.harness.label} does not offer thinking levels over ACP`);
		await this.setConfigOption(state.thinkingConfigId, id);
	}

	async setMode(id: string): Promise<void> {
		const state = this.#session();
		if (state.modeVia?.kind === "modes") {
			await this.#call(methods.agent.session.setMode, { sessionId: state.sessionId, modeId: id });
			state.currentMode = id;
		} else if (state.modeVia?.kind === "config") await this.setConfigOption(state.modeVia.configId, id);
		else throw new Error(`${this.harness.label} does not offer modes over ACP`);
	}

	async authenticate(methodId: string): Promise<void> {
		await this.#call(methods.agent.authenticate, { methodId });
	}

	close(): void {
		this.#terminals.dispose();
		this.#exited ??= new AgentExited(`${this.harness.label} was closed`);
		this.onExit = undefined;
		try {
			this.#child.stdin?.end();
		} catch {}
		const child = this.#child;
		if (child.exitCode === null && child.signalCode === null) {
			const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
			child.kill("SIGTERM");
		}
	}
}
