// What every agent's work becomes in the shared session, whichever agent did it.
//
// Claude Code and Codex keep their own native transcripts, and pi runs inside the pi-durable Harness itself. The
// shared session holds one record per native message, normalized to pi-ai's message shape (text, thinking, tool
// calls, tool results), with where it came from. Each agent continues from its own native history and is told
// about everyone else's work as narration (see narrate.ts).

export type AgentKind = "claude-code" | "codex" | "pi";

export const AGENT_NAMES: Record<AgentKind, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "pi" };

/** Where a recorded message came from: which agent, which of its native sessions, and its id there. */
export type Origin = {
	agent: AgentKind;
	/** The agent's own session id (Claude's session, Codex's thread); "pi:<conversation>" for pi. */
	session: string;
	/** The message's id in that session: a Claude row uuid, a Codex rollout line number. */
	nativeId: string;
	/** The person whose turn it was. */
	member?: string;
	model?: string;
};

export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "image"; mimeType?: string };

export type Normalized =
	| { role: "user"; content: Block[] }
	| { role: "assistant"; content: Block[]; model?: string }
	| { role: "toolResult"; toolCallId: string; toolName?: string; content: string; isError: boolean };

/** One parsed native message, before the session gives it an origin. */
export type Parsed = { nativeId: string; message: Normalized; at?: number; native?: unknown };

/** `share.message`: one native message of Claude Code or Codex. */
export type ShareMessageData = { origin: Origin; message: Normalized; at: number; native?: unknown };

/** `share.prompt`: a person's message to pi; its model message is the prompt itself. */
export type SharePromptData = { member: string; text: string; at: number };

/** `share.turn`: an agent took or gave back the turn. */
export type ShareTurnData = { phase: "start" | "end"; agent: AgentKind; session: string; member?: string; at: number };

/** `share.checkpoint`: a tag on the session up to an entry, with the files as they were (a git commit). */
export type ShareCheckpointData = { label: string; by: string; at: number; upTo: number; git?: string };

/** `share.fork`: the first entry of a fork, made by going back to the checkpoint `label` from conversation `from`. */
export type ShareForkData = { label: string; by: string; at: number; from: number; saved: string; git?: string };

/** Who holds the turn. Only one agent works in the session at a time. */
export type Holder = { agent: AgentKind; session: string; member?: string; since: number; heartbeat: number };

/** A tool result above this is kept as its head and tail. */
export const RESULT_LIMIT = 64_000;

export function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n… [${text.length - limit} characters cut] …\n${text.slice(-half)}`;
}

/** The text of the user's own words, without the context this tool put around them. */
export const CONTEXT_TAG = "session-share-context";
const CONTEXT_BLOCK = new RegExp(`<${CONTEXT_TAG}>[\\s\\S]*?</${CONTEXT_TAG}>\\s*`, "g");

export function stripContext(text: string): string {
	return text.replace(CONTEXT_BLOCK, "");
}
