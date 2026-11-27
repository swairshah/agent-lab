import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { InteractiveApp } from "../src/modes/interactive.ts";
import { here, startSession } from "./helpers.ts";

class FakeTerminal implements Terminal {
	columns = 100;
	rows = 40;
	written = "";
	kittyProtocolActive = false;
	#onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void): void {
		this.#onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.written += data;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	title = "";
	setTitle(title: string): void {
		this.title = title;
	}
	setProgress(): void {}
	statuses: { state: string; app?: string; kind?: string }[] = [];
	setProgramStatus(status: { state: string; app?: string; kind?: string }): void {
		this.statuses.push(status);
	}
	input(data: string): void {
		this.#onInput(data);
	}
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

async function open(options: Parameters<typeof startSession>[0] & { extensions?: string[]; flags?: [string, string | true][] } = {}) {
	const { extensions, flags, ...sessionOptions } = options;
	const started = await startSession(sessionOptions);
	const terminal = new FakeTerminal();
	let extra = {};
	if (extensions) {
		const { Resources } = await import("../src/resources.ts");
		const { ExtensionHost } = await import("../src/extensions.ts");
		const resources = await Resources.load(started.cwd, { extensionPaths: extensions });
		const host = await ExtensionHost.load(started.session, resources, { mode: "tui", flags: new Map(flags ?? []), shutdown: () => {} });
		extra = { resources, host };
	}
	const app = await InteractiveApp.create(started.session, { prompts: [], verbose: false, terminal, tuiMode: "regular", ...extra });
	await app.start();
	await started.session.connect();
	const screen = () => stripTerminalSequences(app.tui.render(terminal.columns).join("\n"));
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 200; i++) {
			if (check()) return;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.fail(`timed out waiting for ${what}\n${screen()}`);
	};
	const type = async (text: string) => {
		for (const ch of text) terminal.input(ch);
		terminal.input(ENTER);
		await new Promise((r) => setTimeout(r, 20));
	};
	const close = async () => {
		app.tui.stop();
		await started.session.dispose();
	};
	return { ...started, app, terminal, screen, until, type, close };
}

test("the terminal UI sends a prompt, streams the answer and shows the footer", async () => {
	const ui = await open();
	await ui.type("hello");
	await ui.until(() => ui.screen().includes("echo: hello (prompt 1"), "the answer");
	assert.match(ui.screen(), /\(one\) one alpha • medium/);
	assert.match(ui.screen(), /↑20 ↓10 \$0\.010 0\.5%\/200k \(auto\)/);
	await ui.close();
});

test("/model opens a selector and the choice is applied in the harness", async () => {
	const ui = await open();
	await ui.type("/model");
	await ui.until(() => ui.screen().includes("Select model (Fake one)"), "the model selector");
	assert.match(ui.screen(), /one beta/);
	assert.match(ui.screen(), /→ Fake two/);
	ui.terminal.input(DOWN);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.session.state.model === "beta", "the model to change");
	await ui.type("/thinking high");
	await ui.until(() => ui.session.state.thinkingLevel === "high", "thinking to change");
	await ui.type("hi");
	await ui.until(() => ui.screen().includes("[one/beta/high/default] echo: hi"), "an answer from beta");

	await ui.type("/model");
	await ui.until(() => ui.screen().includes("Select model (Fake one)"), "the selector again");
	ui.terminal.input(ESC);
	await ui.until(() => !ui.screen().includes("Select model (Fake one)"), "the selector to close");
	assert.equal(ui.session.state.model, "beta");
	await ui.close();
});

test("/harness switches harness inside one conversation", async () => {
	const ui = await open();
	await ui.type("first");
	await ui.until(() => ui.screen().includes("echo: first"), "the first answer");
	await ui.type("/harness two");
	await ui.until(() => ui.session.state.harness === "two" && ui.session.state.connected, "harness two");
	await ui.type("second");
	await ui.until(() => ui.screen().includes("echo: second (prompt 1, context yes"), "an answer from two");
	assert.match(ui.screen(), /Harness: Fake two/);
	assert.match(ui.screen(), /\(two\) two x1/);
	await ui.close();
});

test("permission requests are asked in the UI; tools, shell commands and info commands render", async () => {
	const ui = await open({ permissions: "ask" });
	await ui.type("write made.txt by-ui");
	await ui.until(() => ui.screen().includes("wants to run: Write made.txt"), "the permission prompt");
	assert.match(ui.screen(), /Allow\s+allow once/);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.screen().includes("Wrote made.txt (yes)"), "the write");
	assert.match(ui.terminal.title, /^pid0 - /);
	assert.deepEqual(ui.terminal.statuses.map((s) => `${s.app}:${s.state}${s.kind ? `:${s.kind}` : ""}`).slice(0, 4), ["pid0:idle", "pid0:working", "pid0:blocked:permission", "pid0:working"]);
	assert.equal(readFileSync(join(ui.cwd, "made.txt"), "utf8"), "by-ui");
	assert.match(ui.screen(), /write made\.txt\s+by-ui/);

	await ui.type("write no.txt x");
	await ui.until(() => ui.screen().includes("wants to run: Write no.txt"), "the second prompt");
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("Not allowed (cancelled)"), "the rejection");
	assert.ok(!existsSync(join(ui.cwd, "no.txt")));

	await ui.type("!echo from-shell");
	await ui.until(() => /\$ echo from-shell\s+from-shell/.test(ui.screen()), "the shell output");
	await ui.type("/session");
	await ui.until(() => /User: 2\s+Assistant: 2\s+Tools: 2 calls/.test(ui.screen()), "session info");
	await ui.type("/name My work");
	await ui.until(() => ui.screen().includes("• My work"), "the name in the footer");
	await ui.type("think hard");
	await ui.until(() => ui.screen().includes("pondering deeply"), "thinking");
	ui.terminal.input("\x14");
	await ui.until(() => !ui.screen().includes("pondering deeply"), "thinking hidden");
	await ui.close();
});

test("esc stops a turn; /new, /resume, /fork and /tree move between sessions and branches", async () => {
	const ui = await open();
	await ui.type("slow");
	await ui.until(() => ui.screen().includes("tick3"), "streaming");
	assert.match(ui.screen(), /Working\.\.\. \(escape to interrupt\)/);
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("Operation aborted") && !ui.session.isStreaming, "the stop");

	await ui.type("keep this");
	await ui.until(() => ui.screen().includes("echo: keep this"), "an answer");
	const first = ui.session.store.file;
	await ui.type("/new");
	await ui.until(() => ui.session.store.file !== first && !ui.screen().includes("keep this"), "a new session");
	await ui.type("/resume");
	await ui.until(() => ui.screen().includes("Resume Session"), "the session list");
	await ui.until(() => /› keep this|› slow/.test(ui.screen()), "the sessions to load");
	ui.terminal.input(ENTER);
	await ui.until(() => ui.session.store.file === first && ui.screen().includes("echo: keep this"), "the first session back");

	await ui.type("/fork");
	await ui.until(() => /keep this/.test(ui.screen().split("Operation aborted").at(-1)!.split("echo: keep this").at(-1)!), "the fork list");
	assert.match(ui.screen(), /Fork from Message/);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.session.store.file !== first && ui.app.editor.getText() === "keep this", "the fork");
	assert.ok(!ui.screen().includes("echo: keep this"));
	assert.ok(ui.screen().includes("tick3"));

	ui.app.editor.setText("");
	await ui.type("branch here");
	await ui.until(() => ui.screen().includes("echo: branch here (prompt 1, context yes"), "an answer in the fork");
	await ui.type("/tree");
	await ui.until(() => ui.screen().includes("Session Tree"), "the tree");
	assert.match(ui.screen(), /user: branch here[\s\S]*user: keep this/);
	ui.terminal.input(ESC);
	await ui.until(() => !ui.screen().includes("Session Tree"), "the tree to close");
	await ui.close();
});

test("/settings is pi's settings list and saves to pi's settings; templates and skills expand", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const pi = process.env.PID0_PI_DIR!;
	mkdirSync(join(pi, "prompts"), { recursive: true });
	mkdirSync(join(pi, "skills", "greet"), { recursive: true });
	writeFileSync(join(pi, "prompts", "shout.md"), "---\ndescription: Shout it\n---\nSay loudly: $1");
	writeFileSync(join(pi, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greets people\n---\nAlways greet warmly.");
	const ui = await open();
	assert.match(ui.screen(), /Loaded 1 prompt templates, 1 skills/);
	await ui.type("/settings");
	await ui.until(() => ui.screen().includes("Auto-compact"), "the settings list");
	assert.match(ui.screen(), /Enter\/Space to change/);
	ui.terminal.input(ENTER);
	await ui.until(() => /Auto-compact\s+false/.test(ui.screen()), "auto-compact to toggle");
	ui.terminal.input(ESC);
	await ui.until(() => !ui.screen().includes("Auto-compact"), "settings to close");
	assert.equal(ui.session.autoCompact, false);
	assert.equal(JSON.parse(readFileSync(join(pi, "settings.json"), "utf8")).compaction.enabled, false);

	await ui.type("/shout hello");
	await ui.until(() => ui.screen().includes("echo: Say loudly: hello"), "the template to expand");
	await ui.type("/skill:greet bob");
	await ui.until(() => /echo: <skill name="greet"/.test(ui.screen()), "the skill to expand");
	await ui.type("/theme");
	await ui.until(() => ui.screen().includes("echo: /theme"), "an unknown command to go to the harness");
	assert.ok(!ui.screen().includes("Auto-compact"));
	await ui.type("/hotkeys");
	await ui.until(() => /Open model selector/.test(ui.screen()), "the hotkeys");
	await ui.close();
});

test("double escape opens the tree; going back to a message can summarize the branch that is left", async () => {
	const ui = await open();
	await ui.type("one");
	await ui.until(() => ui.screen().includes("echo: one"), "the first answer");
	await ui.type("two");
	await ui.until(() => ui.screen().includes("echo: two"), "the second answer");
	ui.terminal.input(ESC);
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("Session Tree"), "the tree after a double escape");
	ui.terminal.input(ENTER);
	await ui.until(() => ui.screen().includes("Already at this point"), "the note for the current point");

	ui.terminal.input(ESC);
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("Session Tree"), "the tree again");
	ui.terminal.input("\x1b[A");
	ui.terminal.input(ENTER);
	await ui.until(() => ui.screen().includes("Summarize branch?"), "the summary question");
	ui.terminal.input(DOWN);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.app.editor.getText() === "two" && ui.screen().includes("Navigated to selected point"), "the move");
	const items = await ui.session.messages();
	assert.deepEqual(items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.data.text), ["one"]);
	const summary = items.at(-1)!;
	assert.ok(summary.kind === "summary" && /echo: The user is going back to an earlier point/.test(summary.data.text));
	assert.ok(!ui.screen().includes("echo: two"));

	ui.app.editor.setText("");
	await ui.type("three");
	await ui.until(() => ui.screen().includes("echo: three (prompt 1, context yes"), "an answer on the new branch");
	await ui.close();
});

test("pi extensions load: commands, flags, shortcuts, widgets, status, input events, messages and tools", async () => {
	const ui = await open({ extensions: [join(here, "fixtures", "sample-extension.ts")], flags: [["loud", true]] });
	await ui.until(() => ui.screen().includes("sample widget line"), "the extension's widget");
	await ui.type("/hello bob");
	await ui.until(() => ui.screen().includes("hello bob (loud=true)"), "the extension command");
	await ui.until(() => ui.screen().includes("turns:0"), "the extension status in the footer");

	await ui.type("ping");
	await ui.until(() => ui.screen().includes("echo: pong please"), "the input event to transform the prompt");
	assert.match(ui.screen(), /mcp 1\)/);
	await ui.until(() => ui.screen().includes("turns:1"), "the agent_end handler");
	await ui.type("swallow");
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(!ui.screen().includes("echo: swallow"));

	await ui.type("/ask something");
	await ui.until(() => ui.screen().includes("echo: from extension: something"), "a prompt sent by the extension");
	await ui.type("/note milk");
	await ui.until(() => ui.screen().includes("remember milk"), "the extension's message");
	ui.terminal.input("\x19");
	await ui.until(() => ui.screen().includes("shortcut pressed"), "the extension shortcut");

	const items = await ui.session.messages();
	assert.ok(items.some((i) => i.kind === "custom" && i.data.customType === "sample-state"));
	assert.ok(items.some((i) => i.kind === "note" && i.data.content === "remember milk"));

	await ui.close();
});

test("extension tools are served to the harness over MCP", async () => {
	const { Resources } = await import("../src/resources.ts");
	const { ExtensionHost } = await import("../src/extensions.ts");
	const started = await startSession();
	const resources = await Resources.load(started.cwd, { extensionPaths: [join(here, "fixtures", "sample-extension.ts")] });
	const host = (await ExtensionHost.load(started.session, resources, { mode: "print", flags: new Map(), shutdown: () => {} }))!;
	const call = async (body: unknown, token = host.mcpToken) => fetch(host.mcpUrl!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
	assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status, 401);
	const init = (await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { protocolVersion: string } };
	assert.equal(init.result.protocolVersion, "2025-06-18");
	assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
	const list = (await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
	assert.deepEqual(list.result.tools.map((t) => t.name), ["sample_add"]);
	const result = (await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sample_add", arguments: { a: 2, b: 3 } } })).json()) as { result: { content: { text: string }[]; isError: boolean } };
	assert.deepEqual(result.result, { content: [{ type: "text", text: "5" }], isError: false });
	await host.dispose();
	await started.session.dispose();
});
