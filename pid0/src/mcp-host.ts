import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import { VERSION } from "./config.ts";

export type HostedTool = {
	name: string;
	description: string;
	inputSchema: unknown;
	call(args: Record<string, unknown>): Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
};

export class ToolServer {
	readonly name: string;
	readonly token = randomUUID();
	readonly #tools: () => HostedTool[];
	#server: Server | undefined;
	#mcp: McpServer | undefined;

	constructor(name: string, tools: () => HostedTool[]) {
		this.name = name;
		this.#tools = tools;
	}

	get mcp(): McpServer | undefined {
		return this.#mcp;
	}

	get url(): string | undefined {
		return (this.#mcp as { url?: string } | undefined)?.url;
	}

	async start(): Promise<void> {
		if (this.#server) return;
		const server = createServer((request, response) => {
			if (request.headers.authorization !== `Bearer ${this.token}`) {
				response.writeHead(401).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405, { Allow: "POST" }).end();
				return;
			}
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				void (async () => {
					let payload: unknown;
					try {
						payload = JSON.parse(body);
					} catch {
						response.writeHead(400).end();
						return;
					}
					const batch = Array.isArray(payload) ? payload : [payload];
					const replies = (await Promise.all(batch.map((message) => this.#rpc(message as Record<string, unknown>)))).filter((r) => r !== undefined);
					if (replies.length === 0) {
						response.writeHead(202).end();
						return;
					}
					response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
				})();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		server.unref();
		this.#server = server;
		const port = (server.address() as AddressInfo).port;
		this.#mcp = { type: "http", name: this.name, url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] } as McpServer;
	}

	async #rpc(message: Record<string, unknown>): Promise<unknown> {
		const id = message.id;
		const reply = (result: unknown) => (id === undefined ? undefined : { jsonrpc: "2.0", id, result });
		const params = (message.params ?? {}) as Record<string, unknown>;
		switch (message.method) {
			case "initialize":
				return reply({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: `pid0-${this.name}`, version: VERSION } });
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: this.#tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } })) });
			case "tools/call": {
				const tool = this.#tools().find((t) => t.name === params.name);
				if (!tool) return reply({ content: [{ type: "text", text: `unknown tool ${String(params.name)}` }], isError: true });
				try {
					const result = await tool.call((params.arguments ?? {}) as Record<string, unknown>);
					return reply({ content: result.content, isError: result.isError ?? false });
				} catch (error) {
					return reply({ content: [{ type: "text", text: (error as Error).message }], isError: true });
				}
			}
			default:
				return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
		}
	}

	close(): void {
		this.#server?.close();
		this.#server = undefined;
	}
}
