// syncpi as a library, for clients other than its own (the pi extension in ../syncpi-extension): starting or
// rejoining a folder's session, a live connection to it with the folder kept in sync and this machine as the
// person's device, and the protocol and thread model. Built to dist/client.mjs, exported as `syncpi/client`.
import { fileURLToPath } from "node:url";
import { Connection } from "../cli/client.ts";
import { LocalDevice } from "../cli/device.ts";
import { findByDir, retryProvision, type StartOptions, startSession, untilReady } from "../cli/lifecycle.ts";
import { loadPiContext } from "../cli/pi-context.ts";
import { ensureLocalRunning } from "../cli/provision.ts";
import type { SessionRecord } from "../cli/store.ts";
import { Mirror } from "../cli/sync.ts";
import type { ServerMessage } from "../shared/protocol.ts";

export type * from "../shared/protocol.ts";
export { type Item, Thread, type ThreadState, toolSummary } from "../shared/thread.ts";
export { Connection, findByDir, LocalDevice, Mirror, type SessionRecord, type StartOptions };

/** A file built next to this bundle in dist/. */
function bundled(name: string): string {
	return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/**
 * The session of `dir`: the one started (or joined) there, or a new one, which starts being set up in the background.
 * A session whose setup failed is set up again.
 */
export async function openSession(dir: string, options: StartOptions = {}): Promise<SessionRecord> {
	const record = findByDir(dir) ?? (await startSession(dir, options, bundled("cli.mjs")));
	if (record.status !== "failed") return record;
	if (record.role !== "owner" || record.setup === undefined) throw new Error(`this folder's session could not be set up: ${record.error}`);
	return retryProvision(record, bundled("cli.mjs"));
}

/** Resolves once the session's server is up (a local one is started again if it isn't running). */
export async function whenReady(record: SessionRecord, onStep: (step: string) => void = () => {}): Promise<SessionRecord> {
	const ready = await untilReady(record.id, onStep);
	if (ready.compute === "local" && ready.localRoot !== undefined) await ensureLocalRunning(ready.localRoot, ready.url, onStep);
	return ready;
}

/**
 * A live session: one connection, the session's folder kept in sync with this machine's copy, and this machine as
 * the person's device (requests they send to run here, from any of their clients, run here). Every server message
 * reaches `onMessage`, after file sync and the device have taken theirs.
 */
export class LiveSession {
	readonly record: SessionRecord;
	readonly conn: Connection;
	readonly mirror: Mirror;
	readonly device: LocalDevice;
	onMessage: (message: ServerMessage) => void = () => {};

	constructor(record: SessionRecord) {
		this.record = record;
		this.conn = new Connection(record.url, record.token);
		this.mirror = new Mirror(record.id, record.dir, this.conn);
		this.device = new LocalDevice(this.conn, this.mirror);
		this.conn.onOpen = () => this.device.register();
		this.conn.onBinary = (data) => this.device.binary(data);
		this.conn.onState = (state) => {
			if (state === "closed") this.device.disconnected();
		};
		this.conn.onMessage = (message) => {
			if (this.device.handle(message)) return;
			if (message.type === "files") this.mirror.remoteChanged(message.full === true, message.changed, message.version);
			if (message.type === "welcome") this.mirror.readOnly = message.me.role === "viewer";
			this.onMessage(message);
		};
		// Your pi setup (skills, AGENTS.md), offered with this machine for the requests that run here.
		void loadPiContext(record.dir, bundled("pi-context.mjs")).then(({ prompts: _, ...offered }) => this.device.setContext(offered));
	}

	start(): void {
		this.mirror.start();
		this.conn.start();
	}

	close(): void {
		this.mirror.stop();
		this.device.disconnected();
		this.conn.close();
	}
}
