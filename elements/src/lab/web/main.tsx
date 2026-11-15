// The lab's page: the conversation on the left, the elements that are on at the right, each with its history. Open it
// in two windows with two names to see two people and the agent change the same element.
import anthropicMark from "@lobehub/icons-static-svg/icons/anthropic.svg";
import { type JSX, render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { initials, personColor, renderMarkdown } from "./markdown.ts";
import { VIEWS } from "./views.ts";

const ANTHROPIC = anthropicMark as string;

type Actor = { kind: "agent"; ref?: string } | { kind: "person"; id: string; name: string };
type Op = { version: number; action: string; args: unknown; actor: Actor; summary: string; at: number };
type ElementInfo = { id: string; title: string; description: string; on: boolean; version: number; state: unknown; view: string; tools: string[] };
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
const savedName = () => {
	try {
		return localStorage.getItem("lab:name") ?? "Ada";
	} catch {
		return "Ada";
	}
};

function Lab() {
	const [elements, setElements] = useState<ElementInfo[]>([]);
	const [items, setItems] = useState<Item[]>([]);
	const [busy, setBusy] = useState(false);
	const [model, setModel] = useState("");
	const [name, setName] = useState(savedName);
	const [toast, setToast] = useState("");
	const [flash, setFlash] = useState<string | undefined>();
	const [versions, setVersions] = useState(0);

	const loadState = () => api<{ elements: ElementInfo[]; model: string; busy: boolean }>("GET", "/api/state").then((s) => (setElements(s.elements), setModel(s.model), setBusy(s.busy), setVersions((n) => n + 1)));
	const loadThread = () => api<{ items: Item[]; busy: boolean }>("GET", "/api/transcript").then((t) => (setItems(t.items), setBusy(t.busy)));
	useEffect(() => {
		void loadState();
		void loadThread();
		const events = new EventSource("/api/events");
		events.addEventListener("thread", () => void loadThread());
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
	const on = elements.filter((e) => e.on);

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
			</header>
			<main class="lab-body">
				<Chat items={items} busy={busy} name={name} model={model} elements={elements} flash={flash} faux={model === "test model"} onError={say} />
				<aside class="lab-panels">
					{on.length === 0 ? <p class="muted lab-pad">No element is on. Switch one on above.</p> : null}
					{on.map((e) => {
						const View = VIEWS[e.id];
						return (
							<section class="lab-panel" key={e.id}>
								<div class="lab-panel-head">
									<b>{e.title}</b>
									<span class="lab-version">v{e.version}</span>
									<span class="spacer" />
									<History element={e} name={name} refresh={versions} onRevert={say} onShow={showInChat} />
								</div>
								{View ? <View state={e.state as never} version={e.version} act={act(e)} /> : <pre class="lab-pad">{e.view}</pre>}
							</section>
						);
					})}
				</aside>
			</main>
			{toast ? (
				<div class="toast" data-tone="error" role="status">
					{toast}
				</div>
			) : null}
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
function toolLine(tool: ToolItem, elements: ElementInfo[]): { verb: string; arg: string; status: "done" | "error" | "running" } {
	const element = elements.find((e) => tool.name.startsWith(`${e.id}_`));
	const action = element ? tool.name.slice(element.id.length + 1) : tool.name;
	const what = element ? `the ${element.title.toLowerCase()}` : tool.name.replace(/_/g, " ");
	const details = tool.result?.details ?? {};
	const status = tool.result === undefined ? "running" : tool.result.isError ? "error" : "done";
	const verb = action === "read" ? `Read ${what}` : action === "history" ? `Looked at the history of ${what}` : action === "revert" ? `Put back an earlier ${what}` : `Changed ${what}`;
	const arg = status === "error" ? tool.result!.text.replace(/^Not (changed|reverted)\. /, "").split(". ")[0]! : action === "read" ? `version ${String(details.version ?? "")}` : String(details.summary ?? "");
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
	const touched = [...new Set(tools.map((t) => elements.find((e) => t.name.startsWith(`${e.id}_`))?.title.toLowerCase()).filter(Boolean))];
	const changed = tools.filter((t) => !/_(read|history)$/.test(t.name)).length;
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
					{props.items.length === 0 ? <p class="notice">Ask the agent to do something with the elements at the right, or change them yourself and ask it what changed.</p> : null}
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
								placeholder={props.busy ? "Tell the agent something while it works…" : props.faux ? "Write to the agent… (the test model calls a tool for: tool calendar_read {})" : "Write to the agent…"}
								onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
										event.preventDefault();
										void send();
									}
								}}
							/>
							<button type="submit" class="icon-button small send" title="Send (Enter)" aria-label="Send (Enter)" disabled={text.trim() === ""}>
								<svg viewBox="0 0 20 20">
									<path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
								</svg>
							</button>
						</div>
					</div>
				</form>
			</div>
			<footer class="statusbar">
				<span class="status-item activity" data-busy={props.busy}>
					<span class="spinner" />
					{props.busy ? "Working" : ""}
				</span>
				{props.busy ? (
					<button type="button" class="status-button status-item" title="Stop the agent" onClick={() => void api("POST", "/api/stop").catch((e: Error) => props.onError(e.message))}>
						Stop
					</button>
				) : null}
				<span class="spacer" />
				<span class="status-item" id="model-chip" title={props.model}>
					{/claude|anthropic/i.test(props.model) ? <span dangerouslySetInnerHTML={{ __html: ANTHROPIC }} /> : null}
					{props.model}
				</span>
			</footer>
		</main>
	);
}

render(<Lab />, document.getElementById("app")!);
