// /sync end to end: Ada's pi (pi in RPC mode with this extension and a scripted model, test/faux-pi.ts) syncs with a
// local syncpi server (its scripted model too), and Bob takes turns with her through the server's agent. Checks that
// the thread and Ada's pi session hold the same conversation, that pi's own tools keep working, and that the two
// agents take turns: steering, waiting, stopping.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, type Item, type ServerMessage, Thread } from "syncpi/client";
import { WebSocketServer } from "ws";

const here = import.meta.dirname;
const root = mkdtempSync(join(tmpdir(), "syncpi-ext-test-"));
let checks = 0;
const ok = (text: string) => console.log(`✓ ${++checks}. ${text}`);
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`✗ ${message}`);
}
async function until<T>(what: string, probe: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value) return value as NonNullable<T>;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

const project = join(root, "proj");
mkdirSync(project);
writeFileSync(join(project, "a.txt"), "hello\n");
spawnSync("git", ["init", "-q"], { cwd: project });
const env = { ...process.env, SYNCPI_HOME: join(root, "syncpi"), PI_CODING_AGENT_DIR: join(root, "pi-agent") };

type Record = { type: string; [key: string]: unknown };
const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join(""));

/** A pi in RPC mode in `cwd`, with this extension and the scripted model. */
function startPi(cwd: string) {
	const records: Record[] = [];
	const child: ChildProcess = spawn(
		"pi",
		["--mode", "rpc", "-e", join(here, "../src/index.ts"), "-e", join(here, "faux-pi.ts"), "--provider", "pifaux", "--model", "faux-1", "--session-dir", join(root, "sessions")],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let buffer = "";
	child.stdout!.on("data", (chunk) => {
		buffer += chunk;
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i).replace(/\r$/, "");
			buffer = buffer.slice(i + 1);
			if (line) records.push(JSON.parse(line) as Record);
		}
	});
	const out = { records, stderr: "", child };
	child.stderr!.on("data", (d) => (out.stderr += d));
	let ids = 0;
	const send = (command: object) => child.stdin!.write(`${JSON.stringify({ id: String(++ids), ...command })}\n`);
	const notes = () => records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));
	const answers = () => records.flatMap((r) => (r.type === "message_end" && (r.message as { role: string }).role === "assistant" ? [textOf((r.message as { content: unknown }).content)] : []));
	const settled = () => records.filter((r) => r.type === "agent_settled").length;
	/** Sends a prompt and waits until its run has settled. */
	async function prompt(message: string): Promise<string> {
		const before = settled();
		send({ type: "prompt", message });
		await until(`pi to answer "${message}"`, () => settled() > before, 30_000);
		return answers().at(-1) ?? "";
	}
	return { ...out, send, notes, prompt };
}

// Ada's pi.
const ada = startPi(project);
const { records, send, notes, prompt } = ada;
const pi = ada.child;

// Bob's terminal: a plain client of the server.
const bob = { thread: new Thread(), messages: [] as ServerMessage[], busySeen: false, liveTools: new Set<string>() };
let bobConn: Connection | undefined;
const items = () => bob.thread.state.items;
const text = (item: Item) => ("text" in item ? item.text : item.kind === "tool" ? `${item.name}: ${item.output}` : "");
let bobRequests = 0;
const bobSays = (message: string, mode: "interrupt" | "followUp" | "steer" = "interrupt") => bobConn!.send({ type: "submit", requestId: `bob-${++bobRequests}`, text: message, mode, where: "vm" });

try {
	// 1. A conversation before syncing.
	check((await prompt("hello before sync")) === "(pi) hello before sync", "pi answers on its own");

	// 2. /sync shares it: a local server, with what the session had so far.
	send({ type: "prompt", message: "/sync --local --faux --name Ada" });
	await until("the session to be synced", () => notes().find((n) => n.startsWith("Synced with")), 60_000);
	send({ type: "prompt", message: "/session-share" });
	const link = await until("a share link", () => notes().find((n) => n.startsWith("Share this link"))?.match(/(http\S+)\/s\/([\w-]+)/));
	const joined = (await (await fetch(`${link[1]}/api/join`, { method: "POST", body: JSON.stringify({ invite: link[2], name: "Bob" }) })).json()) as { token: string };
	bobConn = new Connection(link[1]!, joined.token);
	bobConn.onMessage = (m) => {
		bob.messages.push(m);
		if (m.type === "events" && m.conv === "main") {
			bob.thread.apply(m.events);
			if (bob.thread.state.busy) bob.busySeen = true;
			for (const e of m.events as { type: string; toolName?: string }[]) if (e.type === "tool_execution_start" && e.toolName) bob.liveTools.add(e.toolName);
		}
		if (m.type === "history" && m.conv === "main") bob.thread.prepend(m.entries);
	};
	bobConn.start();
	await until("Bob to see Ada's earlier conversation", () => items().some((i) => i.kind === "assistant" && i.text === "(pi) hello before sync"));
	const first = items().find((i) => i.kind === "user");
	check(first?.kind === "user" && first.author === "Ada" && first.text === "hello before sync", `the thread starts with Ada's message, by Ada (${JSON.stringify(first)})`);
	ok("/sync shares the pi session: the thread starts with what it had, Ada's message and pi's answer");

	// 3. A turn in Ada's pi, with a tool only her pi has: Bob watches it live, and the thread gets all of it.
	check((await prompt("use my tool")) === "(pi) my_tool said: contents of a.txt: hello from my_tool", "pi uses its own tool");
	await until("Bob to see the answer", () => items().some((i) => i.kind === "assistant" && i.text.startsWith("(pi) my_tool said")));
	const tool = items().find((i) => i.kind === "tool" && i.name === "my_tool");
	check(tool?.kind === "tool" && tool.status === "done" && tool.output.includes("hello from my_tool"), `the thread has the tool call and its result (${JSON.stringify(tool)})`);
	check(bob.busySeen, "Bob saw the run going");
	const order = items().flatMap((i) => (i.kind === "user" && i.text === "use my tool" ? ["user"] : i.kind === "tool" && i.name === "my_tool" ? ["tool"] : i.kind === "assistant" && i.text.startsWith("(pi) my_tool said") ? ["answer"] : []));
	check(order.join(" ") === "user tool answer", `in order: the message, the tool, the answer (${order.join(" ")})`);
	await until("the turn to end", () => !bob.thread.state.busy);
	ok("a turn in Ada's pi, with a tool only her pi has, reaches the thread in order and in full");

	// 4. Bob's turn runs on the server's agent, which has Ada's pi turn as its own history.
	bobSays("what do you see");
	const seen = await until("the server's answer", () => items().flatMap((i) => (i.kind === "assistant" && !i.streaming && i.text.startsWith("(faux) I see") ? [i.text] : []))[0]);
	check(seen.includes("user: [Ada, in their pi] use my tool") && seen.includes("assistant:  +my_tool") && seen.includes("toolResult(my_tool): contents of a.txt"), `the server's agent sees Ada's turn as messages (${seen})`);
	ok("Bob's turn runs on the server's agent, which sees Ada's pi turn as real messages (tool call and result)");

	// 5. Ada's pi takes in Bob's turn: her model gets it as the messages it was.
	await until("Ada's pi to take in Bob's turn", () => records.some((r) => r.type === "message_end" && (r.message as { customType?: string }).customType === "syncpi" && textOf((r.message as { content: unknown }).content).startsWith("(faux) I see")));
	const adaSees = await prompt("what do you see");
	check(adaSees.includes("user: [Bob, running on the session VM] what do you see") && adaSees.includes("assistant: (faux) I see"), `Ada's model sees Bob's turn as a user message and an answer (${adaSees})`);
	check(!adaSees.includes("custom:"), "not as custom messages");
	ok("Ada's pi takes in Bob's turn, and her model sees it as a user message and an assistant answer");

	// 6. Bob steers Ada's run: her pi adds it at its next step, and the thread has it as Bob's.
	const steered = prompt("slow");
	// Bob sees the tool running while it runs, from Ada's pi's live events.
	await until("Bob to see Ada's tool running", () => items().some((i) => i.kind === "tool" && i.name === "sleep_tool" && i.status === "running"));
	bobSays("also mention cats", "steer");
	const steerAnswer = await steered;
	check(steerAnswer.includes("[Bob, steering] also mention cats"), `pi's model got Bob's steer (${steerAnswer})`);
	await until("the steer in the thread", () => items().find((i) => i.kind === "user" && i.text === "also mention cats"));
	const steer = items().find((i) => i.kind === "user" && i.text === "also mention cats");
	check(steer?.kind === "user" && steer.author === "Bob", `the steer is Bob's in the thread (${JSON.stringify(steer)})`);
	const slowTurn = items().slice(items().findIndex((i) => i.kind === "user" && i.text === "slow"));
	const call = slowTurn.findIndex((i) => i.kind === "assistant" && i.text === "");
	const sleep = slowTurn.findIndex((i) => i.kind === "tool" && i.name === "sleep_tool");
	check(call >= 0 && call < sleep, `the tool's call comes before the tool (${call}, ${sleep})`);
	ok("Bob watches Ada's tool run live and steers her run: her pi's model gets it at the next step, and the thread shows it as Bob's");

	// 7. Bob (an editor) can't stop Ada's run: his message waits for her turn to end, then runs.
	const waited = prompt("slow");
	await until("Ada's second slow turn", () => bob.thread.state.busy);
	const sentAt = Date.now();
	bobSays("after ada");
	await until("Bob to be told it's queued", () => bob.messages.some((m) => m.type === "notice" && m.text.startsWith("Queued: Ada's pi has the turn")));
	check(!(await waited).includes("stopped"), "Ada's run wasn't stopped");
	const after = await until("Bob's answer", () => items().findIndex((i) => i.kind === "assistant" && i.text === "(faux) after ada") + 1);
	const adaDone = items().findLastIndex((i) => i.kind === "assistant" && i.text.startsWith("(pi) slept"));
	check(adaDone >= 0 && adaDone < after - 1, "Bob's message ran after Ada's turn");
	check(Date.now() - sentAt > 1_500, "it waited for the turn");
	ok("Bob can't stop Ada's run: his message waits for her turn to end, then runs on the server");

	// 8. Ada, from another of her clients (an admin there), stops her own pi's run; her message runs next.
	const adaRecord = JSON.parse(readFileSync(join(root, "syncpi", "sessions", readdirSync(join(root, "syncpi", "sessions")).find((f) => /^\w+\.json$/.test(f))!), "utf8")) as { url: string; token: string };
	const adaWeb = new Connection(adaRecord.url, adaRecord.token);
	adaWeb.start();
	const stopped = prompt("slow");
	await until("Ada's third slow turn", () => bob.thread.state.busy);
	adaWeb.send({ type: "submit", requestId: "ada-web-1", text: "from the web", mode: "interrupt", where: "vm" });
	check((await stopped).length >= 0 && notes().some((n) => n === "Ada stopped this turn"), "Ada's pi was told its turn was stopped");
	await until("the web message's answer", () => items().some((i) => i.kind === "assistant" && i.text === "(faux) from the web"));
	ok("Ada stops her pi's run from her other client, and her message runs next");

	// 9. A message in Ada's pi stops Bob's server run (she's an admin), and runs right after.
	bobSays("run sleep 6");
	await until("Bob's server run", () => items().some((i) => i.kind === "tool" && i.status === "running"));
	const before = Date.now();
	check((await prompt("me first")) === "(pi) me first", "pi answers");
	check(Date.now() - before < 5_000, "without waiting for Bob's command");
	await until("Ada's answer in the thread", () => items().some((i) => i.kind === "assistant" && i.text === "(pi) me first"));
	ok("a message in Ada's pi stops Bob's server run (she's an admin) and runs at once");

	// 10. /sync stop: the session keeps the shared conversation, and pi carries on locally with it.
	const asked = () => items().filter((i) => i.kind === "user" && i.author === "Ada" && i.text === "what do you see").length;
	const askedBefore = asked();
	send({ type: "prompt", message: "/sync stop" });
	await until("syncing to stop", () => notes().some((n) => n.startsWith("Stopped syncing")));
	const local = await prompt("what do you see");
	check(local.includes("assistant: (faux) after ada") && local.includes("user: [Bob, running on the session VM] after ada"), `after /sync stop, pi still has the shared conversation (${local.slice(0, 200)})`);
	await new Promise((r) => setTimeout(r, 500));
	check(asked() === askedBefore, "and nothing more reaches the thread");
	ok("/sync stop: pi carries on locally with the whole shared conversation, and the thread hears no more");

	// 10. A server from before /sync (it ignores the turn and recordings): pi says so and carries on, unsynced.
	const oldServer = new WebSocketServer({ port: 0 });
	await new Promise((r) => oldServer.once("listening", r));
	oldServer.on("connection", (ws) => {
		ws.send(JSON.stringify({ type: "welcome", me: { id: "m", name: "Ada", role: "admin" }, session: {}, members: [] }));
		ws.send(JSON.stringify({ type: "events", conv: "main", events: [{ type: "snapshot", entries: [] }] }));
	});
	const oldProject = join(root, "old");
	mkdirSync(oldProject);
	const port = (oldServer.address() as { port: number }).port;
	writeFileSync(join(root, "syncpi", "sessions", "oldsrv1.json"), JSON.stringify({ id: "oldsrv1", name: "old", url: `http://127.0.0.1:${port}`, token: "t", role: "editor", dir: realpathSync(oldProject), compute: "remote", createdAt: Date.now() }));
	const old = startPi(oldProject);
	try {
		old.send({ type: "prompt", message: "/sync" });
		await until("the old session to be synced", () => old.notes().find((n) => n.startsWith("Synced with")));
		const started = Date.now();
		check((await old.prompt("hello old")) === "(pi) hello old", "pi answers");
		check(old.notes().some((n) => n.includes("may be older than /sync")), "pi says the server may need syncpi update");
		check(Date.now() - started < 15_000, "after a short wait");
		const again = Date.now();
		check((await old.prompt("again")) === "(pi) again" && Date.now() - again < 3_000, "and doesn't wait again");
	} finally {
		old.child.kill();
		oldServer.close();
	}
	ok("a server from before /sync: pi says it may need syncpi update, and carries on without waiting again");

	console.log(`\nAll ${checks} /sync checks passed.`);
} catch (error) {
	console.error(error);
	console.error(`--- pi stderr ---\n${ada.stderr.slice(-3000)}`);
	console.error(`--- notes ---\n${notes().join("\n")}`);
	console.error(`--- thread ---\n${items().map((i) => `${i.kind} ${"author" in i ? i.author : ""} ${text(i).slice(0, 100)}`).join("\n")}`);
	process.exitCode = 1;
} finally {
	bobConn?.close();
	pi.kill();
	// The session's server was started detached; its state is under this test's folder.
	spawnSync("pkill", ["-f", root]);
	rmSync(root, { recursive: true, force: true });
}
