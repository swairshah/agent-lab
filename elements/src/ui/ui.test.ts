// The elements and the lab keep the app's look (src/ui/check.ts, UI-GUIDELINES.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkUi } from "./check.ts";

test("the elements and the lab keep the app's look", () => {
	const failing = checkUi().filter((r) => r.errors.length > 0);
	assert.deepEqual(failing.map((r) => `${r.file}: ${r.errors.join(" ")}`), []);
});
