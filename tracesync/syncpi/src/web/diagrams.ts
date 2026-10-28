// Mermaid diagrams in replies (```mermaid blocks), drawn in the page's colors. Mermaid is large, so it loads only
// when a diagram first appears. It runs with securityLevel "strict": labels can't carry HTML or script, and its
// output is sanitized before it reaches the page.
import { el } from "./dom.ts";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | undefined;
let configured = "";
let next = 0;

function token(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Loads mermaid and themes it from the CSS tokens; again when the theme changed since. */
async function mermaid(): Promise<Mermaid> {
	loading ??= import("mermaid").then((m) => m.default);
	const m = await loading;
	const theme = [token("--paper"), token("--ink"), token("--accent")].join();
	if (theme !== configured) {
		configured = theme;
		m.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: "base",
			fontFamily: token("--sans"),
			themeVariables: {
				background: token("--raised"),
				primaryColor: token("--surface"),
				primaryTextColor: token("--ink"),
				primaryBorderColor: token("--rule-strong"),
				secondaryColor: token("--sunken"),
				tertiaryColor: token("--paper"),
				lineColor: token("--muted"),
				textColor: token("--ink"),
				mainBkg: token("--surface"),
				nodeBorder: token("--rule-strong"),
				clusterBkg: token("--sunken"),
				noteBkgColor: token("--accent-soft"),
				noteTextColor: token("--ink"),
				fontSize: "14px",
			},
		});
	}
	return m;
}

/** Draws `source` into `host`; a diagram that doesn't parse shows its source and why. */
export function renderDiagram(host: HTMLElement, source: string): void {
	host.classList.add("diagram");
	const fallback = (reason: string) => {
		const pre = el("pre", "diagram-source");
		pre.textContent = source;
		host.replaceChildren(el("div", "diagram-error", `Couldn't draw this diagram: ${reason}`), pre);
	};
	void mermaid()
		.then((m) => m.render(`diagram-${++next}`, source))
		.then(({ svg }) => {
			// Mermaid's output, sanitized by it under securityLevel "strict".
			host.innerHTML = svg;
		})
		.catch((error: unknown) => fallback(error instanceof Error ? error.message.split("\n")[0]! : String(error)));
}
