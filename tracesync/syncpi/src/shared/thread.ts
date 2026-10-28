// Turns a conversation's agent events (pi-durable `watchEvents`: one snapshot, then one batch per commit) into a flat
// list of display items. The terminal UI and the web view both render this state, so they show the same thread.
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { LineComment } from "./protocol.ts";

type Json = unknown;
type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, Json> };
type Message = { role: string; content?: string | Block[]; provider?: string; model?: string; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean };
type Entry = { id: number | string; kind: string; data?: Json; model?: readonly Message[] };

/** `author` is the name at the time; renderers show the member's current name when they know `memberId`. */
export type UserItem = {
	kind: "user";
	key: string;
	author?: string;
	memberId?: string;
	text: string;
	/** Files added to the message; images also as data URLs, from what the model was sent. */
	attachments?: { name: string; kind: "image" | "text"; url?: string }[];
	/** Comments on lines of project files sent with this message. */
	comments?: LineComment[];
	/** When it was sent (ms since the epoch), for messages sent since syncpi recorded it. */
	at?: number;
	/** The sender's request ID, so their client knows the message arrived even if the acknowledgment didn't. */
	requestId?: string;
	/** Where it ran: on the sender's own machine ("device") or the session VM. */
	where?: "device" | "vm";
	/** Who else wrote it, when it was a draft written together (by name at the time). */
	with?: string[];
	rev: number;
};
/** `model` is the `provider/model` that wrote it, when known. */
export type AssistantItem = { kind: "assistant"; key: string; model?: string; text: string; thinking: string; error?: string; streaming: boolean; rev: number };
export type ToolItem = {
	kind: "tool";
	key: string;
	name: string;
	args: Record<string, Json>;
	output: string;
	status: "pending" | "running" | "done" | "error";
	/** The tool's structured result for UIs, e.g. `{ diff, patch }` from `edit`. */
	details?: Json;
	rev: number;
};
/** A line for people, not the model. `tag`: someone tagged members in a draft (whose writer is `owner`). */
export type NoticeItem = { kind: "notice"; key: string; text: string; tag?: DraftTag; rev: number };
export type DraftTag = { by: string; byId: string; owner: string; memberIds: string[]; text: string; at: number };
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem;

export type ThreadState = {
	items: Item[];
	busy: boolean;
	/** Inputs queued behind the running one. */
	queued: number;
	/** Set while the model call is backing off after an error. */
	retry?: string;
	/** Total spend of the conversation in dollars. */
	cost: number;
	/** Older messages are being summarized (on its own as the context fills, or after /compact). */
	compacting: boolean;
	model?: string;
    thinkingLevel?: string;
	/** Grows with every change, so renderers can skip work. */
	rev: number;
};

export function emptyThread(): ThreadState {
	return { items: [], busy: false, queued: 0, cost: 0, compacting: false, rev: 0 };
}

function textOf(content: Message["content"]): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

function thinkingOf(content: Message["content"]): string {
	if (content === undefined || typeof content === "string") return "";
	return content.flatMap((block) => (block.type === "thinking" && block.thinking !== undefined ? [block.thinking] : [])).join("");
}

export class Thread {
	state: ThreadState = emptyThread();
	#live: AssistantItem | undefined;
	#liveContent: Block[] = [];
	#tools = new Map<string, ToolItem>();

	/** Puts earlier entries (from before the current context) in front of what is shown. */
	prepend(entries: readonly unknown[]): void {
		const earlier = new Thread();
		for (const entry of entries) earlier.#entry(entry as Entry);
		const shown = new Set(this.state.items.map((i) => i.key));
		this.state.items = [...earlier.state.items.filter((i) => !shown.has(i.key)), ...this.state.items];
		for (const [key, tool] of earlier.#tools) if (!this.#tools.has(key)) this.#tools.set(key, tool);
		this.state.rev++;
	}

	apply(events: readonly AgentEvent[]): void {
		for (const event of events) this.#event(event);
		this.state.rev++;
	}

	#touch<T extends Item>(item: T): T {
		item.rev++;
		return item;
	}

	#push(item: Item): void {
		this.state.items.push(item);
	}

	#tool(key: string, name: string, args: Record<string, Json>): ToolItem {
		let tool = this.#tools.get(key);
		if (tool === undefined) {
			tool = { kind: "tool", key, name, args, output: "", status: "pending", rev: 0 };
			this.#tools.set(key, tool);
			this.#push(tool);
		}
		return tool;
	}

	#event(event: AgentEvent): void {
		const s = this.state;
		switch (event.type) {
			case "snapshot": {
				this.state = { ...emptyThread(), rev: s.rev };
				this.#tools.clear();
				this.#live = undefined;
				for (const entry of event.entries) this.#entry(entry as Entry);
				this.state.busy = event.run !== undefined;
				this.state.queued = event.inbox.length;
				this.state.thinkingLevel = event.agent.thinkingLevel;
				const model = event.agent.model;
				if (model !== undefined) this.state.model = `${model.provider}/${model.modelId}`;
				this.state.cost = totalCost(event.usage);
				this.state.compacting = event.compactions.length > 0;
				if (event.generation?.message !== undefined) this.#startLive(event.generation.message as Message);
				for (const slot of event.tools) {
					const tool = this.#tools.get(slot.callId);
					if (tool === undefined || slot.status === "done") continue;
					tool.status = slot.status === "pending" ? "pending" : "running";
					tool.output = slot.output ?? "";
				}
				return;
			}
			case "run_start":
				s.busy = true;
				return;
			case "run_end":
				s.busy = false;
				s.retry = undefined;
				return;
			case "inbox_update":
				s.queued = event.items.length;
				return;
			case "message_start": {
				const message = event.message as Message;
				if (message.role === "assistant") this.#startLive(message);
				return;
			}
			case "message_update":
				this.#updateLive(event.changes as readonly Change[]);
				return;
			case "message_end":
			case "entry_appended":
				this.#entry(event.entry as Entry);
				return;
			case "tool_execution_start": {
				if (event.parentToolCallId !== undefined) return;
				const tool = this.#tool(event.toolCallId, event.toolName, event.args as Record<string, Json>);
				tool.status = "running";
				this.#touch(tool);
				return;
			}
			case "tool_execution_update": {
				if (event.parentToolCallId !== undefined) return;
				const tool = this.#tools.get(event.toolCallId);
				if (tool === undefined) return;
				if (event.details !== undefined) tool.details = event.details;
				if (event.output !== undefined) {
					if ("set" in event.output) tool.output = event.output.set;
					else tool.output = tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
				}
				this.#touch(tool);
				return;
			}
			case "tool_execution_end":
				if (event.parentToolCallId !== undefined) return;
				if (event.entry !== undefined) this.#entry(event.entry as Entry);
				else {
					const tool = this.#tools.get(event.toolCallId);
					if (tool !== undefined && tool.status !== "done") this.#touch(tool).status = "error";
				}
				return;
			case "auto_retry_start":
				s.retry = `${event.errorMessage} (retry ${event.attempt})`;
				return;
			case "auto_retry_end":
				s.retry = undefined;
				return;
			case "task_failed":
				this.#push({ kind: "notice", key: `fail:${event.taskId}`, text: `${event.kind} failed: ${event.message}`, rev: 0 });
				return;
			case "compaction_start":
				s.compacting = true;
				return;
			case "compaction_end":
				s.compacting = false;
				if (event.error !== undefined) this.#push({ kind: "notice", key: `compact:${event.taskId}`, text: `compaction failed: ${event.error}`, rev: 0 });
				return;
			case "usage_changed":
				s.cost = totalCost(event.usage);
				return;
			case "agent_changed":
                s.thinkingLevel = event.agent.thinkingLevel;
				if (event.agent.model !== undefined) s.model = `${event.agent.model.provider}/${event.agent.model.modelId}`;
				return;
			default:
				return;
		}
	}

	#startLive(message: Message): void {
		this.#liveContent = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...(message.content ?? [])].map((b) => ({ ...b }));
		if (this.#live === undefined) {
			this.#live = { kind: "assistant", key: `live:${this.state.items.length}`, model: modelOf(message) ?? this.state.model, text: "", thinking: "", streaming: true, rev: 0 };
			this.#push(this.#live);
		}
		this.#syncLive();
	}

	#updateLive(changes: readonly Change[]): void {
		if (this.#live === undefined) this.#startLive({ role: "assistant", content: [] });
		const content = this.#liveContent;
		for (const change of changes) {
			switch (change.type) {
				case "text_start":
				case "thinking_start":
				case "toolcall_start":
				case "block":
					content[change.contentIndex] = { ...(change.block as Block) };
					break;
				case "text_delta": {
					const block = (content[change.contentIndex] ??= { type: "text", text: "" });
					block.text = (block.text ?? "") + change.delta;
					break;
				}
				case "thinking_delta": {
					const block = (content[change.contentIndex] ??= { type: "thinking", thinking: "" });
					block.thinking = (block.thinking ?? "") + change.delta;
					break;
				}
				case "message":
					this.#liveContent = [...((change.message as Message).content as Block[])].map((b) => ({ ...b }));
					break;
				default:
					break;
			}
		}
		this.#syncLive();
	}

	#syncLive(): void {
		const live = this.#live!;
		live.text = textOf(this.#liveContent);
		live.thinking = thinkingOf(this.#liveContent);
		this.#touch(live);
	}

	#entry(entry: Entry): void {
		const message = entry.model?.[0];
		const key = String(entry.id);
		switch (entry.kind) {
			case "pi.system":
				return;
			case "pi.assistant": {
				if (message === undefined) return;
				const content = message.content;
				const item: AssistantItem = {
					kind: "assistant",
					key,
					model: modelOf(message),
					text: textOf(content),
					thinking: thinkingOf(content),
					streaming: false,
					error: message.stopReason === "error" ? (message.errorMessage ?? "model error") : message.stopReason === "aborted" ? "aborted" : undefined,
					rev: 0,
				};
				// The streamed message becomes the committed one in place.
				const live = this.#live;
				this.#live = undefined;
				const at = live === undefined ? -1 : this.state.items.indexOf(live);
				if (at >= 0) {
					item.rev = live!.rev + 1;
					this.state.items[at] = item;
				} else this.#push(item);
				if (Array.isArray(content)) {
					for (const block of content) if (block.type === "toolCall" && block.id !== undefined) this.#tool(block.id, block.name ?? "tool", block.arguments ?? {});
				}
				return;
			}
			case "pi.tool-result": {
				if (message?.toolCallId === undefined) return;
				const tool = this.#tool(message.toolCallId, (message as { toolName?: string }).toolName ?? "tool", {});
				tool.output = textOf(message.content);
				tool.status = message.isError === true ? "error" : "done";
				const details = (message as { details?: Json }).details;
				if (details !== undefined) tool.details = details;
				this.#touch(tool);
				return;
			}
			case "pi.reset":
				this.#push({ kind: "notice", key, text: "new context: the agent no longer sees the messages above", rev: 0 });
				return;
			case "pi.compaction":
				this.#push({ kind: "notice", key, text: "older messages were summarized; the agent now sees the summary instead", rev: 0 });
				return;
			case "syncpi.notice":
				this.#push({ kind: "notice", key, text: String((entry.data as { text?: string })?.text ?? ""), rev: 0 });
				return;
			case "syncpi.tag": {
				const tag = entry.data as DraftTag & { names?: string[] };
				const names = tag.names?.join(", ") ?? "someone";
				this.#push({ kind: "notice", key, text: `${tag.by} tagged ${names} in ${tag.byId === tag.owner ? "their" : "a"} draft`, tag, rev: 0 });
				return;
			}
			case "syncpi.message": {
				const data = entry.data as { author?: string; memberId?: string; text?: string; attachments?: { name: string; kind: "image" | "text" }[]; comments?: LineComment[]; at?: number; requestId?: string; where?: "device" | "vm"; with?: string[] };
				const images = Array.isArray(message?.content) ? message.content.filter((b) => b.type === "image") : [];
				let image = 0;
				const attachments = data.attachments?.map((a) => {
					const block = a.kind === "image" ? (images[image++] as { data?: string; mimeType?: string } | undefined) : undefined;
					return block?.data ? { ...a, url: `data:${block.mimeType};base64,${block.data}` } : a;
				});
				this.#push({ kind: "user", key, author: data.author, memberId: data.memberId, text: data.text ?? textOf(message?.content), attachments, comments: data.comments, at: data.at, requestId: data.requestId, where: data.where, with: data.with, rev: 0 });
				return;
			}
			default:
				if (message?.role === "user") this.#push({ kind: "user", key, text: textOf(message.content), rev: 0 });
				return;
		}
	}
}

type Change =
	| { type: "text_start" | "thinking_start" | "toolcall_start" | "block"; contentIndex: number; block: unknown }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "message"; message: unknown };

function modelOf(message: Message): string | undefined {
	return message.model === undefined ? undefined : message.provider === undefined ? message.model : `${message.provider}/${message.model}`;
}

function totalCost(usage: { models: Record<string, { cost?: { total?: number } }>; tools: Record<string, { cost?: { total?: number } }> }): number {
	let total = 0;
	for (const u of Object.values(usage.models)) total += u.cost?.total ?? 0;
	for (const u of Object.values(usage.tools)) total += u.cost?.total ?? 0;
	return total;
}

/** A one-line description of a tool call, e.g. `bash  npm test` or `edit  src/app.ts`. */
export function toolSummary(tool: Pick<ToolItem, "name" | "args">): string {
	const a = tool.args as Record<string, unknown>;
	if ((tool.name === "record_browser" || tool.name === "screenshot_browser") && typeof a.title === "string") return a.title;
	const pick = a.command ?? a.path ?? a.file_path ?? a.url ?? a.pattern;
	const detail = typeof pick === "string" ? pick : Object.keys(a).length > 0 ? JSON.stringify(a) : "";
	return detail.replace(/\s+/g, " ").trim();
}

/** Tools that only look around (read, list, search, run a command); a run of them shows as one line, as in Delta. */
export function isQuietTool(tool: Pick<ToolItem, "name" | "status">): boolean {
	return ["read", "ls", "find", "grep", "bash"].includes(tool.name) && tool.status !== "error";
}

const GROUP_PHRASES: Record<string, [string, string]> = {
	ls: ["listed {n} directory", "listed {n} directories"],
	read: ["read {n} file", "read {n} files"],
	find: ["looked for files {n} time", "looked for files {n} times"],
	grep: ["searched {n} time", "searched {n} times"],
	bash: ["ran {n} command", "ran {n} commands"],
	edit: ["made {n} edit", "made {n} edits"],
	write: ["wrote {n} file", "wrote {n} files"],
	remote_bash: ["ran {n} command on the VM", "ran {n} commands on the VM"],
	record_browser: ["recorded {n} video", "recorded {n} videos"],
	screenshot_browser: ["took {n} screenshot", "took {n} screenshots"],
};

/** "Listed 6 directories, read 5 files": what a run of quiet tool calls did, in the order they started. */
export function toolGroupSummary(tools: Pick<ToolItem, "name">[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
	const text = [...counts]
		.map(([name, n]) => {
			const [one, many] = GROUP_PHRASES[name] ?? [`used ${name} {n} time`, `used ${name} {n} times`];
			return (n === 1 ? one : many).replace("{n}", String(n));
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
