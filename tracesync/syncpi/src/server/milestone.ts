// Milestones: the agent marks the points in a thread where something significant was done (a feature built, a bug
// fixed and checked, a decision made), with a title and a short summary. The call is kept in the session like any
// tool call; the thread shows it as a marker, and the timeline beside the thread (thread-map.ts) uses it as the
// summary of its turn. The agent decides when: see the instructions in session.ts.
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const milestoneTool = defineTool({
	name: "milestone",
	description:
		"Mark a milestone in the thread: a significant change that is done and works (a feature built, a bug fixed and verified, a migration finished, a decision reached). People see it as a marker in the thread and in its timeline. Use it at most once per request, after the work, and not for questions, small tweaks or exploring.",
	parameters: Type.Object({
		title: Type.String({ description: "A few words, e.g. 'Cart totals fixed'", maxLength: 80 }),
		summary: Type.String({ description: "One or two plain sentences: what changed and why it matters", maxLength: 400 }),
	}),
	async execute(args) {
		return { output: [{ type: "text", text: "Marked." }], details: { title: args.title, summary: args.summary } };
	},
});
