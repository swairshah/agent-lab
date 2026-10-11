import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { dbPath, faux } from "./config.ts";
import { delegate, setReportSink, type Report, WorkersDoc } from "./delegation.ts";
import { context, openSession } from "./harness.ts";
import { seedItems, sessionConfig, VOICE_ASSISTANT, VOICE_TOOL_RESULT, VOICE_USER, VoiceBridge } from "./voice.ts";

assert.ok(faux, "run with FRONTDESK_FAUX=1");
await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

const text = (message: Message | undefined) => {
	const content = message?.content as string | { type: string; text?: string }[] | undefined;
	return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};
const until = async (check: () => Promise<boolean>, label: string) => {
	for (let tries = 0; tries < 600; tries++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${label}`);
};
const entries = async (session: Awaited<ReturnType<typeof openSession>>) => {
	const view = await session.root.viewState(context);
	const value = view.value.entries;
	view.dispose();
	return value;
};

setReportSink({ kind: "text" });
let session = await openSession();
await (await session.root.submit({ type: "input", content: "Please implement a hello world script" }, context)).wait(context);
await until(async () => (await entries(session)).some((e) => text(e.model?.[0]).startsWith("Update from the team")), "text report");
const workers = await session.harness.snapshot(WorkersDoc, session.root.id, context);
assert.ok(workers?.workers["job-1"], "worker job-1 recorded");
console.log("text frontend: delegated, worker answered, frontdesk relayed the report");
await session.harness.close(context);

const delivered: Report[] = [];
setReportSink({ kind: "voice", deliver: (report) => delivered.push(report) });
session = await openSession();
session.harness.resume();
const before = (await entries(session)).length;
const result = await delegate(session.host, { action: "start", name: "voice-job", task: "read the docs", worker: "sol" }, "voice:test", context);
assert.match(result.text, /Started worker voice-job/);
await until(async () => delivered.length > 0, "voice report");
await until(async () => (await entries(session)).some((e) => e.kind === "app.report"), "voice report entry");
const after = await entries(session);
assert.ok(!after.slice(before).some((e) => e.kind === "pi.assistant"), "voice mode must not start a text generation");
const status = await delegate(session.host, { action: "status" }, "voice:status", context);
assert.match(status.text, /job-1 .*voice-job/s);
console.log("voice frontend: same delegate() path, report delivered to the voice sink, no text generation");

const items = seedItems(after);
assert.ok(items.length > 0);
assert.equal(sessionConfig().tools[0]!.name, "delegate");
console.log(`voice seeding: ${items.length} realtime items from the shared session`);

const bridge = new VoiceBridge(session);
setReportSink({ kind: "voice", deliver: (report) => bridge.deliver(report) });
const sent: { type: string; item?: { type: string; role?: string } }[] = [];
const call = bridge.attach("call_test", { send: (event) => sent.push(event as never), close: () => {} });
call.open();
await bridge.settled();
assert.ok(sent.filter((e) => e.type === "conversation.item.create").length >= items.length, "seeded the call");
const mark = (await entries(session)).length;
call.event({ type: "input_audio_buffer.committed", item_id: "item_1" });
call.event({ type: "response.created" });
call.event({
	type: "response.done",
	response: {
		status: "completed",
		output: [
			{ type: "message", content: [{ type: "output_audio", transcript: "On it, handing that off." }] },
			{
				type: "function_call",
				call_id: "call_1",
				name: "delegate",
				arguments: JSON.stringify({ action: "start", name: "voice-2", task: "Fix the login bug", worker: "opus" }),
			},
		],
	},
});
call.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Can you fix the login bug?" });
await bridge.settled();
const kinds = (await entries(session)).slice(mark).map((e) => e.kind);
assert.deepEqual(kinds.slice(0, 3), [VOICE_USER, VOICE_ASSISTANT, VOICE_TOOL_RESULT]);
assert.ok(sent.some((e) => e.item?.type === "function_call_output"), "function output sent to realtime");
assert.equal(sent.at(-1)?.type, "response.create");
console.log("voice bridge: transcript, tool call and tool result written in order to the shared session");
call.event({ type: "response.created" });
await until(async () => (await entries(session)).filter((e) => e.kind === "app.report").length >= 2, "second voice report");
call.event({ type: "response.done", response: { status: "completed", output: [] } });
await bridge.settled();
assert.ok(sent.some((e) => e.item?.role === "system"), "report injected into the realtime call");
console.log("voice bridge: worker report queued during a response and injected after it");
call.closed();

setReportSink({ kind: "text" });
const settled = await (await session.root.submit({ type: "input", content: "hello again" }, context)).wait(context);
assert.equal(settled.status, "done", "text frontend continues the session after voice turns");
console.log("handoff: text frontend answered on top of the voice turns");
await session.harness.close(context);
console.log("ok");
