// The desktop conversation renderer. It uses SyncPi's protocol and shared Thread state;
// desktop controls and styling are kept separate from the browser frontend.
import { marked } from "marked";
import { parseInvite } from "../../shared/commands.ts";
import type { ClientMessage, Role } from "../../shared/protocol.ts";
import type { BranchInfo, ConvName, EnvStatus, InviteInfo, Member, Presence, ServerMessage, SessionInfo } from "../../shared/protocol.ts";
import { type Item, Thread, toolSummary } from "../../shared/thread.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** The session's path on this server: "/" for a server of its own, "/<id>/" on a shared host. */
const desktop = document.documentElement.dataset.desktop === "true";
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
let branches: BranchInfo[] = [];
let currentBranch = 0;
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
const outbox = new Map<string, Extract<ClientMessage, { type: "submit" }>>();
try { for (const m of JSON.parse(localStorage.getItem(`outbox:${TOKEN_KEY}`) || "[]")) outbox.set(m.requestId, m); } catch {}
function saveOutbox() { localStorage.setItem(`outbox:${TOKEN_KEY}`, JSON.stringify([...outbox.values()])); }
let retry = 0;
const rendered: { key: string; rev: number; el: HTMLElement }[] = [];

function start(token: string): void {
	$("app").hidden = false;
	connect(token);
    enhance();
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
        for (const m of outbox.values()) send(m);
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
    if (!text) return;
    if (command(text)) { input.value = ""; saveDraft(); return; }
    if (text.startsWith("/") && !desktop) { $("status").textContent = "Unknown command. Type / for commands."; return; }
	const steer = $<HTMLInputElement>("steer").checked;
	const message: Extract<ClientMessage, { type: "submit" }> = { type: "submit", requestId: crypto.randomUUID(), text, mode: steer ? "steer" : "followUp", where: $<HTMLSelectElement>("where").value as "device" | "vm" };
    outbox.set(message.requestId, message); saveOutbox(); send(message);
    if (desktop && threads.main.state.items.filter(i => i.kind === "user").length === 0) parent.postMessage({ type: "syncpi-title", title: text.split("\n")[0]!.slice(0, 75) }, location.origin);
	input.value = ""; saveDraft();
	$<HTMLInputElement>("steer").checked = false;
	if (showing !== "main") show("main");
    renderThread();
}

function onMessage(message: ServerMessage): void {
	switch (message.type) {
        case "accepted": outbox.delete(message.requestId); saveOutbox(); renderThread(); return;
        case "target": $("where").title = `Current run: ${message.label}`; return;
        case "notice": $("status").textContent = message.text; return;
        case "files": fileNames = Object.entries(message.changed).filter(([,hash]) => hash !== null).map(([p]) => p).concat(message.full ? [] : fileNames).filter((p,n,a) => a.indexOf(p) === n && message.changed[p] !== null); return;
		case "welcome":
			session = message.session;
			me = message.me;
            $("compact-button").hidden = me.role === "viewer";
            $("context-button").hidden = me.role !== "admin";
            $("model-button").hidden = me.role !== "admin";
			setMembers(message.members);
			document.title = `${session.name} · syncpi`;
			$("session-name").textContent = session.name;
			renderSide();
			return;
		case "events":
			threads[message.conv].apply(message.events);
			if (message.conv === showing) renderThread();
			return;
		case "history":
			threads[message.conv].prepend(message.entries);
			if (message.conv === showing) {
				$("thread").replaceChildren();
				rendered.length = 0;
				renderThread();
			}
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
		case "branches":
			branches = message.branches;
			currentBranch = message.current;
			renderThread();
			return;
		case "error":
            if (message.requestId) { outbox.delete(message.requestId); saveOutbox(); }
			$("status").textContent = `error: ${message.message}`;
            const rejected = document.createElement("div"); rejected.className = "notice error"; rejected.textContent = message.message; $("thread").append(rejected);
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
			el.innerHTML = `<div class="who"><span class="author-avatar">${escapeHtml(name[0]?.toUpperCase() || "?")}</span>${escapeHtml(name)}</div><div class="body">${escapeHtml(item.text)}</div>`;
            if (me?.role === "admin" && /^\d+$/.test(item.key)) {
                const fork = document.createElement("button"); fork.className = "fork-message"; fork.textContent = "⑂ Edit & fork"; fork.title = "Branch before this message and edit it";
                fork.onclick = () => { send({ type: "fork", before: item.key }); $<HTMLTextAreaElement>("input").value = item.text; saveDraft(); $<HTMLTextAreaElement>("input").focus(); };
                el.append(fork);
            }
			return el;
		}
		case "assistant": {
			const el = document.createElement("div");
			el.className = "msg assistant";
			const thinking = item.thinking ? `<details class="thinking"><summary>${item.streaming ? "Thinking…" : "Thought process"}</summary><pre>${escapeHtml(item.thinking)}</pre></details>` : "";
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
    const q = $<HTMLInputElement>("thread-search").value.toLowerCase();
    if (q) for (const item of rendered) item.el.hidden = !item.el.textContent?.toLowerCase().includes(q);
    else for (const item of rendered) item.el.hidden = false;
    $("branch-button").textContent = `⑂ ${branches.find(b => b.id === currentBranch)?.label || "main"}`;
    if (desktop) parent.postMessage({ type: "syncpi-activity", busy: threads.main.state.busy }, location.origin);
	const parts: string[] = [];
	if (s.retry) parts.push(`retrying: ${s.retry}`);
	else if (s.busy) parts.push("working…");
	if (s.compacting) parts.push("summarizing older messages…");
	if (outbox.size > 0) parts.push(`${outbox.size} awaiting delivery`);
	if (s.queued > 0) parts.push(`${s.queued} queued`);
	if (branches.length > 1) parts.push(branches.find((b) => b.id === currentBranch)?.label ?? "");
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

// Desktop conversation controls and slash commands.
let fileNames: string[] = [];
let promptNames: string[] = [];
const COMMANDS = ['env', 'members', 'session-share', 'invite', 'name', 'role', 'remove', 'links', 'revoke', 'compact', 'new', 'tree', 'steer', 'stop', 'where', 'sync', 'web', 'ssh', 'quit', 'model'];
function saveDraft() { try { localStorage.setItem(`draft:${TOKEN_KEY}`, $<HTMLTextAreaElement>('input').value); } catch {} }
function side() { document.documentElement.classList.toggle('show-people'); }
function branchesDialog() {
    send({ type: 'branches' });
    $('branch-list').innerHTML = branches.map(b => `<button class="branch-row" data-branch="${b.id}" ${me?.role !== 'admin' ? 'disabled' : ''}>${b.id === currentBranch ? '●' : '⑂'} ${escapeHtml(b.label)} <small>${new Date(b.at).toLocaleString()}</small></button>`).join('');
    $('branch-list').onclick = e => { const id = (e.target as HTMLElement).closest<HTMLElement>('[data-branch]')?.dataset.branch; if (id) { send({ type: 'switchBranch', id: Number(id) }); $<HTMLDialogElement>('branches-dialog').close(); } };
    $<HTMLDialogElement>('branches-dialog').showModal();
}
function modelDialog() { void fetch('api/models').then(r => r.json()).then(d => { $('available-models').innerHTML = (d.models || []).map((m: {id: string; name: string}) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join(''); }).catch(() => {}); $<HTMLInputElement>('model-ref').value = threads.main.state.model || session?.model || ''; $<HTMLSelectElement>('model-thinking').value = threads.main.state.thinkingLevel || 'medium'; $<HTMLDialogElement>('model-dialog').showModal(); }
function command(text: string): boolean {
    if (text.startsWith('!') && desktop) { parent.postMessage({ type: 'syncpi-shortcut', action: 'terminal', command: text.slice(1).trim() }, location.origin); return true; }
    if (!text.startsWith('/')) return false;
    const [cmd, ...words] = text.slice(1).split(/\s+/); const arg = words.join(' ');
    const member = (query: string) => members.find(m => m.name === query || m.email === query || m.id === query)?.id || query;
    switch (cmd) {
        case 'env': show('setup'); break;
        case 'members': case 'who': side(); break;
        case 'session-share': send({ type: 'invite' }); break;
        case 'invite': { const i = parseInvite(arg); if (typeof i === 'string') $('status').textContent = i; else send({ type: 'invite', ...i }); break; }
        case 'name': send({ type: 'rename', name: arg }); break;
        case 'role': send({ type: 'setRole', memberId: member(words[0] || ''), role: words[1] as Role }); break;
        case 'remove': send({ type: 'remove', memberId: member(arg) }); break;
        case 'links': send({ type: 'invites' }); side(); break;
        case 'revoke': send({ type: 'revoke', code: arg }); break;
        case 'compact': if (arg) send({ type: 'compact', instructions: arg }); else $<HTMLDialogElement>('compact-dialog').showModal(); break;
        case 'new': $<HTMLDialogElement>('reset-dialog').showModal(); break;
        case 'tree': {
            if (/^b\d+$/.test(arg)) { const b = branches[Number(arg.slice(1))]; if (b) send({ type: 'switchBranch', id: b.id }); }
            else if (/^\d+$/.test(arg)) { const users = threads.main.state.items.filter(i => i.kind === 'user' && /^\d+$/.test(i.key)); const item = users[Number(arg) - 1]; if (item) send({ type: 'fork', before: item.key }); }
            else branchesDialog(); break;
        }
        case 'steer': if (arg) { const m: Extract<ClientMessage, { type: 'submit' }> = { type: 'submit', requestId: crypto.randomUUID(), text: arg, mode: 'steer', where: $<HTMLSelectElement>('where').value as 'device' | 'vm' }; outbox.set(m.requestId, m); saveOutbox(); send(m); } break;
        case 'stop': send({ type: 'abort' }); break;
        case 'where': if (arg === 'vm' || desktop && ['here','device'].includes(arg)) $<HTMLSelectElement>('where').value = arg === 'vm' ? 'vm' : 'device'; else $('status').textContent = desktop ? 'Use /where here or /where vm' : 'Browser requests run on the session VM.'; break;
        case 'model': modelDialog(); break;
        case 'sync': case 'ssh': case 'quit': if (desktop) parent.postMessage({ type: 'syncpi-shortcut', action: cmd === 'ssh' ? 'terminal' : cmd === 'quit' ? 'search' : cmd }, location.origin); else $('status').textContent = 'Open the desktop app for local files and terminals.'; break;
        case 'web': if (session) window.open(`${session.url}/`, '_blank', 'noopener'); break;
        default: return false;
    }
    $('completions').hidden = true; return true;
}
function enhance() {
    const input = $<HTMLTextAreaElement>('input');
    try { input.value = localStorage.getItem(`draft:${TOKEN_KEY}`) || ''; } catch {}
    window.addEventListener('pagehide', saveDraft);
    $<HTMLSelectElement>('where').value = desktop ? 'device' : 'vm';
    if (!desktop) $<HTMLSelectElement>('where').querySelector<HTMLOptionElement>('[value=device]')!.disabled = true;
    if (desktop) {
      const match = BASE.match(/\/session\/([^/]+)/);
      if (match) void fetch(`/api/sessions/${match[1]}/context`).then(r => r.json()).then(d => { promptNames = d.prompts?.map((p: {name: string}) => p.name) || []; }).catch(() => {});
    }
    input.placeholder = '@ for files, / for commands, ! for a terminal. Enter to send.';
    const complete = () => {
      saveDraft();
      const value = input.value.slice(0, input.selectionStart);
      const match = value.match(/(?:^|\s)([@/])([^\s]*)$/);
      if (!match) { $('completions').hidden = true; return; }
      const list = match[1] === '@' ? fileNames : [...COMMANDS, ...promptNames];
      const found = list.filter(n => n.toLowerCase().includes(match[2]!.toLowerCase())).slice(0, 9);
      $('completions').hidden = !found.length;
      $('completions').innerHTML = found.map((n,i) => `<button type="button" role="option" aria-selected="${i === 0}" data-complete="${escapeHtml(n)}">${match[1]}${escapeHtml(n)}</button>`).join('');
    };
    input.addEventListener('input', complete);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (!$('completions').hidden) { $('completions').hidden = true; e.stopImmediatePropagation(); } else send({ type: 'abort' }); }
      if (e.key === 'Tab' && !$('completions').hidden) { e.preventDefault(); $('completions').querySelector<HTMLButtonElement>('button')?.click(); }
      if ((e.metaKey || e.ctrlKey) && ['k','n','p','o'].includes(e.key.toLowerCase()) && desktop) { e.preventDefault(); parent.postMessage({ type: 'syncpi-shortcut', action: ({k:'search',n:'new',p:'files',o:'project'} as Record<string,string>)[e.key.toLowerCase()] }, location.origin); }
    });
    $('completions').onclick = e => {
      const name = (e.target as HTMLElement).closest<HTMLElement>('[data-complete]')?.dataset.complete;
      if (!name) return;
      const before = input.value.slice(0, input.selectionStart); const m = before.match(/([@/])[^\s]*$/); if (!m) return;
      input.setRangeText(`${m[1]}${name} `, before.length - m[0].length, input.selectionStart, 'end'); $('completions').hidden = true; saveDraft(); input.focus();
    };
    $('close-side').onclick = side;
    $('branch-button').onclick = branchesDialog;
    $('compact-button').onclick = () => $<HTMLDialogElement>('compact-dialog').showModal();
    $('context-button').onclick = () => $<HTMLDialogElement>('reset-dialog').showModal();
    $('model-button').onclick = modelDialog;
    $('thread-search').oninput = renderThread;
    $('close-model').onclick = () => $<HTMLDialogElement>('model-dialog').close();
    $('model-form').onsubmit = e => { e.preventDefault(); send({ type: 'configure', model: $<HTMLInputElement>('model-ref').value.trim(), thinkingLevel: $<HTMLSelectElement>('model-thinking').value }); $<HTMLDialogElement>('model-dialog').close(); };
    $('close-compact').onclick = () => $<HTMLDialogElement>('compact-dialog').close();
    $('compact-form').onsubmit = e => { e.preventDefault(); send({ type: 'compact', instructions: $<HTMLTextAreaElement>('compact-instructions').value }); $<HTMLDialogElement>('compact-dialog').close(); };
    $('close-reset').onclick = () => $<HTMLDialogElement>('reset-dialog').close();
    $('reset-form').onsubmit = e => { e.preventDefault(); send({ type: 'new' }); $<HTMLDialogElement>('reset-dialog').close(); };
    window.addEventListener('message', e => {
      if (!desktop || e.origin !== location.origin || e.source !== parent || e.data?.type !== 'syncpi-action') return;
      switch (e.data.action) {
        case 'theme': document.documentElement.dataset.theme = e.data.data; break;
        case 'share': send({ type: 'invite' }); break;
        case 'people': side(); break;
        case 'setup': show(showing === 'setup' ? 'main' : 'setup'); break;
        case 'compact': $<HTMLDialogElement>('compact-dialog').showModal(); break;
        case 'new-context': $<HTMLDialogElement>('reset-dialog').showModal(); break;
        case 'branches': branchesDialog(); break;
        case 'model': modelDialog(); break;
        case 'mention': input.value += `${input.value ? '\n' : ''}@${e.data.data} `; saveDraft(); input.focus(); break;
        case 'regenerate-title': {
          const first = threads.main.state.items.find(i => i.kind === 'user');
          parent.postMessage({ type: 'syncpi-title', force: true, title: first?.kind === 'user' ? first.text.split('\n')[0]!.replace(/^\s*(?:please|can you)\s*/i, '').slice(0,75) : session?.name || 'New thread' }, location.origin); break;
        }
      }
    });
}
