// The app's conversation styles, taken from its own stylesheets: the thread, the message box, the status bar, and the
// wake-up rows. `npm run sync:ui` writes them to src/ui/chat.css; the look check fails when that file is not what the
// app has now. So the lab's conversation is the app's, not a copy that drifts.
import { existsSync, readFileSync } from "node:fs";

/** The app's folder: LONG_HORIZON_AGENT, or where it usually is. */
export function appDir(): string | undefined {
	return [process.env.LONG_HORIZON_AGENT, "../../../buisn/long-horizon-agent", "../long-horizon-agent"]
		.filter((dir): dir is string => dir !== undefined && dir !== "")
		.map((dir) => dir.replace(/\/+$/, ""))
		.find((dir) => existsSync(`${dir}/src/web/style.css`));
}

/** The sections of the app's style.css under these headers ("/* ---------- the thread ---------- *\/"). */
function sections(css: string, titles: string[]): string {
	const headers = [...css.matchAll(/^\/\* -{6,} (.+?) -{6,} \*\/$/gm)].map((m) => ({ title: m[1]!, at: m.index! }));
	return titles
		.map((title) => {
			const i = headers.findIndex((h) => h.title === title);
			if (i === -1) throw new Error(`The app's style.css has no section "${title}".`);
			return css.slice(headers[i]!.at, headers[i + 1]?.at ?? css.length).trimEnd();
		})
		.join("\n\n");
}

/** The app's rules whose selector starts with one of these, from its app.css. */
function rules(css: string, starts: string[]): string {
	return css
		.split("\n")
		.filter((line) => starts.some((s) => line.startsWith(s)))
		.join("\n");
}

export function chatCss(dir: string): string {
	const style = readFileSync(`${dir}/src/web/style.css`, "utf8");
	const app = readFileSync(`${dir}/src/web/app.css`, "utf8");
	return [
		"/* The app's conversation (long-horizon-agent/src/web/style.css and app.css), written by `npm run sync:ui`.",
		" * Do not edit: change the app, then sync. `npm run check:ui` fails when this differs from the app's. */",
		"",
		sections(style, ["the thread", "composer: the next row of the thread", "status bar"]),
		"",
		"/* ---------- from app.css: the conversation's own rows ---------- */",
		"",
		rules(app, [".center > .scroller", ".wake", ".wake-", ".tool-", ".msg-body", ".notice", ".composer-row", ".composer {"]),
		"",
	].join("\n");
}
