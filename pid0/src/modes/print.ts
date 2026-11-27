import type { ImageInput, Pid0Session } from "../session.ts";

export type Prompt = { text: string; images?: ImageInput[] };

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
	return new Promise((resolve) => {
		if (stream.write(text)) resolve();
		else stream.once("drain", resolve);
	});
}

export async function runPrint(session: Pid0Session, prompts: Prompt[], mode: "text" | "json"): Promise<number> {
	let failed = false;
	let last = "";
	let pending: Promise<void> = Promise.resolve();
	if (mode === "json") {
		const meta = session.store.meta;
		await write(process.stdout, `${JSON.stringify({ type: "session", version: 1, id: meta.id, timestamp: new Date(meta.created).toISOString(), cwd: meta.cwd, harness: session.harness })}\n`);
	}
	session.subscribe((event) => {
		if (event.type === "notice" && event.level === "error") failed = true;
		if (mode === "json") pending = pending.then(() => write(process.stdout, `${JSON.stringify(event)}\n`));
		else {
			if (event.type === "notice") process.stderr.write(`${event.level === "info" ? "" : `${event.level}: `}${event.text}\n`);
			if (event.type === "message_end" && event.message.role === "assistant") {
				const text = event.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (text) last = text;
			}
		}
	});
	if (prompts.length === 0) {
		process.stderr.write("pid0: nothing to do: give a prompt (pid0 -p \"...\"), or pipe one in\n");
		return 1;
	}
	for (const prompt of prompts) {
		last = "";
		await session.promptAndWait(prompt.text, prompt.images ? { images: prompt.images } : {});
		if (failed) break;
	}
	await pending;
	if (mode === "text" && last) await write(process.stdout, last.endsWith("\n") ? last : `${last}\n`);
	return failed ? 1 : 0;
}
