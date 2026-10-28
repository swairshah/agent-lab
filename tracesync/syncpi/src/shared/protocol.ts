// The wire protocol between a syncpi server (on the session's VM) and its clients (the terminal UI and the web view).
// One WebSocket per client at /ws?token=…; every frame is one JSON object.
import type { AgentEvent } from "@earendil-works/pi-durable";

/** "main" is the shared thread. "setup" is the background agent that prepares the VM; it is visible but not shared. */
export type ConvName = "main" | "setup";

/**
 * admin: everything, including inviting, removing and changing roles. The session's creator is an admin and can't be
 * removed or demoted. editor: talks to the agent, edits files, stops their own runs. viewer: reads along.
 */
export type Role = "admin" | "editor" | "viewer";

export const ROLES: readonly Role[] = ["admin", "editor", "viewer"];

export type Member = { id: string; name: string; email?: string; role: Role; creator?: boolean };

/**
 * A way in. A link invite works for anyone who has it. An email invite only for someone who signs in with exe.dev as
 * that email. Both carry the role new members get, and can expire, run out of uses, or be revoked.
 */
export type InviteInfo = { code: string; role: Role; email?: string; by: string; at: number; expiresAt?: number; maxUses?: number; uses: number };

export type Presence = { memberId: string; name: string; client: "cli" | "web"; device?: string };

/**
 * Where a request's tools run. "device": the sender's own machine, in their synced copy of the project (a terminal
 * client offers this). "vm": the session's VM. A run executes where the request that started it asked for.
 */
export type Where = "device" | "vm";

/** A terminal client's machine, offered to run that member's requests. */
export type DeviceInfo = { hostname: string; platform: string; arch: string; dir: string };

export type EnvStatus = {
	status: "pending" | "running" | "ready" | "failed";
	/** What the setup agent is doing right now, e.g. the last command it ran. */
	activity?: string;
	/** The first lines of .syncpi/ENVIRONMENT.md once the setup agent wrote it. */
	summary?: string;
	error?: string;
};

export type SessionInfo = {
	id: string;
	name: string;
	/** Public origin of the server, e.g. https://syncpi-foo.exe.xyz */
	url: string;
	/** Where the project lives on the VM. */
	workdir: string;
	model: string;
	vm?: string;
};

/** A file's content hash (sha1 hex), or null when the file does not exist. */
export type FileHash = string | null;

export type ClientMessage =
	| { type: "submit"; requestId: string; text: string; mode?: "followUp" | "steer"; where?: Where }
	/** This client runs its member's requests on its machine. */
	| { type: "device"; device: DeviceInfo }
	/** A fence finished: the local copy is in step with the session as of the fence. */
	| { type: "fenceDone"; id: number; error?: string }
	/** The local daemon for a channel exited. */
	| { type: "envClose"; channel: number }
	| { type: "abort" }
	/** Admins: create an invite. With `email`, only that person can use it (signing in with exe.dev). */
	| { type: "invite"; email?: string; role?: Role; expiresInDays?: number; maxUses?: number }
	| { type: "invites" }
	| { type: "revoke"; code: string }
	| { type: "setRole"; memberId: string; role: Role }
	| { type: "remove"; memberId: string }
	/** Anyone: change your own display name. */
	| { type: "rename"; name: string }
	| { type: "ping" };

export type ServerMessage =
	| { type: "welcome"; me: Member; session: SessionInfo; members: Member[] }
	/** Agent events of one conversation. The first batch of each conversation starts with a snapshot. */
	| { type: "events"; conv: ConvName; events: AgentEvent[] }
	| { type: "presence"; online: Presence[]; members: Member[] }
	| { type: "env"; env: EnvStatus }
	/**
	 * Files the server saw change since the previous frame (hash null = deleted). The first frame after connecting is
	 * `full`: every synced file with its hash.
	 */
	| { type: "files"; version: number; full?: boolean; changed: Record<string, FileHash> }
	| { type: "invite"; url: string; invite: InviteInfo }
	| { type: "invites"; invites: InviteInfo[] }
	/** Sent to a member who was removed, right before their connection closes (code 4001). */
	| { type: "removed" }
	/** Where the shared thread's current run executes, e.g. "ada's machine" or "the session VM". */
	| { type: "target"; label: string }
	/**
	 * Bring the local copy in step before the agent's tools run somewhere else: "flush" pushes every local change now;
	 * "pull" also waits until every server change up to `version` has been applied here.
	 */
	| { type: "fence"; id: number; mode: "flush" | "pull"; version: number }
	/**
	 * Start a pi-env daemon (`<daemon> ...args`) for a tunnel channel. Its stdin and stdout travel as binary WebSocket
	 * frames: a 4-byte big-endian channel number, then the bytes.
	 */
	| { type: "envOpen"; channel: number; args: string[] }
	| { type: "envClose"; channel: number }
	| { type: "notice"; text: string }
	| { type: "error"; message: string; requestId?: string }
	| { type: "pong" };

export function channelFrame(channel: number, bytes: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + bytes.length);
	new DataView(frame.buffer).setUint32(0, channel);
	frame.set(bytes, 4);
	return frame;
}

export function parseChannelFrame(frame: Uint8Array): { channel: number; bytes: Uint8Array } {
	return { channel: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0), bytes: frame.subarray(4) };
}

/**
 * A share link is `<session url>/s/<invite>`, where the session URL is a server's origin or, on a shared host,
 * `<origin>/<id>`. It opens the web view in a browser and works with `syncpi --url`. `origin` is the session URL.
 */
export function parseShareUrl(url: string): { origin: string; invite: string } | undefined {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/^(\/[a-z0-9]+)?\/s\/([A-Za-z0-9_-]+)\/?$/);
		if (match === null) return undefined;
		return { origin: `${parsed.origin}${match[1] ?? ""}`, invite: match[2]! };
	} catch {
		return undefined;
	}
}
