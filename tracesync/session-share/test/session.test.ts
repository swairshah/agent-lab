// The whole loop in a scratch git repo, with pi on the faux model: Claude Code (driven through its hook command
// against a transcript file), a stand-in `codex` on PATH that writes a rollout file the way Codex does, and pi.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "session-share-"));
const project = join(root, "project");
const codexHome = join(root, "codex-home");
const bin = join(root, "bin");
const transcripts = join(root, "claude");
const env = {
	...process.env,
	SESSION_SHARE_PROJECT: project,
	SESSION_SHARE_FAUX: "1",
	SESSION_SHARE_MEMBER: "Ada",
	CODEX_HOME: codexHome,
	PATH: `${bin}:${process.env.PATH}`,
};

function cli(args: string[], input?: string) {
	const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, input, encoding: "utf8", timeout: 60_000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

function hook(session: string, event: string) {
	const payload = { session_id: session, transcript_path: join(transcripts, `${session}.jsonl`), hook_event_name: event, cwd: project };
	const r = cli(["hook", "claude-code"], JSON.stringify(payload));
	assert.equal(r.code, 0, r.err);
	return r.out ? JSON.parse(r.out) : undefined;
}

let uuid = 0;
function claudeSays(session: string, type: "user" | "assistant", content: unknown) {
	const row = { type, uuid: `${session}-${++uuid}`, isSidechain: false, timestamp: new Date().toISOString(), sessionId: session, message: { role: type, content } };
	appendFileSync(join(transcripts, `${session}.jsonl`), `${JSON.stringify(row)}\n`);
}

// A stand-in for `codex exec --json [resume <id>] -`: each new thread gets the next id; it records the prompt it got, runs `wc -l` "as a tool",
// answers, and writes all of it to a rollout file under $CODEX_HOME/sessions as Codex does.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const r = args.indexOf("resume");
const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "28");
const threads = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
const thread = r >= 0 ? args[r + 1] : "019a0000-0000-7000-8000-00000000c0d" + threads;
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(path.join(process.env.CODEX_HOME, "last-prompt.txt"), prompt);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "rollout-2026-10-28T20-00-00-" + thread + ".jsonl");
const at = new Date().toISOString();
const n = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\\n").length : 0;
const line = (type, payload) => JSON.stringify({ timestamp: at, type, payload }) + "\\n";
let out = n ? "" : line("session_meta", { id: thread, cwd: process.cwd() });
out += line("turn_context", { model: "gpt-fake" });
out += line("response_item", { type: "message", id: "u" + n, role: "user", content: [{ type: "input_text", text: "<environment_context>\\n</environment_context>" }, { type: "input_text", text: prompt }] });
out += line("response_item", { type: "function_call", id: "f" + n, name: "exec_command", arguments: JSON.stringify({ cmd: "wc -l notes.txt" }), call_id: "call" + n });
out += line("response_item", { type: "function_call_output", call_id: "call" + n, output: "3 notes.txt" });
out += line("response_item", { type: "message", id: "a" + n, role: "assistant", content: [{ type: "output_text", text: "notes.txt has 3 lines." }] });
fs.appendFileSync(file, out);
console.log(JSON.stringify({ type: "thread.started", thread_id: thread }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "notes.txt has 3 lines." } }));
`;

before(() => {
	mkdirSync(project, { recursive: true });
	mkdirSync(bin);
	mkdirSync(codexHome);
	mkdirSync(transcripts);
	execFileSync("git", ["init", "-q"], { cwd: project });
	writeFileSync(join(project, "notes.txt"), "a\nb\nc\n");
	writeFileSync(join(bin, "codex"), FAKE_CODEX);
	chmodSync(join(bin, "codex"), 0o755);
});

after(() => {
	cli(["stop"]);
});

test("Claude Code's turn is recorded, and nothing is said to the first agent in an empty session", () => {
	assert.equal(hook("claude-1", "SessionStart"), undefined);
	assert.equal(hook("claude-1", "UserPromptSubmit"), undefined, "nothing happened before, so no context");
	claudeSays("claude-1", "user", "add a line to notes.txt");
	claudeSays("claude-1", "assistant", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(project, "notes.txt"), old_string: "c\n", new_string: "c\nd\n" } }]);
	claudeSays("claude-1", "user", [{ type: "tool_result", tool_use_id: "t1", content: "The file notes.txt has been updated." }]);
	claudeSays("claude-1", "assistant", [{ type: "text", text: "Added a line." }]);
	hook("claude-1", "Stop");
	const log = cli(["log"]).out;
	assert.match(log, /\[Claude Code · Ada\] user: add a line to notes.txt/);
	assert.match(log, /\[Claude Code · Ada\] called Edit/);
	assert.match(log, /\[Claude Code · Ada\] result of Edit:\nThe file notes.txt has been updated./);
});

test("another agent cannot take the turn while one holds it", () => {
	hook("claude-1", "UserPromptSubmit");
	const blocked = hook("claude-2", "UserPromptSubmit");
	assert.equal(blocked.decision, "block");
	assert.match(blocked.reason, /claude-code \(Ada\) is working/);
	const codex = cli(["codex", "hello"]);
	assert.equal(codex.code, 2);
	hook("claude-1", "Stop");
});

test("Codex is told what Claude did, and its own words are recorded without that context", () => {
	const r = cli(["codex", "how many lines does notes.txt have now?"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /notes.txt has 3 lines/);
	const prompt = readFileSync(join(codexHome, "last-prompt.txt"), "utf8");
	assert.match(prompt, /<session-share-context>[\s\S]*\[Claude Code · Ada\] Added a line\.[\s\S]*<\/session-share-context>\n\nhow many lines/);
	const log = cli(["log"]).out;
	assert.match(log, /\[Codex · Ada\] user: how many lines does notes.txt have now\?/);
	assert.doesNotMatch(log, /\[Codex · Ada\] user: <session-share-context>/);
	assert.match(log, /\[Codex · Ada\] result of exec_command:\n3 notes.txt/);
});

test("Codex's second turn resumes its thread and is told only what is new", () => {
	const r = cli(["codex", "again"]);
	assert.equal(r.code, 0, r.err);
	const prompt = readFileSync(join(codexHome, "last-prompt.txt"), "utf8");
	assert.equal(prompt, "again", "nothing new since Codex's last turn");
	const thread = JSON.parse(readFileSync(join(project, ".session-share", "codex.json"), "utf8")).thread;
	assert.equal(thread, "019a0000-0000-7000-8000-00000000c0d0");
});

test("pi works natively on the shared conversation and sees the others' work", () => {
	const r = cli(["pi", "what happened so far?"]);
	assert.equal(r.code, 0, r.err);
	const seen = Number(r.out.match(/I see (\d+) records of other agents/)?.[1]);
	assert.ok(seen >= 10, r.out);
	assert.match(r.out, /Last: \[Codex · Ada\] notes.txt has 3 lines\./);
	const ran = cli(["pi", "run wc -l notes.txt"]);
	assert.match(ran.out, /→ bash/);
	assert.match(ran.out, /ran it: 3 notes.txt/);
});

test("a new Claude session is told everything, a returning one only what is new", () => {
	const fresh = hook("claude-3", "UserPromptSubmit").hookSpecificOutput.additionalContext;
	assert.match(fresh, /\[Claude Code · Ada\] Added a line\./);
	assert.match(fresh, /\[Codex · Ada\] notes.txt has 3 lines\./);
	assert.match(fresh, /\[pi · Ada\] user: what happened so far\?/);
	assert.match(fresh, /\[pi\] called bash/);
	hook("claude-3", "Stop");
	const back = hook("claude-1", "UserPromptSubmit").hookSpecificOutput.additionalContext;
	assert.doesNotMatch(back, /Added a line/, "claude-1's own work is not narrated back to it");
	assert.match(back, /\[Codex · Ada\]/);
	hook("claude-1", "Stop");
	assert.equal(hook("claude-1", "UserPromptSubmit"), undefined, "nothing new since");
	hook("claude-1", "Stop");
});

test("a checkpoint tags the session and the files, and survives a restart", () => {
	writeFileSync(join(project, "notes.txt"), "a\nb\nc\nd\n");
	const r = cli(["checkpoint", "four lines"]);
	assert.match(r.out, /tagged "four lines" at entry \d+; files at [0-9a-f]{10}/);
	const commit = execFileSync("git", ["rev-parse", "refs/session-share/checkpoints/four-lines"], { cwd: project }).toString().trim();
	assert.equal(execFileSync("git", ["show", `${commit}:notes.txt`], { cwd: project }).toString(), "a\nb\nc\nd\n");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project }).toString().includes(".session-share"), false);
	const before = cli(["log"]).out;
	cli(["stop"]);
	const again = cli(["log"]).out;
	assert.equal(again, before, "the same session after reopening, nothing recorded twice");
	assert.match(cli(["checkpoints"]).out, /four lines {2}by Ada/);
});

test("going back to a checkpoint forks the session and puts the files back", () => {
	writeFileSync(join(project, "notes.txt"), "changed\n");
	writeFileSync(join(project, "extra.txt"), "new\n");
	assert.equal(cli(["pi", "after the checkpoint"]).code, 0);
	const r = cli(["fork", "four lines"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /back at "four lines", files restored from [0-9a-f]{10}/);
	assert.equal(readFileSync(join(project, "notes.txt"), "utf8"), "a\nb\nc\nd\n");
	assert.equal(existsSync(join(project, "extra.txt")), false);
	const saved = execFileSync("git", ["rev-parse", "refs/session-share/checkpoints/before-going-back-to-four-lines"], { cwd: project }).toString().trim();
	assert.equal(execFileSync("git", ["show", `${saved}:extra.txt`], { cwd: project }).toString(), "new\n", "what was there is kept");

	const log = cli(["log"]).out;
	assert.match(log, /\[Claude Code · Ada\] Added a line\./);
	assert.match(log, /— Ada went back to checkpoint "four lines" and its files/);
	assert.doesNotMatch(log, /after the checkpoint/, "the fork ends at the checkpoint");

	const old = hook("claude-1", "UserPromptSubmit");
	assert.equal(old.decision, "block");
	assert.match(old.reason, /went past the checkpoint "four lines"/);

	const fresh = hook("claude-4", "UserPromptSubmit").hookSpecificOutput.additionalContext;
	assert.match(fresh, /\[Codex · Ada\] notes.txt has 3 lines\./);
	assert.match(fresh, /went back to checkpoint "four lines"/);
	assert.doesNotMatch(fresh, /after the checkpoint/);
	hook("claude-4", "Stop");

	const codex = cli(["codex", "where are we?"]);
	assert.equal(codex.code, 0, codex.err);
	assert.match(readFileSync(join(codexHome, "last-prompt.txt"), "utf8"), /went back to checkpoint "four lines"/, "a new Codex thread is told everything");
	assert.equal(JSON.parse(readFileSync(join(project, ".session-share", "codex.json"), "utf8")).thread, "019a0000-0000-7000-8000-00000000c0d1");

	const pi = cli(["pi", "what happened so far?"]).out;
	assert.match(pi, /Last: \[Codex · Ada\] notes.txt has 3 lines\./);
	assert.doesNotMatch(cli(["log"]).out, /after the checkpoint/);
});

test("the active branch survives a restart, and a checkpoint on another branch can be gone back to", () => {
	const before = cli(["log"]).out;
	cli(["stop"]);
	assert.equal(cli(["log"]).out, before);
	assert.match(cli(["branches"]).out, /\* \d+ {2}back to "four lines" from \d+, by Ada/);
	const r = cli(["fork", "before going back to four lines"]);
	assert.equal(r.code, 0, r.err);
	assert.equal(readFileSync(join(project, "extra.txt"), "utf8"), "new\n");
	assert.equal(readFileSync(join(project, "notes.txt"), "utf8"), "changed\n");
	assert.match(cli(["log"]).out, /\[pi · Ada\] user: after the checkpoint/, "the first branch's work is back");
	assert.equal(cli(["branches"]).out.trim().split("\n").length, 3);
	assert.equal(hook("claude-4", "UserPromptSubmit").decision, "block", "a session of the branch left behind is retired too");
	assert.doesNotMatch(cli(["log"]).out, /\[Codex · Ada\] user: where are we\?/);
});
