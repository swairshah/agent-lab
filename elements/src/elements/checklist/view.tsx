// The checklist on the screen: tick an item done, mark it blocked with a reason, add or remove items.
import { useState } from "preact/hooks";
import type { ElementViewProps } from "../../view.ts";
import type { Checklist as State, ChecklistItem } from "./element.ts";

export function ChecklistView({ state, act }: ElementViewProps<State>) {
	const [title, setTitle] = useState("");
	const [blocking, setBlocking] = useState<string | undefined>();
	const [reason, setReason] = useState("");
	const done = state.items.filter((i) => i.state === "done").length;

	const row = (item: ChecklistItem) => (
		<li class={`ck-item ${item.state}`} key={item.id}>
			<button type="button" class="ck-mark" aria-label={item.state === "done" ? `Reopen ${item.title}` : `Mark ${item.title} done`} onClick={() => void act("set_item", { id: item.id, state: item.state === "done" ? "open" : "done" })}>
				{item.state === "done" ? "✓" : item.state === "blocked" ? "!" : ""}
			</button>
			<span class="ck-text">
				<span>{item.title}</span>
				{item.note ? <span class="ck-note">{item.note}</span> : null}
				{blocking === item.id ? (
					<form
						class="inline-form"
						onSubmit={async (e) => {
							e.preventDefault();
							if (await act("set_item", { id: item.id, state: "blocked", note: reason })) (setBlocking(undefined), setReason(""));
						}}
					>
						<input autoFocus value={reason} placeholder="What blocks it?" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
						<button type="submit" class="button">Save</button>
					</form>
				) : null}
			</span>
			<span class="ck-actions">
				{item.state !== "blocked" ? <button type="button" class="link" onClick={() => setBlocking(blocking === item.id ? undefined : item.id)}>Blocked</button> : null}
				<button type="button" class="link danger" aria-label={`Remove ${item.title}`} onClick={() => void act("remove_item", { id: item.id })}>×</button>
			</span>
		</li>
	);

	return (
		<div class="ck">
			<p class="label">{state.items.length === 0 ? "Empty" : `${done} of ${state.items.length} done`}</p>
			<ul class="ck-list">{state.items.map(row)}</ul>
			<form
				class="inline-form"
				onSubmit={async (e) => {
					e.preventDefault();
					if (title.trim() && (await act("add_item", { title }))) setTitle("");
				}}
			>
				<input value={title} placeholder="Add an item…" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
				<button type="submit" class="button">Add</button>
			</form>
		</div>
	);
}
