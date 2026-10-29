// Finding a project's session process, starting it when it is not running, and calling it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ServerInfo } from "./server.ts";

/** The project a command works in: SESSION_SHARE_PROJECT, else the git checkout around `cwd`, else `cwd`. */
export function projectOf(cwd = process.cwd()): string {
	if (process.env.SESSION_SHARE_PROJECT) return process.env.SESSION_SHARE_PROJECT;
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".session-share"))) return dir;
		if (dirname(dir) === dir) break;
	}
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return cwd;
	}
}

/** Who is working: SESSION_SHARE_MEMBER, else git's user.name, else the login name. */
export function memberName(project: string): string {
	if (process.env.SESSION_SHARE_MEMBER) return process.env.SESSION_SHARE_MEMBER;
	try {
		const name = execFileSync("git", ["config", "user.name"], { cwd: project, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		if (name) return name;
	} catch {}
	return userInfo().username;
}

export function readInfo(project: string): ServerInfo | undefined {
	try {
		return JSON.parse(readFileSync(join(project, ".session-share", "server.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export class Client {
	readonly info: ServerInfo;

	constructor(info: ServerInfo) {
		this.info = info;
	}

	get base(): string {
		return `http://127.0.0.1:${this.info.port}`;
	}

	get viewUrl(): string {
		return `${this.base}/?token=${this.info.token}`;
	}

	async fetch(path: string, body?: unknown): Promise<Response> {
		return fetch(`${this.base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-session-share-token": this.info.token, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	async call<T = any>(path: string, body?: unknown): Promise<T> {
		const res = await this.fetch(path, body);
		const value = await res.json();
		if (!res.ok) throw Object.assign(new Error(value.error ?? `${res.status}`), { status: res.status, value });
		return value as T;
	}
}

async function healthy(info: ServerInfo | undefined): Promise<boolean> {
	if (!info) return false;
	try {
		return (await new Client(info).fetch("/health")).ok;
	} catch {
		return false;
	}
}

/** The running session process for `project`, started in the background when there is none. */
export async function connect(project: string, start = true): Promise<Client> {
	const info = readInfo(project);
	if (await healthy(info)) return new Client(info!);
	if (!start) throw new Error(`no session is running in ${project}`);
	const dir = join(project, ".session-share");
	mkdirSync(dir, { recursive: true });
	const out = openSync(join(dir, "server.log"), "a");
	const cli = new URL("./cli.ts", import.meta.url).pathname;
	spawn(process.execPath, [cli, "serve"], { cwd: project, detached: true, stdio: ["ignore", out, out], env: { ...process.env, SESSION_SHARE_PROJECT: project } }).unref();
	for (let i = 0; i < 150; i++) {
		await new Promise((r) => setTimeout(r, 100));
		const next = readInfo(project);
		if (next && next.pid !== info?.pid && (await healthy(next))) return new Client(next);
	}
	throw new Error(`the session process did not start; see ${join(dir, "server.log")}`);
}
