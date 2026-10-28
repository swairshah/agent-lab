// Records a browser doing something, for the agent's `record_browser` tool (src/server/remote-tools.ts): a real
// Chromium (Playwright) opens a page and goes through steps (click, type, scroll, …) at a human pace, with a visible
// pointer, while Playwright records the page. ffmpeg turns the recording into an MP4 people can play anywhere, and a
// still of the last frame is kept as its poster. With `shot`, for `screenshot_browser`, it goes through the steps
// at full speed and only takes a picture at the end.
//
// Run as its own process, so a hung page can't take the session server down:
//   node recorder.mjs < request.json  → prints the result as JSON on its last line
// Playwright comes from SYNCPI_TOOLS (on a VM, the tools syncpi installs next to the server), else from beside this
// script.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Step =
	| { action: "goto"; url: string }
	| { action: "click"; target: string }
	| { action: "type"; target?: string; text: string }
	| { action: "press"; key: string }
	| { action: "hover"; target: string }
	| { action: "scroll"; y: number }
	| { action: "wait"; ms: number }
	| { action: "waitFor"; target: string }
	| { action: "caption"; text: string };

export type RecordRequest = { url: string; steps: Step[]; width?: number; height?: number; out: string; shot?: { fullPage?: boolean } };
export type RecordResult = { video: string; poster: string; seconds: number; log: string[]; error?: string };
export type ShotResult = { image: string; log: string[]; error?: string };

/** A pointer drawn in the page, following the mouse, so a viewer can see where it clicks. Captions show at the bottom. */
const OVERLAY = `(() => {
  const add = () => {
    if (document.getElementById("__syncpi_pointer")) return;
    const p = document.createElement("div");
    p.id = "__syncpi_pointer";
    p.style.cssText = "position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(198,67,44,.85);box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .12s ease";
    document.documentElement.appendChild(p);
    addEventListener("mousemove", (e) => { p.style.left = e.clientX + "px"; p.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => (p.style.transform = "scale(.7)"), true);
    addEventListener("mouseup", () => (p.style.transform = ""), true);
    const c = document.createElement("div");
    c.id = "__syncpi_caption";
    c.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:80%;padding:10px 18px;border-radius:10px;background:rgba(20,20,20,.82);color:#fff;font:500 18px/1.35 system-ui,sans-serif;z-index:2147483647;pointer-events:none;display:none;text-align:center";
    document.documentElement.appendChild(c);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

/** A step's target: CSS, or text=…, role=…, label=…, placeholder=… as in Playwright. */
function locate(page: import("playwright").Page, target: string): import("playwright").Locator {
	const [kind, ...rest] = target.split("=");
	const value = rest.join("=");
	if (rest.length > 0) {
		if (kind === "text") return page.getByText(value, { exact: false }).first();
		if (kind === "role") {
			const [role, name] = value.split(":");
			return page.getByRole(role as Parameters<import("playwright").Page["getByRole"]>[0], name ? { name } : {}).first();
		}
		if (kind === "label") return page.getByLabel(value).first();
		if (kind === "placeholder") return page.getByPlaceholder(value).first();
	}
	return page.locator(target).first();
}

async function moveTo(page: import("playwright").Page, target: import("playwright").Locator): Promise<void> {
	await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
	const box = await target.boundingBox();
	if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
}

function playwright(): typeof import("playwright") {
	const tools = process.env.SYNCPI_TOOLS;
	const require = createRequire(tools ? join(tools, "package.json") : import.meta.url);
	return require("playwright") as typeof import("playwright");
}

/** Goes through the steps, with a beat between them when someone will watch (`beat`, ms). */
async function runSteps(page: import("playwright").Page, steps: Step[], log: string[], beat: number): Promise<void> {
	for (const [n, step] of steps.entries()) {
		log.push(`${n + 1}. ${JSON.stringify(step)}`);
		if (process.env.SYNCPI_DEBUG) console.error(log.at(-1));
		switch (step.action) {
			case "goto":
				await page.goto(step.url, { waitUntil: "load", timeout: 30_000 });
				break;
			case "click": {
				const target = locate(page, step.target);
				if (beat > 0) {
					await moveTo(page, target);
					await page.waitForTimeout(200);
				}
				await target.click();
				break;
			}
			case "hover":
				await moveTo(page, locate(page, step.target));
				break;
			case "type":
				if (step.target) {
					const target = locate(page, step.target);
					if (beat > 0) await moveTo(page, target);
					await target.click();
				}
				await page.keyboard.type(step.text, { delay: beat > 0 ? 55 : 0 });
				break;
			case "press":
				await page.keyboard.press(step.key);
				break;
			case "scroll":
				await page.mouse.wheel(0, step.y);
				break;
			case "wait":
				await page.waitForTimeout(Math.min(30_000, Math.max(0, step.ms)));
				break;
			case "waitFor":
				await locate(page, step.target).waitFor({ state: "visible", timeout: 30_000 });
				break;
			case "caption":
				await page.evaluate((text) => {
					const c = document.getElementById("__syncpi_caption");
					if (c === null) return;
					c.textContent = text;
					c.style.display = text ? "block" : "none";
				}, step.text);
				break;
		}
		// A beat between steps, so a viewer can follow.
		if (beat > 0) await page.waitForTimeout(step.action === "wait" ? 0 : beat);
	}
}

/** A picture of the page after the steps: the viewport, or the whole page. */
export async function screenshot(request: RecordRequest): Promise<ShotResult> {
	const { chromium } = playwright();
	const width = Math.min(1920, Math.max(320, request.width ?? 1280));
	const height = Math.min(2000, Math.max(320, request.height ?? 800));
	const log: string[] = [];
	let error: string | undefined;
	const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.SYNCPI_CHROMIUM || undefined });
	const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
	page.setDefaultTimeout(15_000);
	const image = `${request.out}.png`;
	try {
		await page.goto(request.url, { waitUntil: "load", timeout: 30_000 });
		await runSteps(page, request.steps, log, 0);
		// Let fonts, images and transitions settle.
		await page.waitForTimeout(400);
	} catch (e) {
		error = (e as Error).message.split("\n")[0];
		log.push(`stopped: ${error}`);
	}
	await page.screenshot({ path: image, fullPage: request.shot?.fullPage === true }).catch((e: Error) => (error ??= e.message.split("\n")[0]));
	await browser.close();
	return { image, log, error };
}

export async function record(request: RecordRequest): Promise<RecordResult> {
	const { chromium } = playwright();
	const width = Math.min(1920, Math.max(480, request.width ?? 1280));
	const height = Math.min(1200, Math.max(360, request.height ?? 800));
	const raw = `${request.out}.raw`;
	rmSync(raw, { recursive: true, force: true });
	mkdirSync(raw, { recursive: true });
	const log: string[] = [];
	const started = Date.now();
	let error: string | undefined;
	// SYNCPI_CHROMIUM: a Chromium to use instead of the one Playwright installed.
	const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.SYNCPI_CHROMIUM || undefined });
	const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: raw, size: { width, height } }, deviceScaleFactor: 1 });
	await context.addInitScript(OVERLAY);
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	const poster = `${request.out}.png`;
	try {
		await page.goto(request.url, { waitUntil: "load", timeout: 30_000 });
		await page.mouse.move(width / 2, height / 2);
		await page.waitForTimeout(700);
		await runSteps(page, request.steps, log, 650);
		await page.waitForTimeout(1000);
	} catch (e) {
		error = (e as Error).message.split("\n")[0];
		log.push(`stopped: ${error}`);
	}
	await page.screenshot({ path: poster }).catch(() => {});
	await context.close();
	await browser.close();
	const webm = readdirSync(raw).find((f) => f.endsWith(".webm"));
	if (webm === undefined) throw new Error("the browser left no recording");
	const video = `${request.out}.mp4`;
	// H.264 in an MP4 plays in every browser and on phones; the frame size must be even.
	await run("ffmpeg", ["-y", "-loglevel", "error", "-i", join(raw, webm), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", video]).catch((e: Error) => {
		// No usable ffmpeg: keep the WebM, which browsers other than Safari play.
		log.push(`ffmpeg: ${e.message.split("\n")[0]}`);
		renameSync(join(raw, webm), `${request.out}.webm`);
	});
	const out = statSync(video, { throwIfNoEntry: false }) ? video : `${request.out}.webm`;
	rmSync(raw, { recursive: true, force: true });
	return { video: out, poster, seconds: Math.round((Date.now() - started) / 100) / 10, log, error };
}

// As a process: the request on stdin, the result as the last line of stdout.
if (process.argv[1]?.endsWith("recorder.mjs") || process.argv[1]?.endsWith("recorder.ts")) {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	try {
		const request = JSON.parse(Buffer.concat(chunks).toString()) as RecordRequest;
		const result = request.shot !== undefined ? await screenshot(request) : await record(request);
		console.log(JSON.stringify(result));
	} catch (e) {
		console.log(JSON.stringify({ error: (e as Error).message }));
		process.exitCode = 1;
	}
}
