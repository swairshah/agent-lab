// Starting and joining sessions from pi. Starting copies the project to a session directory on the shared host over
// SSH, as the syncpi CLI does; the extension doesn't carry the server, so the host must already run it (`syncpi update`
// installs it once). Joining trades an invite for a token and downloads the project into ~/.syncpi/projects/<name>.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { join as redeemInvite } from "./connection.ts";
import { extractSnapshot, safeName, safeVm } from "./snapshot.ts";
import { listFiles } from "./shared/files.ts";
import { parseShareUrl } from "./shared/protocol.ts";
import { identity, projectsDir, type SessionRecord, saveSession, sessions } from "./store.ts";
import { Mirror } from "./sync.ts";

const run = promisify(execFile);

export const DEFAULT_HOST = process.env.SYNCPI_VM ?? "syncpi";
const FALLBACK_MODEL = "anthropic/claude-opus-5-5";
const EXE_HOME = "/home/exedev";
const SSH_OPTS = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes"];

export type Progress = (step: string) => void;

/** pi's default model, mapped to what the exe.dev LLM integration serves (anthropic and openai). */
function defaultModel(): { model: string; thinkingLevel?: string } {
	try {
		const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
		if (!s.defaultProvider || !s.defaultModel) return { model: FALLBACK_MODEL };
		const provider = s.defaultProvider === "openai-codex" ? "openai" : s.defaultProvider;
		const model = provider === "anthropic" || provider === "openai" ? `${provider}/${s.defaultModel}` : FALLBACK_MODEL;
		return { model, thinkingLevel: s.defaultThinkingLevel };
	} catch {
		return { model: FALLBACK_MODEL };
	}
}

function pipeInto(command: string, args: string[], input: string | ChildProcess): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", fail);
		child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`${command}: ${err.trim().slice(-400) || `exit ${code}`}`))));
		if (typeof input === "string") child.stdin.end(input);
		else input.stdout!.pipe(child.stdin);
	});
}

async function projectTar(dir: string): Promise<ChildProcess> {
	const files = await listFiles(dir);
	if (existsSync(join(dir, ".git"))) files.push(".git");
	const tar = spawn("tar", ["-czf", "-", "--null", "-T", "-"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
	tar.stdin!.end(files.join("\0"));
	return tar;
}

async function waitHealthy(url: string): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) })
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) return;
		await new Promise((r) => setTimeout(r, 1_000));
	}
	throw new Error(`the session at ${url} did not come up`);
}

/** Creates a session for `dir` on a host VM that already runs the syncpi server. */
export async function startSession(dir: string, vmName: string, progress: Progress, name?: string): Promise<SessionRecord> {
	const vm = safeVm(vmName)!;
	progress(`checking the host ${vm}.exe.xyz`);
	const host = await fetch(`https://${vm}.exe.xyz/healthz`, { signal: AbortSignal.timeout(10_000) })
		.then(async (r) => (r.ok ? ((await r.json()) as { host?: boolean }) : undefined))
		.catch(() => undefined);
	if (host?.host !== true) throw new Error(`${vm}.exe.xyz doesn't run a syncpi host yet; set it up once with \`syncpi update --vm ${vm}\``);

	const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
	const project = basename(dir);
	const token = randomBytes(24).toString("base64url");
	const me = name !== undefined ? { name } : identity();
	const url = `https://${vm}.exe.xyz/${id}`;
	const state = `${EXE_HOME}/.syncpi-sessions/${id}`;
	const workdir = `${EXE_HOME}/projects/${id}/${project.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	const { model, thinkingLevel } = defaultModel();

	await Mirror.adopt(id, dir);
	progress("copying the project");
	await projectTar(dir).then((tar) => pipeInto("ssh", [...SSH_OPTS, "--", `${vm}.exe.xyz`, `mkdir -p ${workdir} && tar -xzf - -C ${workdir}`], tar));
	const serverJson = JSON.stringify(
		{
			id,
			name: project,
			workdir,
			url,
			vm,
			model,
			setupModel: model,
			thinkingLevel,
			auth: "exe-gateway",
			members: {
				owner: {
					id: "owner",
					name: me.name,
					email: me.email?.toLowerCase(),
					role: "admin",
					creator: true,
					tokens: [createHash("sha256").update(token).digest("hex")],
					joinedAt: Date.now(),
				},
			},
			invites: {},
			setup: { status: "pending" },
		},
		null,
		2,
	);
	await pipeInto("ssh", [...SSH_OPTS, "--", `${vm}.exe.xyz`, `umask 077 && mkdir -p ${state} && cat > ${state}/server.json.tmp && mv ${state}/server.json.tmp ${state}/server.json`], serverJson);
	progress("waiting for the session");
	await waitHealthy(url);
	const record: SessionRecord = { id, name: project, url, token, role: "owner", dir, compute: "host", vm, createdAt: Date.now() };
	saveSession(record);
	return record;
}

function uniqueDir(base: string): string {
	if (!existsSync(base) || readdirSync(base).length === 0) return base;
	for (let i = 2; ; i++) if (!existsSync(`${base}-${i}`)) return `${base}-${i}`;
}

/** Joins with a share link; the project lands in ~/.syncpi/projects/<name>. Rejoining an already joined session just returns it. */
export async function joinSession(
	url: string,
	progress: Progress,
	onBrowser: (url: string, check: string, forEmail?: string) => void,
	name?: string,
): Promise<SessionRecord> {
	const share = parseShareUrl(url);
	if (share === undefined) throw new Error(`not a share link: ${url}`);
	const existing = sessions().find((s) => s.url.replace(/\/$/, "") === share.origin);
	if (existing !== undefined) return existing;
	const me = name !== undefined ? { name } : identity();
	progress(`joining as ${me.name}`);
	const joined = await redeemInvite(share.origin, share.invite, me.name, onBrowser);
	const info = (await (await fetch(`${share.origin}/api/info`, { headers: { authorization: `Bearer ${joined.token}` } })).json()) as { id: string; name: string; vm?: string };
	// The server chooses these; a malicious one must not steer where files land or what runs.
	const projectName = safeName(info.name);
	const vm = safeVm(info.vm);
	const dir = resolve(uniqueDir(join(projectsDir(), projectName)));
	mkdirSync(dir, { recursive: true });
	progress(`downloading the project into ${dir}`);
	const res = await fetch(`${share.origin}/api/snapshot.tgz`, { headers: { authorization: `Bearer ${joined.token}` } });
	if (!res.ok || res.body === null) throw new Error(`snapshot: ${res.status}`);
	await extractSnapshot(res.body, dir);
	const record: SessionRecord = { id: String(info.id), name: projectName, url: share.origin, token: joined.token, role: "editor", dir: realpathSync(dir), compute: "remote", vm, createdAt: Date.now() };
	await Mirror.adopt(record.id, record.dir);
	saveSession(record);
	return record;
}

