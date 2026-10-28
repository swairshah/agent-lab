// The page test/bench/search.ts measures: the real Find controller and text reader over a generated thread of
// 2,000 searchable blocks (about 2 MB), shaped like the thread view's rows, and the real palette over 10,000 file
// paths and 1,000 thread titles.
import { Find, type FindBlock, type FindTarget } from "../../src/web/find.ts";
import { rangeOf, readText, type TextMap } from "../../src/web/find-text.ts";
import { Palette } from "../../src/web/palette.ts";

// A fixed sequence of "random" numbers, so every run searches the same text.
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const WORDS = "the a cart total item price discount order receipt checkout server client session thread message reply tool output file path render search match query index block range offset unicode emoji value state update stream token model agent request response error retry cache".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");

const thread = document.getElementById("thread")!;
const scroller = document.getElementById("scroller")!;
let bytes = 0;
for (let n = 0; n < 1000; n++) {
	// A reply: paragraphs with some emphasis and code, about 1 KB.
	const reply = document.createElement("article");
	reply.className = "msg msg-agent";
	reply.dataset.unit = `r${n}`;
	const body = document.createElement("div");
	body.className = "msg-body prose";
	body.dataset.find = "";
	body.innerHTML = `<p>${sentence(60)} <strong>${sentence(3)}</strong> ${sentence(40)}</p><p>${sentence(50)} <code>${sentence(2)}</code> ${sentence(20)}</p>`;
	reply.append(body);
	// A tool call's output, about 1 KB, folded.
	const tool = document.createElement("article");
	tool.className = "msg msg-agent";
	tool.dataset.unit = `t${n}`;
	tool.innerHTML = `<details class="fold tool"><summary>Ran</summary><pre class="tool-output" data-find>${Array.from({ length: 8 }, () => sentence(20)).join("\n")}</pre></details>`;
	thread.append(reply, tool);
	bytes += body.textContent!.length + tool.textContent!.length;
}

const texts = new WeakMap<Element, { map: TextMap; revision: number }>();
let revision = 0;
const target: FindTarget = {
	id: "bench",
	label: "Conversation",
	inputLabel: "Find in conversation",
	barBefore: scroller,
	scroller,
	blocks: () => {
		const out: FindBlock[] = [];
		for (const row of thread.children) {
			(row as HTMLElement).querySelectorAll("[data-find]").forEach((part, n) => {
				let read = texts.get(part);
				if (read === undefined) texts.set(part, (read = { map: readText(part), revision: ++revision }));
				out.push({ id: `${(row as HTMLElement).dataset.unit}#${n}`, revision: read.revision, text: read.map.text, map: read.map });
			});
		}
		return out;
	},
	reveal: (match) => {
		const [unit, n] = match.blockId.split("#");
		const part = thread.querySelector(`[data-unit="${unit}"]`)?.querySelectorAll("[data-find]")[Number(n)];
		const fold = part?.closest("details");
		if (fold && !fold.open) fold.open = true;
		const read = part && texts.get(part);
		return read ? rangeOf(read.map, match.start, match.end) : undefined;
	},
	alive: () => true,
	restore: () => {},
};
const find = new Find({ target: () => target });
const input = document.getElementById("find-input") as HTMLInputElement;
/** Resolves just after the next frame is painted (a task queued from that frame's animation callbacks). Find counts
 *  and highlights in an animation callback queued before this one, so its work is in that frame. */
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now()))));

/** Time from typing a query to the frame after it was counted and highlighted. */
async function findOnce(query: string): Promise<{ ms: number; count: string }> {
	const start = performance.now();
	input.value = query;
	input.dispatchEvent(new Event("input"));
	const end = await frame();
	return { ms: end - start, count: document.getElementById("find-count")!.textContent! };
}

const files = Array.from({ length: 10_000 }, (_, n) => `packages/${WORDS[n % WORDS.length]}/src/${WORDS[(n * 7) % WORDS.length]}/${WORDS[(n * 13) % WORDS.length]}-${n}.ts`);
const threads = Array.from({ length: 1000 }, (_, n) => ({ id: `t${n}`, title: `${sentence(5)} ${n}`, project: WORDS[n % WORDS.length]!, current: n === 0 }));
const palette = new Palette({ handlers: { "palette.all": () => {} }, files: () => files, openFile: () => {}, threads: () => threads, openThread: () => {} });
const paletteInput = document.getElementById("palette-input") as HTMLInputElement;

async function paletteOnce(query: string): Promise<{ ms: number; rows: number }> {
	const start = performance.now();
	paletteInput.value = query;
	paletteInput.dispatchEvent(new Event("input"));
	const end = await frame();
	return { ms: end - start, rows: document.querySelectorAll("#palette-list .palette-row").length };
}

Object.assign(window, {
	bench: {
		bytes,
		blocks: () => target.blocks().length,
		openFind: () => find.open(),
		find: findOnce,
		openPalette: (tab: "all" | "files" | "threads") => palette.open(tab),
		palette: paletteOnce,
		highlights: () => typeof CSS !== "undefined" && "highlights" in CSS,
	},
});
document.title = "ready";
