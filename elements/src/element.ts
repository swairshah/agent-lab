// What a UI element is: one thing on the screen that people and the agent share, such as a calendar or a checklist.
//
// An element is defined once, by its state and the named actions that change it. Everything else follows from that:
//   - people change it through its component, which calls the same actions;
//   - the agent gets tools from it: read it, call each action, see its history, revert it (agent.ts);
//   - every change, by anyone, is a numbered version in its history, with who did it and a line saying what changed,
//     so any version can be read again or restored (store.ts).
//
// An action is a pure function from the state and its arguments to the next state. It throws, in words a person or
// the model can act on, when the change cannot be made. It never reaches outside: no clock (use ctx.now), no network.
import type { TSchema } from "@earendil-works/pi-ai";

/** Who made a change. A tool call's id ties an agent's change to its place in the conversation. */
export type Actor = { kind: "agent"; ref?: string } | { kind: "person"; id: string; name: string };

export type ActionContext = { now: number };

export type ActionDef<S, A = Record<string, unknown>> = {
	/** For the agent's tool and the history: what the action does, in a sentence. */
	description: string;
	/** Its arguments. The agent's tool takes these, plus the version it last read. */
	args: TSchema;
	apply(state: S, args: A, ctx: ActionContext): S;
	/** One line for the history and the conversation: "Added Team offsite on Mar 1, 2027". */
	summary(args: A, before: S, after: S): string;
	/** A person doing this wakes the agent (a reminder added, a question asked), instead of telling it at its next turn. */
	wakes?: boolean;
};

export type ElementDef<S> = {
	/** Also the prefix of its tools: calendar_read, calendar_add_event. Lower case and underscores. */
	id: string;
	title: string;
	/** For the agent: what this element is and when to use it. */
	description: string;
	initial(): S;
	/** The state as the agent reads it: compact text, every id it may need to name in an action. */
	view(state: S, ctx: ActionContext): string;
	actions: Record<string, ActionDef<S, never>>;
};

/** Typing help: the actions' argument types are checked against their schemas where they are written. */
export function defineElement<S>(def: ElementDef<S>): ElementDef<S> {
	if (!/^[a-z][a-z0-9_]*$/.test(def.id)) throw new Error(`An element's id is lower case with underscores: "${def.id}".`);
	for (const name of Object.keys(def.actions)) if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`An action's name is lower case with underscores: "${name}".`);
	return def;
}

/** An action as written, with its argument type: `action<State, { title: string }>({...})`. */
export function action<S, A>(def: ActionDef<S, A>): ActionDef<S, never> {
	return def as unknown as ActionDef<S, never>;
}

/** One change in an element's history. `state` is the element after it. */
export type Op = { version: number; action: string; args: unknown; actor: Actor; summary: string; at: number; state: unknown };

export const actorName = (actor: Actor) => (actor.kind === "agent" ? "the agent" : actor.name);
