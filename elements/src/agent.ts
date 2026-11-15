// What the agent gets from the elements that are on: for each, tools to read it, to call each of its actions, to see
// its history and to revert it; and, at every step, a line saying what changed in it since it last looked.
//
//   calendar_read                         the element now, as text, and its version
//   calendar_add_event {version, …}       one tool per action; refused if the element changed since `version`
//   calendar_history {limit?}             its changes: who, what, when
//   calendar_revert {version, to, reason} put an earlier version back
//
// Reading or changing an element marks it seen, so the line about changes shows only what people did since.
import { Type } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { TObject } from "typebox";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { type ActionDef, actorName, type ElementDef, type Op } from "./element.ts";
import { type ElementStore, Refused } from "./store.ts";

export type ElementsAgentOptions = {
	store: ElementStore;
	/** Whose elements a conversation works on: its scope. */
	scopeOf(conversationId: number): string | Promise<string>;
	/** The elements that are on, by id. Read at every step, so switching one on or off takes effect at the next. */
	enabled(): readonly string[];
	now?: () => number;
};

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16);
const line = (op: Op) => `v${op.version} ${when(op.at)} ${actorName(op.actor)}: ${op.summary}`;
const result = (text: string, details: Record<string, unknown>, isError = false) => ({ output: [{ type: "text" as const, text }], details: details as JsonObject, isError });

/** The tools of one element. */
function elementTools(def: ElementDef<unknown>, options: ElementsAgentOptions) {
	const { store } = options;
	const now = () => ({ now: (options.now ?? Date.now)() });
	const scopeOf = async (conversationId: number) => options.scopeOf(conversationId);

	const read = defineTool({
		name: `${def.id}_read`,
		description: `Read ${def.title} as it is now, with its version. ${def.description} Read it before changing it: a change names the version it was made against.`,
		parameters: Type.Object({}),
		execute: async (_args, api) => {
			const scope = await scopeOf(api.conversationId);
			const { version, state } = await store.read(scope, def.id);
			await store.markSeen(scope, def.id, version);
			return result(`${def.title}, version ${version}:\n${def.view(state, now())}`, { element: def.id, version });
		},
	});

	const actions = Object.entries(def.actions).map(([name, action]: [string, ActionDef<unknown, never>]) =>
		defineTool({
			name: `${def.id}_${name}`,
			description: `${def.title}: ${action.description}`,
			parameters: Type.Object({
				version: Type.Integer({ description: `The version of ${def.title} you last read. The change is refused if it changed since, so you never change what you have not seen.` }),
				...(action.args as TObject).properties,
			}),
			execute: async (args, api) => {
				const scope = await scopeOf(api.conversationId);
				const { version, ...rest } = args as { version: number } & Record<string, unknown>;
				try {
					const op = await store.act(scope, def.id, name, rest, { kind: "agent", ref: api.callId }, version);
					await store.markSeen(scope, def.id, op.version);
					return result(`Done: ${op.summary}. ${def.title} is at version ${op.version} now:\n${def.view(op.state, now())}`, { element: def.id, version: op.version, summary: op.summary });
				} catch (error) {
					const current = error instanceof Refused ? { current: error.current } : {};
					return result(`Not changed. ${(error as Error).message}`, { element: def.id, ...current }, true);
				}
			},
		}),
	);

	const history = defineTool({
		name: `${def.id}_history`,
		description: `The changes to ${def.title}, latest last: each version, when, who made it, and what changed. Use it to answer "who changed this" and before reverting.`,
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ description: "How many of the latest changes; 20 when left out." })) }),
		execute: async (args, api) => {
			const scope = await scopeOf(api.conversationId);
			const ops = await store.history(scope, def.id, { limit: Math.max(1, Math.min(200, args.limit ?? 20)) });
			return result(ops.length === 0 ? `${def.title} has not been changed yet.` : `${def.title}'s changes:\n${ops.map(line).join("\n")}`, { element: def.id, versions: ops.map((op) => op.version) });
		},
	});

	const revert = defineTool({
		name: `${def.id}_revert`,
		description: `Put an earlier version of ${def.title} back, undoing the changes after it. It is a new version: nothing is lost, and it can be reverted too. Only when a person asks, or to undo your own mistake; say why.`,
		parameters: Type.Object({
			version: Type.Integer({ description: `The version of ${def.title} you last read.` }),
			to: Type.Integer({ description: "The version to put back, from its history." }),
			reason: Type.String({ description: "Why, in a few words: it goes in the history." }),
		}),
		execute: async (args, api) => {
			const scope = await scopeOf(api.conversationId);
			try {
				const op = await store.revert(scope, def.id, args.to, { kind: "agent", ref: api.callId }, args.reason, args.version);
				await store.markSeen(scope, def.id, op.version);
				return result(`${op.summary}. ${def.title} is at version ${op.version} now:\n${def.view(op.state, now())}`, { element: def.id, version: op.version, summary: op.summary });
			} catch (error) {
				return result(`Not reverted. ${(error as Error).message}`, { element: def.id }, true);
			}
		},
	});

	return [read, ...actions, history, revert];
}

/** The tool names an element gives the agent, for a picker or a check. */
export function toolNames(def: ElementDef<unknown>): string[] {
	return [`${def.id}_read`, ...Object.keys(def.actions).map((name) => `${def.id}_${name}`), `${def.id}_history`, `${def.id}_revert`];
}

/**
 * One pi-durable extension per element, so each can be installed and removed alone; and one for the prompt section
 * that says what changed. `extensions()` gives those for the elements that are on.
 */
export function elementsAgent(options: ElementsAgentOptions) {
	const perElement = new Map<string, Extension>(options.store.elements().map((def) => [def.id, defineExtension({ name: `element.${def.id}`, tools: elementTools(def, options) })]));
	const changes = defineExtension({
		name: "elements",
		sections: [
			section("ui_elements", async (input) => {
				const on = options.enabled();
				if (on.length === 0) return undefined;
				const scope = await options.scopeOf(input.conversationId as number);
				const lines: string[] = ["Elements on the people's screen, which you and they both change. Each change is a numbered version they can see and revert."];
				for (const id of on) {
					const def = options.store.def(id);
					const { version } = await options.store.read(scope, id);
					const seen = await options.store.seen(scope, id);
					if (seen === undefined) lines.push(`- ${def.title} (${id}_…): version ${version}. You have not read it: ${id}_read before relying on it.`);
					else if (seen === version) lines.push(`- ${def.title}: version ${version}, as you last saw it.`);
					else {
						const since = (await options.store.history(scope, id, { after: seen })).filter((op) => op.actor.kind === "person");
						lines.push(`- ${def.title}: version ${version}; you last saw ${seen}. Since then: ${since.length > 0 ? since.map(line).join("; ") : "your own changes only"}. Read it again before changing it.`);
					}
				}
				return lines.join("\n");
			}),
		],
	});
	return {
		/** The extensions to install for the elements that are on now. */
		extensions(): Extension[] {
			return [changes, ...options.enabled().map((id) => perElement.get(id)!).filter(Boolean)];
		},
		all: perElement,
		changes,
	};
}
