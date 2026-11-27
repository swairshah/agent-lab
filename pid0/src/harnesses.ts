import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Settings } from "./config.ts";

export type ResolvedHarness = {
	id: string;
	label: string;
	command: string[];
	env: Record<string, string>;
	useApiKey?: boolean;
	install: string;
	auth: string;
	source: "path" | "npx" | "settings" | "env";
};

type Builtin = {
	id: string;
	label: string;
	aliases: string[];
	candidates: string[][];
	fallback: string[];
	install: string;
	auth: string;
};

const BUILTINS: Builtin[] = [
	{
		id: "claude",
		label: "Claude Code",
		aliases: ["claude-code", "cc", "anthropic"],
		candidates: [["claude-agent-acp"], ["claude-code-acp"]],
		fallback: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
		install: "Install the adapter with `npm i -g @agentclientprotocol/claude-agent-acp`.",
		auth: "Run `claude` once and sign in (or set ANTHROPIC_API_KEY), then try again.",
	},
	{
		id: "codex",
		label: "Codex",
		aliases: ["openai", "codex-cli"],
		candidates: [["codex-acp"]],
		fallback: ["npx", "-y", "@agentclientprotocol/codex-acp"],
		install: "Install the adapter with `npm i -g @agentclientprotocol/codex-acp`.",
		auth: "Run `codex login` (or set OPENAI_API_KEY), then try again.",
	},
	{
		id: "antigravity",
		label: "Antigravity",
		aliases: ["agy", "google", "gemini"],
		candidates: [["agy", "acp"], ["agy-acp"], ["antigravity-acp"]],
		fallback: ["agy", "acp"],
		install: "Install Antigravity's `agy` CLI (1.5 or newer has `agy acp` built in); for older ones, `bun add -g antigravity-acp`.",
		auth: "Run `agy` once and sign in with your Google account, then try again.",
	},
	{
		id: "pi",
		label: "pi",
		aliases: ["pi-coding-agent"],
		candidates: [["pi-acp"]],
		fallback: ["npx", "-y", "pi-acp"],
		install: "pi-acp needs `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`); install the adapter with `npm i -g pi-acp`.",
		auth: "Run `pi` once and use /login (or set a provider API key), then try again.",
	},
];

export function onPath(bin: string): string | undefined {
	if (isAbsolute(bin) || bin.includes("/")) {
		try {
			accessSync(bin, constants.X_OK);
			return bin;
		} catch {
			return undefined;
		}
	}
	const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const full = join(dir, bin + ext);
			try {
				accessSync(full, constants.X_OK);
				return full;
			} catch {}
		}
	}
	return undefined;
}

function splitCommand(text: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]!);
	return out;
}

export function harnessIds(settings: Settings): string[] {
	const ids = BUILTINS.map((b) => b.id);
	for (const id of Object.keys(settings.harnesses ?? {})) if (!ids.includes(id)) ids.push(id);
	return ids.filter((id) => !settings.harnesses?.[id]?.disabled);
}

export function canonicalHarness(name: string, settings: Settings): string | undefined {
	const wanted = name.toLowerCase();
	const ids = harnessIds(settings);
	if (ids.includes(wanted)) return wanted;
	const alias = BUILTINS.find((b) => b.aliases.includes(wanted));
	if (alias && ids.includes(alias.id)) return alias.id;
	const prefixed = ids.filter((id) => id.startsWith(wanted));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

export function resolveHarness(name: string, settings: Settings): ResolvedHarness {
	const id = canonicalHarness(name, settings);
	if (!id) throw new Error(`unknown harness "${name}" (known: ${harnessIds(settings).join(", ")})`);
	const builtin = BUILTINS.find((b) => b.id === id);
	const override = settings.harnesses?.[id];
	const base = {
		id,
		label: override?.label ?? builtin?.label ?? id,
		env: override?.env ?? {},
		...(override?.useApiKey !== undefined ? { useApiKey: override.useApiKey } : {}),
		install: builtin?.install ?? `Check the command configured for "${id}" in settings.json.`,
		auth: builtin?.auth ?? `Sign in with ${id}'s own CLI, then try again.`,
	};
	const fromEnv = process.env[`PID0_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_COMMAND`];
	if (fromEnv) return { ...base, command: splitCommand(fromEnv), source: "env" };
	if (override?.command?.length) return { ...base, command: override.command, source: "settings" };
	if (!builtin) throw new Error(`harness "${id}" has no command in settings.json`);
	for (const candidate of builtin.candidates) {
		const found = onPath(candidate[0]!);
		if (found) return { ...base, command: [found, ...candidate.slice(1)], source: "path" };
	}
	return { ...base, command: builtin.fallback, source: "npx" };
}

export function harnessStatus(settings: Settings): { harness: ResolvedHarness; available: boolean; note: string }[] {
	return harnessIds(settings).map((id) => {
		const harness = resolveHarness(id, settings);
		const runner = onPath(harness.command[0]!);
		const available = runner !== undefined;
		const note = !available ? `${harness.command[0]} not found. ${harness.install}` : harness.source === "npx" ? `fetched on first use: ${harness.command.join(" ")}` : harness.command.join(" ");
		return { harness, available, note };
	});
}

export function harnessLabel(id: string, settings: Settings): string {
	return settings.harnesses?.[id]?.label ?? BUILTINS.find((b) => b.id === id)?.label ?? id;
}

function claudeApprovedKey(key: string, base: NodeJS.ProcessEnv): boolean {
	try {
		const approved = JSON.parse(readFileSync(join(base.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"), "utf8")).customApiKeyResponses?.approved;
		return Array.isArray(approved) && approved.includes(key.slice(-20));
	} catch {
		return false;
	}
}

export function harnessEnv(harness: ResolvedHarness, base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; dropped: string[] } {
	const env: NodeJS.ProcessEnv = { ...base };
	const dropped: string[] = [];
	if (harness.id === "claude") {
		const installed = onPath("claude");
		if (installed && !env.CLAUDE_CODE_EXECUTABLE) env.CLAUDE_CODE_EXECUTABLE = installed;
		const key = env.ANTHROPIC_API_KEY;
		if (key && harness.useApiKey !== true && !("ANTHROPIC_API_KEY" in harness.env) && !claudeApprovedKey(key, env)) {
			delete env.ANTHROPIC_API_KEY;
			dropped.push("ANTHROPIC_API_KEY");
		}
	}
	if (harness.id === "codex") {
		const installed = onPath("codex");
		if (installed && !env.CODEX_PATH) env.CODEX_PATH = installed;
	}
	return { env: { ...env, ...harness.env }, dropped };
}
