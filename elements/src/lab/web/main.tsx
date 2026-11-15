// The lab's page: the conversation on the left, and at the right a side panel with a tab for each element open in the
// conversation, each with its history. Open it in two windows with two names to see two people and the agent change the
// same element.
//
// The agent opens an element quietly (use_element: its tab appears) or puts it in front of people (show_element: the
// panel opens on it, at the item it named). Each person folds the panel, picks a tab, closes a tab, or opens another
// element themselves; that is theirs, kept in this browser. A tab someone else changed since this person last had it in
// front of them has a dot, and so has the fold button while the panel is folded.
import anthropicMark from "@lobehub/icons-static-svg/icons/anthropic.svg";
import { type JSX, render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { initials, personColor, renderMarkdown } from "./markdown.ts";
import { VIEWS } from "./views.ts";

const ANTHROPIC = anthropicMark as string;

type Actor = { kind: "agent"; ref?: string } | { kind: "person"; id: string; name: string };
type Op = { version: number; action: string; args: unknown; actor: Actor; summary: string; at: number };
type ElementInfo = { id: string; title: string; description: string; on: boolean; open: boolean; version: number; changedBy?: string; state: unknown; view: string; tools: string[] };
type Item =
	| { type: "person"; id: number; name: string; text: string; at: number }
	| { type: "agent"; id: number; text: string }
	| { type: "tool"; id: string; name: string; args: unknown; result?: { text: string; isError: boolean; details: Record<string, unknown> } }
	| { type: "op"; id: number; element: string; title: string; version: number; summary: string; name: string; at: number }
	| { type: "wake"; id: number; text: string };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
	return data;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** What this person keeps in this browser: their name, the panel, their tabs. A private window keeps it for the visit. */
function saved<T>(key: string, fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : (JSON.parse(value) as T);
	} catch {
		return fallback;
	}
}
function keep(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// a private window: it lasts this visit
	}
}
const savedName = () => {
	try {
		return localStorage.getItem("lab:name") ?? "Ada";
	} catch {
		return "Ada";
	}
};

type ToolDetails = { element?: string; shown?: boolean; about?: string; reason?: string };
const isShow = (item: Item): item is ToolItem => item.type === "tool" && item.name === "show_element" && item.result !== undefined && !item.result.isError;

function Lab() {
	const [elements, setElements] = useState<ElementInfo[]>([]);
	const [items, setItems] = useState<Item[]>([]);
	const [busy, setBusy] = useState(false);
	const [model, setModel] = useState("");
	const [name, setName] = useState(savedName);
	const [toast, setToast] = useState("");
	const [flash, setFlash] = useState<string | undefined>();
	const [versions, setVersions] = useState(0);
	const [panel, setPanel] = useState(() => saved("lab:panel", true));
	const [current, setCurrent] = useState<string | undefined>(() => saved<string | undefined>("lab:tab", undefined));
	const [closed, setClosed] = useState<string[]>(() => saved("lab:closed", []));
	const [seen, setSeen] = useState<Record<string, number>>(() => saved("lab:seen", {}));
	const [focus, setFocus] = useState<{ element: string; item: string; key: string } | undefined>();
	const [launcher, setLauncher] = useState(false);
	/** The show_element calls already acted on: those in the transcript when the page opened, and each one since. */
	const shows = useRef<Set<string> | undefined>(undefined);
	const body = useRef<HTMLDivElement>(null);

	const loadState = () => api<{ elements: ElementInfo[]; model: string; busy: boolean }>("GET", "/api/state").then((s) => (setElements(s.elements), setModel(s.model), setBusy(s.busy), setVersions((n) => n + 1)));
	const loadThread = () =>
		api<{ items: Item[]; busy: boolean }>("GET", "/api/transcript").then((t) => {
			// What the agent showed before this page opened is not shown again.
			if (shows.current === undefined) shows.current = new Set(t.items.filter(isShow).map((i) => i.id));
			setItems(t.items);
			setBusy(t.busy);
		});
	useEffect(() => {
		void loadState();
		void loadThread();
		const events = new EventSource("/api/events");
		// The agent's step may have opened an element (its tools loaded), which changes no element: read both.
		events.addEventListener("thread", () => (void loadThread(), void loadState()));
		events.addEventListener("element", () => (void loadState(), void loadThread()));
		return () => events.close();
	}, []);
	const say = (text: string) => (setToast(text), setTimeout(() => setToast(""), 3500));

	/** A person's change, against the version on the screen. A refusal says why and the page catches up. */
	const act = (element: ElementInfo) => async (action: string, args: Record<string, unknown>) => {
		try {
			await api("POST", `/api/elements/${element.id}/act`, { action, args, version: element.version, name });
			return true;
		} catch (error) {
			say((error as Error).message);
			void loadState();
			return false;
		}
	};
	const showInChat = (ref: string) => {
		setFlash(ref);
		document.getElementById(`tool-${ref}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
		setTimeout(() => setFlash(undefined), 1600);
	};
	useEffect(() => keep("lab:panel", panel), [panel]);
	useEffect(() => keep("lab:tab", current), [current]);
	useEffect(() => keep("lab:closed", closed), [closed]);
	useEffect(() => keep("lab:seen", seen), [seen]);

	// The agent showed an element: open the panel on it, at the item it named.
	useEffect(() => {
		if (shows.current === undefined) return;
		const fresh = items.filter(isShow).filter((i) => !shows.current!.has(i.id));
		for (const item of fresh) shows.current.add(item.id);
		const last = fresh.at(-1);
		const details = last?.result?.details as ToolDetails | undefined;
		if (last === undefined || details?.element === undefined) return;
		const id = details.element;
		setClosed((c) => c.filter((e) => e !== id));
		setCurrent(id);
		setPanel(true);
		setLauncher(false);
		if (details.about) setFocus({ element: id, item: details.about, key: last.id });
	}, [items]);

	const on = elements.filter((e) => e.on);
	const tabs = on.filter((e) => (e.open || e.id === current) && !closed.includes(e.id));
	const tab = tabs.find((e) => e.id === current) ?? tabs[0];
	const visible = panel ? tab?.id : undefined;
	/** Someone else changed it since this person last had it in front of them. */
	const changed = (e: ElementInfo) => e.id !== visible && e.version > (seen[e.id] ?? e.version) && e.changedBy !== name;
	const flagged = tabs.some(changed);

	// What is in front of this person is seen; an element they have never seen starts as seen where it is now.
	useEffect(() => {
		const next = { ...seen };
		for (const e of elements) if (next[e.id] === undefined || (e.id === visible && next[e.id] !== e.version)) next[e.id] = e.version;
		if (elements.some((e) => next[e.id] !== seen[e.id])) setSeen(next);
	}, [elements, visible]);

	// Point to the item: after the component has brought it into view (the calendar turns to its day).
	useEffect(() => {
		if (focus === undefined || focus.element !== visible) return;
		const timer = setTimeout(() => {
			const rows = [...(body.current?.querySelectorAll(`[data-item="${CSS.escape(focus.item)}"]`) ?? [])];
			rows.at(-1)?.scrollIntoView({ block: "center", behavior: "smooth" });
			for (const row of rows) row.classList.add("lab-flash");
			setTimeout(() => rows.forEach((row) => row.classList.remove("lab-flash")), 1600);
		}, 60);
		return () => clearTimeout(timer);
	}, [focus?.key, visible]);

	const openTab = async (id: string) => {
		setLauncher(false);
		setClosed((c) => c.filter((e) => e !== id));
		setCurrent(id);
		try {
			await api("POST", `/api/elements/${id}/open`, {});
			void loadState();
		} catch (error) {
			say((error as Error).message);
		}
	};
	const closeTab = (id: string) => {
		setClosed((c) => [...c.filter((e) => e !== id), id]);
		if (current === id) setCurrent(tabs.find((e) => e.id !== id)?.id);
	};
	const others = on.filter((e) => !tabs.includes(e));

	return (
		<div class="lab">
			<header class="lab-bar">
				<b>Element lab</b>
				<span class="muted">{model}</span>
				<span class="spacer" />
				{elements.map((e) => (
					<span class="lab-toggle" key={e.id} title={e.description}>
						<button type="button" class="switch" role="switch" aria-checked={e.on} aria-label={`${e.on ? "Turn off" : "Turn on"} ${e.title}`} onClick={() => void api("POST", `/api/elements/${e.id}/enable`, { on: !e.on }).then(loadState)}>
							<span class="switch-knob" />
						</button>
						{e.title}
					</span>
				))}
				<label class="lab-you">
					You are
					<input
						value={name}
						onInput={(event) => {
							const value = (event.target as HTMLInputElement).value;
							setName(value);
							try {
								localStorage.setItem("lab:name", value);
							} catch {
								// a private window: the name lasts this visit
							}
						}}
					/>
				</label>
				<button type="button" class="icon-button lab-fold" title={panel ? "Hide the side panel" : "Show the side panel"} aria-label={panel ? "Hide the side panel" : flagged ? "Show the side panel: something changed" : "Show the side panel"} aria-pressed={panel} onClick={() => setPanel(!panel)}>
					<svg viewBox="0 0 20 20" aria-hidden="true">
						<rect x="3" y="4" width="14" height="12" rx="1.5" />
						<path d="M12 4v12" />
					</svg>
					{!panel && flagged ? <span class="lab-dot" /> : null}
				</button>
			</header>
			<main class="lab-body" data-panel={panel ? "open" : "closed"}>
				<Chat items={items} busy={busy} name={name} model={model} elements={elements} flash={flash} faux={model === "test model"} onError={say} />
				{panel ? (
					<aside class="lab-side" aria-label="Elements">
						<div class="lab-side-head">
							<div class="lab-tabs" role="tablist">
								{tabs.map((e) => (
									<div key={e.id} role="tab" tabIndex={0} class="lab-tab" aria-selected={e.id === tab?.id} data-changed={changed(e) || undefined} title={changed(e) ? `${e.title}: changed since you last looked` : e.title} onClick={() => setCurrent(e.id)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && setCurrent(e.id)}>
										{e.title}
										{changed(e) ? <span class="lab-dot" /> : null}
										<button
											type="button"
											class="lab-tab-close"
											aria-label={`Close ${e.title}`}
											onClick={(event) => {
												event.stopPropagation();
												closeTab(e.id);
											}}
										>
											<svg viewBox="0 0 20 20" aria-hidden="true">
												<path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
											</svg>
										</button>
									</div>
								))}
							</div>
							<button type="button" class="icon-button small" title="Open an element" aria-label="Open an element" aria-expanded={launcher} onClick={() => setLauncher(!launcher)}>
								<svg viewBox="0 0 20 20" aria-hidden="true">
									<path d="M10 4.5v11M4.5 10h11" />
								</svg>
							</button>
						</div>
						{launcher ? <Launcher elements={others} onOpen={(id) => void openTab(id)} onClose={() => setLauncher(false)} /> : null}
						<div class="lab-side-body" ref={body}>
							{on.length === 0 ? <p class="muted lab-pad">No element is on. Switch one on above.</p> : null}
							{on.length > 0 && tab === undefined ? (
								<div class="lab-pad lab-empty">
									<p class="muted">Nothing is open here yet. The agent opens what you are working on, or you can open one yourself.</p>
									<button type="button" class="button" onClick={() => setLauncher(true)}>
										Open an element
									</button>
								</div>
							) : null}
							{tab ? (
								<section class="lab-panel" key={tab.id}>
									<div class="lab-panel-head">
										<b>{tab.title}</b>
										<span class="lab-version">v{tab.version}</span>
										<span class="spacer" />
										<History element={tab} name={name} refresh={versions} onRevert={say} onShow={showInChat} />
									</div>
									{(() => {
										const View = VIEWS[tab.id];
										return View ? <View state={tab.state as never} version={tab.version} act={act(tab)} focus={focus?.element === tab.id ? focus : undefined} /> : <pre class="lab-pad">{tab.view}</pre>;
									})()}
								</section>
							) : null}
						</div>
					</aside>
				) : null}
			</main>
			{toast ? (
				<div class="toast" data-tone="error" role="status">
					{toast}
				</div>
			) : null}
		</div>
	);
}

/** The elements that are on and not open here, to open one: its name and what it is for. Escape closes it. */
function Launcher(props: { elements: ElementInfo[]; onOpen: (id: string) => void; onClose: () => void }) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	return (
		<div class="lab-launcher" role="menu">
			{props.elements.length === 0 ? <p class="muted small lab-launcher-empty">Every element is open.</p> : null}
			{props.elements.map((e) => (
				<button type="button" role="menuitem" class="lab-launcher-item" key={e.id} onClick={() => props.onOpen(e.id)}>
					<span>{e.title}</span>
					<span class="muted small">{e.description}</span>
				</button>
			))}
		</div>
	);
}

/** An element's history, newest first: who changed what, and a way to put any version back. */
function History(props: { element: ElementInfo; name: string; refresh: number; onRevert: (text: string) => void; onShow: (ref: string) => void }) {
	const [open, setOpen] = useState(false);
	const [ops, setOps] = useState<Op[]>([]);
	useEffect(() => {
		if (open) void api<{ ops: Op[] }>("GET", `/api/elements/${props.element.id}/history`).then((h) => setOps(h.ops.reverse()));
	}, [open, props.refresh]);
	const putBack = async (to: number) => {
		try {
			await api("POST", `/api/elements/${props.element.id}/revert`, { to, version: props.element.version, name: props.name });
		} catch (error) {
			props.onRevert((error as Error).message);
		}
	};
	return (
		<>
			<button type="button" class="link" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? "Hide history" : "History"}
			</button>
			{open ? (
				<ol class="lab-history">
					{ops.length === 0 ? <li class="muted">No changes yet.</li> : null}
					{ops.map((op, i) => (
						<li key={op.version} class={op.action === "revert" ? "lab-history-revert" : ""}>
							<span class="version">v{op.version}</span>
							<span class="lab-history-text">
								<span>{op.summary}</span>
								<span class="muted">
									{op.actor.kind === "agent" ? "the agent" : op.actor.name} · {time(op.at)}
									{op.actor.kind === "agent" && op.actor.ref ? (
										<button type="button" class="link" onClick={() => props.onShow((op.actor as { ref: string }).ref)}>
											In the chat
										</button>
									) : null}
								</span>
							</span>
							{i > 0 ? (
								<button type="button" class="link" title={`Make the element as it was at version ${op.version}`} onClick={() => void putBack(op.version)}>
									Put back
								</button>
							) : null}
						</li>
					))}
					{ops.length > 0 ? (
						<li>
							<span class="version">v0</span>
							<span class="lab-history-text muted">Empty</span>
							<button type="button" class="link" onClick={() => void putBack(0)}>Put back</button>
						</li>
					) : null}
				</ol>
			) : null}
		</>
	);
}

/** The agent's mark beside its rows, as the app shows it (chat/icons.ts). */
function ModelAvatar(props: { model: string }) {
	const anthropic = /claude|anthropic/i.test(props.model);
	return anthropic ? <span class="avatar model-avatar" title={props.model} dangerouslySetInnerHTML={{ __html: ANTHROPIC }} /> : <span class="avatar model-avatar" title={props.model}>{(props.model.split("/").pop()?.[0] ?? "?").toUpperCase()}</span>;
}

function Avatar(props: { name: string }) {
	return (
		<span class="avatar" style={{ "--person": personColor(props.name) } as JSX.CSSProperties} title={props.name}>
			{initials(props.name)}
		</span>
	);
}

type ToolItem = Extract<Item, { type: "tool" }>;

/** A tool call in the app's words: what it did to which element, and the line under it. */
/** The element a call is about: by its tool's name, or the one use_element and show_element name. */
const elementOf = (tool: ToolItem, elements: ElementInfo[]) => elements.find((e) => tool.name.startsWith(`${e.id}_`) || (OPENERS.includes(tool.name) && (tool.args as ToolDetails | undefined)?.element === e.id));
const OPENERS = ["use_element", "show_element"];

function toolLine(tool: ToolItem, elements: ElementInfo[]): { verb: string; arg: string; status: "done" | "error" | "running" } {
	const element = elementOf(tool, elements);
	const action = OPENERS.includes(tool.name) ? tool.name : element ? tool.name.slice(element.id.length + 1) : tool.name;
	const what = element ? `the ${element.title.toLowerCase()}` : OPENERS.includes(tool.name) ? "an element" : tool.name.replace(/_/g, " ");
	const details = tool.result?.details ?? {};
	const status = tool.result === undefined ? "running" : tool.result.isError ? "error" : "done";
	const verb = action === "read" ? `Read ${what}` : action === "use_element" ? `Opened ${what}` : action === "show_element" ? `Showed you ${what}` : action === "history" ? `Looked at the history of ${what}` : action === "revert" ? `Put back an earlier ${what}` : `Changed ${what}`;
	const reason = (tool.args as ToolDetails | undefined)?.reason;
	const arg = status === "error" ? tool.result!.text.replace(/^Not (changed|reverted)\. /, "").split(". ")[0]! : action === "show_element" && reason ? reason : action === "read" || action === "use_element" ? `version ${String(details.version ?? "")}` : String(details.summary ?? "");
	return { verb: status === "error" ? `Did not work: ${verb.charAt(0).toLowerCase()}${verb.slice(1)}` : verb, arg, status };
}

function ToolRow(props: { tool: ToolItem; elements: ElementInfo[]; flash: boolean }) {
	const { verb, arg, status } = toolLine(props.tool, props.elements);
	return (
		<details class={`fold tool tool-${status}${props.flash ? " lab-flash" : ""}`} id={`tool-${props.tool.id}`}>
			<summary>
				<span class="tool-verb">{verb}</span>
				<span class="tool-arg">{arg}</span>
			</summary>
			<div class="tool-body">
				<pre class="tool-output">{props.tool.result?.text ?? "…"}</pre>
			</div>
		</details>
	);
}

/** Calls made one after another, with nothing said between them: one short row, as the app groups them ("Read the
 *  file 3 times"). Which element each touched is in the row; each call is a click away. */
function groupSummary(tools: ToolItem[], elements: ElementInfo[]): { verb: string; arg: string } {
	const touched = [...new Set(tools.map((t) => elementOf(t, elements)?.title.toLowerCase()).filter(Boolean))];
	const changed = tools.filter((t) => !/_(read|history)$/.test(t.name) && !OPENERS.includes(t.name)).length;
	const failed = tools.filter((t) => t.result?.isError).length;
	const verb = changed === 0 ? `Read ${touched.length === 1 ? `the ${touched[0]}` : `${touched.length} elements`}` : `Made ${changed} ${changed === 1 ? "change" : "changes"}`;
	return { verb, arg: [`${tools.length} steps on the ${touched.join(" and the ")}`, failed > 0 ? `${failed} did not work` : ""].filter(Boolean).join(" · ") };
}

function Chat(props: { items: Item[]; busy: boolean; name: string; model: string; elements: ElementInfo[]; flash?: string; faux: boolean; onError: (text: string) => void }) {
	const [text, setText] = useState("");
	const scroller = useRef<HTMLDivElement>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [props.items.length, props.busy]);
	// The box grows with what is written in it, as the app's does.
	useLayoutEffect(() => {
		if (area.current === null) return;
		area.current.style.height = "auto";
		area.current.style.height = `${area.current.scrollHeight}px`;
	}, [text]);
	const send = async () => {
		if (text.trim() === "") return;
		try {
			await api("POST", "/api/message", { text, name: props.name });
			setText("");
		} catch (error) {
			props.onError((error as Error).message);
		}
	};

	// Consecutive tool calls make one row.
	const rows: (Item | { type: "group"; tools: ToolItem[] })[] = [];
	for (const item of props.items) {
		const last = rows.at(-1);
		if (item.type === "tool" && last !== undefined && (last.type === "tool" || last.type === "group")) {
			if (last.type === "group") last.tools.push(item);
			else rows[rows.length - 1] = { type: "group", tools: [last, item] };
		} else rows.push(item);
	}

	return (
		<main class="center">
			<div class="scroller" ref={scroller}>
				<div class="thread">
					{props.items.length === 0 ? <p class="notice">Ask the agent about your work: it opens what it needs at the right. Or open something yourself, change it, and ask what changed.</p> : null}
					{rows.map((row, i) => {
						switch (row.type) {
							case "person":
								return (
									<article class="msg msg-user" key={`p${row.id}`} style={{ "--person": personColor(row.name) } as JSX.CSSProperties}>
										<span class="msg-who">
											<span class="author">{row.name}</span>
										</span>
										<div class="msg-content">
											<div class="msg-body prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text, { breaks: true }) }} />
										</div>
										<div class="msg-meta" />
									</article>
								);
							case "agent":
								return (
									<article class="msg msg-agent" key={`a${row.id}`}>
										<ModelAvatar model={props.model} />
										<div class="msg-content">
											<div class="msg-body prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text) }} />
										</div>
									</article>
								);
							case "op":
								return (
									<p class="notice" key={`o${row.id}`}>
										{row.name} changed the {row.title.toLowerCase()}: {row.summary}
									</p>
								);
							case "wake":
								return (
									<div class="wake" key={`w${row.id}`}>
										<svg viewBox="0 0 20 20" aria-hidden="true">
											<circle cx="10" cy="10" r="7" />
											<path d="M10 6.5V10l2.5 1.5" />
										</svg>
										<div>
											<span class="wake-kind">On the screen</span>
											<span class="wake-text">{row.text}</span>
										</div>
									</div>
								);
							case "tool":
								return (
									<article class="msg msg-agent" key={row.id}>
										<ModelAvatar model={props.model} />
										<div class="msg-content">
											<ToolRow tool={row} elements={props.elements} flash={props.flash === row.id} />
										</div>
									</article>
								);
							case "group":
								return (
									<article class="msg msg-agent" key={`g${i}-${row.tools[0]!.id}`}>
										<ModelAvatar model={props.model} />
										<div class="msg-content">
											<details class="fold tool" open={row.tools.some((t) => t.id === props.flash)}>
												<summary>
													<span class="tool-verb">{groupSummary(row.tools, props.elements).verb}</span>
													<span class="tool-arg">{groupSummary(row.tools, props.elements).arg}</span>
												</summary>
												<div class="tool-body">
													{row.tools.map((t) => (
														<ToolRow key={t.id} tool={t} elements={props.elements} flash={props.flash === t.id} />
													))}
												</div>
											</details>
										</div>
									</article>
								);
						}
					})}
				</div>
				<form
					class="msg composer"
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<Avatar name={props.name} />
					<div class="composer-main">
						<div class="composer-row">
							<textarea
								ref={area}
								rows={1}
								value={text}
								aria-label="Message"
								placeholder={props.busy ? "Tell the agent something while it works…" : props.faux ? "Write to the agent… (the test model calls a tool for: tool show_element {\"element\": \"calendar\", \"reason\": \"to plan\"})" : "Write to the agent…"}
								onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
										event.preventDefault();
										void send();
									}
								}}
							/>
							{props.busy ? (
								<button type="button" class="icon-button small" title="Stop the agent" aria-label="Stop the agent" onClick={() => void api("POST", "/api/stop").catch((e: Error) => props.onError(e.message))}>
									<svg viewBox="0 0 20 20">
										<rect x="6" y="6" width="8" height="8" rx="1.5" />
									</svg>
								</button>
							) : null}
							<button type="submit" class="icon-button small send" title="Send (Enter)" aria-label="Send (Enter)" disabled={text.trim() === ""}>
								<svg viewBox="0 0 20 20">
									<path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
								</svg>
							</button>
						</div>
					</div>
				</form>
			</div>
		</main>
	);
}

render(<Lab />, document.getElementById("app")!);
