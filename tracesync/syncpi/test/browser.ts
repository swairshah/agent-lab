// The thread page in a browser and the app's window, headless:
//   1. on a session's VM, its admin gets a terminal in the browser: a shell in the project's folder there
//   2. a link in the thread opens in a new tab (the thread is contenteditable, where browsers don't follow links)
//   3. dropdowns leave room between their chevron and the border
//   4. the app's sidebar resizes by dragging its edge, and keeps its width
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const repo = join(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "syncpi-browser-")));
const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
const port = await freePort();
const host = `http://127.0.0.1:${port}`;

// A session as `syncpi` provisions it on a VM (src/cli/provision.ts), with Ada as its admin.
const id = "vmsession1";
const token = "ada-token-for-the-browser-test";
const workdir = join(root, "projects", id, "demo");
mkdirSync(workdir, { recursive: true });
writeFileSync(join(workdir, "README.md"), "# demo\n");
const state = join(root, "sessions", id);
mkdirSync(state, { recursive: true });
writeFileSync(
	join(state, "server.json"),
	JSON.stringify({
		id,
		name: "demo",
		workdir,
		url: `${host}/${id}`,
		vm: "syncpi",
		model: "faux/faux-1",
		setupModel: "faux/faux-1",
		auth: "exe-gateway",
		members: { ada: { id: "ada", name: "Ada", role: "admin", creator: true, tokens: [createHash("sha256").update(token).digest("hex")], joinedAt: Date.now() } },
		invites: {},
		setup: { status: "done" },
	}),
);

const processes: ChildProcess[] = [];
const server = spawn(process.execPath, [join(repo, "dist", "server.mjs"), "--sessions", join(root, "sessions"), "--port", String(port), "--host", "127.0.0.1", "--faux"], { stdio: ["ignore", "pipe", "pipe"] });
processes.push(server);
server.stderr!.on("data", (d) => process.env.VERBOSE && process.stderr.write(`  server! ${d}`));

async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await check();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`timed out waiting for ${what}`);
}
let step = 0;
const ok = (text: string) => console.log(`✓ ${++step}. ${text}`);

const browser = await chromium.launch({ channel: "chrome" });
try {
	await waitFor("the server", () => fetch(`${host}/healthz`).then((r) => r.ok).catch(() => false));
	const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
	const page = await context.newPage();
	page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
	await page.goto(`${host}/${id}/#token=${token}`);
	await page.locator("#input").waitFor({ state: "visible", timeout: 30_000 });
	await page.locator("#terminal-toggle").waitFor({ state: "visible" });
	await page.locator("#terminal-toggle").click();
	await page.locator(".xterm-helper-textarea").waitFor({ state: "attached", timeout: 15_000 });
	await waitFor("a prompt", async () => ((await page.locator(".xterm-rows").textContent()) ?? "").trim().length > 0, 20_000);
	await page.locator(".xterm-helper-textarea").focus();
	await page.keyboard.type("echo here-$((6*7)) && pwd");
	await page.keyboard.press("Enter");
	await waitFor("the shell's answer", async () => {
		const text = ((await page.locator(".xterm-rows").textContent()) ?? "").replace(/\s/g, "");
		return text.includes("here-42") && text.includes(workdir.replace(/\s/g, ""));
	});
	ok("the session's admin got a terminal in the browser, in the project's folder on the VM");

	await page.evaluate(() => {
		const a = Object.assign(document.createElement("a"), { href: "https://example.com/from-the-thread", target: "_blank", textContent: "a link" });
		document.querySelector("#thread")!.append(a);
	});
	const [popup] = await Promise.all([context.waitForEvent("page"), page.locator('a[href="https://example.com/from-the-thread"]').click()]);
	if (!popup.url().includes("example.com/from-the-thread")) throw new Error(`the link opened ${popup.url()}`);
	await popup.close();
	ok("a link in the thread opened in a new tab");

	const padding = await page.locator("select").first().evaluate((e) => parseFloat(getComputedStyle(e).paddingRight));
	if (padding < 24) throw new Error(`a dropdown's right padding is ${padding}px`);
	ok(`dropdowns have ${padding}px for their chevron`);

	const appPort = await freePort();
	const app = spawn(process.execPath, [join(repo, "dist", "desktop-host.mjs"), "--port", String(appPort)], { env: { ...process.env, SYNCPI_HOME: join(root, "home") }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(app);
	let output = "";
	app.stdout!.on("data", (d) => (output += d));
	const launch = await waitFor("the app's launch link", () => /SYNCPI_APP (\S+)/.exec(output)?.[1]);
	const win = await context.newPage();
	await win.goto(launch);
	await win.locator("#sidebar-resize").waitFor({ state: "attached" });
	const before = await win.locator("#sidebar").evaluate((e) => e.getBoundingClientRect().width);
	const edge = (await win.locator("#sidebar-resize").boundingBox())!;
	await win.mouse.move(edge.x + 3, edge.y + 300);
	await win.mouse.down();
	await win.mouse.move(edge.x + 83, edge.y + 300, { steps: 5 });
	await win.mouse.up();
	const after = await win.locator("#sidebar").evaluate((e) => e.getBoundingClientRect().width);
	if (Math.abs(after - before - 80) > 4) throw new Error(`dragging the edge 80px made the sidebar ${before} → ${after}`);
	await win.reload();
	await win.locator("#sidebar").waitFor();
	const kept = await win.locator("#sidebar").evaluate((e) => e.getBoundingClientRect().width);
	if (Math.abs(kept - after) > 2) throw new Error(`the sidebar's width wasn't kept: ${after} → ${kept}`);
	ok(`the app's sidebar went ${before} → ${after}px by its edge, and kept it`);
	console.log(`browser test passed (${root})`);
} catch (error) {
	console.error(`FAILED: ${(error as Error).message}`);
	console.error(`(state in ${root})`);
	process.exitCode = 1;
} finally {
	await browser.close();
	for (const p of processes) p.kill();
	process.exit();
}
