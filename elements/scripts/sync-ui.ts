// Writes src/ui/chat.css and src/ui/pickers.css from the app's own stylesheets: `npm run sync:ui`. Run it when the app's conversation changes.
import { writeFileSync } from "node:fs";
import { appDir, SYNCED } from "../src/ui/sync.ts";

const dir = appDir();
if (dir === undefined) {
	console.error("The app (long-horizon-agent) was not found. Set LONG_HORIZON_AGENT to its folder.");
	process.exit(1);
}
for (const [file, make] of Object.entries(SYNCED)) {
	writeFileSync(file, make(dir));
	console.log(`Wrote ${file} from ${dir}.`);
}
