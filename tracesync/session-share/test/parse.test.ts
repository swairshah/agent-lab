import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeState, parseClaudeLine } from "../src/claude.ts";
import { codexState, parseCodexLine } from "../src/codex.ts";
import { narrate } from "../src/narrate.ts";

const row = (r: object) => JSON.stringify({ isSidechain: false, timestamp: "2026-10-28T20:00:00.000Z", ...r });

test("Claude rows: the person's words, Claude's blocks, results named by their call", () => {
	const s = claudeState();
	const said = parseClaudeLine(row({ type: "user", uuid: "u1", message: { role: "user", content: "<session-share-context>\nold\n</session-share-context>\n\nfix the tests" } }), s);
	assert.deepEqual(said.map((p) => p.message), [{ role: "user", content: [{ type: "text", text: "fix the tests" }] }]);

	const call = parseClaudeLine(row({ type: "assistant", uuid: "a1", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "hm", signature: "sig" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }), s);
	assert.equal(call.length, 1);
	assert.deepEqual(call[0]!.message, { role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "t1", name: "Bash", arguments: { command: "npm test" } }] });
	assert.equal((call[0]!.native as { content: { signature?: string }[] }).content[0]!.signature, "sig", "the raw message keeps the signature");

	const result = parseClaudeLine(row({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "2 passing" }] }] } }), s);
	assert.deepEqual(result[0]!.message, { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: "2 passing", isError: false });
});

test("Claude rows that are not the conversation are left out", () => {
	const s = claudeState();
	for (const r of [
		{ type: "user", uuid: "m", isMeta: true, message: { role: "user", content: "meta" } },
		{ type: "assistant", uuid: "side", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } },
		{ type: "user", uuid: "cmd", message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" } },
		{ type: "attachment", uuid: "att" },
		{ type: "user", uuid: "c", isCompactSummary: true, message: { role: "user", content: "summary" } },
	])
		assert.deepEqual(parseClaudeLine(row(r), s), [], JSON.stringify(r));
});

test("Codex rollout: framing dropped, calls and outputs paired, reasoning summary kept", () => {
	const s = codexState();
	const line = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-10-28T20:00:00.000Z", type, payload });
	assert.deepEqual(parseCodexLine(line("session_meta", { id: "th1", cwd: "/x" }), 1, s), []);
	assert.equal(s.thread, "th1");
	parseCodexLine(line("turn_context", { model: "gpt-5.5" }), 2, s);
	assert.deepEqual(parseCodexLine(line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }), 3, s), []);
	assert.deepEqual(parseCodexLine(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" }] }), 4, s), []);
	const said = parseCodexLine(line("response_item", { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "<session-share-context>\nctx\n</session-share-context>\n\ncount lines" }] }), 5, s);
	assert.deepEqual(said[0]!.message, { role: "user", content: [{ type: "text", text: "count lines" }] });
	const call = parseCodexLine(line("response_item", { type: "function_call", id: "f1", name: "exec_command", arguments: '{"cmd":"wc -l a"}', call_id: "c1" }), 6, s);
	assert.deepEqual(call[0]!.message, { role: "assistant", model: "gpt-5.5", content: [{ type: "toolCall", id: "c1", name: "exec_command", arguments: { cmd: "wc -l a" } }] });
	const out = parseCodexLine(line("response_item", { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "3 a" }] }), 7, s);
	assert.deepEqual(out[0]!.message, { role: "toolResult", toolCallId: "c1", toolName: "exec_command", content: "3 a", isError: false });
	assert.equal(out[0]!.nativeId, "line:7");
	const thought = parseCodexLine(line("response_item", { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "xx" }), 8, s);
	assert.deepEqual(thought[0]!.message.role === "assistant" && thought[0]!.message.content, [{ type: "thinking", thinking: "plan" }]);
});

test("narration leaves out the reader's own session and all thinking, and keeps to its budget", () => {
	const items = [
		{ id: 1, kind: "message" as const, agent: "claude-code" as const, session: "c1", member: "Ada", message: { role: "user" as const, content: [{ type: "text" as const, text: "first" }] } },
		{ id: 2, kind: "message" as const, agent: "claude-code" as const, session: "c1", message: { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "secret" }, { type: "text" as const, text: "done" }] } },
		{ id: 3, kind: "message" as const, agent: "codex" as const, session: "x1", message: { role: "assistant" as const, content: [{ type: "text" as const, text: "mine" }] } },
	];
	const told = narrate(items, "x1")!;
	assert.match(told, /\[Claude Code · Ada\] user: first/);
	assert.match(told, /\[Claude Code\] done/);
	assert.doesNotMatch(told, /secret|mine/);
	assert.equal(narrate(items.slice(2), "x1"), undefined);
	assert.match(narrate(items, "x1", 30)!, /1 earlier item left out/);
});
