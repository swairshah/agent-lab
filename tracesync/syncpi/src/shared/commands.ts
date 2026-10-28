import { ROLES, type Role } from "./protocol.ts";

export function parseInvite(arg: string): { email?: string; role?: Role; expiresInDays?: number; maxUses?: number } | string {
	const out: { email?: string; role?: Role; expiresInDays?: number; maxUses?: number } = {};
	const words = arg.split(/\s+/).filter((w) => w.length > 0);
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (w === "--link" || w === "link") continue;
		if (w.includes("@")) out.email = w;
		else if (ROLES.includes(w as Role)) out.role = w as Role;
		else if (/^\d+d$/.test(w)) out.expiresInDays = Number(w.slice(0, -1));
		else if (/^\d+h$/.test(w)) out.expiresInDays = Number(w.slice(0, -1)) / 24;
		else if (w === "never") out.expiresInDays = 0;
		else if (w === "--uses" && /^\d+$/.test(words[i + 1] ?? "")) out.maxUses = Number(words[++i]);
		else return `don't understand "${w}"; usage: /invite [email] [admin|editor|viewer] [7d|12h|never] [--uses N]`;
	}
	return out;
}
