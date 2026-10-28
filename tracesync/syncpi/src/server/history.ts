// The project as it was before the shared thread's last turn, so people can see a file "Before last turn", as in
// Delta. Each run of the main conversation starts with a snapshot of the synced files, committed to a git repository
// of the session's own (`<state>/history.git`, with its own index), never the project's `.git`. Git stores a file
// that didn't change only once, so a snapshot per turn costs little.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BEFORE_LAST_TURN = "refs/syncpi/before-last-turn";

export class History {
	readonly #env: NodeJS.ProcessEnv;
	readonly #dir: string;
	/** Snapshots run one at a time, and reads wait for the one in progress. */
	#queue: Promise<void> = Promise.resolve();

	readonly #workdir: string;

	constructor(stateDir: string, workdir: string) {
		this.#workdir = workdir;
		this.#dir = join(stateDir, "history.git");
		this.#env = {
			...process.env,
			GIT_DIR: this.#dir,
			GIT_WORK_TREE: workdir,
			GIT_INDEX_FILE: join(stateDir, "history.index"),
			// Project paths are names, never patterns.
			GIT_LITERAL_PATHSPECS: "1",
			GIT_AUTHOR_NAME: "syncpi",
			GIT_AUTHOR_EMAIL: "syncpi@localhost",
			GIT_COMMITTER_NAME: "syncpi",
			GIT_COMMITTER_EMAIL: "syncpi@localhost",
		};
	}

	#git(args: string[], input?: string, env = this.#env): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", args, { env, stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			let err = "";
			child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => (err += chunk));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args[0]}: ${err.trim() || `exit ${code}`}`))));
			child.stdin.end(input ?? "");
		});
	}

	/** Records `paths` (the synced files, relative to the project) as they are now, as the base of the turn starting. */
	snapshot(paths: readonly string[]): Promise<void> {
		this.#queue = this.#queue
			.then(async () => {
				// `git init` refuses a work tree setting; the repository itself is bare.
				if (!existsSync(join(this.#dir, "HEAD"))) await this.#git(["init", "--bare", "-q", this.#dir], undefined, { ...process.env });
				await this.#git(["read-tree", "--empty"]);
				// Only files still there (one deleted since the last scan would fail the whole add). -f: a tracked file
				// the project's .gitignore matches is still a project file.
				const present = paths.filter((p) => existsSync(join(this.#workdir, p)));
				if (present.length > 0) await this.#git(["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], present.join("\0"));
				const tree = (await this.#git(["write-tree"])).toString().trim();
				const commit = (await this.#git(["commit-tree", tree, "-m", "before a turn"])).toString().trim();
				await this.#git(["update-ref", BEFORE_LAST_TURN, commit]);
			})
			.catch((error: unknown) => console.error(`history: ${(error as Error).message}`));
		return this.#queue;
	}

	/** A file as it was before the last turn: its bytes, null if it wasn't there, undefined if no turn has run yet. */
	async beforeLastTurn(path: string): Promise<Buffer | null | undefined> {
		await this.#queue;
		if (!existsSync(join(this.#dir, "HEAD"))) return undefined;
		try {
			await this.#git(["rev-parse", "--verify", "-q", BEFORE_LAST_TURN]);
		} catch {
			return undefined;
		}
		try {
			return await this.#git(["cat-file", "blob", `${BEFORE_LAST_TURN}:${path}`]);
		} catch {
			return null;
		}
	}
}
