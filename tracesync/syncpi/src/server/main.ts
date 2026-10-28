// syncpi server. Two ways to run it:
//   --state <dir>      one session at the server's root (a local session, or a session with a VM of its own)
//   --sessions <dir>   a shared host: every session in <dir>/<id>/ is served under /<id>/. The CLI creates a session
//                      by writing its directory over SSH; the server opens it on first use, closes it when idle, and
//                      drops it when its directory is removed.
import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import { json, Room } from "./room.ts";

const { values: args } = parseArgs({
	options: {
		state: { type: "string" },
		sessions: { type: "string" },
		port: { type: "string", default: "8000" },
		host: { type: "string", default: "0.0.0.0" },
		web: { type: "string" },
		faux: { type: "boolean", default: false },
	},
});
if (args.state === undefined && args.sessions === undefined) throw new Error("--state <dir> or --sessions <dir> is required");
const webDir = args.web ?? join(dirname(fileURLToPath(import.meta.url)), "web");
const faux = args.faux || process.env.SYNCPI_FAUX === "1";

/** Rooms closed for this long with nobody in them and nothing running are closed until someone comes back. */
const IDLE_MS = 15 * 60_000;
const ID = /^[a-z0-9]{4,32}$/;

const rooms = new Map<string, Promise<Room>>();

/** The room for a session id on a shared host, opened if its directory exists. */
function roomFor(id: string): Promise<Room> | undefined {
	const existing = rooms.get(id);
	if (existing !== undefined) return existing;
	if (args.sessions === undefined || !ID.test(id)) return undefined;
	const dir = join(args.sessions, id);
	if (!existsSync(join(dir, "server.json"))) return undefined;
	const opening = (async () => {
		const room = new Room(dir, `/${id}`, webDir, faux);
		await room.open();
		return room;
	})();
	rooms.set(id, opening);
	opening.catch((error) => {
		console.error(`session ${id} failed to open`, error);
		rooms.delete(id);
	});
	return opening;
}

let single: Room | undefined;
if (args.state !== undefined) {
	single = new Room(args.state, "", webDir, faux);
	await single.open();
} else {
	// Open every session once, so work a restart interrupted resumes; idle ones close again later.
	for (const id of readdirSync(args.sessions!)) void roomFor(id)?.catch(() => {});
}

/** The room a path belongs to, and the path inside it. */
async function route(path: string): Promise<{ room: Room; rest: string } | undefined> {
	if (single !== undefined) return { room: single, rest: path };
	const match = path.match(/^\/([^/]+)(\/.*)?$/);
	if (match === null) return undefined;
	const room = roomFor(match[1]!);
	if (room === undefined) return undefined;
	return { room: await room, rest: match[2] ?? "" };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://x");
	if (single === undefined && url.pathname === "/healthz") return json(res, 200, { ok: true, host: true });
	const found = await route(url.pathname);
	if (found === undefined) return json(res, 404, { error: "no such session" });
	// /<id> → /<id>/, so the web view's relative URLs resolve inside the session.
	if (found.rest === "") {
		res.writeHead(301, { location: `${url.pathname}/${url.search}` });
		return void res.end();
	}
	await found.room.http(req, res, found.rest, url);
}

const server = createServer((req, res) => {
	handle(req, res).catch((error: Error & { status?: number }) => {
		if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
		else res.destroy();
	});
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://x");
	void route(url.pathname)
		.then((found) => {
			const member = found?.rest === "/ws" ? found.room.member(url.searchParams.get("token") ?? undefined) : undefined;
			if (found === undefined || member === undefined) {
				socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
				return;
			}
			const kind = url.searchParams.get("client") === "cli" ? "cli" : "web";
			wss.handleUpgrade(req, socket, head, (ws) => void found.room.connect(ws, member, kind));
		})
		.catch(() => socket.destroy());
});

// Keeps idle connections alive through proxies, and finds dead ones. On a host, closes idle and removed sessions.
setInterval(async () => {
	if (single !== undefined) return single.pingClients();
	for (const [id, pending] of rooms) {
		try {
			const room = await pending;
			if (!existsSync(join(room.stateDir, "server.json"))) {
				rooms.delete(id);
				await room.close("session removed");
			} else if (await room.idle(IDLE_MS)) {
				rooms.delete(id);
				await room.close();
			} else room.pingClients();
		} catch {}
	}
}, 25_000);

server.listen(Number(args.port), args.host, () => {
	console.log(single !== undefined ? `syncpi session "${single.state.value.name}" on ${args.host}:${args.port}` : `syncpi host for ${args.sessions} on ${args.host}:${args.port}`);
});

async function shutdown(): Promise<void> {
	server.close();
	if (single !== undefined) await single.close("restarting");
	for (const pending of rooms.values()) await (await pending.catch(() => undefined))?.close("restarting");
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
