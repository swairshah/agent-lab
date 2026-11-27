import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NAME = process.env.FAKE_NAME ?? "fake";
const LEGACY = process.env.FAKE_LEGACY_MODELS === "1";
const CAPS = (process.env.FAKE_CAPS ?? "resume").split(",");
const STATE = process.env.FAKE_STATE;
const MODELS = (process.env.FAKE_MODELS ?? "alpha,beta,gamma-large").split(",");
const LEVELS = ["low", "medium", "high"];

type Session = { cwd: string; model: string; level: string; mode: string; prompts: string[]; cancelled: boolean; mcp: number; system?: string };
const sessions = new Map<string, Session>();

function loadState(): Record<string, Session> {
	if (!STATE || !existsSync(STATE)) return {};
	return JSON.parse(readFileSync(STATE, "utf8"));
}

function saveState(): void {
	if (STATE) writeFileSync(STATE, JSON.stringify(Object.fromEntries(sessions)));
}

for (const [id, s] of Object.entries(loadState())) sessions.set(id, s);

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method: string, params: unknown): Promise<any> {
	const id = nextId++;
	send({ jsonrpc: "2.0", id, method, params });
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function update(sessionId: string, update: unknown): void {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function text(sessionId: string, value: string): void {
	update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
}

function configOptions(s: Session): unknown[] {
	const options: unknown[] = [
		{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.level, options: LEVELS.map((value) => ({ value, name: value })) },
	];
	if (!LEGACY) {
		options.unshift({
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: s.model,
			options: MODELS.map((value) => ({ value, name: `${NAME} ${value}`, description: `the ${value} model` })),
		});
	}
	return options;
}

function sessionState(s: Session): Record<string, unknown> {
	return {
		configOptions: configOptions(s),
		modes: { currentModeId: s.mode, availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
		...(LEGACY ? { models: { currentModelId: s.model, availableModels: MODELS.map((modelId) => ({ modelId, name: `${NAME} ${modelId}` })) } } : {}),
	};
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function prompt(sessionId: string, s: Session, blocks: any[]): Promise<{ stopReason: string; usage?: unknown }> {
	const all = blocks.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : b.type === "resource_link" ? `[link ${b.uri}]` : "[block]")).join("\n");
	const hasContext = all.includes("<pid0-context");
	const rules = /<instructions>[\s\S]*?\n\n([\s\S]*?)\n<\/instructions>/.exec(all)?.[1];
	const body = all.replace(/<pid0-context[\s\S]*?<\/pid0-context>\s*/g, "").replace(/<instructions>[\s\S]*?<\/instructions>\s*/g, "").trim();
	s.prompts.push(body);
	s.cancelled = false;
	saveState();
	update(sessionId, { sessionUpdate: "usage_update", used: 1000 * s.prompts.length, size: 200000, cost: { amount: 0.01 * s.prompts.length, currency: "USD" } });
	const [verb, ...rest] = body.split(" ");
	const arg = rest.join(" ");
	if (verb === "slow") {
		for (let i = 0; i < 100 && !s.cancelled; i++) {
			text(sessionId, `tick${i} `);
			await sleep(30);
		}
		return { stopReason: s.cancelled ? "cancelled" : "end_turn" };
	}
	if (verb === "think") update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering deeply" } });
	if (verb === "plan") {
		update(sessionId, {
			sessionUpdate: "plan",
			entries: [
				{ content: "first step", priority: "high", status: "completed" },
				{ content: "second step", priority: "medium", status: "in_progress" },
			],
		});
	}
	if (verb === "read") {
		text(sessionId, "Reading. ");
		const toolCallId = `call_${randomUUID()}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Read ${arg}`, kind: "read", status: "pending", rawInput: { path: arg }, locations: [{ path: arg }] });
		try {
			const result = await request("fs/read_text_file", { sessionId, path: arg });
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: result.content } }], rawOutput: { bytes: result.content.length } });
			text(sessionId, `The file says: ${result.content.trim()}`);
		} catch (error: any) {
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: String(error?.message ?? error) } }] });
			text(sessionId, "Could not read it.");
		}
		return { stopReason: "end_turn" };
	}
	if (verb === "write") {
		const [path, ...content] = rest;
		const toolCallId = `call_${randomUUID()}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Write ${path}`, kind: "edit", status: "pending", rawInput: { path } });
		const answer = await request("session/request_permission", {
			sessionId,
			toolCall: { toolCallId, title: `Write ${path}`, kind: "edit" },
			options: [
				{ optionId: "yes", name: "Allow", kind: "allow_once" },
				{ optionId: "always", name: "Always allow", kind: "allow_always" },
				{ optionId: "no", name: "Reject", kind: "reject_once" },
			],
		});
		const chosen = answer.outcome?.outcome === "selected" ? answer.outcome.optionId : "cancelled";
		if (chosen === "yes" || chosen === "always") {
			await request("fs/write_text_file", { sessionId, path, content: content.join(" ") });
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "diff", path, oldText: null, newText: content.join(" ") }] });
			text(sessionId, `Wrote ${path} (${chosen}).`);
		} else {
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
			text(sessionId, `Not allowed (${chosen}).`);
		}
		return { stopReason: "end_turn" };
	}
	if (verb === "run") {
		const toolCallId = `call_${randomUUID()}`;
		const term = await request("terminal/create", { sessionId, command: arg });
		update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: arg, kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId: term.terminalId }] });
		const exit = await request("terminal/wait_for_exit", { sessionId, terminalId: term.terminalId });
		const out = await request("terminal/output", { sessionId, terminalId: term.terminalId });
		await request("terminal/release", { sessionId, terminalId: term.terminalId });
		update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: exit.exitCode === 0 ? "completed" : "failed", rawOutput: { exitCode: exit.exitCode } });
		text(sessionId, `exit ${exit.exitCode}: ${out.output.trim()}`);
		return { stopReason: "end_turn" };
	}
	if (verb === "fail") throw { code: -32603, message: "the fake agent failed on purpose" };
	text(sessionId, `[${NAME}/${s.model}/${s.level}/${s.mode}] `);
	await sleep(5);
	text(sessionId, `echo: ${body} (prompt ${s.prompts.length}, context ${hasContext ? "yes" : "no"}, mcp ${s.mcp}${s.system ? `, system ${s.system}` : ""}${rules ? `, rules ${rules}` : ""})`);
	return { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } };
}

async function handle(method: string, params: any): Promise<unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: 1,
				agentInfo: { name: NAME, version: "0.0.1" },
				agentCapabilities: {
					loadSession: CAPS.includes("load"),
					promptCapabilities: { image: true, embeddedContext: true },
					mcpCapabilities: { http: true },
					sessionCapabilities: { ...(CAPS.includes("resume") ? { resume: {} } : {}), ...(CAPS.includes("system") ? { systemPrompt: {} } : {}) },
				},
				authMethods: [{ id: "login", name: "Log in", description: `run ${NAME} login` }],
			};
		case "authenticate":
			return {};
		case "session/new": {
			if (process.env.FAKE_AUTH === "1") throw { code: -32000, message: "Authentication required" };
			const sessionId = `${NAME}-${randomUUID()}`;
			const system = params.systemPrompt?.content?.map((b: any) => b.text).join("");
			const s: Session = { cwd: params.cwd, model: MODELS[0]!, level: "medium", mode: "default", prompts: [], cancelled: false, mcp: params.mcpServers?.length ?? 0, ...(system ? { system } : {}) };
			sessions.set(sessionId, s);
			saveState();
			setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review the changes" }, { name: "compact", description: "Compact" }] }), 1);
			return { sessionId, ...sessionState(s) };
		}
		case "session/resume":
		case "session/load": {
			const s = sessions.get(params.sessionId);
			if (!s) throw { code: -32002, message: `Session not found: ${params.sessionId}` };
			if (method === "session/load") {
				for (const p of s.prompts) {
					update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: p } });
					text(params.sessionId, `replayed answer to ${p}`);
				}
			}
			return sessionState(s);
		}
		case "session/set_config_option": {
			const s = sessions.get(params.sessionId)!;
			if (params.configId === "model") {
				if (!MODELS.includes(params.value)) throw { code: -32602, message: `unknown model ${params.value}` };
				s.model = params.value;
			} else if (params.configId === "effort") s.level = params.value;
			else throw { code: -32602, message: `unknown option ${params.configId}` };
			saveState();
			return { configOptions: configOptions(s) };
		}
		case "session/set_model": {
			if (!LEGACY) throw { code: -32601, message: "Method not found" };
			const s = sessions.get(params.sessionId)!;
			s.model = params.modelId;
			saveState();
			return {};
		}
		case "session/set_mode": {
			const s = sessions.get(params.sessionId)!;
			s.mode = params.modeId;
			update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: s.mode });
			return {};
		}
		case "session/prompt": {
			const s = sessions.get(params.sessionId);
			if (!s) throw { code: -32002, message: "Session not found" };
			return prompt(params.sessionId, s, params.prompt);
		}
		default:
			throw { code: -32601, message: `Method not found: ${method}` };
	}
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	for (;;) {
		const end = buffer.indexOf("\n");
		if (end < 0) break;
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === undefined) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiter?.reject(message.error);
			else waiter?.resolve(message.result);
		} else if (message.id === undefined) {
			if (message.method === "session/cancel") {
				const s = sessions.get(message.params.sessionId);
				if (s) s.cancelled = true;
			}
		} else {
			handle(message.method, message.params).then(
				(result) => send({ jsonrpc: "2.0", id: message.id, result }),
				(error) => send({ jsonrpc: "2.0", id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } }),
			);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
