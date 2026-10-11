import { createInterface } from "node:readline";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { watchEvents } from "@earendil-works/pi-durable";
import { dbPath, port, textFrontendModel } from "./config.ts";
import { delegate, setReportSink } from "./delegation.ts";
import { context, openSession } from "./harness.ts";
import { startInspector } from "./inspector.ts";

const tty = process.stdout.isTTY;
const color = (code: number) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

setReportSink({ kind: "text" });
const session = await openSession();
const { harness, root, host } = session;
const server = await startInspector({ session, frontend: "text", port });

console.log(bold("frontdesk") + dim(` · text · ${textFrontendModel.provider}/${textFrontendModel.modelId}`));
console.log(dim(`session ${dbPath}`));
console.log(dim(`inspector http://localhost:${port}`));
console.log(dim("commands: /status  /stop <worker>  /abort  /quit"));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: cyan("› ") });
let streaming = false;

const out = (text: string) => process.stdout.write(text);
const line = (text: string) => {
	if (streaming) {
		out("\n");
		streaming = false;
	}
	out(`\r\x1b[K${text}\n`);
};

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (typeof part?.text === "string" ? [part.text] : [])).join("");
}

let printed = "";
let blocks: { type: string; text?: string }[] = [];

function assistantText(content: readonly { type: string; text?: string }[] | undefined): string {
	return (content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

function flushAssistant(full: string) {
	if (!full.startsWith(printed)) {
		out(`\n${full}`);
	} else {
		out(full.slice(printed.length));
	}
	printed = full;
}

const stream = await watchEvents(harness, root.id, context);
stream.start(async (events: readonly AgentEvent[]) => {
	for (const event of events) {
		if (event.type === "message_start" && event.message.role === "assistant") {
			line("");
			out(`${bold("◆")} `);
			streaming = true;
			printed = "";
			blocks = event.message.content.map((part) => ({ ...part }));
			flushAssistant(assistantText(blocks));
		} else if (event.type === "message_update") {
			for (const change of event.changes) {
				if (change.type === "text_start" || change.type === "block") blocks[change.contentIndex] = { ...change.block };
				else if (change.type === "text_delta") {
					const block = (blocks[change.contentIndex] ??= { type: "text", text: "" });
					block.text = (block.text ?? "") + change.delta;
				} else if (change.type === "message") blocks = change.message.content.map((part) => ({ ...part }));
			}
			flushAssistant(assistantText(blocks));
		} else if (event.type === "message_end") {
			const message = event.entry.model?.[0];
			if (message?.role === "user") {
				const text = contentText(message.content);
				if (text.startsWith("[worker ")) line(magenta(text.length > 400 ? `${text.slice(0, 400)}…` : text));
			} else if (message?.role === "assistant") {
				flushAssistant(assistantText(message.content));
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const { action, name, worker } = part.arguments as Record<string, string | undefined>;
					line(yellow(`  ⇢ ${part.name} ${action ?? ""} ${name ?? ""} ${worker ? `(${worker})` : ""}`.trimEnd()));
				}
				if (message.stopReason === "error") line(color(31)(`  error: ${message.errorMessage ?? "unknown"}`));
				if (streaming) line("");
			}
		} else if (event.type === "tool_execution_end" && event.entry !== undefined) {
			line(dim(`  ← ${contentText(event.entry.model?.[0]?.content).split("\n")[0]}`));
		} else if (event.type === "run_end") {
			streaming = false;
			rl.prompt(true);
		} else if (event.type === "task_failed") {
			line(color(31)(`  task failed: ${event.message}`));
		}
	}
});

harness.resume();
rl.prompt();

let pending = Promise.resolve();

async function handle(input: string): Promise<void> {
	const text = input.trim();
	if (text === "") return rl.prompt();
	if (text === "/quit" || text === "/exit") return rl.close();
	if (text === "/abort") {
		await root.abort(context);
		line(dim("aborted the current run (workers keep going)"));
		return rl.prompt();
	}
	if (text === "/status" || text.startsWith("/stop ")) {
		const args = text === "/status" ? ({ action: "status" } as const) : ({ action: "stop", name: text.slice(6).trim() } as const);
		line(dim((await delegate(host, args, `cli:${Date.now()}`, context)).text));
		return rl.prompt();
	}
	await root.submit({ type: "input", content: text, whenBusy: "steer" }, context);
}

rl.on("line", (input) => {
	pending = pending.then(() => handle(input)).catch((error: unknown) => line(color(31)(String(error))));
});

rl.on("close", async () => {
	await pending;
	await stream.stop();
	server.close();
	await harness.close(context);
	process.exit(0);
});
