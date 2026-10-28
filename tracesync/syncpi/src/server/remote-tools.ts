// Tools that always run on the session's VM (where this server runs), whatever machine a run's other tools are on:
// every agent in the session has them, so an agent working on someone's Mac can still deploy, host or record from
// the VM, where things keep running when that Mac sleeps.
//
//   remote_bash      a command in the VM's copy of the project (long-running ones in the background)
//   record_browser   a real browser on the VM doing something, recorded as a video for the thread
//
// Recordings go to .syncpi/recordings/ in the VM's copy (not synced); the thread shows them (thread-view.ts) through
// GET api/recording (room.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** Where recordings are kept, in the VM's copy of the project. */
export const RECORDINGS = ".syncpi/recordings";

/** Tools installed for the agent on a VM (Playwright and its browser), next to the server: see provision.ts. */
function toolsDir(): string | undefined {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "tools");
	return existsSync(join(dir, "node_modules", "playwright")) ? dir : undefined;
}

const STEP = Type.Object(
	{
		action: Type.Union(["goto", "click", "type", "press", "hover", "scroll", "wait", "waitFor", "caption"].map((a) => Type.Literal(a)), {
			description:
				"goto {url}; click {target}; type {target?, text} (clicks target first, if given); press {key, e.g. Enter}; hover {target}; scroll {y: pixels}; wait {ms}; waitFor {target}; caption {text} (a subtitle on the video; empty text hides it)",
		}),
		target: Type.Optional(Type.String({ description: 'CSS selector, or text=Sign in, role=button:Save, label=Email, placeholder=Search' })),
		text: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
		key: Type.Optional(Type.String()),
		y: Type.Optional(Type.Number()),
		ms: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export type RecordingDetails = { video: string; poster?: string; title: string; seconds?: number; error?: string };

/** The remote tools, for a session whose project copy on this machine is `workdir`. `env` is the VM's shell env. */
export function remoteTools(workdir: string, env: () => NodeJS.ProcessEnv) {
	const remoteBash = defineTool({
		name: "remote_bash",
		description:
			"Run a bash command on the session's Linux VM, in its copy of the project, whatever machine your other tools are on. Use it for what should live on the VM: deploying, hosting a site or tool for everyone, long-running jobs. For a process that should keep running (a server, a watcher), set background: true; its output goes to a log file whose path is returned.",
		parameters: Type.Object({
			command: Type.String(),
			background: Type.Optional(Type.Boolean({ description: "Start it and return at once, leaving it running" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds before a foreground command is stopped (default 600)" })),
		}),
		async execute(args, api, context) {
			if (args.background) {
				mkdirSync(join(workdir, ".syncpi", "logs"), { recursive: true });
				const log = join(workdir, ".syncpi", "logs", `${Date.now()}-${randomBytes(3).toString("hex")}.log`);
				const child = spawn("bash", ["-lc", `nohup bash -lc ${JSON.stringify(args.command)} > ${JSON.stringify(log)} 2>&1 & echo $!`], { cwd: workdir, env: env(), stdio: ["ignore", "pipe", "pipe"] });
				const pid = await new Promise<string>((resolve) => {
					let out = "";
					child.stdout.on("data", (d: Buffer) => (out += d));
					child.on("close", () => resolve(out.trim()));
				});
				return { output: [{ type: "text", text: `Started on the VM (pid ${pid}). Output: ${log}` }] };
			}
			const child = spawn("bash", ["-lc", args.command], { cwd: workdir, env: env(), stdio: ["ignore", "pipe", "pipe"] });
			const stop = () => child.kill("SIGTERM");
			context.abortSignal?.addEventListener("abort", stop, { once: true });
			const timer = setTimeout(stop, Math.min(3600, args.timeout ?? 600) * 1000);
			child.stdout.on("data", (d: Buffer) => api.output(d));
			child.stderr.on("data", (d: Buffer) => api.output(d));
			const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", stop);
			return code === 0 ? {} : { isError: true, diagnostics: [{ severity: "error", message: `exit code ${code ?? "killed"}` }] };
		},
	});

	const recordBrowser = defineTool({
		name: "record_browser",
		description:
			"Show people something working: a real browser on the session's VM opens a URL and goes through steps (click, type, scroll, captions) at a human pace with a visible pointer, and the recording is posted in the thread as a video. The URL must be reachable from the VM: a public site, or a server on the VM (start it with remote_bash, e.g. on http://localhost:5173). Keep it short and purposeful; use captions to say what is happening.",
		parameters: Type.Object({
			title: Type.String({ description: "What the video shows, a few words" }),
			url: Type.String(),
			steps: Type.Array(STEP, { maxItems: 60 }),
			width: Type.Optional(Type.Number()),
			height: Type.Optional(Type.Number()),
		}),
		async execute(args, api, context) {
			const id = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomBytes(3).toString("hex")}`;
			mkdirSync(join(workdir, RECORDINGS), { recursive: true });
			const out = join(workdir, RECORDINGS, id);
			const recorder = join(dirname(fileURLToPath(import.meta.url)), "recorder.mjs");
			const tools = toolsDir();
			const child = spawn(process.execPath, [recorder], {
				cwd: workdir,
				env: { ...env(), ...(tools ? { SYNCPI_TOOLS: tools } : {}), ...(process.env.SYNCPI_CHROMIUM ? { SYNCPI_CHROMIUM: process.env.SYNCPI_CHROMIUM } : {}), SYNCPI_DEBUG: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdin.end(JSON.stringify({ url: args.url, steps: args.steps, width: args.width, height: args.height, out }));
			const stop = () => child.kill("SIGTERM");
			context.abortSignal?.addEventListener("abort", stop, { once: true });
			const timer = setTimeout(stop, 10 * 60_000);
			let stdout = "";
			child.stdout.on("data", (d: Buffer) => (stdout += d));
			child.stderr.on("data", (d: Buffer) => api.output(d));
			await new Promise((resolve) => child.on("close", resolve));
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", stop);
			const result = JSON.parse(stdout.trim().split("\n").pop() || "{}") as { video?: string; poster?: string; seconds?: number; log?: string[]; error?: string };
			if (result.video === undefined) {
				const why = result.error ?? "the recorder stopped";
				const hint = /Cannot find module|playwright/i.test(why) ? " The VM's browser tools aren't installed; the session owner can run `syncpi update`." : "";
				return { isError: true, output: [{ type: "text", text: `Couldn't record: ${why}${hint}` }] };
			}
			const rel = (path: string) => path.slice(workdir.length + 1);
			const details: RecordingDetails = { video: rel(result.video), poster: result.poster ? rel(result.poster) : undefined, title: args.title, seconds: result.seconds, error: result.error };
			const text = result.error
				? `Recorded ${result.seconds}s, but a step failed: ${result.error}. The video shows what happened up to there; it's in the thread.`
				: `Recorded ${result.seconds}s; the video is in the thread for everyone.`;
			return { output: [{ type: "text", text }], details };
		},
	});

	return defineExtension({ name: "syncpi-remote", tools: [remoteBash, recordBrowser] });
}
