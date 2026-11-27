import { VERSION } from "./config.ts";

export type Mode = "text" | "json" | "rpc";

export type Args = {
	command?: "harnesses" | "auth" | "mcp";
	commandArgs: string[];
	print: boolean;
	mode?: Mode;
	export?: { input: string; output?: string };
	harness?: string;
	model?: string;
	thinking?: string;
	models?: string[];
	listModels?: string | true;
	agentMode?: string;
	permissions?: "ask" | "allow" | "deny";
	continue: boolean;
	resume: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	noSession: boolean;
	name?: string;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	skills: string[];
	noSkills: boolean;
	promptTemplates: string[];
	noPromptTemplates: boolean;
	themes: string[];
	useTheme?: string;
	noThemes: boolean;
	tuiMode?: "regular" | "fullscreen";
	verbose: boolean;
	noMcp: boolean;
	help: boolean;
	version: boolean;
	files: string[];
	messages: string[];
};

export class UsageError extends Error {}

const HARNESS_OWNED: Record<string, { takesValue: boolean; what: string }> = {
	"--tools": { takesValue: true, what: "tools" },
	"-t": { takesValue: true, what: "tools" },
	"--exclude-tools": { takesValue: true, what: "tools" },
	"-xt": { takesValue: true, what: "tools" },
	"--no-builtin-tools": { takesValue: false, what: "tools" },
	"-nbt": { takesValue: false, what: "tools" },
	"--no-tools": { takesValue: false, what: "tools" },
	"-nt": { takesValue: false, what: "tools" },
	"--extension": { takesValue: true, what: "extensions" },
	"-e": { takesValue: true, what: "extensions" },
	"--no-extensions": { takesValue: false, what: "extensions" },
	"-ne": { takesValue: false, what: "extensions" },
	"--no-context-files": { takesValue: false, what: "context files (AGENTS.md, CLAUDE.md)" },
	"-nc": { takesValue: false, what: "context files (AGENTS.md, CLAUDE.md)" },
	"--api-key": { takesValue: true, what: "credentials" },
	"--approve": { takesValue: false, what: "project trust" },
	"-a": { takesValue: false, what: "project trust" },
	"--no-approve": { takesValue: false, what: "project trust" },
	"-na": { takesValue: false, what: "project trust" },
	"--offline": { takesValue: false, what: "network activity" },
};

export function parseArgs(argv: string[]): Args {
	const args: Args = { commandArgs: [], print: false, continue: false, resume: false, noSession: false, appendSystemPrompt: [], skills: [], noSkills: false, promptTemplates: [], noPromptTemplates: false, themes: [], noThemes: false, verbose: false, noMcp: false, help: false, version: false, files: [], messages: [] };
	if (argv[0] === "harnesses" || argv[0] === "list" || argv[0] === "auth" || argv[0] === "mcp") {
		args.command = argv[0] === "list" ? "harnesses" : argv[0];
		args.commandArgs = argv.slice(1);
		return args;
	}
	let i = 0;
	const value = (flag: string): string => {
		const v = argv[++i];
		if (v === undefined) throw new UsageError(`${flag} needs a value`);
		return v;
	};
	const oneOf = <T extends string>(flag: string, allowed: readonly T[]): T => {
		const v = value(flag);
		if (!allowed.includes(v as T)) throw new UsageError(`${flag} must be one of ${allowed.join(", ")}`);
		return v as T;
	};
	for (; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			args.messages.push(...argv.slice(i + 1));
			break;
		}
		switch (arg) {
			case "-p":
			case "--print":
				args.print = true;
				break;
			case "--mode":
				args.mode = oneOf(arg, ["text", "json", "rpc"] as const);
				break;
			case "--export": {
				const input = value(arg);
				const next = argv[i + 1];
				args.export = { input, ...(next !== undefined && !next.startsWith("-") ? { output: argv[++i]! } : {}) };
				break;
			}
			case "--harness":
			case "--provider":
				args.harness = value(arg);
				break;
			case "--model":
				args.model = value(arg);
				break;
			case "--thinking":
				args.thinking = value(arg);
				break;
			case "--models":
				args.models = value(arg).split(",").map((s) => s.trim()).filter(Boolean);
				break;
			case "--list-models": {
				const next = argv[i + 1];
				args.listModels = next !== undefined && !next.startsWith("-") ? argv[++i]! : true;
				break;
			}
			case "--agent-mode":
				args.agentMode = value(arg);
				break;
			case "--permissions":
				args.permissions = oneOf(arg, ["ask", "allow", "deny"] as const);
				break;
			case "-c":
			case "--continue":
				args.continue = true;
				break;
			case "-r":
			case "--resume":
				args.resume = true;
				break;
			case "--session":
				args.session = value(arg);
				break;
			case "--session-id":
				args.sessionId = value(arg);
				if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(args.sessionId)) throw new UsageError("--session-id accepts letters, numbers, '.', '_' and '-', and must start and end with a letter or number");
				break;
			case "--fork":
				args.fork = value(arg);
				break;
			case "--session-dir":
				args.sessionDir = value(arg);
				break;
			case "--no-session":
				args.noSession = true;
				break;
			case "-n":
			case "--name":
				args.name = value(arg);
				break;
			case "--system-prompt":
				args.systemPrompt = value(arg);
				break;
			case "--append-system-prompt":
				args.appendSystemPrompt.push(value(arg));
				break;
			case "--skill":
				args.skills.push(value(arg));
				break;
			case "-ns":
			case "--no-skills":
				args.noSkills = true;
				break;
			case "--prompt-template":
				args.promptTemplates.push(value(arg));
				break;
			case "-np":
			case "--no-prompt-templates":
				args.noPromptTemplates = true;
				break;
			case "--theme":
				args.themes.push(value(arg));
				break;
			case "--use-theme":
				args.useTheme = value(arg);
				break;
			case "--no-themes":
				args.noThemes = true;
				break;
			case "--tui-mode":
				args.tuiMode = oneOf(arg, ["regular", "fullscreen"] as const);
				break;
			case "--verbose":
				args.verbose = true;
				break;
			case "--no-mcp":
				args.noMcp = true;
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-v":
			case "--version":
				args.version = true;
				break;
			default: {
				const owned = HARNESS_OWNED[arg];
				if (owned) throw new UsageError(`${arg} is one of pi's options for its own ${owned.what}. In pid0 the harness owns its ${owned.what}: configure them in the harness itself (Claude Code, Codex, Antigravity, pi).`);
				if (arg.startsWith("@") && arg.length > 1) args.files.push(arg.slice(1));
				else if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`unknown option ${arg} (see pid0 --help)`);
				else args.messages.push(arg);
			}
		}
	}
	if (args.fork && (args.session || args.continue || args.resume || args.noSession)) throw new UsageError("--fork cannot be combined with --session, --continue, --resume, or --no-session");
	if (args.sessionId && (args.session || args.continue || args.resume)) throw new UsageError("--session-id cannot be combined with --session, --continue, or --resume");
	if (args.mode === "rpc" && args.files.length) throw new UsageError("RPC mode does not take @file arguments; send them with the prompt command");
	return args;
}

export const HELP = `pid0 ${VERSION}: one coding-agent CLI for Claude Code, Codex, Antigravity and pi (over ACP), with pi-durable sessions

  pid0 [options] [--] [@files...] [messages...]
  pid0 harnesses                         the harnesses pid0 can drive, and whether each is installed
  pid0 auth login <harness> [method]     sign in to a harness
  pid0 auth check <harness>              ready | not_ready (exit 0 | 1)
  pid0 mcp <add|remove|list> ...         MCP servers handed to every harness

Invocation and output
  -p, --print                  run the prompts, print the final answer, exit
  --mode text|json|rpc         text (default), JSONL events, or JSONL commands on stdin
  --export <input> [output]    export a session file to HTML and exit

Harness and model
  --harness <name>             claude, codex, antigravity, pi, or one from settings.json (alias: --provider)
  --model <pattern>            a model of the harness, by id or fuzzy name; accepts harness/model and a :<thinking> suffix
  --thinking <level>           a thinking / reasoning-effort level the harness offers
  --models <patterns>          comma-separated harness/model list that Ctrl+P cycles through
  --list-models [search]       list the models every installed harness offers, then exit
  --agent-mode <id>            a mode the harness offers (for example plan, acceptEdits)
  --permissions ask|allow|deny how tool permission requests are answered (default: ask in the terminal UI, allow elsewhere)

Sessions (stored with pi-durable under ~/.pid0/sessions)
  -c, --continue               continue the most recent session of this directory
  -r, --resume                 pick a session to resume
  --session <path|id>          open a session by file or full/partial id
  --session-id <id>            open this directory's session with the id, or create it
  --fork <path|id>             fork a session into a new one in this directory
  --session-dir <dir>          where sessions are stored and looked up
  --no-session                 keep the session in memory only
  -n, --name <name>            set the session's display name

Prompts and process
  --system-prompt <text|path>         replace the harness's system prompt where it allows that, else add to it
  --append-system-prompt <text|path>  add to the harness's system prompt (repeatable)
  --skill <path>               load a skill file or directory (repeatable); -ns, --no-skills disables discovery
  --prompt-template <path>     load a prompt template file or directory (repeatable); -np disables discovery
  --theme <path>               load a theme file or directory (repeatable); --no-themes disables discovery
  --use-theme <name>           the theme for this run
  --no-mcp                     do not hand pid0's MCP servers to the harness
  --tui-mode regular|fullscreen
  --verbose                    show the harness's own log lines
  -h, --help    -v, --version

  @path includes a text file or image in the first prompt; piped stdin is prepended to it.
  The terminal UI is pi's: its settings (/settings), themes, keybindings.json, prompt templates and skills are read
  from pi's own folder (~/.pi/agent, or PID0_PI_DIR). /hotkeys lists the keys; / lists the commands.

  Tools, extensions and context files belong to each harness and are configured there.`;
