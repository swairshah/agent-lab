// What an element's component is given on the screen. It shows `state` and changes it only through `act`, the same
// actions the agent calls, so every change is a version in the history whoever makes it. `act` resolves false when
// the change was refused (the page says why and refreshes).
import type { ComponentType } from "preact";

export type ElementViewProps<S> = { state: S; version: number; act(action: string, args: Record<string, unknown>): Promise<boolean> };
export type ElementView<S> = ComponentType<ElementViewProps<S>>;
