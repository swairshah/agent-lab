import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { AcpAgent } from "./acp.ts";
import { type Args, HELP, parseArgs, UsageError } from "./args.ts";
import { editMcpServers, loadMcpServers, loadSettings, type McpServerConfig, type Settings, sessionsRoot, VERSION } from "./config.ts";
import { exportSession } from "./export.ts";
import { harnessEnv, harnessLabel, harnessStatus, resolveHarness } from "./harnesses.ts";
import type { Prompt } from "./modes/print.ts";
import { type ImageInput, Pid0Session } from "./session.ts";
import { copySession, findSession, listSessions, type SessionInfo, SessionStore } from "./store.ts";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function textOrFile(value: string): string {
	try {
		if (existsSync(value) && statSync(value).isFile()) return readFileSync(value, "utf8");
	} catch {}
	return value;
}

function readStdin(): Promise<string> {
	return new Promise((done) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => done(data));
		process.stdin.on("error", () => done(data));
	});
}

export function buildPrompts(args: Args, piped: string, cwd: string): Prompt[] {
	const parts: string[] = [];
	const images: ImageInput[] = [];
	if (piped.trim()) parts.push(piped.trimEnd());
	for (const file of args.files) {
		const path = resolve(cwd, file);
		if (!existsSync(path)) throw new UsageError(`@${file}: no such file`);
		const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
		if (mimeType) {
			images.push({ data: readFileSync(path).toString("base64"), mimeType });
			parts.push(`<file name="${path}"></file>`);
		} else parts.push(`<file name="${path}">\n${readFileSync(path, "utf8")}\n</file>`);
	}
	const [first, ...rest] = args.messages;
	if (first !== undefined) parts.push(first);
	const prompts: Prompt[] = [];
	if (parts.length) prompts.push({ text: parts.join("\n\n"), ...(images.length ? { images } : {}) });
	for (const message of rest) prompts.push({ text: message });
	return prompts;
}

function describe(info: SessionInfo): string {
	return `${info.id.slice(0, 8)}  ${new Date(info.modified).toISOString().slice(0, 16).replace("T", " ")}  ${info.name ?? info.first?.split("\n")[0]?.slice(0, 60) ?? "(empty)"}`;
}

async function openStore(args: Args, root: string, cwd: string, interactive: boolean): Promise<{ store: SessionStore; cwd: string } | undefined> {
	if (args.noSession) return { store: await SessionStore.create({ root, cwd, memory: true, ...(args.name ? { name: args.name } : {}) }), cwd };
	const inPlace = async (info: SessionInfo) => {
		if (!existsSync(info.cwd)) throw new UsageError(`the session's folder ${info.cwd} no longer exists; fork it here with: pid0 --fork ${info.id}`);
		return { store: await SessionStore.open(info.file), cwd: info.cwd };
	};
	const ambiguity = (list: SessionInfo[]) => new UsageError(`several sessions match:\n${list.map((s) => `  ${describe(s)}`).join("\n")}`);
	if (args.fork) {
		const found = await findSession(root, cwd, args.fork);
		const source = found.match ?? found.elsewhere;
		if (found.ambiguous) throw ambiguity(found.ambiguous);
		if (!source) throw new UsageError(`no session matches "${args.fork}"`);
		const file = await copySession(source.file, { root, cwd, ...(args.sessionId ? { id: args.sessionId } : {}), ...(args.name ? { name: args.name } : {}) });
		return { store: await SessionStore.open(file), cwd };
	}
	if (args.session) {
		const found = await findSession(root, cwd, args.session);
		if (found.ambiguous) throw ambiguity(found.ambiguous);
		if (found.match) return inPlace(found.match);
		if (found.elsewhere) {
			if (!interactive) throw new UsageError(`session ${found.elsewhere.id} belongs to ${found.elsewhere.cwd}; run pid0 there, or fork it here with --fork ${found.elsewhere.id}`);
			const { confirm } = await import("./modes/interactive.ts");
			if (!(await confirm(`Session ${found.elsewhere.id.slice(0, 8)} belongs to ${found.elsewhere.cwd}. Fork it into this directory?`))) return undefined;
			return { store: await SessionStore.open(await copySession(found.elsewhere.file, { root, cwd })), cwd };
		}
		throw new UsageError(`no session matches "${args.session}"`);
	}
	if (args.sessionId) {
		const existing = (await listSessions(root, cwd, { includeEmpty: true })).find((s) => s.id === args.sessionId);
		if (existing) return inPlace(existing);
		return { store: await SessionStore.create({ root, cwd, id: args.sessionId, ...(args.name ? { name: args.name } : {}) }), cwd };
	}
	if (args.continue) {
		const [latest] = await listSessions(root, cwd);
		if (latest) return { store: await SessionStore.open(latest.file), cwd };
	}
	if (args.resume) {
		if (!interactive) throw new UsageError("--resume needs a terminal; use --session <id> or --continue");
		const { pickSession } = await import("./modes/interactive.ts");
		const picked = await pickSession(root, cwd);
		if (!picked) return undefined;
		return inPlace(picked);
	}
	return { store: await SessionStore.create({ root, cwd, ...(args.name ? { name: args.name } : {}) }), cwd };
}

async function commandHarnesses(settings: Settings): Promise<number> {
	for (const { harness, available, note } of harnessStatus(settings)) {
		console.log(`${available ? "✓" : "✗"} ${harness.id.padEnd(12)} ${harness.label.padEnd(12)} ${note}`);
	}
	console.log(`\nDefault: ${settings.defaultHarness ?? "claude"}. Add or override harnesses in ~/.pid0/settings.json ("harnesses": {"name": {"command": [...]}}): any ACP agent works.`);
	return 0;
}

async function commandAuth(rest: string[], settings: Settings, cwd: string): Promise<number> {
	const [action, name, method] = rest;
	if (!action || !name || !["login", "check"].includes(action)) throw new UsageError("usage: pid0 auth login <harness> [method] | pid0 auth check <harness>");
	const harness = resolveHarness(name, settings);
	const agent = await AcpAgent.start(harness, cwd, { permission: async () => ({ outcome: { outcome: "cancelled" } }) });
	try {
		if (action === "check") {
			try {
				await agent.newSession({ cwd, mcpServers: [] });
				console.log("ready");
				return 0;
			} catch (error) {
				console.log("not_ready");
				console.error((error as Error).message);
				return 1;
			}
		}
		const methods = agent.authMethods;
		if (methods.length === 0) {
			console.log(`${harness.label} offers no sign-in over ACP. ${harness.auth}`);
			return 1;
		}
		const chosen = method ? methods.find((m) => m.id === method) : methods[0];
		if (!chosen) throw new UsageError(`${harness.label} has no sign-in method "${method}" (it offers: ${methods.map((m) => m.id).join(", ")})`);
		const terminal = chosen as { type?: string; args?: string[]; env?: Record<string, string> };
		if (terminal.type === "terminal") {
			agent.close();
			const [command, ...base] = harness.command;
			const code = await new Promise<number>((done) => {
				const child = spawn(command!, [...base, ...(terminal.args ?? [])], { stdio: "inherit", env: { ...harnessEnv(harness).env, ...terminal.env } });
				child.on("exit", (c) => done(c ?? 1));
				child.on("error", () => done(1));
			});
			return code;
		}
		await agent.authenticate(chosen.id);
		console.log(`signed in to ${harness.label} (${chosen.name})`);
		return 0;
	} finally {
		agent.close();
	}
}

function commandMcp(rest: string[], cwd: string): number {
	const [action, ...args] = rest;
	const local = args.includes("-l") || args.includes("--local");
	const clean = args.filter((a) => a !== "-l" && a !== "--local");
	if (action === "list") {
		const servers = loadMcpServers(cwd);
		if (clean.includes("--json")) console.log(JSON.stringify(servers, null, 2));
		else if (Object.keys(servers).length === 0) console.log("no MCP servers (add one with: pid0 mcp add <name> -- <command> [args...])");
		else for (const [name, s] of Object.entries(servers)) console.log(`${name.padEnd(16)} ${"command" in s ? [s.command, ...(s.args ?? [])].join(" ") : s.url}${s.enabled === false ? "  (disabled)" : ""}`);
		return 0;
	}
	if (action === "remove") {
		const name = clean[0];
		if (!name) throw new UsageError("usage: pid0 mcp remove <server> [-l]");
		editMcpServers(cwd, local, (servers) => void delete servers[name]);
		console.log(`removed ${name}`);
		return 0;
	}
	if (action === "add") {
		const split = clean.indexOf("--");
		const head = split < 0 ? clean : clean.slice(0, split);
		const command = split < 0 ? [] : clean.slice(split + 1);
		const name = head[0];
		const pairs = (flag: string) => {
			const out: Record<string, string> = {};
			head.forEach((a, i) => {
				if (a !== flag) return;
				const kv = head[i + 1] ?? "";
				const eq = kv.indexOf("=");
				if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
			});
			return out;
		};
		const url = head.includes("--url") ? head[head.indexOf("--url") + 1] : undefined;
		if (!name || name.startsWith("-") || (!url && command.length === 0)) throw new UsageError("usage: pid0 mcp add <server> [--env K=V] -- <command> [args...]\n       pid0 mcp add <server> --url <url> [--header K=V]");
		const env = pairs("--env");
		const headers = pairs("--header");
		const server: McpServerConfig = url ? { url, ...(Object.keys(headers).length ? { headers } : {}) } : { command: command[0]!, args: command.slice(1), ...(Object.keys(env).length ? { env } : {}) };
		editMcpServers(cwd, local, (servers) => void (servers[name] = server));
		console.log(`added ${name}; every harness gets it at its next session`);
		return 0;
	}
	throw new UsageError("usage: pid0 mcp <add|remove|list>");
}

async function listModels(args: Args, settings: Settings, root: string, cwd: string): Promise<number> {
	const store = await SessionStore.create({ root, cwd, memory: true });
	const ids = args.harness ? [resolveHarness(args.harness, settings).id] : harnessStatus(settings).filter((h) => h.available).map((h) => h.harness.id);
	if (ids.length === 0) {
		console.error("no harness is installed; see pid0 harnesses");
		return 1;
	}
	const session = await Pid0Session.start({ cwd, root, settings, store, harness: ids[0]!, noMcp: true });
	const search = typeof args.listModels === "string" ? args.listModels.toLowerCase() : undefined;
	try {
		for (const listed of await session.availableModels(ids)) {
			if (listed.error) {
				console.log(`${listed.harness}: ${listed.error}`);
				continue;
			}
			const models = listed.models.filter((m) => !search || m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search));
			if (listed.models.length === 0) console.log(`${listed.harness}: offers no model choice over ACP`);
			for (const m of models) console.log(`${`${listed.harness}/${m.id}`.padEnd(44)} ${m.name}${m.id === listed.current ? "  (current)" : ""}`);
		}
	} finally {
		await session.dispose();
	}
	return 0;
}

async function main(argv: string[]): Promise<number> {
	process.title = "pid0";
	const args = parseArgs(argv);
	if (args.help) {
		console.log(HELP);
		return 0;
	}
	if (args.version) {
		console.log(VERSION);
		return 0;
	}
	let cwd = process.cwd();
	const settings = loadSettings(cwd);
	const root = sessionsRoot(args.sessionDir, settings);
	if (args.handoff) settings.handoff = args.handoff;
	if (args.command === "harnesses") return commandHarnesses(settings);
	if (args.command === "auth") return commandAuth(args.commandArgs, settings, cwd);
	if (args.command === "mcp") return commandMcp(args.commandArgs, cwd);
	if (args.export) {
		const store = await SessionStore.open(resolve(args.export.input), { readOnly: true });
		const output = args.export.output ?? `pid0-session-${store.meta.id}.html`;
		console.log(exportSession(store.meta, await store.items(), (h) => harnessLabel(h, settings), output));
		await store.close();
		return 0;
	}
	if (args.listModels) return listModels(args, settings, root, cwd);
	if (args.harness) resolveHarness(args.harness, settings);

	const mode = args.mode === "rpc" ? "rpc" : args.mode === "json" ? "json" : args.print || !process.stdin.isTTY || !process.stdout.isTTY ? "print" : "interactive";
	const piped = mode !== "rpc" && mode !== "interactive" && !process.stdin.isTTY ? await readStdin() : "";
	const opened = await openStore(args, root, cwd, mode === "interactive");
	if (!opened) return 0;
	if (opened.cwd !== cwd) {
		cwd = opened.cwd;
		process.chdir(cwd);
	}
	if (args.name && opened.store.meta.name !== args.name) await opened.store.setName(args.name);
	const systemPrompt = [args.systemPrompt, ...args.appendSystemPrompt].filter((s): s is string => s !== undefined).map(textOrFile).join("\n\n");
	const { Resources } = await import("./resources.ts");
	const resourceOptions = { skillPaths: args.skills, promptPaths: args.promptTemplates, themePaths: args.themes, noSkills: args.noSkills, noPromptTemplates: args.noPromptTemplates, noThemes: args.noThemes, extensionPaths: args.extensions, noExtensions: args.noExtensions, ...(args.approve !== undefined ? { projectTrusted: args.approve } : {}) };
	let resources: Awaited<ReturnType<typeof Resources.load>>;
	const flags = new Map<string, string | true>();
	try {
		resources = await Resources.load(cwd, resourceOptions);
		const known = new Map<string, string>();
		for (const extension of resources.extensions?.extensions ?? []) for (const [name, flag] of extension.flags) known.set(name, flag.type);
		for (const flag of args.extensionFlags) {
			const type = known.get(flag.name);
			if (!type) throw new UsageError(`unknown option --${flag.name} (see pid0 --help)`);
			if (type === "boolean" && flag.value !== undefined && flag.value !== "true" && flag.value !== "false") {
				args.messages.unshift(flag.value);
				flags.set(flag.name, true);
			} else flags.set(flag.name, flag.value ?? true);
		}
	} catch (error) {
		await opened.store.close();
		throw error;
	}
	const prompts = buildPrompts(args, piped, cwd);
	let session: Pid0Session;
	try {
		session = await Pid0Session.start({
			cwd,
			root,
			settings,
			store: opened.store,
			...(args.harness ? { harness: args.harness } : {}),
			...(args.model ? { model: args.model } : {}),
			...(args.thinking ? { thinking: args.thinking } : {}),
			...(args.agentMode ? { mode: args.agentMode } : {}),
			...(args.models ? { scopedModels: args.models } : {}),
			permissions: args.permissions ?? (mode === "interactive" ? (settings.permissions ?? "ask") : mode === "rpc" ? (settings.permissions ?? "allow") : "allow"),
			...(systemPrompt ? { systemPrompt, systemPromptMode: args.systemPrompt ? ("override" as const) : ("append" as const) } : {}),
			noMcp: args.noMcp,
			persistPreferences: mode === "interactive",
			...(args.verbose ? { log: (line: string) => (mode === "interactive" ? console.error(line) : void process.stderr.write(`${line}\n`)) } : {}),
		});
	} catch (error) {
		await opened.store.close();
		throw error;
	}
	session.expand = (text) => resources.expand(text);
	session.baseInstructions = resources.skillsPrompt();
	const { ExtensionHost } = await import("./extensions.ts");
	const control: { shutdown: () => void } = { shutdown: () => {} };
	let code = 0;
	let host: Awaited<ReturnType<typeof ExtensionHost.load>>;
	const { Subagents } = await import("./subagents.ts");
	const { ToolServer } = await import("./mcp-host.ts");
	const subagents = args.noSubagents ? undefined : new Subagents(session);
	const tools = subagents ? new ToolServer("pid0", () => subagents.tools()) : undefined;
	try {
		if (tools) {
			await tools.start();
			const own = () => (tools.mcp ? [tools.mcp] : []);
			session.mcpProviders.push(own);
			subagents?.exclude(own);
		}
		host = await ExtensionHost.load(session, resources, {
			mode: mode === "interactive" ? "tui" : mode,
			flags,
			shutdown: () => control.shutdown(),
			reload: async () => {
				await resources.reload();
			},
		});
		if (mode === "rpc") {
			await host?.start();
			code = await (await import("./modes/rpc.ts")).runRpc(session);
		} else if (mode === "interactive") {
			code = await (await import("./modes/interactive.ts")).runInteractive(session, { prompts, verbose: args.verbose, resources, control, ...(host ? { host } : {}), ...(subagents ? { subagents } : {}), ...(args.useTheme ? { themeName: args.useTheme } : {}), ...(args.tuiMode ? { tuiMode: args.tuiMode } : {}) });
		} else {
			await host?.start();
			code = await (await import("./modes/print.ts")).runPrint(session, prompts, mode === "json" ? "json" : "text");
		}
	} finally {
		await host?.dispose().catch(() => {});
		await subagents?.suspend().catch(() => {});
		await session.dispose();
		await subagents?.dispose().catch(() => {});
		tools?.close();
	}
	return code;
}

if (process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("pid0.mjs") || process.argv[1].endsWith("pid0"))) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`pid0: ${error instanceof UsageError || !process.env.PID0_DEBUG ? (error as Error).message : (error as Error).stack}\n`);
			process.exit(error instanceof UsageError ? 2 : 1);
		},
	);
}

export { main };
