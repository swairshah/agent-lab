// Where elements live: one SQLite table of changes. Each change is a row with the element's state after it, so the
// current state is the last row, any earlier version can be read back, and a revert is one more row that puts an
// earlier state back. Nothing is ever overwritten or deleted.
//
// A scope is whose element it is: the lab has one, the app would have one per file ("case:<id>").
//
// The store also remembers the last version the agent saw of each element, so it can be told what people changed
// since (agent.ts), and tells listeners of every change, so open screens and the conversation follow (lab/server.ts).
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Actor, actorName, type ElementDef, type Op } from "./element.ts";

export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS el_ops(
		scope TEXT NOT NULL, element TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL, args TEXT NOT NULL,
		actor TEXT NOT NULL, summary TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
		PRIMARY KEY(scope, element, version))`,
	`CREATE TABLE IF NOT EXISTS el_seen(scope TEXT NOT NULL, element TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(scope, element))`,
];

type Row = { version: number; action: string; args: string; actor: string; summary: string; at: number; state: string };
const toOp = (row: Row): Op => ({ version: row.version, action: row.action, args: JSON.parse(row.args), actor: JSON.parse(row.actor), summary: row.summary, at: row.at, state: JSON.parse(row.state) });

export type Change = { scope: string; element: string; op: Op };

/** A change that could not be made, with what the caller needs to try again. */
export class Refused extends Error {
	readonly current: number;
	constructor(message: string, current: number) {
		super(message);
		this.current = current;
	}
}

export class ElementStore {
	readonly #db: NodeSqliteDatabase;
	readonly #elements = new Map<string, ElementDef<unknown>>();
	readonly #listeners = new Set<(change: Change) => void>();
	readonly #now: () => number;
	/** One change at a time per element, so two people's changes are numbered one after the other. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(db: NodeSqliteDatabase, elements: readonly ElementDef<never>[], now = () => Date.now()) {
		this.#db = db;
		for (const def of elements) this.#elements.set(def.id, def as ElementDef<unknown>);
		this.#now = now;
	}

	static async open(db: NodeSqliteDatabase, elements: readonly ElementDef<never>[], now?: () => number): Promise<ElementStore> {
		for (const statement of SCHEMA) await db.exec(statement);
		return new ElementStore(db, elements, now);
	}

	def(id: string): ElementDef<unknown> {
		const def = this.#elements.get(id);
		if (def === undefined) throw new Error(`There is no element ${id}. The elements are ${[...this.#elements.keys()].join(", ")}.`);
		return def;
	}

	elements(): ElementDef<unknown>[] {
		return [...this.#elements.values()];
	}

	onChange(listener: (change: Change) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The element now, and its version: 0 before its first change. */
	async read(scope: string, element: string): Promise<{ version: number; state: unknown }> {
		const def = this.def(element);
		const row = await this.#db.get<Row>(`SELECT * FROM el_ops WHERE scope = ? AND element = ? ORDER BY version DESC LIMIT 1`, scope, element);
		return row === undefined ? { version: 0, state: def.initial() } : { version: row.version, state: JSON.parse(row.state) };
	}

	/** The element as it was at a version. */
	async at(scope: string, element: string, version: number): Promise<unknown> {
		if (version === 0) return this.def(element).initial();
		const row = await this.#db.get<Row>(`SELECT * FROM el_ops WHERE scope = ? AND element = ? AND version = ?`, scope, element, version);
		if (row === undefined) throw new Error(`${this.def(element).title} has no version ${version}.`);
		return JSON.parse(row.state);
	}

	/** Its changes, latest last: all, or those after a version, or the last `limit`. */
	async history(scope: string, element: string, options: { after?: number; limit?: number } = {}): Promise<Op[]> {
		const rows = await this.#db.all<Row>(`SELECT * FROM el_ops WHERE scope = ? AND element = ? AND version > ? ORDER BY version DESC LIMIT ?`, scope, element, options.after ?? 0, options.limit ?? 1000);
		return rows.reverse().map(toOp);
	}

	/**
	 * Makes one change. `expected` is the version the caller saw: if the element changed since, the change is refused,
	 * so nobody changes what they have not seen. People's screens pass it too.
	 */
	act(scope: string, element: string, name: string, args: Record<string, unknown>, actor: Actor, expected?: number): Promise<Op> {
		return this.#serial(async () => {
			const def = this.def(element);
			const action = def.actions[name];
			if (action === undefined) throw new Error(`${def.title} has no action ${name}. Its actions are ${Object.keys(def.actions).join(", ")}.`);
			const { version, state } = await this.read(scope, element);
			if (expected !== undefined && expected !== version) {
				const since = await this.history(scope, element, { after: expected });
				throw new Refused(`${def.title} changed since version ${expected}: it is at version ${version} now (${since.map((op) => `v${op.version} ${actorName(op.actor)}: ${op.summary}`).join("; ")}). Read it again and decide whether the change still applies.`, version);
			}
			const ctx = { now: this.#now() };
			const next = action.apply(state, args as never, ctx);
			return this.#record(scope, element, { version: version + 1, action: name, args, actor, summary: action.summary(args as never, state, next), at: ctx.now, state: next });
		});
	}

	/** Puts an earlier version back, as a new version: the history keeps what was undone, and the revert can be reverted. */
	revert(scope: string, element: string, to: number, actor: Actor, reason?: string, expected?: number): Promise<Op> {
		return this.#serial(async () => {
			const def = this.def(element);
			const { version } = await this.read(scope, element);
			if (expected !== undefined && expected !== version) throw new Refused(`${def.title} changed since version ${expected}: it is at version ${version} now. Read its history again before reverting.`, version);
			if (!Number.isInteger(to) || to < 0 || to >= version) throw new Error(`To revert ${def.title}, give a version from 0 to ${version - 1}; it is at version ${version}.`);
			const state = await this.at(scope, element, to);
			const undone = await this.history(scope, element, { after: to });
			const summary = `Put back version ${to}, undoing ${undone.map((op) => `v${op.version} (${op.summary})`).join(", ")}${reason ? `. ${reason}` : ""}`;
			return this.#record(scope, element, { version: version + 1, action: "revert", args: { to, ...(reason ? { reason } : {}) }, actor, summary, at: this.#now(), state });
		});
	}

	/** The last version the agent saw of an element, or undefined if it never has. */
	async seen(scope: string, element: string): Promise<number | undefined> {
		return (await this.#db.get<{ version: number }>(`SELECT version FROM el_seen WHERE scope = ? AND element = ?`, scope, element))?.version;
	}

	async markSeen(scope: string, element: string, version: number): Promise<void> {
		await this.#db.run(`INSERT INTO el_seen(scope, element, version) VALUES (?, ?, ?) ON CONFLICT(scope, element) DO UPDATE SET version = excluded.version`, scope, element, version);
	}

	async #record(scope: string, element: string, op: Op): Promise<Op> {
		await this.#db.run(
			`INSERT INTO el_ops(scope, element, version, action, args, actor, summary, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			scope,
			element,
			op.version,
			op.action,
			JSON.stringify(op.args),
			JSON.stringify(op.actor),
			op.summary,
			op.at,
			JSON.stringify(op.state),
		);
		for (const listener of this.#listeners) listener({ scope, element, op });
		return op;
	}

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => undefined);
		return next;
	}
}
