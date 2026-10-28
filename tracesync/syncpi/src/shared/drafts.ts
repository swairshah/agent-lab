// Text written together, live: unsent drafts and project files being edited. Each is a Yjs document.
//
// Drafts, as in Delta: everyone in the thread sees a draft change keystroke by keystroke, with the cursors in it,
// and an editor can join someone's draft to write it with them; whoever sends it sends it for everyone who wrote it.
// The server only relays and merges them in memory; they're never stored there.
//
// Files: a file someone is editing is a document too (`file:<path>`), started from the file on disk; the server
// writes it back as people type, and merges in changes made to the file some other way (by the agent, say).
import { diffLines } from "diff";
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

/** The key of a file's live document, as cursors name it. */
export function fileKey(path: string): string {
	return `file:${path}`;
}

/**
 * Turns `text` into `next` with one replaced span: what lies between their common start and common end. `caret`,
 * where the cursor is in `next`, keeps that end from reaching left of it, so typing a letter that repeats the next
 * one inserts it where it was typed.
 */
export function replaceText(text: Y.Text, next: string, origin: unknown, caret = next.length): void {
	const before = text.toString();
	if (before === next) return;
	const most = Math.min(before.length, next.length);
	let start = 0;
	while (start < most && before[start] === next[start]) start++;
	const tail = Math.min(most - start, Math.max(0, next.length - caret));
	let end = 0;
	while (end < tail && before[before.length - 1 - end] === next[next.length - 1 - end]) end++;
	text.doc!.transact(() => {
		if (before.length - start - end > 0) text.delete(start, before.length - start - end);
		if (next.length - start - end > 0) text.insert(start, next.slice(start, next.length - end));
	}, origin);
}

/**
 * Turns `text` into `next` hunk by hunk (a line diff, then the changed span within each hunk), so changes in
 * different places stay in their places: what a change on disk did to a file, made to its document.
 */
export function patchText(text: Y.Text, next: string, origin: unknown): void {
	const parts = diffLines(text.toString(), next);
	text.doc!.transact(() => {
		let at = 0;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			if (!part.added && !part.removed) at += part.value.length;
			else if (part.removed && parts[i + 1]?.added) {
				const added = parts[++i]!.value;
				const most = Math.min(part.value.length, added.length);
				let start = 0;
				while (start < most && part.value[start] === added[start]) start++;
				let end = 0;
				while (end < most - start && part.value[part.value.length - 1 - end] === added[added.length - 1 - end]) end++;
				if (part.value.length - start - end > 0) text.delete(at + start, part.value.length - start - end);
				if (added.length - start - end > 0) text.insert(at + start, added.slice(start, added.length - end));
				at += added.length;
			} else if (part.removed) text.delete(at, part.value.length);
			else {
				text.insert(at, part.value);
				at += part.value.length;
			}
		}
	}, origin);
}

/** A draft that's a command (/… or !…) is its writer's business: others don't see it. */
export function isCommand(text: string): boolean {
	return /^\s*[/!]/.test(text);
}

/** The largest change to a draft the server takes. */
export const DRAFT_LIMITS = { updateBytes: 256 * 1024 };
