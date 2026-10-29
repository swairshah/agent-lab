// Claude Code's transcript (~/.claude/projects/<folder>/<session>.jsonl) as normalized messages.
//
// Each line is a row; an assistant response is split over several rows that share `message.id`, one per content
// block. Only what the person and Claude said and did is kept: subagent (sidechain) rows, meta rows, compaction
// summaries, API error rows, slash-command echoes, attachments and the engine's bookkeeping rows are left out, as
// delta-claude's capturedMessage does.
import { type Block, clip, type Parsed, RESULT_LIMIT, stripContext } from "./protocol.ts";

type Row = {
	type?: string;
	uuid?: string;
	timestamp?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	isApiErrorMessage?: boolean;
	message?: { role?: string; model?: string; content?: unknown };
};

/** Engine framing inside a user row that is not the person's words. */
const FRAMING = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>\s*/g;

function userText(text: string): string {
	return stripContext(text).replace(FRAMING, "").trim();
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : `[${b?.type ?? "content"}]`)).join("\n");
}

/** Tool names by call id, so a result row (which carries only the id) can say which tool it answers. */
export type ClaudeState = { tools: Map<string, string> };

export function claudeState(): ClaudeState {
	return { tools: new Map() };
}

export function parseClaudeLine(line: string, state: ClaudeState): Parsed[] {
	let row: Row;
	try {
		row = JSON.parse(line);
	} catch {
		return [];
	}
	if ((row.type !== "user" && row.type !== "assistant") || row.isSidechain || row.isMeta || row.isCompactSummary || row.isApiErrorMessage) return [];
	const id = row.uuid;
	const content = row.message?.content;
	if (id === undefined || content === undefined) return [];
	const at = row.timestamp === undefined ? undefined : Date.parse(row.timestamp);

	if (row.type === "assistant") {
		const blocks: Block[] = [];
		for (const b of Array.isArray(content) ? content : [{ type: "text", text: String(content) }]) {
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) blocks.push({ type: "text", text: b.text });
			else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) blocks.push({ type: "thinking", thinking: b.thinking });
			else if (b?.type === "tool_use" && typeof b.id === "string") {
				state.tools.set(b.id, String(b.name));
				blocks.push({ type: "toolCall", id: b.id, name: String(b.name), arguments: b.input ?? {} });
			}
		}
		if (blocks.length === 0) return [];
		// The raw row keeps what a later Claude round trip needs (thinking signatures), which normalizing drops.
		return [{ nativeId: id, at, message: { role: "assistant", content: blocks, model: row.message?.model }, native: row.message }];
	}

	if (typeof content === "string") {
		const text = userText(content);
		return text ? [{ nativeId: id, at, message: { role: "user", content: [{ type: "text", text }] } }] : [];
	}
	if (!Array.isArray(content)) return [];
	const out: Parsed[] = [];
	const said: Block[] = [];
	for (const [i, b] of content.entries()) {
		if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
			out.push({
				nativeId: `${id}:${i}`,
				at,
				message: {
					role: "toolResult",
					toolCallId: b.tool_use_id,
					toolName: state.tools.get(b.tool_use_id),
					content: clip(resultText(b.content), RESULT_LIMIT),
					isError: b.is_error === true,
				},
			});
		} else if (b?.type === "text" && typeof b.text === "string") {
			const text = userText(b.text);
			if (text) said.push({ type: "text", text });
		} else if (b?.type === "image") said.push({ type: "image", mimeType: b.source?.media_type });
	}
	if (said.length > 0) out.unshift({ nativeId: id, at, message: { role: "user", content: said } });
	return out;
}
