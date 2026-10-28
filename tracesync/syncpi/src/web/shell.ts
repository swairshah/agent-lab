// The app's window: threads in a sidebar, grouped by project, and the open thread's web view beside it. Each
// thread is the same page a browser gets (main.ts), served by the app's local host (src/desktop/host.ts) in an
// iframe of this origin; threads opened recently stay loaded, so switching back is instant.
//
// The shell owns what spans threads: the sidebar, making and joining threads, the thread commands (rename, pin,
// archive, …), the project commands (reveal, sync, …) and the text size. A thread's page runs everything else and
// hands the shell's commands up through `window.syncpiShell`. In the desktop app (Tauri) the shell also reaches the
// system: folder picker, opening links, quitting.
import { commandsFor, matchesKeys } from "../shared/keymap.ts";
import { $, el, escapeHtml, initials, personColor, storage } from "./dom.ts";
import { Palette, type ThreadRow } from "./palette.ts";
import { applyZoom, dragWindow, type Shell, SHELL_COMMANDS, zoomBy } from "./shell-api.ts";
import { Inbox, type InboxItem } from "./inbox.ts";

type Thread = {
	id: string;
	name: string;
	dir: string;
	url: string;
	compute: string;
	vm?: string;
	role: string;
	createdAt: number;
	status?: string;
	step?: string;
	error?: string;
	title?: string;
	pinned?: boolean;
	bookmarked?: boolean;
	archived?: boolean;
	tags?: string[];
	lastOpened?: number;
	sync?: { pushed: number; pulled: number; conflicts: string[]; error: string };
};
type Catalog = { sessions: Thread[]; identity: { name: string }; defaults: { model?: string; thinkingLevel?: string }; login?: { url: string; check: string } };

declare global {
	interface Window {
		__TAURI__?: {
			core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
			dialog?: { open(options: Record<string, unknown>): Promise<string | string[] | null> };
			opener?: { openUrl(url: string): Promise<void> };
			notification?: { isPermissionGranted(): Promise<boolean>; requestPermission(): Promise<string>; sendNotification(options: { title: string; body?: string }): void };
		};
		syncpiShell?: Shell;
		syncpiCommand?: (id: string) => void;
	}
}

const tauri = window.__TAURI__;
let catalog: Catalog = { sessions: [], identity: { name: "" }, defaults: {} };
let active = storage.get("syncpi-active") ?? "";
let archives = false;
/** The project new threads go to when one was picked in the sidebar. */
let project = "";
const busy = new Map<string, boolean>();
const frames = new Map<string, HTMLIFrameElement>();
const KEEP = 6;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, tone: "info" | "error" = "info"): void {
	const box = $("toast");
	box.textContent = text;
	box.dataset.tone = tone;
	box.hidden = false;
	if (toastTimer !== undefined) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (box.hidden = true), 6_000);
}

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

function openUrl(url: string): void {
	if (tauri?.opener) void tauri.opener.openUrl(url);
	else window.open(url, "_blank", "noopener");
}

const project_name = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;
const titleOf = (t: Thread) => t.title?.trim() || "New thread";
const selected = () => catalog.sessions.find((t) => t.id === active);

/** Threads by project, projects by their latest thread; pinned threads first, then the latest. */
function grouped(): { dir: string; threads: Thread[] }[] {
	const recent = (t: Thread) => t.lastOpened ?? t.createdAt;
	const shown = catalog.sessions.filter((t) => Boolean(t.archived) === archives);
	const byDir = new Map<string, Thread[]>();
	for (const t of shown) byDir.set(t.dir, [...(byDir.get(t.dir) ?? []), t]);
	return [...byDir.entries()]
		.map(([dir, threads]) => ({ dir, threads: threads.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || recent(b) - recent(a)) }))
		.sort((a, b) => Math.max(...b.threads.map(recent)) - Math.max(...a.threads.map(recent)));
}

/** Threads in sidebar order, for ⌘⇧] and ⌘⇧[. */
const order = () => grouped().flatMap((g) => g.threads.map((t) => t.id));

const ICONS = {
	folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14.5V6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h5.2A1.5 1.5 0 0 1 16 7.8V9"/><path d="M3 14.5 5 9.5h12.5l-2 5.3a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 14.5z"/></svg>',
	plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>',
	pin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3.5h4l-.5 4 3 3v1.5h-9V10.5l3-3z"/><path d="M10 12v4.5"/></svg>',
	failed: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v4M10 13.5v.01"/></svg>',
};

function renderSidebar(): void {
	const list = $("sidebar-list");
	list.replaceChildren();
	const groups = grouped();
	const unreadThreads = new Set(inbox.unread(inboxItems).map((i) => i.thread));
	list.append(el("div", "sidebar-label", archives ? "Archived" : "Projects"));
	if (groups.length === 0) list.append(el("p", "sidebar-empty muted", archives ? "No archived threads." : "No threads yet."));
	for (const group of groups) {
		const head = el("div", "sidebar-project");
		head.dataset.dir = group.dir;
		head.title = group.dir;
		head.setAttribute("aria-current", String(project === group.dir));
		head.innerHTML = `${ICONS.folder}<span class="sidebar-name">${escapeHtml(project_name(group.dir))}</span><button type="button" class="icon-button small sidebar-add" title="New thread in this project" aria-label="New thread in ${escapeHtml(project_name(group.dir))}">${ICONS.plus}</button>`;
		list.append(head);
		for (const t of group.threads) {
			const row = el("button", "sidebar-thread");
			row.type = "button";
			row.dataset.id = t.id;
			row.setAttribute("aria-current", String(t.id === active));
			const state = t.status === "failed" ? `<span class="thread-state failed" title="${escapeHtml(t.error ?? "Setup failed")}">${ICONS.failed}</span>` : t.status === "provisioning" || busy.get(t.id) ? '<span class="thread-state spinner" aria-label="Working"></span>' : "";
			const tags = (t.tags ?? []).map((tag) => `<span class="thread-tag">${escapeHtml(tag)}</span>`).join("");
			const unread = unreadThreads.has(t.id) ? '<span class="thread-unread" title="Unread mentions"></span>' : "";
			row.innerHTML = `<span class="sidebar-name">${escapeHtml(titleOf(t))}</span>${unread}${tags}${t.pinned ? `<span class="thread-pin" title="Pinned">${ICONS.pin}</span>` : ""}${state}`;
			list.append(row);
		}
	}
	$("archive-toggle").setAttribute("aria-pressed", String(archives));
	const name = catalog.identity.name;
	$("me").innerHTML = `<span class="avatar" style="--person:${personColor(name)}">${escapeHtml(initials(name))}</span><span>${escapeHtml(name)}</span>`;
}

/** Shows the thread: its page (loaded once, kept while recent), or how its setup is going. */
function show(id: string): void {
	const t = catalog.sessions.find((s) => s.id === id);
	if (t === undefined) {
		active = "";
		for (const frame of frames.values()) hide(frame);
		$("preparing").hidden = true;
		$("empty").hidden = false;
		renderSidebar();
		return;
	}
	active = id;
	storage.set("syncpi-active", id);
	$("empty").hidden = true;
	const ready = t.status === undefined || t.status === "ready";
	$("preparing").hidden = ready;
	if (!ready) {
		$("preparing-project").textContent = project_name(t.dir);
		$("preparing-title").textContent = t.status === "failed" ? "Setup failed" : "Preparing the thread";
		$("preparing-step").textContent = t.status === "failed" ? "" : (t.step ?? "Starting");
		$("preparing-error").textContent = t.status === "failed" ? (t.error ?? "") : "";
		$("preparing-retry").hidden = t.status !== "failed" || t.role !== "owner";
	}
	for (const [fid, frame] of frames) {
		if (fid !== id || !ready) hide(frame);
		else frame.hidden = false;
	}
	if (ready && !frames.has(id)) {
		const frame = el("iframe", "session-frame");
		frame.addEventListener("load", () => controls(frame));
		frame.src = `/session/${id}/`;
		frame.title = titleOf(t);
		$("frames").append(frame);
		frames.set(id, frame);
		// Recent threads stay loaded; the oldest goes.
		if (frames.size > KEEP) {
			const [oldest] = [...frames.keys()].filter((f) => f !== id);
			frames.get(oldest!)?.remove();
			frames.delete(oldest!);
		}
	} else if (ready) {
		// Most recently shown last, so the oldest is first to go.
		const frame = frames.get(id)!;
		frames.delete(id);
		frames.set(id, frame);
	}
	if (ready) frames.get(id)?.contentWindow?.focus();
	renderSidebar();
}

/** With the sidebar hidden, a thread's top bar starts after the window's traffic lights. */
function controls(frame: HTMLIFrameElement): void {
	frame.contentDocument?.documentElement.classList.toggle("window-controls", document.body.classList.contains("sidebar-hidden"));
}

// ---------- the inbox: mentions of you in every thread ----------

let inboxItems: InboxItem[] = [];

/** Opens a thread at a message: once its page is up and has the message, it scrolls there and flashes it. */
function reveal(thread: string, key: string): void {
	show(thread);
	const started = Date.now();
	const attempt = () => {
		const page = frames.get(thread)?.contentWindow as (Window & { syncpiReveal?: (key: string) => boolean }) | null | undefined;
		if (page?.syncpiReveal?.(key)) return;
		if (Date.now() - started < 10_000) setTimeout(attempt, 250);
		else toast("That message is no longer in the thread.");
	};
	attempt();
}

const inbox = new Inbox({ load: () => inboxItems, open: (item) => reveal(item.thread, item.key), many: true });

/** A new mention: a toast here, and a notification from the system when the app isn't in front. */
async function announce(item: InboxItem): Promise<void> {
	const what = item.draft !== undefined ? "tagged you in a draft" : "mentioned you";
	toast(`${item.author} ${what} in ${item.threadTitle}`);
	const notes = tauri?.notification;
	if (notes === undefined || document.hasFocus()) return;
	if (!(await notes.isPermissionGranted()) && (await notes.requestPermission()) !== "granted") return;
	notes.sendNotification({ title: `${item.author} ${what}`, body: `${item.threadTitle}: ${item.text.split("\n")[0]!.slice(0, 140)}` });
}

async function pollInbox(): Promise<void> {
	const data = await api<{ items: InboxItem[] }>("/api/inbox").catch(() => undefined);
	if (data === undefined) return;
	const before = JSON.stringify(inboxItems.map((i) => [i.thread, i.key, i.comment]));
	inboxItems = data.items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
	for (const item of inbox.fresh(inboxItems)) void announce(item);
	const unread = inbox.unread(inboxItems).length;
	$("inbox-badge").textContent = unread > 0 ? String(unread) : "";
	if (JSON.stringify(inboxItems.map((i) => [i.thread, i.key, i.comment])) !== before) renderSidebar();
	inbox.update();
}

/** Puts a thread's page away: hidden, and with nothing of its own left open (Find). */
function hide(frame: HTMLIFrameElement): void {
	if (!frame.hidden) (frame.contentWindow as (Window & { syncpiHidden?: () => void }) | null)?.syncpiHidden?.();
	frame.hidden = true;
}

/** Runs a command in the open thread's page (only that one: hidden threads' pages are left alone). `from` says the
 *  sidebar had focus, for commands that care (Find is then the conversation's). */
function inThread(id: string, from?: "sidebar"): boolean {
	const page = frames.get(active)?.contentWindow as (Window & { syncpiRun?: (id: string, from?: "sidebar") => boolean }) | null | undefined;
	if (page?.syncpiRun === undefined) return false;
	page.focus();
	return page.syncpiRun(id, from);
}

async function refresh(): Promise<void> {
	const next = await api<Catalog>("/api/sessions").catch(() => undefined);
	if (next === undefined) return;
	const before = JSON.stringify(catalog.sessions.map((t) => [t.id, t.status, t.step, t.title, t.pinned, t.archived, t.tags, t.dir, t.lastOpened]));
	const status = selected()?.status;
	catalog = next;
	if (JSON.stringify(catalog.sessions.map((t) => [t.id, t.status, t.step, t.title, t.pinned, t.archived, t.tags, t.dir, t.lastOpened])) !== before) renderSidebar();
	// A thread whose setup just finished (or failed) shows as it is now.
	if (selected()?.status !== status || (active && !selected())) show(active);
	if (catalog.login) showLogin(catalog.login);
}

// ---------- making and joining threads ----------

function dialog(id: string): HTMLDialogElement {
	return $<HTMLDialogElement>(id);
}

async function chooseFolder(): Promise<string | undefined> {
	if (tauri?.dialog) {
		const picked = await tauri.dialog.open({ directory: true, multiple: false, title: "Open a project" });
		return typeof picked === "string" ? picked : undefined;
	}
	return prompt("Project folder")?.trim() || undefined;
}

/** ⌘O: pick a folder, then say where the thread runs and with which model. */
async function openProject(dir?: string): Promise<void> {
	const folder = dir ?? (await chooseFolder());
	if (!folder) return;
	$<HTMLInputElement>("create-dir").value = folder;
	$<HTMLInputElement>("create-model").value = catalog.defaults.model ?? "";
	$<HTMLSelectElement>("create-thinking").value = catalog.defaults.thinkingLevel ?? "medium";
	$("create-error").textContent = "";
	updateCreate();
	dialog("create-dialog").showModal();
}

function updateCreate(): void {
	$("create-vm-field").hidden = $<HTMLSelectElement>("create-compute").value !== "host";
}

async function create(input: { dir: string; compute: string; model?: string; thinkingLevel?: string; vm?: string }): Promise<void> {
	toast("Starting a thread…");
	const { id } = await api<{ id: string }>("/api/sessions", { title: "", setupModel: "", ...input });
	await refresh();
	project = input.dir;
	show(id);
}

/** ⌘N: a thread in the current project straight away, run where the open thread runs, as in Delta. */
function newThread(dir = project || selected()?.dir || ""): void {
	if (!dir) return void openProject();
	const current = selected();
	const same = current?.dir === dir;
	void create({ dir, compute: same && current?.compute === "host" ? "host" : "local", vm: same ? current?.vm : undefined, model: catalog.defaults.model, thinkingLevel: catalog.defaults.thinkingLevel }).catch((e) => toast((e as Error).message, "error"));
}

function showLogin(login: { url: string; check: string }): void {
	const box = $("join-login");
	box.hidden = false;
	box.innerHTML = `Sign in to join: <a href="#" id="join-login-link">open the sign-in page</a> and check it shows <strong class="mono">${escapeHtml(login.check)}</strong>.`;
	$("join-login-link").addEventListener("click", (event) => {
		event.preventDefault();
		openUrl(login.url);
	});
}

function join(url = ""): void {
	$<HTMLInputElement>("join-url").value = url;
	$<HTMLInputElement>("join-as").value = storage.get("syncpi-name") ?? catalog.identity.name;
	$("join-error").textContent = "";
	$("join-login").hidden = true;
	dialog("join-dialog").showModal();
}

/** A one-field dialog: rename, tags, preview. */
function ask(title: string, label: string, value: string, ok: string, hint: string, done: (value: string) => void): void {
	$("text-title").textContent = title;
	$("text-label").textContent = label;
	$("text-hint").textContent = hint;
	$("text-ok").textContent = ok;
	const input = $<HTMLInputElement>("text-input");
	input.value = value;
	const form = $<HTMLFormElement>("text-form");
	form.onsubmit = (event) => {
		event.preventDefault();
		dialog("text-dialog").close();
		done(input.value.trim());
	};
	dialog("text-dialog").showModal();
	input.select();
}

// ---------- thread and project commands ----------

async function decorate(id: string, patch: Record<string, unknown>): Promise<void> {
	await api(`/api/sessions/${id}/decorate`, patch).catch((e) => toast((e as Error).message, "error"));
	await refresh();
}

function threadAction(action: string, id = active): void {
	const t = catalog.sessions.find((s) => s.id === id);
	if (t === undefined) return toast("Open a thread first.");
	const verb = (name: string, body: unknown = {}) => api(`/api/sessions/${id}/${name}`, body);
	const fail = (e: unknown) => toast((e as Error).message, "error");
	switch (action) {
		case "rename":
			return ask("Rename thread", "Title", titleOf(t), "Rename", "", (title) => title && void decorate(id, { title }));
		case "title":
			toast("Generating a title…");
			return void verb("title").then(() => refresh(), fail);
		case "pin":
			return void decorate(id, { pinned: !t.pinned });
		case "bookmark":
			toast(t.bookmarked ? "Bookmark removed" : "Bookmarked");
			return void decorate(id, { bookmarked: !t.bookmarked });
		case "archive":
			if (!t.archived && id === active) {
				const next = order().find((o) => o !== id);
				void decorate(id, { archived: true }).then(() => show(next ?? ""));
				return;
			}
			return void decorate(id, { archived: !t.archived });
		case "tags":
			return ask("Tags", "Tags, separated by commas", (t.tags ?? []).join(", "), "Save", "", (text) => void decorate(id, { tags: text.split(",").map((s) => s.trim()).filter(Boolean) }));
		case "share":
			if (id !== active) show(id);
			return void inThread("thread.share");
		case "web":
			return void api<{ url: string }>(`/api/sessions/${id}/weblink`).then((r) => openUrl(r.url), fail);
		case "reveal":
		case "zed":
			return void verb("reveal", { editor: action === "zed" }).catch(fail);
		case "sync":
			toast("Syncing…");
			return void verb("sync").then(() => toast("Project synchronized"), fail);
		case "update":
			toast("Updating the server…");
			return void verb("update").then(() => toast("Server updated"), fail);
		case "preview":
			return ask("Preview", "Address", storage.get("syncpi-preview") ?? "http://localhost:3000", "Open", "Opens in your browser.", (url) => {
				if (!/^https?:\/\//.test(url)) return toast("Use an http:// or https:// address.", "error");
				storage.set("syncpi-preview", url);
				openUrl(url);
			});
	}
}

function step(by: number): void {
	const ids = order();
	if (ids.length === 0) return;
	const at = ids.indexOf(active);
	show(ids[at < 0 ? 0 : (at + by + ids.length) % ids.length]!);
}

/** What the shell does for each command it owns (shell-api.ts lists them). The rest belong to the thread's page. */
const commands: Record<string, () => void> = {
	"palette.all": () => inThread("palette.all") || palette.open("all"),
	"palette.commands": () => inThread("palette.commands") || palette.open("commands"),
	"palette.files": () => inThread("palette.files") || palette.open("files"),
	"palette.threads": () => inThread("palette.threads") || palette.open("threads"),
	// Find belongs to the open thread; with none open there's nothing to find in.
	"find.open": () => inThread("find.open", "sidebar"),
	"find.next": () => inThread("find.next", "sidebar"),
	"find.previous": () => inThread("find.previous", "sidebar"),
	"inbox.toggle": () => {
		inbox.toggle();
		// Reading marks: the badge and dots follow when it closes.
		$("inbox").addEventListener("close", () => void pollInbox(), { once: true });
	},
	"thread.new": () => newThread(),
	"project.add": () => void openProject(),
	"thread.join": () => join(),
	"thread.next": () => step(1),
	"thread.previous": () => step(-1),
	"thread.rename": () => threadAction("rename"),
	"thread.title": () => threadAction("title"),
	"thread.pin": () => threadAction("pin"),
	"thread.archive": () => threadAction("archive"),
	"thread.bookmark": () => threadAction("bookmark"),
	"thread.tags": () => threadAction("tags"),
	"thread.archives": () => {
		archives = !archives;
		renderSidebar();
	},
	"view.sidebar": () => {
		const hidden = document.body.classList.toggle("sidebar-hidden");
		storage.set("syncpi-sidebar", hidden ? "hidden" : "shown");
		for (const frame of frames.values()) controls(frame);
	},
	"app.zoomIn": () => zoomBy(0.1),
	"app.zoomOut": () => zoomBy(-0.1),
	"app.zoomReset": () => zoomBy(0),
	"app.theme": () => {
		const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
		setTheme(dark ? "light" : "dark");
	},
	"app.quit": () => void tauri?.core.invoke("quit"),
	"project.sync": () => threadAction("sync"),
	"project.reveal": () => threadAction("reveal"),
	"project.zed": () => threadAction("zed"),
	"project.web": () => threadAction("web"),
	"project.preview": () => threadAction("preview"),
	"project.update": () => threadAction("update"),
};

// The theme is shared with every thread's page (same origin, same storage); each applies it on change.
function setTheme(theme: string): void {
	storage.set("syncpi-theme", theme);
	applyTheme(theme);
	for (const frame of frames.values()) (frame.contentWindow as (Window & { syncpiTheme?: (t: string) => void }) | null)?.syncpiTheme?.(theme);
}
function applyTheme(theme: string | undefined): void {
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
}

const threadRows = (): ThreadRow[] =>
	grouped().flatMap((g) => g.threads.map((t) => ({ id: t.id, title: titleOf(t), project: project_name(t.dir), current: t.id === active })));

// The shell's own palette shows when no thread is open, where there's nothing to find in.
const palette = new Palette({ app: "desktop", handlers: Object.fromEntries(Object.entries(commands).filter(([id]) => !id.startsWith("find."))), files: () => [], openFile: () => {}, threads: threadRows, openThread: show });

window.syncpiShell = {
	command(id: string): boolean {
		if (!(SHELL_COMMANDS as readonly string[]).includes(id) || commands[id] === undefined) return false;
		commands[id]!();
		return true;
	},
	threads: threadRows,
	open: show,
	session: (id: string) => catalog.sessions.find((t) => t.id === id),
	activity(id: string, working: boolean) {
		if (busy.get(id) === working) return;
		busy.set(id, working);
		renderSidebar();
	},
	titled(id: string, title: string) {
		const t = catalog.sessions.find((s) => s.id === id);
		// A new thread is named after its first message at once, then gets a short title written from it, as in Delta.
		if (t && (!t.title?.trim() || t.title === "New thread")) {
			void decorate(id, { title });
			void api(`/api/sessions/${id}/title`, {}).then(refresh, () => {});
		}
	},
	openUrl,
	toast,
};
// The app's menu runs commands here: the shell's own, or the open thread's.
window.syncpiCommand = (id: string) => {
	if (!window.syncpiShell!.command(id)) inThread(id);
};

// ---------- wiring ----------

function wire(): void {
	applyTheme(storage.get("syncpi-theme"));
	applyZoom(document);
	dragWindow($("sidebar").querySelector<HTMLElement>(".sidebar-head")!);
	if (storage.get("syncpi-sidebar") === "hidden") document.body.classList.add("sidebar-hidden");
	addEventListener("storage", (event) => {
		if (event.key === "syncpi-theme") applyTheme(event.newValue ?? undefined);
		if (event.key === "syncpi-zoom") applyZoom(document);
	});

	$("sidebar-list").addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		const add = target.closest(".sidebar-add");
		const head = target.closest<HTMLElement>(".sidebar-project");
		const row = target.closest<HTMLElement>(".sidebar-thread");
		if (add && head) return newThread(head.dataset.dir);
		if (head) {
			project = project === head.dataset.dir ? "" : head.dataset.dir!;
			return renderSidebar();
		}
		if (row) show(row.dataset.id!);
	});
	$("sidebar-list").addEventListener("contextmenu", (event) => {
		const row = (event.target as HTMLElement).closest<HTMLElement>(".sidebar-thread");
		if (!row) return;
		event.preventDefault();
		menu(row.dataset.id!, event.clientX, event.clientY);
	});
	addEventListener("click", () => ($("context-menu").hidden = true));
	addEventListener("blur", () => ($("context-menu").hidden = true));
	$("sidebar-new").addEventListener("click", () => newThread());
	$("sidebar-search").addEventListener("click", () => commands["palette.threads"]!());
	$("sidebar-inbox").addEventListener("click", () => commands["inbox.toggle"]!());
	$("archive-toggle").addEventListener("click", () => commands["thread.archives"]!());
	$("theme-toggle").addEventListener("click", () => commands["app.theme"]!());
	$("empty-open").addEventListener("click", () => void openProject());
	$("empty-join").addEventListener("click", () => join());
	$("preparing-retry").addEventListener("click", () => void api(`/api/sessions/${active}/retry`, {}).then(refresh, (e) => toast((e as Error).message, "error")));

	for (const d of document.querySelectorAll<HTMLDialogElement>("dialog.form-dialog")) d.querySelector("[data-close]")?.addEventListener("click", () => d.close());
	$("create-compute").addEventListener("change", updateCreate);
	$("create-choose").addEventListener("click", async () => {
		const folder = await chooseFolder();
		if (folder) $<HTMLInputElement>("create-dir").value = folder;
	});
	$("create-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const compute = $<HTMLSelectElement>("create-compute").value;
		const input = {
			dir: $<HTMLInputElement>("create-dir").value.trim(),
			compute,
			vm: compute === "host" ? $<HTMLInputElement>("create-vm").value.trim() || undefined : undefined,
			model: $<HTMLInputElement>("create-model").value.trim() || undefined,
			thinkingLevel: $<HTMLSelectElement>("create-thinking").value,
		};
		create(input).then(
			() => dialog("create-dialog").close(),
			(e) => ($("create-error").textContent = (e as Error).message),
		);
	});
	$("join-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const name = $<HTMLInputElement>("join-as").value.trim();
		if (name) storage.set("syncpi-name", name);
		$("join-error").textContent = "";
		api<{ id: string }>("/api/join", { url: $<HTMLInputElement>("join-url").value.trim(), name }).then(
			async ({ id }) => {
				dialog("join-dialog").close();
				await refresh();
				show(id);
			},
			(e) => ($("join-error").textContent = (e as Error).message),
		);
	});

	// Threads' pages report what they're doing.
	addEventListener("message", (event) => {
		if (event.origin !== location.origin) return;
		const data = event.data as { type?: string; event?: string; busy?: boolean; title?: string; action?: string };
		const id = [...frames.entries()].find(([, f]) => f.contentWindow === event.source)?.[0];
		if (data?.type !== "syncpi" || id === undefined) return;
		if (data.event === "activity") window.syncpiShell!.activity(id, Boolean(data.busy));
		if (data.event === "title" && data.title) window.syncpiShell!.titled(id, data.title);
	});

	// Shortcuts while the shell itself has focus (the sidebar, or no thread open).
	const keys = commandsFor("desktop").filter((c) => c.keys && commands[c.id]);
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || document.querySelector("dialog[open]:not(#palette):not(#inbox)")) return;
		if (event.isComposing) return;
		const command = keys.find((c) => matchesKeys(event, c.keys!));
		if (command === undefined) return;
		// A command that doesn't apply (Find with no thread open) leaves the key alone.
		if ((commands[command.id]! as () => unknown)() === false) return;
		event.preventDefault();
	});
}

function menu(id: string, x: number, y: number): void {
	const t = catalog.sessions.find((s) => s.id === id);
	if (t === undefined) return;
	const items: [string, () => void][] = [
		["Share", () => threadAction("share", id)],
		[t.pinned ? "Unpin" : "Pin", () => threadAction("pin", id)],
		["Rename", () => threadAction("rename", id)],
		["Regenerate title", () => threadAction("title", id)],
		["Tags", () => threadAction("tags", id)],
		["Open in browser", () => threadAction("web", id)],
		["Reveal in Finder", () => threadAction("reveal", id)],
		["Open in Zed", () => threadAction("zed", id)],
		[t.archived ? "Unarchive" : "Archive", () => threadAction("archive", id)],
	];
	const box = $("context-menu");
	box.replaceChildren(
		...items.map(([label, run]) => {
			const item = el("button", "menu-item", label);
			item.type = "button";
			item.setAttribute("role", "menuitem");
			item.addEventListener("click", () => {
				box.hidden = true;
				run();
			});
			return item;
		}),
	);
	box.hidden = false;
	box.style.left = `${Math.min(x, innerWidth - box.offsetWidth - 8)}px`;
	box.style.top = `${Math.min(y, innerHeight - box.offsetHeight - 8)}px`;
}

wire();
await refresh();
renderSidebar();
show(catalog.sessions.some((t) => t.id === active) ? active : (order()[0] ?? ""));
setInterval(() => void refresh(), 1500);
void pollInbox();
setInterval(() => void pollInbox(), 4000);
