// The session owner: one pi-durable Harness with two conversations.
//   - main: the shared thread everyone talks to. Messages carry their author.
//   - setup: a background agent that prepares the VM (toolchains, dependencies, a first build and test run) and writes
//     .syncpi/ENVIRONMENT.md. Everyone can watch it, but it is not part of the shared thread.
// Both run their tools in the project directory on this machine.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	type DocumentReader,
	Harness,
	InboxDoc,
	LiveDoc,
	type ModelRef,
	section,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { diff, Scanner } from "../shared/files.ts";
import type { ConvName, EnvStatus, FileHash, Where } from "../shared/protocol.ts";
import { toolSummary } from "../shared/thread.ts";
import type { Devices } from "./devices.ts";
import type { StateFile, StoredMember } from "./state.ts";

export const context: Context = BACKGROUND_CONTEXT;

const SETUP_REQUEST = "syncpi-setup-1";

export function parseModel(ref: string): ModelRef {
	const slash = ref.indexOf("/");
	if (slash <= 0) throw new Error(`model must look like provider/model, got ${ref}`);
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** The exe.dev LLM integration: Anthropic and OpenAI APIs reachable from any attached VM without a key on the VM. */
const EXE_GATEWAY = "https://llm.int.exe.xyz";

/**
 * The same model runtime pi uses. Locally it reads pi's login (~/.pi/agent/auth.json, models.json), so whatever
 * `pi` can use, the session can use. On a VM it gets a private pi directory whose models.json routes the built-in
 * anthropic and openai providers through the exe.dev gateway.
 */
async function createSessionModels(stateDir: string, auth: "pi" | "exe-gateway"): Promise<Models> {
	// pi-ai loads OAuth flows (token refresh for pi's subscription logins) through a computed import() that a bundle
	// cannot follow; register them statically instead, as pi's own standalone binary does.
	registerBunOAuthFlows();
	// Exactly the models this machine's pi has, including providers its extensions add (kimi, subscription logins…).
	if (auth === "pi") return (await createAgentSessionServices({ cwd: process.cwd() })).modelRuntime;
	const dir = join(stateDir, "pi");
	await mkdir(dir, { recursive: true });
	const config = {
		providers: {
			anthropic: { baseUrl: EXE_GATEWAY, apiKey: "exe-gateway" },
			openai: { baseUrl: `${EXE_GATEWAY}/v1`, apiKey: "exe-gateway" },
		},
	};
	writeFileSync(join(dir, "models.json"), `${JSON.stringify(config, null, 2)}\n`);
	return ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
}

/** Nothing secret is in this process's environment, but keep the shells' environment minimal anyway. */
function shellEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/_API_KEY$|^SYNCPI_/.test(key)) delete env[key];
	return env;
}

/** A scripted model for tests: `write <path> <text>` writes a file, `run <command>` runs bash, anything else is echoed. */
function installFaux(models: MutableModels): void {
	const faux = fauxProvider({ tokensPerSecond: 400 });
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 10_000 }, () => (ctx: { messages: { role: string; content: unknown }[] }) => {
			const last = ctx.messages.findLast((m) => m.role !== "system")!;
			const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			if (last.role === "toolResult") return fauxAssistantMessage("Done.");
			if (text.includes("prepare this VM")) {
				return fauxAssistantMessage([fauxToolCall("write", { path: ".syncpi/ENVIRONMENT.md", content: "# Environment\n\nfaux setup: nothing to install.\n" })], {
					stopReason: "toolUse",
				});
			}
			const body = text.replace(/^\[[^\]]+\]\s*/, "");
			const write = body.match(/^write (\S+) ([\s\S]+)$/);
			if (write) return fauxAssistantMessage([fauxToolCall("write", { path: write[1]!, content: write[2]! })], { stopReason: "toolUse" });
			const run = body.match(/^run ([\s\S]+)$/);
			if (run) return fauxAssistantMessage([fauxToolCall("bash", { command: run[1]! })], { stopReason: "toolUse" });
			return fauxAssistantMessage(`(faux) ${body}`);
		}),
	);
}

export type SessionEvents = {
	/** The setup agent's status changed. */
	env(status: EnvStatus): void;
	/** Files in the workspace changed. */
	files(version: number, changed: Record<string, FileHash>): void;
	/** The shared thread's tools now run somewhere else. */
	target(label: string): void;
};

/** Who started a run and where its tools execute, read back from the request ID of its first input. */
type Route = { memberId?: string; where: Where };

/** How long a run waits for its sender's machine to reconnect before its tool calls fail. */
const DEVICE_WAIT_MS = 60_000;

export class Session {
	readonly state: StateFile;
	readonly stateDir: string;
	readonly faux: boolean;
	harness!: Harness;
	main!: Conversation;
	setup!: Conversation;
	readonly #listeners: SessionEvents;
	readonly #scanner: Scanner;
	#files = new Map<string, string>();
	#filesVersion = 0;
	#scanTimer: NodeJS.Timeout | undefined;
	#scanning: Promise<void> | undefined;
	#rescan = false;
	#setupWatch: AgentEventStream | undefined;
	#mainWatch: AgentEventStream | undefined;
	readonly devices: Devices;
	/** Where the shared thread's tools ran last ("vm" or a member id), so a change of machine can fence first. */
	#target: string | undefined;
	#targetLabel = "the session VM";
	#arriving: Promise<void> = Promise.resolve();
	readonly #routes = new Map<number, Route>();

	constructor(state: StateFile, stateDir: string, faux: boolean, devices: Devices, listeners: SessionEvents) {
		this.state = state;
		this.stateDir = stateDir;
		this.faux = faux;
		this.devices = devices;
		this.#listeners = listeners;
		this.#scanner = new Scanner(state.value.workdir);
	}

	get workdir(): string {
		return this.state.value.workdir;
	}

	get filesVersion(): number {
		return this.#filesVersion;
	}

	manifest(): Record<string, string> {
		return Object.fromEntries(this.#files);
	}

	async open(): Promise<void> {
		const s = this.state.value;
		await mkdir(join(this.workdir, ".syncpi"), { recursive: true });
		let models: Models;
		if (this.faux) {
			const faux = createModels();
			installFaux(faux);
			models = faux;
		} else models = await createSessionModels(this.stateDir, s.auth ?? (s.vm === undefined ? "pi" : "exe-gateway"));

		const Syncpi = defineExtension({
			name: "syncpi",
			sections: [section("syncpi", () => this.#projectNotes(), { tag: true })],
		});
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(Syncpi);

		const env = shellEnv();
		this.harness = await Harness.open(
			await openNodeSqliteStorage(join(this.stateDir, "session.sqlite")),
			{
				models,
				registry,
				// The setup agent always works on the VM. The shared thread works wherever its current run's sender asked:
				// their own machine from a terminal, or the VM.
				env: async (target) => {
					const vm = () => new NodeExecutionEnv({ cwd: target.cwd ?? this.workdir, shellEnv: env });
					if (this.main === undefined || target.conversationId !== this.main.id) return vm();
					return this.#envFor(await this.#route(target.read), vm);
				},
				settings: { retry: { maxRetries: 4 }, afterFailedRun: "continue" },
				identity: { attribution: { name: "syncpi", url: "https://github.com/swairshah" } },
			},
			context,
		);
		const model = this.faux ? { provider: "faux", modelId: "faux-1" } : parseModel(s.model);
		this.main = await this.harness.root(context, {
			agent: { model, thinkingLevel: (s.thinkingLevel ?? "medium") as "medium", instructions: mainInstructions(s.name, this.workdir), cwd: this.workdir },
		});

		const setupModel = this.faux ? model : parseModel(s.setupModel);
		let setup = s.setup.conversationId === undefined ? undefined : await this.harness.conversation(s.setup.conversationId as ConversationId, context);
		if (setup === undefined) {
			setup = await this.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: setupModel, thinkingLevel: "low", instructions: setupInstructions(s.name, this.workdir), cwd: this.workdir },
				},
				context,
			);
			s.setup = { status: "pending", conversationId: setup.id as number };
			this.state.save();
		}
		this.setup = setup;

		this.#files = await this.#scanner.scan();
		this.#scanTimer = setInterval(() => this.scanSoon(), 3_000);
		// Every finished tool call may have touched files: rescan right away instead of at the next tick.
		this.#mainWatch = await this.watch("main");
		this.#mainWatch.start(async (events) => {
			if (events.some((e) => e.type === "tool_execution_end")) this.scanSoon();
		});
		this.harness.resume();
		void this.#runSetup();
	}

	conversation(name: ConvName): Conversation {
		return name === "main" ? this.main : this.setup;
	}

	/** Attaches a client to one conversation: the snapshot and every later batch, without gaps. */
	watch(name: ConvName): Promise<AgentEventStream> {
		return watchEvents(this.harness, this.conversation(name).id, context);
	}

	async submit(member: StoredMember, requestId: string, text: string, mode: "followUp" | "steer", where: Where): Promise<void> {
		// A request can only run on its sender's own machine, and only while it is connected.
		const destination: Where = where === "device" && this.devices.online(member.id) !== undefined ? "device" : "vm";
		// A steer joins the running run and its tools. Nobody steers a run that executes on someone else's machine;
		// it waits for its own run instead.
		if (mode === "steer") {
			const current = await this.#route(this.harness);
			if (current.where === "device" && current.memberId !== member.id) mode = "followUp";
		}
		await this.main.submit(
			{
				type: "input",
				content: `[${member.name}] ${text}`,
				// The route is part of the request ID, so it is stored with the submission and survives restarts.
				requestId: `${member.id}:${destination}:${requestId}`,
				whenBusy: mode,
				entry: { kind: "syncpi.message", data: { author: member.name, memberId: member.id, text } },
			},
			context,
		);
	}

	/** A line everyone sees in the thread; the model does not. */
	async notice(text: string): Promise<void> {
		await this.main.submit({ type: "write", entry: { kind: "syncpi.notice", data: { text } } }, context);
	}

	/**
	 * Stops the current run only. Queued messages, including other people's, stay queued; the next one starts a new run.
	 * (Conversation.abort would withdraw every queued input.)
	 */
	async abort(): Promise<void> {
		const live = await this.harness.snapshot(LiveDoc, this.main.id, context);
		if (live?.run !== undefined) await this.harness.abortTask(live.run.taskId, context);
	}

	/** Who started the shared thread's current run, if one is running. */
	async runner(): Promise<string | undefined> {
		const live = await this.harness.snapshot(LiveDoc, this.main.id, context);
		if (live?.run === undefined) return undefined;
		return (await this.#route(this.harness)).memberId;
	}

	/** A removed member's queued messages are withdrawn, and their running request stopped. */
	async withdraw(memberId: string): Promise<void> {
		const inbox = await this.harness.snapshot(InboxDoc, this.main.id, context);
		for (const item of inbox?.items ?? []) {
			if (item.mode === "write") continue;
			const data = (item.entry as { data?: { memberId?: string } } | undefined)?.data;
			if (data?.memberId === memberId) await (await this.harness.submission(item.id, context))?.abort(context);
		}
		if ((await this.runner()) === memberId) await this.abort();
	}

	async #route(read: DocumentReader): Promise<Route> {
		const live = await read.snapshot(LiveDoc, this.main.id, context);
		const input = live?.run?.inputs[0];
		if (input === undefined) return { where: "vm" };
		const cached = this.#routes.get(input as number);
		if (cached !== undefined) return cached;
		const record = await (await this.harness.submission(input, context))?.status(context);
		const [memberId, where] = (record?.requestId ?? "").split(":");
		const route: Route = where === "device" && memberId ? { memberId, where: "device" } : { memberId, where: "vm" };
		this.#routes.set(input as number, route);
		return route;
	}

	async #envFor(route: Route, vm: () => ExecutionEnv): Promise<ExecutionEnv> {
		if (route.where === "vm" || route.memberId === undefined) {
			await this.#arrive("vm");
			return vm();
		}
		const memberId = route.memberId;
		const deadline = Date.now() + DEVICE_WAIT_MS;
		while (this.devices.online(memberId) === undefined) {
			if (Date.now() > deadline) {
				const name = this.state.value.members[memberId]?.name ?? "the sender";
				throw new Error(
					`${name}'s machine is not connected. Requests sent from ${name}'s terminal run on their machine; they can reopen syncpi there, or send it from the web view to run it on the session VM.`,
				);
			}
			await new Promise((r) => setTimeout(r, 1_000));
		}
		await this.#arrive(memberId);
		return this.devices.env(memberId);
	}

	/**
	 * Before the shared thread's tools run on another machine, the copies are brought in step: every connected machine
	 * pushes its local changes, the server rescans, and the new machine pulls everything up to that point. Within a run
	 * the machine stays the same, and ordinary sync covers the rest.
	 */
	#arrive(target: string): Promise<void> {
		const next = this.#arriving.then(async () => {
			if (this.#target === target) return;
			const others = this.devices.list().filter((d) => d.memberId !== target);
			await Promise.all(others.map((d) => this.devices.fence(d.memberId, "flush", 0)));
			await this.scanNow();
			if (target !== "vm") await this.devices.fence(target, "pull", this.#filesVersion);
			this.#target = target;
			this.#targetLabel = target === "vm" ? `the session VM (${this.state.value.vm ?? "this server"}, ${this.workdir})` : (this.devices.label(target) ?? target);
			this.#listeners.target(target === "vm" ? "the session VM" : (this.devices.label(target) ?? target));
		});
		this.#arriving = next.catch(() => {});
		return next;
	}

	/** Rescans now and resolves when the scan, and any it triggers, is done. */
	async scanNow(): Promise<void> {
		while (this.#scanning !== undefined) await this.#scanning;
		this.scanSoon();
		while (this.#scanning !== undefined) await this.#scanning;
	}

	/**
	 * The pi setup that applies to the current run: on a member's machine, their skills and the AGENTS.md / CLAUDE.md
	 * files their pi would read there; on the VM, the project's own AGENTS.md / CLAUDE.md.
	 */
	#piNotes(): string {
		const target = this.#target;
		const context = target !== undefined && target !== "vm" ? this.devices.context(target) : undefined;
		const parts: string[] = [];
		if (context !== undefined) {
			const owner = this.state.value.members[target!]?.name ?? "the sender";
			for (const file of context.agents) parts.push(`Instructions from ${file.path} (${owner}'s pi setup):\n${file.content.trim()}`);
			if (context.skills) parts.push(`${owner}'s pi skills. Their paths are on ${owner}'s machine, where your tools run now:\n${context.skills.trim()}`);
		} else {
			for (const name of ["AGENTS.md", "CLAUDE.md"]) {
				const file = join(this.workdir, name);
				if (existsSync(file)) parts.push(`Instructions from the project's ${name}:\n${readFileSync(file, "utf8").slice(0, 64 * 1024).trim()}`);
			}
		}
		return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
	}

	get targetLabel(): string {
		return this.#targetLabel;
	}

	/** Rescans the workspace shortly; bursts of tool calls collapse into one scan. */
	scanSoon(): void {
		if (this.#scanning !== undefined) {
			this.#rescan = true;
			return;
		}
		this.#scanning = (async () => {
			try {
				const next = await this.#scanner.scan();
				const changed = diff(this.#files, next);
				this.#files = next;
				if (Object.keys(changed).length > 0) {
					this.#filesVersion++;
					this.#listeners.files(this.#filesVersion, changed);
				}
			} catch (error) {
				console.error("scan failed", error);
			} finally {
				this.#scanning = undefined;
				if (this.#rescan) {
					this.#rescan = false;
					this.scanSoon();
				}
			}
		})();
	}

	/** The current hash of one file, straight from disk. */
	fileHash(path: string): Promise<FileHash> {
		return this.#scanner.hash(path);
	}

	envStatus(): EnvStatus {
		const { conversationId: _, ...status } = this.state.value.setup;
		return status;
	}

	#setEnv(patch: Partial<EnvStatus>): void {
		const next = { ...this.state.value.setup, ...patch };
		const before = JSON.stringify(this.state.value.setup);
		this.state.value.setup = next;
		if (JSON.stringify(next) === before) return;
		if (patch.status !== undefined) this.state.save();
		this.#listeners.env(this.envStatus());
	}

	async #runSetup(): Promise<void> {
		if (this.state.value.setup.status === "ready") return;
		this.#setupWatch = await this.watch("setup");
		this.#setupWatch.start(async (events) => this.#onSetupEvents(events));
		this.#setEnv({ status: "running", error: undefined });
		try {
			// The request ID makes this idempotent: after a restart it finds the same submission instead of a second one.
			const submission = await this.setup.submit(
				{ type: "input", content: `Please prepare this VM for the project at ${this.workdir}.`, requestId: SETUP_REQUEST },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status === "done") this.#setEnv({ status: "ready", activity: undefined, summary: this.#environmentSummary() });
			else this.#setEnv({ status: "failed", activity: undefined, error: settled.reason });
		} catch (error) {
			this.#setEnv({ status: "failed", activity: undefined, error: String((error as Error).message ?? error) });
		}
		await this.#setupWatch?.stop();
		this.#setupWatch = undefined;
		this.scanSoon();
	}

	async #onSetupEvents(events: readonly AgentEvent[]): Promise<void> {
		for (const event of events) {
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) {
				this.#setEnv({ activity: `${event.toolName} ${toolSummary({ name: event.toolName, args: event.args as Record<string, unknown> })}`.slice(0, 160) });
			}
		}
	}

	#environmentSummary(): string | undefined {
		const file = join(this.workdir, ".syncpi", "ENVIRONMENT.md");
		if (!existsSync(file)) return undefined;
		return readFileSync(file, "utf8").split("\n").slice(0, 40).join("\n");
	}

	#projectNotes(): string {
		const s = this.state.value;
		const people = Object.values(s.members).map((m) => `${m.name}${m.creator ? " (created the session)" : m.role === "admin" ? " (admin)" : m.role === "viewer" ? " (viewer)" : ""}`);
		const env =
			s.setup.status === "ready"
				? (this.#environmentSummary() ?? "The setup agent finished but wrote no notes.")
				: s.setup.status === "failed"
					? `The setup agent failed: ${s.setup.error ?? "unknown error"}. Set up what you need yourself.`
					: "A background setup agent is still installing toolchains and dependencies. If a command is missing, wait a little or install it yourself; notes will appear in .syncpi/ENVIRONMENT.md.";
		const vm = s.vm === undefined ? "" : ` On the VM (${s.vm}), ports 3000-9999 other than 8000 are reachable by the owner at https://${s.vm}.exe.xyz:<port>/.`;
		return `People in this session: ${people.join(", ")}.\n\nYour tools now run on ${this.#targetLabel}.${vm}\n\nThe session VM's environment (set up by a background agent; other machines have whatever their owner installed):\n${env}${this.#piNotes()}`;
	}

	async close(): Promise<void> {
		if (this.#scanTimer !== undefined) clearInterval(this.#scanTimer);
		await this.#mainWatch?.stop();
		await this.#setupWatch?.stop();
		await this.harness.close(context);
	}
}

function mainInstructions(name: string, workdir: string): string {
	return `You are syncpi, a coding agent in a shared session for the project "${name}". The session's server and its copy of the project (${workdir}) are on a Linux VM (Ubuntu; sudo works without a password).

Several people can be in this thread at once, from a terminal or a browser. Each user message starts with the sender's name in brackets, like "[Ada] fix the tests". Keep track of who asked for what, and use names when it helps. When two people ask for conflicting things, say so instead of picking silently.

Your tools run where the person whose request you are working on is: on their own computer when they wrote from a terminal (in their copy of the project, with their toolchains, for example Xcode on a Mac), or on the session's Linux VM when they wrote from a browser. The syncpi section says which machine you are on right now, and its working directory is the project. Do not assume tools or files outside the project carry over between machines.

Everyone has a synced copy of the project. Files you change show up in everyone's copy within seconds, wherever you changed them. Files under .syncpi/ and ignored files (build output, dependencies) are not synced, so each machine has its own.

Run long-lived processes (dev servers, watchers) in the background with output to a log file, for example \`nohup npm run dev > /tmp/dev.log 2>&1 &\`, and on the VM never on port 8000, which serves this session. Keep answers short; people see your tool calls as they happen.`;
}

function setupInstructions(name: string, workdir: string): string {
	return `You prepare a fresh Ubuntu VM so that coding agents can build, run, test and debug the project "${name}" at ${workdir}. You run in the background. Nobody reads your messages, so act instead of asking. sudo works without a password.

1. Look at the project: README, manifests and lockfiles, CI config, Dockerfiles, .tool-versions, .nvmrc and similar.
2. Install the toolchains it expects, at the versions it asks for (apt, nvm, uv, rustup, go, and so on), and system packages it needs.
3. Install dependencies with the lockfile-respecting command (npm ci, pnpm install --frozen-lockfile, uv sync, cargo fetch, ...). Do not change files tracked by git.
4. Run the build and the quickest meaningful test command once. Do not fix failures in the project; write them down.
5. Write .syncpi/ENVIRONMENT.md, under 60 lines: toolchains and versions, the exact commands to install, build, test, lint and run the project, how to start a dev server, and known problems.

Do not start long-running servers. Finish with a one-line summary.`;
}
