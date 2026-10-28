// Settings (⌘, or the gear): everything that isn't the conversation. Your name, appearance, where your requests run,
// the model and context; people and invites; branches; the environment the setup agent prepared; session details.
import { ROLES } from "../shared/protocol.ts";
import { $, escapeHtml, initials, personColor, relativeTime } from "./dom.ts";
import type { SessionClient } from "./session.ts";

const ENV_LABEL = { pending: "Waiting to start", running: "Setting up", ready: "Ready", failed: "Setup failed" } as const;

export type Section = "general" | "people" | "branches" | "environment" | "session";

export type SettingsHooks = {
	onTheme(theme: string): void;
	onShowSetup(): void;
	onCompact(): void;
	onReset(): void;
};

export class Settings {
	readonly #session: SessionClient;
	readonly #dialog: HTMLDialogElement;
	#modelsLoaded = false;

	constructor(session: SessionClient, hooks: SettingsHooks) {
		this.#session = session;
		this.#dialog = $<HTMLDialogElement>("settings-dialog");
		this.#dialog.querySelector("[data-close]")!.addEventListener("click", () => this.#dialog.close());
		this.#dialog.querySelector(".settings-nav")!.addEventListener("click", (event) => {
			const section = (event.target as HTMLElement).closest<HTMLElement>("[data-section]")?.dataset.section;
			if (section !== undefined) this.show(section as Section);
		});

		$("rename").addEventListener("submit", (event) => {
			event.preventDefault();
			const name = $<HTMLInputElement>("rename-input").value.trim();
			if (name && name !== session.me?.name) session.send({ type: "rename", name });
		});
		$<HTMLSelectElement>("theme-select").addEventListener("change", (event) => hooks.onTheme((event.target as HTMLSelectElement).value));
		$("model-form").addEventListener("submit", (event) => {
			event.preventDefault();
			session.send({ type: "configure", model: $<HTMLInputElement>("model-ref").value.trim(), thinkingLevel: $<HTMLSelectElement>("model-thinking").value });
		});
		$("compact-button").addEventListener("click", hooks.onCompact);
		$("reset-button").addEventListener("click", hooks.onReset);
		$("env-open").addEventListener("click", () => {
			this.#dialog.close();
			hooks.onShowSetup();
		});

		$("members").addEventListener("change", (event) => {
			const select = event.target as HTMLSelectElement;
			if (select.dataset.member) session.send({ type: "setRole", memberId: select.dataset.member, role: select.value as (typeof ROLES)[number] });
		});
		$("members").addEventListener("click", (event) => {
			const id = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
			if (id) session.send({ type: "remove", memberId: id });
		});
		$("invites").addEventListener("click", (event) => {
			const code = (event.target as HTMLElement).closest<HTMLElement>("[data-revoke]")?.dataset.revoke;
			if (code) session.send({ type: "revoke", code });
		});
		$("invite-form").addEventListener("submit", (event) => {
			event.preventDefault();
			const email = $<HTMLInputElement>("invite-email").value.trim();
			session.send({
				type: "invite",
				email: email || undefined,
				role: $<HTMLSelectElement>("invite-role").value as (typeof ROLES)[number],
				expiresInDays: email ? undefined : Number($<HTMLSelectElement>("invite-days").value),
			});
			$<HTMLInputElement>("invite-email").value = "";
		});
		$("branch-list").addEventListener("click", (event) => {
			const id = (event.target as HTMLElement).closest<HTMLElement>("[data-branch]")?.dataset.branch;
			if (id) session.send({ type: "switchBranch", id: Number(id) });
		});
	}

	open(section: Section = "general"): void {
		this.show(section);
		if (!this.#dialog.open) this.#dialog.showModal();
	}

	toggle(): void {
		if (this.#dialog.open) this.#dialog.close();
		else this.open();
	}

	show(section: Section): void {
		for (const button of this.#dialog.querySelectorAll<HTMLElement>("[data-section]")) button.setAttribute("aria-current", String(button.dataset.section === section));
		for (const panel of this.#dialog.querySelectorAll<HTMLElement>("[data-panel]")) panel.hidden = panel.dataset.panel !== section;
		if (section === "general") this.renderGeneral();
		if (section === "people" && this.#session.role === "admin") this.#session.send({ type: "invites" });
	}

	/** Your name, the model (admins), context controls (editors), the run-location choice (in an app). */
	renderGeneral(embedded = document.documentElement.classList.contains("embedded")): void {
		const s = this.#session;
		const rename = $<HTMLInputElement>("rename-input");
		if (document.activeElement !== rename && s.me) rename.value = s.me.name;
		$("where-field").hidden = !embedded;
		$("model-field").hidden = s.role !== "admin";
		$("context-field").hidden = s.role === "viewer";
		$("reset-button").hidden = s.role !== "admin";
		const model = $<HTMLInputElement>("model-ref");
		if (document.activeElement !== model) model.value = s.threads.main.state.model ?? s.info?.model ?? "";
		$<HTMLSelectElement>("model-thinking").value = s.threads.main.state.thinkingLevel ?? "medium";
		if (s.role === "admin" && !this.#modelsLoaded) {
			this.#modelsLoaded = true;
			void fetch("api/models", { headers: { authorization: `Bearer ${s.token}` } })
				.then((r) => r.json())
				.then((d: { models?: { id: string; name: string }[] }) => {
					$("available-models").innerHTML = (d.models ?? []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
				})
				.catch(() => (this.#modelsLoaded = false));
		}
	}

	renderPeople(): void {
		const s = this.#session;
		const online = new Set(s.online.map((p) => p.memberId));
		const admin = s.role === "admin";
		$("members").innerHTML = s.members
			.map((m) => {
				const role = m.creator ? "admin · created the session" : m.role;
				const controls =
					admin && !m.creator
						? `<select data-member="${escapeHtml(m.id)}" aria-label="Role of ${escapeHtml(m.name)}">${ROLES.map((r) => `<option${r === m.role ? " selected" : ""}>${r}</option>`).join("")}</select><button type="button" class="link danger" data-remove="${escapeHtml(m.id)}">Remove</button>`
						: `<span class="muted">${role}</span>`;
				return `<li class="member"><span class="avatar${online.has(m.id) ? " online" : ""}" style="--person:${personColor(m.name)}">${escapeHtml(initials(m.name))}</span><span class="member-name">${escapeHtml(m.name)}${
					m.id === s.me?.id ? ' <span class="muted">you</span>' : ""
				}${m.email ? `<span class="member-email">${escapeHtml(m.email)}</span>` : ""}</span>${controls}</li>`;
			})
			.join("");
		$("admin").hidden = !admin;
	}

	renderInvites(): void {
		$("invites").innerHTML =
			this.#session.invites
				.map(
					(i) =>
						`<li class="member"><span class="member-name">${escapeHtml(i.email ?? "Link")}<span class="member-email">${i.role} · used ${i.uses}${
							i.expiresAt ? ` · until ${new Date(i.expiresAt).toLocaleDateString()}` : ""
						}</span></span><button type="button" class="link danger" data-revoke="${escapeHtml(i.code)}">Revoke</button></li>`,
				)
				.join("") || '<li class="muted">No active invites</li>';
	}

	renderBranches(): void {
		const s = this.#session;
		$("branch-list").innerHTML = s.branches
			.map(
				(b) =>
					`<li><button type="button" class="branch-row" data-branch="${b.id}" aria-current="${b.id === s.currentBranch}" ${s.role !== "admin" ? "disabled" : ""}><span class="branch-mark"></span>${escapeHtml(b.label)}<span class="muted">${relativeTime(b.at)}</span></button></li>`,
			)
			.join("");
	}

	renderEnv(): void {
		const env = this.#session.env;
		$("env-status").textContent = ENV_LABEL[env.status];
		$("env-status").dataset.status = env.status;
		$("env-detail").textContent = env.error ?? env.activity ?? "";
		$("env-summary").textContent = env.summary ?? "";
		$("env-summary").hidden = !env.summary;
	}

	renderInfo(): void {
		const s = this.#session;
		if (s.info === undefined) return;
		const rows: [string, string][] = [
			["Project", s.info.workdir],
			["Model", s.threads.main.state.model ?? s.info.model],
			["Session", s.info.url],
		];
		if (s.info.vm) rows.push(["VM", `${s.info.vm}.exe.xyz`]);
		if (s.target) rows.push(["Runs on", s.target]);
		$("info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
	}
}
