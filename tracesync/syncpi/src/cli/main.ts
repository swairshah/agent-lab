// syncpi: a multiplayer pi session whose agent runs on its own exe.dev VM.
//
//   syncpi                     start a session for this folder, or rejoin the one already started here
//   syncpi --url <share link>  join someone's session; the project lands in ~/.syncpi/projects/<name>
//   syncpi ls                  sessions on this machine
//   syncpi rm <name>           forget a session (and delete its VM if you own it)
//   syncpi update              copy a newly built server to this folder's session VM and restart it
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { type BranchInfo, type Member, parseShareUrl, type Role, type ServerMessage } from "../shared/protocol.ts";
import { Thread, toolSummary } from "../shared/thread.ts";
import { Connection, join as joinSession } from "./client.ts";
import {
	DEFAULT_HOST,
	destroyExe,
	ensureHost,
	ensureLocalRunning,
	freePort,
	gatewayModel,
	piDefaults,
	provisionExe,
	provisionLocal,
	provisionOnHost,
	removeFromHost,
	stopLocal,
	updateServerExe,
} from "./provision.ts";
import { home, identity, loadSession, projectsDir, removeSession, type SessionRecord, saveSession, sessionLog, sessions } from "./store.ts";
import { LocalDevice } from "./device.ts";
import { loadPiContext, printPiContext } from "./pi-context.ts";
import { extractSnapshot, safeName, safeVm } from "./snapshot.ts";
import { Mirror } from "./sync.ts";
import { App, parseInvite } from "./tui.ts";

/** Used when pi has no default model, or a VM session can't reach pi's default through the exe.dev integration. */
const FALLBACK_MODEL = "anthropic/claude-opus-5-5";

const { values: opts, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		url: { type: "string" },
		dir: { type: "string" },
		new: { type: "boolean", default: false },
		local: { type: "boolean", default: process.env.SYNCPI_COMPUTE === "local" },
		faux: { type: "boolean", default: false },
		model: { type: "string", default: process.env.SYNCPI_MODEL },
		"setup-model": { type: "string", default: process.env.SYNCPI_SETUP_MODEL },
		"no-sync": { type: "boolean", default: false },
		"no-pi": { type: "boolean", default: false },
		headless: { type: "boolean", default: false },
		name: { type: "string" },
		vm: { type: "string" },
		help: { type: "boolean", short: "h", default: false },
	},
});

const say = (text: string) => process.stderr.write(`${text}\n`);

function openUrl(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
const progress = (step: string) => say(`\x1b[2m· ${step}\x1b[0m`);

function usage(): void {
	say(`syncpi: a shared pi session with its agent on an exe.dev VM

  syncpi                      start a session for this folder (or rejoin it)
  syncpi --url <share link>   join a session; files go to ~/.syncpi/projects/<name>
  syncpi ls                   list sessions on this machine
  syncpi rm <name>            forget a session; deletes the VM if you own it
  syncpi update               push a newly built server to the host (or this folder's VM)

options
  --new             start a fresh session even if this folder has one
  --vm <name>       put the session on this exe.dev VM (created if needed)
                    instead of the shared host ${DEFAULT_HOST}.exe.xyz
  --local           run the session server on this machine instead of a VM
  --model p/id      agent model (default: pi's default model)
  --setup-model p/id  setup agent model (default: the agent model)

Models use your pi login locally, and the exe.dev LLM integration on a VM;
no API keys are copied anywhere.
  --dir <path>      where to put a joined project
  --no-sync         don't sync files with the local folder
  --no-pi           don't offer your pi setup (skills, AGENTS.md, prompt templates)
  --name <name>     your display name (default: git user.name)

inside: /session-share  /web  /env  /who  /remote  /steer  /stop  /sync  /ssh  /quit`);
}

function here(): string {
	return realpathSync(process.cwd());
}

function findByDir(dir: string): SessionRecord | undefined {
	return sessions().find((s) => s.dir === dir);
}

function findByName(name: string): SessionRecord | undefined {
	return sessions().find((s) => s.name === name || s.id === name || s.vm === name);
}

/**
 * Records a new session and starts creating its server in a background process, so the UI can open right away. The
 * VM name (or local port) is chosen here, which fixes the session's URL before the server exists.
 */
async function start(dir: string): Promise<SessionRecord> {
	const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
	const local = opts.local || opts.faux;
	const pi = piDefaults();
	let model = opts.model ?? pi.model ?? FALLBACK_MODEL;
	if (!local) {
		const mapped = gatewayModel(model, FALLBACK_MODEL);
		if (mapped.changed) say(`${model} is not available through the exe.dev LLM integration; using ${mapped.model}`);
		model = mapped.model;
	}
	const name = basename(dir);
	// Sessions share one host VM unless --vm names another; a session id is its path there.
	const vm = local ? undefined : safeVm(opts.vm ?? DEFAULT_HOST);
	const port = local ? await freePort() : undefined;
	const record: SessionRecord = {
		id,
		name,
		url: vm !== undefined ? `https://${vm}.exe.xyz/${id}` : `http://127.0.0.1:${port}`,
		token: randomBytes(24).toString("base64url"),
		role: "owner",
		dir,
		compute: local ? "local" : "host",
		vm,
		port,
		localRoot: local ? join(home, "local", id) : undefined,
		createdAt: Date.now(),
		status: "provisioning",
		step: "starting",
		setup: {
			model,
			setupModel: opts["setup-model"] ?? model,
			thinkingLevel: pi.thinkingLevel,
			owner: opts.name !== undefined ? { name: opts.name } : identity(),
			faux: opts.faux,
		},
	};
	// The server gets the folder as it is now; anything changed after this syncs up once it is running.
	await Mirror.adopt(id, dir);
	saveSession(record);
	const log = openSync(sessionLog(id), "a");
	const child = spawn(process.execPath, [process.argv[1]!, "__provision", id], { detached: true, stdio: ["ignore", log, log] });
	child.unref();
	saveSession({ ...record, provisioner: child.pid });
	return { ...record, provisioner: child.pid };
}

/** Runs the background setup again for a session whose setup failed. */
function retryProvision(record: SessionRecord): SessionRecord {
	const log = openSync(sessionLog(record.id), "a");
	const child = spawn(process.execPath, [process.argv[1]!, "__provision", record.id], { detached: true, stdio: ["ignore", log, log] });
	child.unref();
	const next: SessionRecord = { ...record, status: "provisioning", step: "starting", error: undefined, provisioner: child.pid };
	saveSession(next);
	return next;
}

/** `syncpi __provision <id>`: the background half of `start`. Reports each step in the session record. */
async function provision(id: string): Promise<void> {
	const record = loadSession(id);
	if (record?.setup === undefined) throw new Error(`no session ${id} to set up`);
	const update = (patch: Partial<SessionRecord>) => saveSession({ ...(loadSession(id) ?? record), ...patch });
	const step = (text: string) => {
		console.log(`${new Date().toISOString()} ${text}`);
		update({ step: text });
	};
	const config = { id, name: record.name, ownerToken: record.token, ...record.setup };
	try {
		if (record.compute === "local") await provisionLocal(record.dir, config, record.port!, step, { faux: record.setup.faux });
		else if (record.compute === "host") await provisionOnHost(record.dir, config, record.vm!, step);
		else await provisionExe(record.dir, config, record.vm!, step);
		update({ status: "ready", step: undefined, error: undefined, provisioner: undefined });
		console.log("ready");
	} catch (error) {
		const message = String((error as Error).message ?? error);
		console.log(`failed: ${message}`);
		update({ status: "failed", step: undefined, error: message, provisioner: undefined });
	}
}

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Resolves once the session's server is up; reports provisioning steps meanwhile. */
async function untilReady(id: string, onStep: (step: string) => void): Promise<SessionRecord> {
	for (;;) {
		const record = loadSession(id);
		if (record === undefined) throw new Error("the session was removed");
		if (record.status === undefined || record.status === "ready") return record;
		if (record.status === "failed") throw new Error(record.error ?? "setup failed");
		if (!alive(record.provisioner)) throw new Error(`setup was interrupted (log: ${sessionLog(id)})`);
		onStep(record.step ?? "starting");
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function joinFromUrl(url: string): Promise<SessionRecord> {
	const share = parseShareUrl(url);
	if (share === undefined) throw new Error(`not a share link: ${url} (expected https://<host>/s/<code>)`);
	const existing = sessions().find((s) => s.url.replace(/\/$/, "") === share.origin);
	if (existing !== undefined) {
		say(`already joined; reopening ${existing.dir}`);
		return existing;
	}
	const me = opts.name !== undefined ? { name: opts.name } : identity();
	progress(`joining as ${me.name}`);
	const joined = await joinSession(share.origin, share.invite, me.name, (url, check, forEmail) => {
		say(`\nThis invite is for ${forEmail ?? "an email address"}. Sign in with exe.dev in your browser and approve code \x1b[1m${check}\x1b[0m.`);
		say(`  ${url}`);
		openUrl(url);
	});
	const info = (await (await fetch(`${share.origin}/api/info`, { headers: { authorization: `Bearer ${joined.token}` } })).json()) as { id: string; name: string; vm?: string };
	// The server chooses these; a malicious one must not steer where files land or what runs.
	const projectName = safeName(info.name);
	const vm = safeVm(info.vm);
	const dir = resolve(opts.dir ?? uniqueDir(join(projectsDir(), projectName)));
	mkdirSync(dir, { recursive: true });
	progress(`downloading the project into ${dir}`);
	const conn = new Connection(share.origin, joined.token);
	const res = await conn.snapshot();
	if (res.body === null) throw new Error("empty snapshot");
	await extractSnapshot(res.body, dir);
	const record: SessionRecord = {
		id: String(info.id),
		name: projectName,
		url: share.origin,
		token: joined.token,
		role: "editor",
		dir: realpathSync(dir),
		compute: "remote",
		vm,
		createdAt: Date.now(),
	};
	await Mirror.adopt(record.id, record.dir);
	saveSession(record);
	return record;
}

function uniqueDir(base: string): string {
	if (!existsSync(base) || readdirSync(base).length === 0) return base;
	for (let i = 2; ; i++) if (!existsSync(`${base}-${i}`)) return `${base}-${i}`;
}

async function attach(initial: SessionRecord): Promise<void> {
	let record = initial;
	if (record.status === "failed") {
		// A session you started here: try its setup again (same session, same URL). One you joined can't be set up here.
		if (record.role !== "owner" || record.setup === undefined) {
			throw new Error(`this folder's session could not be set up: ${record.error}\n  details: ${sessionLog(record.id)}\n  start over with: syncpi rm && syncpi`);
		}
		say(`\x1b[2m· the last setup failed (${record.error}); trying again\x1b[0m`);
		record = retryProvision(record);
	}
	const conn = new Connection(record.url, record.token);
	const mirror = opts["no-sync"] ? undefined : new Mirror(record.id, record.dir, conn);
	mirror?.start();
	// Requests sent from this terminal run on this machine, in the synced copy. Without a synced copy they run on the VM.
	const device = mirror === undefined ? undefined : new LocalDevice(conn, mirror);
	if (device !== undefined) {
		conn.onOpen = () => device.register();
		conn.onBinary = (data) => device.binary(data);
	}
	// Your pi setup (skills, AGENTS.md, prompt templates), loaded the way pi loads it for this folder.
	const piContext = opts["no-pi"] ? undefined : loadPiContext(record.dir);
	void piContext?.then(({ prompts: _, ...offered }) => device?.setContext(offered));
	// The UI opens now. Messages typed before the server is up are queued and sent once it is.
	const ui: { setup(state: { step?: string; error?: string } | undefined): void; run(): Promise<void> } = opts.headless
		? headless(record, conn, mirror, device)
		: new App(record, conn, mirror, device, piContext);
	const done = ui.run();
	void untilReady(record.id, (step) => ui.setup({ step }))
		.then(async (ready) => {
			if (ready.compute === "local" && ready.localRoot !== undefined) await ensureLocalRunning(ready.localRoot, ready.url, (step) => ui.setup({ step }));
			ui.setup(undefined);
			conn.start();
		})
		.catch((error: Error) => ui.setup({ error: `${error.message}. Run \`syncpi rm\` and start again.` }));
	await done;
	mirror?.stop();
	conn.close();
	say(`\nThe session keeps running at ${record.url}. Rejoin with \`syncpi\` in ${record.dir}`);
	process.exit(0);
}

/**
 * A line-based client for scripts and tests: prints each finished item of the shared thread, reads messages (and
 * /session-share, /quit) from stdin.
 */
function headless(record: SessionRecord, conn: Connection, mirror: Mirror | undefined, device: LocalDevice | undefined) {
	let lastStep: string | undefined;
	return {
		setup(state: { step?: string; error?: string } | undefined): void {
			const line = state === undefined ? "setup done" : state.error !== undefined ? `setup failed ${state.error}` : `setup ${state.step}`;
			if (line !== lastStep) process.stdout.write(`${line}\n`);
			lastStep = line;
		},
		run: () => runHeadless(record, conn, mirror, device),
	};
}

async function runHeadless(record: SessionRecord, conn: Connection, mirror: Mirror | undefined, device: LocalDevice | undefined): Promise<void> {
	const thread = new Thread();
	const printed = new Set<string>();
	let members: Member[] = [];
	let branches: BranchInfo[] = [];
	const out = (line: string) => process.stdout.write(`${line}\n`);
	const flush = () => {
		for (const item of thread.state.items) {
			if (printed.has(item.key)) continue;
			if (item.kind === "assistant" && item.streaming) return;
			if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) return;
			printed.add(item.key);
			if (item.kind === "user") out(`[${item.author ?? "?"}] ${item.text}`);
			else if (item.kind === "assistant") out(`agent: ${item.text}${item.error ? ` (error: ${item.error})` : ""}`);
			else if (item.kind === "tool") out(`tool ${item.name} ${toolSummary(item)} -> ${item.status}`);
			else out(`-- ${item.text}`);
		}
	};
	if (mirror !== undefined) mirror.onEvent = (e) => out(`sync ${e.type} ${"path" in e ? e.path : ""}${"message" in e ? e.message : ""}`);
	conn.onMessage = (message: ServerMessage) => {
		if (device?.handle(message)) return;
		if (message.type === "target") out(`target ${message.label}`);
		else if (message.type === "history" && message.conv === "main") {
			thread.prepend(message.entries);
			flush();
		}
		else if (message.type === "events" && message.conv === "main") {
			thread.apply(message.events);
			flush();
		} else if (message.type === "files") mirror?.remoteChanged(message.full === true, message.changed, message.version);
		else if (message.type === "invite") out(`share ${message.url} ${message.invite.role}${message.invite.email ? ` ${message.invite.email}` : ""}`);
		else if (message.type === "env") out(`env ${message.env.status}${message.env.activity ? ` ${message.env.activity}` : ""}`);
		else if (message.type === "presence") {
			members = message.members;
			out(`presence ${message.online.map((p) => `${p.name}/${p.client}`).join(" ")}`);
			out(`members ${message.members.map((m) => `${m.name}:${m.role}`).join(" ")}`);
		} else if (message.type === "welcome") out(`welcome ${message.me.name} ${message.me.role}`);
		else if (message.type === "invites") out(`invites ${message.invites.map((i) => `${i.code}:${i.email ?? "link"}:${i.role}`).join(" ")}`);
		else if (message.type === "removed") out("removed");
		else if (message.type === "branches") {
			branches = message.branches;
			out(`branches current=${message.branches.findIndex((b) => b.id === message.current)} ${message.branches.map((b) => b.label).join(",")}`);
		}
		else if (message.type === "error") out(`error ${message.message}`);
	};
	conn.onState = (state, detail) => {
		if (state === "closed") device?.disconnected();
		out(`connection ${state}${detail ? ` ${detail}` : ""}`);
	};
	const rl = createInterface({ input: process.stdin });
	for await (const line of rl) {
		const text = line.trim();
		if (text === "/quit") break;
		const [command = "", ...words] = text.split(/\s+/);
		const memberId = (query: string) => members.find((m) => m.name === query || m.email === query)?.id ?? query;
		if (command === "/session-share") conn.send({ type: "invite" });
		else if (command === "/invite") {
			const parsed = parseInvite(words.join(" "));
			if (typeof parsed === "string") out(`error ${parsed}`);
			else conn.send({ type: "invite", ...parsed });
		} else if (command === "/name") conn.send({ type: "rename", name: words.join(" ") });
		else if (command === "/role") conn.send({ type: "setRole", memberId: memberId(words[0] ?? ""), role: words[1] as Role });
		else if (command === "/remove") conn.send({ type: "remove", memberId: memberId(words[0] ?? "") });
		else if (command === "/links") conn.send({ type: "invites" });
		else if (command === "/compact") conn.send({ type: "compact", instructions: words.join(" ") || undefined });
		else if (command === "/new") conn.send({ type: "new" });
		else if (command === "/tree" && /^b\d+$/.test(words[0] ?? "")) conn.send({ type: "switchBranch", id: branches[Number(words[0]!.slice(1))]?.id ?? -1 });
		else if (command === "/tree" && /^\d+$/.test(words[0] ?? "")) {
			const users = thread.state.items.filter((i) => i.kind === "user" && /^\d+$/.test(i.key));
			conn.send({ type: "fork", before: users[Number(words[0]) - 1]?.key ?? "" });
		}
		else if (command === "/revoke") conn.send({ type: "revoke", code: words[0] ?? "" });
		else if (text.startsWith("/vm ")) conn.send({ type: "submit", requestId: randomUUID(), text: text.slice(4), where: "vm" });
		else if (text.length > 0) conn.send({ type: "submit", requestId: randomUUID(), text, where: device === undefined ? "vm" : "device" });
	}
	// Let in-flight sync finish before leaving.
	await new Promise((r) => setTimeout(r, 2_000));
	out(`done ${record.name}`);
}

async function main(): Promise<void> {
	if (opts.help) return usage();
	const [command, arg] = positionals;
	if (command === "__provision") return provision(arg!);
	if (command === "__pi-context") return printPiContext(arg!);
	if (command === "ls") {
		const all = sessions();
		if (all.length === 0) say("no sessions yet");
		for (const s of all) say(`${s.name.padEnd(20)} ${s.role.padEnd(6)} ${s.compute.padEnd(6)} ${(s.status ?? "ready").padEnd(12)} ${s.url}  ${s.dir}`);
		return;
	}
	if (command === "rm") {
		const record = arg === undefined ? findByDir(here()) : findByName(arg);
		if (record === undefined) throw new Error(`no session ${arg ?? "for this folder"}`);
		if (alive(record.provisioner)) process.kill(record.provisioner!, "SIGTERM");
		if (record.role === "owner" && record.compute === "host" && record.vm !== undefined) {
			progress(`removing the session from ${record.vm}`);
			await removeFromHost(record.vm, record.id, record.name).catch((error: Error) => say(`  (${error.message})`));
		}
		if (record.role === "owner" && record.compute === "exe" && record.vm !== undefined) {
			progress(`deleting VM ${record.vm}`);
			// A session removed early in its setup may have no VM yet.
			await destroyExe(record.vm).catch((error: Error) => say(`  (${error.message})`));
		}
		if (record.compute === "local" && record.localRoot !== undefined) await stopLocal(record.localRoot);
		removeSession(record.id);
		say(`removed ${record.name} (local files in ${record.dir} are untouched)`);
		return;
	}
	if (command === "update") {
		const record = arg === undefined ? findByDir(here()) : findByName(arg);
		// `syncpi update` with no session here, or `syncpi update --vm <name>`, updates a host directly.
		if (record === undefined || record.compute === "host" || opts.vm !== undefined) {
			const vm = opts.vm ?? record?.vm ?? DEFAULT_HOST;
			await ensureHost(vm, progress, { force: true });
			say(`updated the syncpi host on ${vm}; clients reconnect on their own`);
			return;
		}
		if (record.vm === undefined || record.role !== "owner") throw new Error("no VM session you own here");
		progress(`updating the server on ${record.vm}`);
		await updateServerExe(record.vm);
		say("updated; clients reconnect on their own");
		return;
	}
	if (command !== undefined) throw new Error(`unknown command ${command}; see syncpi --help`);

	if (opts.url !== undefined) return attach(await joinFromUrl(opts.url));
	const dir = here();
	const existing = opts.new ? undefined : findByDir(dir);
	return attach(existing ?? (await start(dir)));
}

main().catch((error: Error) => {
	say(`\x1b[31msyncpi: ${error.message}\x1b[0m`);
	process.exit(1);
});
