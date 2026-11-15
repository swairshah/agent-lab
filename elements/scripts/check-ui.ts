// Whether the elements and the lab keep the app's look: `npm run check:ui`. What is checked is in src/ui/check.ts and
// why in UI-GUIDELINES.md. Exits 1 on any error.
import { checkUi } from "../src/ui/check.ts";

const results = checkUi();
for (const r of results) {
	console.log(`${r.errors.length > 0 ? "✖" : r.warnings.length > 0 ? "!" : "✔"} ${r.file}`);
	for (const e of r.errors) console.log(`    error: ${e}`);
	for (const w of r.warnings) console.log(`    warning: ${w}`);
}
const failed = results.filter((r) => r.errors.length > 0).length;
process.exit(failed > 0 ? 1 : 0);
