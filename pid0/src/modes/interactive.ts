import type { Pid0Session } from "../session.ts";
import type { SessionInfo } from "../store.ts";
import type { Prompt } from "./print.ts";

export async function confirm(_question: string): Promise<boolean> {
	return false;
}

export async function pickSession(_root: string, _cwd: string): Promise<SessionInfo | undefined> {
	return undefined;
}

export async function runInteractive(_session: Pid0Session, _options: { prompts: Prompt[]; verbose: boolean; tuiMode?: "regular" | "fullscreen" }): Promise<number> {
	return 0;
}
