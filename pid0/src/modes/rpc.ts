import type { RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";
import { exportSession } from "../export.ts";
import { harnessStatus } from "../harnesses.ts";
import type { Pid0Session } from "../session.ts";
import { listSessions } from "../store.ts";
import type { Subagents } from "../subagents.ts";

export type Command = { id?: string; type: string; [key: string]: any };
export type RpcOptions = { subagents?: Subagents };
export const READ_ONLY_COMMANDS = new Set(["get_state", "get_messages", "get_entries", "get_harnesses", "get_available_models", "get_available_thinking_levels", "get_available_modes", "get_session_stats", "list_sessions", "get_fork_messages", "get_tree", "get_last_assistant_text", "get_commands", "get_subagents", "get_pending"]);

export function createRpc(session: Pid0Session, send: (record: unknown) => void, options: RpcOptions = {}) {
	const permissions = new Map<string, (response: RequestPermissionResponse) => void>();
	let permissionSeq = 0;
	const open = new Map<string, unknown>();
	session.onPermission = (request, harness) =>
		new Promise((resolve) => {
			const id = `perm-${++permissionSeq}`;
			const record = { type: "permission_request", id, harness, toolCall: request.toolCall, options: request.options };
			open.set(id, record);
			permissions.set(id, (response) => {
				open.delete(id);
				send({ type: "permission_resolved", id });
				resolve(response);
			});
			send(record);
		});

	const handlers: Record<string, (c: Command) => Promise<unknown> | unknown> = {
		prompt: async (c) => {
			if (session.isStreaming && !c.streamingBehavior) throw new Error("the agent is working; set streamingBehavior to \"steer\" or \"followUp\" to queue the message");
			return { disposition: await session.prompt(String(c.message ?? ""), { ...(c.images ? { images: c.images } : {}) }) };
		},
		steer: async (c) => ({ disposition: await session.prompt(String(c.message ?? ""), { ...(c.images ? { images: c.images } : {}), behavior: "steer" }) }),
		follow_up: async (c) => ({ disposition: await session.prompt(String(c.message ?? ""), { ...(c.images ? { images: c.images } : {}), behavior: "followUp" }) }),
		abort: () => session.abort(),
		clear_queue: () => ({ followUp: session.takeQueue(), steering: [] }),
		new_session: async () => {
			await session.newSession();
			return { cancelled: false };
		},
		get_state: () => {
			const s = session.state;
			return { ...s, model: s.model ? { harness: s.harness, id: s.model, name: s.modelName } : undefined, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: false };
		},
		get_messages: async () => ({ messages: await session.messages() }),
		get_entries: async () => ({ entries: await session.messages() }),
		get_harnesses: () => ({ harnesses: harnessStatus(session.settings).map((h) => ({ id: h.harness.id, label: h.harness.label, available: h.available, command: h.harness.command })) }),
		set_harness: async (c) => {
			await session.setHarness(String(c.harness));
			return { harness: session.harness };
		},
		set_model: async (c) => session.setModel(c.harness ?? c.provider ? `${c.harness ?? c.provider}/${c.modelId ?? ""}` : String(c.modelId ?? c.model)),
		cycle_model: async () => (await session.cycleModel()) ?? null,
		get_available_models: async (c) => ({
			models: (await session.availableModels(c.harnesses ?? [session.harness])).flatMap((h) => h.models.map((m) => ({ harness: h.harness, id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}), current: m.id === h.current }))),
		}),
		set_thinking_level: async (c) => ({ level: await session.setThinking(String(c.level)) }),
		cycle_thinking_level: async () => {
			const level = await session.cycleThinking();
			return level ? { level } : null;
		},
		get_available_thinking_levels: async () => ({ levels: (await session.connect()).thinking.map((t) => t.id) }),
		get_available_modes: async () => ({ modes: (await session.connect()).modes, current: session.native?.currentMode }),
		set_mode: async (c) => ({ mode: await session.setMode(String(c.mode)) }),
		compact: async (c) => ({ summary: await session.compact(c.customInstructions) }),
		bash: async (c) => session.shell(String(c.command), Boolean(c.excludeFromContext)),
		get_session_stats: async () => {
			const items = await session.messages();
			const count = (kind: string) => items.filter((i) => i.kind === kind).length;
			return { sessionFile: session.store.file, sessionId: session.store.id, userMessages: count("user"), assistantMessages: count("assistant"), toolCalls: count("tool"), totalMessages: session.store.meta.messages, tokens: session.totals, cost: session.state.cost, context: session.state.context };
		},
		export_html: async (c) => ({ path: exportSession(session.store.meta, await session.messages(), (h) => session.label(h), c.outputPath ?? `pid0-session-${session.store.id}.html`) }),
		list_sessions: async (c) => ({ sessions: await listSessions(session.root, c.all ? undefined : session.cwd) }),
		switch_session: async (c) => {
			await session.switchSession(String(c.sessionPath));
			return { cancelled: false };
		},
		fork: async (c) => {
			const items = await session.messages();
			const index = items.findIndex((i) => i.id === Number(c.entryId));
			if (index < 0 || items[index]!.kind !== "user") throw new Error(`entry ${c.entryId} is not a user message of this session`);
			const text = (items[index] as { data: { text: string } }).data.text;
			await session.clone(index === 0 ? "empty" : items[index - 1]!.id);
			return { text, cancelled: false };
		},
		clone: async () => ({ sessionFile: await session.clone(), cancelled: false }),
		navigate_tree: async (c) => {
			await session.navigate(c.entryId === undefined || c.entryId === null ? undefined : Number(c.entryId));
			return { cancelled: false };
		},
		get_fork_messages: async () => ({ messages: (await session.messages()).flatMap((i) => (i.kind === "user" ? [{ entryId: i.id, text: i.data.text }] : [])) }),
		get_tree: async () => session.store.tree(),
		get_last_assistant_text: async () => ({ text: (await session.lastAssistantText()) ?? null }),
		set_session_name: async (c) => session.setName(String(c.name ?? "").trim() || undefined),
		get_commands: async () => ({ commands: (session.native?.commands ?? []).map((cmd) => ({ name: cmd.name, description: cmd.description, source: session.harness })) }),
		get_subagents: async () => ({ subagents: options.subagents ? await options.subagents.list() : [] }),
		subagent: async (c) => {
			const subagents = options.subagents;
			if (!subagents) throw new Error("subagents are off");
			const id = String(c.id_or_name ?? c.name ?? "");
			if (c.action === "stop") return subagents.stop(id);
			if (c.action === "pause") return subagents.pause(id);
			if (c.action === "resume") return subagents.resume(id);
			if (c.action === "interrupt") return subagents.interrupt(id);
			if (c.action === "send") return subagents.send(id, String(c.message ?? ""), c.mode === "steer" ? "steer" : "queue");
			if (c.action === "dispatch") return subagents.dispatch({ prompt: String(c.prompt ?? ""), ...(c.harness ? { harness: String(c.harness) } : {}), ...(c.model ? { model: String(c.model) } : {}), ...(c.name ? { name: String(c.name) } : {}) });
			return subagents.status(id);
		},
		set_permissions: (c) => {
			if (c.policy !== "ask" && c.policy !== "allow" && c.policy !== "deny") throw new Error("policy is ask, allow or deny");
			session.permissions = c.policy;
			return { policy: session.permissions };
		},
		permission_response: (c) => {
			const resolve = permissions.get(String(c.id));
			if (!resolve) throw new Error(`no pending permission request ${c.id}`);
			permissions.delete(String(c.id));
			resolve(c.optionId ? { outcome: { outcome: "selected", optionId: String(c.optionId) } } : { outcome: { outcome: "cancelled" } });
		},
	};

	handlers.get_pending = () => ({ permissions: [...open.values()], queued: session.queued });

	const run = async (command: Command): Promise<Record<string, unknown> | undefined> => {
		const handler = handlers[command.type];
		const head = { ...(command.id !== undefined ? { id: command.id } : {}), type: "response", command: command.type };
		if (!handler) return { ...head, success: false, error: `Unknown command: ${command.type}` };
		try {
			const data = await handler(command);
			return { ...head, success: true, ...(data !== undefined && data !== null ? { data } : {}) };
		} catch (error) {
			return { ...head, success: false, error: (error as Error).message };
		}
	};
	return { run };
}

export async function runRpc(session: Pid0Session, options: RpcOptions = {}): Promise<number> {
	let pending: Promise<void> = Promise.resolve();
	const send = (record: unknown) => {
		pending = pending.then(
			() =>
				new Promise<void>((resolve) => {
					if (process.stdout.write(`${JSON.stringify(record)}\n`)) resolve();
					else process.stdout.once("drain", resolve);
				}),
		);
	};
	session.subscribe(send);
	const rpc = createRpc(session, send, options);
	const handle = async (line: string) => {
		let command: Command;
		try {
			command = JSON.parse(line);
		} catch (error) {
			send({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${(error as Error).message}` });
			return;
		}
		const response = await rpc.run(command);
		if (response && !(command.type === "permission_response" && response.success)) send(response);
	};

	await new Promise<void>((resolve) => {
		let buffer = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const line = buffer.slice(0, end).replace(/\r$/, "");
				buffer = buffer.slice(end + 1);
				if (line.trim()) void handle(line);
			}
		});
		process.stdin.on("end", resolve);
		process.once("SIGTERM", resolve);
		process.once("SIGHUP", resolve);
	});
	if (session.isStreaming) await session.waitForSettled();
	await pending;
	return 0;
}
