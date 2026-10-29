// The session's one process: it owns the store (pi-durable allows one process per storage), and agents' hooks, the
// Codex and pi commands and the web view all reach it over HTTP on localhost, with the token in server.json.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AgentKind } from "./protocol.ts";
import { Busy, excludeFromGit, Store } from "./store.ts";

export type ServerInfo = { port: number; token: string; pid: number; project: string };

type HookPayload = { session_id?: string; transcript_path?: string; hook_event_name?: string; cwd?: string };

/** What a Claude Code hook prints and how it exits. */
type HookAnswer = { stdout?: string };

export async function serve(project: string, options: { model?: string; faux?: boolean } = {}): Promise<void> {
	const dir = join(project, ".session-share");
	const store = new Store({ dir, project, ...options });
	await store.open();
	excludeFromGit(project);
	const token = randomBytes(18).toString("base64url");
	const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

	async function hook(agent: AgentKind, member: string | undefined, p: HookPayload): Promise<HookAnswer> {
		const session = p.session_id;
		if (!session) return {};
		switch (p.hook_event_name) {
			case "SessionStart":
				await store.register(agent, session, p.transcript_path, member);
				return {};
			case "UserPromptSubmit": {
				await store.register(agent, session, p.transcript_path, member);
				try {
					const told = await store.begin(agent, session, member);
					log(`${agent} ${session} took the turn${told ? ` (told ${told.length} characters)` : ""}`);
					if (!told) return {};
					return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: told } }) };
				} catch (error) {
					if (error instanceof Busy) return { stdout: JSON.stringify({ decision: "block", reason: error.message }) };
					throw error;
				}
			}
			case "PostToolUse":
				await store.record(session);
				await store.heartbeat(session);
				return {};
			case "Stop":
			case "SessionEnd":
				await store.end(session);
				log(`${agent} ${session} gave the turn back`);
				return {};
			default:
				return {};
		}
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			log(`error ${req.method} ${req.url}: ${error instanceof Error ? error.stack : error}`);
			send(res, 500, { error: String(error instanceof Error ? error.message : error) });
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(readFileSync(new URL("./view.html", import.meta.url)));
			return;
		}
		if ((req.headers["x-session-share-token"] ?? url.searchParams.get("token")) !== token) return send(res, 401, { error: "bad token" });
		const body = req.method === "POST" ? await readJson(req) : {};
		switch (`${req.method} ${url.pathname}`) {
			case "GET /health":
				return send(res, 200, { ok: true, project });
			case "POST /hook":
				return send(res, 200, await hook(body.agent, body.member, body.payload ?? {}));
			case "POST /turn/begin":
				try {
					if (body.transcript) await store.register(body.agent, body.session, body.transcript, body.member);
					return send(res, 200, { context: (await store.begin(body.agent, body.session, body.member)) ?? null });
				} catch (error) {
					if (error instanceof Busy) return send(res, 409, { error: error.message, holder: error.holder });
					throw error;
				}
			case "POST /turn/heartbeat":
				await store.heartbeat(body.session);
				return send(res, 200, {});
			case "POST /turn/end":
				if (body.adopt) await store.adopt(body.session, body.adopt, body.transcript);
				await store.end(body.adopt ?? body.session);
				return send(res, 200, {});
			case "POST /pi": {
				res.writeHead(200, { "content-type": "application/x-ndjson" });
				try {
					const answer = await store.runPi(String(body.prompt), body.member ?? "someone", (item) => res.write(`${JSON.stringify({ item })}\n`));
					res.end(`${JSON.stringify({ answer })}\n`);
				} catch (error) {
					res.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
				}
				return;
			}
			case "POST /checkpoint":
				return send(res, 200, await store.checkpoint(String(body.label), body.by ?? "someone"));
			case "GET /checkpoints":
				return send(res, 200, { checkpoints: await store.checkpoints() });
			case "GET /items": {
				await store.recordAll();
				return send(res, 200, { items: await store.items(Number(url.searchParams.get("after") ?? 0)), lease: await store.lease() });
			}
			case "POST /stop":
				send(res, 200, {});
				setTimeout(() => void shutdown(), 50);
				return;
			default:
				return send(res, 404, { error: "not found" });
		}
	}

	// While Claude Code or Codex holds the turn, their transcripts are recorded as they grow, so views follow live.
	const tick = setInterval(() => {
		void store.lease().then((h) => (h && h.agent !== "pi" ? store.record(h.session) : 0)).catch(() => {});
	}, 1_000);

	const info = (port: number): ServerInfo => ({ port, token, pid: process.pid, project });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	writeFileSync(join(dir, "server.json"), `${JSON.stringify(info(port), null, 2)}\n`, { mode: 0o600 });
	log(`serving ${project} on http://127.0.0.1:${port}`);

	async function shutdown(): Promise<void> {
		clearInterval(tick);
		server.close();
		rmSync(join(dir, "server.json"), { force: true });
		await store.close();
		process.exit(0);
	}
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
}

function send(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}
