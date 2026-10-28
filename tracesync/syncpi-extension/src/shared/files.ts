// Which files of a project are synced, and their content hashes. Used on both ends: the server scans the VM's
// workspace, and each client scans its local copy. A git repository syncs what git would see (tracked plus untracked
// files that are not ignored); any other directory is walked with a fixed ignore list.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { FileHash } from "./protocol.ts";

const run = promisify(execFile);

/** Paths never synced, in any project. `.syncpi/` holds the session's own notes on the VM. */
const ALWAYS_SKIP = [".git", ".syncpi", "node_modules", ".DS_Store"];
const WALK_SKIP = new Set([...ALWAYS_SKIP, "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"]);

/** Files bigger than this are not synced (build outputs, datasets). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function hashBytes(bytes: Uint8Array | string): string {
	return createHash("sha1").update(bytes).digest("hex");
}

export function skipped(path: string): boolean {
	const parts = path.split("/");
	return parts.some((part) => ALWAYS_SKIP.includes(part)) || path.endsWith(".syncpi-conflict");
}

async function gitFiles(dir: string): Promise<string[] | undefined> {
	try {
		const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: dir,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.split("\0").filter((p) => p.length > 0);
	} catch {
		return undefined;
	}
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (WALK_SKIP.has(name)) continue;
		const full = join(dir, name);
		const info = await lstat(full).catch(() => undefined);
		if (info === undefined) continue;
		if (info.isDirectory()) await walk(full, root, out);
		else if (info.isFile()) out.push(relative(root, full).split(sep).join("/"));
	}
}

/** Relative paths (with `/`) of the files that sync. */
export async function listFiles(dir: string): Promise<string[]> {
	let files = (await lstat(join(dir, ".git")).catch(() => undefined)) !== undefined ? await gitFiles(dir) : undefined;
	if (files === undefined) {
		files = [];
		await walk(dir, dir, files);
	}
	return files.filter((p) => !skipped(p)).sort();
}

type Stat = { size: number; mtimeMs: number; hash: string };

/**
 * Hashes of a directory's synced files. Unchanged files (same size and mtime) are not read again, so rescanning a
 * project every second or two is cheap.
 */
export class Scanner {
	readonly dir: string;
	#cache = new Map<string, Stat>();

	constructor(dir: string) {
		this.dir = dir;
	}

	async scan(): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const seen = new Set<string>();
		for (const path of await listFiles(this.dir)) {
			const hash = await this.hash(path);
			if (hash !== null) {
				out.set(path, hash);
				seen.add(path);
			}
		}
		for (const path of this.#cache.keys()) if (!seen.has(path)) this.#cache.delete(path);
		return out;
	}

	/** The current hash of one file, or null when it is missing, not a regular file, or too large. */
	async hash(path: string): Promise<FileHash> {
		const full = join(this.dir, path);
		const info = await lstat(full).catch(() => undefined);
		if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) {
			this.#cache.delete(path);
			return null;
		}
		const cached = this.#cache.get(path);
		if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash;
		const bytes = await readFile(full).catch(() => undefined);
		if (bytes === undefined) return null;
		const hash = hashBytes(bytes);
		this.#cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
		return hash;
	}
}

/** Changes from `before` to `after`: new or changed paths with their hash, removed paths with null. */
export function diff(before: Map<string, string>, after: Map<string, string>): Record<string, FileHash> {
	const changed: Record<string, FileHash> = {};
	for (const [path, hash] of after) if (before.get(path) !== hash) changed[path] = hash;
	for (const path of before.keys()) if (!after.has(path)) changed[path] = null;
	return changed;
}

/** Rejects absolute paths and `..`, so a client can never read or write outside the project. */
export function safePath(path: string): string | undefined {
	if (path.length === 0 || path.startsWith("/") || path.includes("\0") || path.includes("\\")) return undefined;
	const parts = path.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return undefined;
	if (skipped(path)) return undefined;
	return path;
}
