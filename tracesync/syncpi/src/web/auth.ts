// Getting into a session: an owner link (#token=…), an invite (/s/<code>, a link or an email invite that needs an
// exe.dev sign-in), a token this browser already has, or an exe.dev sign-in for members invited by email.
import { $, storage } from "./dom.ts";

/** The session's path on this server: "/" for a server of its own, "/<id>/" on a shared host. */
export const BASE = new URL(document.baseURI).pathname;
export const TOKEN_KEY = `syncpi-token:${location.origin}${BASE}`;

type JoinReply = { token?: string; error?: string; login?: boolean; email?: string; loginUrl?: string };

async function valid(token: string): Promise<boolean> {
	const res = await fetch("api/info", { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
	return res?.ok === true;
}

async function join(invite: string, name: string): Promise<{ ok: boolean; status: number; reply: JoinReply }> {
	const res = await fetch("api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite, name }) });
	return { ok: res.ok, status: res.status, reply: (await res.json()) as JoinReply };
}

/** Resolves with a member token once this browser is in the session, showing the join or sign-in screen meanwhile. */
export async function signIn(): Promise<string> {
	// In the app, its local host signs every request in for this member; the page holds no token.
	if (document.documentElement.dataset.desktop === "true") return "desktop";
	const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
	if (fromHash) storage.set(TOKEN_KEY, fromHash);
	const invite = location.pathname.slice(BASE.length - 1).match(/^\/s\/([A-Za-z0-9_-]+)/)?.[1];
	const token = fromHash ?? storage.get(TOKEN_KEY);
	if (token !== undefined && (await valid(token))) return enter(token);
	if (invite !== undefined) return showJoin(invite);
	// Members invited by email can always come back by signing in with exe.dev.
	const res = await fetch("api/exe-login", { method: "POST" }).catch(() => undefined);
	const reply = ((await res?.json().catch(() => ({}))) ?? {}) as JoinReply;
	if (res?.ok && reply.token) return enter(reply.token);
	$("nologin").hidden = false;
	$<HTMLAnchorElement>("nologin-login").href = reply.loginUrl ?? `/__exe.dev/login?redirect=${encodeURIComponent(BASE)}`;
	if (res?.status === 403) $("nologin-error").textContent = reply.error ?? "";
	return new Promise(() => {});
}

function enter(token: string): string {
	storage.set(TOKEN_KEY, token);
	history.replaceState(null, "", BASE);
	$("join").hidden = true;
	$("nologin").hidden = true;
	return token;
}

async function showJoin(invite: string): Promise<string> {
	$("join").hidden = false;
	const info = await fetch(`api/invite/${invite}`).catch(() => undefined);
	const details = ((await info?.json().catch(() => ({}))) ?? {}) as { session?: string; role?: string; email?: string; login?: string; error?: string };
	if (!info?.ok) {
		$("join-link").hidden = true;
		$("join-error").textContent = details.error ?? "This invite doesn't work.";
		return new Promise(() => {});
	}
	if (details.session) $("join-name").textContent = details.session;
	if (details.role && details.role !== "editor") $("join-role").textContent = ` as ${details.role === "admin" ? "an admin" : "a viewer"}`;

	if (details.email !== undefined) {
		// An email invite: try right away, in case this browser is already signed in to exe.dev.
		$("join-link").hidden = true;
		const attempt = await join(invite, "");
		if (attempt.ok && attempt.reply.token) return enter(attempt.reply.token);
		$("join-email").hidden = false;
		$("join-email-to").textContent = details.email;
		$<HTMLAnchorElement>("join-login").href = details.login ?? "#";
		if (attempt.status === 403) {
			$("join-error").textContent = attempt.reply.error ?? "";
			const logout = $("join-logout");
			logout.hidden = false;
			logout.addEventListener("click", async () => {
				await fetch("/__exe.dev/logout", { method: "POST" }).catch(() => {});
				location.reload();
			});
		}
		return new Promise(() => {});
	}

	const input = $<HTMLInputElement>("join-input");
	input.value = storage.get("syncpi-name") ?? "";
	input.focus();
	return new Promise((resolve) => {
		$("join-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const name = input.value.trim();
			if (!name) return;
			const attempt = await join(invite, name);
			if (!attempt.ok || !attempt.reply.token) {
				$("join-error").textContent = attempt.reply.error ?? "Could not join.";
				return;
			}
			storage.set("syncpi-name", name);
			resolve(enter(attempt.reply.token));
		});
	});
}
