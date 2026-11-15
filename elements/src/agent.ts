// What the agent gets from the elements that are on: for each, tools to read it, to call each of its actions, to see
// its history and to revert it; and, at every step, a line saying what changed in it since it last looked.
//
//   use_element {element}                 open an element in this conversation: its tools are offered from now on
//   show_element {element, about?, reason} the same, and put it in front of the people (their panel opens on it)
//   calendar_read                         the element now, as text, and its version
//   calendar_add_event {version, …}       one tool per action; refused if the element changed since `version`
//   calendar_history {limit?}             its changes: who, what, when
//   calendar_revert {version, to, reason} put an earlier version back
//
// There can be many elements, so an element's own tools are deferred: the model is offered them only once the element
// is open in its conversation, by use_element, show_element, or a person opening it on the screen (openElement). Until
// then the prompt section lists it in a line, with what it is for, so the agent knows to open it when it is relevant.
//
// Reading or changing an element marks it seen, so the line about changes shows only what people did since.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, type Conversation, type JsonObject } from "@earendil-works/pi-durable";
import type { TObject } from "typebox";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { type ActionDef, actorName, type ElementDef, type Op } from "./element.ts";
import { type ElementStore, Refused } from "./store.ts";

export type ElementsAgentOptions = {
	store: ElementStore;
	/** Whose elements a conversation works on: its scope. */
	scopeOf(conversationId: number): string | Promise<string>;
	/** The elements that are on (available to open), by id. Read at every step, so switching one on or off takes effect at the next. */
	enabled(): readonly string[];
	now?: () => number;
};

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16);
const line = (op: Op) => `v${op.version} ${when(op.at)} ${actorName(op.actor)}: ${op.summary}`;
const result = (text: string, details: Record<string, unknown>, isError = false, addTools?: string[]) => ({ output: [{ type: "text" as const, text }], details: details as JsonObject, isError, ...(addTools ? { control: { addTools } } : {}) });

/** The tools of one element. */
function elementTools(def: ElementDef<unknown>, options: ElementsAgentOptions) {
	const { store } = options;
	const now = () => ({ now: (options.now ?? Date.now)() });
	const scopeOf = async (conversationId: number) => options.scopeOf(conversationId);

	const read = defineTool({
		name: `${def.id}_read`,
		deferred: true,
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
			deferred: true,
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
		deferred: true,
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
		deferred: true,
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

/** The elements open in a request: those whose tools it offers. */
const openIn = (tools: readonly { name: string }[], ids: readonly string[]) => ids.filter((id) => tools.some((t) => t.name === `${id}_read`));

/**
 * Opens elements in a conversation for a person (they opened one on the screen): their tools are offered to the model
 * from its next request, as `control.addTools` does for the agent's own use_element. In one commit, so it never loses
 * tools the agent loaded meanwhile.
 */
export async function openElement(conversation: Conversation, defs: readonly ElementDef<unknown>[], context = BACKGROUND_CONTEXT): Promise<void> {
	const names = defs.flatMap(toolNames);
	await conversation.commit(async (tx) => {
		const state = await tx.doc(AgentDoc, conversation.id);
		if (Array.isArray(state.modelTools)) {
			for (const name of names) if (!state.modelTools.includes(name)) state.modelTools.push(name);
			return;
		}
		const add = [...(state.modelTools?.add ?? [])];
		for (const name of names) if (!add.includes(name)) add.push(name);
		state.modelTools = { ...state.modelTools, add };
	}, context);
}

/**
 * One pi-durable extension per element, so each can be installed and removed alone; and one with use_element,
 * show_element and the prompt section that lists the elements and says what changed. `extensions()` gives those for
 * the elements that are on.
 */
export function elementsAgent(options: ElementsAgentOptions) {
	const { store } = options;
	const perElement = new Map<string, Extension>(store.elements().map((def) => [def.id, defineExtension({ name: `element.${def.id}`, tools: elementTools(def, options) })]));
	const now = () => ({ now: (options.now ?? Date.now)() });

	/** Opens an element in the conversation and gives the agent what read would, so it can act at once. */
	const open = async (id: string, conversationId: number, details: Record<string, unknown>, done: (title: string) => string) => {
		if (!options.enabled().includes(id)) {
			const on = options.enabled().map((e) => store.def(e)).map((def) => `${def.id} (${def.title})`);
			return result(`There is no element ${id} to open. The elements are ${on.join(", ") || "none: none is on"}.`, { element: id }, true);
		}
		const def = store.def(id);
		const scope = await options.scopeOf(conversationId);
		const { version, state } = await store.read(scope, id);
		await store.markSeen(scope, id, version);
		return result(`${done(def.title)} Its tools are yours now (${id}_…). ${def.title}, version ${version}:\n${def.view(state, now())}`, { element: id, version, ...details }, false, toolNames(def));
	};
	const elementArg = Type.String({ description: "The element's id, from the list of elements in your instructions." });

	const use = defineTool({
		name: "use_element",
		description: "Open an element to work on it in this conversation, without changing what the people see: gives you its tools and what it holds now. Their screen marks it as changed when you change it.",
		parameters: Type.Object({ element: elementArg }),
		execute: async (args, api) => open(args.element, api.conversationId, {}, (title) => `${title} is open.`),
	});

	const show = defineTool({
		name: "show_element",
		description:
			"Put an element in front of the people: their side panel opens on it, at an item if you name one. Use it when the element is what you are talking about now (planning the week: the calendar), not for every change you make; your other changes only mark it. Also opens it for you, as use_element does.",
		parameters: Type.Object({
			element: elementArg,
			about: Type.Optional(Type.String({ description: "An item to point to, by its id in the element's text (an entry, a task)." })),
			reason: Type.String({ description: "Why you are showing it, in a few plain words the people see: \"to plan next week\"." }),
		}),
		execute: async (args, api) => open(args.element, api.conversationId, { shown: true, reason: args.reason, ...(args.about ? { about: args.about } : {}) }, (title) => `${title} is on the people's screen now.`),
	});

	const changes = defineExtension({
		name: "elements",
		tools: [use, show],
		sections: [
			section("ui_elements", async (input) => {
				const on = options.enabled();
				if (on.length === 0) return undefined;
				const scope = await options.scopeOf(input.conversationId as number);
				const opened = openIn(input.agent?.tools ?? [], on);
				const lines: string[] = ["Elements on the people's screen, which you and they both change. Each change is a numbered version they can see and revert."];
				if (opened.length > 0) lines.push("Open in this conversation:");
				for (const id of opened) {
					const def = store.def(id);
					const { version } = await store.read(scope, id);
					const seen = await store.seen(scope, id);
					if (seen === undefined) lines.push(`- ${def.title} (${id}_…): version ${version}. You have not read it: ${id}_read before relying on it.`);
					else if (seen === version) lines.push(`- ${def.title}: version ${version}, as you last saw it.`);
					else {
						const since = (await store.history(scope, id, { after: seen })).filter((op) => op.actor.kind === "person");
						lines.push(`- ${def.title}: version ${version}; you last saw ${seen}. Since then: ${since.length > 0 ? since.map(line).join("; ") : "your own changes only"}. Read it again before changing it.`);
					}
				}
				const closed = on.filter((id) => !opened.includes(id));
				if (closed.length > 0) {
					lines.push("Not open yet: when one is relevant, use_element to work on it, or show_element to put it in front of the people too.");
					for (const id of closed) lines.push(`- ${store.def(id).title} (${id}): ${store.def(id).description}`);
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
