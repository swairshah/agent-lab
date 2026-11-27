import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions, SessionStore } from "../src/store.ts";
import { answers, startSession, tempDir, testSettings } from "./helpers.ts";

test("a prompt is answered, streamed, and recorded in pi-durable", async () => {
	const { session, events, root, cwd } = await startSession();
	await session.promptAndWait("hello");
	assert.match(answers(events).at(-1)!, /^\[one\/alpha\/medium\/default\] echo: hello \(prompt 1, context no/);
	assert.ok(events.some((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta"));
	const kinds = (await session.messages()).map((i) => i.kind);
	assert.deepEqual(kinds, ["user", "assistant", "turn"]);
	assert.equal(session.totals.total, 30);
	assert.deepEqual(session.state.context, { used: 1000, size: 200000 });
	await session.dispose();
	const [info] = await listSessions(root, cwd);
	assert.equal(info!.messages, 2);
	assert.equal(info!.first, "hello");
});

test("model, thinking and mode are chosen inside the harness", async () => {
	const { session, events } = await startSession({ model: "one/gamma:high", mode: "plan" });
	await session.promptAndWait("hi");
	assert.match(answers(events).at(-1)!, /^\[one\/gamma-large\/high\/plan\]/);
	await session.setModel("beta");
	assert.equal(await session.cycleThinking(), "low");
	await session.promptAndWait("again");
	assert.match(answers(events).at(-1)!, /^\[one\/beta\/low\/plan\] echo: again \(prompt 2/);
	await assert.rejects(session.setModel("nope"), /no model matching "nope" \(it offers: alpha, beta, gamma-large\)/);
	const cycled = await session.cycleModel();
	assert.equal(cycled!.model, "gamma-large");
	await session.dispose();
});

test("a harness with the legacy models field is driven through session/set_model", async () => {
	const { session, events } = await startSession({ harness: "two", model: "x2" });
	await session.promptAndWait("hi");
	assert.match(answers(events).at(-1)!, /^\[two\/x2\//);
	const [listed] = await session.availableModels();
	assert.deepEqual(listed!.models.map((m) => m.id), ["x1", "x2"]);
	await session.dispose();
});

test("switching harness mid-session hands the other one the story so far", async () => {
	const { session, events } = await startSession();
	await session.promptAndWait("remember the word marmalade");
	await session.setHarness("two");
	await session.promptAndWait("what was the word?");
	assert.match(answers(events).at(-1)!, /^\[two\/x1.*prompt 1, context yes/);
	await session.promptAndWait("and again");
	assert.match(answers(events).at(-1)!, /prompt 2, context no/);
	await session.setModel("one/beta");
	await session.promptAndWait("back");
	assert.match(answers(events).at(-1)!, /^\[one\/beta.*prompt 2, context yes/);
	const items = await session.messages();
	assert.deepEqual(items.filter((i) => i.kind === "switch").map((i) => i.kind === "switch" && i.data.harness), ["two", "one"]);
	await session.dispose();
});

test("tools, file access, permissions and terminals go through the client", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "note.txt"), "forty-two\n");
	const { session, events } = await startSession({ dir });
	await session.promptAndWait("read note.txt");
	assert.equal(answers(events).at(-1), "The file says: forty-two");
	const items = await session.messages();
	assert.deepEqual(items.map((i) => i.kind), ["user", "assistant", "tool", "assistant", "turn"]);
	const tool = items.find((i) => i.kind === "tool")!;
	assert.ok(tool.kind === "tool" && tool.data.status === "completed" && tool.data.output === "forty-two\n" && tool.data.kind === "read");
	assert.ok(events.some((e) => e.type === "tool_execution_start") && events.some((e) => e.type === "tool_execution_end" && !e.isError));

	await session.promptAndWait("write out.txt hello there");
	assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "hello there");
	session.permissions = "deny";
	await session.promptAndWait("write nope.txt x");
	assert.match(answers(events).at(-1)!, /Not allowed \(no\)/);
	session.permissions = "ask";
	session.onPermission = async (request) => ({ outcome: { outcome: "selected", optionId: request.options[1]!.optionId } });
	await session.promptAndWait("write asked.txt y");
	assert.match(answers(events).at(-1)!, /Wrote asked.txt \(always\)/);

	await session.promptAndWait("run echo from-terminal");
	assert.equal(answers(events).at(-1), "exit 0: from-terminal");
	await session.dispose();
});

test("abort cancels the turn; queued prompts run after the current one", async () => {
	const { session, events } = await startSession();
	assert.equal(await session.prompt("slow"), "started");
	await new Promise((r) => setTimeout(r, 150));
	const settled = session.waitForSettled();
	await session.abort();
	assert.deepEqual(await settled, { aborted: true });
	const turn = (await session.messages()).findLast((i) => i.kind === "turn")!;
	assert.ok(turn.kind === "turn" && turn.data.stopReason === "cancelled");

	await session.prompt("first");
	assert.equal(await session.prompt("second"), "queued");
	assert.deepEqual(session.queued, ["second"]);
	await session.waitForSettled();
	const all = answers(events);
	assert.match(all.at(-2)!, /echo: first/);
	assert.match(all.at(-1)!, /echo: second/);
	await session.dispose();
});

test("a session is resumed natively when the harness can, and re-told when it cannot", async () => {
	const dir = tempDir();
	const state = join(dir, "state.json");
	const settings = testSettings({ one: { FAKE_STATE: state } });
	const first = await startSession({ dir, settings });
	await first.session.promptAndWait("one");
	const file = first.session.store.file!;
	await first.session.dispose();

	const second = await startSession({ dir, settings, store: await SessionStore.open(file) });
	await second.session.promptAndWait("two");
	assert.match(answers(second.events).at(-1)!, /prompt 2, context no/);
	await second.session.dispose();

	const forgetful = testSettings({ one: { FAKE_CAPS: "none" } });
	const third = await startSession({ dir, settings: forgetful, store: await SessionStore.open(file) });
	await third.session.promptAndWait("three");
	assert.match(answers(third.events).at(-1)!, /prompt 1, context yes/);
	await third.session.dispose();
});

test("tree, fork, clone and compact", async () => {
	const { session, events, root, cwd } = await startSession();
	await session.promptAndWait("a");
	await session.promptAndWait("b");
	const items = await session.messages();
	const firstAnswer = items.find((i) => i.kind === "turn")!.id;
	await session.navigate(firstAnswer);
	assert.deepEqual((await session.messages()).filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.data.text), ["a"]);
	await session.promptAndWait("c");
	assert.match(answers(events).at(-1)!, /echo: c \(prompt 1, context yes/);
	const tree = await session.store.tree();
	assert.equal(tree.branches.length, 2);
	assert.deepEqual(tree.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.data.text), ["a", "b", "c"]);

	await session.navigate(items.at(-1)!.id);
	assert.deepEqual((await session.messages()).filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.data.text), ["a", "b"]);
	assert.equal((await session.store.branches()).length, 2);

	const original = session.store.file;
	const cloned = await session.clone();
	assert.notEqual(cloned, original);
	assert.equal((await session.messages()).length, items.length);
	assert.equal((await listSessions(root, cwd)).length, 2);

	const summary = await session.compact("keep it short");
	assert.match(summary!, /echo: Write a handoff summary/);
	assert.deepEqual((await session.store.contextItems()).map((i) => i.kind), ["reset"]);
	await session.promptAndWait("after");
	assert.match(answers(events).at(-1)!, /prompt 1, context yes/);
	await session.dispose();
});

test("a session open in another process cannot be opened for writing", async () => {
	const { session } = await startSession();
	const file = session.store.file!;
	await session.promptAndWait("keep me");
	await session.dispose();
	writeFileSync(`${file}.lock`, String(process.ppid));
	await assert.rejects(SessionStore.open(file), /is open in another pid0/);
	const viewer = await SessionStore.open(file, { readOnly: true });
	await viewer.close();
	writeFileSync(`${file}.lock`, "999999999");
	const again = await SessionStore.open(file);
	await again.close();
});

test("an agent that is missing or fails is reported, not thrown", async () => {
	const settings = testSettings();
	settings.harnesses!.gone = { command: ["definitely-not-a-binary-xyz"] };
	const { session, events } = await startSession({ settings, harness: "gone" });
	await session.promptAndWait("hi");
	const notice = events.find((e) => e.type === "notice" && e.level === "error");
	assert.ok(notice && notice.type === "notice" && /cannot run/.test(notice.text));
	await session.setHarness("one");
	await session.promptAndWait("fail now");
	assert.ok(events.some((e) => e.type === "notice" && /failed on purpose/.test(e.text)));
	await session.promptAndWait("ok");
	assert.match(answers(events).at(-1)!, /echo: ok/);
	await session.dispose();
});

test("Claude Code gets the user's own login: an unapproved API key in the environment is not passed on", async () => {
	const { harnessEnv, resolveHarness } = await import("../src/harnesses.ts");
	const home = tempDir();
	const claude = resolveHarness("claude", {});
	const base = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "sk-ant-0123456789abcdefghijklmnop" };
	assert.deepEqual(harnessEnv(claude, base).dropped, ["ANTHROPIC_API_KEY"]);
	assert.equal(harnessEnv(claude, base).env.ANTHROPIC_API_KEY, undefined);
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [base.ANTHROPIC_API_KEY.slice(-20)] } }));
	assert.equal(harnessEnv(claude, base).env.ANTHROPIC_API_KEY, base.ANTHROPIC_API_KEY);
	const forced = resolveHarness("claude", { harnesses: { claude: { useApiKey: true } } });
	assert.equal(harnessEnv(forced, { ...base, CLAUDE_CONFIG_DIR: tempDir() }).env.ANTHROPIC_API_KEY, base.ANTHROPIC_API_KEY);
	const codex = resolveHarness("codex", {});
	assert.equal(harnessEnv(codex, { ...base, OPENAI_API_KEY: "sk-x" }).env.OPENAI_API_KEY, "sk-x");
});
