// Your pi setup, offered to the session for your requests: the skills pi would list, the AGENTS.md / CLAUDE.md files pi
// would read for this folder (your global one included), and your prompt templates. It is loaded with pi's own
// services, in a short-lived child process (`syncpi __pi-context <dir>`), because loading runs your extensions' code
// and they must not write into the terminal UI.
import { execFile } from "node:child_process";
import { createAgentSessionServices, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { PiContext } from "../shared/protocol.ts";

const MARK = "SYNCPI-PI-CONTEXT ";
/** Bounds on what goes into the agent's instructions. */
const MAX_AGENTS_BYTES = 64 * 1024;
const MAX_SKILLS_BYTES = 48 * 1024;

export type PromptTemplateInfo = { name: string; description: string; argumentHint?: string; content: string };

export type LoadedPiContext = PiContext & { prompts: PromptTemplateInfo[] };

/** Runs in the child: loads pi's resources for `dir` and prints them on one marked line. */
export async function printPiContext(dir: string): Promise<void> {
	const services = await createAgentSessionServices({ cwd: dir });
	const loader = services.resourceLoader;
	const skills = loader.getSkills().skills;
	let budget = MAX_AGENTS_BYTES;
	const agents: PiContext["agents"] = [];
	for (const file of loader.getAgentsFiles().agentsFiles) {
		if (file.content.length > budget) continue;
		budget -= file.content.length;
		agents.push({ path: file.path, content: file.content });
	}
	const skillsPrompt = skills.length > 0 ? formatSkillsForPrompt(skills, "read").slice(0, MAX_SKILLS_BYTES) : "";
	const prompts = loader.getPrompts().prompts.map((p) => ({ name: p.name, description: p.description, argumentHint: p.argumentHint, content: p.content }));
	const out: LoadedPiContext = { skills: skillsPrompt, skillCount: skills.length, agents, prompts };
	process.stdout.write(`\n${MARK}${JSON.stringify(out)}\n`);
	process.exit(0);
}

/** Loads your pi setup for `dir`, or an empty one if pi's resources can't be loaded. */
export function loadPiContext(dir: string, helper?: string): Promise<LoadedPiContext> {
	return new Promise((resolve) => {
		execFile(process.execPath, helper ? [helper, dir] : [process.argv[1]!, "__pi-context", dir], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (_error, stdout) => {
			const line = stdout.split("\n").find((l) => l.startsWith(MARK));
			try {
				if (line !== undefined) return resolve(JSON.parse(line.slice(MARK.length)) as LoadedPiContext);
			} catch {}
			resolve({ skills: "", skillCount: 0, agents: [], prompts: [] });
		});
	});
}

/** Expands `/name args` with a prompt template, as pi does: $1…$n, and $@ or $ARGUMENTS for all of them. */
export function expandTemplate(text: string, templates: PromptTemplateInfo[]): string | undefined {
	const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
	if (match === null) return undefined;
	const template = templates.find((t) => t.name === match[1]);
	if (template === undefined) return undefined;
	const raw = (match[2] ?? "").trim();
	const args = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^(["'])([\s\S]*)\1$/, "$2")) ?? [];
	return template.content
		.replace(/\$ARGUMENTS|\$@/g, args.join(" "))
		.replace(/\$(\d+)/g, (_, n: string) => args[Number(n) - 1] ?? "");
}
