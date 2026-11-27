import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Settings } from "../src/config.ts";
import { type Pid0Event, Pid0Session, type SessionOptions } from "../src/session.ts";
import { SessionStore } from "../src/store.ts";

export const here = dirname(fileURLToPath(import.meta.url));
process.env.PID0_PI_DIR ??= mkdtempSync(join(tmpdir(), "pid0-pi-"));
export const FAKE = join(here, "fake-agent.ts");

export function fakeHarness(name: string, env: Record<string, string> = {}) {
	return { label: `Fake ${name}`, command: [process.execPath, "--no-warnings", FAKE], env: { FAKE_NAME: name, ...env } };
}

export function tempDir(prefix = "pid0-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function testSettings(extra: Record<string, Record<string, string>> = {}): Settings {
	return {
		defaultHarness: "one",
		permissions: "allow",
		harnesses: {
			claude: { disabled: true },
			codex: { disabled: true },
			antigravity: { disabled: true },
			pi: { disabled: true },
			one: fakeHarness("one", extra.one),
			two: fakeHarness("two", { FAKE_LEGACY_MODELS: "1", FAKE_CAPS: "load", FAKE_MODELS: "x1,x2", ...extra.two }),
		},
	};
}

export async function startSession(options: Partial<SessionOptions> & { dir?: string } = {}) {
	const dir = options.dir ?? tempDir();
	const root = options.root ?? join(dir, "sessions");
	const cwd = options.cwd ?? dir;
	const settings = options.settings ?? testSettings();
	const store = options.store ?? (await SessionStore.create({ root, cwd }));
	const session = await Pid0Session.start({ ...options, cwd, root, settings, store });
	const events: Pid0Event[] = [];
	session.subscribe((event) => events.push(event));
	return { session, events, dir, root, cwd, settings };
}

export function answers(events: Pid0Event[]): string[] {
	return events.flatMap((e) => (e.type === "message_end" && e.message.role === "assistant" ? [e.message.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));
}
