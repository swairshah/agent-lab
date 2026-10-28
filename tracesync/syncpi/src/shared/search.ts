// Search, without the DOM: Find's literal matching (find.ts), and the palette's ranking of names and paths
// (palette.ts). See docs/search-spec.md. Offsets are UTF-16 code units throughout, as JavaScript strings and DOM
// Ranges count them; text is never lowercased and then indexed, since case changes can change lengths.

/** Longer queries are cut to this, with a note in the Find bar. */
export const MAX_QUERY = 512;

/** One piece of searchable text: a paragraph of a message, a tool's output, a file's lines. Matches never cross
 *  blocks. `revision` changes whenever the text may have. */
export type SearchBlock = { id: string; revision: number; text: string };
export type FindMatch = { blockId: string; start: number; end: number };

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** The query as a literal pattern: case-insensitive by JavaScript's Unicode rules unless `matchCase`. */
export function literalPattern(query: string, matchCase: boolean): RegExp | undefined {
	if (query === "") return undefined;
	return new RegExp(query.slice(0, MAX_QUERY).replace(SPECIAL, "\\$&"), matchCase ? "gu" : "giu");
}

/** Every occurrence of `query` in `text`, without overlaps ("aa" in "aaaa" is two). */
export function matchesIn(text: string, pattern: RegExp): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	pattern.lastIndex = 0;
	for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
		// An empty match can't happen for a non-empty literal, but never loop on one.
		if (m[0].length === 0) {
			pattern.lastIndex++;
			continue;
		}
		out.push({ start: m.index, end: m.index + m[0].length });
	}
	return out;
}

/** The occurrences in blocks, in block order and then offset order. */
export function findAll(blocks: readonly SearchBlock[], query: string, matchCase: boolean): FindMatch[] {
	const pattern = literalPattern(query, matchCase);
	if (pattern === undefined) return [];
	const out: FindMatch[] = [];
	for (const block of blocks) for (const m of matchesIn(block.text, pattern)) out.push({ blockId: block.id, ...m });
	return out;
}

/**
 * Which match to keep active after the matches changed: the same one (same block and offset) when it's still there,
 * else the nearest after it in document order, else the last. `order` gives each block's position. -1 when there
 * are none.
 */
export function keepActive(matches: readonly FindMatch[], previous: FindMatch | undefined, order: (blockId: string) => number): number {
	if (matches.length === 0) return -1;
	if (previous === undefined) return 0;
	const same = matches.findIndex((m) => m.blockId === previous.blockId && m.start === previous.start && m.end === previous.end);
	if (same >= 0) return same;
	const at = order(previous.blockId);
	const next = matches.findIndex((m) => {
		const o = order(m.blockId);
		return o > at || (o === at && m.start >= previous.start);
	});
	return next >= 0 ? next : matches.length - 1;
}

// ---------- the palette: names and paths ----------

/** One character of text: its offset and its text (a whole code point, so emoji stay whole). */
function chars(text: string): { at: number; ch: string; low: string }[] {
	const out: { at: number; ch: string; low: string }[] = [];
	let at = 0;
	for (const ch of text) {
		out.push({ at, ch, low: ch.toLowerCase() });
		at += ch.length;
	}
	return out;
}

const WORD = /[\p{L}\p{N}_]/u;
const SEPARATOR = /[\s/._-]/;

/**
 * How well `query` matches `text`, ignoring case: a contiguous match scores 1000 less how late it starts (less again
 * when it starts mid-word); otherwise a subsequence scores by runs and word starts. -1 when it doesn't match, or
 * only as letters scattered across the text. The offsets of the matched characters come with it, for highlighting.
 */
export function fuzzy(text: string, query: string): { score: number; positions: number[] } {
	if (query === "") return { score: 0, positions: [] };
	const t = chars(text);
	const q = chars(query);
	for (let i = 0; i + q.length <= t.length; i++) {
		if (q.every((c, n) => t[i + n]!.low === c.low)) {
			const midWord = i > 0 && WORD.test(t[i - 1]!.ch);
			return { score: 1000 - i - (midWord ? 50 : 0), positions: q.map((_, n) => t[i + n]!.at) };
		}
	}
	let i = 0;
	let points = 0;
	let last = -2;
	const positions: number[] = [];
	for (const c of q) {
		while (i < t.length && t[i]!.low !== c.low) i++;
		if (i === t.length) return { score: -1, positions: [] };
		points += i === last + 1 ? 5 : 1;
		if (i === 0 || SEPARATOR.test(t[i - 1]!.ch)) points += 3;
		positions.push(t[i]!.at);
		last = i;
		i++;
	}
	// Letters scattered across the text match nearly anything; keep runs and word starts.
	return points >= q.length * 3 ? { score: points, positions } : { score: -1, positions: [] };
}

/** A project file against the query: the better of its full path and its name (with a bonus for the name), and
 *  where the match is. A path where neither matches is out, whatever the bonus. */
export function fileMatch(path: string, query: string): { score: number; field: "name" | "path"; positions: number[] } | undefined {
	const slash = path.lastIndexOf("/");
	const whole = fuzzy(path, query);
	const name = fuzzy(path.slice(slash + 1), query);
	if (whole.score < 0 && name.score < 0) return undefined;
	if (query === "") return { score: 0, field: "name", positions: [] };
	const byName = name.score >= 0 ? name.score + 200 : -1;
	return byName >= whole.score ? { score: byName, field: "name", positions: name.positions } : { score: whole.score, field: "path", positions: whole.positions };
}

/** Sorts scored rows: best first, then by label (ignoring case, in code-unit order, so it's the same everywhere),
 *  then by id, so equal scores keep one order across redraws. */
export function byRank<T extends { score: number; label: string; id: string }>(a: T, b: T): number {
	if (a.score !== b.score) return b.score - a.score;
	const la = a.label.toLowerCase();
	const lb = b.label.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Text as HTML-ready pieces with the characters at `positions` (UTF-16 offsets of code points) marked. */
export function markPositions(text: string, positions: readonly number[]): { text: string; marked: boolean }[] {
	const marks = new Set(positions);
	const out: { text: string; marked: boolean }[] = [];
	for (const { at, ch } of chars(text)) {
		const marked = marks.has(at);
		const last = out.at(-1);
		if (last !== undefined && last.marked === marked) last.text += ch;
		else out.push({ text: ch, marked });
	}
	return out;
}
