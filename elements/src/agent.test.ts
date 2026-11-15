// What the agent gets before and after an element is open in its conversation (agent.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { elementsAgent, openElement, toolNames } from "./agent.ts";
import { calendar } from "./elements/calendar/element.ts";
import { testElement } from "./testing.ts";

test("an element not open yet is a line in the prompt, and its tools are offered once the agent opens it", async () => {
	const t = await testElement(calendar, { open: false });
	try {
		await t.act("add_event", { title: "Team offsite", date: "2027-03-01" });
		assert.match(await t.sectionText(), /Not open yet: when one is relevant, use_element .* show_element .*\n- Calendar \(calendar\): /);
		assert.doesNotMatch(await t.sectionText(), /Open in this conversation/);

		const closed = await t.callTool("calendar_read", {});
		assert.equal(closed.isError, true);
		assert.ok(!closed.offered.includes("calendar_read"));

		const used = await t.callTool("use_element", { element: "calendar" });
		assert.match(used.text, /^Calendar is open\. Its tools are yours now \(calendar_…\)\. Calendar, version 1:\n[^]*Team offsite/);
		assert.deepEqual(used.offered.filter((name) => name.startsWith("calendar_")), toolNames(calendar));
		assert.equal(used.details.shown, undefined);

		const shown = await t.callTool("show_element", { element: "calendar", about: "e1", reason: "to plan the offsite" });
		assert.deepEqual([shown.details.shown, shown.details.about, shown.details.reason, shown.details.version], [true, "e1", "to plan the offsite", 1]);
		assert.match(shown.text, /^Calendar is on the people's screen now\./);

		const unknown = await t.callTool("show_element", { element: "inbox", reason: "to look" });
		assert.equal(unknown.isError, true);
		assert.match(unknown.text, /There is no element inbox to open\. The elements are calendar \(Calendar\)/);
	} finally {
		await t.dispose();
	}
});

test("a person opening an element offers its tools in that conversation, keeping those already loaded", async () => {
	const t = await testElement(calendar, { open: false });
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	for (const extension of elementsAgent({ store: t.store, scopeOf: () => "test", enabled: () => ["calendar"] }).extensions()) registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.getModel().id } } });
		const offered = async () => (await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
		assert.deepEqual(await offered(), ["use_element", "show_element"]);
		await openElement(root, [calendar as never]);
		await openElement(root, [calendar as never]);
		assert.deepEqual(await offered(), ["use_element", "show_element", ...toolNames(calendar)]);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await t.dispose();
	}
});
