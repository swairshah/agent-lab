import assert from "node:assert/strict";
import { test } from "node:test";
import { testElement } from "../../testing.ts";
import { checklist } from "./element.ts";

test("checklist: items are added, set and removed by anyone, and a blocked item says why", async () => {
	const t = await testElement(checklist);
	try {
		await t.act("add_item", { title: "Book the venue" });
		await t.act("add_item", { title: "Send the invitations" });
		await assert.rejects(t.act("add_item", { title: "send the invitations" }), /already on the checklist/);
		const blocked = await t.callTool("checklist_set_item", { version: 2, id: "i2", state: "blocked" });
		assert.match(blocked.text, /Not changed\. Say what blocks it/);
		const set = await t.callTool("checklist_set_item", { version: 2, id: "i2", state: "blocked", note: "Guest list not final" });
		assert.match(set.text, /Done: Set i2 "Send the invitations" blocked: Guest list not final\. Checklist is at version 3 now:\n0 of 2 done\.\ni1 \[ \] Book the venue\ni2 \[!\] Send the invitations · Guest list not final/);
		await t.act("set_item", { id: "i1", state: "done", note: "Confirmed by email, Nov 14" });
		await t.act("remove_item", { id: "i2" });
		assert.equal(await t.view(), "1 of 1 done.\ni1 [x] Book the venue · Confirmed by email, Nov 14");
		assert.match((await t.callTool("checklist_remove_item", { version: 5, id: "i9" })).text, /There is no item i9\. The items are i1/);
	} finally {
		await t.dispose();
	}
});
