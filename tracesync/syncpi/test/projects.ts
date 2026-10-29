// Projects in the app (the shell, through its host, in Chrome): a new project from the command palette (⌘⇧P) and from
// the sidebar, and who else is in a project, shown in the sidebar. `npm run test:projects`.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { Connection } from "../src/cli/client.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const dist = join(import.meta.dirname, "../dist");
// Real paths, as the app keeps them (on macOS the temp folder is under /private).
const root = realpathSync(mkdtempSync(join(tmpdir(), "syncpi-projects-test-")));
const processes: ChildProcess[] = [];
let browser: Browser | undefined;
let checks = 0;
const ok = (text: string) => console.log(`✓ ${++checks}. ${text}`);
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < end) {
		last = await probe();
		if (last) return last as NonNullable<T>;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`);
}

const mod = process.platform === "darwin" ? "Meta" : "Control";
const folder = (name: string) => {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "README.md"), `# ${name}\n`);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
};
const shapes = folder("shapes");
const other = folder("other");

let bob: Connection | undefined;
try {
	const home = join(root, "home-app");
	const host = spawn(process.execPath, [join(dist, "desktop-host.mjs"), "--faux"], { env: { ...process.env, SYNCPI_HOME: home, PI_CODING_AGENT_DIR: join(root, "empty-pi") }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(host);
	let out = "";
	host.stdout!.on("data", (d) => (out += d));
	const launch = await until("the app's host", () => out.match(/SYNCPI_APP (\S+)/)?.[1]);

	browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: "chrome" });
	const app = await (await browser.newContext({ viewport: { width: 1300, height: 820 } })).newPage();
	const errors: string[] = [];
	app.on("pageerror", (e) => errors.push(e.message));
	await app.goto(launch);
	// In a browser there's no native folder picker; the shell asks with a prompt instead.
	const pick = (dir: string) => app.evaluate((d) => (window.prompt = () => d), dir);

	// 1. ⌘⇧P, "new project": the folder, then where it runs; it opens.
	await pick(shapes);
	await app.locator("body").click();
	await app.keyboard.press(`${mod}+Shift+p`);
	await until("the palette", () => app.locator("#palette").isVisible());
	await app.keyboard.type("new project");
	const first = await until("the command", async () => (await app.locator("#palette-list [aria-selected='true'] .palette-title").textContent()) ?? undefined);
	check(first === "New project (open a folder)", `the first command is New project (${first})`);
	await app.keyboard.press("Enter");
	await until("the new project dialog", () => app.locator("#create-dialog").isVisible());
	check((await app.locator("#create-dialog h2").textContent()) === "New project", "titled New project");
	check((await app.locator("#create-dir").inputValue()) === shapes, "with the folder picked");
	await app.getByRole("button", { name: "Create project" }).click();
	await until("the project in the sidebar", () => app.locator(`.sidebar-project[data-dir="${shapes}"]`).count());
	await until("its thread open", () => app.frameLocator("iframe.session-frame:not([hidden])").locator("#input").isVisible(), 60_000);
	ok("⌘⇧P, “new project”: pick a folder, choose where it runs, and the project opens with its first thread");

	// 2. The sidebar's New project button does the same.
	await pick(other);
	await app.locator(".sidebar-new-project").click();
	await until("the dialog again", () => app.locator("#create-dialog").isVisible());
	check((await app.locator("#create-dir").inputValue()) === other, "with the folder picked");
	await app.locator("#create-dialog [data-close]").click();
	ok("the New project button on the sidebar's Projects heading opens the same flow");

	// 3. Bob joins the project's thread: the sidebar shows him, here now.
	const record = JSON.parse(readFileSync(join(home, "sessions", readdirSync(join(home, "sessions")).find((f) => /^\w+\.json$/.test(f))!), "utf8")) as { url: string; token: string };
	const owner = new Connection(record.url, record.token);
	const invite = new Promise<string>((resolve) => {
		owner.onMessage = (m: ServerMessage) => {
			if (m.type === "invite") resolve(m.url);
		};
	});
	owner.start();
	owner.send({ type: "invite" });
	const link = await invite;
	owner.close();
	const joined = (await (await fetch(`${record.url}/api/join`, { method: "POST", body: JSON.stringify({ invite: link.match(/\/s\/([\w-]+)/)![1], name: "Bob" }) })).json()) as { token: string };
	bob = new Connection(record.url, joined.token);
	bob.start();
	const head = app.locator(`.sidebar-project[data-dir="${shapes}"]`);
	await until("Bob on the project", () => head.locator(".sidebar-people .avatar.online").count());
	check((await head.locator(".sidebar-people .avatar").textContent()) === "B", "his initial");
	check((await head.locator(".sidebar-people").getAttribute("title")) === "Shared with Bob; Bob is here now", `said in full (${await head.locator(".sidebar-people").getAttribute("title")})`);
	const shared = app.locator(".sidebar-thread .thread-shared");
	check((await shared.count()) === 1 && (await shared.getAttribute("class"))?.includes("online"), "the thread shows it's shared, with someone there now");
	if (process.env.PROJECTS_SHOT) await app.locator("#sidebar").screenshot({ path: process.env.PROJECTS_SHOT });
	ok("a collaborator shows on the project (their avatar, with a dot while they're here) and on the thread");

	// 4. Bob leaves: still shared, nobody here.
	bob.close();
	await until("Bob gone", async () => (await head.locator(".sidebar-people .avatar.online").count()) === 0);
	check((await head.locator(".sidebar-people").getAttribute("title")) === "Shared with Bob", "still shared with him");
	check(!(await shared.getAttribute("class"))?.includes("online"), "nobody there now");
	ok("when they leave, the project still shows them, without the dot");

	check(errors.length === 0, `page errors: ${errors.join("; ")}`);
	console.log(`\nAll ${checks} project checks passed.`);
} finally {
	bob?.close();
	await browser?.close();
	for (const p of processes) p.kill();
	spawnSync("pkill", ["-f", root]);
	rmSync(root, { recursive: true, force: true });
}
