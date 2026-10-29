// Comments on part of a graphic (annotate.ts) in a real browser: Ada owns a session with the scripted model, and Bob
// is an editor in another browser. A reply with an SVG image, an HTML page and a Mermaid diagram (the scripted model
// repeats what it's sent), and an image file opened in the panel: marks made by clicking and dragging, seen by the
// other person as they're made and written, sent together as one message with the graphic marked with them.
// `npm run test:annotate` (needs Chrome, or PLAYWRIGHT_CHROMIUM).
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";

const dist = join(import.meta.dirname, "../dist");
const root = mkdtempSync(join(tmpdir(), "syncpi-annotate-test-"));
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

const mod = process.platform === "darwin" ? "Meta" : "Control";
const dir = join(root, "shapes");
mkdirSync(dir, { recursive: true });

const REPLY = [
	"look at these",
	"```svg",
	'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#dd3333"/><circle cx="150" cy="100" r="60" fill="#3333dd"/></svg>',
	"```",
	"```html",
	'<!doctype html><html><body style="margin:0;background:#33aa33"><h1 style="margin:0;padding:20px;color:#fff;font:40px sans-serif">Hello</h1></body></html>',
	"```",
	"```mermaid",
	"graph LR",
	"  A[Start] --> B[Middle] --> C[End]",
	"```",
].join("\n");

/** A person's color, as dom.ts personColor gives it, in RGB. */
function personRgb(name: string): [number, number, number] {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const hue = h % 360;
	const s = 0.42;
	const l = 0.48;
	const k = (n: number) => (n + hue / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}
/** ANNOTATE_SHOTS=<dir> saves screenshots at a few moments, to look at. */
const shot = async (page: Page, name: string) => {
	if (process.env.ANNOTATE_SHOTS) await page.screenshot({ path: join(process.env.ANNOTATE_SHOTS, `${name}.png`) });
};
const near = (a: number[], b: number[], d = 40) => a.every((v, i) => Math.abs(v - b[i]!) <= d);

try {
	browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: "chrome" });
	// A project image: 300×200, orange.
	const maker = await browser.newPage();
	await maker.setContent('<div id="c" style="width:300px;height:200px;background:#ee8800"></div>');
	writeFileSync(join(dir, "logo.png"), await maker.locator("#c").screenshot());
	await maker.close();
	execFileSync("git", ["init", "-q"], { cwd: dir });

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
	await until("the session to start", () => lines.some((l) => l.includes("connection open")), 60_000);
	const record = JSON.parse(readFileSync(join(home, "sessions", readdirSync(join(home, "sessions")).find((f) => /^\w+\.json$/.test(f))!), "utf8")) as { url: string; token: string };
	cli.stdin!.write("/session-share\n");
	const share = await until("a share link", () => lines.find((l) => l.startsWith("share "))?.split(" ")[1]);
	const bob = (await (await fetch(`${record.url}/api/join`, { method: "POST", body: JSON.stringify({ invite: share.match(/\/s\/([\w-]+)/)![1], name: "Bob" }) })).json()) as { token: string };

	const errors: string[] = [];
	const bobFrames: string[] = [];
	const open = async (token: string, frames?: string[]) => {
		const page = await (await browser!.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
		page.on("pageerror", (e) => errors.push(e.message));
		if (frames) page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(typeof f.payload === "string" ? f.payload : f.payload.toString("utf8"))));
		await page.goto(`${record.url}/#token=${token}`);
		await page.waitForFunction(() => document.querySelector("#me-avatar")?.textContent);
		return page;
	};
	const A = await open(record.token);
	const B = await open(bob.token, bobFrames);

	// The reply with three graphics.
	await A.locator("#input").fill(REPLY);
	await A.locator("#input").press(`${mod}+Enter`);
	for (const page of [A, B]) {
		await until("the SVG card", () => page.locator(".thread .artifact-svg .graphic-frame").count());
		await until("the HTML card", () => page.locator(".thread .artifact-html .graphic-frame").count());
		await until("the diagram", () => page.locator(".thread .viewer .diagram-surface").count());
	}

	/** The agent has finished (answering the comments just sent): the thread no longer scrolls to follow it. */
	const idle = (page: Page) => until("the agent to finish", () => page.evaluate(() => document.querySelector("#activity")?.getAttribute("data-busy") === "false"), 30_000);
	/** Clicks (or drags to `to`) on a graphic at fractions of its surface, in comment mode. */
	async function mark(page: Page, frame: Locator, surface: Locator, at: [number, number], text: string, options: { to?: [number, number]; enter?: string } = {}) {
		await idle(page);
		// All of it on screen, so a drag stays inside the window.
		await frame.evaluate((n) => n.scrollIntoView({ block: "center" }));
		await frame.hover();
		const toggle = frame.locator(":scope > .mark-toggle");
		if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
		const box = (await surface.boundingBox())!;
		await page.mouse.move(box.x + box.width * at[0], box.y + box.height * at[1]);
		await page.mouse.down();
		if (options.to) await page.mouse.move(box.x + box.width * options.to[0], box.y + box.height * options.to[1], { steps: 6 });
		await page.mouse.up();
		await until("the comment box", () => page.locator(".mark-editor textarea").isVisible());
		await page.keyboard.type(text);
		if (options.enter !== "") await page.keyboard.press(options.enter ?? "Enter");
	}
	const svgFrame = (page: Page) => page.locator(".thread .artifact-svg .graphic-frame").first();
	const marksOn = (frame: Locator) => frame.locator(".mark");
	const titles = (frame: Locator) => marksOn(frame).evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).title));

	// 1. Ada marks a point on the SVG: Bob sees it, numbered, with her comment, and a bar to send it.
	await mark(A, svgFrame(A), svgFrame(A), [0.4, 0.3], "make the circle green");
	await until("Bob to see Ada's comment", async () => (await titles(svgFrame(B))).includes("Ada: make the circle green"));
	check((await svgFrame(B).locator(".mark-pin").first().textContent()) === "1", "numbered 1");
	const bar = (page: Page) => page.locator(".thread .artifact-svg .marks-bar");
	check((await bar(B).textContent())?.includes("1 comment, not sent yet"), `Bob sees it waiting (${await bar(B).textContent()})`);
	ok("Ada marks a point on an SVG image: Bob sees it at once, numbered, with her comment, waiting to be sent");

	// 2. Ada drags an area and writes slowly: Bob sees the area, then her comment as she writes it.
	await mark(A, svgFrame(A), svgFrame(A), [0.1, 0.1], "", { to: [0.5, 0.4], enter: "" });
	await until("Bob to see Ada writing", async () => (await titles(svgFrame(B))).includes("Ada is writing a comment"));
	check((await bar(B).textContent())?.includes("Ada is writing a comment"), "the bar says she's writing");
	await A.keyboard.type("this red is wrong", { delay: 40 });
	await until("Bob to see the comment as it's written", async () => (await titles(svgFrame(B))).includes("Ada: this red is wrong"));
	await shot(A, "ada-writing");
	await shot(B, "bob-sees-ada-writing");
	check(await A.locator(".mark-editor textarea").isVisible(), "while Ada's box is still open");
	await A.keyboard.press("Enter");
	const area = svgFrame(B).locator(".mark.area");
	check((await area.count()) === 1, "Bob sees it as an area");
	const areaBox = (await area.boundingBox())!;
	const svgBox = (await svgFrame(B).boundingBox())!;
	check(Math.abs(areaBox.width / svgBox.width - 0.4) < 0.03 && Math.abs(areaBox.height / svgBox.height - 0.3) < 0.03, `the same area on Bob's screen (${(areaBox.width / svgBox.width).toFixed(3)}, ${(areaBox.height / svgBox.height).toFixed(3)})`);
	ok("Ada drags an area: Bob sees the area, and her comment as she writes it");

	// 3. Bob adds his own; Ada sees all three; Bob sends them together, with a picture.
	await mark(B, svgFrame(B), svgFrame(B), [0.75, 0.75], "agree");
	await until("Ada to see Bob's comment", async () => (await titles(svgFrame(A))).includes("Bob: agree"));
	check((await bar(A).textContent())?.includes("3 comments"), "three comments wait");
	await svgFrame(A).hover();
	await shot(A, "ada-three-waiting");
	await bar(B).getByRole("button", { name: "Send 3 comments" }).click();
	const sent = (page: Page, title: string) =>
		page.evaluate((t) => {
			const msg = [...document.querySelectorAll(".thread .msg")].find((m) => m.textContent?.includes(`Comments on ${t}`));
			return msg
				? {
						text: msg.textContent ?? "",
						items: [...msg.querySelectorAll("ol li")].map((li) => li.textContent?.trim() ?? ""),
						author: msg.querySelector(".msg-author, .author, .msg-name")?.textContent?.trim(),
						image: (msg.querySelector(".attached img") as HTMLImageElement | null)?.src,
					}
				: undefined;
		}, title);
	const svgMessage = await until("the message", () => sent(A, "the SVG image in a reply"));
	// (The message shows as Markdown: its numbered lines are a numbered list.)
	check(svgMessage.text.includes("numbered on the attached picture"), `with a picture (${svgMessage.text})`);
	check(svgMessage.items[0] === "Ada, at 40% across, 30% down: make the circle green", `the first comment (${svgMessage.items})`);
	check(svgMessage.items[1] === "Ada, on the area 10%–50% across, 10%–40% down: this red is wrong", "the area");
	check(svgMessage.items[2] === "Bob, at 75% across, 75% down: agree", "Bob's");
	check(svgMessage.author === "Bob", `sent by Bob (${svgMessage.author})`);
	await until("the marks to go for Ada", async () => (await marksOn(svgFrame(A)).count()) === 0);
	await until("and for Bob", async () => (await marksOn(svgFrame(B)).count()) === 0 && (await bar(B).count()) === 0);
	ok("Bob adds his own comment, and sends all three as one message; they leave the graphic for everyone");

	/**
	 * Pixels of a sent picture, at fractions of it, and its size. A point with `pin` is a comment's number: sampled
	 * beside the digit, inside the pin (annotate.ts drawMarks: radius 11 units of a 700th of the longer side).
	 */
	const pixels = (page: Page, src: string, points: ([number, number] | [number, number, "pin"])[]) =>
		page.evaluate(
			async ({ src, points }) => {
				const image = new Image();
				image.src = src;
				await image.decode();
				const canvas = document.createElement("canvas");
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const ctx = canvas.getContext("2d")!;
				ctx.drawImage(image, 0, 0);
				const unit = Math.max(1, Math.max(image.naturalWidth, image.naturalHeight) / 700);
				return {
					width: image.naturalWidth,
					height: image.naturalHeight,
					at: points.map(([x, y, pin]) => [...ctx.getImageData(Math.floor(x * image.naturalWidth + (pin ? 7 * unit : 0)), Math.floor(y * image.naturalHeight), 1, 1).data.slice(0, 3)]),
				};
			},
			{ src, points },
		);
	check(svgMessage.image?.startsWith("data:image/png"), "with a picture");
	await A.locator(".thread .msg .attached img").last().scrollIntoViewIfNeeded();
	await shot(A, "sent");
	const svgPicture = await pixels(A, svgMessage.image!, [[0.5, 0.5], [0.4, 0.3, "pin"], [0.75, 0.75, "pin"]]);
	check(near(svgPicture.at[0]!, [0x33, 0x33, 0xdd]), `the picture shows the SVG (its circle at the middle: ${svgPicture.at[0]})`);
	check(near(svgPicture.at[1]!, personRgb("Ada")), `Ada's numbered pin where she clicked (${svgPicture.at[1]} vs ${personRgb("Ada")})`);
	check(near(svgPicture.at[2]!, personRgb("Bob")), `Bob's where he clicked (${svgPicture.at[2]})`);
	ok(`the picture is the SVG as shown (${svgPicture.width}×${svgPicture.height}), with each comment's number where it was made, in its author's color`);

	// 4. The diagram: a mark stays on the drawing as it's zoomed, and ⌘↩ in the box sends.
	const diagram = (page: Page) => page.locator(".thread .viewer").first();
	const stage = (page: Page) => diagram(page).locator(".viewer-stage");
	const drawing = (page: Page) => diagram(page).locator(".diagram-surface");
	await mark(A, stage(A), drawing(A), [0.3, 0.2], "", { to: [0.6, 0.8], enter: "" });
	await A.keyboard.type("rename Middle");
	const place = async (page: Page) => {
		const m = (await diagram(page).locator(".mark").boundingBox())!;
		const d = (await drawing(page).boundingBox())!;
		return [(m.x - d.x) / d.width, (m.y - d.y) / d.height, m.width / d.width];
	};
	await until("Bob to see the diagram's mark", () => diagram(B).locator(".mark").count());
	const before = await place(B);
	await diagram(B).getByRole("button", { name: "Zoom in" }).click();
	await B.waitForTimeout(300);
	const after = await place(B);
	check(after.every((v, i) => Math.abs(v - before[i]!) < 0.01), `the mark stays on the same part of the drawing when zoomed (${before} → ${after})`);
	await A.keyboard.press(`${mod}+Enter`);
	const diagramMessage = await until("the diagram's message", () => sent(B, "the diagram in a reply"));
	check(diagramMessage.items[0] === "Ada, on the area 30%–60% across, 20%–80% down: rename Middle" && diagramMessage.image?.startsWith("data:image/png"), `the diagram's comment, with a picture (${diagramMessage.text})`);
	const diagramPicture = await pixels(B, diagramMessage.image!, [[0.3, 0.2, "pin"]]);
	check(near(diagramPicture.at[0]!, personRgb("Ada")), `the picture is the diagram, marked (${diagramPicture.width}×${diagramPicture.height}, ${diagramPicture.at[0]})`);
	ok("a diagram's mark stays on the drawing as it's zoomed, and ⌘↩ in the box sends it, with the diagram marked");

	// 5. The HTML preview: drawn inside its sandboxed frame, and sent.
	const htmlFrame = (page: Page) => page.locator(".thread .artifact-html .graphic-frame").first();
	await mark(A, htmlFrame(A), htmlFrame(A), [0.2, 0.1], "bigger title");
	await A.locator(".thread .artifact-html .marks-bar").getByRole("button", { name: "Send" }).click();
	const htmlMessage = await until("the HTML message", () => sent(B, "the HTML in a reply"));
	check(htmlMessage.image?.startsWith("data:image/png"), `with a picture (${htmlMessage.text})`);
	const htmlPicture = await pixels(B, htmlMessage.image!, [[0.9, 0.9], [0.2, 0.1, "pin"]]);
	check(near(htmlPicture.at[0]!, [0x33, 0xaa, 0x33]), `the picture is the page as it runs in the frame (green: ${htmlPicture.at[0]})`);
	check(near(htmlPicture.at[1]!, personRgb("Ada")), "marked where Ada clicked");
	ok(`an HTML preview is drawn inside its sandboxed frame (${htmlPicture.width}×${htmlPicture.height}), marked and sent`);

	// 6. An image file in the panel.
	await A.locator("#input").focus();
	await A.keyboard.press(`${mod}+p`);
	await A.keyboard.type("logo.png");
	await until("logo.png listed", () => A.evaluate(() => document.querySelector("#palette-list [aria-selected='true'] .palette-title")?.textContent === "logo.png"));
	await A.keyboard.press("Enter");
	const imageFrame = A.locator("#panel-file .graphic-image");
	await until("the image", () => imageFrame.locator("img").evaluate((i) => (i as HTMLImageElement).naturalWidth > 0).catch(() => false));
	await mark(A, imageFrame, imageFrame, [0.5, 0.5], "use the brand orange", { enter: `${mod}+Enter` });
	const imageMessage = await until("the image's message", () => sent(B, "the image logo.png"));
	const imagePicture = await pixels(B, imageMessage.image!, [[0.1, 0.1], [0.5, 0.5, "pin"]]);
	check(imagePicture.width === 300 * 2 || imagePicture.width === 300, `at the image's own resolution (${imagePicture.width}×${imagePicture.height})`);
	check(near(imagePicture.at[0]!, [0xee, 0x88, 0x00]) && near(imagePicture.at[1]!, personRgb("Ada")), "the image, marked");
	ok("an image file in the panel: the picture is the image at its own resolution, marked");

	// 7. In a side thread, marks are Ada's alone.
	const before7 = bobFrames.length;
	await A.locator("#input").fill("/side a private look");
	await A.locator("#input").press(`${mod}+Enter`);
	await until("the side thread", () => A.evaluate(() => !(document.querySelector("#setup-banner") as HTMLElement).hidden));
	await until("its answer", () => A.evaluate(() => document.querySelector("#thread")?.textContent?.includes("(faux) a private look")));
	await A.locator("#input").fill(REPLY.split("\n").slice(0, 4).join("\n"));
	await A.locator("#input").press(`${mod}+Enter`);
	await until("the side thread's SVG", () => A.locator(".thread .artifact-svg .graphic-frame").count());
	// The reply is drawn again once it's finished: wait for its card to stay put.
	await until("the side reply to settle", async () => {
		const card = await A.locator(".thread .artifact-svg .graphic-frame").first().elementHandle();
		await A.waitForTimeout(800);
		return card?.evaluate((n) => n.isConnected);
	});
	await mark(A, svgFrame(A), svgFrame(A), [0.5, 0.5], "private thought");
	await until("Ada's private mark", async () => (await titles(svgFrame(A))).includes("Ada: private thought"));
	await A.waitForTimeout(500);
	check(!bobFrames.slice(before7).some((f) => f.includes("private thought") || f.includes('"key":"side:')), "none of it reached Bob");
	check((await marksOn(svgFrame(B)).count()) === 0, "Bob's SVG has no marks");
	ok("in Ada's side thread, her marks reach only her");

	check(errors.length === 0, `page errors: ${errors.join("; ")}`);
	console.log(`\nAll ${checks} graphic comment checks passed.`);
} finally {
	await browser?.close();
	for (const p of processes) p.kill();
	spawnSync("pkill", ["-f", root]);
	rmSync(root, { recursive: true, force: true });
}
