import assert from "node:assert/strict";
import { test } from "node:test";
import { testElement } from "../../testing.ts";
import { checklist } from "./element.ts";

test("checklist: items are added, set and removed by anyone, and a blocked item says why", async () => {
	const t = await testElement(checklist);
	try {
		await t.act("add_item", { title: "State license, primary source" });
		await t.act("add_item", { title: "NPDB query" });
		await assert.rejects(t.act("add_item", { title: "npdb query" }), /already on the checklist/);
		const blocked = await t.callTool("checklist_set_item", { version: 2, id: "i2", state: "blocked" });
		assert.match(blocked.text, /Not changed\. Say what blocks it/);
		const set = await t.callTool("checklist_set_item", { version: 2, id: "i2", state: "blocked", note: "Date of birth missing" });
		assert.match(set.text, /Done: Set i2 "NPDB query" blocked: Date of birth missing\. Checklist is at version 3 now:\n0 of 2 done\.\ni1 \[ \] State license, primary source\ni2 \[!\] NPDB query · Date of birth missing/);
		await t.act("set_item", { id: "i1", state: "done", note: "Ohio board, Nov 14" });
		await t.act("remove_item", { id: "i2" });
		assert.equal(await t.view(), "1 of 1 done.\ni1 [x] State license, primary source · Ohio board, Nov 14");
		assert.match((await t.callTool("checklist_remove_item", { version: 5, id: "i9" })).text, /There is no item i9\. The items are i1/);
	} finally {
		await t.dispose();
	}
});
