// Testing one element alone. `testElement(def)` gives it a temporary store, and three ways in:
//   act / revert          as a person on the screen would (no model)
//   callTool              as the agent would: one tool call through a real pi-durable Harness with a scripted model
//   sectionText           the line the agent reads about it at its next step
//
// The element starts open in the conversation (its tools offered), as if the agent had called use_element; pass
// `{ open: false }` to start before that, where only use_element and show_element are offered.
//
//   const t = await testElement(calendar);
//   await t.act("add_event", { title: "Team offsite", date: "2027-03-01" });
//   const result = await t.callTool("calendar_read", {});
//   await t.dispose();
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { elementsAgent } from "./agent.ts";
import type { Actor, ElementDef, Op } from "./element.ts";
import { ElementStore } from "./store.ts";

export const PERSON: Actor = { kind: "person", id: "u_ada", name: "Ada" };
const SCOPE = "test";

export async function testElement<S>(def: ElementDef<S>, options: { now?: () => number; open?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "element-"));
	const db = await openNodeSqliteDatabase(join(dir, "elements.sqlite"));
	const now = options.now ?? (() => Date.parse("2026-11-14T15:00:00Z"));
	const store = await ElementStore.open(db, [def as unknown as ElementDef<never>], now);
	const agent = elementsAgent({ store, scopeOf: () => SCOPE, enabled: () => [def.id], now });
	const own = (agent.all.get(def.id)?.tools ?? []) as ToolRegistration[];
	const opened = options.open ?? true;

	return {
		store,
		/** The element now. */
		read: async () => (await store.read(SCOPE, def.id)) as { version: number; state: S },
		view: async () => def.view((await store.read(SCOPE, def.id)).state as S, { now: now() }),
		/** A person's change, against the current version unless one is given. */
		act: async (name: string, args: Record<string, unknown>, actor: Actor = PERSON, expected?: number): Promise<Op> => store.act(SCOPE, def.id, name, args, actor, expected ?? (await store.read(SCOPE, def.id)).version),
		revert: (to: number, actor: Actor = PERSON, reason?: string) => store.revert(SCOPE, def.id, to, actor, reason),
		history: () => store.history(SCOPE, def.id),
		/** One tool call, as the agent makes it; what the model would see back, and the tools offered after it. */
		callTool: async (name: string, args: Record<string, unknown>) => {
			const faux = fauxProvider({ tokensPerSecond: 100_000 });
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" }), fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
			const registry = createRegistry();
			for (const extension of agent.extensions()) registry.install(extension);
			const harness = await Harness.open(new MemoryStorage(), { models, registry, now }, BACKGROUND_CONTEXT);
			try {
				const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.getModel().id }, ...(opened ? { modelTools: { add: own } } : {}) } });
				await (await root.submit({ type: "input", content: `call ${name}` }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
				const page = await root.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
				const message = page.items.find((e) => e.kind === "pi.tool-result")?.model?.[0] as { content?: { text?: string }[]; isError?: boolean; details?: Record<string, unknown> } | undefined;
				if (message === undefined) throw new Error(`The tool ${name} was never called. Its tools are ${own.map((t) => t.name).join(", ")}.`);
				return { text: (message.content ?? []).map((b) => b.text ?? "").join(""), isError: message.isError === true, details: message.details ?? {}, offered: (await root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name) };
			} finally {
				await harness.close(BACKGROUND_CONTEXT);
			}
		},
		/** The line about this element in the agent's prompt, as at its next step. */
		sectionText: async () => {
			const section = agent.changes.sections![0]!;
			const tools = [...(agent.changes.tools ?? []), ...(opened ? own : [])];
			return String(await section.render({ conversationId: 1, agent: { tools } } as never, BACKGROUND_CONTEXT));
		},
		dispose: async () => {
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
