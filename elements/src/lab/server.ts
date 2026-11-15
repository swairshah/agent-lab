// The lab: one conversation with an agent, and the elements chosen for it, on a local page. People change the elements
// on the screen; the agent changes them with its tools; both are versions in each element's history.
//
// How each kind of change is recorded in the conversation (the session's transcript is the record of what happened):
//   - the agent's change is its tool call, whose result carries the element, the new version and the summary;
//   - a person's change is a `ui.op` entry written into the transcript (people see a line, the model does not), and
//     the agent learns of it from the "what changed" section at its next step;
//   - a person's change to an action marked `wakes` also messages the agent (a `ui.wake` input), so it acts on it now.
//
// HTTP: GET / (the page), GET /api/state, GET /api/transcript, POST /api/message, GET /api/events (server-sent events),
// GET /api/elements/:id/history, POST /api/elements/:id/act, POST /api/elements/:id/revert, POST /api/elements/:id/enable.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { type Conversation, createRegistry, defineExtension, type Extension, Harness, section, watchEvents } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { elementsAgent, toolNames } from "../agent.ts";
import type { Actor, ElementDef } from "../element.ts";
import { ElementStore, Refused } from "../store.ts";

export type LabOptions = { elements: readonly ElementDef<never>[]; on: string[]; model: string; port: number; dbPath: string; webDir: string };

const SCOPE = "lab";

/** The scripted model: `tool <name> <json>` makes it call that tool; anything else it repeats. */
function fauxModels(): MutableModels {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 400 });
	models.setProvider(faux.provider);
	type Message = { role: string; content: unknown; toolName?: string };
	const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("") : "");
	faux.setResponses(
		Array.from({ length: 10_000 }, () => (ctx: { messages: Message[] }) => {
			const last = ctx.messages.findLast((m) => m.role !== "system");
			const text = textOf(last?.content).replace(/^\[[^\]]+\]\s*/, "");
			if (last?.role === "toolResult") return fauxAssistantMessage(`(test model) ${last.toolName}: ${textOf(last.content).slice(0, 300)}`);
			const call = /^tool (\w+)\s*([\s\S]*)$/.exec(text);
			if (call) return fauxAssistantMessage([fauxToolCall(call[1]!, (call[2]!.trim() ? JSON.parse(call[2]!) : {}) as never)], { stopReason: "toolUse" });
			return fauxAssistantMessage(`(test model) ${text.slice(0, 200)}. Write "tool <name> <json>" to call a tool, or set OPENROUTER_API_KEY for a real model.`);
		}) as never,
	);
	return models;
}

/** OpenRouter, with no model asking for more than 16,000 tokens a step (a low balance refuses requests that reserve more). */
function realModels(): MutableModels {
	const models = createModels();
	const provider = openrouterProvider();
	const cap = <M extends object>(m: M): M => ("maxTokens" in m && typeof m.maxTokens === "number" && m.maxTokens > 16_000 ? { ...m, maxTokens: 16_000 } : m);
	models.setProvider(
		new Proxy(provider, {
			get(target, key) {
				if (key === "getModels") return () => target.getModels().map(cap);
				const value = Reflect.get(target, key, target) as unknown;
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		}) as Provider,
	);
	return models;
}

/** What the page shows of the transcript: people, the agent's words and tool calls, element changes, wake-ups. */
type Item =
	| { type: "person"; id: number; name: string; text: string; at: number }
	| { type: "agent"; id: number; text: string }
	| { type: "tool"; id: string; name: string; args: unknown; result?: { text: string; isError: boolean; details: Record<string, unknown> } }
	| { type: "op"; id: number; element: string; title: string; version: number; summary: string; name: string; at: number }
	| { type: "wake"; id: number; text: string };

export async function startLab(options: LabOptions) {
	const db = await openNodeSqliteDatabase(options.dbPath);
	const store = await ElementStore.open(db, options.elements);
	const on = new Set(options.on);
	const agent = elementsAgent({ store, scopeOf: () => SCOPE, enabled: () => [...on] });
	const base = defineExtension({
		name: "lab",
		sections: [
			section("role", () =>
				"You work with people on a shared screen. The elements on it (below) are theirs as much as yours: change one only when asked or when your task needs it, read it first, and say in a line what you changed. If a change is refused because the element changed, read it again and decide.",
			),
		],
	});
	const registry = createRegistry();
	registry.install(base);
	const installed = new Map<string, Extension>();
	const sync = () => {
		const wanted = new Map(agent.extensions().map((e) => [e.name, e]));
		for (const [name, e] of installed) if (!wanted.has(name)) (registry.uninstall(e), installed.delete(name));
		for (const [name, e] of wanted) if (!installed.has(name)) (registry.install(e), installed.set(name, e));
	};
	sync();

	const faux = options.model === "faux";
	const harness = await Harness.open(await SqliteStorage.open(db, { prefix: "pi_" }), { models: faux ? fauxModels() : realModels(), registry, settings: { toolExecution: "sequential" } }, context);
	const model = faux ? { provider: "faux", modelId: "faux-1" } : { provider: "openrouter", modelId: options.model };
	const root: Conversation = await harness.root(context, { agent: { model: model as never } });
	// A conversation kept from an earlier run keeps the model it had: this run's model applies from now on.
	await root.configure({ model: model as never }, context);

	// Everyone watching the page hears of every change.
	const clients = new Set<ServerResponse>();
	const tell = (event: string, data: unknown) => {
		for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	const stream = await watchEvents(harness, root.id, context);
	let busy = stream.snapshot.run !== undefined;
	stream.start(async (events) => {
		for (const event of events) {
			if (event.type === "run_start") busy = true;
			if (event.type === "run_end") busy = false;
		}
		tell("thread", { busy });
	});

	// A person's change: a line in the transcript, and the agent woken when the action says so.
	store.onChange(({ element, op }) => {
		tell("element", { element, version: op.version });
		if (op.actor.kind !== "person") return;
		const def = store.def(element);
		const data = { element, title: def.title, version: op.version, summary: op.summary, name: op.actor.name, at: op.at };
		void root.submit({ type: "write", entry: { kind: "ui.op", data: data as never } }, context).then(async () => {
			const wakes = op.action !== "revert" && def.actions[op.action]?.wakes === true;
			if (wakes) await root.submit({ type: "input", content: `[screen] ${op.actor.kind === "person" ? op.actor.name : ""} changed ${def.title} (now version ${op.version}): ${op.summary}.`, whenBusy: "followUp", entry: { kind: "ui.wake", data: { text: `${data.name} changed ${def.title}: ${op.summary}` } as never } }, context);
		});
	});

	async function transcript(): Promise<Item[]> {
		const page = await root.entries({ order: "ascending" }, 2000, undefined, context);
		const items: Item[] = [];
		const tools = new Map<string, Extract<Item, { type: "tool" }>>();
		for (const entry of page.items) {
			const data = entry.data as Record<string, unknown> | undefined;
			const message = entry.model?.[0] as { content?: unknown; toolCallId?: string; isError?: boolean; details?: Record<string, unknown>; stopReason?: string; errorMessage?: string } | undefined;
			const blocks = Array.isArray(message?.content) ? (message!.content as { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[]) : [];
			if (entry.kind === "lab.message") items.push({ type: "person", id: entry.id as number, name: String(data?.name), text: String(data?.text), at: Number(data?.at) });
			else if (entry.kind === "ui.op") items.push({ type: "op", id: entry.id as number, ...(data as Omit<Extract<Item, { type: "op" }>, "type" | "id">) });
			else if (entry.kind === "ui.wake") items.push({ type: "wake", id: entry.id as number, text: String(data?.text) });
			else if (entry.kind === "pi.assistant") {
				const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
				if (text) items.push({ type: "agent", id: entry.id as number, text });
				// A step that failed (the model provider refused, a key ran out) says so instead of showing nothing.
				if (message?.stopReason === "error") items.push({ type: "agent", id: entry.id as number, text: `The agent's step failed: ${message.errorMessage ?? "no reason given"}` });
				for (const b of blocks.filter((b) => b.type === "toolCall")) {
					const tool = { type: "tool" as const, id: b.id!, name: b.name!, args: b.arguments };
					tools.set(b.id!, tool);
					items.push(tool);
				}
			} else if (entry.kind === "pi.tool-result" && message?.toolCallId) {
				const tool = tools.get(message.toolCallId);
				if (tool) tool.result = { text: blocks.map((b) => b.text ?? "").join(""), isError: message.isError === true, details: message.details ?? {} };
			}
		}
		return items;
	}

	async function state() {
		return {
			busy,
			model: faux ? "test model" : options.model,
			elements: await Promise.all(
				store.elements().map(async (def) => {
					const { version, state } = await store.read(SCOPE, def.id);
					return { id: def.id, title: def.title, description: def.description, on: on.has(def.id), version, state, view: def.view(state, { now: Date.now() }), tools: toolNames(def) };
				}),
			),
		};
	}

	const json = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const body = (req: IncomingMessage) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				try {
					resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
				} catch (error) {
					reject(error);
				}
			});
		});
	const person = (b: Record<string, unknown>): Actor => {
		const name = String(b.name ?? "").trim() || "Someone";
		return { kind: "person", id: `p_${name.toLowerCase().replace(/\W+/g, "_")}`, name };
	};
	const STATIC: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/main.js": ["main.js", "text/javascript"], "/main.js.map": ["main.js.map", "application/json"], "/style.css": ["style.css", "text/css"] };

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://lab");
		const path = url.pathname;
		try {
			const file = STATIC[path];
			if (req.method === "GET" && file) {
				res.writeHead(200, { "content-type": file[1] });
				return res.end(readFileSync(join(options.webDir, file[0])));
			}
			if (req.method === "GET" && path === "/api/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				res.write(": hello\n\n");
				clients.add(res);
				req.on("close", () => clients.delete(res));
				return;
			}
			if (req.method === "GET" && path === "/api/state") return json(res, 200, await state());
			if (req.method === "GET" && path === "/api/transcript") return json(res, 200, { items: await transcript(), busy });
			if (req.method === "POST" && path === "/api/message") {
				const b = await body(req);
				const text = String(b.text ?? "").trim();
				if (text === "") return json(res, 400, { error: "Write something." });
				const who = person(b);
				await root.submit({ type: "input", content: `[${who.kind === "person" ? who.name : ""}] ${text}`, whenBusy: "followUp", entry: { kind: "lab.message", data: { name: who.kind === "person" ? who.name : "", text, at: Date.now() } as never } }, context);
				return json(res, 200, { ok: true });
			}
			const match = /^\/api\/elements\/([a-z0-9_]+)\/(history|act|revert|enable)$/.exec(path);
			if (match) {
				const [, id, what] = match as unknown as [string, string, string];
				const def = store.def(id);
				if (req.method === "GET" && what === "history") return json(res, 200, { ops: await store.history(SCOPE, def.id) });
				const b = await body(req);
				if (what === "enable") {
					if (b.on === true) on.add(def.id);
					else on.delete(def.id);
					sync();
					tell("element", { element: def.id });
					return json(res, 200, await state());
				}
				try {
					const op =
						what === "act"
							? await store.act(SCOPE, def.id, String(b.action), (b.args ?? {}) as Record<string, unknown>, person(b), typeof b.version === "number" ? b.version : undefined)
							: await store.revert(SCOPE, def.id, Number(b.to), person(b), typeof b.reason === "string" ? b.reason : undefined, typeof b.version === "number" ? b.version : undefined);
					return json(res, 200, { op });
				} catch (error) {
					return json(res, error instanceof Refused ? 409 : 400, { error: (error as Error).message, ...(error instanceof Refused ? { current: error.current } : {}) });
				}
			}
			json(res, 404, { error: "Not found" });
		} catch (error) {
			json(res, 500, { error: (error as Error).message });
		}
	});
	await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
	return {
		url: `http://localhost:${options.port}`,
		close: async () => {
			for (const res of clients) res.end();
			server.close();
			await stream.stop();
			await harness.close(context);
			await db.close();
		},
	};
}
