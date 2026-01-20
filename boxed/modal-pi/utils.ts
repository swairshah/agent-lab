import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

export interface ToolCallInfo {
	name: string;
	args: any;
	result?: string;
	isError: boolean;
}

export function printSummary(messages: AgentMessage[], toolCalls: ToolCallInfo[]) {
	console.log("\n" + "=".repeat(60));
	console.log("SUMMARY");
	console.log("=".repeat(60));

	// Tool calls summary
	console.log("\n--- Tool Calls ---");
	if (toolCalls.length === 0) {
		console.log("No tool calls made");
	} else {
		toolCalls.forEach((call, i) => {
			console.log(`${i + 1}. ${call.name}`);
			console.log(`   Args: ${JSON.stringify(call.args)}`);
			console.log(`   Result: ${call.result || "(no text result)"}`);
			console.log(`   Error: ${call.isError}`);
		});
	}
	console.log(`Total tool calls: ${toolCalls.length}`);

	// Messages summary
	console.log("\n--- Messages ---");
	let userCount = 0;
	let assistantCount = 0;
	let toolResultCount = 0;

	messages.forEach((msg, i) => {
		const role = msg.role;
		if (role === "user") {
			userCount++;
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join(" ");
			console.log(`${i + 1}. [user] ${content.slice(0, 50)}${content.length > 50 ? "..." : ""}`);
		} else if (role === "assistant") {
			assistantCount++;
			const textContent = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
			const toolCallCount = msg.content.filter((c) => c.type === "toolCall").length;
			console.log(
				`${i + 1}. [assistant] ${textContent.slice(0, 50)}${textContent.length > 50 ? "..." : ""}${toolCallCount > 0 ? ` (+${toolCallCount} tool calls)` : ""}`,
			);
		} else if (role === "toolResult") {
			toolResultCount++;
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
			console.log(
				`${i + 1}. [toolResult:${msg.toolName}] ${content.slice(0, 50)}${content.length > 50 ? "..." : ""}`,
			);
		}
	});
	console.log(`Total: ${userCount} user, ${assistantCount} assistant, ${toolResultCount} tool results`);

	// Usage & cost summary
	console.log("\n--- Usage & Cost ---");
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	messages.forEach((msg) => {
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			totalInput += assistantMsg.usage.input;
			totalOutput += assistantMsg.usage.output;
			totalCacheRead += assistantMsg.usage.cacheRead;
			totalCacheWrite += assistantMsg.usage.cacheWrite;
			totalCost += assistantMsg.usage.cost.total;
		}
	});

	console.log(`Input tokens:  ${totalInput.toLocaleString()}`);
	console.log(`Output tokens: ${totalOutput.toLocaleString()}`);
	console.log(`Cache read:    ${totalCacheRead.toLocaleString()}`);
	console.log(`Cache write:   ${totalCacheWrite.toLocaleString()}`);
	console.log(`Total tokens:  ${(totalInput + totalOutput).toLocaleString()}`);
	console.log(`Total cost:    $${totalCost.toFixed(6)}`);

	console.log("\n" + "=".repeat(60));
}
