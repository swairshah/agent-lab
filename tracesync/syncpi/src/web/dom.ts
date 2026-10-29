// Small DOM helpers shared by the web view's modules.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Creates an element with a class and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** A stable color per person, so names, avatars and presence dots match everywhere. */
function personHue(name: string): number {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h % 360;
}

/** A person's color, for CSS: their hue (from their name), in the theme's saturation and lightness (style.css). */
export function personColor(name: string): string {
	return `hsl(${personHue(name)} var(--person-s) var(--person-l))`;
}

/** The same color as a plain value, the light theme's, for drawing (a canvas can't read the theme's variables). */
export function personColorValue(name: string): string {
	return `hsl(${personHue(name)} 42% 48%)`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
	get(key: string): string | undefined {
		try {
			return localStorage.getItem(key) ?? undefined;
		} catch {
			return undefined;
		}
	},
	set(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {}
	},
	remove(key: string): void {
		try {
			localStorage.removeItem(key);
		} catch {}
	},
};

export function relativeTime(at: number): string {
	const s = Math.round((Date.now() - at) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
	return new Date(at).toLocaleDateString();
}
