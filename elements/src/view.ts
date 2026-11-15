// What an element's component is given on the screen. It shows `state` and changes it only through `act`, the same
// actions the agent calls, so every change is a version in the history whoever makes it. `act` resolves false when
// the change was refused (the page says why and refreshes).
//
// Each item's row carries `data-item` with the item's id, so the page can point to one: when the agent shows the
// element about an item, the page scrolls to the row and highlights it. `focus` is that item, for a component that
// must first bring it into view (the calendar turns to the entry's day); `key` changes each time it is shown again.
import type { ComponentType } from "preact";

export type ElementViewProps<S> = { state: S; version: number; act(action: string, args: Record<string, unknown>): Promise<boolean>; focus?: { item: string; key: string } };
export type ElementView<S> = ComponentType<ElementViewProps<S>>;
