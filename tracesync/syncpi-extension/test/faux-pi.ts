// pi's side of the test: a scripted model ("pifaux/faux-1") and two tools of this pi's own, which the syncpi server
// doesn't have. Loaded with `pi -e test/faux-pi.ts`.
//   "use my tool"      calls my_tool, then says what it returned
//   "slow"             calls sleep_tool (4 s, stops when the run is stopped), then answers the newest message
//   "what do you see"  lists the messages it was given, one per line: role, then text (what the context holds)
//   anything else      "(pi) <text>"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

type Block = { type: string; text?: string; name?: string };
type M = { role: string; content: string | Block[]; toolName?: string };

const textOf = (m: M) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join(""));

function describe(m: M): string {
	const calls = typeof m.content === "string" ? "" : m.content.flatMap((b) => (b.type === "toolCall" ? [` +${b.name}`] : [])).join("");
	return m.role === "toolResult" ? `toolResult(${m.toolName}): ${textOf(m).slice(0, 80)}` : `${m.role}: ${textOf(m).slice(0, 80)}${calls}`;
}

export default function (pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "pifaux", tokensPerSecond: 300 });
	faux.setResponses(
		Array.from({ length: 1_000 }, () => (context: { messages: M[] }) => {
			const messages = context.messages.filter((m) => m.role !== "system");
			const last = messages.at(-1)!;
			if (last.role === "toolResult") {
				if (last.toolName === "my_tool") return fauxAssistantMessage(`(pi) my_tool said: ${textOf(last)}`);
				const user = messages.findLast((m) => m.role === "user");
				return fauxAssistantMessage(`(pi) slept; newest message: ${user ? textOf(user) : ""}`);
			}
			const text = textOf(last);
			if (text === "use my tool") return fauxAssistantMessage([fauxToolCall("my_tool", { path: "a.txt" })], { stopReason: "toolUse" });
			if (text === "slow") return fauxAssistantMessage([fauxToolCall("sleep_tool", {})], { stopReason: "toolUse" });
			if (text === "what do you see") return fauxAssistantMessage(`(pi) I see\n${messages.map(describe).join("\n")}`);
			return fauxAssistantMessage(`(pi) ${text}`);
		}),
	);
	pi.registerProvider(faux.provider);

	pi.registerTool({
		name: "my_tool",
		label: "My tool",
		description: "A tool only this pi has.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `contents of ${params.path}: hello from my_tool` }], details: {} };
		},
	});
	pi.registerTool({
		name: "sleep_tool",
		label: "Sleep",
		description: "Waits four seconds.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 4_000);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			return { content: [{ type: "text", text: signal?.aborted ? "stopped" : "slept 4 s" }], details: {} };
		},
	});
}
