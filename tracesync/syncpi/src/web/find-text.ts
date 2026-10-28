// What Find searches in a piece of the page, and where a match is in it (find.ts). Text is read from the elements
// a view marks as searchable, leaving out controls (Copy, avatars, line numbers, buttons), so a match is what's
// displayed. Code drawn by Pierre is read from its lines, in its shadow root, without the line-number gutter.
// Blocks (paragraphs, list items, lines) are separated by a newline, which a query (one line) can't contain, so
// matches stay within one; inline parts (emphasis, links, highlighted tokens) join, so a phrase can cross them.

/** Text that isn't all on the page: a long tool output showing its last lines. `expand` shows all of it. */
export type Folded = { text: string; expand(): void };
const folded = new WeakMap<Element, Folded>();
/** Code for Pierre to draw, by its host, until it's drawn (its text is the same once it is). */
const sources = new WeakMap<Element, string>();

export function setFolded(element: Element, value: Folded): void {
	folded.set(element, value);
}
export function setSource(host: Element, code: string): void {
	sources.set(host, code);
}

/** Never searched, wherever they are. */
const SKIP =
	"button, .copy-code, .avatar, .msg-meta, .msg-where, .answer-to, .inline-comment, .artifact, .viewer, .comment-number, .comment-on, .tool-more, .recording, svg, img, video, iframe, script, style, textarea, input, select, [hidden], [aria-hidden='true']";
const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION", "HR", "DL", "DT", "DD"]);

/** An element's searchable text, with the text nodes it came from (`start` is where each begins in `text`).
 *  `mapped` is false when some of the text isn't on the page as text nodes yet (folded output, code not drawn). */
export type TextMap = { text: string; pieces: { node: Text; start: number }[]; mapped: boolean };

export function readText(root: Element, skip = SKIP): TextMap {
	const out: TextMap = { text: "", pieces: [], mapped: true };
	// Block boundaries become one newline, written only when more text follows (none leads or trails).
	let pending = false;
	const breakLine = () => void (pending = true);
	const flush = () => {
		if (pending && out.text !== "" && !out.text.endsWith("\n")) out.text += "\n";
		pending = false;
	};
	const append = (value: string) => {
		if (value === "") return;
		flush();
		out.text += value;
	};
	const walk = (node: Node) => {
		for (let child = node.firstChild; child !== null; child = child.nextSibling) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child as Text;
				if (text.data === "") continue;
				flush();
				out.pieces.push({ node: text, start: out.text.length });
				out.text += text.data;
			} else if (child.nodeType === Node.ELEMENT_NODE) visit(child as Element);
		}
	};
	const visit = (element: Element, isRoot = false) => {
		// The root is what a view chose to search (it may be a link-like button); only what's inside is filtered.
		if (!isRoot && element.matches(skip)) return;
		const fold = folded.get(element);
		if (fold !== undefined && element.textContent !== fold.text) {
			breakLine();
			append(fold.text);
			out.mapped = false;
			return breakLine();
		}
		if (element.tagName === "BR") return append("\n");
		// Pierre draws into the shadow root of a <diffs-container> inside the host it's given.
		const shadow = element.shadowRoot ?? (sources.has(element) ? (element.querySelector("diffs-container")?.shadowRoot ?? null) : null);
		if (shadow !== null || sources.has(element)) {
			breakLine();
			flush();
			if (!readPierre(shadow, out)) {
				const code = sources.get(element);
				if (code !== undefined) {
					append(code);
					out.mapped = false;
				}
			}
			return breakLine();
		}
		const block = BLOCK.has(element.tagName);
		if (block) breakLine();
		walk(element);
		if (block) breakLine();
	};
	visit(root, true);
	return out;
}

/** Pierre's code: one line per [data-line] in its content column, without the gutter. False if not drawn yet. */
function readPierre(shadow: ShadowRoot | null, out: TextMap): boolean {
	const lines = shadow?.querySelectorAll("[data-content] > [data-line]");
	if (lines === undefined || lines.length === 0) return false;
	lines.forEach((line, n) => {
		if (n > 0) out.text += "\n";
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		for (let t = walker.nextNode() as Text | null; t !== null; t = walker.nextNode() as Text | null) {
			// An empty line holds just a newline, which isn't the line's text.
			if (t.data === "\n") continue;
			out.pieces.push({ node: t, start: out.text.length });
			out.text += t.data;
		}
	});
	return true;
}

/** The live DOM range for text offsets in a TextMap, or undefined when that text isn't in text nodes. */
export function rangeOf(map: TextMap, start: number, end: number): Range | undefined {
	const first = pieceAt(map, start, false);
	const last = pieceAt(map, end, true);
	if (first === undefined || last === undefined || !first.node.isConnected || !last.node.isConnected) return undefined;
	const range = document.createRange();
	range.setStart(first.node, start - first.start);
	range.setEnd(last.node, end - last.start);
	return range;
}

function pieceAt(map: TextMap, offset: number, isEnd: boolean): { node: Text; start: number } | undefined {
	let lo = 0;
	let hi = map.pieces.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const piece = map.pieces[mid]!;
		const from = piece.start;
		const to = from + piece.node.data.length;
		if (isEnd ? offset <= from : offset < from) hi = mid - 1;
		else if (isEnd ? offset > to : offset >= to) lo = mid + 1;
		else return piece;
	}
	return undefined;
}
