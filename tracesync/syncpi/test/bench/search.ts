// `npm run bench:search`: how long Find and the palette take, from a typed query to the painted results, against
// the spec's release targets (docs/search-spec.md): p95 under 100 ms for a 2 MB, 2,000-block conversation, and under
// 50 ms for 10,000 file paths and 1,000 thread titles. Runs in Chrome; prints the machine and the timings.
import { cpus } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright";

const root = join(import.meta.dirname, "../..");
const out = mkdtempSync(join(tmpdir(), "syncpi-search-bench-"));
await build({ entryPoints: [join(import.meta.dirname, "search-page.ts")], bundle: true, format: "esm", outfile: join(out, "page.js"), logLevel: "warning", loader: { ".svg": "text" } });
copyFileSync(join(root, "src/web/style.css"), join(out, "style.css"));
// The real markup of the Find bar and the palette, from the page.
const index = readFileSync(join(root, "src/web/index.html"), "utf8");
const bar = index.match(/<div id="find-bar"[\s\S]*?\n {6}<\/div>/)![0];
const palette = index.match(/<dialog id="palette"[\s\S]*?<\/dialog>/)![0];
writeFileSync(
	join(out, "index.html"),
	`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body style="height:100vh;margin:0"><div id="app" style="height:100%"><div class="layout"><main class="center">${bar}<div id="scroller" class="scroller"><div id="thread" class="thread"></div></div></main></div></div>${palette}<input id="input" hidden><script type="module" src="page.js"></script></body>`,
);
// Module scripts don't load from file://; a local server serves the page.
const types: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };
const server = createServer((req, res) => {
	const name = (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "").slice(1).split("?")[0]!;
	let body: Buffer;
	try {
		body = readFileSync(join(out, name.replace(/\.\.+/g, "")));
	} catch {
		return void res.writeHead(404).end();
	}
	res.writeHead(200, { "content-type": types[name.split(".").pop()!] ?? "application/octet-stream" }).end(body);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)]!;
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: "chrome" });
try {
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
	page.on("pageerror", (e) => console.error("page error:", e.message));
	await page.goto(url);
	await page.waitForFunction(() => document.title === "ready");
	type Bench = { bytes: number; blocks(): number; openFind(): boolean; find(q: string): Promise<{ ms: number; count: string }>; openPalette(tab: string): void; palette(q: string): Promise<{ ms: number; rows: number }>; highlights(): boolean };
	const info = await page.evaluate(() => {
		const b = (window as unknown as { bench: Bench }).bench;
		return { bytes: b.bytes, highlights: b.highlights() };
	});
	console.log(`Machine: ${cpus()[0]!.model}, ${cpus().length} cores; ${await browser.version()}`);
	console.log(`Conversation: ${(info.bytes / 1e6).toFixed(2)} MB of text in 2,000 blocks; CSS highlights: ${info.highlights ? "yes" : "no (boxes)"}`);
	// Opening Find reads every block the first time (cold); later queries reuse what was read.
	const cold = await page.evaluate(async () => {
		const b = (window as unknown as { bench: Bench }).bench;
		const start = performance.now();
		b.openFind();
		const first = await b.find("checkout");
		return { open: performance.now() - start, first };
	});
	console.log(`Find, opening it and the first query (reads all 2,000 blocks): ${cold.open.toFixed(1)} ms (${cold.first.count})`);
	const rows: string[] = [];
	let worstFind = 0;
	for (const query of ["cart total", "the", "receipt checkout server", "unicode emoji", "zzz-not-there", "s"]) {
		const times = (await page.evaluate(async (q) => {
			const b = (window as unknown as { bench: Bench }).bench;
			const out: { ms: number; count: string }[] = [];
			// One untimed run first, as a person's first keystroke after opening is.
			await b.find(q);
			for (let n = 0; n < 20; n++) {
				await b.find("");
				out.push(await b.find(q));
			}
			return out;
		}, query));
		const ms = times.map((t) => t.ms);
		worstFind = Math.max(worstFind, percentile(ms, 95));
		rows.push(`| Find "${query}" | ${times.at(-1)!.count.split("/")[1]} matches | ${percentile(ms, 50).toFixed(1)} | ${percentile(ms, 95).toFixed(1)} |`);
	}
	await page.evaluate(() => (window as unknown as { bench: Bench }).bench.openPalette("all"));
	let worstPalette = 0;
	for (const [tab, query] of [["all", "cart"], ["all", "chkout"], ["files", "src"], ["files", "server-12"], ["threads", "session"], ["all", "zzzq"]] as const) {
		const times = await page.evaluate(async ([t, q]) => {
			const b = (window as unknown as { bench: Bench }).bench;
			b.openPalette(t);
			const out: { ms: number; rows: number }[] = [];
			await b.palette(q);
			for (let n = 0; n < 20; n++) {
				await b.palette("");
				out.push(await b.palette(q));
			}
			return out;
		}, [tab, query] as const);
		const ms = times.map((t) => t.ms);
		worstPalette = Math.max(worstPalette, percentile(ms, 95));
		rows.push(`| Palette ${tab} "${query}" | ${times.at(-1)!.rows} rows | ${percentile(ms, 50).toFixed(1)} | ${percentile(ms, 95).toFixed(1)} |`);
	}
	console.log("\n| Query | Results | p50 ms | p95 ms |\n|---|---|---|---|");
	for (const row of rows) console.log(row);
	console.log(`\nFind p95 worst ${worstFind.toFixed(1)} ms (target 100): ${worstFind < 100 ? "met" : "MISSED"}; palette p95 worst ${worstPalette.toFixed(1)} ms (target 50): ${worstPalette < 50 ? "met" : "MISSED"}`);
	if (worstFind >= 100 || worstPalette >= 50) process.exitCode = 1;
	// With --webkit (macOS): the same page in a WKWebView, the app's engine.
	if (process.argv.includes("--webkit")) {
		console.log("\nIn WKWebView:");
		// Not spawnSync: this process serves the page it loads.
		const run = await new Promise<{ out: string; failed: boolean }>((resolve) =>
			execFile("swift", [join(import.meta.dirname, "webkit.swift"), url], { timeout: 300_000 }, (error, stdout, stderr) => resolve({ out: stdout || stderr, failed: error !== null })),
		);
		console.log(run.out.trim());
		if (run.failed) process.exitCode = 1;
	}
} finally {
	await browser.close();
	if (process.env.KEEP_BENCH) {
		// For checking the same page in another webview (the app's): it stays up until interrupted.
		console.log(`serving ${url} (Ctrl-C to stop)`);
		await new Promise(() => {});
	}
	server.close();
	rmSync(out, { recursive: true, force: true });
}
