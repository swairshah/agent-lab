// Two-way sync between the session's workspace (on the VM) and a local folder.
//
// Both sides keep content hashes. `base` is the hash both sides last agreed on for each path. For a path:
//   local == remote               nothing to do
//   local == base (we didn't touch it)    take the remote version
//   remote == base (they didn't)          push ours (compare-and-swap on the server, so a race is caught)
//   both changed                          ours wins and is pushed; theirs is saved under ~/.syncpi/conflicts/<id>/
// Remote changes arrive as `files` frames on the WebSocket; local changes are found by rescanning every 1.5 s
// (unchanged files cost a stat, not a read).
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Scanner, safePath } from "../shared/files.ts";
import type { FileHash } from "../shared/protocol.ts";
import type { Connection } from "./client.ts";
import { conflictsDir, loadBase, saveBase } from "./store.ts";

export type SyncEvent =
	| { type: "pulled"; path: string; deleted: boolean }
	| { type: "pushed"; path: string; deleted: boolean }
	| { type: "conflict"; path: string; saved: string }
	| { type: "error"; message: string };

export class Mirror {
	readonly dir: string;
	readonly #id: string;
	readonly #conn: Connection;
	readonly #scanner: Scanner;
	readonly #base: Map<string, string>;
	#remote = new Map<string, string>();
	#ready = false;
	/** The newest server file version this copy has received. */
	#version = 0;
	#queue = new Set<string>();
	#running: Promise<void> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#saveTimer: NodeJS.Timeout | undefined;
	onEvent: (event: SyncEvent) => void = () => {};
	/** Viewers only receive changes; their local edits stay local. */
	readOnly = false;
	pulled = 0;
	pushed = 0;
	conflicts: string[] = [];

	constructor(id: string, dir: string, conn: Connection) {
		this.#id = id;
		this.dir = dir;
		this.#conn = conn;
		this.#scanner = new Scanner(dir);
		this.#base = loadBase(id);
	}

	/** Records the current local state as agreed, e.g. right after uploading or downloading the whole project. */
	static async adopt(id: string, dir: string): Promise<void> {
		saveBase(id, await new Scanner(dir).scan());
	}

	start(): void {
		this.#timer = setInterval(() => void this.#scanLocal(), 1_500);
	}

	stop(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#flushBase();
	}

	get pending(): number {
		return this.#queue.size;
	}

	/** A `files` frame from the server. */
	remoteChanged(full: boolean, changed: Record<string, FileHash>, version = 0): void {
		this.#version = Math.max(this.#version, version);
		if (full) {
			this.#remote = new Map(Object.entries(changed).filter((e): e is [string, string] => e[1] !== null));
			this.#ready = true;
			for (const path of new Set([...this.#remote.keys(), ...this.#base.keys()])) this.#queue.add(path);
			void this.#scanLocal();
		} else {
			for (const [path, hash] of Object.entries(changed)) {
				if (hash === null) this.#remote.delete(path);
				else this.#remote.set(path, hash);
				this.#queue.add(path);
			}
		}
		this.#kick();
	}

	/**
	 * Brings this copy in step before the agent's tools run on another machine (or here): local changes are pushed now,
	 * and for "pull" every server change up to `version` is applied. Resolves when done or after `timeoutMs`.
	 */
	async fence(mode: "flush" | "pull", version: number, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		await this.#scanLocal();
		const pending = () => this.#running !== undefined || this.#queue.size > 0 || (mode === "pull" && this.#version < version);
		while (pending() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
	}

	async #scanLocal(): Promise<void> {
		if (!this.#ready) return;
		try {
			const local = await this.#scanner.scan();
			for (const [path, hash] of local) if (this.#base.get(path) !== hash) this.#queue.add(path);
			for (const path of this.#base.keys()) if (!local.has(path)) this.#queue.add(path);
			this.#kick();
		} catch (error) {
			this.onEvent({ type: "error", message: `scan: ${String(error)}` });
		}
	}

	#kick(): void {
		if (this.#running !== undefined || this.#queue.size === 0) return;
		this.#running = (async () => {
			while (this.#queue.size > 0) {
				const path = this.#queue.values().next().value!;
				this.#queue.delete(path);
				try {
					await this.#reconcile(path);
				} catch (error) {
					this.onEvent({ type: "error", message: `${path}: ${String((error as Error).message ?? error)}` });
				}
			}
		})().finally(() => {
			this.#running = undefined;
			this.#saveBaseSoon();
			if (this.#queue.size > 0) this.#kick();
		});
	}

	#setBase(path: string, hash: FileHash): void {
		if (hash === null) this.#base.delete(path);
		else this.#base.set(path, hash);
	}

	async #reconcile(path: string): Promise<void> {
		if (safePath(path) === undefined) return;
		const remote = this.#remote.get(path) ?? null;
		const local = await this.#scanner.hash(path);
		const base = this.#base.get(path) ?? null;
		if (local === remote) return this.#setBase(path, remote);
		if (local === base) return this.#pull(path, remote);
		if (this.readOnly) return;
		if (remote === base) return this.#push(path, local, base);
		await this.#conflict(path, remote);
		await this.#push(path, local, remote);
	}

	async #pull(path: string, remote: FileHash): Promise<void> {
		const full = join(this.dir, path);
		if (remote === null) {
			rmSync(full, { force: true });
			this.#setBase(path, null);
			this.pulled++;
			this.onEvent({ type: "pulled", path, deleted: true });
			return;
		}
		const file = await this.#conn.getFile(path);
		if (file === undefined) return; // gone again; the next frame says so
		mkdirSync(dirname(full), { recursive: true });
		const tmp = `${full}.syncpi-tmp`;
		writeFileSync(tmp, file.bytes);
		renameSync(tmp, full);
		this.#setBase(path, file.hash);
		this.#remote.set(path, file.hash);
		this.pulled++;
		this.onEvent({ type: "pulled", path, deleted: false });
	}

	async #push(path: string, local: FileHash, base: FileHash): Promise<void> {
		let result: { ok: boolean; hash: FileHash };
		if (local === null) {
			if (base === null) return;
			result = await this.#conn.deleteFile(path, base);
		} else {
			const bytes = await readFile(join(this.dir, path)).catch(() => undefined);
			if (bytes === undefined) return;
			result = await this.#conn.putFile(path, base, bytes);
		}
		if (result.ok) {
			this.#setBase(path, result.hash);
			if (result.hash === null) this.#remote.delete(path);
			else this.#remote.set(path, result.hash);
			this.pushed++;
			this.onEvent({ type: "pushed", path, deleted: local === null });
			return;
		}
		// The server changed under us; reconcile again against what it has now.
		if (result.hash === null) this.#remote.delete(path);
		else this.#remote.set(path, result.hash);
		this.#queue.add(path);
	}

	async #conflict(path: string, remote: FileHash): Promise<void> {
		const saved = join(conflictsDir(this.#id), `${path}.${Date.now()}`);
		mkdirSync(dirname(saved), { recursive: true });
		if (remote === null) writeFileSync(saved, "(deleted in the session)\n");
		else {
			const file = await this.#conn.getFile(path);
			writeFileSync(saved, file?.bytes ?? "");
		}
		this.conflicts.push(path);
		this.onEvent({ type: "conflict", path, saved });
	}

	#saveBaseSoon(): void {
		if (this.#saveTimer !== undefined) return;
		this.#saveTimer = setTimeout(() => this.#flushBase(), 1_000);
	}

	#flushBase(): void {
		if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		saveBase(this.#id, this.#base);
	}
}
