// The web view of a session. It speaks the same WebSocket protocol as the terminal UI and renders the same Thread
// state, so both always show the same thread.
import { marked } from "marked";
import type { ConvName, EnvStatus, InviteInfo, Member, Presence, ServerMessage, SessionInfo } from "../shared/protocol.ts";
import { type Item, Thread, toolSummary } from "../shared/thread.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** The session's path on this server: "/" for a server of its own, "/<id>/" on a shared host. */
const BASE = new URL(document.baseURI).pathname;
const TOKEN_KEY = `syncpi-token:${location.origin}${BASE}`;

function storedToken(): string | undefined {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function storeToken(token: string): void {
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Model output is untrusted: raw HTML in markdown is shown as text, and links cannot run script.
marked.use({
	renderer: {
		html: (token) => escapeHtml(token.text),
		link: ({ href, text }) => (/^https?:|^mailto:/i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text)),
		image: ({ text }) => escapeHtml(text),
	},
});

function personColor(name: string): string {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return `hsl(${h % 360} 45% 50%)`;
}

// ---------- entry: owner link (#token=…), invite (/s/<code>), a stored token, or an exe.dev sign-in ----------

type JoinReply = { token?: string; error?: string; login?: boolean; email?: string; loginUrl?: string };

async function boot(): Promise<void> {
	const hash = new URLSearchParams(location.hash.slice(1));
	const fromHash = hash.get("token");
	if (fromHash) {
		storeToken(fromHash);
		history.replaceState(null, "", BASE);
	}
	const invite = location.pathname.slice(BASE.length - 1).match(/^\/s\/([A-Za-z0-9_-]+)/)?.[1];
	const token = fromHash ?? storedToken();
	if (token !== undefined && (await valid(token))) {
		if (invite !== undefined) history.replaceState(null, "", BASE);
		return start(token);
	}
	if (invite !== undefined) return showJoin(invite);
	// Members invited by email can always come back by signing in with exe.dev.
	const res = await fetch("api/exe-login", { method: "POST" }).catch(() => undefined);
	const reply = ((await res?.json().catch(() => ({}))) ?? {}) as JoinReply;
	if (res?.ok && reply.token) return enter(reply.token);
	$("nologin").hidden = false;
	$<HTMLAnchorElement>("nologin-login").href = reply.loginUrl ?? `/__exe.dev/login?redirect=${encodeURIComponent(BASE)}`;
	if (res?.status === 403) $("nologin-error").textContent = reply.error ?? "";
}

async function valid(token: string): Promise<boolean> {
	const res = await fetch("api/info", { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
	return res?.ok === true;
}

function enter(token: string): void {
	storeToken(token);
	history.replaceState(null, "", BASE);
	$("join").hidden = true;
	$("nologin").hidden = true;
	start(token);
}

async function join(invite: string, name: string): Promise<{ ok: boolean; status: number; reply: JoinReply }> {
	const res = await fetch("api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite, name }) });
	return { ok: res.ok, status: res.status, reply: (await res.json()) as JoinReply };
}

async function showJoin(invite: string): Promise<void> {
	$("join").hidden = false;
	const info = await fetch(`api/invite/${invite}`).catch(() => undefined);
	const details = ((await info?.json().catch(() => ({}))) ?? {}) as { session?: string; role?: string; email?: string; login?: string; error?: string };
	if (!info?.ok) {
		$("join-link").hidden = true;
		$("join-error").textContent = details.error ?? "This invite doesn't work.";
		return;
	}
	if (details.session) $("join-name").textContent = details.session;
	if (details.role && details.role !== "editor") $("join-role").textContent = ` as ${details.role === "admin" ? "an admin" : "a viewer"}`;

	if (details.email !== undefined) {
		// An email invite: try right away, in case this browser is already signed in to exe.dev.
		$("join-link").hidden = true;
		const attempt = await join(invite, "");
		if (attempt.ok && attempt.reply.token) return enter(attempt.reply.token);
		$("join-email").hidden = false;
		$("join-email-to").textContent = details.email;
		$<HTMLAnchorElement>("join-login").href = details.login ?? "#";
		if (attempt.status === 403) {
			$("join-error").textContent = attempt.reply.error ?? "";
			const logout = $("join-logout");
			logout.hidden = false;
			logout.addEventListener("click", async () => {
				await fetch("/__exe.dev/logout", { method: "POST" }).catch(() => {});
				location.reload();
			});
		}
		return;
	}

	const input = $<HTMLInputElement>("join-input");
	try {
		input.value = localStorage.getItem("syncpi-name") ?? "";
	} catch {}
	input.focus();
	$("join-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const name = input.value.trim();
		if (!name) return;
		const attempt = await join(invite, name);
		if (!attempt.ok || !attempt.reply.token) {
			$("join-error").textContent = attempt.reply.error ?? "Could not join.";
			return;
		}
		try {
			localStorage.setItem("syncpi-name", name);
		} catch {}
		enter(attempt.reply.token);
	});
}

// ---------- the live session ----------

const threads: Record<ConvName, Thread> = { main: new Thread(), setup: new Thread() };
let showing: ConvName = "main";
let session: SessionInfo | undefined;
let me: Member | undefined;
let online: Presence[] = [];
let members: Member[] = [];
let env: EnvStatus = { status: "pending" };
let invites: InviteInfo[] = [];
/** Current names by member id: a renamed person shows under their new name everywhere. */
let names = new Map<string, string>();

function setMembers(list: Member[]): void {
	members = list;
	const mine = list.find((m) => m.id === me?.id);
	if (mine !== undefined) me = mine;
	const next = new Map(list.map((m) => [m.id, m.name]));
	const changed = [...next].some(([id, n]) => names.get(id) !== n);
	names = next;
	const rename = $<HTMLInputElement>("rename-input");
	if (document.activeElement !== rename && me) rename.value = me.name;
	const admin = me?.role === "admin";
	if (admin && $("admin").hidden) send({ type: "invites" });
	$("admin").hidden = !admin;
	$("share").hidden = !admin;
	$("composer").hidden = me?.role === "viewer" || showing !== "main";
	if (changed) {
		// Re-render messages so authors show their current names.
		$("thread").replaceChildren();
		rendered.length = 0;
		renderThread();
	}
}
let ws: WebSocket | undefined;
let retry = 0;
const rendered: { key: string; rev: number; el: HTMLElement }[] = [];

function start(token: string): void {
	$("app").hidden = false;
	connect(token);
	const input = $<HTMLTextAreaElement>("input");
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	});
	$("composer").addEventListener("submit", (event) => {
		event.preventDefault();
		submit();
	});
	$("stop").addEventListener("click", () => send({ type: "abort" }));
	$("share").addEventListener("click", () => send({ type: "invite" }));
	$("rename").addEventListener("submit", (event) => {
		event.preventDefault();
		const name = $<HTMLInputElement>("rename-input").value.trim();
		if (name && name !== me?.name) send({ type: "rename", name });
	});
	$("invite-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const email = $<HTMLInputElement>("invite-email").value.trim();
		send({
			type: "invite",
			email: email || undefined,
			role: $<HTMLSelectElement>("invite-role").value,
			expiresInDays: email ? undefined : Number($<HTMLSelectElement>("invite-days").value),
		});
		$<HTMLInputElement>("invite-email").value = "";
	});
	$("members").addEventListener("change", (event) => {
		const select = event.target as HTMLSelectElement;
		if (select.dataset.member) send({ type: "setRole", memberId: select.dataset.member, role: select.value });
	});
	$("members").addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-remove]");
		if (button?.dataset.remove) send({ type: "remove", memberId: button.dataset.remove });
	});
	$("invites").addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-revoke]");
		if (button?.dataset.revoke) send({ type: "revoke", code: button.dataset.revoke });
	});
	$("copy").addEventListener("click", () => void navigator.clipboard?.writeText($<HTMLInputElement>("share-url").value));
	$("tab-main").addEventListener("click", () => show("main"));
	$("tab-setup").addEventListener("click", () => show("setup"));
	input.focus();
}

function connect(token: string): void {
	const wsUrl = new URL(`ws?client=web&token=${encodeURIComponent(token)}`, document.baseURI);
	wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(wsUrl);
	ws = socket;
	setConn("connecting");
	socket.onopen = () => {
		retry = 0;
		setConn("open");
	};
	socket.onmessage = (event) => onMessage(JSON.parse(String(event.data)) as ServerMessage);
	socket.onclose = (event) => {
		if (ws !== socket) return;
		// 4001: removed from the session. The token is dead; don't come back.
		if (event.code === 4001) {
			setConn("removed");
			try {
				localStorage.removeItem(TOKEN_KEY);
			} catch {}
			$("status").textContent = "You were removed from this session.";
			$("composer").hidden = true;
			return;
		}
		setConn("reconnecting");
		setTimeout(() => connect(token), Math.min(15_000, 500 * 2 ** retry++));
	};
}

function send(message: unknown): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function setConn(state: string): void {
	const el = $("conn");
	el.textContent = state;
	el.className = `pill ${state}`;
}

function submit(): void {
	const input = $<HTMLTextAreaElement>("input");
	const text = input.value.trim();
	if (!text || ws?.readyState !== WebSocket.OPEN) return;
	const steer = $<HTMLInputElement>("steer").checked;
	send({ type: "submit", requestId: crypto.randomUUID(), text, mode: steer ? "steer" : "followUp" });
	input.value = "";
	$<HTMLInputElement>("steer").checked = false;
	if (showing !== "main") show("main");
}

function onMessage(message: ServerMessage): void {
	switch (message.type) {
		case "welcome":
			session = message.session;
			me = message.me;
			setMembers(message.members);
			document.title = `${session.name} · syncpi`;
			$("session-name").textContent = session.name;
			renderSide();
			return;
		case "events":
			threads[message.conv].apply(message.events);
			if (message.conv === showing) renderThread();
			return;
		case "presence":
			online = message.online;
			setMembers(message.members);
			renderPeople();
			renderSide();
			return;
		case "env":
			env = message.env;
			renderSide();
			return;
		case "invite": {
			const i = message.invite;
			$("share-who").textContent = i.email ? `Only ${i.email} can use this link, after signing in with exe.dev. They join as ${i.role}.` : `Anyone with this link can join as ${i.role}${i.expiresAt ? ` until ${new Date(i.expiresAt).toLocaleDateString()}` : ""}.`;
			$<HTMLInputElement>("share-url").value = message.url;
			$("share-cli").textContent = `syncpi --url ${message.url}`;
			$<HTMLDialogElement>("share-dialog").showModal();
			send({ type: "invites" });
			return;
		}
		case "invites":
			invites = message.invites;
			renderSide();
			return;
		case "error":
			$("status").textContent = `error: ${message.message}`;
			return;
		default:
			return;
	}
}

function show(conv: ConvName): void {
	showing = conv;
	$("tab-main").setAttribute("aria-selected", String(conv === "main"));
	$("tab-setup").setAttribute("aria-selected", String(conv === "setup"));
	$("thread").replaceChildren();
	rendered.length = 0;
	$("composer").hidden = conv !== "main" || me?.role === "viewer";
	renderThread();
}

function itemElement(item: Item): HTMLElement {
	switch (item.kind) {
		case "user": {
			const el = document.createElement("div");
			el.className = "msg user";
			const name = (item.memberId ? names.get(item.memberId) : undefined) ?? item.author ?? "someone";
			el.style.setProperty("--c", personColor(name));
			el.innerHTML = `<div class="who">${escapeHtml(name)}</div><div class="body">${escapeHtml(item.text)}</div>`;
			return el;
		}
		case "assistant": {
			const el = document.createElement("div");
			el.className = "msg assistant";
			const thinking = item.thinking && !item.text ? `<div class="thinking">thinking… ${escapeHtml(item.thinking.slice(-300))}</div>` : "";
			const error = item.error ? `<div class="err">${escapeHtml(item.error)}</div>` : "";
			el.innerHTML = `${thinking}<div class="body">${marked.parse(item.text, { async: false })}</div>${error}`;
			return el;
		}
		case "tool": {
			const el = document.createElement("details");
			el.className = `tool ${item.status}`;
			const icon = item.status === "running" ? "◌" : item.status === "done" ? "✓" : item.status === "error" ? "✗" : "○";
			const output = item.output.trimEnd();
			el.innerHTML = `<summary><span class="st">${icon}</span><span class="name">${escapeHtml(item.name)}</span><span class="arg">${escapeHtml(toolSummary(item))}</span></summary>${output ? `<pre>${escapeHtml(output.slice(-20_000))}</pre>` : ""}`;
			if (item.status === "running" || item.status === "error") el.open = true;
			return el;
		}
		case "notice": {
			const el = document.createElement("div");
			el.className = "notice";
			el.textContent = `— ${item.text}`;
			return el;
		}
	}
}

function renderThread(): void {
	const box = $("thread");
	const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
	const items = threads[showing].state.items;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const have = rendered[i];
		if (have !== undefined && have.key === item.key && have.rev === item.rev) continue;
		const el = itemElement(item);
		// Keep a tool's open/closed state when it updates.
		if (have !== undefined && have.el instanceof HTMLDetailsElement && el instanceof HTMLDetailsElement && have.key === item.key && item.kind === "tool" && item.status !== "running") el.open = have.el.open;
		if (have === undefined) box.append(el);
		else have.el.replaceWith(el);
		rendered[i] = { key: item.key, rev: item.rev, el };
	}
	for (const extra of rendered.splice(items.length)) extra.el.remove();
	if (follow) box.scrollTop = box.scrollHeight;

	const s = threads[showing].state;
	const parts: string[] = [];
	if (s.retry) parts.push(`retrying: ${s.retry}`);
	else if (s.busy) parts.push("working…");
	if (s.queued > 0) parts.push(`${s.queued} queued`);
	if (s.cost > 0) parts.push(`$${s.cost.toFixed(2)}`);
	if (s.model) parts.push(s.model);
	$("status").textContent = parts.join(" · ");
	$("stop").hidden = !(showing === "main" && threads.main.state.busy);
}

function renderPeople(): void {
	const box = $("people");
	box.replaceChildren();
	const seen = new Map<string, Presence[]>();
	for (const p of online) seen.set(p.memberId, [...(seen.get(p.memberId) ?? []), p]);
	for (const [, list] of seen) {
		const el = document.createElement("span");
		el.className = "person";
		el.style.setProperty("--c", personColor(list[0]!.name));
		el.textContent = list[0]!.name;
		el.title = `${list[0]!.name} · ${[...new Set(list.map((p) => p.client))].join(", ")}`;
		box.append(el);
	}
}

function renderSide(): void {
	const envBox = $("env");
	const label = { pending: "Waiting to start", running: "Setting up", ready: "Ready", failed: "Setup failed" }[env.status];
	envBox.innerHTML = `<div><strong>${label}</strong></div>${env.activity ? `<div class="muted">${escapeHtml(env.activity)}</div>` : ""}${env.error ? `<div class="error">${escapeHtml(env.error)}</div>` : ""}${env.summary ? `<pre>${escapeHtml(env.summary)}</pre>` : ""}`;
	$("env-dot").className = `dot ${env.status}`;

	const onlineIds = new Set(online.map((p) => p.memberId));
	const admin = me?.role === "admin";
	$("members").innerHTML = members
		.map((m) => {
			const dot = `<span class="${onlineIds.has(m.id) ? "on" : "off"}">●</span>`;
			const who = `<span class="who">${escapeHtml(m.name)}${m.id === me?.id ? ' <span class="muted">(you)</span>' : ""}${m.email ? `<br><span class="muted">${escapeHtml(m.email)}</span>` : ""}</span>`;
			if (!admin || m.creator) return `<li>${dot}${who}<span class="muted">${m.creator ? "admin · created it" : m.role}</span></li>`;
			const options = ["admin", "editor", "viewer"].map((r) => `<option${r === m.role ? " selected" : ""}>${r}</option>`).join("");
			return `<li>${dot}${who}<select data-member="${escapeHtml(m.id)}" aria-label="Role of ${escapeHtml(m.name)}">${options}</select><button type="button" data-remove="${escapeHtml(m.id)}" aria-label="Remove ${escapeHtml(m.name)}">Remove</button></li>`;
		})
		.join("");
	$("invites").innerHTML =
		invites
			.map(
				(i) =>
					`<li><span class="who">${escapeHtml(i.email ?? "link")} <span class="muted">· ${i.role} · used ${i.uses}${i.expiresAt ? ` · until ${new Date(i.expiresAt).toLocaleDateString()}` : ""}</span></span><button type="button" data-revoke="${escapeHtml(i.code)}">Revoke</button></li>`,
			)
			.join("") || '<li class="muted">none</li>';

	if (session !== undefined) {
		const rows: [string, string][] = [
			["Project", session.workdir],
			["Model", session.model],
		];
		if (session.vm) rows.push(["VM", `${session.vm}.exe.xyz`]);
		$("info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
	}
}

void boot();
