// Find (⌘F) and the palette (⌘K) in a real browser: a thread in a browser, served by a session with the scripted
// model, and the app's shell with its threads and terminal (the desktop host). Part of `npm run test:search`.
// Needs `npm run build` first, and Chrome (or PLAYWRIGHT_CHROMIUM pointing at a Chromium).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type FrameLocator, type Page } from "playwright";

const dist = join(import.meta.dirname, "../dist");
const root = mkdtempSync(join(tmpdir(), "syncpi-search-test-"));
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

function project(name: string, files: Record<string, string>): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

/** A session with the scripted model, as `syncpi --headless --faux` runs it; its owner link. */
async function session(dir: string): Promise<string> {
	const home = join(root, "home-cli");
	const lines: string[] = [];
	const cli = spawn(process.execPath, [join(dist, "cli.mjs"), "--headless", "--faux", "--name", "Ada"], { cwd: dir, env: { ...process.env, SYNCPI_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
	processes.push(cli);
	let buf = "";
	cli.stdout!.on("data", (d) => {
		buf += d;
		const parts = buf.split("\n");
		buf = parts.pop()!;
		lines.push(...parts);
	});
	await until("the session to start", () => lines.some((l) => l.includes("connection open")), 60_000);
	const record = JSON.parse(readFileSync(join(home, "sessions", readdirSync(join(home, "sessions")).find((f) => /^\w+\.json$/.test(f))!), "utf8")) as { url: string; token: string };
	return `${record.url}/#token=${record.token}`;
}

type Scope = Page | FrameLocator;
const mod = process.platform === "darwin" ? "Meta" : "Control";

/** Sends a message and waits for the reply to finish. */
async function say(page: Page, text: string): Promise<void> {
	const before = await page.locator(".thread .msg-user").count();
	await page.locator("#input").fill(text);
	await page.keyboard.press(`${mod}+Enter`);
	await until(`a reply to "${text.slice(0, 30)}"`, () =>
		page.evaluate((n) => document.querySelectorAll(".thread .msg-user").length > n && !document.querySelector(".streaming, .tool-running, .tool-pending, .msg-user.pending"), before),
	);
	await page.waitForTimeout(200);
}

const count = (scope: Scope) => scope.locator("#find-count").textContent();
/** The text of every highlighted match, and of the current one. */
const painted = (page: Page) =>
	page.evaluate(() => {
		const all = CSS.highlights.get("syncpi-find");
		const current = CSS.highlights.get("syncpi-find-current");
		return { all: all ? [...all].map((r) => r.toString()) : [], current: current ? [...current].map((r) => r.toString()) : [] };
	});

/** Types a query and waits until it's counted and every match is highlighted as exactly that text. */
async function search(page: Page, query: string, total: number): Promise<void> {
	await page.locator("#find-input").fill(query);
	await until(`${total} × "${query}"`, async () => {
		const p = await painted(page);
		const texts = [...p.all, ...p.current];
		return (await count(page))?.endsWith(`/${total}`) && texts.length === total && texts.every((t) => t.toLowerCase() === query.toLowerCase());
	});
}

try {
	browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: "chrome" });

	// ---------- a thread in a browser ----------
	const dir = project("web", {
		"README.md": "# Notes\n\nThe cart total is computed in `src/cart.ts`.\n",
		"src/cart.ts": "export function cartTotal(items: number[]) {\n\treturn items.reduce((a, b) => a + b, 0); // cart total\n}\n",
		"src/server/room.ts": "export const room = 1;\n",
	});
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(await session(dir));
	await page.waitForFunction(() => document.querySelector("#me-avatar")?.textContent);

	await say(page, "Where is the **cart total** computed?");
	await say(page, "The cart total, again: src/foo.ts [Ada] .* and 🙂👩‍💻 Привет cart TOTAL");
	await say(page, "alpha omega");
	await say(page, "beta gamma");
	await say(page, `run printf 'line %s\\n' $(seq 1 30); echo needle-in-output`);
	await say(page, `run printf 'early-needle\\n'; printf 'filler %s\\n' $(seq 1 30)`);

	// ⌘F opens Find on the conversation, focused.
	await page.locator("#input").click();
	await page.keyboard.press(`${mod}+f`);
	await until("Find to open", () => page.locator("#find-bar").isVisible());
	check(await page.evaluate(() => document.activeElement?.id === "find-input"), "Find's input has focus");
	check((await page.locator("#find-scope").textContent()) === "Conversation", "the scope says Conversation");
	ok("⌘F opens Find on the conversation, with its input focused");

	// A phrase in several messages; Enter and ⇧Enter step and wrap.
	await page.keyboard.type("cart total");
	await search(page, "cart total", 6);
	const index = async () => Number((await count(page))!.split("/")[0]);
	const first = await index();
	const steps: number[] = [first];
	for (let n = 0; n < 6; n++) {
		await page.keyboard.press("Enter");
		steps.push(await index());
	}
	await page.keyboard.press("Shift+Enter");
	steps.push(await index());
	const expected = [...Array.from({ length: 7 }, (_, n) => ((first - 1 + n) % 6) + 1), ((first + 4) % 6) + 1];
	check(steps.join() === expected.join(), `Enter and ⇧Enter wrap: ${steps.join()} (expected ${expected.join()})`);
	ok(`"cart total" is found 6 times (the user's messages, the replies echoing them, across **bold**); Enter and ⇧Enter wrap: ${steps.join(" → ")} of 6`);

	// Across an emphasized span: one match, with the right range.
	const { all } = await painted(page);
	check(all.filter((t) => t.toLowerCase() === "cart total").length === 5 && all.every((t) => t.toLowerCase() === "cart total"), `highlights: ${JSON.stringify(all)}`);
	ok("a phrase across <strong> is one match, and every highlight covers exactly the matched text");

	// Across two messages: none.
	await page.locator("#find-input").fill("omega beta");
	await until("no matches", async () => (await count(page)) === "0/0");
	check((await page.locator("#find-note").textContent()) === "No matches", "says No matches");
	ok("a phrase across two messages doesn't match (0/0, No matches)");

	// Regular-expression characters are literal.
	for (const q of [".*", "[Ada]", "src/foo.ts"]) await search(page, q, 2);
	ok("`.*`, `[Ada]` and `src/foo.ts` match literally (in the message and its echo)");

	// Match case.
	await page.locator("#find-input").fill("cart TOTAL");
	await until("case-insensitive", async () => (await count(page))?.endsWith("/6"));
	await page.locator("#find-case").click();
	await until("case-sensitive", async () => (await count(page))?.endsWith("/2"));
	const cased = await painted(page);
	check([...cased.all, ...cased.current].length === 2 && [...cased.all, ...cased.current].every((t) => t === "cart TOTAL"), `cased highlights ${JSON.stringify(cased)}`);
	await page.locator("#find-case").click();
	ok("Match case narrows 6 matches to 2, and the highlights follow");

	// After emoji and Cyrillic, the highlighted characters are the right ones.
	await search(page, "привет cart", 2);
	const emoji = await painted(page);
	check([...emoji.all, ...emoji.current].every((t) => t === "Привет cart"), `emoji ${JSON.stringify(emoji)}`);
	ok("after emoji and Cyrillic, the highlight covers exactly «Привет cart»");

	// UI text isn't searched.
	await page.locator("#find-input").fill("Copy");
	await until("no Copy", async () => (await count(page)) === "0/0");
	await search(page, "Ada", 2);
	ok("the Copy buttons and author names aren't searched (\"Ada\" only where it's written)");

	// In a folded tool call, and above where a long output is cut: counted, and revealed by opening it. Each also
	// appears in the message asking for it and in the call's command line.
	const folds = () => page.evaluate(() => [...document.querySelectorAll<HTMLDetailsElement>(".thread details.tool")].map((d) => d.open));
	const inOutput = () => page.evaluate(() => {
		const range = [...(CSS.highlights.get("syncpi-find-current") ?? [])][0] as Range | undefined;
		return range?.startContainer.parentElement?.closest("pre.tool-output") ? range.toString() : undefined;
	});
	const toOutput = async () => {
		for (let n = 0; n < 3 && !(await inOutput()); n++) await page.keyboard.press("Enter");
		return inOutput();
	};
	const before = await folds();
	await page.locator("#find-input").fill("needle-in-output");
	await until("in a folded output", async () => {
		const p = await painted(page);
		return (await count(page))?.endsWith("/3") && [...p.all, ...p.current].length > 0 && [...p.all, ...p.current].every((t) => t === "needle-in-output");
	});
	const got = await toOutput();
	if (got !== "needle-in-output") console.log(await page.evaluate(() => JSON.stringify({ count: document.querySelector("#find-count")?.textContent, cur: [...(CSS.highlights.get("syncpi-find-current") ?? [])].map((r) => [(r as Range).toString(), (r as Range).startContainer.parentElement?.className]), all: [...(CSS.highlights.get("syncpi-find") ?? [])].map((r) => [(r as Range).toString(), (r as Range).startContainer.parentElement?.className]), pres: [...document.querySelectorAll("pre.tool-output")].map((p) => [p.textContent?.slice(-40), (p.closest("details") as HTMLDetailsElement).open]) })));
	check(got === "needle-in-output", "the match in the output is current and highlighted");
	check((await folds()).some((open, n) => open && !before[n]), "the fold holding the match opened");
	await page.locator("#find-input").fill("early-needle");
	await until("above the cut", async () => {
		const p = await painted(page);
		return (await count(page))?.endsWith("/3") && [...p.all, ...p.current].length > 0 && [...p.all, ...p.current].every((t) => t === "early-needle");
	});
	const early = await toOutput();
	if (early !== "early-needle") console.log(await page.evaluate(() => JSON.stringify({ count: document.querySelector("#find-count")?.textContent, cur: [...(CSS.highlights.get("syncpi-find-current") ?? [])].map((r) => [(r as Range).toString(), (r as Range).startContainer.parentElement?.className]), all: [...(CSS.highlights.get("syncpi-find") ?? [])].map((r) => [(r as Range).toString(), (r as Range).startContainer.parentElement?.className]), pres: [...document.querySelectorAll("pre.tool-output")].map((p) => [p.textContent?.slice(0, 40), (p.closest("details") as HTMLDetailsElement).open, !!p.previousElementSibling?.matches(".tool-more")]) })));
	check(early === "early-needle", "the cut-short output was shown in full");
	ok("matches in folded tool output count; going to one opens its fold, and shows all of an output cut short");

	// Esc closes, folds go back, focus returns to the composer.
	await page.keyboard.press("Escape");
	await until("Find closed", async () => !(await page.locator("#find-bar").isVisible()));
	check(JSON.stringify(await folds()) === JSON.stringify(before), "folds back as they were");
	check(await page.evaluate(() => document.activeElement?.id === "input"), "focus back in the composer");
	check((await painted(page)).all.length === 0, "highlights cleared");
	ok("Esc closes Find: the folds it opened close again, highlights go, and the composer has focus again");

	// The query is remembered; ⌘F again selects it; a selection in the thread seeds it.
	await page.keyboard.press(`${mod}+f`);
	check((await page.locator("#find-input").inputValue()) === "early-needle", "query remembered");
	check(await page.evaluate(() => { const i = document.activeElement as HTMLInputElement; return i.id === "find-input" && i.selectionStart === 0 && i.selectionEnd === i.value.length; }), "query selected");
	await page.keyboard.press("Escape");
	await page.evaluate(() => {
		const body = [...document.querySelectorAll(".thread .msg-user .msg-body")].find((b) => b.textContent?.includes("alpha omega"))!;
		const range = document.createRange();
		range.selectNodeContents(body.querySelector("p")!);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(range);
	});
	await page.keyboard.press(`${mod}+f`);
	check((await page.locator("#find-input").inputValue()) === "alpha omega", "selection seeds the query");
	await until("seeded matches", async () => (await count(page))?.endsWith("/2"));
	ok("⌘F keeps the last query (selected), or takes the selected text");

	// A theme change redraws the thread: highlights come back, once each.
	await page.evaluate(() => (window as Window & { syncpiRun?: (id: string) => boolean }).syncpiRun!("app.theme"));
	await until("rehighlighted", async () => {
		const p = await painted(page);
		return p.all.length + p.current.length === 2;
	});
	ok("after a theme change redraws the thread, the 2 matches are highlighted again (no duplicates)");

	// Streaming: counts update, the view stays on the match.
	await page.locator("#find-input").fill("streamed-word");
	await until("none yet", async () => (await count(page)) === "0/0");
	await search(page, "alpha omega", 2);
	await page.evaluate(() => {
		const input = document.querySelector<HTMLTextAreaElement>("#input")!;
		input.value = `alpha omega ${"streamed-word ".repeat(600)}`;
		input.dispatchEvent(new Event("input"));
	});
	await page.locator("#input").focus();
	await page.keyboard.press(`${mod}+Enter`);
	// Sending scrolls to what was sent; from then on, the reply streaming in mustn't move the view.
	await until("the reply streaming", () => page.evaluate(() => document.querySelector(".streaming") !== null));
	await page.locator("#find-input").focus();
	await page.keyboard.press("Enter");
	const top = await page.locator("#scroller").evaluate((s) => s.scrollTop);
	const on = (await painted(page)).current[0];
	await until("counts grow while it streams", async () => (await count(page))?.endsWith("/4"));
	check(Math.abs((await page.locator("#scroller").evaluate((s) => s.scrollTop)) - top) < 4, "the view stayed put");
	check((await painted(page)).current[0] === on, "the same match is current");
	ok("while a reply arrives, the count grows (2 → 4), the current match stays current and the thread doesn't scroll away");
	await until("reply done", () => page.evaluate(() => !document.querySelector(".streaming")));

	// Esc while the agent works closes Find, and doesn't stop the agent.
	await page.locator("#input").fill("run sleep 2; echo slept");
	await page.locator("#input").focus();
	await page.keyboard.press(`${mod}+Enter`);
	await until("working", () => page.evaluate(() => document.querySelector("#activity")?.getAttribute("data-busy") === "true"));
	await page.keyboard.press(`${mod}+f`);
	await page.keyboard.press("Escape");
	check(!(await page.locator("#find-bar").isVisible()), "Find closed");
	check(await page.evaluate(() => document.querySelector("#activity")?.getAttribute("data-busy") === "true"), "the agent is still working");
	check(await page.evaluate(() => document.activeElement?.id === "input"), "focus back in the composer");
	await until("slept", () => page.evaluate(() => document.querySelector(".thread")!.textContent!.includes("slept")));
	ok("Esc with Find open closes Find; the agent keeps working, and the composer has focus again");

	if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
	console.log(`\n${checks} checks passed`);
} catch (error) {
	console.error(`✗ ${(error as Error).stack ?? error}`);
	process.exitCode = 1;
} finally {
	await browser?.close();
	for (const p of processes) p.kill();
	rmSync(root, { recursive: true, force: true });
}
