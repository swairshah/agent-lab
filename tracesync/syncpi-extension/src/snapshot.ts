// Safe handling of what a session server sends when you join: its project name becomes a folder name, and its
// snapshot is a tarball extracted into that folder. A malicious server must not be able to write outside it.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A project name usable as one folder name. */
export function safeName(name: unknown): string {
	if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`the server sent an unusable project name: ${JSON.stringify(name)}`);
	return name;
}

/** An exe.dev VM name usable in `ssh <vm>.exe.xyz`, or undefined. */
export function safeVm(vm: unknown): string | undefined {
	if (vm === undefined || vm === null) return undefined;
	if (typeof vm !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(vm)) throw new Error(`unusable VM name: ${JSON.stringify(vm)}`);
	return vm;
}

function unsafePath(path: string): boolean {
	return path.startsWith("/") || path.split("/").some((part) => part === "..");
}

/**
 * Downloads a snapshot to a temporary file, refuses it if any entry is absolute, climbs out with "..", or is a link
 * pointing outside the project, then extracts it into `dir` without taking the archive's owners.
 */
export async function extractSnapshot(body: ReadableStream<Uint8Array>, dir: string): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), "syncpi-snapshot-"));
	const file = join(tmp, "project.tgz");
	try {
		await pipeline(Readable.fromWeb(body as never), createWriteStream(file, { mode: 0o600 }));
		const { stdout } = await run("tar", ["-tvzf", file], { maxBuffer: 256 * 1024 * 1024 });
		const { stdout: names } = await run("tar", ["-tzf", file], { maxBuffer: 256 * 1024 * 1024 });
		for (const name of names.split("\n").filter((n) => n.length > 0)) if (unsafePath(name.replace(/\/$/, ""))) throw new Error(`unsafe path in snapshot: ${name}`);
		for (const line of stdout.split("\n")) {
			// Symbolic links ("l… name -> target") and hard links ("… link to target") must stay inside the project.
			const target = line.startsWith("l") ? line.split(" -> ")[1] : line.match(/ link to (.+)$/)?.[1];
			if (target !== undefined && unsafePath(target.trim())) throw new Error(`unsafe link in snapshot: ${line.trim()}`);
		}
		await new Promise<void>((done, fail) => {
			const tar = spawn("tar", ["-xzf", file, "--no-same-owner", "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
			let err = "";
			tar.stderr.on("data", (d) => (err += d));
			tar.on("close", (code) => (code === 0 ? done() : fail(new Error(`tar: ${err.trim() || `exit ${code}`}`))));
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
