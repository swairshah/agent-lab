// A local chat with an agent and the elements you choose:
//   npm run lab -- --ui calendar,checklist            with the scripted test model ("tool <name> <json>" calls a tool)
//   npm run lab -- --ui calendar --model anthropic/claude-sonnet-5.5   with a real model (OPENROUTER_API_KEY in .env)
//   --port 8300   --fresh (start from nothing; otherwise data/lab.sqlite carries over)
// Elements not in --ui can be switched on from the page.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { ELEMENTS } from "../src/elements/index.ts";
import { startLab } from "../src/lab/server.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const ids = ELEMENTS.map((e) => e.id);
const ui = (option("--ui") ?? ids.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const unknown = ui.filter((id) => !ids.includes(id));
if (unknown.length > 0) {
	console.error(`No element ${unknown.join(", ")}. The elements are ${ids.join(", ")}.`);
	process.exit(1);
}
const model = option("--model") ?? (process.env.OPENROUTER_API_KEY ? "anthropic/claude-sonnet-5.5" : "faux");
mkdirSync("data", { recursive: true });
if (args.includes("--fresh") && existsSync("data/lab.sqlite")) rmSync("data/lab.sqlite");
const lab = await startLab({ elements: ELEMENTS, on: ui, model, port: Number(option("--port") ?? 8300), dbPath: "data/lab.sqlite", webDir: "dist" });
console.log(`Lab on ${lab.url}\n  elements on: ${ui.join(", ") || "none"}\n  model: ${model === "faux" ? 'test model (write "tool <name> <json>" to call a tool)' : model}`);
process.on("SIGINT", () => void lab.close().then(() => process.exit(0)));
