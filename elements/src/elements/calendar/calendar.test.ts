import assert from "node:assert/strict";
import { test } from "node:test";
import { testElement } from "../../testing.ts";
import { calendar } from "./element.ts";

test("calendar: people and the agent change it through the same actions, each change a version with who made it", async () => {
	const t = await testElement(calendar);
	try {
		const added = await t.act("add_event", { title: "DEA renewal due", date: "2027-03-01" });
		assert.deepEqual([added.version, added.summary], [1, 'Added e1 "DEA renewal due" on Mar 1, 2027']);
		await assert.rejects(t.act("add_event", { title: "x", date: "March 1" }), /not a date: use YYYY-MM-DD/);
		assert.equal((await t.read()).version, 1, "a refused change makes no version");

		// The agent reads it, then changes it against the version it read.
		const read = await t.callTool("calendar_read", {});
		assert.match(read.text, /^Calendar, version 1:\nToday is 2026-11-14\.\nComing up:\ne1 · 2027-03-01 · DEA renewal due$/);
		const moved = await t.callTool("calendar_move_event", { version: 1, id: "e1", date: "2027-02-15", time: "09:30" });
		assert.equal(moved.isError, false, moved.text);
		assert.match(moved.text, /Done: Moved e1 "DEA renewal due" from Mar 1, 2027 to Feb 15, 2027 at 09:30\. Calendar is at version 2/);
		assert.equal((await t.history()).at(-1)!.actor.kind, "agent");

		// Against a stale version, refused, with what changed since.
		await t.act("add_event", { title: "Call St. Mary's", date: "2026-11-20", time: "14:00" });
		const stale = await t.callTool("calendar_cancel_event", { version: 2, id: "e1" });
		assert.equal(stale.isError, true);
		assert.match(stale.text, /Not changed\. Calendar changed since version 2: it is at version 3 now \(v3 Ada: Added e2 "Call St\. Mary's" on Nov 20, 2026 at 14:00\)/);
		assert.equal(stale.details.current, 3);
	} finally {
		await t.dispose();
	}
});

test("calendar: the agent is told what people changed since it last looked, and can see the history and revert", async () => {
	const t = await testElement(calendar);
	try {
		assert.match(await t.sectionText(), /Calendar \(calendar_…\): version 0\. You have not read it/);
		await t.callTool("calendar_read", {});
		assert.match(await t.sectionText(), /Calendar: version 0, as you last saw it/);
		await t.act("add_event", { title: "Liability policy expires", date: "2027-06-30" });
		await t.act("cancel_event", { id: "e1", reason: "Wrong policy" });
		assert.match(await t.sectionText(), /Calendar: version 2; you last saw 0\. Since then: v1 .* Ada: Added e1 .*; v2 .* Ada: Cancelled e1 "Liability policy expires": Wrong policy\. Read it again/);

		const history = await t.callTool("calendar_history", {});
		assert.match(history.text, /v1 2026-11-14 15:00 Ada: Added e1[\s\S]*v2 2026-11-14 15:00 Ada: Cancelled e1/);
		const reverted = await t.callTool("calendar_revert", { version: 2, to: 1, reason: "Ada cancelled the wrong entry" });
		assert.equal(reverted.isError, false, reverted.text);
		assert.match(reverted.text, /Put back version 1, undoing v2 \(Cancelled e1 "Liability policy expires": Wrong policy\)\. Ada cancelled the wrong entry\. Calendar is at version 3/);
		assert.equal((await t.read()).state.entries[0]!.state, "scheduled");
		// The revert is itself a version, and can be reverted.
		await t.revert(2);
		assert.equal((await t.read()).state.entries[0]!.state, "cancelled");
		assert.deepEqual((await t.history()).map((op) => op.action), ["add_event", "cancel_event", "revert", "revert"]);
		await assert.rejects(t.revert(9), /give a version from 0 to 3/);
	} finally {
		await t.dispose();
	}
});
