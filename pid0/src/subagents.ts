import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { canonicalHarness, harnessIds, harnessLabel, harnessStatus } from "./harnesses.ts";
import type { HostedTool } from "./mcp-host.ts";
import { Pid0Session } from "./session.ts";
import type { Item, SessionStore } from "./store.ts";
import { SubagentDoc, SubagentIndex, type SubagentState, TURN_OPTIONS, type TurnInput, type TurnResult } from "./subagent-task.ts";

const context = BACKGROUND_CONTEXT;

export type SubagentInfo = SubagentState & { conversation: number; activity: string[] };
export type SubagentEvent = { type: "subagent"; id: string; name: string; status: string; note?: string };

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function describe(item: Item): string | undefined {
	switch (item.kind) {
		case "user":
			return `→ ${clip(item.data.text, 160)}`;
		case "assistant":
			return item.data.text ? `← ${clip(item.data.text, 240)}` : undefined;
		case "tool":
			return `· ${clip(item.data.title, 100)} (${item.data.status})`;
		case "turn":
			return item.data.error ? `! ${clip(item.data.error, 200)}` : item.data.stopReason === "end_turn" ? undefined : `· turn ended: ${item.data.stopReason}`;
		default:
			return undefined;
	}
}

export class Subagents {
	readonly parent: Pid0Session;
	readonly #children = new Map<string, Pid0Session>();
	readonly #listeners = new Set<(event: SubagentEvent) => void>();
	readonly #waiters = new Map<string, number>();
	#closing = false;
	#own: unknown;
	#store: SessionStore;

	constructor(parent: Pid0Session) {
		this.parent = parent;
		this.#store = parent.store;
		this.#attach();
		parent.subscribe((event) => {
			if (event.type !== "session_changed" || parent.store === this.#store) return;
			void this.#detach().then(() => {
				this.#store = parent.store;
				this.#attach();
			});
		});
	}

	exclude(provider: unknown): void {
		this.#own = provider;
	}

	#inherit(child: Pid0Session): void {
		const parent = this.parent;
		child.permissions = parent.permissions;
		child.expand = parent.expand;
		child.baseInstructions = parent.baseInstructions;
		child.extraInstructions = parent.extraInstructions;
		child.mcpProviders.length = 0;
		child.mcpProviders.push(...parent.mcpProviders.filter((provider) => provider !== this.#own));
	}

	#attach(): void {
		const store = this.#store;
		if (store.readOnly) return;
		store.subagents.runner.run = (input, conversation, signal) => this.#runTurn(input, conversation, signal);
		void this.list().then((agents) => {
			if (agents.some((a) => a.task !== undefined)) store.harness.resume();
		});
	}

	async #detach(): Promise<void> {
		for (const child of this.#children.values()) await child.dispose().catch(() => {});
		this.#children.clear();
	}

	subscribe(listener: (event: SubagentEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(state: SubagentState, note?: string): void {
		for (const listener of [...this.#listeners]) listener({ type: "subagent", id: state.id, name: state.name, status: state.status, ...(note ? { note } : {}) });
	}

	async #index(): Promise<Record<string, number>> {
		return { ...(((await this.#store.harness.snapshot(SubagentIndex, context))?.agents ?? {}) as Record<string, number>) };
	}

	async #conversation(id: string): Promise<number> {
		const index = await this.#index();
		const exact = index[id];
		if (exact !== undefined) return exact;
		for (const [key, conversation] of Object.entries(index)) {
			const state = await this.#store.harness.snapshot(SubagentDoc, conversation as never, context);
			if (state?.name === id || key.startsWith(id)) return conversation;
		}
		throw new Error(`no subagent "${id}" (known: ${Object.keys(index).join(", ") || "none"})`);
	}

	async #state(conversation: number): Promise<SubagentState> {
		return structuredClone((await this.#store.harness.snapshot(SubagentDoc, conversation as never, context)) as SubagentState);
	}

	async #child(state: SubagentState, conversation: number): Promise<Pid0Session> {
		let child = this.#children.get(state.id);
		if (child) return child;
		const conv = await this.#store.harness.conversation(conversation as never, context);
		if (!conv) throw new Error(`subagent ${state.id} has no conversation`);
		const parent = this.parent;
		child = await Pid0Session.start({
			cwd: parent.cwd,
			root: parent.root,
			settings: parent.settings,
			store: this.#store.view(conv),
			harness: state.harness,
			...(state.model ? { model: state.model } : {}),
			...(state.thinking ? { thinking: state.thinking } : {}),
			permissions: parent.permissions,
			noMcp: parent.noMcp,
		});
		this.#inherit(child);
		child.onPermission = (request, harness) => (parent.onPermission ? parent.onPermission({ ...request, toolCall: { ...request.toolCall, title: `[subagent ${state.name}] ${request.toolCall.title ?? "a tool"}` } }, harness) : Promise.resolve({ outcome: { outcome: "cancelled" as const } }));
		this.#children.set(state.id, child);
		return child;
	}

	async #runTurn(input: TurnInput, conversation: number, signal: AbortSignal): Promise<TurnResult> {
		const state = await this.#state(conversation);
		const child = await this.#child(state, conversation);
		this.#inherit(child);
		let error: string | undefined;
		const stop = child.subscribe((event) => {
			if (event.type === "notice" && event.level === "error") error = event.text;
		});
		const onAbort = () => void child.abort();
		signal.addEventListener("abort", onAbort);
		try {
			if (signal.aborted) return { stopReason: "cancelled", answer: "" };
			await child.promptAndWait(input.message);
		} finally {
			signal.removeEventListener("abort", onAbort);
			stop();
		}
		const items = await child.messages();
		const turn = items.findLast((i) => i.kind === "turn");
		const lastUser = items.findLastIndex((i) => i.kind === "user");
		const answer = items.slice(lastUser + 1).flatMap((i) => (i.kind === "assistant" && i.data.text ? [i.data.text] : [])).join("\n\n");
		const stopReason = turn?.kind === "turn" ? turn.data.stopReason : "error";
		const result: TurnResult = { stopReason, answer, ...(error && stopReason === "error" ? { error } : {}) };
		queueMicrotask(() => void this.#afterTurn(conversation).catch(() => {}));
		return result;
	}

	async #afterTurn(conversation: number): Promise<void> {
		for (let i = 0; i < 40; i++) {
			const state = await this.#state(conversation);
			if (this.#closing) return;
			if (state.task === undefined || state.status !== "working") {
				this.#emit(state, state.status === "failed" ? state.error : state.lastAnswer ? clip(state.lastAnswer, 200) : undefined);
				if ((state.status === "idle" || state.status === "failed") && !this.#waiters.get(state.id)) {
					const body = state.status === "failed" ? `It failed: ${state.error ?? "unknown error"}` : (state.lastAnswer ?? "(no answer)");
					await this.parent.addEntry("note", { customType: "subagent", content: `Subagent ${state.name} (${state.id}) finished its work.\n\n${body.length > 6000 ? `${body.slice(0, 6000)}… (use subagent_status for the rest)` : body}`, display: true });
				}
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async dispatch(options: { prompt: string; harness?: string; model?: string; thinking?: string; name?: string }): Promise<SubagentInfo> {
		const settings = this.parent.settings;
		const harness = options.harness ? canonicalHarness(options.harness, settings) : this.parent.harness;
		if (!harness) throw new Error(`unknown harness "${options.harness}" (known: ${harnessIds(settings).join(", ")})`);
		if (!options.prompt?.trim()) throw new Error("a subagent needs a prompt");
		const id = `sub_${randomUUID().slice(0, 8)}`;
		const store = this.#store;
		const { Turn } = store.subagents;
		const now = Date.now();
		const taken = new Set<string>();
		for (const conversation of Object.values(await this.#index())) taken.add((await this.#state(conversation)).name);
		let name = (options.name ?? "").trim().replace(/\s+/g, "-") || `${harness}-${Object.keys(await this.#index()).length + 1}`;
		for (let n = 2; taken.has(name); n++) name = `${name.replace(/-\d+$/, "")}-${n}`;
		const parentConversation = store.branch;
		const conversation = await store.harness.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const doc = await tx.doc(SubagentDoc, created.id);
			Object.assign(doc, { id, name, harness, status: "working", queue: [], turns: 0, parent: parentConversation, created: now, updated: now, ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}) });
			doc.task = (await tx.createTask(Turn, { agent: id, message: options.prompt }, { ...TURN_OPTIONS, conversationId: created.id })) as unknown as number;
			(await tx.doc(SubagentIndex)).agents[id] = created.id as unknown as number;
			return created.id as unknown as number;
		}, context);
		store.harness.resume();
		const info = await this.#info(conversation);
		this.#emit(info, "started");
		return info;
	}

	async #info(conversation: number, activity = 8): Promise<SubagentInfo> {
		const state = await this.#state(conversation);
		const conv = await this.#store.harness.conversation(conversation as never, context);
		const items = conv ? await this.#store.view(conv).items() : [];
		return { ...state, conversation, activity: items.flatMap((item) => describe(item) ?? []).slice(-activity) };
	}

	async list(): Promise<SubagentInfo[]> {
		const out: SubagentInfo[] = [];
		for (const conversation of Object.values(await this.#index())) out.push(await this.#info(conversation));
		return out.sort((a, b) => a.created - b.created);
	}

	async status(id: string, activity = 12): Promise<SubagentInfo> {
		return this.#info(await this.#conversation(id), activity);
	}

	async conversations(): Promise<number[]> {
		return Object.values(await this.#index());
	}

	async #cancelTurn(conversation: number): Promise<void> {
		const task = (await this.#state(conversation)).task;
		if (task === undefined) return;
		await this.#store.harness.abortTask(task as never, context);
		await this.#store.harness.waitForTask(task as never, context).catch(() => {});
	}

	async #start(conversation: number, message: string): Promise<void> {
		const { Turn } = this.#store.subagents;
		await this.#store.harness.commit(async (tx) => {
			const doc = await tx.doc(SubagentDoc, conversation as never);
			doc.status = "working";
			doc.updated = Date.now();
			delete doc.interrupted;
			doc.task = (await tx.createTask(Turn, { agent: doc.id, message }, { ...TURN_OPTIONS, conversationId: conversation as never })) as unknown as number;
		}, context);
		this.#store.harness.resume();
	}

	async #edit(conversation: number, change: (doc: SubagentState) => void): Promise<void> {
		await this.#store.harness.commit(async (tx) => {
			const doc = await tx.doc(SubagentDoc, conversation as never);
			change(doc as SubagentState);
			doc.updated = Date.now();
		}, context);
	}

	async send(id: string, message: string, mode: "queue" | "steer" = "queue"): Promise<SubagentInfo> {
		const conversation = await this.#conversation(id);
		const state = await this.#state(conversation);
		if (state.status === "stopped") throw new Error(`subagent ${state.name} was stopped; dispatch a new one`);
		if (!message?.trim()) throw new Error("the message is empty");
		if (mode === "steer" && state.status === "working") {
			await this.#edit(conversation, (doc) => void (doc.status = "paused"));
			await this.#cancelTurn(conversation);
			await this.#start(conversation, message);
		} else if (state.status === "working" || state.status === "paused") {
			await this.#edit(conversation, (doc) => void (mode === "steer" ? doc.queue.unshift(message) : doc.queue.push(message)));
		} else await this.#start(conversation, message);
		const info = await this.#info(conversation);
		this.#emit(info, mode === "steer" ? "steered" : "message queued");
		return info;
	}

	async interrupt(id: string): Promise<SubagentInfo> {
		const conversation = await this.#conversation(id);
		const state = await this.#state(conversation);
		if (state.status === "working") {
			await this.#edit(conversation, (doc) => void (doc.status = "paused"));
			await this.#cancelTurn(conversation);
			const next = (await this.#state(conversation)).queue[0];
			if (next !== undefined) {
				await this.#edit(conversation, (doc) => void doc.queue.shift());
				await this.#start(conversation, next);
			} else
				await this.#edit(conversation, (doc) => {
					doc.status = "idle";
					delete doc.interrupted;
				});
		}
		const info = await this.#info(conversation);
		this.#emit(info, "interrupted");
		return info;
	}

	async pause(id: string): Promise<SubagentInfo> {
		const conversation = await this.#conversation(id);
		const state = await this.#state(conversation);
		if (state.status === "stopped") throw new Error(`subagent ${state.name} was stopped`);
		await this.#edit(conversation, (doc) => void (doc.status = "paused"));
		await this.#cancelTurn(conversation);
		const info = await this.#info(conversation);
		this.#emit(info, "paused");
		return info;
	}

	async resume(id: string): Promise<SubagentInfo> {
		const conversation = await this.#conversation(id);
		const state = await this.#state(conversation);
		if (state.status !== "paused") throw new Error(`subagent ${state.name} is ${state.status}, not paused`);
		const next = state.interrupted ? "Continue where you left off." : state.queue[0];
		if (next === undefined) await this.#edit(conversation, (doc) => void (doc.status = "idle"));
		else {
			if (!state.interrupted) await this.#edit(conversation, (doc) => void doc.queue.shift());
			await this.#start(conversation, next);
		}
		const info = await this.#info(conversation);
		this.#emit(info, "resumed");
		return info;
	}

	async stop(id: string): Promise<SubagentInfo> {
		const conversation = await this.#conversation(id);
		await this.#edit(conversation, (doc) => {
			doc.status = "stopped";
			doc.queue = [];
		});
		await this.#cancelTurn(conversation);
		const state = await this.#state(conversation);
		const child = this.#children.get(state.id);
		this.#children.delete(state.id);
		await child?.dispose().catch(() => {});
		const info = await this.#info(conversation);
		this.#emit(info, "stopped");
		return info;
	}

	async wait(id: string, timeoutMs = 600_000): Promise<SubagentInfo & { timedOut: boolean }> {
		const conversation = await this.#conversation(id);
		const key = (await this.#state(conversation)).id;
		const deadline = Date.now() + timeoutMs;
		this.#waiters.set(key, (this.#waiters.get(key) ?? 0) + 1);
		try {
			for (;;) {
				const state = await this.#state(conversation);
				if (state.status !== "working") return { ...(await this.#info(conversation)), timedOut: false };
				if (Date.now() >= deadline) return { ...(await this.#info(conversation)), timedOut: true };
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		} finally {
			setTimeout(() => this.#waiters.set(key, Math.max(0, (this.#waiters.get(key) ?? 1) - 1)), 2500).unref();
		}
	}

	async suspend(): Promise<void> {
		this.#closing = true;
		this.#store.subagents.runner.suspended = true;
		await Promise.all(
			[...this.#children.values()].map(async (child) => {
				if (!child.isStreaming) return;
				const settled = child.waitForSettled();
				await child.abort();
				await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5000))]);
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	async dispose(): Promise<void> {
		this.#closing = true;
		this.#store.subagents.runner.run = undefined;
		await this.#detach();
	}

	report(info: SubagentInfo, full = false): string {
		const lines = [
			`${info.name} (${info.id}): ${info.status}${info.queue.length ? `, ${info.queue.length} queued` : ""}`,
			`harness: ${harnessLabel(info.harness, this.parent.settings)}${info.model ? `, model: ${info.model}` : " (default model)"}; turns finished: ${info.turns}`,
		];
		if (info.error) lines.push(`error: ${info.error}`);
		if (info.activity.length) lines.push("recent activity:", ...info.activity.map((a) => `  ${a}`));
		if (info.lastAnswer && info.status !== "working") lines.push("last answer:", full ? info.lastAnswer : clip(info.lastAnswer, 1500));
		return lines.join("\n");
	}

	tools(): HostedTool[] {
		const text = (value: string) => ({ content: [{ type: "text", text: value }] });
		const str = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" && args[key] ? (args[key] as string) : undefined);
		const need = (args: Record<string, unknown>, key: string) => {
			const value = str(args, key);
			if (!value) throw new Error(`"${key}" is required`);
			return value;
		};
		const id = { type: "string", description: "The subagent's id or name, as returned by subagent_dispatch" };
		return [
			{
				name: "subagent_dispatch",
				description:
					"Start a subagent: a separate coding agent that works on its own task in this folder, in the background, while you continue. Give it a complete, self-contained prompt; it does not see this conversation. Returns at once with the subagent's id. Use subagent_wait to get its answer, or subagent_status to look in on it.",
				inputSchema: {
					type: "object",
					properties: {
						prompt: { type: "string", description: "The full task for the subagent" },
						harness: { type: "string", description: `Which agent runs it: ${harnessIds(this.parent.settings).join(", ")}. Default: the harness you are running in.` },
						model: { type: "string", description: "A model of that harness, by id or part of its name. Default: the harness's default model." },
						thinking: { type: "string", description: "A thinking / reasoning-effort level of that harness. Optional." },
						name: { type: "string", description: "A short name to refer to it by. Optional." },
					},
					required: ["prompt"],
				},
				call: async (args) => {
					const info = await this.dispatch({ prompt: need(args, "prompt"), ...(str(args, "harness") ? { harness: str(args, "harness")! } : {}), ...(str(args, "model") ? { model: str(args, "model")! } : {}), ...(str(args, "thinking") ? { thinking: str(args, "thinking")! } : {}), ...(str(args, "name") ? { name: str(args, "name")! } : {}) });
					return text(`Started subagent ${info.name} (id ${info.id}) on ${harnessLabel(info.harness, this.parent.settings)}${info.model ? ` with model ${info.model}` : ""}. It is working in the background.`);
				},
			},
			{
				name: "subagent_status",
				description: "Check on subagents: status (working, idle, paused, stopped, failed), recent activity, queued messages and the last answer. Without an id, lists all of them.",
				inputSchema: { type: "object", properties: { id } },
				call: async (args) => {
					const one = str(args, "id");
					if (one) return text(this.report(await this.status(one), true));
					const all = await this.list();
					return text(all.length ? all.map((info) => this.report(info)).join("\n\n") : "No subagents yet.");
				},
			},
			{
				name: "subagent_wait",
				description: "Wait until a subagent finishes its current work (or the timeout passes), then return its status and answer.",
				inputSchema: { type: "object", properties: { id, timeout_seconds: { type: "number", description: "How long to wait at most. Default 600." } }, required: ["id"] },
				call: async (args) => {
					const info = await this.wait(need(args, "id"), (typeof args.timeout_seconds === "number" ? args.timeout_seconds : 600) * 1000);
					return text(`${info.timedOut ? "Still working after the timeout.\n" : ""}${this.report(info, true)}`);
				},
			},
			{
				name: "subagent_send",
				description: 'Send a subagent another message. mode "queue" (default) delivers it after its current work and anything already queued; mode "steer" stops what it is doing now and has it act on this message next.',
				inputSchema: { type: "object", properties: { id, message: { type: "string" }, mode: { type: "string", enum: ["queue", "steer"] } }, required: ["id", "message"] },
				call: async (args) => text(this.report(await this.send(need(args, "id"), need(args, "message"), args.mode === "steer" ? "steer" : "queue"))),
			},
			{
				name: "subagent_interrupt",
				description: "Stop what a subagent is doing right now. It keeps its conversation; it goes on to its next queued message, or waits for one.",
				inputSchema: { type: "object", properties: { id }, required: ["id"] },
				call: async (args) => text(this.report(await this.interrupt(need(args, "id")))),
			},
			{
				name: "subagent_pause",
				description: "Pause a subagent: stop its current work and hold its queued messages until subagent_resume.",
				inputSchema: { type: "object", properties: { id }, required: ["id"] },
				call: async (args) => text(this.report(await this.pause(need(args, "id")))),
			},
			{
				name: "subagent_resume",
				description: "Resume a paused subagent: it continues the work that was interrupted, then its queued messages.",
				inputSchema: { type: "object", properties: { id }, required: ["id"] },
				call: async (args) => text(this.report(await this.resume(need(args, "id")))),
			},
			{
				name: "subagent_stop",
				description: "Stop a subagent for good and release its agent process. Its record stays readable with subagent_status.",
				inputSchema: { type: "object", properties: { id }, required: ["id"] },
				call: async (args) => text(this.report(await this.stop(need(args, "id")), true)),
			},
			{
				name: "subagent_harnesses",
				description: "List the harnesses a subagent can run on and whether each is installed.",
				inputSchema: { type: "object", properties: {} },
				call: async () => text(harnessStatus(this.parent.settings).map((h) => `${h.harness.id} (${h.harness.label}): ${h.available ? "available" : "not installed"}${h.harness.id === this.parent.harness ? " (current, the default)" : ""}`).join("\n")),
			},
		];
	}
}
