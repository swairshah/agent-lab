// Unsent drafts, shared as they're written and written together, as in Delta. Each member's draft is a Yjs document:
// everyone in the thread sees it change keystroke by keystroke, with the cursors in it, and an editor can join
// someone's draft to write it with them; whoever sends it sends it for everyone who wrote it. The server only relays
// and merges them in memory; they're never stored there.
import * as Y from "yjs";

export { Y };

export function draftText(doc: Y.Doc): Y.Text {
	return doc.getText("draft");
}

export function toBase64(bytes: Uint8Array): string {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A draft that's a command (/… or !…) is its writer's business: others don't see it. */
export function isCommand(text: string): boolean {
	return /^\s*[/!]/.test(text);
}

/** The largest change to a draft the server takes. */
export const DRAFT_LIMITS = { updateBytes: 256 * 1024 };
