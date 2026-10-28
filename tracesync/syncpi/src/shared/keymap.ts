// The commands both apps offer and their shortcuts, in one place (keymap.json, which the desktop app reads too).
// Keys are written as in Zed: modifiers then the key, joined with "-", e.g. "cmd-shift-p". "cmd" is Ctrl off a Mac.
import keymap from "./keymap.json" with { type: "json" };

export type App = "web" | "desktop";
export type Command = { id: string; title: string; group: string; keys?: string; apps: App[]; quick?: boolean };

export const COMMANDS: readonly Command[] = keymap as Command[];

export function commandsFor(app: App): Command[] {
	return COMMANDS.filter((c) => c.apps.includes(app));
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SYMBOLS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", escape: "Esc", enter: "↩", "`": "`" };
const WORDS: Record<string, string> = { cmd: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", escape: "Esc", enter: "Enter" };

/** Splits "cmd-shift-p" into its parts; the key itself may be "-" or contain no letters ("cmd-/"). */
function parts(keys: string): { mods: Set<string>; key: string } {
	const tokens = keys.split("-");
	const key = tokens.pop() || "-";
	return { mods: new Set(tokens), key };
}

/** "cmd-shift-p" as ⌘⇧P on a Mac, Ctrl+Shift+P elsewhere. */
export function formatKeys(keys: string): string {
	const { mods, key } = parts(keys);
	const order = ["ctrl", "alt", "shift", "cmd"].filter((m) => mods.has(m));
	const label = key.length === 1 ? key.toUpperCase() : (SYMBOLS[key] ?? key[0]!.toUpperCase() + key.slice(1));
	return MAC ? order.map((m) => SYMBOLS[m]).join("") + label : [...order.map((m) => WORDS[m]), WORDS[key] ?? label].join("+");
}

/** Whether a key press is this shortcut. Shifted punctuation ("cmd-}") is matched on the character typed. */
export function matchesKeys(event: KeyboardEvent, keys: string): boolean {
	const { mods, key } = parts(keys);
	const cmd = MAC ? event.metaKey : event.ctrlKey;
	if (mods.has("cmd") !== cmd) return false;
	if (MAC && mods.has("ctrl") !== event.ctrlKey) return false;
	if (mods.has("alt") !== event.altKey) return false;
	const typed = event.key.toLowerCase();
	// With Alt held, a Mac types a different character; compare the physical key instead.
	const physical = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.code === "Slash" ? "/" : event.code === "Comma" ? "," : event.code === "Backquote" ? "`" : typed;
	const shifted = /^[{}?:"<>|~!@#$%^&*()_+]$/.test(key);
	if (!shifted && mods.has("shift") !== event.shiftKey) return false;
	return typed === key || physical === key;
}
