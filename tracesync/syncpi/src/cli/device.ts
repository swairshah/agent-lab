// This machine as the place where your own requests run. When you write to the agent from this terminal, its tools
// run here, in your synced copy of the project, through pi-env's daemon: the session server tunnels pi-env's protocol
// over this client's WebSocket. Nobody else's requests run here.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { hostname } from "node:os";
import { localDaemon } from "@earendil-works/pi-env";
import { channelFrame, parseChannelFrame, type ServerMessage } from "../shared/protocol.ts";
import type { Connection } from "./client.ts";
import type { Mirror } from "./sync.ts";

export class LocalDevice {
	readonly #conn: Connection;
	readonly #mirror: Mirror;
	readonly #daemons = new Map<number, ChildProcessWithoutNullStreams>();
	/** Tool activity on this machine, for the UI. */
	onActivity: (running: number) => void = () => {};

	constructor(conn: Connection, mirror: Mirror) {
		this.#conn = conn;
		this.#mirror = mirror;
	}

	/** Offers this machine on every (re)connect; the server forgets devices when their connection closes. */
	register(): void {
		this.#conn.send({ type: "device", device: { hostname: hostname().replace(/\.local$/, ""), platform: process.platform, arch: process.arch, dir: this.#mirror.dir } });
	}

	/** Handles device messages; returns false for messages that are not about the device. */
	handle(message: ServerMessage): boolean {
		switch (message.type) {
			case "envOpen":
				this.#open(message.channel, message.args);
				return true;
			case "envClose":
				this.#daemons.get(message.channel)?.kill();
				this.#daemons.delete(message.channel);
				this.onActivity(this.#daemons.size);
				return true;
			case "fence":
				void this.#mirror.fence(message.mode, message.version).then(
					() => this.#conn.send({ type: "fenceDone", id: message.id }),
					(error: Error) => this.#conn.send({ type: "fenceDone", id: message.id, error: error.message }),
				);
				return true;
			default:
				return false;
		}
	}

	binary(data: Buffer): void {
		const { channel, bytes } = parseChannelFrame(data);
		this.#daemons.get(channel)?.stdin.write(bytes);
	}

	#open(channel: number, args: string[]): void {
		// pi-env asks for `serve --token <hex>`; nothing else is accepted from the server.
		if (args.length !== 3 || args[0] !== "serve" || args[1] !== "--token" || !/^[0-9a-f]+$/i.test(args[2] ?? "")) {
			this.#conn.send({ type: "envClose", channel });
			return;
		}
		const daemon = spawn(localDaemon(), args, { cwd: this.#mirror.dir, stdio: ["pipe", "pipe", "pipe"] });
		this.#daemons.set(channel, daemon);
		this.onActivity(this.#daemons.size);
		daemon.stdout.on("data", (chunk: Buffer) => this.#conn.sendBinary(channelFrame(channel, chunk)));
		daemon.stderr.resume();
		daemon.stdin.on("error", () => {});
		daemon.on("error", () => this.#conn.send({ type: "envClose", channel }));
		daemon.on("exit", () => {
			if (this.#daemons.get(channel) !== daemon) return;
			this.#daemons.delete(channel);
			this.onActivity(this.#daemons.size);
			this.#conn.send({ type: "envClose", channel });
		});
	}

	/** The connection dropped: the server closed our channels too, and pi-env reconnects later. */
	disconnected(): void {
		for (const daemon of this.#daemons.values()) daemon.kill();
		this.#daemons.clear();
		this.onActivity(0);
	}
}
