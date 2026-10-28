// Mentions: "@Name" in a message or a comment points it at a member of the session, who finds it in their inbox.
// Names are matched as written in the session (they may contain spaces), case-insensitively, and only as a whole
// name: "@Ann" doesn't mention "Anna".
import type { ThreadState, UserItem } from "./thread.ts";

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` mentions the member named `name`. */
export function mentions(text: string, name: string): boolean {
	if (!name.trim()) return false;
	return new RegExp(`(^|[^\\w@])@${escape(name.trim())}(?![\\w])`, "i").test(text);
}

/** The names mentioned in `text`, out of `names`, longest first so "@Ann Lee" isn't also "@Ann". */
export function mentioned(text: string, names: readonly string[]): string[] {
	return [...names].sort((a, b) => b.length - a.length).filter((name) => mentions(text, name));
}

/** A message that mentions someone: where it is in the thread, who wrote it and what it says. */
export type Mention = {
	/** The user message's key in the thread. */
	key: string;
	/** Which comment of the message mentions them, when it's one of its comments rather than its text. */
	comment?: number;
	memberId?: string;
	author: string;
	text: string;
	at?: number;
};

/** The messages in a thread that mention `me` (by name), written by someone else; the newest first. */
export function mentionsOf(state: ThreadState, me: { id: string; name: string }): Mention[] {
	const out: Mention[] = [];
	for (const item of state.items) {
		if (item.kind !== "user" || item.memberId === me.id) continue;
		const user = item as UserItem;
		const base = { key: user.key, memberId: user.memberId, author: user.author ?? "someone", at: user.at };
		if (mentions(user.text, me.name)) out.push({ ...base, text: user.text });
		(user.comments ?? []).forEach((c, n) => {
			if (mentions(c.text, me.name)) out.push({ ...base, comment: n, text: c.text });
		});
	}
	return out.reverse();
}
