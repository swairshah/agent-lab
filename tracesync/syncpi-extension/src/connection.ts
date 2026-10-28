// The extension's connection to a syncpi session server: one WebSocket (Node's built-in client) that reconnects on
// its own, each time starting from a fresh snapshot, plus the file API that sync uses and the invite exchange.
import type { ClientMessage, FileHash, ServerMessage } from "./shared/protocol.ts";

export type ConnectionState = "connecting" | "open" | "closed";

/** WebSocket close code the server uses for a member who was removed. */
const REMOVED = 4001;

export class Connection {
	readonly url: string;
	readonly token: string;
	state: ConnectionState = "connecting";
	onMessage: (message: ServerMessage) => void = () => {};
	/** Binary frames: tunnel bytes for a pi-env daemon on this machine. */
	onBinary: (data: Buffer) => void = () => {};
	/** Called on every (re)connect, before queued messages are sent. */
	onOpen: () => void = () => {};
	onState: (state: ConnectionState, detail?: string) => void = () => {};
	#ws: WebSocket | undefined;
	#closed = false;
	#retry = 0;
	#outbox: ClientMessage[] = [];

	constructor(url: string, token: string) {
		this.url = url.replace(/\/$/, "");
		this.token = token;
	}

	get queued(): number {
		return this.#outbox.length;
	}

	start(): void {
		this.#open();
	}

	#open(): void {
		const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws?client=cli&token=${encodeURIComponent(this.token)}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		this.#setState("connecting");
		ws.onopen = () => {
			this.#retry = 0;
			this.#setState("open");
			this.onOpen();
			for (const message of this.#outbox.splice(0)) ws.send(JSON.stringify(message));
		};
		ws.onmessage = (event) => {
			if (typeof event.data !== "string") {
				this.onBinary(Buffer.from(event.data as ArrayBuffer));
				return;
			}
			try {
				this.onMessage(JSON.parse(event.data) as ServerMessage);
			} catch (error) {
				this.onState(this.state, `bad frame: ${String(error)}`);
			}
		};
		ws.onclose = (event) => {
			if (this.#ws !== ws) return;
			if (event.code === REMOVED) this.#closed = true;
			this.#setState("closed", event.code === REMOVED ? "removed from the session" : undefined);
			if (this.#closed) return;
			const delay = Math.min(15_000, 500 * 2 ** this.#retry++);
			setTimeout(() => !this.#closed && this.#open(), delay);
		};
	}

	#setState(state: ConnectionState, detail?: string): void {
		this.state = state;
		this.onState(state, detail);
	}

	/** Sends now, or once the connection is back. Submits carry request IDs, so a resend never posts twice. */
	send(message: ClientMessage): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
		else this.#outbox.push(message);
	}

	/** Sends binary data now, or drops it: tunnel bytes are useless on a new connection. */
	sendBinary(data: Uint8Array): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(data);
	}

	close(): void {
		this.#closed = true;
		this.#ws?.close();
	}

	async #fetch(path: string, init: RequestInit = {}): Promise<Response> {
		return fetch(`${this.url}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.token}` } });
	}

	async getFile(path: string): Promise<{ bytes: Buffer; hash: string } | undefined> {
		const res = await this.#fetch(`/api/file?path=${encodeURIComponent(path)}`);
		if (res.status === 404) return undefined;
		if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
		return { bytes: Buffer.from(await res.arrayBuffer()), hash: res.headers.get("x-hash") ?? "" };
	}

	/** Compare-and-swap write: `ok` false means the server's copy is no longer `base`; `hash` is what it has instead. */
	async putFile(path: string, base: FileHash, bytes: Buffer): Promise<{ ok: boolean; hash: FileHash }> {
		const res = await this.#fetch(`/api/file?path=${encodeURIComponent(path)}&base=${base ?? "none"}`, { method: "PUT", body: new Uint8Array(bytes) });
		if (res.status !== 200 && res.status !== 409) throw new Error(`PUT ${path}: ${res.status} ${await res.text()}`);
		const body = (await res.json()) as { hash: FileHash };
		return { ok: res.status === 200, hash: body.hash };
	}

	async deleteFile(path: string, base: string): Promise<{ ok: boolean; hash: FileHash }> {
		const res = await this.#fetch(`/api/file?path=${encodeURIComponent(path)}&base=${base}`, { method: "DELETE" });
		if (res.status !== 200 && res.status !== 409) throw new Error(`DELETE ${path}: ${res.status}`);
		const body = (await res.json()) as { hash: FileHash };
		return { ok: res.status === 200, hash: body.hash };
	}

	async snapshot(): Promise<Response> {
		const res = await this.#fetch("/api/snapshot.tgz");
		if (!res.ok) throw new Error(`snapshot: ${res.status}`);
		return res;
	}
}

/**
 * Trades an invite for a member token. A link invite answers at once. An email invite needs the invitee to sign in to
 * exe.dev as that email: `onBrowser` gets a page to open and a short code to compare there, and this waits for the
 * approval.
 */
export async function join(
	origin: string,
	invite: string,
	name: string,
	onBrowser: (url: string, check: string, forEmail?: string) => void,
	signal?: AbortSignal,
): Promise<{ token: string }> {
	const res = await fetch(`${origin}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite, name }) });
	const body = (await res.json()) as { token?: string; error?: string; login?: boolean; email?: string };
	if (res.ok && body.token !== undefined) return { token: body.token };
	if (res.status !== 401 || body.login !== true) throw new Error(body.error ?? `join failed: ${res.status}`);

	const start = (await (
		await fetch(`${origin}/api/cli-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite, name }) })
	).json()) as { code: string; check: string; url: string };
	onBrowser(start.url, start.check, body.email);
	const deadline = Date.now() + 10 * 60_000;
	while (Date.now() < deadline && signal?.aborted !== true) {
		await new Promise((r) => setTimeout(r, 2_000));
		const poll = await fetch(`${origin}/api/cli-login/${start.code}`).catch(() => undefined);
		if (poll === undefined) continue;
		const state = (await poll.json()) as { status: string; token?: string; error?: string };
		if (state.status === "approved" && state.token !== undefined) return { token: state.token };
		if (state.status === "denied") throw new Error(state.error ?? "sign-in was refused");
		if (state.status === "expired") break;
	}
	throw new Error("the browser sign-in expired; run /sync join again");
}
