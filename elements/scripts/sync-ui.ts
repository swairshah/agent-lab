// Writes src/ui/chat.css from the app's own stylesheets: `npm run sync:ui`. Run it when the app's conversation changes.
import { writeFileSync } from "node:fs";
import { appDir, chatCss } from "../src/ui/sync.ts";

const dir = appDir();
if (dir === undefined) {
	console.error("The app (long-horizon-agent) was not found. Set LONG_HORIZON_AGENT to its folder.");
	process.exit(1);
}
writeFileSync("src/ui/chat.css", chatCss(dir));
console.log(`Wrote src/ui/chat.css from ${dir}.`);
