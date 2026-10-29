#!/usr/bin/env node
// session-share: one pi-durable session that Claude Code, Codex and pi all work in, taking turns.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, memberName, projectOf, readInfo, Client } from "./client.ts";
import { findRollout } from "./codex.ts";
import { type Item, narrateItem } from "./narrate.ts";

const USAGE = `session-share: one shared session for Claude Code, Codex and pi, in this folder

  session-share claude [claude args…]       Claude Code, recorded into the session and told what the others did
  session-share codex [--new] [-m model] <prompt>
                                            one Codex turn (resumes this session's Codex thread)
  session-share pi [--model p/m] <prompt>   one pi turn, natively on the shared session
  session-share log                         the whole session as text
  session-share checkpoint <label>          tag the session and the files as they are now
  session-share checkpoints                 the tags so far
  session-share fork <label>                go back to a checkpoint: the session and the files (what is there now
                                            is tagged first, so it can be gone back to)
  session-share branches                    the forks so far
  session-share status | view | stop

  SESSION_SHARE_MEMBER sets who you are (default: git user.name).`;

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const project = projectOf();
	const member = memberName(project);
	switch (command) {
		case "serve": {
			const { serve } = await import("./server.ts");
			await serve(project, { model: process.env.SESSION_SHARE_MODEL, faux: process.env.SESSION_SHARE_FAUX === "1" });
			return -1;
		}
		case "hook":
			return hook(rest[0] ?? "claude-code", project, member);
		case "claude":
			return claude(project, member, rest);
		case "codex":
			return codex(project, member, rest);
		case "pi":
			return pi(project, member, rest);
		case "log": {
			const { items } = await (await connect(project)).call<{ items: Item[] }>("/items");
			for (const item of items) {
				const text = narrateItem(item);
				if (text) console.log(`${text}\n`);
			}
			return 0;
		}
		case "checkpoint": {
			const label = rest.join(" ").trim();
			if (!label) throw new Error("usage: session-share checkpoint <label>");
			const c = await (await connect(project)).call("/checkpoint", { label, by: member });
			console.log(`tagged "${c.label}" at entry ${c.upTo}${c.git ? `; files at ${c.git.slice(0, 10)} (refs/session-share/checkpoints/…)` : ""}`);
			return 0;
		}
		case "checkpoints": {
			const { checkpoints } = await (await connect(project)).call("/checkpoints");
			for (const c of checkpoints) console.log(`${new Date(c.at).toLocaleString()}  ${c.label}  by ${c.by}  entry ${c.upTo}${c.git ? `  git ${c.git.slice(0, 10)}` : ""}`);
			return 0;
		}
		case "fork": {
			const label = rest.join(" ").trim();
			if (!label) throw new Error("usage: session-share fork <label>");
			const f = await (await connect(project)).call("/fork", { label, by: member }).catch((error) => {
				if (error.status !== 409) throw error;
				console.error(error.message);
				process.exit(2);
			});
			console.log(`back at "${f.label}"${f.git ? `, files restored from ${f.git.slice(0, 10)}` : ""} (branch ${f.branch}).`);
			console.log(`What was there before is tagged "${f.saved}". Claude Code and Codex sessions from before are retired here: start new ones.`);
			return 0;
		}
		case "branches": {
			const { active, branches } = await (await connect(project)).call("/branches");
			if (branches.length === 0) console.log(`* ${active}  the session (no forks yet)`);
			for (const b of branches)
				console.log(`${b.id === active ? "*" : " "} ${b.id}  ${b.label ? `back to "${b.label}" from ${b.parent}, by ${b.by}, ${new Date(b.created).toLocaleString()}` : "the session as it began"}`);
			return 0;
		}
		case "status": {
			const client = await connect(project, false).catch(() => undefined);
			if (!client) {
				console.log(`no session process running for ${project}`);
				return 0;
			}
			const { items, lease } = await client.call("/items");
			console.log(`project ${project}\nview    ${client.viewUrl}\nentries ${items.length}\nturn    ${lease ? `${lease.agent} (${lease.member ?? "?"}) since ${new Date(lease.since).toLocaleTimeString()}` : "free"}`);
			return 0;
		}
		case "view":
			console.log((await connect(project)).viewUrl);
			return 0;
		case "stop": {
			const info = readInfo(project);
			if (info) await new Client(info).call("/stop", {}).catch(() => {});
			return 0;
		}
		default:
			console.log(USAGE);
			return command === undefined || command === "help" || command === "--help" ? 0 : 1;
	}
}

/**
 * A Claude Code hook: hand its input to the session and print what it says. It never fails Claude: anything that goes
 * wrong is written to .session-share/hook.log and the hook exits quietly.
 */
async function hook(agent: string, project: string, member: string): Promise<number> {
	const input = readFileSync(0, "utf8");
	try {
		const payload = JSON.parse(input);
		const answer = await (await connect(project)).call<{ stdout?: string }>("/hook", { agent, member, payload });
		if (answer.stdout) process.stdout.write(answer.stdout);
	} catch (error) {
		mkdirSync(join(project, ".session-share"), { recursive: true });
		appendFileSync(join(project, ".session-share", "hook.log"), `${new Date().toISOString()} ${error instanceof Error ? error.stack : error}\n`);
	}
	return 0;
}

/** Claude Code with this session's hooks, for this run only (--settings); the person's own settings are untouched. */
async function claude(project: string, member: string, args: string[]): Promise<number> {
	await connect(project);
	const command = `${quote(process.execPath)} ${quote(new URL("./cli.ts", import.meta.url).pathname)} hook claude-code`;
	const entry = [{ hooks: [{ type: "command", command, timeout: 60 }] }];
	const settings = {
		hooks: {
			SessionStart: entry,
			UserPromptSubmit: entry,
			PostToolUse: [{ matcher: "*", hooks: entry[0]!.hooks }],
			Stop: entry,
			SessionEnd: entry,
		},
	};
	return run("claude", ["--settings", JSON.stringify(settings), ...args], project, { SESSION_SHARE_PROJECT: project, SESSION_SHARE_MEMBER: member });
}

function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
		child.on("error", reject);
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}

function option(args: string[], ...names: string[]): string | undefined {
	const i = args.findIndex((a) => names.includes(a));
	if (i < 0) return undefined;
	const [, value] = args.splice(i, 2);
	return value;
}

function flag(args: string[], name: string): boolean {
	const i = args.indexOf(name);
	if (i >= 0) args.splice(i, 1);
	return i >= 0;
}

/**
 * One Codex turn. Codex runs headless (`codex exec --json`), resuming this session's thread, with what the others did
 * put before the prompt; afterwards its rollout file is recorded. The turn is held from before Codex starts until it
 * has been recorded.
 */
async function codex(project: string, member: string, args: string[]): Promise<number> {
	const state = join(project, ".session-share", "codex.json");
	const fresh = flag(args, "--new");
	const model = option(args, "-m", "--model");
	const prompt = args.join(" ").trim();
	if (!prompt) throw new Error("usage: session-share codex [--new] [-m model] <prompt>");
	let thread: string | undefined;
	if (!fresh) {
		try {
			thread = JSON.parse(readFileSync(state, "utf8")).thread;
		} catch {}
	}
	const client = await connect(project);
	const session = thread ?? `codex-new:${randomUUID()}`;
	const begun = await client.call<{ context: string | null }>("/turn/begin", { agent: "codex", session, member, transcript: thread ? findRollout(thread) : undefined }).catch((error) => {
		if (error.status === 409) {
			console.error(error.message);
			process.exit(2);
		}
		throw error;
	});
	const input = begun.context ? `${begun.context}\n\n${prompt}` : prompt;
	const heartbeat = setInterval(() => void client.call("/turn/heartbeat", { session }).catch(() => {}), 60_000);
	let started: string | undefined;
	try {
		return await new Promise<number>((resolve, reject) => {
			const child = spawn("codex", ["exec", "--json", "--skip-git-repo-check", "-C", project, ...(model ? ["-m", model] : []), ...(thread ? ["resume", thread] : []), "-"], {
				cwd: project,
				stdio: ["pipe", "pipe", "inherit"],
			});
			child.on("error", reject);
			child.stdin.end(input);
			let pending = "";
			child.stdout.on("data", (chunk: Buffer) => {
				pending += chunk.toString("utf8");
				for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					try {
						const event = JSON.parse(line);
						if (event.type === "thread.started") started = event.thread_id;
						showCodex(event);
					} catch {}
				}
			});
			child.on("exit", (code) => resolve(code ?? 1));
		});
	} finally {
		// The turn is given back whatever happened, after its rollout is recorded.
		clearInterval(heartbeat);
		const id = started ?? thread;
		if (id) writeFileSync(state, `${JSON.stringify({ thread: id }, null, 2)}\n`);
		const rollout = id ? findRollout(id) : undefined;
		await client.call("/turn/end", id && id !== session ? { session, adopt: id, transcript: rollout } : { session });
	}
}

function showCodex(event: { type?: string; item?: Record<string, any> }): void {
	const item = event.item;
	if (event.type !== "item.completed" || !item) return;
	if (item.type === "agent_message" && item.text) console.log(`\n${item.text}`);
	else if (item.type === "command_execution") console.log(`\x1b[2m$ ${item.command}\x1b[0m`);
	else if (item.type === "file_change") console.log(`\x1b[2m~ ${(item.changes ?? []).map((c: { path: string }) => c.path).join(", ")}\x1b[0m`);
}

/** One pi turn on the shared conversation, printed as it happens. */
async function pi(project: string, member: string, args: string[]): Promise<number> {
	const prompt = args.join(" ").trim();
	if (!prompt) throw new Error("usage: session-share pi <prompt>");
	const res = await (await connect(project)).fetch("/pi", { prompt, member });
	if (!res.ok || !res.body) throw new Error((await res.json()).error ?? `pi failed (${res.status})`);
	let pending = "";
	let failed = false;
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		pending += Buffer.from(chunk).toString("utf8");
		for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
			const line = JSON.parse(pending.slice(0, end));
			pending = pending.slice(end + 1);
			if (line.error) {
				console.error(line.error);
				failed = true;
			} else if (line.item) showPi(line.item);
		}
	}
	return failed ? 1 : 0;
}

function showPi(item: Item): void {
	const m = item.message;
	if (item.agent !== "pi" || !m || m.role === "user") return;
	if (m.role === "toolResult") return;
	for (const b of m.content) {
		if (b.type === "text") console.log(`\n${b.text}`);
		else if (b.type === "toolCall") console.log(`\x1b[2m→ ${b.name} ${JSON.stringify(b.arguments).slice(0, 160)}\x1b[0m`);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		if (code >= 0) process.exit(code);
	},
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);
