// The server's own small state: session identity, members and their tokens, invites, setup progress.
// Kept in <stateDir>/server.json, written atomically. The conversation itself lives in pi-durable's session.sqlite.
//
// Tokens are stored as SHA-256 hashes. A member has one token per place they signed in (a terminal, a browser), so
// signing in again somewhere doesn't sign them out elsewhere; removing a member drops them all.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchInfo, EnvStatus, InviteInfo, Member, Role } from "../shared/protocol.ts";

export type StoredMember = Member & { tokens: string[]; joinedAt: number };

export type StoredInvite = Omit<InviteInfo, "code"> & { revoked?: boolean };

export type ServerState = {
	id: string;
	name: string;
	/** Absolute path of the project on this machine. */
	workdir: string;
	/** Public URL of the session, e.g. https://syncpi.exe.xyz/<id> */
	url: string;
	vm?: string;
	model: string;
	setupModel: string;
	thinkingLevel?: string;
	/**
	 * Where model credentials come from. "pi": this machine's pi login (~/.pi/agent/auth.json), for local sessions.
	 * "exe-gateway": the exe.dev LLM integration at https://llm.int.exe.xyz, so no keys live on the VM.
	 * Defaults to "exe-gateway" on a VM and "pi" otherwise.
	 */
	auth?: "pi" | "exe-gateway";
	members: Record<string, StoredMember>;
	invites: Record<string, StoredInvite>;
	setup: EnvStatus & { conversationId?: number };
	/** The thread's branches, and the one everyone is on (pi-durable conversation ids). */
	branches?: BranchInfo[];
	main?: number;
};

export function token(bytes = 18): string {
	return randomBytes(bytes).toString("base64url");
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** At most this many live tokens per member; the oldest goes first. */
const MAX_TOKENS = 20;

export class StateFile {
	readonly path: string;
	value: ServerState;

	constructor(stateDir: string) {
		this.path = join(stateDir, "server.json");
		this.value = JSON.parse(readFileSync(this.path, "utf8")) as ServerState;
		this.value.members ??= {};
		this.value.invites ??= {};
		this.value.setup ??= { status: "pending" };
		if (this.#migrate()) this.save();
	}

	/** Sessions from older versions: plaintext tokens, an "owner" role, unrestricted invites. */
	#migrate(): boolean {
		let changed = false;
		for (const member of Object.values(this.value.members) as (StoredMember & { token?: string; role: string })[]) {
			if (member.token !== undefined) {
				member.tokens = [hash(member.token)];
				delete member.token;
				changed = true;
			}
			member.tokens ??= [];
			if ((member.role as string) === "owner") {
				member.role = "admin";
				member.creator = true;
				changed = true;
			}
		}
		for (const invite of Object.values(this.value.invites)) {
			if (invite.role === undefined) {
				invite.role = "editor";
				invite.uses ??= 0;
				changed = true;
			}
		}
		return changed;
	}

	save(): void {
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	memberByToken(value: string | undefined): StoredMember | undefined {
		if (value === undefined || value.length === 0) return undefined;
		const hashed = hash(value);
		return Object.values(this.value.members).find((m) => m.tokens.includes(hashed));
	}

	memberByEmail(email: string): StoredMember | undefined {
		const wanted = email.trim().toLowerCase();
		return Object.values(this.value.members).find((m) => m.email?.toLowerCase() === wanted);
	}

	/** A new token for a member; returns the token itself, which is never stored. */
	issueToken(member: StoredMember): string {
		const value = token();
		member.tokens = [...member.tokens, hash(value)].slice(-MAX_TOKENS);
		this.save();
		return value;
	}

	addMember(name: string, email: string | undefined, role: Role, creator = false): { member: StoredMember; token: string } {
		const member: StoredMember = { id: token(6), name, email, role, creator: creator || undefined, tokens: [], joinedAt: Date.now() };
		this.value.members[member.id] = member;
		return { member, token: this.issueToken(member) };
	}

	removeMember(id: string): void {
		delete this.value.members[id];
		this.save();
	}

	createInvite(input: { by: string; role: Role; email?: string; expiresAt?: number; maxUses?: number }): InviteInfo {
		const code = token(12);
		const invite: StoredInvite = { ...input, email: input.email?.trim().toLowerCase(), at: Date.now(), uses: 0 };
		this.value.invites[code] = invite;
		this.save();
		return { code, ...withoutRevoked(invite) };
	}

	/** An invite that can still be used. */
	validInvite(code: string | undefined): (InviteInfo & { revoked?: boolean }) | undefined {
		if (code === undefined) return undefined;
		const invite = this.value.invites[code];
		if (invite === undefined || invite.revoked) return undefined;
		if (invite.expiresAt !== undefined && Date.now() > invite.expiresAt) return undefined;
		if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) return undefined;
		return { code, ...invite };
	}

	useInvite(code: string): void {
		const invite = this.value.invites[code];
		if (invite !== undefined) invite.uses++;
		this.save();
	}

	revokeInvite(code: string): boolean {
		const invite = this.value.invites[code];
		if (invite === undefined || invite.revoked) return false;
		invite.revoked = true;
		this.save();
		return true;
	}

	/** Invites that still work, newest first. */
	activeInvites(): InviteInfo[] {
		return Object.keys(this.value.invites)
			.map((code) => this.validInvite(code))
			.filter((i) => i !== undefined)
			.map(({ revoked: _, ...i }) => i)
			.sort((a, b) => b.at - a.at);
	}

	members(): Member[] {
		return Object.values(this.value.members).map(({ id, name, email, role, creator }) => ({ id, name, email, role, creator }));
	}
}

function withoutRevoked(invite: StoredInvite): Omit<InviteInfo, "code"> {
	const { revoked: _, ...rest } = invite;
	return rest;
}
