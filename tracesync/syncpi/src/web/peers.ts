// Other people's cursors in a draft: where they are now (their Yjs relative positions, resolved against the draft as
// it is here), and the draft's text drawn with them, each person's selection tinted and their caret named, as in a
// shared document. The composer draws them over its textarea; the thread draws them in a draft being written.
import { draftText, Y } from "../shared/drafts.ts";
import { escapeHtml, personColor } from "./dom.ts";
import type { SessionClient } from "./session.ts";

export type Peer = { id: string; name: string; start: number; end: number; at: number };

function index(doc: Y.Doc, json: unknown): number | undefined {
	if (json === undefined || json === null) return undefined;
	try {
		return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc)?.index;
	} catch {
		return undefined;
	}
}

/** The people whose cursors are in `owner`'s draft (not you), with their selections in its current text. */
export function peersIn(session: SessionClient, owner: string): Peer[] {
	const doc = owner.startsWith("file:") ? session.fileDocs.get(owner.slice(5))?.doc : session.drafts.get(owner)?.doc;
	if (doc === undefined) return [];
	const length = draftText(doc).length;
	const out: Peer[] = [];
	for (const [id, caret] of session.carets) {
		if (caret.owner !== owner || id === session.me?.id) continue;
		const anchor = index(doc, caret.anchor);
		const head = index(doc, caret.head) ?? anchor;
		if (anchor === undefined || head === undefined) continue;
		const clamp = (n: number) => Math.max(0, Math.min(length, n));
		out.push({ id, name: session.nameOf(id, caret.name), start: clamp(Math.min(anchor, head)), end: clamp(Math.max(anchor, head)), at: caret.at });
	}
	return out;
}

/** `text` as HTML with each peer's selection marked and their caret at its end, named for a moment after it moved. */
export function peersHtml(text: string, peers: Peer[]): string {
	const cuts = [...new Set([0, text.length, ...peers.flatMap((p) => [p.start, p.end])])].sort((a, b) => a - b);
	let html = "";
	for (let i = 0; i < cuts.length; i++) {
		const at = cuts[i]!;
		for (const p of peers) {
			if (p.end !== at) continue;
			const hide = Math.max(0, p.at + 2500 - Date.now());
			html += `<span class="peer-caret" style="--person:${personColor(p.name)}; --hide:${hide}ms" data-name="${escapeHtml(p.name)}"></span>`;
		}
		const next = cuts[i + 1];
		if (next === undefined) break;
		const segment = escapeHtml(text.slice(at, next));
		const over = peers.find((p) => p.start <= at && next <= p.end && p.start < p.end);
		html += over ? `<mark class="peer-selection" style="--person:${personColor(over.name)}">${segment}</mark>` : segment;
	}
	// A last empty line still takes its height, as in the textarea.
	return text.endsWith("\n") ? `${html} ` : html;
}
