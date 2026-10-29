// Codex's rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl) as normalized messages.
//
// Each line is `{timestamp, type, payload}`. The conversation is in the `response_item` lines: messages, reasoning,
// function and custom tool calls and their outputs. Developer messages and the context Codex injects as user input
// (`<environment_context>`, `<heartbeat>`, skills, AGENTS.md) are left out; `event_msg` lines repeat the items for UIs.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Block, clip, type Parsed, RESULT_LIMIT, stripContext } from "./protocol.ts";

/** A whole input block that is one tagged element is Codex's own framing, not the person's words. */
const FRAMING = /^\s*<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>\s*/;

function userText(text: string): string {
	let t = stripContext(text);
	for (let m = t.match(FRAMING); m; m = t.match(FRAMING)) t = t.slice(m[0].length);
	if (/^# AGENTS\.md instructions/.test(t)) return "";
	return t.trim();
}

function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	if (Array.isArray(output)) return output.map((b: { type?: string; text?: string }) => (typeof b?.text === "string" ? b.text : `[${b?.type ?? "content"}]`)).join("\n");
	if (output && typeof output === "object" && "content" in output) return outputText((output as { content: unknown }).content);
	return output == null ? "" : JSON.stringify(output);
}

function args(text: unknown): unknown {
	if (typeof text !== "string") return text ?? {};
	try {
		return JSON.parse(text);
	} catch {
		return { input: text };
	}
}

/** Tool names by call id, and the model the current turn runs. */
export type CodexState = { tools: Map<string, string>; model?: string; thread?: string };

export function codexState(): CodexState {
	return { tools: new Map() };
}

export function parseCodexLine(line: string, lineNo: number, state: CodexState): Parsed[] {
	let row: { timestamp?: string; type?: string; payload?: Record<string, any> };
	try {
		row = JSON.parse(line);
	} catch {
		return [];
	}
	const p = row.payload;
	if (!p) return [];
	if (row.type === "session_meta") state.thread = p.id;
	if (row.type === "turn_context" && typeof p.model === "string") state.model = p.model;
	if (row.type !== "response_item") return [];
	const nativeId = typeof p.id === "string" ? p.id : `line:${lineNo}`;
	const at = row.timestamp === undefined ? undefined : Date.parse(row.timestamp);
	const assistant = (content: Block[]): Parsed[] => [{ nativeId, at, message: { role: "assistant", content, model: state.model }, native: p }];
	const result = (callId: string, output: unknown, isError = false): Parsed[] => [
		{ nativeId, at, message: { role: "toolResult", toolCallId: callId, toolName: state.tools.get(callId), content: clip(outputText(output), RESULT_LIMIT), isError } },
	];

	switch (p.type) {
		case "message": {
			const content: { type?: string; text?: string }[] = Array.isArray(p.content) ? p.content : [];
			if (p.role === "assistant") {
				const blocks: Block[] = content.flatMap((b) => (typeof b.text === "string" && b.text.trim() ? [{ type: "text", text: b.text } as Block] : []));
				return blocks.length ? assistant(blocks) : [];
			}
			if (p.role !== "user") return [];
			const blocks: Block[] = content.flatMap((b): Block[] => {
				if (b.type === "input_image") return [{ type: "image" }];
				const text = typeof b.text === "string" ? userText(b.text) : "";
				return text ? [{ type: "text", text }] : [];
			});
			return blocks.length ? [{ nativeId, at, message: { role: "user", content: blocks } }] : [];
		}
		case "reasoning": {
			const summary = (Array.isArray(p.summary) ? p.summary : []).map((s: { text?: string }) => s?.text ?? "").join("\n").trim();
			// The encrypted reasoning only means something to OpenAI; the summary is what others can read.
			return summary ? assistant([{ type: "thinking", thinking: summary }]) : [];
		}
		case "function_call":
		case "custom_tool_call": {
			const name = p.namespace ? `${p.namespace}.${p.name}` : String(p.name);
			state.tools.set(p.call_id, name);
			return assistant([{ type: "toolCall", id: String(p.call_id), name, arguments: p.type === "function_call" ? args(p.arguments) : { input: p.input } }]);
		}
		case "local_shell_call": {
			state.tools.set(p.call_id, "shell");
			return assistant([{ type: "toolCall", id: String(p.call_id), name: "shell", arguments: p.action ?? {} }]);
		}
		case "function_call_output":
		case "custom_tool_call_output":
		case "local_shell_call_output":
			return result(String(p.call_id), p.output, p.output?.success === false);
		default:
			return [];
	}
}

/** The rollout file of a Codex thread, searched newest day first. */
export function findRollout(thread: string, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string | undefined {
	const root = join(home, "sessions");
	if (!existsSync(root)) return undefined;
	// Folders only, newest first: older Codex versions left flat rollout files at the top.
	const desc = (dir: string) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name] : [])).sort().reverse();
	for (const y of desc(root))
		for (const m of desc(join(root, y)))
			for (const d of desc(join(root, y, m))) {
				const hit = readdirSync(join(root, y, m, d)).find((f) => f.endsWith(`${thread}.jsonl`));
				if (hit) return join(root, y, m, d, hit);
			}
	return undefined;
}
