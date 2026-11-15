// A calendar: things due on a day (a renewal, a follow-up, a call), each scheduled, done or cancelled. People add and
// cancel entries on the screen; the agent schedules what it is waiting on and marks what happened.
import { Type } from "@earendil-works/pi-ai";
import { action, defineElement } from "../../element.ts";

export type CalendarEntry = { id: string; title: string; date: string; time?: string; note?: string; state: "scheduled" | "done" | "cancelled" };
export type Calendar = { entries: CalendarEntry[]; next: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function checkDate(date: string, time?: string): void {
	if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`"${date}" is not a date: use YYYY-MM-DD.`);
	if (time !== undefined && !TIME.test(time)) throw new Error(`"${time}" is not a time: use HH:MM, 24-hour.`);
}

function entry(state: Calendar, id: string): CalendarEntry {
	const found = state.entries.find((e) => e.id === id);
	if (found === undefined) throw new Error(`There is no entry ${id}. The entries are ${state.entries.map((e) => `${e.id} (${e.title})`).join(", ") || "none"}.`);
	return found;
}

const change = (state: Calendar, id: string, patch: Partial<CalendarEntry>): Calendar => ({ ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

export const calendar = defineElement<Calendar>({
	id: "calendar",
	title: "Calendar",
	description: "What is due on which day: renewals, follow-ups, calls, reminders. The people see it as a month.",
	initial: () => ({ entries: [], next: 1 }),
	view: (state, ctx) => {
		const today = new Date(ctx.now).toISOString().slice(0, 10);
		const live = state.entries.filter((e) => e.state !== "cancelled").sort((a, b) => `${a.date}${a.time ?? ""}`.localeCompare(`${b.date}${b.time ?? ""}`));
		if (live.length === 0) return `Nothing on the calendar. Today is ${today}.`;
		const row = (e: CalendarEntry) => `${e.id} · ${e.date}${e.time ? ` ${e.time}` : ""} · ${e.title}${e.state === "done" ? " (done)" : ""}${e.note ? ` · ${e.note}` : ""}`;
		const coming = live.filter((e) => e.state === "scheduled" && e.date >= today);
		const late = live.filter((e) => e.state === "scheduled" && e.date < today);
		const done = live.filter((e) => e.state === "done");
		return [`Today is ${today}.`, coming.length ? `Coming up:\n${coming.map(row).join("\n")}` : "", late.length ? `Past due, not marked done:\n${late.map(row).join("\n")}` : "", done.length ? `Done:\n${done.map(row).join("\n")}` : ""].filter(Boolean).join("\n");
	},
	actions: {
		add_event: action<Calendar, { title: string; date: string; time?: string; note?: string }>({
			description: "Put something on a day: a renewal, a follow-up, a reminder.",
			args: Type.Object({
				title: Type.String({ description: "What is due, as a person reads it on the calendar." }),
				date: Type.String({ description: "YYYY-MM-DD." }),
				time: Type.Optional(Type.String({ description: "HH:MM, 24-hour, when it has a time." })),
				note: Type.Optional(Type.String()),
			}),
			apply: (state, args) => {
				if (args.title.trim() === "") throw new Error("Give the entry a title.");
				checkDate(args.date, args.time);
				const added: CalendarEntry = { id: `e${state.next}`, title: args.title.trim(), date: args.date, state: "scheduled", ...(args.time ? { time: args.time } : {}), ...(args.note?.trim() ? { note: args.note.trim() } : {}) };
				return { entries: [...state.entries, added], next: state.next + 1 };
			},
			summary: (args, _before, after) => `Added ${after.entries.at(-1)!.id} "${args.title.trim()}" on ${day(args.date)}${args.time ? ` at ${args.time}` : ""}`,
			wakes: true,
		}),
		move_event: action<Calendar, { id: string; date: string; time?: string }>({
			description: "Move an entry to another day or time.",
			args: Type.Object({ id: Type.String({ description: "The entry, as e3." }), date: Type.String({ description: "YYYY-MM-DD." }), time: Type.Optional(Type.String({ description: "HH:MM, 24-hour." })) }),
			apply: (state, args) => {
				const found = entry(state, args.id);
				if (found.state !== "scheduled") throw new Error(`${found.id} "${found.title}" is ${found.state}: only a scheduled entry moves.`);
				checkDate(args.date, args.time);
				return change(state, args.id, { date: args.date, ...(args.time ? { time: args.time } : {}) });
			},
			summary: (args, before) => `Moved ${args.id} "${entry(before, args.id).title}" from ${day(entry(before, args.id).date)} to ${day(args.date)}${args.time ? ` at ${args.time}` : ""}`,
		}),
		complete_event: action<Calendar, { id: string; note?: string }>({
			description: "Mark an entry done, with what happened.",
			args: Type.Object({ id: Type.String({ description: "The entry, as e3." }), note: Type.Optional(Type.String({ description: "What happened, in a line." })) }),
			apply: (state, args) => {
				const found = entry(state, args.id);
				if (found.state !== "scheduled") throw new Error(`${found.id} "${found.title}" is already ${found.state}.`);
				return change(state, args.id, { state: "done", ...(args.note?.trim() ? { note: args.note.trim() } : {}) });
			},
			summary: (args, before) => `Marked ${args.id} "${entry(before, args.id).title}" done${args.note ? `: ${args.note}` : ""}`,
		}),
		cancel_event: action<Calendar, { id: string; reason?: string }>({
			description: "Take an entry off the calendar. It stays in the history.",
			args: Type.Object({ id: Type.String({ description: "The entry, as e3." }), reason: Type.Optional(Type.String()) }),
			apply: (state, args) => {
				const found = entry(state, args.id);
				if (found.state === "cancelled") throw new Error(`${found.id} is already cancelled.`);
				return change(state, args.id, { state: "cancelled", ...(args.reason?.trim() ? { note: args.reason.trim() } : {}) });
			},
			summary: (args, before) => `Cancelled ${args.id} "${entry(before, args.id).title}"${args.reason ? `: ${args.reason}` : ""}`,
		}),
	},
});
