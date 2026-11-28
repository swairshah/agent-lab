import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, createRegistry, defineDoc, type EntryRecord, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { cwdSlug } from "./config.ts";
import { SubagentIndex, subagentRuntime } from "./subagent-task.ts";

const context = BACKGROUND_CONTEXT;

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

export type UserData = { text: string; images?: number; files?: string[]; harness: string; model?: string; at: number };
export type AssistantData = { text: string; thinking?: string; harness: string; model?: string; at: number };
export type ToolDiff = { path: string; oldText?: string; newText: string };
export type ToolData = {
	toolCallId: string;
	title: string;
	kind?: string;
	status: string;
	input?: unknown;
	output?: string;
	diffs?: ToolDiff[];
	locations?: { path: string; line?: number }[];
	harness: string;
	at: number;
};
export type PlanData = { entries: { content: string; status: string; priority?: string }[]; harness: string; at: number };
export type ShellData = { command: string; output: string; exitCode: number | null; excluded: boolean; at: number };
export type TurnData = {
	harness: string;
	model?: string;
	stopReason: string;
	error?: string;
	usage?: Usage;
	context?: { used: number; size: number };
	cost?: { amount: number; currency: string };
	durationMs: number;
	at: number;
};
export type SwitchData = { harness: string; model?: string; from?: string; at: number };
export type CustomData = { customType: string; data?: unknown; at: number };
export type NoteData = { customType: string; content: string; display: boolean; details?: unknown; at: number };
export type SummaryData = { text: string; harness: string; at: number };
export type ResetData = { summary?: string; by?: string; at: number };

export type Item = { id: number; conversation: number } & (
	| { kind: "user"; data: UserData }
	| { kind: "assistant"; data: AssistantData }
	| { kind: "tool"; data: ToolData }
	| { kind: "plan"; data: PlanData }
	| { kind: "shell"; data: ShellData }
	| { kind: "turn"; data: TurnData }
	| { kind: "switch"; data: SwitchData }
	| { kind: "summary"; data: SummaryData }
	| { kind: "custom"; data: CustomData }
	| { kind: "note"; data: NoteData }
	| { kind: "reset"; data: ResetData }
);
export type ItemKind = Item["kind"];

export type NativeInfo = { sessionId?: string; seen: number; model?: string; thinking?: string; mode?: string };
export type Natives = { harness?: string; agents: Record<string, NativeInfo> };

export type SessionMeta = {
	id: string;
	cwd: string;
	name?: string;
	created: number;
	modified: number;
	messages: number;
	first?: string;
	active?: number;
	parentSession?: string;
};

export type SessionInfo = SessionMeta & { file: string };
export type Branch = { id: number; parent?: number; at?: number; active: boolean; tip?: number };

const Meta = defineDoc<SessionMeta>({
	kind: "pid0.session",
	version: 1,
	scope: "session",
	initial: () => ({ id: "", cwd: "", created: 0, modified: 0, messages: 0 }),
	checkpointWhen: () => true,
});

const NativesDoc = defineDoc<Natives>({
	kind: "pid0.natives",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
	checkpointWhen: () => true,
});

const KINDS: Record<string, ItemKind> = {
	"pid0.user": "user",
	"pid0.assistant": "assistant",
	"pid0.tool": "tool",
	"pid0.plan": "plan",
	"pid0.shell": "shell",
	"pid0.turn": "turn",
	"pid0.switch": "switch",
	"pid0.summary": "summary",
	"pid0.custom": "custom",
	"pid0.note": "note",
};

function toItem(entry: EntryRecord): Item | undefined {
	const id = entry.id as unknown as number;
	const conversation = entry.conversationId as unknown as number;
	if (entry.kind === "pi.reset") {
		const first = entry.model?.[0];
		const summary = first?.role === "user" ? (typeof first.content === "string" ? first.content : first.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : undefined;
		return { id, conversation, kind: "reset", data: { ...(summary ? { summary } : {}), at: first?.role === "user" ? first.timestamp : 0 } };
	}
	const kind = KINDS[entry.kind];
	if (!kind) return undefined;
	return { id, conversation, kind, data: entry.data } as unknown as Item;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function modelMessages(kind: ItemKind, data: Record<string, any>): unknown[] | undefined {
	if (kind === "user") return [{ role: "user", content: data.text, timestamp: data.at }];
	if (kind === "assistant" && data.text) {
		return [{ role: "assistant", content: [{ type: "text", text: data.text }], api: "acp", provider: data.harness, model: data.model ?? "default", usage: ZERO_USAGE, stopReason: "stop", timestamp: data.at }];
	}
	if (kind === "note") return [{ role: "user", content: data.content, timestamp: data.at }];
	if (kind === "summary") return [{ role: "user", content: `Summary of a branch of this conversation that was explored and then left:\n${data.text}`, timestamp: data.at }];
	if (kind === "shell" && !data.excluded) return [{ role: "user", content: `Ran \`${data.command}\`\n\`\`\`\n${data.output}\n\`\`\``, timestamp: data.at }];
	return undefined;
}

function lockPath(file: string): string {
	return `${file}.lock`;
}

function lockHolder(file: string): number | undefined {
	try {
		const pid = Number(readFileSync(lockPath(file), "utf8").trim());
		if (!pid || pid === process.pid) return undefined;
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}

export class SessionLocked extends Error {
	constructor(file: string, pid: number) {
		super(`session ${basename(file)} is open in another pid0 (process ${pid}); close it there, or start a new session`);
	}
}

export type CreateOptions = { root: string; cwd: string; id?: string; name?: string; memory?: boolean; parentSession?: string };

export class SessionStore {
	readonly file: string | undefined;
	readonly harness: Harness;
	conv: Conversation;
	meta: SessionMeta;
	readonly readOnly: boolean;

	readonly subagents: ReturnType<typeof subagentRuntime>;
	readonly isView: boolean;

	private constructor(file: string | undefined, harness: Harness, conv: Conversation, meta: SessionMeta, readOnly: boolean, subagents: ReturnType<typeof subagentRuntime>, isView = false) {
		this.subagents = subagents;
		this.isView = isView;
		this.file = file;
		this.harness = harness;
		this.conv = conv;
		this.meta = meta;
		this.readOnly = readOnly;
	}

	static async create(options: CreateOptions): Promise<SessionStore> {
		const id = options.id ?? randomUUID();
		const now = Date.now();
		let file: string | undefined;
		if (!options.memory) {
			const dir = join(options.root, cwdSlug(options.cwd));
			mkdirSync(dir, { recursive: true });
			file = join(dir, `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${id}.sqlite`);
		}
		const meta: SessionMeta = { id, cwd: resolve(options.cwd), created: now, modified: now, messages: 0, ...(options.name ? { name: options.name } : {}), ...(options.parentSession ? { parentSession: options.parentSession } : {}) };
		const store = await SessionStore.#open(file, false);
		await store.harness.commit(async (tx) => {
			Object.assign(await tx.doc(Meta), meta);
		}, context);
		store.meta = meta;
		return store;
	}

	static async open(file: string, options: { readOnly?: boolean } = {}): Promise<SessionStore> {
		if (!existsSync(file)) throw new Error(`no session file at ${file}`);
		return SessionStore.#open(file, options.readOnly ?? false);
	}

	static async #open(file: string | undefined, readOnly: boolean): Promise<SessionStore> {
		if (file && !readOnly) {
			const holder = lockHolder(file);
			if (holder !== undefined) throw new SessionLocked(file, holder);
			writeFileSync(lockPath(file), String(process.pid));
		}
		try {
			const storage = file ? await openNodeSqliteStorage(file) : new MemoryStorage();
			const subagents = subagentRuntime();
			const registry = createRegistry();
			registry.install(subagents.extension);
			const harness = await Harness.open(storage, { models: createModels(), registry, readOnly }, context);
			const meta = { ...((await harness.snapshot(Meta, context)) ?? { id: "", cwd: "", created: 0, modified: 0, messages: 0 }) } as SessionMeta;
			const root = readOnly ? ((await harness.conversation(1 as never, context)) ?? (await harness.root(context))) : await harness.root(context);
			const active = meta.active === undefined ? undefined : await harness.conversation(meta.active as never, context);
			return new SessionStore(file, harness, active ?? root, meta, readOnly, subagents);
		} catch (error) {
			if (file && !readOnly) rmSync(lockPath(file), { force: true });
			throw error;
		}
	}

	view(conv: Conversation): SessionStore {
		return new SessionStore(undefined, this.harness, conv, { ...this.meta, messages: 0 }, false, this.subagents, true);
	}

	async close(): Promise<void> {
		if (this.isView) return;
		const empty = this.file !== undefined && !this.readOnly && this.meta.messages === 0 && (await this.lastEntry()) === 0 && (await this.branches()).length <= 1;
		await this.harness.close(context);
		if (this.file && !this.readOnly) {
			rmSync(lockPath(this.file), { force: true });
			if (empty) for (const suffix of ["", "-wal", "-shm"]) rmSync(this.file + suffix, { force: true });
		}
	}

	get id(): string {
		return this.meta.id;
	}

	get branch(): number {
		return this.conv.id as unknown as number;
	}

	async #meta(change: (meta: SessionMeta) => void): Promise<void> {
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(Meta);
			change(doc as SessionMeta);
			this.meta = { ...(doc as SessionMeta) };
		}, context);
	}

	async append<K extends Exclude<ItemKind, "reset">>(kind: K, data: Extract<Item, { kind: K }>["data"]): Promise<number> {
		const model = modelMessages(kind, data);
		const id = await this.conv.commit(async (tx) => {
			const entry = await tx.appendEntry(this.conv.id, { kind: `pid0.${kind}`, data: data as never, ...(model ? { model: model as never } : {}) });
			if (this.isView) return entry.id as unknown as number;
			const doc = await tx.doc(Meta);
			doc.modified = data.at;
			if (kind === "user") {
				doc.messages++;
				doc.first ??= (data as UserData).text.slice(0, 200);
			} else if (kind === "assistant") doc.messages++;
			this.meta = { ...(doc as SessionMeta) };
			return entry.id as unknown as number;
		}, context);
		return id;
	}

	async #scan(conv: Conversation): Promise<Item[]> {
		const out: Item[] = [];
		let cursor: never | undefined;
		do {
			const page = await conv.entries({ order: "ascending" }, 500, cursor, context);
			for (const entry of page.items) {
				const item = toItem(entry);
				if (item) out.push(item);
			}
			cursor = page.next as never | undefined;
		} while (cursor !== undefined);
		return out;
	}

	items(): Promise<Item[]> {
		return this.#scan(this.conv);
	}

	async contextItems(): Promise<Item[]> {
		const view = await this.conv.context(context);
		return view.entries.flatMap((entry) => toItem(entry) ?? []);
	}

	async lastEntry(): Promise<number> {
		const page = await this.conv.entries({ order: "descending" }, 1, undefined, context);
		return (page.items[0]?.id as unknown as number) ?? 0;
	}

	async natives(): Promise<Natives> {
		const doc = await this.harness.snapshot(NativesDoc, this.conv.id, context);
		return structuredClone((doc ?? { agents: {} }) as Natives);
	}

	async updateNatives(change: (natives: Natives) => void): Promise<void> {
		await this.conv.commit(async (tx) => {
			change((await tx.doc(NativesDoc, this.conv.id)) as Natives);
		}, context);
	}

	setName(name: string | undefined): Promise<void> {
		return this.#meta((meta) => {
			if (name) meta.name = name;
			else delete meta.name;
		});
	}

	async reset(summary: string | undefined): Promise<void> {
		await this.conv.reset(summary, context);
		await this.updateNatives((natives) => {
			for (const info of Object.values(natives.agents)) {
				delete info.sessionId;
				info.seen = 0;
			}
		});
		await this.#meta((meta) => {
			meta.modified = Date.now();
		});
	}

	async branches(): Promise<Branch[]> {
		const records = await this.harness.commit(async (tx) => {
			const out = [];
			let cursor: never | undefined;
			do {
				const page = await tx.scanConversations({}, 200, cursor);
				out.push(...page.items);
				cursor = page.next as never | undefined;
			} while (cursor !== undefined);
			return out;
		}, context);
		const out: Branch[] = [];
		const subagents = new Set(Object.values(((await this.harness.snapshot(SubagentIndex, context))?.agents ?? {}) as Record<string, number>));
		for (const record of records) {
			const id = record.id as unknown as number;
			if (subagents.has(id)) continue;
			const conv = await this.harness.conversation(record.id, context);
			const tip = conv ? ((await conv.entries({ order: "descending" }, 1, undefined, context)).items[0]?.id as unknown as number | undefined) : undefined;
			out.push({
				id,
				active: id === this.branch,
				...(record.parent ? { parent: record.parent.conversationId as unknown as number, at: record.parent.at as unknown as number } : {}),
				...(tip !== undefined ? { tip } : {}),
			});
		}
		return out;
	}

	async tree(): Promise<{ branches: Branch[]; items: Item[] }> {
		const branches = await this.branches();
		const seen = new Map<number, Item>();
		for (const branch of branches) {
			const conv = await this.harness.conversation(branch.id as never, context);
			if (!conv) continue;
			for (const item of await this.#scan(conv)) seen.set(item.id, item);
		}
		return { branches, items: [...seen.values()].sort((a, b) => a.id - b.id) };
	}

	async #activate(conv: Conversation): Promise<void> {
		this.conv = conv;
		await this.#meta((meta) => {
			meta.active = conv.id as unknown as number;
			meta.modified = Date.now();
		});
	}

	async branchAt(entryId: number | undefined): Promise<number> {
		const prefs = await this.natives();
		const init = async (tx: any, id: any) => {
			const doc = (await tx.doc(NativesDoc, id)) as Natives;
			if (prefs.harness) doc.harness = prefs.harness;
			for (const [harness, info] of Object.entries(prefs.agents)) {
				doc.agents[harness] = { seen: 0, ...(info.model ? { model: info.model } : {}), ...(info.thinking ? { thinking: info.thinking } : {}), ...(info.mode ? { mode: info.mode } : {}) };
			}
		};
		if (entryId === undefined) {
			const fresh = await this.harness.createConversation({ ownership: { kind: "ownerless" }, init }, context);
			await this.#activate(fresh);
			return this.branch;
		}
		for (const branch of await this.branches()) {
			if (branch.tip === entryId) {
				const conv = await this.harness.conversation(branch.id as never, context);
				const own = conv ? (await conv.entries({ order: "descending" }, 1, undefined, context)).items[0] : undefined;
				if (conv && (own?.conversationId as unknown as number) === branch.id) {
					await this.#activate(conv);
					return this.branch;
				}
			}
		}
		const source = await this.#owner(entryId);
		const fork = await source.fork(entryId as never, { ownership: { kind: "ownerless" }, init }, context);
		await this.#activate(fork);
		return this.branch;
	}

	async lineage(entryId: number | undefined): Promise<Set<number>> {
		const ids = new Set<number>();
		if (entryId === undefined) return ids;
		const owner = await this.#owner(entryId);
		let cursor: never | undefined;
		do {
			const page = await owner.entries({ order: "ascending", maxEntryId: entryId as never }, 500, cursor, context);
			for (const entry of page.items) ids.add(entry.id as unknown as number);
			cursor = page.next as never | undefined;
		} while (cursor !== undefined);
		return ids;
	}

	async #owner(entryId: number): Promise<Conversation> {
		const found = await this.harness.commit((tx) => tx.entry(entryId as never), context);
		if (!found) throw new Error(`no entry ${entryId} in this session`);
		return (await this.harness.conversation(found.conversationId, context)) ?? this.conv;
	}

	async rekey(change: { id: string; cwd: string; parentSession?: string; name?: string }): Promise<void> {
		await this.#meta((meta) => {
			meta.id = change.id;
			meta.cwd = resolve(change.cwd);
			meta.created = Date.now();
			meta.modified = meta.created;
			if (change.parentSession) meta.parentSession = change.parentSession;
			if (change.name) meta.name = change.name;
		});
	}
}

export async function copySession(source: string, options: { root: string; cwd: string; id?: string; name?: string; open?: SessionStore }): Promise<string> {
	const reference = options.open ?? (await SessionStore.open(source, { readOnly: true }));
	const parent = reference.meta.id;
	if (!options.open) await reference.close();
	const id = options.id ?? randomUUID();
	const dir = join(options.root, cwdSlug(options.cwd));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.sqlite`);
	copyFileSync(source, file);
	for (const suffix of ["-wal"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, file + suffix);
	const copy = await SessionStore.open(file);
	await copy.rekey({ id, cwd: options.cwd, parentSession: parent, ...(options.name ? { name: options.name } : {}) });
	await copy.updateNatives((natives) => {
		for (const info of Object.values(natives.agents)) {
			delete info.sessionId;
			info.seen = 0;
		}
	});
	await copy.close();
	return file;
}

function sessionFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".sqlite")).map((name) => join(dir, name));
	} catch {
		return [];
	}
}

export async function listSessions(root: string, cwd?: string, options: { includeEmpty?: boolean } = {}): Promise<SessionInfo[]> {
	const dirs = cwd ? [join(root, cwdSlug(cwd))] : [root, ...(existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path).isDirectory()) : [])];
	const out: SessionInfo[] = [];
	for (const dir of dirs) {
		for (const file of sessionFiles(dir)) {
			try {
				const store = await SessionStore.open(file, { readOnly: true });
				if (store.meta.id && (store.meta.messages > 0 || options.includeEmpty)) out.push({ ...store.meta, file });
				await store.close();
			} catch {}
		}
	}
	return out.sort((a, b) => b.modified - a.modified);
}

export async function findSession(root: string, cwd: string, ref: string): Promise<{ match?: SessionInfo; elsewhere?: SessionInfo; ambiguous?: SessionInfo[] }> {
	if (ref.endsWith(".sqlite") || isAbsolute(ref) || ref.includes("/")) {
		const file = resolve(ref);
		if (!existsSync(file)) throw new Error(`no session file at ${file}`);
		const store = await SessionStore.open(file, { readOnly: true });
		const info = { ...store.meta, file };
		await store.close();
		return { match: info };
	}
	const all = await listSessions(root, undefined, { includeEmpty: true });
	const hits = all.filter((s) => s.id === ref);
	const partial = hits.length ? hits : all.filter((s) => s.id.startsWith(ref));
	if (partial.length === 0) return {};
	const local = partial.filter((s) => s.cwd === resolve(cwd));
	if (local.length === 1) return { match: local[0]! };
	if (local.length > 1) return { ambiguous: local };
	if (partial.length === 1) return { elsewhere: partial[0]! };
	return { ambiguous: partial };
}
