// Whether the elements and the lab keep the app's look (UI-GUIDELINES.md): `npm run check:ui`, and `npm test` runs it.
//
//   - the tokens in src/ui/base.css are the app's, value for value (long-horizon-agent/src/web/style.css);
//   - an element's view.css and the lab's lab.css use the tokens: no colors of their own, no fonts of their own;
//   - motion is short and eases out: transitions and animations at most 300ms, never ease-in;
//   - each stylesheet's own classes are its own: el-<id>- in an element, lab- in the lab, so nothing collides when an
//     element goes into the app; the base's classes may be used anywhere;
//   - a component's classes are the base's or its own, and it sets no colors inline.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type UiResult = { file: string; errors: string[]; warnings: string[] };

/** The app's stylesheet: LONG_HORIZON_AGENT names the app's folder; otherwise it is looked for where it usually is. */
const APP_STYLE = [process.env.LONG_HORIZON_AGENT, "../../../buisn/long-horizon-agent", "../long-horizon-agent"]
	.filter((dir): dir is string => dir !== undefined && dir !== "")
	.map((dir) => `${dir.replace(/\/+$/, "")}/src/web/style.css`)
	.find((file) => existsSync(file)) ?? "long-horizon-agent/src/web/style.css";
const BASE = "src/ui/base.css";
const MAX_MS = 300;

/** The custom properties of each token block: light, dark by preference, dark by choice. */
export function tokenBlocks(css: string): Map<string, Map<string, string>> {
	const blocks = new Map<string, Map<string, string>>();
	const read = (label: string, start: number) => {
		const open = css.indexOf("{", start);
		let depth = 0;
		let end = open;
		for (let i = open; i < css.length; i++) {
			if (css[i] === "{") depth++;
			if (css[i] === "}" && --depth === 0) {
				end = i;
				break;
			}
		}
		const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
		const values = new Map<string, string>();
		for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) values.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
		blocks.set(label, values);
	};
	const light = css.indexOf(":root {");
	if (light !== -1) read("light", light);
	const dark = css.indexOf(":root:not([data-theme=\"light\"])");
	if (dark !== -1) read("dark (by preference)", dark);
	const chosen = css.indexOf(':root[data-theme="dark"]');
	if (chosen !== -1) read("dark (chosen)", chosen);
	return blocks;
}

/** The classes a stylesheet defines (in its selectors). */
const classesIn = (css: string) => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}").matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));

/** What is wrong with one element's or the lab's stylesheet. */
function checkSheet(file: string, prefix: string, base: Set<string>): UiResult {
	const css = readFileSync(file, "utf8");
	const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const errors: string[] = [];
	const warnings: string[] = [];
	const colors = [...plain.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab)\(/g)].map((m) => m[0]);
	if (colors.length > 0) errors.push(`It sets colors of its own (${[...new Set(colors)].join(", ")}): use the tokens (var(--ink), var(--accent), …).`);
	for (const match of plain.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/g)) {
		const value = match[1]!;
		if (/["']|\b(serif|sans-serif|monospace|system-ui|Arial|Helvetica|Inter)\b/.test(value) && !/var\(--(sans|mono|serif)\)/.test(value)) errors.push(`It names a font ("${value.trim()}"): use var(--sans) or var(--mono).`);
	}
	for (const match of plain.matchAll(/(transition|animation)\s*:\s*([^;}]+)/g)) {
		const value = match[2]!;
		for (const time of value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
			const ms = time[2] === "s" ? Number(time[1]) * 1000 : Number(time[1]);
			if (ms > MAX_MS) errors.push(`A ${match[1]} takes ${time[0]}: interface motion is at most ${MAX_MS}ms.`);
		}
		if (/\bease-in\b(?!-out)/.test(value)) errors.push(`A ${match[1]} eases in ("${value.trim()}"): ease out, so it answers at once.`);
	}
	const own = [...classesIn(css)].filter((name) => !base.has(name) && !name.startsWith(prefix));
	if (own.length > 0) errors.push(`It defines classes without its prefix ${prefix} (${own.join(", ")}): its own classes start with ${prefix}; the base's are used as they are.`);
	if (!/prefers-reduced-motion/.test(plain) && /animation\s*:/.test(plain)) warnings.push("It animates without saying what happens under prefers-reduced-motion (the base turns animation off; check it still reads).");
	return { file, errors, warnings };
}

/** What is wrong with one element's component. */
function checkView(file: string, prefix: string, base: Set<string>, own: Set<string>): UiResult {
	const source = readFileSync(file, "utf8");
	const errors: string[] = [];
	const warnings: string[] = [];
	const used = new Set<string>();
	for (const match of source.matchAll(/class=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
		// In a template, a class added on a condition is written with a leading space: \`a\${on ? " b" : ""}\`.
		const text = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, (inner) => (inner.match(/" [^"]*"/g) ?? []).join(" "));
		for (const name of text.replace(/"/g, " ").split(/\s+/)) if (/^[a-z][\w-]*$/.test(name)) used.add(name);
	}
	const unknown = [...used].filter((name) => !base.has(name) && !own.has(name));
	if (unknown.length > 0) errors.push(`It uses classes that are neither the base's nor in its view.css: ${unknown.join(", ")}.`);
	if (/style=\{\{[^}]*(#[0-9a-fA-F]{3,8}|rgba?\()/.test(source)) errors.push("It sets a color inline: use a class and the tokens.");
	const strings = [...source.matchAll(/>\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*)\s*</g)].map((m) => m[1]!.trim());
	const technical = strings.filter((s) => /\b(API|JSON|null|undefined|id|ID|webhook|endpoint|token)\b/.test(s));
	if (technical.length > 0) warnings.push(`Words people read look technical: ${technical.map((s) => `"${s}"`).join(", ")}.`);
	if (!used.has(`${prefix.replace(/-$/, "")}`) && ![...used].some((n) => n.startsWith(prefix))) warnings.push(`Its outermost element has no ${prefix.replace(/-$/, "")} class, so its styles have nothing to hang on.`);
	return { file, errors, warnings };
}

export function checkUi(): UiResult[] {
	const results: UiResult[] = [];
	const baseCss = readFileSync(BASE, "utf8");
	const base = classesIn(baseCss);

	// The tokens are the app's.
	const tokens: UiResult = { file: BASE, errors: [], warnings: [] };
	if (!existsSync(APP_STYLE)) tokens.warnings.push("The app (long-horizon-agent) was not found, so the tokens could not be compared with its own. Set LONG_HORIZON_AGENT to its folder.");
	else {
		const app = tokenBlocks(readFileSync(APP_STYLE, "utf8"));
		const ours = tokenBlocks(baseCss);
		for (const [label, values] of app) {
			const mine = ours.get(label);
			if (mine === undefined) {
				tokens.errors.push(`It has no ${label} token block; the app has one.`);
				continue;
			}
			for (const [name, value] of values) {
				if (!mine.has(name)) tokens.errors.push(`${label}: ${name} is missing (the app: ${value}).`);
				else if (mine.get(name) !== value) tokens.errors.push(`${label}: ${name} is ${mine.get(name)}, the app's is ${value}.`);
			}
			for (const name of mine.keys()) if (!values.has(name)) tokens.errors.push(`${label}: ${name} is not one of the app's tokens.`);
		}
	}
	results.push(tokens);

	for (const id of readdirSync("src/elements", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
		const dir = join("src/elements", id);
		const prefix = `el-${id}-`;
		const sheet = join(dir, "view.css");
		const view = join(dir, "view.tsx");
		if (!existsSync(view)) continue;
		let own = new Set<string>();
		if (existsSync(sheet)) {
			results.push(checkSheet(sheet, prefix, base));
			own = classesIn(readFileSync(sheet, "utf8"));
		}
		own.add(`el-${id}`);
		results.push(checkView(view, prefix, base, own));
	}
	results.push(checkSheet("src/lab/web/lab.css", "lab-", new Set([...base, "lab"])));
	return results;
}
