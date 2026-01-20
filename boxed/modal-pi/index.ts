/**
 * Modal Pi CLI - A REPL that runs an LLM agent with tools proxied to a Modal sandbox.
 *
 * Usage:
 *   export MODAL_TOKEN_ID="your-token-id"
 *   export MODAL_TOKEN_SECRET="your-token-secret"
 *   export ANTHROPIC_API_KEY="your-key"      # for claude-* models
 *   export OPENROUTER_API_KEY="your-key"     # for *glm* models
 *   export OPENAI_API_KEY="your-key"         # for gpt-*, o1-*, o3-* models
 *   export GOOGLE_API_KEY="your-key"         # for gemini-* models
 *   export MODEL="claude-sonnet-4-20250514"  # optional, defaults to claude-sonnet-4
 *   bun run index.ts [sandbox-name]
 *
 * Model selection (auto-detects provider):
 *   MODEL=claude-sonnet-4-20250514  → Anthropic
 *   MODEL=z-ai/glm-4.7              → OpenRouter
 *   MODEL=gpt-4o                    → OpenAI
 *   MODEL=gemini-2.0-flash          → Google
 *
 * Sandbox will be created if it doesn't exist.
 *
 * NOTE: All command execution happens in REMOTE Modal sandbox containers,
 * not on the local machine. This provides secure, isolated execution.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { ModalClient, type Sandbox } from "modal";
import * as readline from "readline";
import { createModalTools } from "./tools.js";
import { printSummary, type ToolCallInfo } from "./utils.js";

// Default model if MODEL env var not set
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

type SupportedProvider = "anthropic" | "openrouter" | "openai" | "google";

const PROVIDER_CONFIG: Record<SupportedProvider, { apiKeyEnv: string; baseUrl: string; api: string }> = {
	anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com", api: "anthropic" },
	openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
	openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
	google: { apiKeyEnv: "GOOGLE_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google" },
};

/**
 * Detect provider based on model name.
 * - claude* → anthropic
 * - *glm* → openrouter (e.g., z-ai/glm-4.7)
 * - gpt*, o1*, o3* → openai
 * - gemini* → google
 */
function detectProvider(modelName: string): SupportedProvider {
	const lower = modelName.toLowerCase();
	if (lower.startsWith("claude")) return "anthropic";
	if (lower.includes("glm")) return "openrouter";
	if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) return "openai";
	if (lower.startsWith("gemini")) return "google";
	throw new Error(
		`Unsupported model: ${modelName}. Supported: claude-*, *glm*, gpt-*, o1-*, o3-*, gemini-*`,
	);
}

/**
 * Get or create a model configuration.
 * Tries the registry first, falls back to custom config for dynamic models.
 */
function getModelConfig(provider: SupportedProvider, modelName: string): Model<any> {
	// Try to get from registry first
	const registryModel = getModel(provider as any, modelName as any);
	if (registryModel) {
		return registryModel;
	}

	// Fallback: create custom config for models not in registry
	const config = PROVIDER_CONFIG[provider];
	return {
		id: modelName,
		name: modelName,
		api: config.api,
		provider: provider,
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<any>;
}

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools for file operations, search, and command execution in a Modal sandbox.

Available tools:
- Read: Read file contents
- Write: Write content to files
- Edit: Search and replace in files
- Glob: Find files by pattern
- Grep: Search file contents
- Bash: Execute shell commands
- LS: List directory contents

All file operations and commands execute in an isolated Modal sandbox environment.`;

class ModalAgent {
	private sandboxName: string;
	private timeout: number;
	private modelName: string;
	private provider: SupportedProvider;
	private modal: ModalClient | null = null;
	private sandbox: Sandbox | null = null;
	private agent: Agent | null = null;

	constructor(sandboxName: string, modelName: string, timeout = 3600000) {
		this.sandboxName = sandboxName;
		this.modelName = modelName;
		this.provider = detectProvider(modelName);
		this.timeout = timeout;
	}

	async setup(): Promise<void> {
		console.log(`Setting up Modal sandbox: ${this.sandboxName}`);
		console.log(`  Model: ${this.modelName} (provider: ${this.provider})`);

		this.modal = new ModalClient();

		// Get or create app
		const app = await this.modal.apps.fromName("claude-sandbox", { createIfMissing: true });
		console.log(`  Using Modal app: claude-sandbox`);

		// Get or create sandbox
		this.sandbox = await this.getOrCreateSandbox(app);
		await this.testConnection();

		// Create agent with Modal tools
		const tools = createModalTools(this.sandbox);

		this.agent = new Agent({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
				model: getModelConfig(this.provider, this.modelName),
				tools,
			},
		});

		console.log(`  Agent connected with Modal-proxied tools\n`);
	}

	private async getOrCreateSandbox(app: any): Promise<Sandbox> {
		try {
			// Try to get existing sandbox by name from the app
			const sandbox = await this.modal!.sandboxes.fromName("claude-sandbox", this.sandboxName);

			// Check if it's still running
			const exitCode = await sandbox.poll();
			if (exitCode !== null) {
				throw new Error("Sandbox terminated");
			}

			console.log(`  Connected to existing sandbox: ${this.sandboxName}`);
			return sandbox;
		} catch {
			// Create new sandbox
			return this.createSandbox(app);
		}
	}

	private async createSandbox(app: any): Promise<Sandbox> {
		// Use a Python image with common dev tools
		const image = this.modal!.images.fromRegistry("python:3.11-slim");

		const sandbox = await this.modal!.sandboxes.create(app, image, {
			timeoutMs: this.timeout,
			name: this.sandboxName,
			workdir: "/root",
		});

		console.log(`  Created new sandbox: ${this.sandboxName}`);

		// Install useful tools in the sandbox (runs in remote container)
		const installCmd =
			"apt-get update && apt-get install -y git curl vim ripgrep jq && pip install ipython requests numpy pandas";
		console.log("  Installing dev tools...");
		const proc = await sandbox.exec(["bash", "-c", installCmd], { timeoutMs: 300000 });
		await proc.wait();

		return sandbox;
	}

	private async testConnection(): Promise<void> {
		const proc = await this.sandbox!.exec(["echo", "Modal sandbox connected!"]);
		let output = "";
		for await (const chunk of proc.stdout) {
			output += chunk;
		}
		console.log(`  ${output.trim()}`);
	}

	async chat(message: string): Promise<string> {
		const toolCalls: ToolCallInfo[] = [];
		let responseText = "";

		// Subscribe to events
		const unsubscribe = this.agent!.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						process.stdout.write(event.assistantMessageEvent.delta);
						responseText += event.assistantMessageEvent.delta;
					}
					break;

				case "tool_execution_start":
					console.log(`\n  > ${event.toolName}: ${truncate(JSON.stringify(event.args), 80)}`);
					toolCalls.push({
						name: event.toolName,
						args: event.args,
						isError: false,
					});
					break;

				case "tool_execution_end": {
					const lastCall = toolCalls[toolCalls.length - 1];
					if (lastCall) {
						lastCall.isError = event.isError;
						if (event.result?.content?.[0]?.type === "text") {
							lastCall.result = event.result.content[0].text;
						}
					}

					const status = event.isError ? "x" : "|";
					const resultText = event.result?.content?.[0]?.type === "text" ? event.result.content[0].text : "";
					console.log(`  ${status} ${truncate(resultText, 80)}`);
					break;
				}

				case "message_end":
					console.log();
					break;
			}
		});

		try {
			await this.agent!.prompt(message);
		} finally {
			unsubscribe();
		}

		return responseText;
	}

	async repl(): Promise<void> {
		console.log("=".repeat(60));
		console.log("Modal Pi REPL");
		console.log("Type your messages, 'exit' to quit, 'clear' for new session");
		console.log("=".repeat(60));
		console.log();

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const prompt = (): Promise<string> =>
			new Promise((resolve) => {
				rl.question("\x1b[1;32mYou:\x1b[0m ", (answer) => {
					resolve(answer);
				});
			});

		while (true) {
			try {
				const userInput = (await prompt()).trim();

				if (!userInput) {
					continue;
				}

				if (userInput.toLowerCase() === "exit") {
					console.log("\nGoodbye.");
					break;
				}

				if (userInput.toLowerCase() === "clear") {
					this.agent!.clearMessages();
					console.log("Session cleared.\n");
					continue;
				}

				if (userInput.toLowerCase() === "summary") {
					printSummary(this.agent!.state.messages, []);
					continue;
				}

				console.log();
				await this.chat(userInput);
				console.log();
			} catch (e) {
				if ((e as any).code === "ERR_USE_AFTER_CLOSE") {
					break;
				}
				console.log(`\nError: ${e}\n`);
			}
		}

		rl.close();
	}

	cleanup(): void {
		if (this.modal) {
			this.modal.close();
		}
	}
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + "...";
}

async function main() {
	const sandboxName = process.argv[2] || `claude-${process.env.USER || "default"}`;
	const modelName = process.env.MODEL || DEFAULT_MODEL;
	const provider = detectProvider(modelName);

	// Check for required API key based on provider
	const requiredKey = PROVIDER_CONFIG[provider].apiKeyEnv;
	if (!process.env[requiredKey]) {
		console.error(`Error: ${requiredKey} environment variable required for provider '${provider}'`);
		console.error(`  Model: ${modelName}`);
		process.exit(1);
	}

	const agent = new ModalAgent(sandboxName, modelName);

	try {
		await agent.setup();
		await agent.repl();
	} finally {
		agent.cleanup();
	}
}

main().catch(console.error);
