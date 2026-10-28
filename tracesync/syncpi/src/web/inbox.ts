// The inbox, as in Delta (⇧⌘J, or "Inbox" in the palette): messages that mention you. Unread first (⌘1) or all
// (⌘2); arrows move, Enter opens the message where it was left, in its thread. In the app it spans every thread
// (the host follows shared threads, src/desktop/host.ts); in a browser it's this thread's.
//
// What you've read is kept in this browser (or the app).
import type { Mention } from "../shared/mentions.ts";
import { formatKeys, matchesKeys } from "../shared/keymap.ts";
import { $, el, escapeHtml, initials, personColor, relativeTime, storage } from "./dom.ts";

export type InboxItem = Mention & { thread: string; threadTitle: string };

const READ = "syncpi-inbox-read";
const SEEN = "syncpi-inbox-seen";

export const itemId = (i: InboxItem) => `${i.thread}/${i.key}/${i.comment ?? "m"}`;

function idSet(key: string): Set<string> {
	try {
		return new Set(JSON.parse(storage.get(key) ?? "[]") as string[]);
	} catch {
		return new Set();
	}
}
function saveIds(key: string, ids: Set<string>): void {
	storage.set(key, JSON.stringify([...ids].slice(-3000)));
}

export class Inbox {
	readonly #dialog = $<HTMLDialogElement>("inbox");
	readonly #list = $("inbox-list");
	readonly #load: () => InboxItem[];
	readonly #open: (item: InboxItem) => void;
	readonly #many: boolean;
	#tab: "unread" | "all" = "unread";
	#rows: InboxItem[] = [];
	#selected = 0;

	/** `many`: items come from more than one thread, so each shows its thread. */
	constructor(options: { load: () => InboxItem[]; open: (item: InboxItem) => void; many: boolean }) {
		this.#load = options.load;
		this.#open = options.open;
		this.#many = options.many;
		$("inbox-tabs").addEventListener("click", (event) => {
			const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
			if (tab === "unread" || tab === "all") this.#show(tab);
		});
		this.#list.addEventListener("click", (event) => {
			const index = (event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
			if (index !== undefined) this.#run(Number(index));
		});
		this.#dialog.addEventListener("keydown", (event) => this.#key(event));
		this.#dialog.addEventListener("click", (event) => {
			if (event.target === this.#dialog) this.#dialog.close();
		});
		$("inbox-read-all").addEventListener("click", () => {
			const read = idSet(READ);
			for (const item of this.#load()) read.add(itemId(item));
			saveIds(READ, read);
			this.#render();
		});
	}

	get isOpen(): boolean {
		return this.#dialog.open;
	}

	toggle(): void {
		if (this.#dialog.open) return this.#dialog.close();
		this.#dialog.showModal();
		this.#show(this.unread(this.#load()).length > 0 ? "unread" : "all");
		// The list has the keys (arrows, Enter), not the first button.
		this.#list.focus();
	}

	/** Refreshes the list if it's showing (new mentions arrived). */
	update(): void {
		if (this.#dialog.open) this.#render();
	}

	unread(items: InboxItem[]): InboxItem[] {
		const read = idSet(READ);
		return items.filter((i) => !read.has(itemId(i)));
	}

	/** Mentions not announced yet (each is announced once, as it arrives); marks them announced. */
	fresh(items: InboxItem[]): InboxItem[] {
		const seen = idSet(SEEN);
		const first = storage.get(SEEN) === undefined;
		const out = this.unread(items).filter((i) => !seen.has(itemId(i)));
		for (const i of items) seen.add(itemId(i));
		saveIds(SEEN, seen);
		// The first time, what's already there isn't news.
		return first ? [] : out;
	}

	read(item: InboxItem): void {
		const read = idSet(READ);
		read.add(itemId(item));
		saveIds(READ, read);
	}

	#show(tab: "unread" | "all"): void {
		this.#tab = tab;
		this.#render();
	}

	#render(): void {
		const items = this.#load();
		const unread = this.unread(items);
		const unreadIds = new Set(unread.map(itemId));
		$("inbox-tabs").innerHTML = [
			["unread", `Unread (${unread.length})`, 1],
			["all", "All", 2],
		]
			.map(([tab, label, n]) => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${tab === this.#tab}">${label}<kbd>${formatKeys(`cmd-${n}`)}</kbd></button>`)
			.join("");
		this.#rows = this.#tab === "unread" ? unread : items;
		this.#selected = Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
		this.#list.replaceChildren();
		if (this.#rows.length === 0) {
			this.#list.append(el("div", "palette-empty", this.#tab === "unread" ? "No unread notifications" : "Nobody has mentioned you yet"));
			return;
		}
		this.#rows.forEach((item, n) => {
			const row = el("div", "inbox-row");
			row.dataset.index = String(n);
			row.dataset.unread = String(unreadIds.has(itemId(item)));
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", String(n === this.#selected));
			const where = this.#many ? ` in <span class="inbox-thread">${escapeHtml(item.threadTitle)}</span>` : "";
			const when = item.at ? `<span class="inbox-time">${escapeHtml(relativeTime(item.at))}</span>` : "";
			row.innerHTML = `<span class="avatar" style="--person:${personColor(item.author)}">${escapeHtml(initials(item.author))}</span><div class="inbox-main"><div class="inbox-head"><strong>${escapeHtml(item.author)}</strong> ${
				item.comment !== undefined ? "mentioned you in a comment" : "mentioned you"
			}${where}${when}</div><div class="inbox-text">${escapeHtml(item.text)}</div></div>`;
			this.#list.append(row);
		});
		this.#list.querySelector(`[data-index="${this.#selected}"]`)?.scrollIntoView({ block: "nearest" });
	}

	#run(index: number): void {
		const item = this.#rows[index];
		if (item === undefined) return;
		this.read(item);
		this.#dialog.close();
		this.#open(item);
	}

	#key(event: KeyboardEvent): void {
		if (matchesKeys(event, "cmd-1") || matchesKeys(event, "cmd-2")) {
			event.preventDefault();
			return this.#show(matchesKeys(event, "cmd-1") ? "unread" : "all");
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (this.#rows.length === 0) return;
			this.#selected = (this.#selected + (event.key === "ArrowDown" ? 1 : -1) + this.#rows.length) % this.#rows.length;
			for (const row of this.#list.querySelectorAll<HTMLElement>("[data-index]")) row.setAttribute("aria-selected", String(Number(row.dataset.index) === this.#selected));
			this.#list.querySelector(`[data-index="${this.#selected}"]`)?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter") {
			event.preventDefault();
			this.#run(this.#selected);
		}
	}
}
