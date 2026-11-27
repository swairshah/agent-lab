import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { fakeHarness, here, tempDir } from "./helpers.ts";

const BIN = join(here, "..", "bin", "pid0.mjs");

function setup() {
	const home = tempDir("pid0-home-");
	const work = tempDir("pid0-work-");
	writeFileSync(
		join(home, "settings.json"),
		JSON.stringify({
			defaultHarness: "one",
			harnesses: { claude: { disabled: true }, codex: { disabled: true }, antigravity: { disabled: true }, pi: { disabled: true }, one: fakeHarness("one", { FAKE_STATE: join(work, "state.json") }), two: fakeHarness("two", { FAKE_LEGACY_MODELS: "1" }) },
		}),
	);
	const run = (args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, ["--no-warnings", BIN, ...args], { cwd: work, env: { ...process.env, PID0_DIR: home }, stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			child.stdout.on("data", (c) => (out += c));
			child.stderr.on("data", (c) => (err += c));
			child.on("exit", (code) => resolve({ out, err, code: code ?? -1 }));
			child.stdin.end(stdin ?? "");
		});
	return { home, work, run };
}

test("print mode answers, continues, and switches harness and model", async () => {
	const { run, work, home } = setup();
	const first = await run(["-p", "hello there"]);
	assert.equal(first.code, 0, first.err);
	assert.match(first.out, /^\[one\/alpha\/medium\/default\] echo: hello there \(prompt 1, context no/);

	const second = await run(["-c", "--model", "one/beta:high", "-p", "again"]);
	assert.match(second.out, /^\[one\/beta\/high\/default\] echo: again \(prompt 2, context no/);

	const third = await run(["-c", "--harness", "two", "--model", "gamma", "-p", "who"]);
	assert.match(third.out, /^\[two\/gamma-large.*prompt 1, context yes/);

	writeFileSync(join(work, "facts.txt"), "the answer is 7\n");
	const piped = await run(["--no-session", "@facts.txt", "what is it"], "piped words\n");
	assert.match(piped.out, /echo: piped words\n\n<file name=".*facts.txt">\nthe answer is 7\n\n<\/file>\n\nwhat is it/);

	const dirs = readdirSync(join(home, "sessions"));
	assert.equal(dirs.length, 1);
	assert.equal(readdirSync(join(home, "sessions", dirs[0]!)).filter((f) => f.endsWith(".sqlite")).length, 1);
});

test("json mode emits a session header and events", async () => {
	const { run, work } = setup();
	writeFileSync(join(work, "facts.txt"), "seven\n");
	const result = await run(["--mode", "json", "--no-session", "read facts.txt"]);
	const records = result.out.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records[0].type, "session");
	const types = records.map((r) => r.type);
	for (const type of ["agent_start", "turn_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "message_end", "turn_end", "agent_end", "agent_settled"]) assert.ok(types.includes(type), `missing ${type}`);
	assert.equal(types.at(-1), "agent_settled");
});

test("rpc mode takes commands and reports state", async () => {
	const { run } = setup();
	const commands = [
		{ id: "1", type: "get_state" },
		{ id: "2", type: "set_model", modelId: "beta" },
		{ id: "3", type: "get_available_models" },
		{ id: "4", type: "prompt", message: "from rpc" },
		{ id: "5", type: "nope" },
	];
	const result = await run(["--mode", "rpc", "--no-session"], `${commands.map((c) => JSON.stringify(c)).join("\n")}\n`);
	const records = result.out.trim().split("\n").map((line) => JSON.parse(line));
	const response = (id: string) => records.find((r) => r.type === "response" && r.id === id);
	assert.equal(response("1").data.harness, "one");
	assert.deepEqual(response("2").data, { harness: "one", model: "beta" });
	assert.deepEqual(response("3").data.models.map((m: { id: string }) => m.id), ["alpha", "beta", "gamma-large"]);
	assert.deepEqual(response("4").data, { disposition: "started" });
	assert.equal(response("5").success, false);
	const answer = records.findLast((r) => r.type === "message_end" && r.message.role === "assistant");
	assert.match(answer.message.content[0].text, /^\[one\/beta.*echo: from rpc/);
	assert.equal(records.at(-1).type, "agent_settled");
});

test("sessions: --session-id, --fork, --session by partial id, --export", async () => {
	const { run, work, home } = setup();
	await run(["--session-id", "alpha-1", "-n", "First", "-p", "one"]);
	const again = await run(["--session-id", "alpha-1", "-p", "two"]);
	assert.match(again.out, /prompt 2, context no/);
	const forked = await run(["--fork", "alpha", "--session-id", "beta-2", "-p", "three"]);
	assert.match(forked.out, /prompt 1, context yes/);
	const partial = await run(["--session", "beta", "-p", "four"]);
	assert.match(partial.out, /prompt 2, context no/);
	const missing = await run(["--session", "zzz", "-p", "x"]);
	assert.equal(missing.code, 2);
	assert.match(missing.err, /no session matches "zzz"/);
	const exported = await run(["--export", findSqlite(home, "alpha-1"), join(work, "out.html")]);
	assert.equal(exported.code, 0, exported.err);
	const html = readFileSync(join(work, "out.html"), "utf8");
	assert.match(html, /<title>First<\/title>/);
	assert.match(html, /echo: two/);
});

function findSqlite(home: string, id: string): string {
	const root = join(home, "sessions");
	for (const dir of readdirSync(root)) for (const file of readdirSync(join(root, dir))) if (file.endsWith(`${id}.sqlite`)) return join(root, dir, file);
	throw new Error(`no session ${id}`);
}

test("subcommands: harnesses, mcp, list-models, auth check", async () => {
	const { run, work } = setup();
	const harnesses = await run(["harnesses"]);
	assert.match(harnesses.out, /✓ one\s+Fake one/);
	assert.doesNotMatch(harnesses.out, /claude/);

	assert.equal((await run(["mcp", "add", "demo", "--env", "A=1", "--", "echo", "hi"])).code, 0);
	assert.match((await run(["mcp", "list"])).out, /demo\s+echo hi/);
	assert.match((await run(["--no-session", "-p", "x"])).out, /mcp 1\)/);
	assert.match((await run(["--no-session", "--no-mcp", "-p", "x"])).out, /mcp 0\)/);
	await run(["mcp", "remove", "demo"]);
	assert.match((await run(["mcp", "list"])).out, /no MCP servers/);

	const models = await run(["--list-models"]);
	assert.match(models.out, /one\/alpha\s+one alpha {2}\(current\)/);
	assert.match(models.out, /two\/gamma-large/);
	assert.match((await run(["--list-models", "beta"])).out, /^one\/beta.*\ntwo\/beta.*\n$/);

	const check = await run(["auth", "check", "one"]);
	assert.equal(check.out.trim(), "ready");
	assert.ok(existsSync(work));
});

test("pi's harness-owned options are refused with the reason", async () => {
	const { run } = setup();
	const result = await run(["--tools", "read", "-p", "x"]);
	assert.equal(result.code, 2);
	assert.match(result.err, /the harness owns its tools/);
	assert.throws(() => parseArgs(["--fork", "a", "--continue"]), /--fork cannot be combined/);
	assert.throws(() => parseArgs(["--session-id", "-bad"]), /--session-id/);
	const parsed = parseArgs(["-p", "--model", "claude/opus:high", "@a.txt", "hi", "--", "-not-a-flag"]);
	assert.deepEqual([parsed.print, parsed.model, parsed.files, parsed.messages], [true, "claude/opus:high", ["a.txt"], ["hi", "-not-a-flag"]]);
});
