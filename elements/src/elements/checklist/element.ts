// A checklist: what has to be true before something is finished, each item open, done or blocked, with a note. People
// tick items on the screen; the agent marks what it verified and says what blocks the rest.
import { Type } from "@earendil-works/pi-ai";
import { action, defineElement } from "../../element.ts";

export type ChecklistItem = { id: string; title: string; state: "open" | "done" | "blocked"; note?: string };
export type Checklist = { items: ChecklistItem[]; next: number };

function item(state: Checklist, id: string): ChecklistItem {
	const found = state.items.find((i) => i.id === id);
	if (found === undefined) throw new Error(`There is no item ${id}. The items are ${state.items.map((i) => `${i.id} (${i.title})`).join(", ") || "none"}.`);
	return found;
}

export const checklist = defineElement<Checklist>({
	id: "checklist",
	title: "Checklist",
	description: "What has to be done or verified, each item open, done or blocked, with a note on why.",
	initial: () => ({ items: [], next: 1 }),
	view: (state) => {
		if (state.items.length === 0) return "The checklist is empty.";
		const done = state.items.filter((i) => i.state === "done").length;
		return [`${done} of ${state.items.length} done.`, ...state.items.map((i) => `${i.id} [${i.state === "done" ? "x" : i.state === "blocked" ? "!" : " "}] ${i.title}${i.note ? ` · ${i.note}` : ""}`)].join("\n");
	},
	actions: {
		add_item: action<Checklist, { title: string }>({
			description: "Add an item to the checklist.",
			args: Type.Object({ title: Type.String({ description: "What has to be done, as a person reads it." }) }),
			apply: (state, args) => {
				const title = args.title.trim();
				if (title === "") throw new Error("Give the item a title.");
				if (state.items.some((i) => i.title.toLowerCase() === title.toLowerCase())) throw new Error(`"${title}" is already on the checklist.`);
				return { items: [...state.items, { id: `i${state.next}`, title, state: "open" }], next: state.next + 1 };
			},
			summary: (args, _before, after) => `Added ${after.items.at(-1)!.id} "${args.title.trim()}"`,
		}),
		set_item: action<Checklist, { id: string; state: "open" | "done" | "blocked"; note?: string }>({
			description: "Set an item open, done or blocked, with a note: what was found, or what blocks it.",
			args: Type.Object({
				id: Type.String({ description: "The item, as i2." }),
				state: Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Literal("blocked")]),
				note: Type.Optional(Type.String({ description: "One line: the evidence, or what blocks it. Needed for blocked." })),
			}),
			apply: (state, args) => {
				item(state, args.id);
				if (args.state === "blocked" && !args.note?.trim()) throw new Error("Say what blocks it (note).");
				return { ...state, items: state.items.map((i) => (i.id === args.id ? { ...i, state: args.state, ...(args.note?.trim() ? { note: args.note.trim() } : {}) } : i)) };
			},
			summary: (args, before) => `Set ${args.id} "${item(before, args.id).title}" ${args.state}${args.note ? `: ${args.note}` : ""}`,
		}),
		remove_item: action<Checklist, { id: string }>({
			description: "Take an item off the checklist.",
			args: Type.Object({ id: Type.String({ description: "The item, as i2." }) }),
			apply: (state, args) => {
				item(state, args.id);
				return { ...state, items: state.items.filter((i) => i.id !== args.id) };
			},
			summary: (args, before) => `Removed ${args.id} "${item(before, args.id).title}"`,
		}),
	},
});
