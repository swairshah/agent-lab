// Starting a session's server. This runs in a background process (`syncpi __provision <id>`), so the terminal UI is
// up at once and shows the steps as they happen.
//   host:  the default. Every session lives on one shared exe.dev VM (syncpi.exe.xyz unless `--vm` names another),
//          served under https://<vm>.exe.xyz/<id>/ by one multi-session server. The VM is created and the server
//          installed or updated the first time it is needed; after that a session is a directory written over SSH.
//          Models go through the account's exe.dev LLM integration, so no keys are copied to the VM.
//   exe:   (sessions from older versions) a VM per session. The project and the server bundle are copied over SSH, the server runs as the
//          systemd unit `syncpi`, and exe.dev serves its port 8000 at https://<vm>.exe.xyz/. Models go through the
//          account's exe.dev LLM integration, so no keys are copied to the VM.
//   local: the same server as a child process on this machine, with its own copy of the project. Models use this
//          machine's pi login.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listFiles } from "../shared/files.ts";
import { home, type Identity } from "./store.ts";

const run = promisify(execFile);

/** Where the built server (server.mjs) and web view (web/) are: next to the CLI bundle, or dist/ in a checkout. */
export function appDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const dir of [here, join(here, "..", "..", "dist")]) if (existsSync(join(dir, "server.mjs"))) return dir;
	throw new Error("server bundle not found; run `npm run build` in the syncpi package");
}

export type ServerConfig = {
	id: string;
	name: string;
	workdir: string;
	url: string;
	vm?: string;
	model: string;
	setupModel: string;
	thinkingLevel?: string;
	auth: "pi" | "exe-gateway";
	ownerToken: string;
	owner: Identity;
};

export type SessionConfig = Omit<ServerConfig, "url" | "workdir" | "vm" | "auth">;

function serverJson(config: ServerConfig): string {
	const ownerId = "owner";
	return JSON.stringify(
		{
			id: config.id,
			name: config.name,
			workdir: config.workdir,
			url: config.url,
			vm: config.vm,
			model: config.model,
			setupModel: config.setupModel,
			thinkingLevel: config.thinkingLevel,
			auth: config.auth,
			// The creator is the session's first admin. The server keeps only a hash of their token.
			members: {
				[ownerId]: {
					id: ownerId,
					name: config.owner.name,
					email: config.owner.email?.toLowerCase(),
					role: "admin",
					creator: true,
					tokens: [createHash("sha256").update(config.ownerToken).digest("hex")],
					joinedAt: Date.now(),
				},
			},
			invites: {},
			setup: { status: "pending" },
		},
		null,
		2,
	);
}

// ---------- models: pi's defaults ----------

const PI_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** pi's default model and thinking level (`/model` in pi writes them to ~/.pi/agent/settings.json). */
export function piDefaults(): { model?: string; thinkingLevel?: string } {
	try {
		const settings = JSON.parse(readFileSync(join(PI_DIR, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
		const model = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined;
		return { model, thinkingLevel: settings.defaultThinkingLevel };
	} catch {
		return {};
	}
}

/**
 * The model a VM session can reach through the exe.dev LLM integration, which serves the Anthropic and OpenAI APIs.
 * A ChatGPT-subscription model (openai-codex/…) is the same model on the integration's openai provider.
 */
export function gatewayModel(model: string, fallback: string): { model: string; changed: boolean } {
	const [provider, ...rest] = model.split("/");
	const id = rest.join("/");
	if (provider === "anthropic" || provider === "openai") return { model, changed: false };
	if (provider === "openai-codex") return { model: `openai/${id}`, changed: false };
	return { model: fallback, changed: true };
}

/** A tar.gz of the project's synced files plus .git, streamed from `dir`. */
async function projectTar(dir: string): Promise<ChildProcess> {
	const files = await listFiles(dir);
	if (existsSync(join(dir, ".git"))) files.push(".git");
	const tar = spawn("tar", ["-czf", "-", "--null", "-T", "-"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
	tar.stdin!.end(files.join("\0"));
	return tar;
}

/** Runs a command, feeding it `input` (a string or another process's stdout). */
function pipeInto(command: string, args: string[], input: string | ChildProcess): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(" ").slice(0, 80)}: ${err.trim().slice(-500) || `exit ${code}`}`))));
		if (typeof input === "string") child.stdin.end(input);
		else input.stdout!.pipe(child.stdin);
	});
}

// ---------- exe.dev ----------

const SSH_OPTS = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes"];
const EXE_HOME = "/home/exedev";

async function exe(...args: string[]): Promise<string> {
	try {
		const { stdout } = await run("ssh", [...SSH_OPTS, "exe.dev", ...args], { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		const e = error as { stderr?: string; stdout?: string; message: string };
		throw new Error(`exe.dev ${args[0]}: ${(e.stderr || e.stdout || e.message).trim().slice(0, 400)}`);
	}
}

function vmSsh(vm: string, script: string, input?: string | ChildProcess): Promise<string> {
	const args = [...SSH_OPTS, "--", `${vm}.exe.xyz`, script];
	if (input !== undefined) return pipeInto("ssh", args, input);
	return run("ssh", args, { maxBuffer: 16 * 1024 * 1024 }).then(
		(r) => r.stdout,
		(error: { stderr?: string; message: string }) => {
			throw new Error(`${vm}: ${(error.stderr || error.message).trim().slice(-500)}`);
		},
	);
}

const NODE_SETUP = `set -e
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
fi
node --version`;

function unit(): string {
	return `[Unit]
Description=syncpi session server
After=network-online.target

[Service]
User=exedev
WorkingDirectory=${EXE_HOME}
ExecStart=/usr/bin/env node ${EXE_HOME}/.syncpi-app/server.mjs --state ${EXE_HOME}/.syncpi --port 8000
Restart=always
RestartSec=2
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${EXE_HOME}/.local/bin

[Install]
WantedBy=multi-user.target
`;
}

export function vmName(project: string): string {
	const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";
	return `syncpi-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

export type Progress = (step: string) => void;

/**
 * The agent's tools on a VM (src/server/remote-tools.ts): Playwright, its Chromium and the system libraries it needs,
 * next to the server in ~/.syncpi-app/tools. Installed once per Playwright version, in the background (it takes a few
 * minutes the first time), so a session doesn't wait for it; record_browser says so if it's used before it's ready.
 */
const PLAYWRIGHT = "1.64.1";
const TOOLS_DIR = `${EXE_HOME}/.syncpi-app/tools`;
const TOOLS_SCRIPT = `set -e
cd ${TOOLS_DIR}
[ -f package.json ] || echo '{"name":"syncpi-tools","private":true}' > package.json
npm install --no-audit --no-fund playwright@${PLAYWRIGHT}
sudo npx playwright install-deps chromium
npx playwright install chromium
command -v ffmpeg >/dev/null || sudo apt-get install -y ffmpeg
touch .ready-${PLAYWRIGHT}
`;
/** Writes the install script and starts it detached, unless it's done; a lock keeps a second run from starting. */
function installAgentTools(vm: string): Promise<string> {
	return vmSsh(
		vm,
		`mkdir -p ${TOOLS_DIR} && cat > ${TOOLS_DIR}/install.sh && if [ ! -f ${TOOLS_DIR}/.ready-${PLAYWRIGHT} ]; then setsid nohup flock -n ${TOOLS_DIR}/.lock bash ${TOOLS_DIR}/install.sh > ${TOOLS_DIR}/install.log 2>&1 < /dev/null & fi`,
		TOOLS_SCRIPT,
	);
}

function serverBundle(): ChildProcess {
	return spawn("tar", ["-czf", "-", "server.mjs", "relay.mjs", "recorder.mjs", "web"], { cwd: appDir(), env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

// ---------- the shared host ----------

/** The default host VM for sessions. */
export const DEFAULT_HOST = process.env.SYNCPI_VM ?? "syncpi";
const HOST_SESSIONS = `${EXE_HOME}/.syncpi-sessions`;
const HOST_PROJECTS = `${EXE_HOME}/projects`;

export function hostPaths(id: string, name: string): { state: string; workdir: string } {
	return { state: `${HOST_SESSIONS}/${id}`, workdir: `${HOST_PROJECTS}/${id}/${name.replace(/[^A-Za-z0-9._-]/g, "-")}` };
}

/**
 * A hash of everything a host runs and serves (the server, the relay and every web file, whatever the build splits it
 * into), so a host is updated exactly when the build changed.
 */
function bundleVersion(): string {
	const hash = createHash("sha1");
	const app = appDir();
	const web = readdirSync(join(app, "web"), { recursive: true, encoding: "utf8" })
		.filter((f) => statSync(join(app, "web", f)).isFile())
		.sort()
		.map((f) => `web/${f}`);
	for (const file of ["server.mjs", "relay.mjs", ...web]) hash.update(file).update(readFileSync(join(app, file)));
	return hash.digest("hex").slice(0, 16);
}

function hostUnit(): string {
	return unit().replace(`--state ${EXE_HOME}/.syncpi --port 8000`, `--sessions ${HOST_SESSIONS} --port 8000`);
}

/** Holds a lock while setting up a host, so two sessions starting at once don't both create it. */
async function withHostLock<T>(vm: string, fn: () => Promise<T>): Promise<T> {
	const lock = join(home, "hosts", `${vm}.lock`);
	mkdirSync(dirname(lock), { recursive: true });
	for (let waited = 0; ; waited += 500) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			// A lock left by a crashed setup is stale after ten minutes.
			const age = Date.now() - (existsSync(lock) ? lstatSafe(lock) : 0);
			if (age > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function lstatSafe(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Makes sure `vm` runs the current syncpi host: creates the VM if it doesn't exist, installs or updates the server. */
export async function ensureHost(vm: string, progress: Progress, options: { force?: boolean } = {}): Promise<void> {
	await withHostLock(vm, async () => {
		const listed = JSON.parse(await exe("ls", "--json")) as { vms: { vm_name: string }[] };
		if (!listed.vms.some((v) => v.vm_name === vm)) {
			progress(`creating the host VM ${vm}`);
			await exe("new", `--name=${vm}`, "--no-email", "--tag=syncpi", "--comment=syncpi-host");
			await exe("share", "port", vm, "8000");
			await exe("share", "set-public", vm);
		}
		progress(`connecting to ${vm}`);
		for (let attempt = 0; ; attempt++) {
			const ok = await vmSsh(vm, "echo ok").catch(() => "");
			if (ok.trim() === "ok") break;
			if (attempt >= 30) throw new Error(`could not reach ${vm} over SSH`);
			await new Promise((r) => setTimeout(r, 3_000));
		}
		const version = bundleVersion();
		const probe = await vmSsh(
			vm,
			`cat ~/.syncpi-app/VERSION 2>/dev/null || echo none; [ -f ~/.syncpi/server.json ] && echo single || echo -; [ -d ${HOST_SESSIONS} ] && echo host || echo -; ss -ltnH 'sport = :8000' | wc -l`,
		);
		const [installed, single, isHost, listeners] = probe.trim().split("\n");
		if (single === "single") throw new Error(`${vm} runs a single syncpi session; pick another VM with --vm`);
		if (isHost !== "host" && Number(listeners) > 0) throw new Error(`${vm} already serves something on port 8000; pick another VM with --vm`);
		if (installed === version && isHost === "host" && !options.force) return void (await installAgentTools(vm).catch(() => {}));
		progress(installed === "none" ? `installing syncpi on ${vm}` : `updating syncpi on ${vm}`);
		await vmSsh(vm, NODE_SETUP);
		await pipeInto("ssh", [...SSH_OPTS, "--", `${vm}.exe.xyz`, `mkdir -p ${EXE_HOME}/.syncpi-app ${HOST_SESSIONS} ${HOST_PROJECTS} && chmod 700 ${HOST_SESSIONS} && tar -xzf - -C ${EXE_HOME}/.syncpi-app`], serverBundle());
		await vmSsh(vm, `cat > ~/.syncpi-app/VERSION`, `${version}\n`);
		await vmSsh(vm, "sudo tee /etc/systemd/system/syncpi.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable syncpi && sudo systemctl restart syncpi", hostUnit());
		await installAgentTools(vm);
		for (let attempt = 0; attempt < 60; attempt++) {
			const ok = await fetch(`https://${vm}.exe.xyz/healthz`, { signal: AbortSignal.timeout(5_000) })
				.then(async (r) => r.ok && ((await r.json()) as { host?: boolean }).host === true)
				.catch(() => false);
			if (ok) return;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		throw new Error(`the syncpi host on ${vm} did not come up`);
	});
}

/** Creates a session on a host: copies the project, then writes its server.json, which makes the host serve it. */
export async function provisionOnHost(dir: string, config: SessionConfig, vm: string, progress: Progress): Promise<void> {
	await ensureHost(vm, progress);
	const url = `https://${vm}.exe.xyz/${config.id}`;
	const paths = hostPaths(config.id, config.name);
	progress("copying the project");
	await projectTar(dir).then((tar) => vmSsh(vm, `mkdir -p ${paths.workdir} && tar -xzf - -C ${paths.workdir}`, tar));
	await vmSsh(
		vm,
		`umask 077 && mkdir -p ${paths.state} && cat > ${paths.state}/server.json.tmp && mv ${paths.state}/server.json.tmp ${paths.state}/server.json`,
		serverJson({ ...config, url, workdir: paths.workdir, vm, auth: "exe-gateway" }),
	);
	await waitHealthy(url, progress);
}

/** Removes a session from its host; the host closes it within half a minute. */
export async function removeFromHost(vm: string, id: string, name: string): Promise<void> {
	const paths = hostPaths(id, name);
	await vmSsh(vm, `rm -f ${paths.state}/server.json && rm -rf ${paths.state} ${HOST_PROJECTS}/${id}`);
}

export async function provisionExe(dir: string, config: SessionConfig, vm: string, progress: Progress): Promise<void> {
	const url = `https://${vm}.exe.xyz`;
	const workdir = `${EXE_HOME}/${config.name.replace(/[^A-Za-z0-9._-]/g, "-")}`;

	progress(`creating VM ${vm}`);
	await exe("new", `--name=${vm}`, "--no-email", "--tag=syncpi", `--comment=syncpi-${config.id}`);
	await exe("share", "port", vm, "8000");
	await exe("share", "set-public", vm);

	progress("waiting for the VM to boot");
	for (let attempt = 0; ; attempt++) {
		const ok = await vmSsh(vm, "echo ok").catch(() => "");
		if (ok.trim() === "ok") break;
		if (attempt >= 30) throw new Error(`could not reach ${vm} over SSH`);
		await new Promise((r) => setTimeout(r, 3_000));
	}

	progress("copying the project");
	await Promise.all([
		vmSsh(vm, NODE_SETUP),
		projectTar(dir).then((tar) => vmSsh(vm, `mkdir -p ${workdir} && tar -xzf - -C ${workdir}`, tar)),
		pipeInto("ssh", [...SSH_OPTS, "--", `${vm}.exe.xyz`, `mkdir -p ${EXE_HOME}/.syncpi-app && tar -xzf - -C ${EXE_HOME}/.syncpi-app`], serverBundle()),
	]);

	progress("starting the session server");
	await vmSsh(vm, `umask 077 && mkdir -p ${EXE_HOME}/.syncpi && cat > ${EXE_HOME}/.syncpi/server.json`, serverJson({ ...config, url, workdir, vm, auth: "exe-gateway" }));
	await vmSsh(vm, "sudo tee /etc/systemd/system/syncpi.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable --now syncpi", unit());
	await installAgentTools(vm);
	await waitHealthy(url, progress);
}

/** Copies a newly built server to a session's VM and restarts it. Sessions from older versions switch to the gateway. */
export async function updateServerExe(vm: string): Promise<void> {
	await pipeInto("ssh", [...SSH_OPTS, "--", `${vm}.exe.xyz`, `tar -xzf - -C ${EXE_HOME}/.syncpi-app && rm -f ${EXE_HOME}/.syncpi/env && sudo systemctl restart syncpi`], serverBundle());
}

export async function destroyExe(vm: string): Promise<void> {
	await exe("rm", vm);
}

async function waitHealthy(url: string, progress: Progress, child?: ChildProcess): Promise<void> {
	progress("waiting for the server");
	for (let attempt = 0; attempt < 90; attempt++) {
		if (child !== undefined && child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
		const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) })
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) return;
		await new Promise((r) => setTimeout(r, 1_000));
	}
	throw new Error(`server at ${url} did not come up`);
}

// ---------- local ----------

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

export async function provisionLocal(dir: string, config: SessionConfig, port: number, progress: Progress, options: { faux?: boolean } = {}): Promise<string> {
	const localRoot = join(home, "local", config.id);
	const workdir = join(localRoot, "workspace", basename(dir));
	const stateDir = join(localRoot, "state");
	mkdirSync(workdir, { recursive: true });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	progress("copying the project");
	await pipeInto("tar", ["-xzf", "-", "-C", workdir], await projectTar(dir));
	const url = `http://127.0.0.1:${port}`;
	writeFileSync(join(stateDir, "server.json"), serverJson({ ...config, url, workdir, auth: "pi" }), { mode: 0o600 });
	writeFileSync(join(localRoot, "port"), String(port));
	progress("starting the session server");
	const child = startLocal(localRoot, options.faux === true);
	await waitHealthy(url, progress, child);
	return localRoot;
}

/** Starts (or restarts after a reboot) a local session's server in the background. */
export function startLocal(localRoot: string, faux: boolean): ChildProcess {
	const port = readFileSync(join(localRoot, "port"), "utf8").trim();
	const log = openSync(join(localRoot, "server.log"), "a");
	const child = spawn(process.execPath, [join(appDir(), "server.mjs"), "--state", join(localRoot, "state"), "--port", port, "--host", "127.0.0.1", ...(faux ? ["--faux"] : [])], {
		detached: true,
		stdio: ["ignore", log, log],
	});
	child.unref();
	writeFileSync(join(localRoot, "pid"), String(child.pid));
	if (faux) writeFileSync(join(localRoot, "faux"), "1");
	return child;
}

export async function ensureLocalRunning(localRoot: string, url: string, progress: Progress): Promise<void> {
	const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) })
		.then((r) => r.ok)
		.catch(() => false);
	if (ok) return;
	const child = startLocal(localRoot, existsSync(join(localRoot, "faux")));
	await waitHealthy(url, progress, child);
}

export async function stopLocal(localRoot: string): Promise<void> {
	try {
		process.kill(Number(readFileSync(join(localRoot, "pid"), "utf8")), "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 300));
	rmSync(localRoot, { recursive: true, force: true });
}
