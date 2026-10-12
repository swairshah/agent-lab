import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type Conversation, createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { dbPath, faux, textFrontendModel, workspace } from "./config.ts";
import { Delegation, type DelegationHost } from "./delegation.ts";
import { installFaux } from "./faux.ts";
import { textFrontendInstructions } from "./prompts.ts";
import { WebTools } from "./web-tools.ts";

export const context = BACKGROUND_CONTEXT;

export type Session = {
	harness: Harness;
	root: Conversation;
	host: DelegationHost;
};

export async function openSession(): Promise<Session> {
	const models = createModels();
	if (faux) {
		installFaux(models);
	} else {
		models.setProvider(openaiProvider());
		models.setProvider(anthropicProvider());
	}

	const registry = createRegistry();
	registry.install(Delegation);
	registry.install(CodingTools);
	registry.install(WebTools);

	await mkdir(dirname(dbPath), { recursive: true });
	const harness = await Harness.open(
		await openNodeSqliteStorage(dbPath),
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
			settings: {
				extensions: [Delegation],
				retry: { maxRetries: 3 },
				toolExecution: "parallel",
			},
		},
		context,
	);

	const root = await harness.root(context, {
		agent: { model: textFrontendModel, thinkingLevel: "low", instructions: textFrontendInstructions },
	});
	await root.configure(
		{ model: textFrontendModel, extensions: [Delegation], instructions: textFrontendInstructions, cwd: workspace },
		context,
	);

	const host: DelegationHost = {
		rootId: root.id,
		commit: (change, ctx) => harness.commit(change, ctx),
		busy: async (id, ctx) => (await harness.snapshot(LiveDoc, id, ctx))?.run !== undefined,
		abort: async (id, ctx) => (await harness.conversation(id, ctx))?.abort(ctx),
	};

	return { harness, root, host };
}
