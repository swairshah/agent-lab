// Turns that run in someone's own pi (the syncpi pi extension, after /sync in pi). That pi runs the agent, with its
// own model, tools and extensions, and records each message into the shared thread (Session.record). One agent works
// on the thread at a time:
//   - A pi asks for the turn. The server's agent is stopped first when its run may be stopped by that person (their
//     own, or anyone's for an admin), and otherwise finishes first, with whatever is queued behind it.
//   - While a pi has the turn, the server's agent doesn't start: other people's messages wait for the turn to end,
//     steer the pi's run, or stop it (when they may), as they would the server's run.
//   - Everyone watching sees the pi's run live: its partial answer and its tools' output, sent by the pi.
import { randomUUID } from "node:crypto";
import type { AgentEvent, TaskId } from "@earendil-works/pi-durable";
import type { LiveEvent, ServerMessage } from "../shared/protocol.ts";

/** One pi's connection. */
export type TurnClient = { memberId: string; name: string; send(message: ServerMessage): void };

/** What the turns need from the room and the session. */
export type TurnHost = {
	/** The server agent's current run on the thread, and whose it is. */
	current(): Promise<{ taskId: TaskId; memberId?: string } | undefined>;
	/** Stops a run of the server's agent and resolves once it has ended. */
	interrupt(taskId: TaskId): Promise<void>;
	/** The server's agent has nothing running or queued on the thread. */
	idle(): Promise<boolean>;
	/** The thread's newest entry. */
	lastEntry(): Promise<number>;
	/** Whether `memberId` may stop a run of `owner`'s. */
	mayStop(memberId: string, owner: string | undefined): boolean;
	/** Agent events for everyone watching the thread. */
	events(events: AgentEvent[]): void;
	/** Where the thread's turn runs now: `label`, or back to the server's own (undefined). */
	target(label: string | undefined): void;
};

type Holder = {
	client: TurnClient;
	/** The partial answer, and the tools running, for someone who starts watching mid-turn. */
	message?: unknown;
	tools: Map<string, { toolName: string; args: unknown; output: string }>;
	/** Tools whose results are recorded: live events about them come late, and are left out. */
	finished: Set<string>;
	/** Steers passed to this pi and not recorded yet, by id: who wrote them. */
	steers: Map<string, string>;
};

/** How often a pi waiting for the turn checks whether the server's agent is done. */
const POLL_MS = 150;

export class PiTurns {
	readonly #host: TurnHost;
	#holder: Holder | undefined;
	#asking: { client: TurnClient; requestId: string }[] = [];
	/** Other people's messages for the thread, waiting for the pi's turn to end, in order. */
	#held: { requestId: string; run: () => Promise<void> }[] = [];
	#granting = false;

	constructor(host: TurnHost) {
		this.#host = host;
	}

	/** Whose pi has the turn. */
	get holder(): TurnClient | undefined {
		return this.#holder?.client;
	}

	/** A pi asks for the turn; it's answered with "turn" once it has it. */
	ask(client: TurnClient, requestId: string): void {
		client.send({ type: "turn", requestId });
		if (this.#holder?.client === client) {
			void this.#grant(client, requestId);
			return;
		}
		this.#asking = this.#asking.filter((a) => a.client !== client);
		this.#asking.push({ client, requestId });
		void this.#next();
	}

	async #next(): Promise<void> {
		if (this.#granting) return;
		this.#granting = true;
		try {
			while (this.#holder === undefined && this.#asking.length > 0) {
				const asking = this.#asking[0]!;
				const current = await this.#host.current();
				if (current !== undefined && this.#host.mayStop(asking.client.memberId, current.memberId)) await this.#host.interrupt(current.taskId);
				while (!(await this.#host.idle()) && this.#asking[0] === asking) await new Promise((r) => setTimeout(r, POLL_MS));
				if (this.#asking[0] !== asking || this.#holder !== undefined) continue;
				this.#asking.shift();
				this.#holder = { client: asking.client, tools: new Map(), finished: new Set(), steers: new Map() };
				this.#host.events([{ type: "run_start" } as AgentEvent]);
				this.#host.target(`${asking.client.name}'s pi`);
				await this.#grant(asking.client, asking.requestId);
			}
		} finally {
			this.#granting = false;
		}
	}

	async #grant(client: TurnClient, requestId: string): Promise<void> {
		client.send({ type: "turn", requestId, upTo: await this.#host.lastEntry() });
	}

	/** The pi gives the turn back (or left): the messages that waited for it go to the server's agent, in order. */
	async end(client: TurnClient): Promise<void> {
		if (this.#holder?.client !== client) return;
		this.#holder = undefined;
		this.#host.events([{ type: "run_end" } as AgentEvent]);
		this.#host.target(undefined);
		for (const held of this.#held.splice(0)) await held.run().catch(() => {});
		void this.#next();
	}

	/** A pi's connection closed. */
	async left(client: TurnClient): Promise<void> {
		this.#asking = this.#asking.filter((a) => a.client !== client);
		await this.end(client);
	}

	/** What the pi that has the turn is doing, for everyone watching. */
	live(client: TurnClient, events: LiveEvent[]): void {
		const holder = this.#holder;
		if (holder?.client !== client || !Array.isArray(events)) return;
		const out: AgentEvent[] = [];
		for (const event of events.slice(0, 100)) {
			if (event.type === "message_update") {
				holder.message = event.message;
				out.push({ type: "message_update", changes: [{ type: "message", message: event.message }] } as unknown as AgentEvent);
			} else if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && !holder.finished.has(event.toolCallId)) {
				holder.message = undefined;
				holder.tools.set(event.toolCallId, { toolName: String(event.toolName), args: event.args ?? {}, output: "" });
				out.push({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: String(event.toolName), args: event.args ?? {} } as AgentEvent);
			} else if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
				const tool = holder.tools.get(event.toolCallId);
				if (tool === undefined) continue;
				tool.output = String(event.output).slice(-64 * 1024);
				out.push({ type: "tool_execution_update", toolCallId: event.toolCallId, output: { set: tool.output } } as unknown as AgentEvent);
			}
		}
		if (out.length > 0) this.#host.events(out);
	}

	/** What someone who starts watching mid-turn needs to see it running. */
	replay(): AgentEvent[] {
		const holder = this.#holder;
		if (holder === undefined) return [];
		const out = [{ type: "run_start" } as AgentEvent];
		for (const [toolCallId, tool] of holder.tools) {
			out.push({ type: "tool_execution_start", toolCallId, toolName: tool.toolName, args: tool.args } as AgentEvent);
			if (tool.output) out.push({ type: "tool_execution_update", toolCallId, output: { set: tool.output } } as unknown as AgentEvent);
		}
		if (holder.message !== undefined) out.push({ type: "message_update", changes: [{ type: "message", message: holder.message }] } as unknown as AgentEvent);
		return out;
	}

	/** The pi recorded its messages up to here: finished tools no longer need replaying. */
	recorded(client: TurnClient, toolCallIds: string[]): void {
		if (this.#holder?.client !== client) return;
		for (const id of toolCallIds) {
			this.#holder.tools.delete(id);
			this.#holder.finished.add(id);
		}
	}

	/** Who wrote the steer `id` that was passed to `client`'s pi, if it was. */
	steerer(client: TurnClient, id: string): string | undefined {
		if (this.#holder?.client !== client) return undefined;
		const memberId = this.#holder.steers.get(id);
		this.#holder.steers.delete(id);
		return memberId;
	}

	/** While a pi has the turn, someone's message waits for it to end. False when no pi has the turn. */
	hold(requestId: string, run: () => Promise<void>): boolean {
		if (this.#holder === undefined) return false;
		// A message sent again (after a reconnect) waits once.
		if (!this.#held.some((h) => h.requestId === requestId)) this.#held.push({ requestId, run });
		return true;
	}

	/** Someone steers the pi's run: it's passed to the pi, which adds it at its next step. */
	steer(memberId: string, name: string, text: string): boolean {
		const holder = this.#holder;
		if (holder === undefined) return false;
		const id = randomUUID();
		holder.steers.set(id, memberId);
		holder.client.send({ type: "piControl", action: "steer", by: name, id, text: `[${name}, steering] ${text}` });
		return true;
	}

	/** Someone stops the pi's run. */
	stop(name: string): boolean {
		if (this.#holder === undefined) return false;
		this.#holder.client.send({ type: "piControl", action: "stop", by: name });
		return true;
	}
}
