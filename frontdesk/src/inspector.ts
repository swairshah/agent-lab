import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationId } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { timingSafeEqual } from "node:crypto";
import { dbPath, host, textFrontendModel, token, voiceModel, workerModels, workspace } from "./config.ts";
import { WorkersDoc } from "./delegation.ts";
import { context, type Session } from "./harness.ts";

export type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export type InspectorOptions = {
	session: Session;
	frontend: "text" | "voice" | "none";
	port: number;
	routes?: Route[];
};

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export function openSse(req: IncomingMessage, res: ServerResponse, onClose: () => void) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.write(": connected\n\n");
	const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
	req.on("close", () => {
		clearInterval(ping);
		onClose();
	});
	return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function throttled<T>(send: (value: T) => void, ms: number): (value: T) => void {
	let pending: { value: T } | undefined;
	let timer: NodeJS.Timeout | undefined;
	return (value) => {
		pending = { value };
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (pending !== undefined) send(pending.value);
			pending = undefined;
		}, ms);
	};
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const COOKIE = "frontdesk_token";

function matches(candidate: string | undefined): boolean {
	if (candidate === undefined) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req: IncomingMessage, url: URL): string | undefined {
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ")) return header.slice(7);
	const cookie = req.headers.cookie
		?.split(";")
		.map((part) => part.trim().split("="))
		.find(([name]) => name === COOKIE)?.[1];
	return cookie !== undefined ? decodeURIComponent(cookie) : (url.searchParams.get("token") ?? undefined);
}

/** With FRONTDESK_TOKEN set, every request needs it: a bearer header (iOS), or a cookie set by opening /?token=… */
function authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
	if (token === "") return true;
	const presented = presentedToken(req, url);
	if (!matches(presented)) {
		sendJson(res, 401, { error: "unauthorized" });
		return false;
	}
	if (url.searchParams.has("token")) {
		res.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
	}
	return true;
}

async function listConversations(session: Session) {
	const { harness, root } = session;
	const state = await harness.snapshot(WorkersDoc, root.id, context);
	const busy = async (id: ConversationId) => (await harness.snapshot(LiveDoc, id, context))?.run !== undefined;
	const items: { id: ConversationId; label: string; kind: string; model?: string; busy: boolean; task?: string }[] = [
		{ id: root.id, label: "frontdesk (root)", kind: "root", busy: await busy(root.id) },
	];
	for (const [name, worker] of Object.entries(state?.workers ?? {})) {
		items.push({
			id: worker.conversationId,
			label: name,
			kind: "worker",
			model: `${worker.model.provider}/${worker.model.modelId}`,
			busy: await busy(worker.conversationId),
			task: worker.task,
		});
	}
	return items;
}

export async function startInspector(options: InspectorOptions): Promise<Server> {
	if (!LOOPBACK.has(host) && token === "") {
		throw new Error(`FRONTDESK_HOST=${host} exposes the server beyond this machine; set FRONTDESK_TOKEN too`);
	}
	const { session, frontend } = options;
	const { harness } = session;

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!authorize(req, res, url)) return;
		for (const route of options.routes ?? []) if (await route(req, res, url)) return;

		if (url.pathname === "/api/info") {
			return sendJson(res, 200, {
				frontend,
				rootId: session.root.id,
				db: dbPath,
				workspace,
				models: {
					text: `${textFrontendModel.provider}/${textFrontendModel.modelId}`,
					voice: voiceModel,
					opus: `${workerModels.opus.provider}/${workerModels.opus.modelId}`,
					sol: `${workerModels.sol.provider}/${workerModels.sol.modelId}`,
				},
			});
		}
		if (url.pathname === "/api/conversations") return sendJson(res, 200, await listConversations(session));
		if (url.pathname === "/api/usage") return sendJson(res, 200, await harness.usage(context));

		const match = /^\/api\/conversations\/(\d+)\/events$/.exec(url.pathname);
		if (match !== null) {
			const conversation = await harness.conversation(Number(match[1]) as ConversationId, context);
			if (conversation === undefined) return sendJson(res, 404, { error: "no such conversation" });
			const view = await conversation.viewState(context);
			let unsubscribe = () => {};
			const send = openSse(req, res, () => {
				unsubscribe();
				view.dispose();
			});
			send("view", view.value);
			unsubscribe = view.subscribe(throttled((value) => send("view", value), 120));
			return;
		}
		if (url.pathname === "/api/tasks/events") {
			const graph = await harness.taskGraph(context);
			let unsubscribe = () => {};
			const send = openSse(req, res, () => {
				unsubscribe();
				graph.dispose();
			});
			send("tasks", graph.value);
			unsubscribe = graph.subscribe(throttled((value) => send("tasks", value), 250));
			return;
		}

		const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
		if (/^[\w.-]+$/.test(file) && TYPES[extname(file)] !== undefined) {
			try {
				const body = await readFile(PUBLIC + file);
				res.writeHead(200, { "content-type": TYPES[extname(file)]! });
				return res.end(body);
			} catch {}
		}
		sendJson(res, 404, { error: "not found" });
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (!res.headersSent) sendJson(res, 500, { error: String(error) });
			else res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(options.port, host, resolve));
	return server;
}
