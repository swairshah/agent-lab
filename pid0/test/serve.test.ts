import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { runAttach } from "../src/modes/attach.ts";
import { serve } from "../src/modes/serve.ts";
import { Subagents } from "../src/subagents.ts";
import { startSession } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(options: Parameters<typeof startSession>[0] = {}) {
	const started = await startSession(options);
	const subagents = new Subagents(started.session);
	const served = await serve(started.session, { host: "127.0.0.1", port: 0, subagents });
	const rpc = async (type: string, extra: Record<string, unknown> = {}) => (await (await fetch(`${served.url}/rpc`, { method: "POST", body: JSON.stringify({ type, ...extra }) })).json()) as { success: boolean; data?: any; error?: string };
	const events: { type: string; [key: string]: any }[] = [];
	const abort = new AbortController();
	const stream = (async () => {
		const response = await fetch(`${served.url}/events`, { signal: abort.signal });
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end < 0) break;
				for (const line of buffer.slice(0, end).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
				buffer = buffer.slice(end + 2);
			}
		}
	})().catch(() => {});
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 300; i++) {
			if (check()) return;
			await sleep(25);
		}
		assert.fail(`timed out waiting for ${what}`);
	};
	const close = async () => {
		abort.abort();
		await stream;
		await served.close();
		await subagents.suspend();
		await started.session.dispose();
		await subagents.dispose();
	};
	await until(() => events.some((e) => e.type === "state"), "the first state");
	return { ...started, served, rpc, events, until, close, subagents };
}

test("pid0 serve: the web page, commands over HTTP and the event stream", async () => {
	const s = await start();
	const page = await (await fetch(`${s.served.url}/`)).text();
	assert.match(page, /<title>pid0<\/title>/);
	assert.equal((await fetch(`${s.served.url}/nope`)).status, 404);
	assert.equal(s.events[0]!.state.harness, "one");
	assert.equal(s.served.clients(), 1);

	assert.deepEqual((await s.rpc("prompt", { message: "over http" })).data, { disposition: "started" });
	await s.until(() => s.events.some((e) => e.type === "agent_settled"), "the turn to settle");
	const text = s.events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent.delta).join("");
	assert.match(text, /echo: over http \(prompt 1/);
	assert.ok(s.events.findLast((e) => e.type === "state")!.state.totals.total > 0);

	assert.deepEqual((await s.rpc("set_model", { modelId: "beta" })).data, { harness: "one", model: "beta" });
	assert.equal((await s.rpc("get_state")).data.model, "beta");
	assert.equal((await s.rpc("get_messages")).data.messages.filter((m: { kind: string }) => m.kind === "user").length, 1);
	assert.equal((await s.rpc("nope")).success, false);
	await s.close();
});

test("pid0 serve: permission requests go to the clients, and any of them can answer", async () => {
	const s = await start({ permissions: "ask" });
	await s.rpc("prompt", { message: "write served.txt from-the-web" });
	await s.until(() => s.events.some((e) => e.type === "permission_request"), "the permission request");
	const ask = s.events.find((e) => e.type === "permission_request")!;
	assert.equal((await s.rpc("get_pending")).data.permissions[0].id, ask.id);
	await s.rpc("permission_response", { id: ask.id, optionId: ask.options[0].optionId });
	await s.until(() => s.events.some((e) => e.type === "agent_settled"), "the turn to settle");
	assert.ok(s.events.some((e) => e.type === "permission_resolved"));
	assert.equal(readFileSync(join(s.cwd, "served.txt"), "utf8"), "from-the-web");
	assert.equal((await s.rpc("set_permissions", { policy: "deny" })).data.policy, "deny");
	await s.rpc("prompt", { message: "write no.txt x" });
	await s.until(() => s.events.filter((e) => e.type === "agent_settled").length === 2, "the second turn");
	assert.ok(!existsSync(join(s.cwd, "no.txt")));
	await s.close();
});

test("pid0 serve: subagents over HTTP, and pid0 attach from a terminal", async () => {
	const s = await start();
	const dispatched = await s.rpc("subagent", { action: "dispatch", prompt: "side job", name: "side" });
	assert.equal(dispatched.data.name, "side");
	await s.until(() => s.events.some((e) => e.type === "subagent" && e.status === "idle"), "the subagent to finish");
	assert.equal((await s.rpc("get_subagents")).data.subagents[0].status, "idle");

	const input = new PassThrough();
	const output = new PassThrough();
	let seen = "";
	output.on("data", (chunk) => (seen += chunk));
	const attached = runAttach(s.served.url, input, output);
	const wait = async (pattern: RegExp, what: string) => {
		for (let i = 0; i < 300 && !pattern.test(seen); i++) await sleep(25);
		assert.match(seen, pattern, what);
	};
	await wait(/pid0 at http:\/\/127\.0\.0\.1:\d+ · Fake one/, "the banner");
	await sleep(100);
	input.write("hello from ssh\n");
	await wait(/echo: hello from ssh/, "the streamed answer");
	input.write("/subagents\n");
	await wait(/side: idle \(one\)/, "the subagent list");
	input.write("/model beta\n");
	await wait(/model: beta/, "the model change");
	input.write("/quit\n");
	assert.equal(await attached, 0);
	assert.equal(await runAttach("http://127.0.0.1:1", new PassThrough(), new PassThrough()), 1);
	await s.close();
});

test("the pid0 serve command starts, answers, and stops cleanly on SIGTERM", async () => {
	const { spawn } = await import("node:child_process");
	const { writeFileSync } = await import("node:fs");
	const { fakeHarness, here, tempDir } = await import("./helpers.ts");
	const home = tempDir("pid0-home-");
	const work = tempDir("pid0-work-");
	writeFileSync(join(home, "settings.json"), JSON.stringify({ defaultHarness: "one", harnesses: { one: fakeHarness("one") } }));
	const child = spawn(process.execPath, ["--no-warnings", join(here, "..", "bin", "pid0.mjs"), "serve", "--port", "0"], { cwd: work, env: { ...process.env, PID0_DIR: home, PID0_PI_DIR: join(home, "pi") }, stdio: ["ignore", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", (chunk) => (err += chunk));
	for (let i = 0; i < 400 && !/web:\s+http/.test(err); i++) await sleep(25);
	const url = /web:\s+(http:\/\/127\.0\.0\.1:\d+)\//.exec(err)?.[1];
	assert.ok(url, err);
	const state = (await (await fetch(`${url}/rpc`, { method: "POST", body: JSON.stringify({ type: "get_state" }) })).json()) as { data: { harness: string; permissions: string } };
	assert.equal(state.data.harness, "one");
	assert.equal(state.data.permissions, "ask");
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	child.kill("SIGTERM");
	assert.equal(await exited, 0);
	assert.throws(() => parseServe(["--host", "x"]), /--host is an option of pid0 serve/);
});

function parseServe(argv: string[]) {
	return parseArgs(argv);
}
