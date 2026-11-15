// The lab's page: the conversation on the left, the elements that are on at the right, each with its history. Open it
// in two windows with two names to see two people and the agent change the same element.
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { VIEWS } from "./views.ts";

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
				<Chat items={items} busy={busy} name={name} elements={elements} flash={flash} faux={model === "test model"} onError={say} />
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

function Chat(props: { items: Item[]; busy: boolean; name: string; elements: ElementInfo[]; flash?: string; faux: boolean; onError: (text: string) => void }) {
	const [text, setText] = useState("");
	const box = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		box.current?.scrollTo({ top: box.current.scrollHeight });
	}, [props.items.length, props.busy]);
	const titleOf = (tool: string) => props.elements.find((e) => tool.startsWith(`${e.id}_`));
	const send = async () => {
		if (text.trim() === "") return;
		try {
			await api("POST", "/api/message", { text, name: props.name });
			setText("");
		} catch (error) {
			props.onError((error as Error).message);
		}
	};

	return (
		<section class="lab-chat">
			<div class="lab-thread" ref={box}>
				{props.items.length === 0 ? <p class="muted lab-pad">Ask the agent to do something with the elements on the right, or change them yourself and ask it what changed.</p> : null}
				{props.items.map((item) => {
					switch (item.type) {
						case "person":
							return (
								<div class="lab-msg lab-person" key={`p${item.id}`}>
									<b>{item.name}</b>
									<span>{item.text}</span>
								</div>
							);
						case "agent":
							return (
								<div class="lab-msg lab-agent" key={`a${item.id}`}>
									{item.text}
								</div>
							);
						case "op":
							return (
								<div class="lab-op" key={`o${item.id}`}>
									<b>{item.name}</b> changed {item.title}: {item.summary} <span class="lab-version">v{item.version}</span>
								</div>
							);
						case "wake":
							return (
								<div class="lab-op lab-wake" key={`w${item.id}`}>
									The agent was told: {item.text}
								</div>
							);
						case "tool": {
							const element = titleOf(item.name);
							const action = element ? item.name.slice(element.id.length + 1) : item.name;
							const details = item.result?.details ?? {};
							const line = !item.result
								? `${element?.title ?? ""} ${action}…`
								: item.result.isError
									? `${element?.title ?? item.name}: ${item.result.text.split(". ").slice(0, 2).join(". ")}`
									: action === "read"
										? `Read ${element?.title} (v${String(details.version)})`
										: action === "history"
											? `Looked at ${element?.title}'s history`
											: `${element?.title ?? item.name}: ${String(details.summary ?? item.result.text.slice(0, 120))}`;
							return (
								<details class={`lab-tool${item.result?.isError ? " lab-error" : ""}${props.flash === item.id ? " lab-flash" : ""}`} id={`tool-${item.id}`} key={item.id}>
									<summary>
										<span class="lab-tool-mark">{item.result?.isError ? "✕" : action === "read" || action === "history" ? "○" : "●"}</span>
										{line}
										{details.version !== undefined && !item.result?.isError && action !== "read" && action !== "history" ? <span class="lab-version">v{String(details.version)}</span> : null}
									</summary>
									<pre>{`${item.name} ${JSON.stringify(item.args)}\n\n${item.result?.text ?? ""}`}</pre>
								</details>
							);
						}
					}
				})}
				{props.busy ? <div class="muted lab-working">Working…</div> : null}
			</div>
			<form
				class="lab-composer"
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<textarea
					rows={2}
					value={text}
					placeholder={props.faux ? 'Write to the agent. The test model calls a tool when you write: tool calendar_read {}' : "Write to the agent…"}
					onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				<button type="submit" class="button primary">Send</button>
			</form>
		</section>
	);
}

render(<Lab />, document.getElementById("app")!);
