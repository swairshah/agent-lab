// Find's literal matching and the palette's ranking, without a browser (src/shared/search.ts). Part of
// `npm run test:search`; run alone with `npx tsx --test test/search-unit.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { byRank, fileMatch, findAll, fuzzy, keepActive, literalPattern, markPositions, MAX_QUERY, matchesIn, type SearchBlock } from "../src/shared/search.ts";

const blocks = (...texts: string[]): SearchBlock[] => texts.map((text, n) => ({ id: `b${n}`, revision: 1, text }));
const spans = (text: string, query: string, matchCase = false) => findAll(blocks(text), query, matchCase).map((m) => text.slice(m.start, m.end));

test("a phrase in two blocks is found in both, in block order", () => {
	const found = findAll(blocks("the cart total", "nothing here", "cart totals again"), "cart total", false);
	assert.deepEqual(
		found.map((m) => [m.blockId, m.start]),
		[
			["b0", 4],
			["b2", 0],
		],
	);
});

test("matches never cross blocks", () => {
	assert.equal(findAll(blocks("ends with cart", "total starts"), "cart total", false).length, 0);
});

test("regular-expression characters are literal", () => {
	for (const q of [".*", "[Ada]", "src/foo.ts", "a+b", "(x)", "$1", "\\d", "^", "|"]) {
		assert.deepEqual(spans(`before ${q} after`, q), [q], q);
	}
	assert.equal(spans("src/fooXts", "src/foo.ts").length, 0);
});

test("Match case decides which occurrences count", () => {
	assert.deepEqual(spans("Total total TOTAL", "total"), ["Total", "total", "TOTAL"]);
	assert.deepEqual(spans("Total total TOTAL", "total", true), ["total"]);
});

test("occurrences don't overlap", () => {
	assert.equal(spans("aaaa", "aa").length, 2);
	assert.equal(spans("aaa", "aa").length, 1);
});

test("an empty query finds nothing; spaces count", () => {
	assert.equal(findAll(blocks("anything"), "", false).length, 0);
	assert.deepEqual(spans("a b  c", "  "), ["  "]);
	assert.equal(spans("ab", " a").length, 0);
});

test("offsets are UTF-16 code units, right after emoji and mixed scripts", () => {
	const text = "🙂👩‍💻 Привет mañana total";
	const [m] = findAll(blocks(text), "total", false);
	assert.equal(text.slice(m!.start, m!.end), "total");
	assert.deepEqual(spans("😀 MAÑANA", "mañana"), ["MAÑANA"]);
	assert.deepEqual(spans("ΣΊΣΥΦΟΣ σίσυφος", "σίσυφος"), ["ΣΊΣΥΦΟΣ", "σίσυφος"]);
});

test("case-insensitive matching keeps the original text's offsets", () => {
	// "İ" lowercases to two code units; offsets must still point into the original string.
	const text = "İstanbul and istanbul";
	for (const m of findAll(blocks(text), "stanbul", false)) assert.equal(text.slice(m.start, m.end), "stanbul");
});

test("queries are cut at the limit", () => {
	const long = "x".repeat(MAX_QUERY + 50);
	assert.equal(literalPattern(long, false)!.source.length, MAX_QUERY);
	assert.equal(matchesIn("x".repeat(MAX_QUERY), literalPattern(long, true)!).length, 1);
});

test("the active match is kept, or the next after it, or the last", () => {
	const order = (id: string) => Number(id.slice(1));
	const before = findAll(blocks("cat cat", "cat", "cat"), "cat", false);
	const active = before[2]!; // b1
	assert.equal(keepActive(before, active, order), 2);
	// Older history arrives at the front: same occurrence, new index.
	const grown = findAll([{ id: "b-1", revision: 1, text: "cat" }, ...blocks("cat cat", "cat", "cat")], "cat", false);
	assert.equal(keepActive(grown, active, order), 3);
	// It disappears: the next one after it.
	const gone = findAll(blocks("cat cat", "dog", "cat"), "cat", false);
	assert.deepEqual(gone[keepActive(gone, active, order)], { blockId: "b2", start: 0, end: 3 });
	// Nothing after it: the last.
	const tail = findAll(blocks("cat cat", "dog", "dog"), "cat", false);
	assert.equal(keepActive(tail, active, order), 1);
	assert.equal(keepActive([], active, order), -1);
});

test("palette: a file matches by the better of its path and its name", () => {
	// The name matches at its start; the full path only late.
	const late = fileMatch("packages/web/src/components/palette.ts", "palette")!;
	assert.equal(late.field, "name");
	assert.ok(late.score > fuzzy("packages/web/src/components/palette.ts", "palette").score);
	// Neither matches: out, whatever bonus a name would have had.
	assert.equal(fileMatch("src/server/room.ts", "zzq"), undefined);
	assert.equal(fileMatch("src/a.ts", "srcxa"), undefined);
});

test("palette: a match only in the folder says so", () => {
	const match = fileMatch("src/server/room.ts", "server")!;
	assert.equal(match.field, "path");
	assert.deepEqual(match.positions, [4, 5, 6, 7, 8, 9]);
});

test("palette: equal scores sort the same way every time", () => {
	const rows = [
		{ score: 10, label: "beta", id: "2" },
		{ score: 10, label: "Alpha", id: "9" },
		{ score: 10, label: "alpha", id: "1" },
		{ score: 50, label: "zeta", id: "5" },
	];
	const once = [...rows].sort(byRank).map((r) => r.id);
	const again = [...rows].reverse().sort(byRank).map((r) => r.id);
	assert.deepEqual(once, ["5", "1", "9", "2"]);
	assert.deepEqual(again, once);
});

test("palette: highlights land on the right characters after emoji", () => {
	const title = "🎉 Launch party";
	const { positions } = fuzzy(title, "party");
	const marked = markPositions(title, positions).filter((p) => p.marked).map((p) => p.text).join("");
	assert.equal(marked, "party");
	const sub = fuzzy("👩‍💻 go to file", "gtf");
	assert.ok(sub.score > 0);
	assert.equal(markPositions("👩‍💻 go to file", sub.positions).filter((p) => p.marked).map((p) => p.text).join(""), "gtf");
});
