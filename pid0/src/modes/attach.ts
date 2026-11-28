import { createInterface } from "node:readline";

type Event = { type: string; [key: string]: any };

const dim = (text: string) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[22m` : text);
const red = (text: string) => (process.stdout.isTTY ? `\x1b[31m${text}\x1b[39m` : text);

const HELP = `  /stop                       stop the current turn
  /harness <name>             switch harness        /model <name>   switch model
  /thinking <level>           set thinking level    /permissions ask|allow|deny
  /new   /compact [notes]     new session; compact the context
  /status   /subagents        session state; subagents
  /subagent <stop|pause|resume|interrupt> <name>
  !cmd  !!cmd                 run a shell command on the server (!! keeps it from the agent)
  /quit                       leave (the agent keeps running on the server)
  anything else is sent to the agent; while it works, messages are queued`;

export async function runAttach(target: string | undefined, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<number> {
	const base = (target ?? process.env.PID0_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
	const write = (text: string) => void output.write(text);
	const rpc = async (type: string, extra: Record<string, unknown> = {}) => {
		const response = await fetch(`${base}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) });
		const body = (await response.json()) as { success: boolean; error?: string; data?: any };
		if (!body.success) throw new Error(body.error ?? "the command failed");
		return body.data;
	};

	let state: Record<string, any>;
	try {
		state = await rpc("get_state");
	} catch (error) {
		process.stderr.write(`pid0: cannot reach a pid0 server at ${base} (${(error as Error).message}). Start one with: pid0 serve\n`);
		return 1;
	}
	write(`${bold("pid0")} at ${base} · ${state.harnessLabel}${state.modelName ? ` · ${state.modelName}` : ""} · ${state.cwd}\n${dim("/help lists commands; /quit leaves and the agent keeps running")}\n`);
	const recent = ((await rpc("get_messages")).messages as { kind: string; data: any }[]).filter((m) => m.kind === "user" || m.kind === "assistant").slice(-4);
	for (const item of recent) write(item.kind === "user" ? `\n${bold(">")} ${item.data.text}\n` : `\n${item.data.text}\n`);

	let streaming = false;
	let asks: Event[] = ((await rpc("get_pending")).permissions as Event[]) ?? [];
	const showAsk = (ask: Event) => write(`\n${bold(`Allow ${ask.toolCall?.title ?? "a tool"}?`)} ${ask.options.map((o: { name: string }, i: number) => `[${i + 1}] ${o.name}`).join("  ")}\n`);
	for (const ask of asks) showAsk(ask);

	const onEvent = (event: Event) => {
		switch (event.type) {
			case "state":
				state = event.state;
				break;
			case "message_start":
				if (event.message.role === "user") write(`\n${bold(">")} ${event.message.content}\n`);
				else {
					streaming = true;
					write("\n");
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") write(event.assistantMessageEvent.delta);
				break;
			case "message_end":
				if (event.message.role === "assistant" && streaming) {
					streaming = false;
					write("\n");
				}
				break;
			case "tool_execution_end":
				write(`${dim(`  ${event.isError ? "✗" : "●"} ${event.toolName}`)}\n`);
				break;
			case "notice":
				write(`${event.level === "error" ? red(event.text) : dim(event.text)}\n`);
				break;
			case "shell_end":
				write(`${dim(`$ ${event.command}`)}\n${event.output}`);
				break;
			case "turn_end":
				if (event.stopReason === "cancelled") write(`${dim("stopped")}\n`);
				break;
			case "harness_changed":
				write(`${dim(`now talking to ${event.harness}`)}\n`);
				break;
			case "permission_request":
				asks.push(event);
				showAsk(event);
				break;
			case "permission_resolved":
				asks = asks.filter((a) => a.id !== event.id);
				break;
			case "subagent":
				write(`${dim(`subagent ${event.name}: ${event.status}${event.note ? ` (${event.note})` : ""}`)}\n`);
				break;
			case "session_changed":
				write(`${dim("the session changed")}\n`);
				break;
		}
	};

	const abort = new AbortController();
	const stream = (async () => {
		const response = await fetch(`${base}/events`, { signal: abort.signal });
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end < 0) break;
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				for (const line of frame.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
			}
		}
	})().catch((error) => {
		if (!abort.signal.aborted) process.stderr.write(`pid0: lost the server (${(error as Error).message})\n`);
	});

	const handle = async (line: string): Promise<boolean> => {
		const text = line.trim();
		if (!text) return true;
		if (asks.length > 0 && /^\d+$/.test(text)) {
			const ask = asks[0]!;
			const option = ask.options[Number(text) - 1];
			if (option) await rpc("permission_response", { id: ask.id, optionId: option.optionId });
			return true;
		}
		const [command, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ");
		if (command === "/quit" || command === "/exit" || command === "/detach") return false;
		if (command === "/help") write(`${HELP}\n`);
		else if (command === "/stop") await rpc("abort");
		else if (command === "/harness") await rpc("set_harness", { harness: arg });
		else if (command === "/model") write(`${dim(`model: ${(await rpc("set_model", { modelId: arg })).model ?? "default"}`)}\n`);
		else if (command === "/thinking") write(`${dim(`thinking: ${(await rpc("set_thinking_level", { level: arg })).level}`)}\n`);
		else if (command === "/permissions") write(`${dim(`permissions: ${(await rpc("set_permissions", { policy: arg })).policy}`)}\n`);
		else if (command === "/new") await rpc("new_session");
		else if (command === "/compact") await rpc("compact", arg ? { customInstructions: arg } : {});
		else if (command === "/status") write(`${state.harnessLabel} · ${state.modelName ?? "default model"}${state.thinkingLevel ? ` · ${state.thinkingLevel}` : ""} · ${state.isStreaming ? "working" : "idle"} · session ${state.sessionId}\n`);
		else if (command === "/subagents") {
			const all = (await rpc("get_subagents")).subagents as { name: string; status: string; harness: string; model?: string }[];
			write(all.length ? `${all.map((s) => `${s.name}: ${s.status} (${s.harness}${s.model ? `, ${s.model}` : ""})`).join("\n")}\n` : `${dim("no subagents")}\n`);
		} else if (command === "/subagent") await rpc("subagent", { action: rest[0], name: rest[1] });
		else if (text.startsWith("!")) {
			const excluded = text.startsWith("!!");
			await rpc("bash", { command: text.slice(excluded ? 2 : 1).trim(), excludeFromContext: excluded });
		} else await rpc("prompt", { message: text, streamingBehavior: "followUp" });
		return true;
	};

	const lines = createInterface({ input, terminal: false });
	for await (const line of lines) {
		try {
			if (!(await handle(line))) break;
		} catch (error) {
			write(`${red((error as Error).message)}\n`);
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	abort.abort();
	await stream;
	return 0;
}
