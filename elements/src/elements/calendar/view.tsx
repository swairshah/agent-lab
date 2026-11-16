// The calendar on the screen, in the app's look: a compact month (a dot on days with entries), the selected day's
// entries, and what is coming up. Adding, marking done and cancelling go through the element's actions.
import { useEffect, useState } from "preact/hooks";
import { TimeField } from "../../ui/pickers.tsx";
import type { ElementViewProps } from "../../view.ts";
import type { Calendar as State, CalendarEntry } from "./element.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayLabel = (date: string, today: string) => `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}${date === today ? " · Today" : ""}`;
const when = (e: CalendarEntry) => `${new Date(`${e.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}${e.time ? ` · ${e.time}` : ""}`;

export function CalendarView({ state, act, focus }: ElementViewProps<State>) {
	const today = iso(new Date());
	const [month, setMonth] = useState(() => today.slice(0, 7));
	const [selected, setSelected] = useState(today);
	const [title, setTitle] = useState("");
	const [time, setTime] = useState("");
	// An entry the agent pointed to: turn to its day, where the page finds its row.
	useEffect(() => {
		const date = state.entries.find((e) => e.id === focus?.item)?.date;
		if (date) (setMonth(date.slice(0, 7)), setSelected(date));
	}, [focus?.key]);
	const live = state.entries.filter((e) => e.state !== "cancelled");
	const on = (date: string) => live.filter((e) => e.date === date).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
	const [y, m] = month.split("-").map(Number) as [number, number];
	const first = new Date(Date.UTC(y, m - 1, 1));
	const days = Array.from({ length: 42 }, (_, i) => iso(new Date(Date.UTC(y, m - 1, 1 - first.getUTCDay() + i))));
	const shift = (n: number) => setMonth(iso(new Date(Date.UTC(y, m - 1 + n, 1))).slice(0, 7));
	const upcoming = live.filter((e) => e.state === "scheduled" && e.date >= today).sort((a, b) => `${a.date}${a.time ?? ""}`.localeCompare(`${b.date}${b.time ?? ""}`)).slice(0, 5);

	const add = async (event: Event) => {
		event.preventDefault();
		if (title.trim() === "") return;
		if (await act("add_event", { title, date: selected, ...(time ? { time } : {}) })) (setTitle(""), setTime(""));
	};
	const entry = (e: CalendarEntry, withDate: boolean) => (
		<li class="event" key={e.id} data-item={e.id}>
			<span class={`event-dot${e.state === "scheduled" ? " tone-scheduled" : ""}`} />
			<div class="event-main">
				<div class="event-title">{e.title}</div>
				<div class="event-meta">{[withDate ? when(e) : e.time, e.state === "done" ? "Done" : "", e.note].filter(Boolean).join(" · ") || "Scheduled"}</div>
				{e.state === "scheduled" && !withDate ? (
					<div class="event-actions">
						<button type="button" class="text-button" onClick={() => void act("complete_event", { id: e.id })}>Mark done</button>
						<button type="button" class="text-button" onClick={() => void act("cancel_event", { id: e.id })}>Cancel it</button>
					</div>
				) : null}
			</div>
		</li>
	);

	return (
		<div class="el-calendar">
			<div class="el-calendar-top">
				<div class="el-calendar-month">
					<div class="el-calendar-head">
						<span class="el-calendar-name">{first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
						<span class="spacer" />
						<button type="button" class="icon-button small" aria-label="Earlier month" onClick={() => shift(-1)}>
							<svg viewBox="0 0 20 20">
								<path d="m12 5-5 5 5 5" />
							</svg>
						</button>
						<button type="button" class="el-calendar-today" onClick={() => (setMonth(today.slice(0, 7)), setSelected(today))}>
							Today
						</button>
						<button type="button" class="icon-button small" aria-label="Later month" onClick={() => shift(1)}>
							<svg viewBox="0 0 20 20">
								<path d="m8 5 5 5-5 5" />
							</svg>
						</button>
					</div>
					<div class="el-calendar-grid" role="grid">
						{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
							<span class="el-calendar-weekday" key={i}>
								{d}
							</span>
						))}
						{days.map((d) => (
							<button
								type="button"
								key={d}
								role="gridcell"
								aria-selected={d === selected}
								aria-label={`${d}, ${on(d).length} entries`}
								class="el-calendar-day"
								data-outside={d.slice(0, 7) !== month || undefined}
								data-today={d === today || undefined}
								data-entries={on(d).length > 0 || undefined}
								onClick={() => setSelected(d)}
							>
								{Number(d.slice(8))}
							</button>
						))}
					</div>
				</div>
				<div class="el-calendar-upcoming">
					<p class="section-label">Coming up</p>
					<ul class="event-list">{upcoming.length > 0 ? upcoming.map((e) => entry(e, true)) : <li class="muted small el-calendar-empty">Nothing scheduled.</li>}</ul>
				</div>
			</div>
			<p class="section-label el-calendar-day-label">{dayLabel(selected, today)}</p>
			<ul class="event-list">{on(selected).length > 0 ? on(selected).map((e) => entry(e, false)) : <li class="muted small el-calendar-empty">Nothing on this day.</li>}</ul>
			<form class="el-calendar-add" onSubmit={add}>
				<input value={title} placeholder="Add a reminder on this day…" aria-label="What is due" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
				<TimeField value={time} onChange={setTime} optional />
				<button type="submit" class="button">
					Add
				</button>
			</form>
		</div>
	);
}
