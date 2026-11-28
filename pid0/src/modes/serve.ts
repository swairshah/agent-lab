import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "../config.ts";
import type { Pid0Session } from "../session.ts";
import type { Subagents } from "../subagents.ts";
import { type Command, createRpc } from "./rpc.ts";

export type ServeOptions = { host: string; port: number; subagents?: Subagents; log?: (line: string) => void };
export type Served = { url: string; port: number; clients(): number; close(): Promise<void> };

const STATE_EVENTS = new Set(["agent_start", "agent_settled", "model_changed", "harness_changed", "mode_changed", "thinking_level_changed", "session_changed", "session_info_changed", "usage_update", "queue_update", "compaction_end"]);

const page = () => readFileSync(new URL("./web.html", import.meta.url));

export async function serve(session: Pid0Session, options: ServeOptions): Promise<Served> {
	const clients = new Set<ServerResponse>();
	const broadcast = (record: unknown) => {
		const frame = `data: ${JSON.stringify(record)}\n\n`;
		for (const client of clients) client.write(frame);
	};
	const state = () => ({ ...session.state, totals: session.totals, permissions: session.permissions, version: VERSION });
	session.subscribe((event) => {
		broadcast(event);
		if (STATE_EVENTS.has(event.type)) broadcast({ type: "state", state: state() });
	});
	options.subagents?.subscribe((event) => broadcast(event));
	const rpc = createRpc(session, broadcast, options.subagents ? { subagents: options.subagents } : {});

	const server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0];
		if (request.method === "GET" && (path === "/" || path === "/index.html")) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page());
			return;
		}
		if (request.method === "GET" && path === "/events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
			response.write(`data: ${JSON.stringify({ type: "state", state: state() })}\n\n`);
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (request.method === "POST" && path === "/rpc") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
				if (body.length > 32 * 1024 * 1024) request.destroy();
			});
			request.on("end", () => {
				void (async () => {
					let command: Command;
					try {
						command = JSON.parse(body);
					} catch {
						response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "response", command: "parse", success: false, error: "the body is not JSON" }));
						return;
					}
					const result = command.type === "get_state" ? { type: "response", command: "get_state", success: true, data: state() } : await rpc.run(command);
					response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result ?? { type: "response", command: command.type, success: true }));
				})();
			});
			return;
		}
		response.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, resolve);
	});
	const ping = setInterval(() => {
		for (const client of clients) client.write(": ping\n\n");
	}, 20_000);
	ping.unref();
	const port = (server.address() as AddressInfo).port;
	const shown = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host.includes(":") ? `[${options.host}]` : options.host;
	return {
		url: `http://${shown}:${port}`,
		port,
		clients: () => clients.size,
		close: async () => {
			clearInterval(ping);
			for (const client of clients) client.end();
			clients.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export async function runServe(session: Pid0Session, options: ServeOptions): Promise<number> {
	const served = await serve(session, options);
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	log(`pid0 ${VERSION} serving ${session.label()} in ${session.cwd}`);
	log(`  web:    ${served.url}/`);
	log(`  attach: pid0 attach ${served.url}`);
	if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") log("  no sign-in is required: anyone who can reach this address can run commands here as this user");
	await new Promise<void>((resolve) => {
		process.once("SIGTERM", resolve);
		process.once("SIGINT", resolve);
		process.once("SIGHUP", resolve);
	});
	log("pid0: stopping");
	await served.close();
	return 0;
}
