// Starting a session for a folder: the record (with its URL, chosen up front), then its server created in a background
// process, so a client can open right away. Shared by the CLI and the client library (src/client), which run it the
// same way: the background half is `syncpi __provision <id>`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_HOST, freePort, gatewayModel, piDefaults, provisionExe, provisionLocal, provisionOnHost } from "./provision.ts";
import { type Identity, home, identity, loadSession, type SessionRecord, saveSession, sessionLog, sessions } from "./store.ts";
import { safeVm } from "./snapshot.ts";
import { Mirror } from "./sync.ts";

/** Used when pi has no default model, or a VM session can't reach pi's default through the exe.dev integration. */
export const FALLBACK_MODEL = "anthropic/claude-opus-5-5";

export type StartOptions = {
	/** Run the server on this machine instead of a VM. */
	local?: boolean;
	/** A local server with a scripted model (tests). */
	faux?: boolean;
	model?: string;
	setupModel?: string;
	/** The exe.dev VM to host it on (default: the shared host). */
	vm?: string;
	/** The owner (default: git's user.name). */
	owner?: Identity;
	/** Told about a choice made along the way (a model that isn't available on the VM). */
	say?: (text: string) => void;
};

/** The session started in (or joined into) `dir`, if there is one. */
export function findByDir(dir: string): SessionRecord | undefined {
	return sessions().find((s) => s.dir === dir);
}

/**
 * Records a new session and starts creating its server in a background process (`cli`, the syncpi CLI script, runs
 * `__provision`). The VM name (or local port) is chosen here, which fixes the session's URL before the server exists.
 */
export async function startSession(dir: string, options: StartOptions, cli: string): Promise<SessionRecord> {
	const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
	const local = options.local || options.faux;
	const pi = piDefaults();
	let model = options.model ?? pi.model ?? FALLBACK_MODEL;
	if (!local) {
		const mapped = gatewayModel(model, FALLBACK_MODEL);
		if (mapped.changed) options.say?.(`${model} is not available through the exe.dev LLM integration; using ${mapped.model}`);
		model = mapped.model;
	}
	// Sessions share one host VM unless `vm` names another; a session id is its path there.
	const vm = local ? undefined : safeVm(options.vm ?? DEFAULT_HOST);
	const port = local ? await freePort() : undefined;
	const record: SessionRecord = {
		id,
		name: basename(dir),
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
		setup: { model, setupModel: options.setupModel ?? model, thinkingLevel: pi.thinkingLevel, owner: options.owner ?? identity(), faux: options.faux },
	};
	// The server gets the folder as it is now; anything changed after this syncs up once it is running.
	await Mirror.adopt(id, dir);
	saveSession(record);
	return { ...record, provisioner: spawnProvision(record, cli) };
}

/** Runs the background setup again for a session whose setup failed. */
export function retryProvision(record: SessionRecord, cli: string): SessionRecord {
	const next: SessionRecord = { ...record, status: "provisioning", step: "starting", error: undefined };
	saveSession(next);
	return { ...next, provisioner: spawnProvision(next, cli) };
}

function spawnProvision(record: SessionRecord, cli: string): number | undefined {
	const log = openSync(sessionLog(record.id), "a");
	const child = spawn(process.execPath, [cli, "__provision", record.id], { detached: true, stdio: ["ignore", log, log] });
	child.unref();
	saveSession({ ...(loadSession(record.id) ?? record), provisioner: child.pid });
	return child.pid;
}

/** `syncpi __provision <id>`: the background half of `startSession`. Reports each step in the session record. */
export async function provision(id: string): Promise<void> {
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

export function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Resolves once the session's server is up; reports provisioning steps meanwhile. */
export async function untilReady(id: string, onStep: (step: string) => void): Promise<SessionRecord> {
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
