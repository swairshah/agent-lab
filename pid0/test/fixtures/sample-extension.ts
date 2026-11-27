import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turns = 0;
	pi.registerFlag("loud", { description: "Shout", type: "boolean", default: false });
	pi.registerCommand("hello", {
		description: "Say hello from the extension",
		handler: async (args, ctx) => {
			ctx.ui.notify(`hello ${args || "world"} (loud=${pi.getFlag("loud")})`, "info");
			ctx.ui.setStatus("sample", `turns:${turns}`);
			pi.appendEntry("sample-state", { greeted: args });
		},
	});
	pi.registerCommand("ask", {
		description: "Send a prompt for the user",
		handler: async (args) => {
			pi.sendUserMessage(`from extension: ${args}`);
		},
	});
	pi.registerCommand("note", {
		description: "Add a note to the conversation",
		handler: async (args) => {
			pi.sendMessage({ customType: "sample-note", content: `remember ${args}`, display: true });
		},
	});
	pi.registerShortcut("ctrl+y", { description: "Sample shortcut", handler: (ctx) => ctx.ui.notify("shortcut pressed", "info") });
	pi.registerTool({
		name: "sample_add",
		label: "Add",
		description: "Adds two numbers",
		parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } as never,
		async execute(_id, params: { a: number; b: number }) {
			return { content: [{ type: "text", text: String(params.a + params.b) }], details: {} };
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("sample", ["sample widget line"]);
		ctx.ui.setTitle("Pi - somewhere");
	});
	pi.on("agent_end", async (_event, ctx) => {
		turns++;
		ctx.ui.setStatus("sample", `turns:${turns}`);
	});
	pi.on("input", async (event) => {
		if (event.text === "ping") return { action: "transform", text: "pong please" };
		if (event.text === "swallow") return { action: "handled" };
		return { action: "continue" };
	});
}
