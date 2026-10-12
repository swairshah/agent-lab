import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, type Static, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	LiveDoc,
	type ModelRef,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defaultWorker, type WorkerKind, workerModels, workspace } from "./config.ts";
import { workerInstructions } from "./prompts.ts";
import { WebTools } from "./web-tools.ts";

export type WorkerRecord = {
	conversationId: ConversationId;
	kind: WorkerKind;
	model: ModelRef;
	task: string;
	startedAt: number;
	reported: EntryId[];
};

export type WorkersState = {
	workers: Record<string, WorkerRecord>;
	reporters: Record<string, TaskId>;
};

export const WorkersDoc = defineDoc<WorkersState>({
	kind: "app.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workers: {}, reporters: {} }),
});

export const REPORT_ENTRY = "app.report";

export type Report = { worker: string; status: "answered" | "failed"; text: string };

export type ReportSink =
	| { readonly kind: "text" }
	| { readonly kind: "voice"; deliver(report: Report): void };

let sink: ReportSink = { kind: "text" };

export function setReportSink(next: ReportSink): void {
	sink = next;
}

export function reportHeader(report: Report): string {
	return report.status === "answered" ? `[worker ${report.worker} finished]` : `[worker ${report.worker} failed]`;
}

export function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.worker-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: Report };

const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.worker-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { name, conversationId, message, followUp } = task.input;
			const worker = (await runtime.conversation(conversationId, context))!;
			const submission = await worker.submit(
				{
					type: "input",
					content: message,
					whenBusy: followUp ? "followUp" : "steer",
					requestId: `worker:${task.id}`,
				},
				context,
			);
			const settled = await submission.wait(context);
			await runtime.commit(async (tx) => {
				const next = (report?: Report) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") {
					if (settled.reason === "aborted") return next();
					return next({ worker: name, status: "failed", text: String(settled.reason) });
				}
				if (settled.type !== "input") return next();
				const record = (await tx.doc(WorkersDoc, runtime.conversationId)).workers[name]!;
				if (record.reported.includes(settled.answer)) return next();
				record.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next({ worker: name, status: "answered", text: textOf(answer) });
			}, context);
		},
		report: async (task, runtime, context) => {
			const report = task.state.checkpoint.report;
			const done = () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;
			if (report === undefined) {
				await runtime.commit(done, context);
				return;
			}
			const content = `${reportHeader(report)} ${report.text}`;
			if (sink.kind === "text") {
				const main = (await runtime.conversation(runtime.conversationId, context))!;
				await main.submit(
					{
						type: "input",
						content,
						whenBusy: "followUp",
						requestId: `worker-report:${task.id}`,
					},
					context,
				);
				await runtime.commit(done, context);
				return;
			}
			const current = sink;
			await runtime.commit(async (tx) => {
				await tx.appendEntry(runtime.conversationId, {
					kind: REPORT_ENTRY,
					data: { worker: report.worker, status: report.status, via: "voice" },
					model: [{ role: "user", content, timestamp: Date.now() }],
				});
				return done();
			}, context);
			current.deliver(report);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const delegateParameters = Type.Object({
	action: Type.Union(
		[Type.Literal("start"), Type.Literal("message"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("result")],
		{ description: "start a new worker, message a running one, stop one, list workers, or fetch a full result" },
	),
	name: Type.Optional(Type.String({ description: "Short lowercase handle for the worker, e.g. 'auth-fix'" })),
	task: Type.Optional(
		Type.String({ description: "start/message: a self-contained brief; workers cannot see this conversation" }),
	),
	worker: Type.Optional(
		Type.Union([Type.Literal("opus"), Type.Literal("sol")], {
			description: "start only: 'opus' (Claude Opus, default) or 'sol' (GPT-5.6 Sol)",
		}),
	),
	followUp: Type.Optional(
		Type.Boolean({ description: "message only: queue after the current answer instead of steering the current work" }),
	),
});

export type DelegateArgs = Static<typeof delegateParameters>;

export const DELEGATE_DESCRIPTION =
	"Hand work to a background worker agent (Claude Opus or GPT-5.6 Sol with file, shell and web tools). " +
	"Returns immediately; the worker's answer is reported back to you as a message when it is done.";

export type DelegationResult = { text: string; worker?: { name: string; conversationId: ConversationId } };

/** What delegation needs from its caller: a tool's API inside a run, or the Harness for the voice frontend. */
export interface DelegationHost {
	readonly rootId: ConversationId;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	busy(conversationId: ConversationId, context: Context): Promise<boolean>;
	abort(conversationId: ConversationId, context: Context): Promise<void>;
}

/** The one implementation of the delegate tool, shared by the text and voice frontends. */
export async function delegate(
	host: DelegationHost,
	args: DelegateArgs,
	reporterKey: string,
	context: Context,
): Promise<DelegationResult> {
	const { action, name, task, followUp } = args;
	const state: WorkersState = await host.commit(
		async (tx) => JSON.parse(JSON.stringify(await tx.doc(WorkersDoc, host.rootId))),
		context,
	);

	if (action === "status") {
		const names = name === undefined ? Object.keys(state.workers) : [name];
		const lines: string[] = [];
		for (const each of names) {
			const record = state.workers[each];
			if (record === undefined) continue;
			const busy = await host.busy(record.conversationId, context);
			lines.push(`${each} (${record.kind}): ${busy ? "working" : "idle"}, ${record.reported.length} answer(s)`);
		}
		return { text: lines.length === 0 ? "No workers." : lines.join("\n") };
	}
	if (name === undefined || name.trim() === "") return { text: `${action} needs a name.` };
	const record = state.workers[name];
	if (action !== "start" && record === undefined) return { text: `No worker named ${name}.` };
	const ref = (conversationId: ConversationId) => ({ name, conversationId });

	if (action === "stop") {
		await host.abort(record!.conversationId, context);
		return { text: `Stopped ${name}.`, worker: ref(record!.conversationId) };
	}
	if (action === "result") {
		const last = record!.reported.at(-1);
		if (last === undefined) return { text: `${name} has not answered yet.`, worker: ref(record!.conversationId) };
		const text = await host.commit(
			async (tx) => textOf((await tx.entry(AssistantEntry, last))?.model?.[0] as AssistantMessage | undefined),
			context,
		);
		return { text: text || "(empty answer)", worker: ref(record!.conversationId) };
	}
	if (task === undefined || task.trim() === "") return { text: `${action} needs a task.` };
	if (action === "start" && record !== undefined) return { text: `${name} already exists; use action "message".` };

	const conversationId = await host.commit(async (tx) => {
		const workers = await tx.doc(WorkersDoc, host.rootId);
		const background = { ownership: { kind: "conversation" }, conversationId: host.rootId, background: true } as const;
		if (action === "start") {
			const kind = args.worker ?? defaultWorker;
			const model = workerModels[kind];
			const anchor = await tx.createTask(Anchor, null, background);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				model,
				thinkingLevel: "high",
				extensions: [CodingTools, WebTools],
				tools: null,
				instructions: workerInstructions(name, workspace),
				cwd: workspace,
			});
			workers.workers[name] = {
				conversationId: child.id,
				kind,
				model,
				task,
				startedAt: Date.now(),
				reported: [],
			};
		}
		const target = workers.workers[name]!.conversationId;
		const input = { name, conversationId: target, message: task, followUp: action === "message" && followUp === true };
		workers.reporters[reporterKey] = await tx.createTask(Reporter, input, background);
		return target;
	}, context);
	const kind = (action === "start" ? args.worker : record?.kind) ?? defaultWorker;
	const text =
		action === "start"
			? `Started worker ${name} on ${kind}. Its answer will be reported back when it is done.`
			: `Sent to ${name}.`;
	return { text, worker: ref(conversationId) };
}

const delegateTool = defineTool({
	name: "delegate",
	description: DELEGATE_DESCRIPTION,
	parameters: delegateParameters,
	replay: "unsafe",
	execute: async (args, api, context) => {
		const host: DelegationHost = {
			rootId: api.conversationId,
			commit: (change, ctx) => api.commit(change, ctx),
			busy: async (id, ctx) => (await api.snapshot(LiveDoc, id, ctx))?.run !== undefined,
			abort: async (id, ctx) => (await api.conversation(id, ctx))?.abort(ctx),
		};
		const result = await delegate(host, args, `tool:${api.taskId}`, context);
		return {
			content: [{ type: "text", text: result.text }],
			...(result.worker === undefined ? {} : { details: result.worker }),
		};
	},
});

export const Delegation = defineExtension({
	name: "frontdesk-delegation",
	tasks: [Anchor, Reporter],
	tools: [delegateTool],
});
