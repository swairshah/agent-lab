// What the CLI remembers on this machine, under ~/.syncpi:
//   config.json              who you are (name and email shown to collaborators)
//   sessions/<id>.json       one per session you started or joined: server URL, your token, the local folder
//   sessions/<id>.base.json  the file hashes both sides last agreed on, so sync can tell who changed what
//   projects/<name>/         default folder for sessions you joined
//   conflicts/<id>/          the other side's version of files that both sides changed
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const home = process.env.SYNCPI_HOME ?? join(homedir(), ".syncpi");
const sessionsDir = join(home, "sessions");

export type Identity = { name: string; email?: string };

export type SessionRecord = {
	id: string;
	name: string;
	url: string;
	token: string;
	/** "owner": you created this session from this machine (and can delete it). Otherwise you joined it. */
	role: "owner" | "editor";
	/** The local folder that mirrors the project. */
	dir: string;
	/** "host": on a shared host VM (`vm`). "exe": a VM of its own (older sessions). "remote": a session you joined. */
	compute: "host" | "exe" | "local" | "remote";
	vm?: string;
	/** Local compute only: where the server keeps its state and workspace. */
	localRoot?: string;
	/** Local compute only: the server's port, chosen before it starts. */
	port?: number;
	createdAt: number;
	/**
	 * A new session is "provisioning" while a background process (`syncpi __provision <id>`, pid `provisioner`)
	 * creates its server. `step` says what it is doing. Absent means ready (and sessions you joined are always ready).
	 */
	status?: "provisioning" | "ready" | "failed";
	step?: string;
	error?: string;
	provisioner?: number;
	/** What the provisioner needs to create the server. */
	setup?: { model: string; setupModel: string; thinkingLevel?: string; owner: Identity; faux?: boolean };
};

function writeJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

function git(key: string): string | undefined {
	try {
		return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function identity(): Identity {
	const file = join(home, "config.json");
	if (existsSync(file)) {
		const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Identity>;
		if (stored.name) return { name: stored.name, email: stored.email };
	}
	const name = git("user.name") ?? userInfo().username;
	return { name: name.split(" ")[0] ?? name, email: git("user.email") };
}

export function sessions(): SessionRecord[] {
	if (!existsSync(sessionsDir)) return [];
	return readdirSync(sessionsDir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".base.json") && !f.endsWith(".tmp"))
		.map((f) => JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as SessionRecord)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadSession(id: string): SessionRecord | undefined {
	const file = join(sessionsDir, `${id}.json`);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
	} catch {
		return undefined;
	}
}

export function sessionLog(id: string): string {
	return join(sessionsDir, `${id}.log`);
}

export function saveSession(record: SessionRecord): void {
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	writeJson(join(sessionsDir, `${record.id}.json`), record);
}

export function removeSession(id: string): void {
	rmSync(join(sessionsDir, `${id}.json`), { force: true });
	rmSync(join(sessionsDir, `${id}.base.json`), { force: true });
}

export function loadBase(id: string): Map<string, string> {
	const file = join(sessionsDir, `${id}.base.json`);
	if (!existsSync(file)) return new Map();
	return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>));
}

export function saveBase(id: string, base: Map<string, string>): void {
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	writeJson(join(sessionsDir, `${id}.base.json`), Object.fromEntries(base));
}

export function conflictsDir(id: string): string {
	return join(home, "conflicts", id);
}

export function projectsDir(): string {
	return join(home, "projects");
}
