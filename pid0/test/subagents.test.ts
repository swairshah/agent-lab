import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ToolServer } from "../src/mcp-host.ts";
import { Pid0Session } from "../src/session.ts";
import { SessionStore } from "../src/store.ts";
import { Subagents } from "../src/subagents.ts";
import { startSession, tempDir, testSettings } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(options: Parameters<typeof startSession>[0] = {}) {
	const started = await startSession(options);
	const subagents = new Subagents(started.session);
	const close = async () => {
		await subagents.suspend();
		await started.session.dispose();
		await subagents.dispose();
	};
	return { ...started, subagents, close };
}

test("a subagent runs as a pi-durable task on the current harness and default model, and reports back", async () => {
	const { session, subagents, close } = await setup();
	const started = await subagents.dispatch({ prompt: "do the thing" });
	assert.equal(started.status, "working");
	assert.equal(started.harness, "one");
	assert.ok(started.task !== undefined);
	const done = await subagents.wait(started.id);
	assert.equal(done.status, "idle");
	assert.equal(done.turns, 1);
	assert.match(done.lastAnswer!, /^\[one\/alpha\/medium\/default\] echo: do the thing \(prompt 1, context no/);
	assert.deepEqual(done.activity.slice(0, 2).map((a) => a.slice(0, 14)), ["→ do the thing", "← [one/alpha/m"]);

	const other = await subagents.dispatch({ prompt: "second opinion", harness: "two", model: "x2", name: "reviewer" });
	await sleep(600);
	const settled = await subagents.status("reviewer");
	assert.equal(settled.status, "idle");
	assert.match(settled.lastAnswer!, /^\[two\/x2\//);
	assert.equal(other.name, "reviewer");

	const parentItems = await session.messages();
	const note = parentItems.find((i) => i.kind === "note");
	assert.ok(note && note.kind === "note" && /Subagent reviewer .* finished its work\.\n\n\[two\/x2/.test(note.data.content));
	assert.equal((await session.store.branches()).length, 1);
	await assert.rejects(subagents.dispatch({ prompt: "x", harness: "nope" }), /unknown harness "nope"/);
	await close();
});

test("the main agent can queue, steer, interrupt, pause, resume and stop a subagent", async () => {
	const { subagents, close } = await setup();
	const a = await subagents.dispatch({ prompt: "slow", name: "worker" });
	await sleep(250);
	assert.equal((await subagents.send("worker", "after", "queue")).queue.length, 1);
	const steered = await subagents.send("worker", "now", "steer");
	assert.equal(steered.status, "working");
	const done = await subagents.wait(a.id);
	assert.equal(done.status, "idle");
	assert.equal(done.queue.length, 0);
	const sent = done.activity.filter((line) => line.startsWith("→")).map((line) => line.slice(2));
	assert.deepEqual(sent, ["slow", "now", "after"]);
	assert.match(done.lastAnswer!, /echo: after/);

	await subagents.send("worker", "slow");
	await sleep(200);
	const paused = await subagents.pause("worker");
	assert.equal(paused.status, "paused");
	assert.equal(paused.interrupted, true);
	await subagents.send("worker", "held");
	await sleep(200);
	assert.equal((await subagents.status("worker")).status, "paused");
	await subagents.resume("worker");
	const resumed = await subagents.wait("worker");
	assert.match(resumed.lastAnswer!, /echo: held/);
	assert.ok(resumed.activity.some((line) => line.includes("Continue where you left off.")));

	await subagents.send("worker", "slow");
	await sleep(200);
	const interrupted = await subagents.interrupt("worker");
	assert.equal(interrupted.status, "idle");
	const stopped = await subagents.stop("worker");
	assert.equal(stopped.status, "stopped");
	await assert.rejects(subagents.send("worker", "more"), /was stopped/);
	await assert.rejects(subagents.status("ghost"), /no subagent "ghost"/);
	await close();
});

test("the subagent tools are served to the main agent over MCP", async () => {
	const { subagents, close } = await setup();
	const server = new ToolServer("pid0", () => subagents.tools());
	await server.start();
	const call = async (name: string, args: Record<string, unknown>) => {
		const response = await fetch(server.url!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
		const body = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
		return { text: body.result.content[0]!.text, isError: body.result.isError };
	};
	const list = (await (await fetch(server.url!, { method: "POST", headers: { Authorization: `Bearer ${server.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()) as { result: { tools: { name: string }[] } };
	assert.deepEqual(list.result.tools.map((t) => t.name), ["subagent_dispatch", "subagent_status", "subagent_wait", "subagent_send", "subagent_interrupt", "subagent_pause", "subagent_resume", "subagent_stop", "subagent_harnesses"]);
	const started = await call("subagent_dispatch", { prompt: "from the tool", harness: "two", name: "helper" });
	assert.match(started.text, /Started subagent helper \(id sub_\w+\) on Fake two/);
	const waited = await call("subagent_wait", { id: "helper", timeout_seconds: 20 });
	assert.match(waited.text, /helper \(sub_\w+\): idle[\s\S]*last answer:\n\[two\/x1.*echo: from the tool/);
	assert.match((await call("subagent_status", {})).text, /helper .*: idle/);
	assert.match((await call("subagent_send", { id: "helper", message: "again" })).text, /working/);
	assert.match((await call("subagent_harnesses", {})).text, /one \(Fake one\): available \(current, the default\)/);
	const bad = await call("subagent_wait", { id: "nobody" });
	assert.equal(bad.isError, true);
	await call("subagent_stop", { id: "helper" });
	server.close();
	await close();
});

test("a subagent's unfinished turn is picked up again after pid0 restarts", async () => {
	const dir = tempDir();
	const settings = testSettings({ one: { FAKE_STATE: join(dir, "state.json") } });
	const first = await setup({ dir, settings });
	await first.session.promptAndWait("keep this session");
	const file = first.session.store.file!;
	const started = await first.subagents.dispatch({ prompt: "slow", name: "long" });
	await sleep(300);
	await first.close();

	const store = await SessionStore.open(file);
	const session = await Pid0Session.start({ cwd: dir, root: join(dir, "sessions"), settings, store });
	const subagents = new Subagents(session);
	const before = await subagents.status("long");
	assert.equal(before.status, "working");
	assert.equal(before.id, started.id);
	const done = await subagents.wait("long", 20_000);
	assert.equal(done.status, "idle");
	assert.equal(done.lastStop, "end_turn");
	assert.match(done.lastAnswer!, /tick99/);
	await subagents.suspend();
	await session.dispose();
	await subagents.dispose();
});

test("subagents inherit pid0's skills, standing instructions and tool servers, but not the subagent tools", async () => {
	const { session, subagents, close } = await setup();
	const own = () => [{ type: "http" as const, name: "pid0", url: "http://127.0.0.1:1/mcp", headers: [] }];
	const shared = () => [{ type: "http" as const, name: "pi-extensions", url: "http://127.0.0.1:2/mcp", headers: [] }];
	session.mcpProviders.push(own, shared);
	subagents.exclude(own);
	session.baseInstructions = "Skills: greet";
	session.extraInstructions = "Answer in rhyme.";
	session.expand = (text) => text.replace("/shout", "LOUDLY");
	const started = await subagents.dispatch({ prompt: "/shout hi" });
	const done = await subagents.wait(started.id);
	assert.match(done.lastAnswer!, /echo: LOUDLY hi \(prompt 1, context no, mcp 1, rules Skills: greet\n\nAnswer in rhyme\.\)/);
	await session.promptAndWait("main");
	const main = (await session.messages()).findLast((i) => i.kind === "assistant")!;
	assert.ok(main.kind === "assistant" && /mcp 2, rules Skills: greet/.test(main.data.text));
	await close();
});
