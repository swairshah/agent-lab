// The calendar on the screen: a month, the selected day's entries, and what is coming up. Adding, marking done and
// cancelling go through the element's actions.
import { useState } from "preact/hooks";
import type { ElementViewProps } from "../../view.ts";
import type { Calendar as State, CalendarEntry } from "./element.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function CalendarView({ state, act }: ElementViewProps<State>) {
	const today = iso(new Date());
	const [month, setMonth] = useState(() => today.slice(0, 7));
	const [selected, setSelected] = useState(today);
	const [title, setTitle] = useState("");
	const [time, setTime] = useState("");
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
	const row = (e: CalendarEntry) => (
		<li class={`cal-entry ${e.state}`} key={e.id}>
			<span class="cal-dot" />
			<span class="cal-text">
				<span class="cal-title">{e.title}</span>
				<span class="cal-meta">{[e.id, e.time, e.state === "done" ? "done" : "", e.note].filter(Boolean).join(" · ")}</span>
			</span>
			{e.state === "scheduled" ? (
				<span class="cal-actions">
					<button type="button" class="link" onClick={() => void act("complete_event", { id: e.id })}>Done</button>
					<button type="button" class="link danger" onClick={() => void act("cancel_event", { id: e.id })}>Cancel</button>
				</span>
			) : null}
		</li>
	);

	return (
		<div class="cal">
			<div class="cal-head">
				<b>{first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</b>
				<span class="spacer" />
				<button type="button" class="link" onClick={() => shift(-1)} aria-label="Earlier month">‹</button>
				<button type="button" class="link" onClick={() => (setMonth(today.slice(0, 7)), setSelected(today))}>Today</button>
				<button type="button" class="link" onClick={() => shift(1)} aria-label="Later month">›</button>
			</div>
			<div class="cal-grid">
				{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span class="cal-wd" key={i}>{d}</span>)}
				{days.map((d) => (
					<button type="button" key={d} class={`cal-day${d.slice(0, 7) !== month ? " out" : ""}${d === today ? " today" : ""}${d === selected ? " sel" : ""}`} onClick={() => setSelected(d)}>
						{Number(d.slice(8))}
						{on(d).length > 0 ? <i /> : null}
					</button>
				))}
			</div>
			<p class="label">{label(selected)}</p>
			<ul class="cal-list">{on(selected).length > 0 ? on(selected).map(row) : <li class="muted">Nothing on this day.</li>}</ul>
			<form class="inline-form" onSubmit={add}>
				<input value={title} placeholder="Add on this day…" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
				<input type="time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
				<button type="submit" class="button">Add</button>
			</form>
			<p class="label">Coming up</p>
			<ul class="cal-list">{upcoming.length > 0 ? upcoming.map((e) => <li class="cal-entry" key={e.id}><span class="cal-dot" /><span class="cal-text"><span class="cal-title">{e.title}</span><span class="cal-meta">{label(e.date)}{e.time ? ` · ${e.time}` : ""}</span></span></li>) : <li class="muted">Nothing scheduled.</li>}</ul>
		</div>
	);
}
