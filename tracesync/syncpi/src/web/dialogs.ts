// Small confirmations and the share link. Everything else lives in settings.
import { type App, commandsFor, formatKeys } from "../shared/keymap.ts";
import type { InviteInfo } from "../shared/protocol.ts";
import { $ } from "./dom.ts";
import type { SessionClient } from "./session.ts";

export type DialogId = "compact" | "reset" | "share" | "keymap" | "land";

export class Dialogs {
	constructor(session: SessionClient) {
		for (const id of ["compact", "reset", "share", "keymap", "land"] as DialogId[]) {
			const dialog = this.#dialog(id);
			dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
		}
		$("copy-share").addEventListener("click", () => void navigator.clipboard?.writeText($<HTMLInputElement>("share-url").value));
		$("compact-form").addEventListener("submit", (event) => {
			event.preventDefault();
			session.send({ type: "compact", instructions: $<HTMLTextAreaElement>("compact-instructions").value.trim() || undefined });
			this.#dialog("compact").close();
		});
		$("reset-form").addEventListener("submit", (event) => {
			event.preventDefault();
			session.send({ type: "new" });
			this.#dialog("reset").close();
		});
	}

	#dialog(id: DialogId): HTMLDialogElement {
		return $<HTMLDialogElement>(`${id}-dialog`);
	}

	open(id: DialogId): void {
		this.#dialog(id).showModal();
	}

	/** Every shortcut this app has, grouped as in the palette. */
	keymap(app: App): void {
		const groups = new Map<string, string[]>();
		for (const c of commandsFor(app)) {
			if (c.keys === undefined) continue;
			groups.set(c.group, [...(groups.get(c.group) ?? []), `<div class="keymap-row"><span>${c.title}</span><kbd>${formatKeys(c.keys)}</kbd></div>`]);
		}
		const extra = `<div class="keymap-row"><span>Send a message</span><kbd>${formatKeys("cmd-enter")}</kbd></div><div class="keymap-row"><span>New line</span><kbd>${formatKeys("enter")}</kbd></div>`;
		$("keymap-list").innerHTML =
			[...groups].map(([group, rows]) => `<section><h3>${group}</h3>${rows.join("")}</section>`).join("") + `<section><h3>Composer</h3>${extra}</section>`;
		this.open("keymap");
	}

	share(url: string, invite: InviteInfo): void {
		$("share-who").textContent = invite.email
			? `Only ${invite.email} can use this link, after signing in with exe.dev. They join as ${invite.role}.`
			: `Anyone with this link can join as ${invite.role}${invite.expiresAt ? ` until ${new Date(invite.expiresAt).toLocaleDateString()}` : ""}.`;
		$<HTMLInputElement>("share-url").value = url;
		$("share-cli").textContent = `syncpi --url ${url}`;
		this.open("share");
	}
}
