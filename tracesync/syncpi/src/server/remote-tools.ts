// Tools that always run on the session's VM (where this server runs), whatever machine a run's other tools are on:
// every agent in the session has them, so an agent working on someone's Mac can still deploy, host or record from
// the VM, where things keep running when that Mac sleeps.
//
//   remote_bash         a command in the VM's copy of the project (long-running ones in the background)
//   record_browser      a real browser on the VM doing something, recorded as a video for the thread
//   screenshot_browser  a picture of a page in that browser, which the agent sees and the thread shows
//
// Recordings and screenshots go to .syncpi/recordings/ in the VM's copy (not synced); the thread shows them
// (thread-view.ts) through GET api/recording (room.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
export type ScreenshotDetails = { image: string; title: string; error?: string };

/** Runs the recorder (recorder.ts) in its own process; its last line of output is the result. */
async function runRecorder(workdir: string, env: NodeJS.ProcessEnv, request: Record<string, unknown>, onLog: (d: Buffer) => void, signal: AbortSignal | undefined, ms: number): Promise<Record<string, unknown>> {
	const recorder = join(dirname(fileURLToPath(import.meta.url)), "recorder.mjs");
	const tools = toolsDir();
	const child = spawn(process.execPath, [recorder], {
		cwd: workdir,
		env: { ...env, ...(tools ? { SYNCPI_TOOLS: tools } : {}), ...(process.env.SYNCPI_CHROMIUM ? { SYNCPI_CHROMIUM: process.env.SYNCPI_CHROMIUM } : {}), SYNCPI_DEBUG: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(JSON.stringify(request));
	const stop = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", stop, { once: true });
	const timer = setTimeout(stop, ms);
	let stdout = "";
	child.stdout.on("data", (d: Buffer) => (stdout += d));
	child.stderr.on("data", onLog);
	await new Promise((resolve) => child.on("close", resolve));
	clearTimeout(timer);
	signal?.removeEventListener("abort", stop);
	try {
		return JSON.parse(stdout.trim().split("\n").pop() || "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Why the recorder failed, with what to do when the VM lacks its browser. */
const why = (error: unknown) => {
	const text = typeof error === "string" ? error : "the recorder stopped";
	return /Cannot find module|playwright/i.test(text) ? `${text}. The VM's browser tools aren't installed; the session owner can run \`syncpi update\`.` : text;
};

/** Where a new recording or screenshot goes (without its extension). */
function outPath(workdir: string): string {
	mkdirSync(join(workdir, RECORDINGS), { recursive: true });
	return join(workdir, RECORDINGS, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomBytes(3).toString("hex")}`);
}

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
			const out = outPath(workdir);
			const request = { url: args.url, steps: args.steps, width: args.width, height: args.height, out };
			const result = (await runRecorder(workdir, env(), request, (d) => api.output(d), context.abortSignal, 10 * 60_000)) as { video?: string; poster?: string; seconds?: number; error?: string };
			if (result.video === undefined) return { isError: true, output: [{ type: "text", text: `Couldn't record: ${why(result.error)}` }] };
			const rel = (path: string) => path.slice(workdir.length + 1);
			const details: RecordingDetails = { video: rel(result.video), poster: result.poster ? rel(result.poster) : undefined, title: args.title, seconds: result.seconds, error: result.error };
			const text = result.error
				? `Recorded ${result.seconds}s, but a step failed: ${result.error}. The video shows what happened up to there; it's in the thread.`
				: `Recorded ${result.seconds}s; the video is in the thread for everyone.`;
			return { output: [{ type: "text", text }], details };
		},
	});

	const screenshotBrowser = defineTool({
		name: "screenshot_browser",
		description:
			"Look at a page: a real browser on the session's VM opens a URL, goes through optional steps (click, type, scroll, wait…), and takes a screenshot. You see the image, and it's shown in the thread for everyone. Use it to check your own UI work, or to show people how something looks. The URL must be reachable from the VM: a public site, or a server on the VM (start it with remote_bash). For something to watch happen, use record_browser instead.",
		parameters: Type.Object({
			title: Type.String({ description: "What the picture shows, a few words" }),
			url: Type.String(),
			steps: Type.Optional(Type.Array(STEP, { maxItems: 40 })),
			width: Type.Optional(Type.Number({ description: "Viewport width in pixels (default 1280; 390 for a phone)" })),
			height: Type.Optional(Type.Number({ description: "Viewport height in pixels (default 800)" })),
			fullPage: Type.Optional(Type.Boolean({ description: "The whole page, not just what fits in the viewport" })),
		}),
		async execute(args, api, context) {
			const out = outPath(workdir);
			const request = { url: args.url, steps: args.steps ?? [], width: args.width, height: args.height, out, shot: { fullPage: args.fullPage === true } };
			const result = (await runRecorder(workdir, env(), request, (d) => api.output(d), context.abortSignal, 3 * 60_000)) as { image?: string; error?: string };
			const bytes = result.image !== undefined && existsSync(result.image) ? readFileSync(result.image) : undefined;
			if (bytes === undefined) return { isError: true, output: [{ type: "text", text: `Couldn't take a screenshot: ${why(result.error)}` }] };
			const details: ScreenshotDetails = { image: result.image!.slice(workdir.length + 1), title: args.title, error: result.error };
			const text = result.error ? `A step failed (${result.error}); this is the page as it was then. It's shown in the thread.` : "Here is the page; it's shown in the thread.";
			return { output: [{ type: "text", text }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }], details };
		},
	});

	return defineExtension({ name: "syncpi-remote", tools: [remoteBash, recordBrowser, screenshotBrowser] });
}
