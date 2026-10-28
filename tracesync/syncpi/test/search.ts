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
	}).catch(async (error: Error) => {
		throw new Error(`${error.message}; count ${await count(page)}, highlights ${JSON.stringify(await painted(page))}`);
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

	// ---------- files in the panel ----------
	const openFile = async (path: string) => {
		await page.locator("#input").focus();
		await page.keyboard.press(`${mod}+p`);
		await page.keyboard.type(path);
		await until(`${path} listed`, () => page.evaluate((p) => document.querySelector("#palette-list [aria-selected='true'] .palette-title")?.textContent === p.split("/").pop(), path));
		await page.keyboard.press("Enter");
		await until(`${path} open`, () => page.evaluate(() => !!document.querySelector("#panel-file .artifact .artifact-body")?.textContent || !!document.querySelector("#panel-file diffs-container")));
		await page.waitForTimeout(400);
	};
	const findInPanel = async () => {
		await page.locator("#panel-file .artifact-head").click();
		await page.keyboard.press(`${mod}+f`);
		await until("Find on the file", () => page.evaluate(() => document.querySelector("#find-bar")?.nextElementSibling?.id === "panel-file"));
	};
	await openFile("src/cart.ts");
	await findInPanel();
	check((await page.locator("#find-scope").textContent()) === "src/cart.ts", "the scope is the file");
	check((await page.locator("#find-input").getAttribute("aria-label")) === "Find in file", "labelled Find in file");
	await search(page, "cart total", 1);
	const inShadow = await page.evaluate(() => [...(CSS.highlights.get("syncpi-find-current") ?? [])][0]?.startContainer.getRootNode() instanceof ShadowRoot);
	check(inShadow, "the highlight is in the code view's shadow root");
	await page.locator("#find-input").fill("3");
	await until("not the gutter", async () => (await count(page)) === "0/0");
	await search(page, "items", 2);
	ok("in a code file, Find searches the code (highlighted in the code view), not its line numbers");

	// Focus decides: back in the composer, ⌘F is the conversation's.
	await page.locator("#input").focus();
	await page.keyboard.press(`${mod}+f`);
	await until("conversation again", async () => (await page.locator("#find-scope").textContent()) === "Conversation");
	check((await page.locator("#find-input").inputValue()) === "alpha omega", "the conversation's own query came back");
	await page.keyboard.press("Escape");
	ok("⌘F from the composer is the conversation's Find again, with its own remembered query");

	// Markdown: the rendered text in Preview, the source in Code.
	await openFile("README.md");
	await findInPanel();
	await page.locator("#find-input").fill("`src/cart.ts`");
	await until("no backticks in the rendered view", async () => (await count(page)) === "0/0");
	await search(page, "src/cart.ts", 1);
	await page.locator("#panel-file .artifact-tabs [data-view='code']").click();
	await until("the source view", () => page.evaluate(() => document.querySelector("#find-scope")?.textContent === "README.md" && !document.querySelector("#panel-file .markdown-preview")));
	await page.locator("#find-input").focus();
	await search(page, "`src/cart.ts`", 1);
	ok("Markdown: the preview is searched as rendered (no backticks), the source as written");
	await page.keyboard.press("Escape");

	// Text being edited: what's in the editor, unsaved; Find changes nothing.
	await openFile("src/cart.ts");
	await page.locator("#panel-file [data-edit]").click();
	const area = page.locator("#panel-file textarea.file-editor");
	await area.waitFor();
	await until("the file's text in the editor", async () => (await area.inputValue()).includes("cartTotal"));
	await area.press(`${mod}+End`);
	await area.pressSequentially("// typed-but-unsaved");
	const typed = await area.inputValue();
	await page.keyboard.press(`${mod}+f`);
	await until("Find on the editor", async () => (await page.locator("#find-scope").textContent())?.includes("editing"));
	await page.locator("#find-input").fill("typed-but-unsaved");
	await until("found in the editor", async () => (await count(page)) === "1/1");
	await page.keyboard.press("Enter");
	check(await area.evaluate((a: HTMLTextAreaElement) => a.value.slice(a.selectionStart, a.selectionEnd)) === "typed-but-unsaved", "the match is selected in the editor");
	const after = await area.inputValue();
	check(after === typed, `the text is unchanged: ${JSON.stringify(typed)} → ${JSON.stringify(after)}`);
	check(await page.locator(".find-layer .find-box.current").count() === 1, "a box marks it");
	await page.keyboard.press("Escape");
	await page.locator("#panel-file .file-editor-bar .button").click();
	ok("while a file is edited, Find searches the editor's text, selects the match in it and changes nothing");

	// An older version: only what's shown.
	await say(page, "edit src/cart.ts // cart total => // cart sum");
	await openFile("src/cart.ts");
	await page.locator("#panel-file .version-select").selectOption("before");
	const shown = () => page.evaluate(() => document.querySelector("#panel-file diffs-container")?.shadowRoot?.querySelector("[data-content]")?.textContent ?? "");
	await until("the older version", async () => (await shown()).includes("cart total"));
	await findInPanel();
	check((await page.locator("#find-scope").textContent())?.includes("before the last turn"), "says which version");
	await search(page, "cart total", 1);
	await page.locator("#panel-file .version-select").selectOption("latest");
	await until("the current version", async () => (await shown()).includes("cart sum"));
	await until("Find follows the version", async () => !(await page.locator("#find-scope").textContent())?.includes("before") && (await count(page)) === "0/0");
	ok("an older version is searched as shown; switching to the current one searches that instead (0 matches there)");
	await page.keyboard.press("Escape");

	// A diff: the old and new lines, without the gutters.
	await page.locator("#panel-tabs [data-tab='changes']").click();
	if ((await page.locator("#panel-browse").getAttribute("aria-expanded")) === "false") await page.locator("#panel-browse").click();
	await page.locator("#panel-list .panel-group").filter({ hasText: "src/cart.ts" }).locator("[data-artifact]").last().click();
	await until("the diff", () => page.evaluate(() => !!document.querySelector("#panel-view diffs-container")?.shadowRoot?.querySelector("[data-line]")));
	await page.locator("#panel-view .artifact-head").click();
	await page.keyboard.press(`${mod}+f`);
	await search(page, "cart total", 1);
	await search(page, "cart sum", 1);
	ok("in a diff, the removed and added lines are both searched");
	await page.keyboard.press("Escape");

	// A preview can't be searched, and says so.
	await say(page, "write page.html <h1>Preview only</h1>");
	await openFile("page.html");
	await findInPanel();
	await until("unavailable", async () => (await page.locator("#find-note").textContent()) === "Find isn't available for this view.");
	ok("an HTML preview says Find isn't available for it");
	await page.keyboard.press("Escape");

	// ---------- the palette, in a browser ----------
	await page.locator("#input").fill("hello world");
	await page.locator("#input").evaluate((i: HTMLTextAreaElement) => i.setSelectionRange(0, 5));
	await page.keyboard.press(`${mod}+k`);
	await until("the palette", () => page.locator("#palette").isVisible());
	const tabs = await page.locator("#palette-tabs [data-tab]").allTextContents();
	check(await page.evaluate(() => document.activeElement?.id === "palette-input"), "the palette's input has focus");
	check((await page.locator("#palette-input").getAttribute("aria-expanded")) === "true", "the combobox says it's expanded");
	check(!tabs.some((t) => t.startsWith("Threads")), `no Threads tab in a browser: ${tabs.join(", ")}`);
	check((await page.locator("#palette-heading").textContent()) === "Search commands and files", "titled for what it searches here");
	const active = await page.locator("#palette-input").getAttribute("aria-activedescendant");
	check(active !== null && (await page.locator(`#${active}`).getAttribute("aria-selected")) === "true", "the active option is the selected row");
	ok("⌘K opens the palette on All with its input focused, as a combobox; in a browser there's no Threads tab");

	await page.keyboard.press("Escape");
	await until("closed", async () => !(await page.locator("#palette").isVisible()));
	check(await page.evaluate(() => { const i = document.activeElement as HTMLTextAreaElement; return i.id === "input" && i.selectionStart === 0 && i.selectionEnd === 5; }), "the composer's selection is back");
	ok("Esc closes the palette and puts focus and the selection back where they were");

	await page.keyboard.press(`${mod}+p`);
	await page.keyboard.type("server");
	await until("room.ts by its folder", () => page.evaluate(() => [...document.querySelectorAll("#palette-list .palette-row")].some((r) => r.querySelector(".palette-title")?.textContent === "room.ts" && r.querySelector(".palette-detail mark")?.textContent === "server")));
	check(await page.evaluate(() => !document.querySelector("#palette-list .palette-row .palette-title mark")?.closest(".palette-row")?.textContent?.includes("room.ts")), "the name isn't marked");
	ok("a file matched only by its folder shows the folder marked, not the name");

	await page.locator("#palette-input").fill("<img src=x onerror=alert(1)>");
	await until("create row", () => page.evaluate(() => document.querySelector("#palette-list")?.textContent?.includes("Create <img src=x onerror=alert(1)>")));
	check((await page.locator("#palette-list img").count()) === 0, "no markup from the query");
	ok("a query with HTML in it shows as text");

	await page.keyboard.press(`${mod}+2`); // Commands (no Threads tab here)
	await page.locator("#palette-input").fill("zzqxjv");
	await until("nothing matches", async () => (await page.locator("#palette-list").textContent()) === "Nothing matches.");
	await page.keyboard.press("Enter");
	check(await page.locator("#palette").isVisible(), "Enter with no results did nothing");
	await page.keyboard.press("Escape");
	ok("with no results, Enter does nothing");

	if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);

	// ---------- the app: its shell, threads and terminal (the desktop host) ----------
	const appProject = project("app", { "README.md": "# App\n\nshell needle\n" });
	const host = spawn(process.execPath, [join(dist, "desktop-host.mjs"), "--faux"], { env: { ...process.env, SYNCPI_HOME: join(root, "home-app"), PI_CODING_AGENT_DIR: join(root, "empty-pi") }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(host);
	let hostOut = "";
	host.stdout!.on("data", (d) => (hostOut += d));
	const launch = await until("the app's host", () => hostOut.match(/SYNCPI_APP (\S+)/)?.[1], 30_000);
	const app = await (await browser.newContext({ viewport: { width: 1380, height: 880 } })).newPage();
	app.on("pageerror", (e) => errors.push(e.message));
	await app.goto(launch);
	await app.evaluate((dir) => (window.prompt = () => dir), appProject);
	await app.getByRole("button", { name: "Open a project" }).click();
	await app.getByRole("button", { name: "Start thread" }).click();
	const thread = app.frameLocator("iframe.session-frame:not([hidden])");
	await thread.locator("#input").waitFor({ timeout: 60_000 });
	await thread.locator("#input").fill("the shell needle is here");
	await thread.locator("#input").press(`${mod}+Enter`);
	await until("the reply", async () => (await thread.locator(".thread").textContent())?.includes("(faux) the shell needle"));

	// In a thread, ⌘K has a Threads tab.
	await thread.locator("#input").press(`${mod}+k`);
	await until("the thread's palette", () => thread.locator("#palette").isVisible());
	check((await thread.locator("#palette-tabs [data-tab='threads']").count()) === 1, "Threads tab in the app");
	check((await thread.locator("#palette-heading").textContent()) === "Search commands, threads and files", "titled with threads");
	await thread.locator("#palette-input").press("Escape");
	ok("in the app, the palette has a Threads tab and says it searches threads");

	// From the sidebar, ⌘F opens Find in the open thread's conversation.
	await app.locator("#sidebar").click({ position: { x: 20, y: 300 } });
	await app.keyboard.press(`${mod}+f`);
	await until("Find in the thread", () => thread.locator("#find-bar").isVisible());
	check((await thread.locator("#find-scope").textContent()) === "Conversation", "the conversation");
	await thread.locator("#find-input").fill("shell needle");
	await until("found from the sidebar", async () => (await count(thread))?.endsWith("/2"));
	ok("⌘F with the sidebar focused opens Find in the open thread's conversation (shell → page, once)");

	// Another thread showing: the hidden one's Find is closed.
	const firstThread = await app.locator("iframe.session-frame:not([hidden])").getAttribute("src");
	await app.evaluate(() => (window as Window & { syncpiCommand?: (id: string) => void }).syncpiCommand!("thread.new"));
	await until("a second thread", async () => (await app.locator("iframe.session-frame:not([hidden])").getAttribute("src")) !== firstThread, 60_000);
	const away = await app.evaluate((src) => {
		const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe.session-frame")].find((f) => f.getAttribute("src") === src);
		const doc = frame?.contentDocument;
		return { found: !!frame, hidden: frame?.hidden, bar: doc ? !doc.querySelector<HTMLElement>("#find-bar")!.hidden : undefined, focus: doc?.hasFocus() };
	}, firstThread!);
	check(away.found && away.hidden && away.bar === false && away.focus === false, `the hidden thread: ${JSON.stringify(away)}`);
	ok("switching threads closes Find in the one put away; it keeps no bar or focus");
	await app.evaluate(() => (window as Window & { syncpiCommand?: (id: string) => void }).syncpiCommand!("thread.previous"));
	await until("back", async () => (await app.locator("iframe.session-frame:not([hidden])").getAttribute("src")) === firstThread);

	// A terminal keeps ⌘K and ⌘F; ⇧⌘P still opens the commands.
	await app.evaluate(() => (window as Window & { syncpiCommand?: (id: string) => void }).syncpiCommand!("view.terminal"));
	await thread.locator(".terminal .xterm").first().waitFor({ timeout: 20_000 });
	await thread.locator(".terminal .xterm").first().click();
	await until("terminal focus", () => thread.locator("#terminal").evaluate((t) => t.contains(t.ownerDocument.activeElement)));
	const prevented = (key: string) =>
		thread.locator("#terminal").evaluate((t, key) => {
			const target = t.ownerDocument.activeElement!;
			const event = new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, metaKey: navigator.platform.includes("Mac"), ctrlKey: !navigator.platform.includes("Mac"), bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		}, key);
	check(!(await prevented("k")), "⌘K isn't taken from the terminal");
	check(!(await thread.locator("#palette").isVisible()), "no palette");
	check(!(await prevented("f")), "⌘F isn't taken from the terminal");
	check(!(await thread.locator("#find-bar").isVisible()), "no Find");
	await app.keyboard.press(`${mod}+Shift+p`);
	await until("commands from the terminal", () => thread.locator("#palette").isVisible());
	check((await thread.locator("#palette-tabs [aria-selected='true']").textContent())?.startsWith("Commands"), "on Commands");
	await thread.locator("#palette-input").press("Escape");
	ok("in a terminal, ⌘K and ⌘F are the terminal's; ⇧⌘P still opens the commands");

	// The app's menu (no key event): ⌘K in a terminal does what the terminal would; Find follows the last pane.
	await thread.locator(".terminal .xterm").first().click();
	check(await app.evaluate(() => { (window as Window & { syncpiCommand?: (id: string) => void }).syncpiCommand!("palette.all"); return true; }), "menu ran");
	check(!(await thread.locator("#palette").isVisible()) && !(await app.locator("#palette").isVisible()), "the menu's ⌘K in a terminal opens no palette");
	ok("⌘K from the app's menu while a terminal has focus goes to the terminal, not to a palette");

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
