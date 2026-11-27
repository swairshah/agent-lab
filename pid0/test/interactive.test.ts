import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { InteractiveApp } from "../src/modes/interactive.ts";
import { startSession } from "./helpers.ts";

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
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	input(data: string): void {
		this.#onInput(data);
	}
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

async function open(options: Parameters<typeof startSession>[0] = {}) {
	const started = await startSession(options);
	const terminal = new FakeTerminal();
	const app = new InteractiveApp(started.session, { prompts: [], verbose: false, terminal });
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
	assert.match(ui.screen(), /Fake one • one alpha • medium/);
	assert.match(ui.screen(), /↑20 ↓10 \$0\.010 0\.5%\/200\.0k/);
	await ui.close();
});

test("/model opens a selector and the choice is applied in the harness", async () => {
	const ui = await open();
	await ui.type("/model");
	await ui.until(() => ui.screen().includes("Model (Fake one)"), "the model selector");
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
	await ui.until(() => ui.screen().includes("Model (Fake one)"), "the selector again");
	ui.terminal.input(ESC);
	await ui.until(() => !ui.screen().includes("Model (Fake one)"), "the selector to close");
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
	assert.match(ui.screen(), /switched to Fake two|now talking to Fake two/);
	assert.match(ui.screen(), /Fake two • two x1/);
	await ui.close();
});

test("permission requests are asked in the UI; tools, shell commands and info commands render", async () => {
	const ui = await open({ permissions: "ask" });
	await ui.type("write made.txt by-ui");
	await ui.until(() => ui.screen().includes("asks to run: Write made.txt"), "the permission prompt");
	assert.match(ui.screen(), /Allow\s+allow once/);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.screen().includes("Wrote made.txt (yes)"), "the write");
	assert.equal(readFileSync(join(ui.cwd, "made.txt"), "utf8"), "by-ui");
	assert.match(ui.screen(), /● Write made\.txt\s+\+1 -0 made\.txt/);

	await ui.type("write no.txt x");
	await ui.until(() => ui.screen().includes("asks to run: Write no.txt"), "the second prompt");
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("Not allowed (cancelled)"), "the rejection");
	assert.ok(!existsSync(join(ui.cwd, "no.txt")));

	await ui.type("!echo from-shell");
	await ui.until(() => /\$ echo from-shell\s+from-shell/.test(ui.screen()), "the shell output");
	await ui.type("/session");
	await ui.until(() => /Messages: 2 user, 2 assistant, 2 tool calls/.test(ui.screen()), "session info");
	await ui.type("/name My work");
	await ui.until(() => ui.screen().includes("• My work"), "the name in the footer");
	await ui.type("think hard");
	await ui.until(() => ui.screen().includes("pondering deeply"), "thinking");
	ui.terminal.input("\x14");
	await ui.until(() => ui.screen().includes("Thinking…") && !ui.screen().includes("pondering deeply"), "thinking hidden");
	await ui.close();
});

test("esc stops a turn; /new, /resume, /fork and /tree move between sessions and branches", async () => {
	const ui = await open();
	await ui.type("slow");
	await ui.until(() => ui.screen().includes("tick3"), "streaming");
	assert.match(ui.screen(), /Working… \(esc to interrupt\)/);
	ui.terminal.input(ESC);
	await ui.until(() => ui.screen().includes("— stopped") && !ui.session.isStreaming, "the stop");

	await ui.type("keep this");
	await ui.until(() => ui.screen().includes("echo: keep this"), "an answer");
	const first = ui.session.store.file;
	await ui.type("/new");
	await ui.until(() => ui.session.store.file !== first && !ui.screen().includes("keep this"), "a new session");
	await ui.type("/resume");
	await ui.until(() => ui.screen().includes("Resume a session"), "the session list");
	ui.terminal.input(ENTER);
	await ui.until(() => ui.session.store.file === first && ui.screen().includes("echo: keep this"), "the first session back");

	await ui.type("/fork");
	await ui.until(() => ui.screen().includes("Fork from a message"), "the fork list");
	ui.terminal.input(DOWN);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.session.store.file !== first && ui.app.editor.getText() === "keep this", "the fork");
	assert.ok(!ui.screen().includes("echo: keep this"));
	assert.ok(ui.screen().includes("tick3"));

	ui.app.editor.setText("");
	await ui.type("branch here");
	await ui.until(() => ui.screen().includes("echo: branch here (prompt 1, context yes"), "an answer in the fork");
	await ui.type("/tree");
	await ui.until(() => ui.screen().includes("Session tree"), "the tree");
	assert.match(ui.screen(), /● you: slow/);
	ui.terminal.input(ENTER);
	await ui.until(() => ui.app.editor.getText() === "slow" && !ui.screen().includes("tick3"), "the branch before the first message");
	assert.equal((await ui.session.store.branches()).length, 3);
	await ui.close();
});
