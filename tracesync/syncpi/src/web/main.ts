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
import type { ConvName, LineComment, Where } from "../shared/protocol.ts";
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
import { ThreadMap } from "./thread-map.ts";
import { Follow } from "./follow.ts";
import { mentionsOf } from "../shared/mentions.ts";
import { matchesKeys } from "../shared/keymap.ts";
import { Git } from "./git.ts";
import { Find, type FindTarget } from "./find.ts";

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
		session.submit(composer.takeText(), "interrupt", where, [], [comment], undefined, showing === "side" ? "side" : undefined);
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

	let showing: ConvName = "main";
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
	const show = (conv: ConvName): void => {
		if (conv === "land" && session.land === null) return toast("Nothing has been landed yet: /land starts it.");
		if (conv === "side" && session.side === null) return side();
		showing = conv;
		$("setup-banner").hidden = conv === "main";
		$("side-fresh").hidden = conv !== "side";
		// Your side thread is private: the composer there isn't the shared draft the others see as you type.
		composer.setPrivate(conv === "side");
		updateLandBanner();
		threadView.show(conv);
		threadMap.enabled = conv === "main";
		follow.share();
		threadMap.update();
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
	const threadView = new ThreadView($("thread"), $("scroller"), session, { onOpenArtifact: (a) => panel.open(a), onFork: fork, onOpenFile: (path, lines) => void openFile(path, lines), loadImage, loadRecording, onComment: sendComment, onShowLand: () => show("land"), draftOwner: () => composer.owner, onJoinDraft: (owner) => composer.join(owner) });
	const threadMap = new ThreadMap(session, $("scroller"), $("thread"));
	// Find (⌘F) searches the pane last used: the conversation, or the file open in the panel. The project tree, the
	// sidebar and the composer count as the conversation.
	let pane: "conversation" | "panel" = "conversation";
	const notePane = (event: Event) => {
		const target = event.target as Element | null;
		if (target?.closest?.("#find-bar") || !(target instanceof Element)) return;
		pane = target.closest(".panel-main") !== null ? "panel" : "conversation";
	};
	document.addEventListener("focusin", notePane, true);
	document.addEventListener("pointerdown", notePane, true);
	const findTarget = (): FindTarget | undefined => {
		if (pane === "panel" && panel.shown !== null) {
			const target = panel.findTarget();
			if (target !== undefined) return target;
		}
		return threadView.findTarget($("scroller"));
	};
	const find = new Find({ target: findTarget, onOpen: (open) => void (follow.paused = open) });
	// Rows replaced (a reply streaming, a theme change) or the panel's view redrawn: Find counts again.
	const changed = (records: MutationRecord[]) => {
		if (records.every((r) => (r.target as Element).closest?.(".find-layer") || [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).classList?.contains("find-layer") || (n as Element).classList?.contains("find-box")))) return;
		find.refresh();
	};
	new MutationObserver(changed).observe($("thread"), { childList: true });
	new MutationObserver(changed).observe($("panel-file"), { childList: true, subtree: true });
	new MutationObserver(changed).observe($("panel-view"), { childList: true, subtree: true });
	/** A terminal has its own keys (⌘F, ⌘K); another dialog keeps its own input. */
	const inTerminal = () => terminals?.focused === true;
	const findBlocked = () => inTerminal() || document.querySelector("dialog[open]") !== null;
	const mac = /Mac|iPhone|iPad/.test(navigator.platform);
	const follow = new Follow({ session, scroller: $("scroller"), box: $("thread"), panel, showing: () => showing, show: (conv) => show(conv), notify: toast });
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
			conv: () => (showing === "land" || showing === "side" ? showing : "main"),
			land: () => land(),
			side: (text, fresh) => side(text, fresh),
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

	/**
	 * Your side thread: a private fork of the thread to ask about it (the server keeps yours until it restarts, or
	 * `fresh` forks it again from the thread as it is now). `text`: a question to ask it.
	 */
	const side = (text?: string, fresh = false): void => {
		if (session.role === "viewer") return toast("Viewers can't start a side thread.", "error");
		if (session.side !== null && !fresh && !text) return show("side");
		session.openSide(where, fresh, text);
	};
	session.onSideOpen = () => show("side");
	session.on("side", () => {
		if (showing === "side" && session.side === null) show("main");
	});
	$("side-fresh").addEventListener("click", () => side(undefined, true));

	/** The rocket: open the land in progress, or ask to start one. */
	const land = () => {
		if (session.role === "viewer") return toast("Viewers can't land changes.", "error");
		if (session.land?.status === "running") return show("land");
		$("land-where").textContent =
			where === "device" ? "It runs on this machine, where your git credentials are." : "It runs on the session VM, which needs credentials to push (a deploy key or token there).";
		$<HTMLDialogElement>("land-dialog").showModal();
	};
	/** The rocket and the side thread's banner say how the latest land is going. */
	const updateLandBanner = () => {
		const info = session.land;
		const button = $("land-button");
		button.dataset.state = info?.status ?? "";
		button.title = info === null ? "Land changes on main" : info.status === "running" ? `Landing (${info.by})… click to follow` : info.status === "landed" ? `Landed on main (${info.detail ?? ""}). Click to land again` : `Not landed: ${info.detail ?? ""}. Click to try again`;
		$("land-stop").hidden = showing !== "land" || info?.status !== "running";
		if (showing === "setup") $("side-title").textContent = "Setup agent's thread";
		else if (showing === "side") $("side-title").textContent = "Your side thread · only you see it, and it can't change files";
		else if (showing === "land" && info !== null)
			$("side-title").textContent = info.status === "running" ? `Landing, started by ${info.by}` : info.status === "landed" ? `Landed on main (${info.detail?.slice(0, 12)})` : `Not landed: ${info.detail}`;
	};
	const updateComposer = () => {
		const viewer = session.role === "viewer";
		// The land thread can be answered too (it may ask how this project ships), and your side thread asked.
		const talks = showing === "main" || showing === "land" || showing === "side";
		$("composer").hidden = !talks;
		$("viewer-note").hidden = !viewer;
		$<HTMLTextAreaElement>("input").hidden = viewer;
		$("send").hidden = viewer || !talks;
		$("attach").hidden = viewer || !talks;
		$("land-button").hidden = viewer || session.role === undefined;
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
		$("stop").hidden = !((showing === "main" || showing === "side") && session.threads[showing].state.busy) || session.role === "viewer";
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

	session.on("drafts", () => threadView.renderTyping());
	session.on("thread", () => threadMap.update());
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
		// Each face follows that person when clicked, as in Delta.
		$("presence").innerHTML = [...new Map(session.online.map((p) => [p.memberId, p])).values()]
			.map((p) => {
				const name = session.nameOf(p.memberId, p.name);
				return p.memberId === session.me?.id ? avatarHtml(name) : `<button type="button" class="presence-face" data-member="${escapeHtml(p.memberId)}" title="Follow ${escapeHtml(name)}">${avatarHtml(name)}</button>`;
			})
			.join("");
		follow.refresh();
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
	$("diff-chip").addEventListener("click", () => panel.showChanges());
	$("share").addEventListener("click", () => session.send({ type: "invite" }));
	$("stop").addEventListener("click", () => session.send(showing === "side" ? { type: "abort", conv: "side" } : { type: "abort" }));
	$("setup-back").addEventListener("click", () => show("main"));
	$("land-stop").addEventListener("click", () => session.send({ type: "abort", conv: "land" }));
	$("land-button").addEventListener("click", () => land());
	$("land-form").addEventListener("submit", (event) => {
		event.preventDefault();
		$<HTMLDialogElement>("land-dialog").close();
		session.send({ type: "land", where });
		landing = true;
	});
	// After asking to land: its thread, once it's started.
	let landing = false;
	session.on("land", () => {
		if (landing && session.land?.status === "running") {
			landing = false;
			show("land");
		}
		updateLandBanner();
	});
	$("model-chip").addEventListener("click", () => session.role === "admin" && pickModel());
	$("branch-chip").addEventListener("click", () => settings.open("branches"));
	// Clicking empty space in the conversation puts the cursor in the composer.
	$("scroller").addEventListener("click", (event) => {
		if (event.target === event.currentTarget && window.getSelection()?.isCollapsed) composer.focus();
	});
	// Roles are checked when a command runs, not when it was listed: a role can change while the palette is open.
	const admin = (run: () => void) => () => (session.role === "admin" ? run() : toast("Only admins can do that."));
	const editor = (run: () => void) => () => (session.role === "viewer" ? toast("Viewers can't do that; an admin can make you an editor.", "error") : run());
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
	// Showing a draft you were tagged in also joins it, to write it with them.
	const reveal = (key: string) => {
		const shown = threadView.reveal(key);
		const item = session.threads.main.state.items.find((i) => i.key === key);
		if (item?.kind === "notice" && item.tag !== undefined) composer.join(item.tag.owner);
		return shown;
	};
	const inbox = app ? undefined : new Inbox({ load: inboxItems, open: (item) => reveal(item.key), many: false });
	if (inbox) {
		// The inbox button in the top bar, with how many are unread (the app has its own, in the sidebar).
		const count = () => {
			const unread = inbox.unread(inboxItems()).length;
			$("inbox-count").textContent = unread > 0 ? String(unread) : "";
			$("inbox-open").title = unread > 0 ? `Inbox: ${unread} unread (⇧⌘J)` : "Inbox (⇧⌘J)";
		};
		$("inbox-open").hidden = false;
		$("inbox-open").addEventListener("click", () => inbox.toggle());
		$("inbox").addEventListener("close", count);
		$("inbox-read-all").addEventListener("click", count);
		session.on("thread", () => {
			for (const m of inbox.fresh(inboxItems())) toast(`${m.author} ${m.draft !== undefined ? "tagged you in a draft" : "mentioned you"}: ${m.text.split("\n")[0]!.slice(0, 90)}`);
			inbox.update();
			count();
		});
		session.on("session", count);
	}
	(window as Window & { syncpiReveal?: (key: string) => boolean }).syncpiReveal = reveal;

	// What each command in src/shared/keymap.json does here; in the app, the shell's commands go up to it.
	const fromShell = Object.fromEntries((app ? SHELL_COMMANDS : []).map((id) => [id, () => void app!.command(id)]));
	const palette = new Palette({
		app: app ? "desktop" : "web",
		files: () => session.files,
		openFile: (path) => void openFile(path),
		threads: app ? () => app.threads() : undefined,
		createFile: (path) => void createFile(path),
		canCreate: () => session.role !== "viewer",
		openThread: (id) => app?.open(id),
		handlers: {
			...fromShell,
			"palette.threads": () => palette.open("threads"),
			...(inbox ? { "inbox.toggle": () => inbox.toggle() } : {}),
			// In a terminal, ⌘K is the terminal's. As a key it goes straight there; from the app's menu, it's done for it.
			"palette.all": () => {
				if (inTerminal()) return void terminals!.commandK(mac);
				palette.open("all");
			},
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
			"agent.stop": editor(() => session.send(showing === "side" ? { type: "abort", conv: "side" } : { type: "abort" })),
			"agent.model": admin(() => void pickModel()),
			"agent.compact": editor(() => dialogs.open("compact")),
			"agent.newContext": admin(() => dialogs.open("reset")),
			"agent.branches": () => settings.open("branches"),
			"agent.setup": () => show(showing === "setup" ? "main" : "setup"),
			"agent.land": editor(() => land()),
			"agent.landThread": () => show(showing === "land" ? "main" : "land"),
			"agent.side": editor(() => (showing === "side" ? show("main") : side())),
			"view.changes": () => panel.toggle(),
			"view.files": () => panel.toggleTree(),
			"view.people": () => settings.open("people"),
			...(git ? { "view.git": () => git.toggle() } : {}),
			...(terminals ? { "view.terminal": () => (session.role === "viewer" ? toast("Viewers can't run commands.", "error") : terminals.toggle()) } : {}),
			"find.open": () => !findBlocked() && find.open(),
			"find.next": () => !findBlocked() && find.next(),
			"find.previous": () => !findBlocked() && find.previous(),
			"file.comment": editor(() => commentOnSelection() || toast("Select lines in a file or diff (click or drag their numbers) to comment on them.")),
		},
	});
	document.addEventListener("keydown", (event) => {
		// Esc belongs to whatever has focus: dialogs close, the composer stops the agent.
		if (event.key === "Escape" || event.defaultPrevented) return;
		// With a dialog open only the palette and settings shortcuts apply, so typing there stays typing.
		const dialog = document.querySelector("dialog[open]");
		if (dialog !== null && dialog.id !== "palette" && dialog.id !== "settings-dialog" && dialog.id !== "inbox") return;
		// The terminal keeps ⌘K (Ctrl+K: kill to the end of the line, elsewhere) and ⌘F; ⇧⌘P still opens the palette.
		if (inTerminal() && (matchesKeys(event, "cmd-k") || matchesKeys(event, "cmd-f"))) return;
		palette.handleKey(event);
	});

	// The shell runs this thread's commands (its menu, its shortcuts while the sidebar has focus) and shares the theme.
	const run = (window as Window & { syncpiRun?: (id: string, from?: "sidebar") => boolean; syncpiTheme?: (theme: string) => void });
	run.syncpiRun = (id, from) => {
		// From the sidebar, Find is the conversation's.
		if (from === "sidebar") pane = "conversation";
		const handler = palette.handler(id);
		if (handler === undefined) return false;
		return handler() !== false;
	};
	// The app put this thread away (another is showing): Find closes, so a hidden page holds no bar or focus.
	(window as Window & { syncpiHidden?: () => void }).syncpiHidden = () => find.close(true);
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
