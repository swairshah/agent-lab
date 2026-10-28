// Members' own machines as execution environments. A terminal client registers its machine (`device`), and requests
// that member sends run their tools there, in that member's synced copy of the project:
//
//   pi-durable tool call → RemoteExecutionEnv (pi-env) → Connection spawns relay.mjs
//     → local socket → this server → the member's WebSocket (binary frames, one channel per daemon)
//     → their syncpi client → pi-env daemon on their machine
//
// pi-env does the work: file operations and commands with Node's semantics, streaming, cancellation, and reconnecting
// after a lost connection. This module only routes bytes and keeps the copies in step (fences) before tools run.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { WebSocket } from "ws";
import { channelFrame, type DeviceInfo, type ServerMessage } from "../shared/protocol.ts";

export type DeviceClient = {
	memberId: string;
	name: string;
	ws: WebSocket;
	send(message: ServerMessage): void;
};

type Device = { client: DeviceClient; info: DeviceInfo };

const RELAY = join(dirname(fileURLToPath(import.meta.url)), "relay.mjs");

export class Devices {
	readonly #socketPath: string;
	/** Relays prove they were started by this server; the socket is also in a directory only this user can enter. */
	readonly #secret = randomBytes(24).toString("hex");
	readonly #server: Server;
	readonly #devices = new Map<string, Device>();
	readonly #channels = new Map<number, { socket: Socket; client: DeviceClient }>();
	readonly #envs = new Map<string, { dir: string; connection: Connection; env: RemoteExecutionEnv }>();
	readonly #fences = new Map<number, (error?: string) => void>();
	#nextChannel = 1;
	#nextFence = 1;

	constructor(stateDir: string) {
		// Socket paths are limited to about 104 bytes, so the socket lives in a short private directory.
		const dir = `/tmp/syncpi-${process.getuid?.() ?? 0}`;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const info = lstatSync(dir);
		if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error(`${dir} is not a private directory`);
		chmodSync(dir, 0o700);
		this.#socketPath = join(dir, `${createHash("sha1").update(stateDir).digest("hex").slice(0, 12)}.sock`);
		rmSync(this.#socketPath, { force: true });
		this.#server = createServer((socket) => this.#relay(socket));
		this.#server.listen(this.#socketPath);
	}

	/** A terminal client offers its machine. The newest client of a member wins. */
	register(client: DeviceClient, info: DeviceInfo): void {
		this.#devices.set(client.memberId, { client, info });
	}

	/** A client went away: its tunnels close, so pi-env sees a lost connection and reconnects when it comes back. */
	unregister(client: DeviceClient): void {
		const device = this.#devices.get(client.memberId);
		if (device?.client === client) this.#devices.delete(client.memberId);
		for (const [channel, entry] of this.#channels) {
			if (entry.client !== client) continue;
			this.#channels.delete(channel);
			entry.socket.destroy();
		}
	}

	/** The pi setup a member's machine offered, used while their request runs there. */
	context(memberId: string): DeviceInfo["context"] {
		return this.#devices.get(memberId)?.info.context;
	}

	online(memberId: string): DeviceInfo | undefined {
		return this.#devices.get(memberId)?.info;
	}

	label(memberId: string): string | undefined {
		const device = this.#devices.get(memberId);
		return device === undefined ? undefined : `${device.client.name}'s machine (${device.info.hostname}, ${device.info.platform} ${device.info.arch})`;
	}

	list(): { memberId: string; info: DeviceInfo }[] {
		return [...this.#devices].map(([memberId, d]) => ({ memberId, info: d.info }));
	}

	/** The execution environment on a member's machine, in their copy of the project. */
	env(memberId: string): RemoteExecutionEnv {
		const device = this.#devices.get(memberId);
		if (device === undefined) throw new Error("device offline");
		const cached = this.#envs.get(memberId);
		if (cached !== undefined && cached.dir === device.info.dir) return cached.env;
		cached?.connection.close();
		const connection = new Connection({ command: [process.execPath, RELAY, this.#socketPath, this.#secret, memberId] });
		const env = new RemoteExecutionEnv({ connection, id: `syncpi-device:${memberId}`, cwd: device.info.dir });
		this.#envs.set(memberId, { dir: device.info.dir, connection, env });
		return env;
	}

	/** Asks a member's client to bring its copy in step; resolves when it has, or after a timeout. */
	fence(memberId: string, mode: "flush" | "pull", version: number, timeoutMs = 20_000): Promise<void> {
		const device = this.#devices.get(memberId);
		if (device === undefined) return Promise.resolve();
		const id = this.#nextFence++;
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.#fences.delete(id);
				resolve();
			}, timeoutMs);
			this.#fences.set(id, () => {
				clearTimeout(timer);
				this.#fences.delete(id);
				resolve();
			});
			device.client.send({ type: "fence", id, mode, version });
		});
	}

	fenceDone(id: number): void {
		this.#fences.get(id)?.();
	}

	/** Bytes from a client's daemon. */
	fromClient(client: DeviceClient, channel: number, bytes: Uint8Array): void {
		const entry = this.#channels.get(channel);
		if (entry?.client === client) entry.socket.write(bytes);
	}

	clientClosedChannel(client: DeviceClient, channel: number): void {
		const entry = this.#channels.get(channel);
		if (entry?.client !== client) return;
		this.#channels.delete(channel);
		entry.socket.end();
	}

	/** A relay process connected: route it to the member's client as a new channel. */
	#relay(socket: Socket): void {
		let header = "";
		const onData = (chunk: Buffer) => {
			header += chunk.toString("latin1");
			const newline = header.indexOf("\n");
			if (newline < 0) return;
			socket.off("data", onData);
			const rest = Buffer.from(header.slice(newline + 1), "latin1");
			let request: { secret: string; memberId: string; args: string[] };
			try {
				request = JSON.parse(header.slice(0, newline)) as typeof request;
			} catch {
				socket.destroy();
				return;
			}
			const given = Buffer.from(String(request.secret));
			const expected = Buffer.from(this.#secret);
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
				socket.destroy();
				return;
			}
			const device = this.#devices.get(request.memberId);
			if (device === undefined) {
				socket.destroy();
				return;
			}
			const channel = this.#nextChannel++;
			const client = device.client;
			this.#channels.set(channel, { socket, client });
			client.send({ type: "envOpen", channel, args: request.args });
			const forward = (bytes: Uint8Array) => {
				if (client.ws.readyState === client.ws.OPEN) client.ws.send(channelFrame(channel, bytes));
			};
			if (rest.length > 0) forward(rest);
			socket.on("data", forward);
			socket.on("close", () => {
				if (this.#channels.get(channel)?.socket !== socket) return;
				this.#channels.delete(channel);
				client.send({ type: "envClose", channel });
			});
			socket.on("error", () => socket.destroy());
		};
		socket.on("data", onData);
	}

	close(): void {
		for (const { connection } of this.#envs.values()) connection.close();
		this.#server.close();
		rmSync(this.#socketPath, { force: true });
	}
}
