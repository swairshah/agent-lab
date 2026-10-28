// The web view of a session, in a browser or embedded in an app. It speaks the same WebSocket protocol as the
// terminal UI and renders the same Thread state, so every client shows the same thread.
//
//   auth.ts         getting in: owner link, invite, stored token, exe.dev sign-in
//   session.ts      the connection and the session's state, with change notifications
//   thread-view.ts  the conversation, tool calls and inline artifacts
//   artifacts.ts    diffs and code (Pierre), HTML/SVG previews, markdown, images
//   panel.ts        the side panel: Changes and open files in tabs
//   files-tree.ts   the project tree beside it (⇧⌘E)
//   composer.ts     writing, attachments, completion and slash commands
//   settings.ts     settings (⌘,): you, people, branches, environment, session
//   palette.ts      the command palette (⌘K, ⌘⇧P, ⌘P); commands and shortcuts are in src/shared/keymap.json
//   dialogs.ts      share link, keyboard shortcuts and confirmations
//   bridge.ts       talking to an app that embeds this view
import { kindOfPath } from "../shared/artifacts.ts";
import type { LineComment, Where } from "../shared/protocol.ts";
import { commentOnSelection } from "./artifacts.ts";
import { BASE, signIn, TOKEN_KEY } from "./auth.ts";
import { embedded, onHostAction, toHost } from "./bridge.ts";
import { Composer } from "./composer.ts";
import { Dialogs } from "./dialogs.ts";
import { $, escapeHtml, initials, personColor, storage } from "./dom.ts";
import { modelVendor } from "./icons.ts";
import { Palette } from "./palette.ts";
import { QuoteComments } from "./quote-comments.ts";
import { ArtifactPanel } from "./panel.ts";
import { SessionClient } from "./session.ts";
import { Settings } from "./settings.ts";
import { avatarHtml, ThreadView } from "./thread-view.ts";
import { applyZoom, dragWindow, SHELL_COMMANDS, shell } from "./shell-api.ts";
import { Terminals } from "./terminal.ts";
import { Inbox } from "./inbox.ts";
import { mentionsOf } from "../shared/mentions.ts";
import { Git } from "./git.ts";

type Theme = "system" | "light" | "dark";

function applyTheme(theme: Theme): void {
	if (theme === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
	$<HTMLSelectElement>("theme-select").value = theme;
	storage.set("syncpi-theme", theme);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, tone: "info" | "error" = "info"): void {
	const box = $("toast");
	box.textContent = text;
	box.dataset.tone = tone;
	box.hidden = false;
	if (toastTimer !== undefined) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (box.hidden = true), 6_000);
}

async function main(): Promise<void> {
	applyTheme((storage.get("syncpi-theme") as Theme | undefined) ?? "system");
	document.documentElement.classList.toggle("embedded", embedded);
	// In the app: one of its threads, beside the sidebar (shell.ts). The shell runs what spans threads.
	const app = shell();
	const threadId = app ? (BASE.match(/\/session\/([A-Za-z0-9_-]+)\//)?.[1] ?? "") : "";
	if (app) {
		applyZoom(document);
		dragWindow(document.querySelector<HTMLElement>(".topbar")!);
	}
	const token = await signIn();
	$("app").hidden = false;

	const session = new SessionClient(token, TOKEN_KEY);
	const loadImage = async (path: string) => {
		const res = await fetch(`api/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
		return res?.ok ? URL.createObjectURL(await res.blob()) : undefined;
	};
	// A comment on file lines goes to the thread as its own message, as in Delta.
	// A comment on file lines goes to the thread as its own message, as in Delta.
	let where: Where = embedded ? ((storage.get("syncpi-where") as Where | undefined) ?? "device") : "vm";
	// A comment goes out at once, as in Delta, with whatever is written in the composer; it stays inline where it
	// was made (thread-view.ts).
	const sendComment = (comment: LineComment) => {
		if (session.role === "viewer") return toast("Viewers can't comment; ask an admin to make you an editor.", "error");
		session.submit(composer.takeText(), "followUp", where, [], [comment]);
	};
	// A project file as an artifact, for a tab in the panel.
	const loadFile = async (path: string, lines?: string) => {
		const res = await fetch(`api/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
		if (!res?.ok) return undefined;
		const kind = kindOfPath(path);
		const content = kind === "image" ? "" : await res.text();
		return { key: `file:${path}`, kind, title: path, path, content, lang: path.split(".").pop(), source: "file" as const, lines, hash: res.headers.get("x-hash") ?? undefined };
	};
	const panel = new ArtifactPanel(session, loadImage, sendComment, loadFile);
	// Terminals on this machine, in the app.
	const terminals = app ? new Terminals(threadId) : undefined;
	const git = app ? new Git(threadId, sendComment, toast) : undefined;
	$("git-toggle").hidden = git === undefined;
	$("terminal-toggle").hidden = terminals === undefined;
	$("git-toggle").addEventListener("click", () => git?.toggle());
	$("terminal-toggle").addEventListener("click", () => palette.handler("view.terminal")?.());
	const quotes = new QuoteComments($("thread"), sendComment, () => composer.focus());
	// Up from the composer's first line moves the cursor into the thread, as in Delta.
	$("input").addEventListener("keydown", (event) => {
		const input = event.target as HTMLTextAreaElement;
		if (event.key !== "ArrowUp" || event.shiftKey || event.metaKey || event.altKey || event.ctrlKey || !$("completions").hidden) return;
		if (input.value.lastIndexOf("\n", input.selectionStart - 1) !== -1) return;
		if (quotes.cursorToEnd()) event.preventDefault();
	});
	const dialogs = new Dialogs(session);
	// Saving a file edited in the panel, refused if it changed since it was opened (compare-and-swap on its hash).
	panel.onSave = async (path, text, base) => {
		if (session.role === "viewer") {
			toast("Viewers can't change files.", "error");
			return undefined;
		}
		const res = await fetch(`api/file?path=${encodeURIComponent(path)}&base=${encodeURIComponent(base)}`, {
			method: "PUT",
			headers: { authorization: `Bearer ${token}` },
			body: text,
		}).catch(() => undefined);
		if (res?.status === 409) {
			toast(`${path} changed since you opened it. Reopen it to see the change, then edit again.`, "error");
			return undefined;
		}
		if (!res?.ok) {
			toast(`Couldn't save ${path}.`, "error");
			return undefined;
		}
		toast(`Saved ${path}; it syncs to everyone's copy.`);
		return ((await res.json()) as { hash: string }).hash;
	};

	let showing: "main" | "setup" = "main";
		const setWhere = (next: Where) => {
		where = embedded ? next : "vm";
		storage.set("syncpi-where", where);
		$<HTMLSelectElement>("where").value = where;
		$("where-label").textContent = where === "device" ? "Runs on this machine" : "Runs on the session VM";
	};
	const fork = (key: string, text: string) => {
		session.send({ type: "fork", before: key });
		composer.setText(text);
	};
	const show = (conv: "main" | "setup") => {
		showing = conv;
		$("setup-banner").hidden = conv !== "setup";
		threadView.show(conv);
		updateComposer();
	};

	// A new, empty project file (from the palette's Files tab), opened to edit.
	const createFile = async (path: string) => {
		if (session.role === "viewer") return toast("Viewers can't change files.", "error");
		const res = await fetch(`api/file?path=${encodeURIComponent(path)}&base=none`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "" }).catch(() => undefined);
		if (!res?.ok) return toast(res?.status === 409 ? `${path} already exists.` : `Couldn't create ${path}.`, "error");
		await openFile(path);
	};
	const openFile = async (path: string, lines?: string) => {
		const file = await loadFile(path, lines);
		if (file === undefined) return toast(`Couldn't open ${path}`, "error");
		panel.openFile(file);
	};
	// Recordings are fetched once with this member's credentials and played from memory.
	const recordings = new Map<string, Promise<string | undefined>>();
	const loadRecording = (name: string) => {
		if (!recordings.has(name))
			recordings.set(
				name,
				fetch(`api/recording?name=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } })
					.then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : undefined))
					.catch(() => undefined),
			);
		return recordings.get(name)!;
	};
	const threadView = new ThreadView($("thread"), $("scroller"), session, { onOpenArtifact: (a) => panel.open(a), onFork: fork, onOpenFile: (path, lines) => void openFile(path, lines), loadImage, loadRecording, onComment: sendComment });
	const settings = new Settings(session, {
		onTheme: (theme) => {
			applyTheme(theme as Theme);
			threadView.reset();
			panel.refresh();
		},
		onShowSetup: () => show("setup"),
		onCompact: () => dialogs.open("compact"),
		onReset: () => dialogs.open("reset"),
	});
	const composer = new Composer(
		{
			session,
			embedded,
			notify: toast,
			showSetup: () => show("setup"),
			togglePanel: () => panel.toggle(),
			openSettings: (section) => settings.open(section),
			confirm: (id) => dialogs.open(id),
			toHost: (action, data) => toHost("action", { action, data }),
			terminal: terminals && ((command) => (session.role === "viewer" ? toast("Viewers can't run commands.", "error") : void terminals.add(command))),
			app: app && ((command) => void app.command(command)),
			vm: () => app?.session(threadId)?.vm,
			fork,
			where: () => where,
			setWhere,
		},
		TOKEN_KEY,
	);
	setWhere(where);
	$("where-label").hidden = !embedded;
	$("where-label").addEventListener("click", () => setWhere(where === "device" ? "vm" : "device"));
	$<HTMLSelectElement>("where").addEventListener("change", (event) => setWhere((event.target as HTMLSelectElement).value as Where));

	const updateComposer = () => {
		const viewer = session.role === "viewer";
		$("composer").hidden = showing !== "main";
		$("viewer-note").hidden = !viewer;
		$<HTMLTextAreaElement>("input").hidden = viewer;
		$("send").hidden = viewer || showing !== "main";
		$("attach").hidden = viewer || showing !== "main";
		const name = session.me?.name ?? "";
		$("me-avatar").textContent = initials(name);
		$("me-avatar").style.setProperty("--person", personColor(name));
	};

	const updateStatus = () => {
		const s = session.threads[showing].state;
		const parts: string[] = [];
		if (s.retry) parts.push(`Retrying: ${s.retry}`);
		else if (s.busy) parts.push("Working");
		if (s.compacting) parts.push("Summarizing older messages");
		if (session.outbox.size > 0) parts.push(`${session.outbox.size} sending`);
		if (s.queued > 0) parts.push(`${s.queued} queued`);
		$("status-text").textContent = parts.join(" · ");
		$("activity").dataset.busy = String(s.busy || s.compacting);
		$("stop").hidden = !(showing === "main" && session.threads.main.state.busy) || session.role === "viewer";
		const model = session.threads.main.state.model ?? session.info?.model ?? "model";
		// The vendor's mark is one of our bundled SVGs; the name is escaped.
		$("model-chip").innerHTML = `${modelVendor(model)?.svg ?? ""}<span>${escapeHtml(model)}</span>`;
		$("cost").textContent = s.cost > 0 ? `$${s.cost.toFixed(2)}` : "";
	};

	let titled = false;
	// The project's sync with this machine, in the app: what went up and down, and conflicts.
	const updateSync = () => {
		const sync = app?.session(threadId)?.sync;
		const box = $("sync-status");
		box.hidden = sync === undefined;
		if (sync === undefined) return;
		box.textContent = sync.error ? "Sync failed" : sync.conflicts.length > 0 ? `${sync.conflicts.length} conflict${sync.conflicts.length === 1 ? "" : "s"}` : `↑${sync.pushed} ↓${sync.pulled} synced`;
		box.title = sync.error || (sync.conflicts.length > 0 ? `Conflicts: ${sync.conflicts.join(", ")}` : "Files synced with this machine. Click to sync now.");
		box.dataset.state = sync.error || sync.conflicts.length > 0 ? "error" : "ok";
	};
	if (app) {
		setInterval(updateSync, 2000);
		updateSync();
		$("sync-status").addEventListener("click", () => app.command("project.sync"));
	}

	session.on("typing", () => threadView.renderTyping());
	session.on("thread", () => {
		threadView.render();
		panel.update();
		updateStatus();
		toHost("activity", { busy: session.threads.main.state.busy });
		// The first message names the thread in an embedding app.
		const first = session.threads.main.state.items.find((i) => i.kind === "user");
		if (!titled && first?.kind === "user") {
			titled = true;
			toHost("title", { title: first.text.split("\n")[0]!.slice(0, 75) });
		}
	});
	let names = "";
	let role = "";
	session.on("people", () => {
		settings.renderPeople();
		$("presence").innerHTML = [...new Map(session.online.map((p) => [p.memberId, p])).values()].map((p) => avatarHtml(session.nameOf(p.memberId, p.name))).join("");
		const nextNames = [...session.names].join("|");
		// Renames and role changes change how existing messages render (author names, the fork action).
		if (nextNames !== names || session.role !== role) {
			names = nextNames;
			role = session.role ?? "";
			threadView.reset();
			updateComposer();
			$("share").hidden = session.role !== "admin";
			$("model-chip").toggleAttribute("disabled", session.role !== "admin");
		}
	});
	session.on("session", () => {
		const info = session.info!;
		document.title = `${info.name} · syncpi`;
		panel.setSession(info.id, info.name);
		$("session-name").textContent = info.name;
		settings.renderInfo();
		updateStatus();
	});
	session.on("env", () => settings.renderEnv());
	session.on("invites", () => settings.renderInvites());
	session.on("branches", () => {
		settings.renderBranches();
		const branch = session.branches.find((b) => b.id === session.currentBranch);
		$("branch-chip").textContent = branch?.label ?? "main";
		$("branch-chip").hidden = session.branches.length < 2;
	});
	session.on("target", () => settings.renderInfo());
	session.on("connection", () => {
		$("conn").textContent = session.connection === "open" ? "" : session.connection;
		$("conn").dataset.state = session.connection;
		if (session.connection === "removed") {
			toast("You were removed from this session.", "error");
			$("composer").hidden = true;
		}
	});
	session.onInvite = (url, invite) => dialogs.share(url, invite);
	session.onNotice = (text) => toast(text);
	session.onError = (message) => toast(message, "error");

	$("settings-open").addEventListener("click", () => settings.open());
	$("panel-toggle").addEventListener("click", () => panel.toggle());
	$("share").addEventListener("click", () => session.send({ type: "invite" }));
	$("stop").addEventListener("click", () => session.send({ type: "abort" }));
	$("setup-back").addEventListener("click", () => show("main"));
	$("model-chip").addEventListener("click", () => session.role === "admin" && pickModel());
	$("branch-chip").addEventListener("click", () => settings.open("branches"));
	// Clicking empty space in the conversation puts the cursor in the composer.
	$("scroller").addEventListener("click", (event) => {
		if (event.target === event.currentTarget && window.getSelection()?.isCollapsed) composer.focus();
	});
	const admin = (run: () => void) => () => (session.role === "admin" ? run() : toast("Only admins can do that."));
	let models: { id: string; name: string; reasoning?: boolean }[] | undefined;
	const pickModel = async () => {
		models ??= await fetch("api/models", { headers: { authorization: `Bearer ${token}` } })
			.then((r) => r.json() as Promise<{ models?: typeof models }>)
			.then((d) => d.models)
			.catch(() => undefined);
		if (!models?.length) return toast("Couldn't load the models.", "error");
		const state = session.threads.main.state;
		palette.pickModel({
			models,
			current: state.model ?? session.info?.model ?? "",
			thinking: state.thinkingLevel ?? "medium",
			choose: (model, thinkingLevel) => session.send({ type: "configure", model, thinkingLevel }),
		});
	};
	// The inbox: in a browser, this thread's mentions of you; in the app the shell keeps one for every thread and asks
	// this page to show a message (syncpiReveal).
	const inboxItems = () => {
		const me = session.me;
		const info = session.info;
		if (me === undefined || info === undefined) return [];
		return mentionsOf(session.threads.main.state, me).map((m) => ({ ...m, author: session.nameOf(m.memberId, m.author), thread: info.id, threadTitle: info.name }));
	};
	const inbox = app ? undefined : new Inbox({ load: inboxItems, open: (item) => threadView.reveal(item.key), many: false });
	if (inbox) {
		session.on("thread", () => {
			for (const m of inbox.fresh(inboxItems())) toast(`${m.author} mentioned you: ${m.text.split("\n")[0]!.slice(0, 90)}`);
			inbox.update();
		});
	}
	(window as Window & { syncpiReveal?: (key: string) => boolean }).syncpiReveal = (key) => threadView.reveal(key);

	// What each command in src/shared/keymap.json does here; in the app, the shell's commands go up to it.
	const fromShell = Object.fromEntries((app ? SHELL_COMMANDS : []).map((id) => [id, () => void app!.command(id)]));
	const palette = new Palette({
		app: app ? "desktop" : "web",
		files: () => session.files,
		openFile: (path) => void openFile(path),
		threads: app ? () => app.threads() : undefined,
		createFile: (path) => void createFile(path),
		openThread: (id) => app?.open(id),
		handlers: {
			...fromShell,
			"palette.threads": () => palette.open("threads"),
			...(inbox ? { "inbox.toggle": () => inbox.toggle() } : {}),
			"palette.all": () => palette.open("all"),
			"palette.commands": () => palette.open("commands"),
			"palette.files": () => palette.open("files"),
			"app.keymap": () => dialogs.keymap("web"),
			"app.settings": () => settings.toggle(),
			"app.theme": () => {
				const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
				applyTheme(dark ? "light" : "dark");
				threadView.reset();
				panel.refresh();
			},
			"thread.share": admin(() => session.send({ type: "invite" })),
			"agent.stop": () => session.send({ type: "abort" }),
			"agent.model": admin(() => void pickModel()),
			"agent.compact": () => dialogs.open("compact"),
			"agent.newContext": admin(() => dialogs.open("reset")),
			"agent.branches": () => settings.open("branches"),
			"agent.setup": () => show(showing === "setup" ? "main" : "setup"),
			"view.changes": () => panel.toggle(),
			"view.files": () => panel.toggleTree(),
			"view.people": () => settings.open("people"),
			...(git ? { "view.git": () => git.toggle() } : {}),
			...(terminals ? { "view.terminal": () => (session.role === "viewer" ? toast("Viewers can't run commands.", "error") : terminals.toggle()) } : {}),
			"file.comment": () => commentOnSelection() || toast("Select lines in a file or diff (click or drag their numbers) to comment on them."),
		},
	});
	document.addEventListener("keydown", (event) => {
		// Esc belongs to whatever has focus: dialogs close, the composer stops the agent.
		if (event.key === "Escape" || event.defaultPrevented) return;
		// With a dialog open only the palette and settings shortcuts apply, so typing there stays typing.
		const dialog = document.querySelector("dialog[open]");
		if (dialog !== null && dialog.id !== "palette" && dialog.id !== "settings-dialog" && dialog.id !== "inbox") return;
		palette.handleKey(event);
	});

	// The shell runs this thread's commands (its menu, its shortcuts while the sidebar has focus) and shares the theme.
	const run = (window as Window & { syncpiRun?: (id: string) => boolean; syncpiTheme?: (theme: string) => void });
	run.syncpiRun = (id) => {
		const handler = palette.handler(id);
		if (handler === undefined) return false;
		handler();
		return true;
	};
	run.syncpiTheme = (theme) => {
		applyTheme(theme as Theme);
		threadView.reset();
		panel.refresh();
	};
	addEventListener("storage", (event) => {
		if (event.key === "syncpi-zoom") applyZoom(document);
		if (event.key === "syncpi-theme") run.syncpiTheme!(event.newValue ?? "system");
	});

	onHostAction((action, data) => {
		switch (action) {
			case "theme":
				applyTheme(data === "light" || data === "dark" ? data : "system");
				threadView.reset();
				return panel.refresh();
			case "settings":
				return settings.open();
			case "share":
				return session.send({ type: "invite" });
			case "people":
				return settings.open("people");
			case "panel":
				return panel.toggle();
			case "setup":
				return show(showing === "setup" ? "main" : "setup");
			case "compact":
				return dialogs.open("compact");
			case "new-context":
				return dialogs.open("reset");
			case "branches":
				return settings.open("branches");
			case "model":
				return settings.open("general");
			case "mention":
				if (typeof data === "string") composer.setText(`${composer.text}${composer.text ? " " : ""}@${data} `);
				return;
		}
	});

	updateComposer();
	session.connect();
	composer.focus();
}

void main();
