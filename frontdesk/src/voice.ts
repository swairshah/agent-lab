import type { AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { EntryDraft } from "@earendil-works/pi-durable";
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { transcriptionModel, voiceModel, voiceName } from "./config.ts";
import {
	DELEGATE_DESCRIPTION,
	type DelegateArgs,
	delegate,
	delegateParameters,
	type Report,
	reportHeader,
} from "./delegation.ts";
import { context, type Session } from "./harness.ts";
import { voiceFrontendInstructions } from "./prompts.ts";

export const VOICE_USER = "app.voice-user";
export const VOICE_ASSISTANT = "app.voice-assistant";
export const VOICE_TOOL_RESULT = "app.voice-tool-result";

const SEED_ITEMS = 40;
const SEED_CHARS = 2_000;
const REPORT_CHARS = 3_000;

type RealtimeEvent = { type: string; [key: string]: any };
type BridgeEvent = { type: string; [key: string]: unknown };

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function messageText(message: Message): string {
	const content = message.content as string | readonly { type: string; text?: string }[];
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

export function sessionConfig() {
	return {
		type: "realtime" as const,
		model: voiceModel,
		instructions: voiceFrontendInstructions,
		output_modalities: ["audio" as const],
		audio: {
			input: {
				transcription: { model: transcriptionModel },
				turn_detection: { type: "semantic_vad" as const },
			},
			output: { voice: voiceName },
		},
		tools: [
			{
				type: "function" as const,
				name: "delegate",
				description: DELEGATE_DESCRIPTION,
				parameters: JSON.parse(JSON.stringify(delegateParameters)),
			},
		],
		tool_choice: "auto" as const,
	};
}

/** Converts the pi-durable root transcript into Realtime conversation items so a call resumes the session. */
export function seedItems(entries: readonly { kind: string; model?: readonly Message[] }[]) {
	const items: object[] = [];
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const text = clip(messageText(message).trim(), SEED_CHARS);
			if (message.role === "user" && text !== "") {
				const role = text.startsWith("[worker ") ? "system" : "user";
				items.push({ type: "message", role, content: [{ type: "input_text", text }] });
			} else if (message.role === "assistant") {
				const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
				if (text !== "") items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
				for (const call of calls) {
					const note = `(earlier you called ${call.name} ${JSON.stringify(call.arguments)})`;
					items.push({ type: "message", role: "system", content: [{ type: "input_text", text: clip(note, SEED_CHARS) }] });
				}
			} else if (message.role === "toolResult" && text !== "") {
				const note = `(${message.toolName} returned: ${text})`;
				items.push({ type: "message", role: "system", content: [{ type: "input_text", text: note }] });
			}
		}
	}
	return items.slice(-SEED_ITEMS);
}

export type Transport = { send(event: object): void; close(): void };

export type Attachment = {
	open(): void;
	event(event: RealtimeEvent): void;
	closed(): void;
};

type Call = {
	id: string;
	transport: Transport;
	responding: boolean;
	transcripts: Map<string, ReturnType<typeof deferred<string>>>;
	reports: Report[];
	queue: Promise<void>;
};

export class VoiceBridge {
	readonly #session: Session;
	#client: OpenAI | undefined;
	readonly #listeners = new Set<(event: BridgeEvent) => void>();
	#call: Call | undefined;

	constructor(session: Session) {
		this.#session = session;
	}

	get #openai(): OpenAI {
		this.#client ??= new OpenAI();
		return this.#client;
	}

	get active(): string | undefined {
		return this.#call?.id;
	}

	subscribe(listener: (event: BridgeEvent) => void): () => void {
		this.#listeners.add(listener);
		listener({ type: "status", state: this.#call === undefined ? "idle" : "live", callId: this.#call?.id });
		return () => this.#listeners.delete(listener);
	}

	#emit(event: BridgeEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	/** Creates a Realtime call from the browser's SDP offer and attaches a server-side sideband socket to it. */
	async start(offerSdp: string): Promise<string> {
		await this.hangup();
		const response = await this.#openai.realtime.calls.create({ sdp: offerSdp, session: sessionConfig() as never });
		const answer = await response.text();
		const id = response.headers.get("location")?.split("/").pop();
		if (id === undefined || id === "") throw new Error("Realtime call created without a call id");
		const ws = new OpenAIRealtimeWS({ callID: id }, this.#openai);
		const attachment = this.attach(id, { send: (event) => ws.send(event as never), close: () => ws.close() });
		ws.socket.on("open", () => attachment.open());
		ws.socket.on("close", () => attachment.closed());
		ws.on("error", (error: unknown) => this.#emit({ type: "error", message: String((error as Error)?.message ?? error) }));
		ws.on("event", (event: RealtimeEvent) => attachment.event(event));
		return answer;
	}

	/** Binds a Realtime call's server-side event stream to the shared session. */
	attach(id: string, transport: Transport): Attachment {
		const call: Call = { id, transport, responding: false, transcripts: new Map(), reports: [], queue: Promise.resolve() };
		this.#call = call;
		this.#emit({ type: "status", state: "connecting", callId: id });
		return {
			open: () => {
				this.#enqueue(call, () => this.#seed(call));
				this.#emit({ type: "status", state: "live", callId: id });
			},
			event: (event) => this.#onEvent(call, event),
			closed: () => {
				if (this.#call === call) this.#call = undefined;
				this.#emit({ type: "status", state: "idle", callId: id });
			},
		};
	}

	/** Resolves once every event received so far has been written to the session. */
	async settled(): Promise<void> {
		await this.#call?.queue;
	}

	async hangup(): Promise<void> {
		const call = this.#call;
		if (call === undefined) return;
		this.#call = undefined;
		try {
			await this.#openai.realtime.calls.hangup(call.id);
		} catch {}
		call.transport.close();
	}

	/** ReportSink target: a worker finished while the voice frontend is in charge. */
	deliver(report: Report): void {
		const call = this.#call;
		this.#emit({ type: "report", worker: report.worker, status: report.status });
		if (call === undefined) return;
		call.reports.push(report);
		if (!call.responding) this.#enqueue(call, async () => this.#flushReports(call));
	}

	#send(call: Call, event: object): void {
		call.transport.send(event);
	}

	#enqueue(call: Call, work: () => Promise<void>): void {
		call.queue = call.queue.then(work).catch((error: unknown) => this.#emit({ type: "error", message: String(error) }));
	}

	async #write(entry: EntryDraft): Promise<void> {
		await this.#session.root.submit({ type: "write", entry }, context);
	}

	async #seed(call: Call): Promise<void> {
		const view = await this.#session.root.viewState(context);
		const items = seedItems(view.value.entries);
		view.dispose();
		for (const item of items) this.#send(call, { type: "conversation.item.create", item });
		this.#emit({ type: "log", text: `resumed session with ${items.length} earlier messages` });
	}

	#onEvent(call: Call, event: RealtimeEvent): void {
		switch (event.type) {
			case "input_audio_buffer.committed": {
				const slot = deferred<string>();
				call.transcripts.set(event.item_id, slot);
				this.#enqueue(call, async () => {
					const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), 10_000));
					const text = (await Promise.race([slot.promise, timeout])).trim();
					call.transcripts.delete(event.item_id);
					if (text === "") return;
					await this.#write({
						kind: VOICE_USER,
						data: { callId: call.id },
						model: [{ role: "user", content: text, timestamp: Date.now() }],
					});
				});
				break;
			}
			case "conversation.item.input_audio_transcription.completed":
				call.transcripts.get(event.item_id)?.resolve(String(event.transcript ?? ""));
				break;
			case "conversation.item.input_audio_transcription.failed":
				call.transcripts.get(event.item_id)?.resolve("");
				break;
			case "response.created":
				call.responding = true;
				break;
			case "response.done":
				call.responding = false;
				this.#enqueue(call, () => this.#onResponse(call, event.response));
				break;
			case "error":
				this.#emit({ type: "error", message: event.error?.message ?? JSON.stringify(event) });
				break;
		}
	}

	async #onResponse(call: Call, response: { status?: string; output?: any[] }): Promise<void> {
		const texts: string[] = [];
		const calls: ToolCall[] = [];
		for (const item of response.output ?? []) {
			if (item.type === "message") {
				for (const part of item.content ?? []) {
					const text = part.transcript ?? part.text;
					if (typeof text === "string" && text !== "") texts.push(text);
				}
			} else if (item.type === "function_call") {
				let args: Record<string, never> = {};
				try {
					args = JSON.parse(item.arguments || "{}");
				} catch {}
				calls.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: args });
			}
		}
		if (texts.length === 0 && calls.length === 0) return this.#flushReports(call);

		const message: AssistantMessage = {
			role: "assistant",
			content: [...(texts.length > 0 ? [{ type: "text" as const, text: texts.join(" ") }] : []), ...calls],
			api: "openai-realtime",
			provider: "openai",
			model: voiceModel,
			usage: ZERO_USAGE,
			stopReason: calls.length > 0 ? "toolUse" : response.status === "cancelled" ? "aborted" : "stop",
			timestamp: Date.now(),
		};
		await this.#write({ kind: VOICE_ASSISTANT, data: { callId: call.id, status: response.status ?? null }, model: [message] });

		for (const toolCall of calls) {
			let output: string;
			let isError = false;
			try {
				if (toolCall.name !== "delegate") throw new Error(`unknown tool ${toolCall.name}`);
				const result = await delegate(
					this.#session.host,
					toolCall.arguments as DelegateArgs,
					`voice:${toolCall.id}`,
					context,
				);
				output = result.text;
				this.#emit({ type: "delegate", args: toolCall.arguments, result: result.text });
			} catch (error) {
				output = `Error: ${(error as Error).message ?? error}`;
				isError = true;
			}
			await this.#write({
				kind: VOICE_TOOL_RESULT,
				data: { callId: call.id },
				model: [
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: output }],
						isError,
						timestamp: Date.now(),
					},
				],
			});
			this.#send(call, {
				type: "conversation.item.create",
				item: { type: "function_call_output", call_id: toolCall.id, output },
			});
		}
		if (calls.length > 0) {
			call.responding = true;
			this.#send(call, { type: "response.create" });
			return;
		}
		await this.#flushReports(call);
	}

	async #flushReports(call: Call): Promise<void> {
		if (call.reports.length === 0 || call.responding) return;
		const reports = call.reports.splice(0);
		for (const report of reports) {
			const text = `${reportHeader(report)} ${clip(report.text, REPORT_CHARS)}\n\nTell the user the gist in one or two spoken sentences.`;
			this.#send(call, { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
		}
		call.responding = true;
		this.#send(call, { type: "response.create" });
	}
}
