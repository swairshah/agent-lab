import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VERSION = "0.1.0";

export type HarnessOverride = {
	label?: string;
	command?: string[];
	env?: Record<string, string>;
	useApiKey?: boolean;
	disabled?: boolean;
};

export type McpServerConfig =
	| { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
	| { url: string; headers?: Record<string, string>; type?: "http" | "sse"; enabled?: boolean };

export type Settings = {
	defaultHarness?: string;
	defaultModels?: Record<string, string>;
	defaultThinking?: Record<string, string>;
	defaultModes?: Record<string, string>;
	scopedModels?: string[];
	harnesses?: Record<string, HarnessOverride>;
	sessionDir?: string;
	permissions?: "ask" | "allow" | "deny";
	handoff?: "anonymous" | "named";
	hideThinking?: boolean;
	tuiMode?: "regular" | "fullscreen";
	quietStartup?: boolean;
};

export function agentDir(): string {
	return resolve(process.env.PID0_DIR ?? join(homedir(), ".pid0"));
}

export function settingsPath(): string {
	return join(agentDir(), "settings.json");
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function loadSettings(cwd: string): Settings {
	const global = readJson<Settings>(settingsPath()) ?? {};
	const project = readJson<Settings>(join(cwd, ".pid0", "settings.json")) ?? {};
	return {
		...global,
		...project,
		defaultModels: { ...global.defaultModels, ...project.defaultModels },
		defaultThinking: { ...global.defaultThinking, ...project.defaultThinking },
		defaultModes: { ...global.defaultModes, ...project.defaultModes },
		harnesses: { ...global.harnesses, ...project.harnesses },
	};
}

export function updateSettings(change: (settings: Settings) => void): void {
	const settings = readJson<Settings>(settingsPath()) ?? {};
	change(settings);
	writeJsonAtomic(settingsPath(), settings);
}

export function sessionsRoot(override: string | undefined, settings: Settings): string {
	return resolve(override ?? process.env.PID0_SESSION_DIR ?? settings.sessionDir ?? join(agentDir(), "sessions"));
}

export function cwdSlug(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]+/g, "-")}--`;
}

type McpFile = { mcpServers?: Record<string, McpServerConfig> };

export function mcpPath(cwd: string, local: boolean): string {
	return local ? join(cwd, ".pid0", "mcp.json") : join(agentDir(), "mcp.json");
}

export function loadMcpServers(cwd: string): Record<string, McpServerConfig> {
	const global = readJson<McpFile>(mcpPath(cwd, false))?.mcpServers ?? {};
	const project = readJson<McpFile>(mcpPath(cwd, true))?.mcpServers ?? {};
	return { ...global, ...project };
}

export function editMcpServers(cwd: string, local: boolean, change: (servers: Record<string, McpServerConfig>) => void): void {
	const path = mcpPath(cwd, local);
	const file = readJson<McpFile>(path) ?? {};
	file.mcpServers ??= {};
	change(file.mcpServers);
	writeJsonAtomic(path, file);
}

export function ensureDir(path: string): string {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
	return path;
}
