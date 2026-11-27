import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

type Term = {
	child: ChildProcess;
	output: string;
	truncated: boolean;
	limit: number;
	exit?: { exitCode: number | null; signal: string | null };
	done: Promise<{ exitCode: number | null; signal: string | null }>;
};

export type TerminalRequest = {
	command: string;
	args?: string[];
	env?: { name: string; value: string }[];
	cwd?: string | null;
	outputByteLimit?: number | null;
};

export class Terminals {
	readonly #terms = new Map<string, Term>();
	readonly #cwd: string;

	constructor(cwd: string) {
		this.#cwd = cwd;
	}

	create(request: TerminalRequest): string {
		const id = `term_${randomUUID()}`;
		const env = { ...process.env };
		for (const v of request.env ?? []) env[v.name] = v.value;
		const hasArgs = (request.args?.length ?? 0) > 0;
		const child = spawn(request.command, request.args ?? [], {
			cwd: request.cwd ?? this.#cwd,
			env,
			shell: !hasArgs,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const term: Term = {
			child,
			output: "",
			truncated: false,
			limit: request.outputByteLimit ?? 1_000_000,
			done: undefined as never,
		};
		const take = (chunk: Buffer) => {
			term.output += chunk.toString("utf8");
			if (Buffer.byteLength(term.output) > term.limit) {
				const buf = Buffer.from(term.output);
				let start = buf.length - term.limit;
				while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
				term.output = buf.subarray(start).toString("utf8");
				term.truncated = true;
			}
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		term.done = new Promise((done) => {
			const finish = (exitCode: number | null, signal: string | null) => {
				term.exit ??= { exitCode, signal };
				done(term.exit);
			};
			child.on("error", (error) => {
				term.output += `${error.message}\n`;
				finish(127, null);
			});
			child.on("close", finish);
		});
		this.#terms.set(id, term);
		return id;
	}

	#get(id: string): Term {
		const term = this.#terms.get(id);
		if (!term) throw new Error(`unknown terminal ${id}`);
		return term;
	}

	output(id: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
		const term = this.#get(id);
		return { output: term.output, truncated: term.truncated, ...(term.exit ? { exitStatus: term.exit } : {}) };
	}

	waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
		return this.#get(id).done;
	}

	kill(id: string): void {
		const term = this.#get(id);
		if (!term.exit) term.child.kill("SIGTERM");
	}

	readonly #released = new Map<string, string>();

	release(id: string): void {
		const term = this.#terms.get(id);
		if (!term) return;
		if (!term.exit) term.child.kill("SIGKILL");
		this.#released.set(id, term.output);
		this.#terms.delete(id);
	}

	peek(id: string): string | undefined {
		return this.#terms.get(id)?.output ?? this.#released.get(id);
	}

	dispose(): void {
		for (const id of [...this.#terms.keys()]) this.release(id);
	}
}
