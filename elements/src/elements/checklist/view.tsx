// The checklist on the screen, in the app's look: a round mark per item (green done, red blocked), its note under it.
// Ticking, blocking with a reason, adding and removing go through the element's actions.
import { useState } from "preact/hooks";
import type { ElementViewProps } from "../../view.ts";
import type { Checklist as State, ChecklistItem } from "./element.ts";

const CHECK = (
	<svg viewBox="0 0 20 20">
		<path d="m4.5 10.5 3.5 3.5 7.5-8" />
	</svg>
);

export function ChecklistView({ state, act }: ElementViewProps<State>) {
	const [title, setTitle] = useState("");
	const [blocking, setBlocking] = useState<string | undefined>();
	const [reason, setReason] = useState("");
	const done = state.items.filter((i) => i.state === "done").length;

	const row = (item: ChecklistItem) => (
		<li class={`check-row${item.state === "done" ? " check-verified" : item.state === "blocked" ? " check-blocked" : ""}`} key={item.id}>
			<button type="button" class="check-mark" aria-label={item.state === "done" ? `Reopen ${item.title}` : `Mark ${item.title} done`} onClick={() => void act("set_item", { id: item.id, state: item.state === "done" ? "open" : "done" })}>
				{item.state === "done" ? CHECK : item.state === "blocked" ? "!" : null}
			</button>
			<div class="check-main">
				<div class="check-title">{item.title}</div>
				{item.note ? <div class="check-note">{item.note}</div> : null}
				{blocking === item.id ? (
					<form
						class="el-checklist-inline"
						onSubmit={async (e) => {
							e.preventDefault();
							if (await act("set_item", { id: item.id, state: "blocked", note: reason })) (setBlocking(undefined), setReason(""));
						}}
					>
						<input autoFocus value={reason} placeholder="What blocks it?" aria-label="What blocks it" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
						<button type="submit" class="button">
							Save
						</button>
						<button type="button" class="button" onClick={() => setBlocking(undefined)}>
							Cancel
						</button>
					</form>
				) : null}
			</div>
			<span class="el-checklist-actions">
				{item.state !== "blocked" && blocking !== item.id ? (
					<button type="button" class="link" onClick={() => setBlocking(item.id)}>
						Blocked
					</button>
				) : null}
				<button type="button" class="link danger" onClick={() => void act("remove_item", { id: item.id })}>
					Remove
				</button>
			</span>
		</li>
	);

	return (
		<div class="el-checklist">
			<p class="section-label el-checklist-count">{state.items.length === 0 ? "Nothing on it yet" : `${done} of ${state.items.length} done`}</p>
			<ul class="checklist">{state.items.map(row)}</ul>
			<form
				class="el-checklist-inline"
				onSubmit={async (e) => {
					e.preventDefault();
					if (title.trim() && (await act("add_item", { title }))) setTitle("");
				}}
			>
				<input value={title} placeholder="Add an item…" aria-label="New item" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
				<button type="submit" class="button">
					Add
				</button>
			</form>
		</div>
	);
}
