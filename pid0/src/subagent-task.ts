import { defineDoc, defineExtension, defineTask, type Task } from "@earendil-works/pi-durable";

export type SubagentStatus = "working" | "idle" | "paused" | "stopped" | "failed";

export type SubagentState = {
	id: string;
	name: string;
	harness: string;
	model?: string;
	thinking?: string;
	status: SubagentStatus;
	queue: string[];
	task?: number;
	turns: number;
	interrupted?: boolean;
	lastAnswer?: string;
	lastStop?: string;
	error?: string;
	parent: number;
	created: number;
	updated: number;
};

export const SubagentDoc = defineDoc<SubagentState>({
	kind: "pid0.subagent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ id: "", name: "", harness: "", status: "idle", queue: [], turns: 0, parent: 0, created: 0, updated: 0 }),
	checkpointWhen: () => true,
});

export const SubagentIndex = defineDoc<{ agents: Record<string, number> }>({
	kind: "pid0.subagents",
	version: 1,
	scope: "session",
	initial: () => ({ agents: {} }),
	checkpointWhen: () => true,
});

export type TurnInput = { agent: string; message: string };
export type TurnResult = { stopReason: string; answer: string; error?: string };
export type TurnRunner = { suspended?: boolean; run?: (input: TurnInput, conversationId: number, signal: AbortSignal) => Promise<TurnResult> };
export type TurnTask = Task<TurnInput, { phase: "run" }, TurnResult, object>;

export const TURN_OPTIONS = { ownership: { kind: "conversation" as const }, background: true };

export function subagentRuntime() {
	const runner: TurnRunner = {};
	const Turn: TurnTask = defineTask<TurnInput, { phase: "run" }, TurnResult>({
		name: "pid0.subagent.turn",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				let result: TurnResult;
				try {
					if (!runner.run) throw new Error("this process cannot run subagents");
					result = await runner.run(task.input, runtime.conversationId as unknown as number, runtime.signal);
				} catch (error) {
					result = { stopReason: "error", answer: "", error: (error as Error).message };
				}
				if (runner.suspended && !runtime.signal.aborted) await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve(), { once: true }));
				if (runtime.signal.aborted) return;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(SubagentDoc, runtime.conversationId);
					doc.turns++;
					doc.updated = runtime.now();
					doc.lastStop = result.stopReason;
					if (result.answer) doc.lastAnswer = result.answer;
					if (result.error) doc.error = result.error;
					else delete doc.error;
					delete doc.task;
					delete doc.interrupted;
					if (doc.status === "working") {
						const next = result.error ? undefined : doc.queue.shift();
						if (next !== undefined) doc.task = (await tx.createTask(Turn, { agent: task.input.agent, message: next }, { ...TURN_OPTIONS, conversationId: runtime.conversationId })) as unknown as number;
						else doc.status = result.error ? "failed" : "idle";
					}
					return { status: "terminal", outcome: { status: "completed", result } };
				}, context);
			},
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const doc = await tx.doc(SubagentDoc, runtime.conversationId);
				if (doc.task === (task.id as unknown as number)) {
					delete doc.task;
					doc.interrupted = true;
					doc.updated = runtime.now();
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
	const extension = defineExtension({ name: "pid0.subagents", tasks: [Turn] });
	return { runner, Turn, extension };
}
