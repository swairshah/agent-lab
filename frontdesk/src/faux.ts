import type { Message } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

function text(message: Message): string {
	const content = message.content as string | readonly { type: string; text?: string }[];
	return typeof content === "string" ? content : content.flatMap((part) => (part.text ? [part.text] : [])).join("");
}

/** A scripted stand-in for every model, so the CLI, inspector and delegation flow run without API keys. */
export function installFaux(models: MutableModels): void {
	const faux = fauxProvider({ tokensPerSecond: 80 });
	models.setProvider(faux.provider);
	let counter = 0;
	const step: FauxResponseStep = (context) => {
		const isWorker = JSON.stringify(context.messages).includes('You are the worker \\"');
		const last = context.messages.findLast((message) => message.role !== "system")!;
		const said = text(last);
		if (isWorker) {
			if (last.role === "toolResult") return fauxAssistantMessage(`Done. I checked the workspace:\n${said.slice(0, 200)}`);
			return fauxAssistantMessage([fauxToolCall("bash", { command: "pwd && ls | head -5" })], { stopReason: "toolUse" });
		}
		if (last.role === "toolResult") return fauxAssistantMessage(said);
		if (said.startsWith("[worker ")) return fauxAssistantMessage(`Update from the team: ${said}`);
		if (/implement|read|docs|build|fix|research/i.test(said)) {
			counter += 1;
			return fauxAssistantMessage(
				[
					fauxText("Handing that to a worker."),
					fauxToolCall("delegate", { action: "start", name: `job-${counter}`, task: said, worker: "opus" }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (/status/i.test(said)) {
			return fauxAssistantMessage([fauxToolCall("delegate", { action: "status" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(`(faux frontdesk) You said: ${said}`);
	};
	faux.setResponses(Array.from({ length: 10_000 }, () => step));
}
