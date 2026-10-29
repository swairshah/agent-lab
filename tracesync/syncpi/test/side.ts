// Side threads (/side): a private fork of the thread per person. Ada owns a session with the scripted model (from a
// terminal, headless, and two browser tabs); Bob is an editor in another browser. Everything Bob's browser receives is
// recorded, and none of Ada's side thread may be in it. `npm run test:side` (needs Chrome, or PLAYWRIGHT_CHROMIUM).
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const dist = join(import.meta.dirname, "../dist");
const root = mkdtempSync(join(tmpdir(), "syncpi-side-test-"));
const processes: ChildProcess[] = [];
let browser: Browser | undefined;
let checks = 0;
const ok = (text: string) => console.log(`✓ ${++checks}. ${text}`);
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function until<T>(what: string, probe: () => Promise<T> | T, ms = 20_000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < end) {
		last = await probe();
		if (last) return last as NonNullable<T>;
		await new Promise((r) => setTimeout(r, 60));
	}
	throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`);
}

const CART = "export const TOTAL = 42;\n";
const dir = join(root, "cart");
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src/cart.ts"), CART);
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["add", "-A"], { cwd: dir });
execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-qm", "init"], { cwd: dir });

// Ada's terminal: the headless client, which prints the shared thread and, as "side …", Ada's side thread.
const home = join(root, "home");
const lines: string[] = [];
const cli = spawn(process.execPath, [join(dist, "cli.mjs"), "--headless", "--faux", "--name", "Ada", "--no-sync"], { cwd: dir, env: { ...process.env, SYNCPI_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
processes.push(cli);
let buf = "";
cli.stdout!.on("data", (d) => {
	buf += d;
	const parts = buf.split("\n");
	buf = parts.pop()!;
	lines.push(...parts);
});
const type = (line: string) => cli.stdin!.write(`${line}\n`);
const saw = (text: string) => lines.some((l) => l.includes(text));

const mod = process.platform === "darwin" ? "Meta" : "Control";
const threadText = (page: Page) => page.locator("#thread").textContent();
/** Sends what's in the composer, and waits for a reply containing `reply`. */
async function send(page: Page, text: string, reply: string): Promise<void> {
	await page.locator("#input").click();
	await page.keyboard.type(text);
	await page.keyboard.press(`${mod}+Enter`);
	await until(`"${reply}"`, async () => (await threadText(page))?.includes(reply));
}
const showing = (page: Page) => page.evaluate(() => (document.querySelector("#setup-banner") as HTMLElement).hidden ? "main" : document.querySelector("#side-title")!.textContent);

try {
	await until("the session to start", () => saw("connection open"), 60_000);
	const record = JSON.parse(readFileSync(join(home, "sessions", readdirSync(join(home, "sessions")).find((f) => /^\w+\.json$/.test(f))!), "utf8")) as { url: string; token: string };
	type("/session-share");
	const share = await until("a share link", () => lines.find((l) => l.startsWith("share "))?.split(" ")[1]);
	const bob = (await (await fetch(`${record.url}/api/join`, { method: "POST", body: JSON.stringify({ invite: share.match(/\/s\/([\w-]+)/)![1], name: "Bob" }) })).json()) as { token: string };

	browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: "chrome" });
	const errors: string[] = [];
	const received: string[] = [];
	const url = record.url;
	const open = async (token: string, frames?: string[]) => {
		const page = await (await browser!.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
		page.on("pageerror", (e) => errors.push(e.message));
		if (frames) page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(typeof f.payload === "string" ? f.payload : f.payload.toString("utf8"))));
		await page.goto(`${url}/#token=${token}`);
		await page.waitForFunction(() => document.querySelector("#me-avatar")?.textContent);
		return page;
	};
	const A = await open(record.token);
	const A2 = await open(record.token);
	const B = await open(bob.token, received);

	type("The cart total is in src/cart.ts");
	await until("the shared reply", async () => (await threadText(B))?.includes("(faux) The cart total is in src/cart.ts"));

	// Bob follows Ada.
	await B.locator("#presence [data-member]").first().click();
	await until("Bob following", () => B.evaluate(() => !(document.querySelector("#follow-bar") as HTMLElement).hidden));

	// Ada asks in their side thread, typed into the composer as /side <question>.
	await send(A, "/side what did we decide about the total?", "(faux) what did we decide about the total?");
	check((await showing(A))?.startsWith("Your side thread"), `Ada sees her side thread (${await showing(A)})`);
	const side = (await threadText(A))!;
	check(side.includes("The cart total is in src/cart.ts"), "the side thread starts from the thread's history");
	ok("/side <question> forks the thread into Ada's side thread, with its history, shows it, and asks it");

	check((await showing(B)) === "main", "Bob stays in the shared thread");
	await until("Bob is told", () => B.locator("#toast").textContent().then((t) => t?.includes("Ada is in their private side thread")));
	check(!(await threadText(B))!.includes("what did we decide"), "Bob's thread has no side question");
	ok("Bob, following Ada, stays in the shared thread and is told only that Ada is in their private side thread");

	// Typing in the side thread doesn't go to the shared draft; the draft in the thread is kept.
	await A.locator("#input").click();
	await A.keyboard.type("private typing in the side thread");
	await A.waitForTimeout(800);
	await A.locator("#setup-back").click();
	check((await A.locator("#input").inputValue()) === "", "the main composer is as Ada left it (empty)");
	await A.locator("#input").click();
	await A.keyboard.type("a draft for the thread");
	await until("Bob sees Ada's draft", async () => (await threadText(B))?.includes("a draft for the thread"));
	await A.evaluate(() => (window as Window & { syncpiRun?: (id: string) => boolean }).syncpiRun?.("agent.side"));
	await until("the side thread again", async () => (await showing(A))?.startsWith("Your side thread"));
	check((await A.locator("#input").inputValue()) === "private typing in the side thread", "the side composer keeps what was typed there");
	await A.locator("#setup-back").click();
	check((await A.locator("#input").inputValue()) === "a draft for the thread", "back in the thread, the shared draft is there");
	ok("the composer is private in the side thread, keeps what was typed in each, and the shared draft carries on");

	// Ada's other tab has the same side thread.
	await A2.evaluate(() => (window as Window & { syncpiRun?: (id: string) => boolean }).syncpiRun?.("agent.side"));
	await until("Ada's other tab shows it", async () => (await threadText(A2))?.includes("(faux) what did we decide about the total?"));
	ok("Ada's other tab opens the same side thread");

	// The side agent can't change files.
	await A.evaluate(() => (window as Window & { syncpiRun?: (id: string) => boolean }).syncpiRun?.("agent.side"));
	await A.locator("#input").fill("");
	await A.locator("#input").click();
	await A.keyboard.type("edit src/cart.ts 42 => 43");
	await A.keyboard.press(`${mod}+Enter`);
	await until("the edit to fail", () => A.evaluate(() => [...document.querySelectorAll("#thread .tool")].some((t) => t.classList.contains("tool-error") || /not found|unknown|isn't available|not available/i.test(t.textContent ?? ""))), 20_000);
	await A.waitForTimeout(500);
	check(readFileSync(join(dir, "src/cart.ts"), "utf8") === CART, "src/cart.ts is unchanged");
	const failure = await A.evaluate(() => [...document.querySelectorAll("#thread .tool")].at(-1)?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120));
	ok(`the side agent has no edit tool: an edit fails ("${failure}") and the file is unchanged`);

	// A new message in the side thread interrupts its own run, as in the thread.
	await A.locator("#input").click();
	await A.keyboard.type("run sleep 8; echo slept-through");
	await A.keyboard.press(`${mod}+Enter`);
	await until("the command to run", () => A.evaluate(() => document.querySelector("#thread .tool-running") !== null));
	const started = Date.now();
	await send(A, "quick question", "(faux) quick question");
	check(Date.now() - started < 6_000, "the reply came before the command would have finished");
	check(await A.evaluate(() => ![...document.querySelectorAll("#thread .tool-output")].some((o) => o.textContent?.includes("slept-through"))), "the command was stopped before it printed");
	ok("a message in the side thread stops its run and is answered at once");

	// The terminal: /side new forks it again, from the thread as it is now; every client of Ada's shows the new one.
	type("/side new hello from the terminal");
	await until("the terminal's side reply", () => saw("side agent: (faux) hello from the terminal"));
	check(saw("side [Ada] The cart total is in src/cart.ts"), "the terminal's side thread has the thread's history");
	await until("the browser's side thread replaced", async () => {
		const text = (await threadText(A))!;
		return text.includes("hello from the terminal") && !text.includes("quick question");
	});
	ok("/side new in the terminal forks a fresh side thread; Ada's browser shows it in place of the old one");

	// Nothing of the side thread reached Bob: not in what his browser received, not in what it shows.
	const secrets = ["what did we decide", "private typing", "edit src/cart.ts 42", "quick question", "slept-through", "hello from the terminal", "private side thread: a fork"];
	const leaked = secrets.filter((s) => received.some((frame) => frame.includes(s)));
	check(leaked.length === 0, `Bob's browser received: ${leaked.join(", ")}`);
	check(received.length > 20, "Bob's frames were recorded");
	const bobText = (await B.locator("body").textContent())!;
	check(!secrets.some((s) => bobText.includes(s)), "Bob's page shows none of it");
	check(!lines.some((l) => l.startsWith("[Ada] what did we decide") || l.startsWith("agent: (faux) quick question")), "the shared thread (in the terminal) has none of it");
	ok(`none of Ada's side thread reached Bob (${received.length} frames checked) or the shared thread`);

	// Bob has a side thread of his own, which Ada doesn't see.
	await send(B, "/side is the total tested?", "(faux) is the total tested?");
	check(!(await threadText(B))!.includes("hello from the terminal"), "Bob's side thread isn't Ada's");
	await B.waitForTimeout(500);
	check(!(await A.locator("body").textContent())!.includes("is the total tested"), "Ada doesn't see Bob's");
	ok("Bob's side thread is Bob's own; Ada doesn't see it");

	// The side agent was told what it is (its instructions are stored with its conversation).
	const stored = readdirSync(home, { recursive: true, encoding: "utf8" })
		.filter((f) => /session\.sqlite(-wal)?$/.test(f))
		.map((f) => readFileSync(join(home, f)).toString("latin1"));
	check(stored.some((db) => db.includes("This is Ada's private side thread")), "Ada's side agent has its instructions");
	check(stored.some((db) => db.includes("This is Bob's private side thread")), "Bob's side agent has its instructions");
	ok("each side agent's instructions say whose private side thread it is, and not to change anything");

	// In the app, the page receives over its own connection but sends through the app's (so requests can run on
	// this machine): /side still opens in the page that asked.
	const appDir = join(root, "app");
	mkdirSync(appDir);
	writeFileSync(join(appDir, "README.md"), "# App\n");
	execFileSync("git", ["init", "-q"], { cwd: appDir });
	const host = spawn(process.execPath, [join(dist, "desktop-host.mjs"), "--faux"], { env: { ...process.env, SYNCPI_HOME: join(root, "home-app"), PI_CODING_AGENT_DIR: join(root, "empty-pi") }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(host);
	let hostOut = "";
	host.stdout!.on("data", (d) => (hostOut += d));
	const launch = await until("the app's host", () => hostOut.match(/SYNCPI_APP (\S+)/)?.[1], 30_000);
	const app = await (await browser.newContext({ viewport: { width: 1300, height: 820 } })).newPage();
	app.on("pageerror", (e) => errors.push(e.message));
	await app.goto(launch);
	await app.evaluate((d) => (window.prompt = () => d), appDir);
	await app.getByRole("button", { name: "Open a project" }).click();
	await app.getByRole("button", { name: "Start thread" }).click();
	const inApp = app.frameLocator("iframe.session-frame:not([hidden])");
	await inApp.locator("#input").waitFor({ timeout: 60_000 });
	await inApp.locator("#input").click();
	await app.keyboard.type("/side asked from the app");
	await app.keyboard.press(`${mod}+Enter`);
	await until("the app's side thread", async () => (await inApp.locator("#thread").textContent())?.includes("(faux) asked from the app"));
	check((await inApp.locator("#side-title").textContent())?.startsWith("Your side thread") && !(await inApp.locator("#setup-banner").isHidden()), "the app shows its side thread");
	ok("in the app, /side opens the side thread in the thread that asked");

	// A server from before side threads ignores the request: the page says so instead of doing nothing.
	const old = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
	await old.routeWebSocket(/\/ws/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((m) => {
			if (!(typeof m === "string" && JSON.parse(m).type === "side")) server.send(m);
		});
	});
	await old.goto(`${url}/#token=${bob.token}`);
	await old.waitForFunction(() => document.querySelector("#me-avatar")?.textContent);
	await old.locator("#input").click();
	await old.keyboard.type("/side ignored by an old server");
	await old.keyboard.press(`${mod}+Enter`);
	await until("the notice", () => old.locator("#toast").textContent().then((t) => t?.includes("didn't open a side thread")), 15_000);
	check((await showing(old)) === "main", "the page stays in the thread");
	ok("a server that ignores /side gets a notice saying it may need syncpi update");

	check(errors.length === 0, `page errors: ${errors.join("; ")}`);
	console.log(`\nAll ${checks} side-thread checks passed.`);
} finally {
	await browser?.close();
	for (const p of processes) p.kill();
	// The clients start their session servers detached; theirs are the ones whose state is under this test's folder.
	spawnSync("pkill", ["-f", root]);
	rmSync(root, { recursive: true, force: true });
}
