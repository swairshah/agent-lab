// The project's uncommitted changes in git, in the app (⇧⌘G): the files git sees as changed, their diffs, staging,
// and a commit. The app's host runs git in the project's folder on this machine (src/desktop/host.ts, /git).
// Comments on these diffs go to the thread like any other.
import { type CommentHandler, renderDiff } from "./artifacts.ts";
import { $, el, escapeHtml } from "./dom.ts";

type Status = { files: { status: string; path: string }[]; diff: string; staged: string; branch: string };

/** A combined `git diff` split into one patch per file. */
function patches(diff: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of diff.split(/^(?=diff --git )/m)) {
		const path = part.match(/^diff --git a\/.+? b\/(.+)$/m)?.[1];
		if (path) out.set(path, (out.get(path) ?? "") + part);
	}
	return out;
}

const STATUS: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", "?": "Untracked", U: "Conflicted" };

export class Git {
	readonly #thread: string;
	readonly #onComment: CommentHandler;
	readonly #notify: (text: string, tone?: "info" | "error") => void;
	readonly #root = $("git");

	constructor(thread: string, onComment: CommentHandler, notify: (text: string, tone?: "info" | "error") => void) {
		this.#thread = thread;
		this.#onComment = onComment;
		this.#notify = notify;
		$("git-close").addEventListener("click", () => this.toggle());
		$("git-refresh").addEventListener("click", () => void this.refresh());
		$("git-commit").addEventListener("submit", (event) => {
			event.preventDefault();
			const message = $<HTMLInputElement>("git-message").value.trim();
			if (!message) return;
			void this.#post({ action: "commit", message }).then((ok) => ok && ($<HTMLInputElement>("git-message").value = ""));
		});
	}

	toggle(): void {
		this.#root.hidden = !this.#root.hidden;
		if (!this.#root.hidden) void this.refresh();
	}

	async refresh(): Promise<void> {
		const res = await fetch(`/api/sessions/${this.#thread}/git`).catch(() => undefined);
		const data = (await res?.json().catch(() => undefined)) as (Status & { error?: string }) | undefined;
		if (!res?.ok || data === undefined) return this.#empty(/not a git repository/.test(data?.error ?? "") ? "This project isn't a git repository." : (data?.error ?? "Couldn't read the project's git status."));
		this.#render(data);
	}

	async #post(body: Record<string, string>): Promise<boolean> {
		const res = await fetch(`/api/sessions/${this.#thread}/git`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
		const data = (await res?.json().catch(() => undefined)) as (Status & { error?: string }) | undefined;
		if (!res?.ok || data === undefined || data.error) {
			this.#notify(data?.error ?? "Git didn't do that.", "error");
			return false;
		}
		if (body.action === "commit") this.#notify("Committed.");
		this.#render(data);
		return true;
	}

	#empty(text: string): void {
		$("git-branch").textContent = "";
		$("git-files").replaceChildren(el("p", "muted git-empty", text));
	}

	#render(status: Status): void {
		$("git-branch").textContent = status.branch ? `on ${status.branch}` : "";
		const list = $("git-files");
		list.replaceChildren();
		if (status.files.length === 0) return this.#empty("No uncommitted changes.");
		const unstaged = patches(status.diff);
		const staged = patches(status.staged);
		for (const file of status.files) {
			const [index, tree] = [file.status[0]!, file.status[1]!];
			const section = el("section", "git-file");
			const head = el("header", "git-file-head");
			const code = tree !== " " ? tree : index;
			head.innerHTML = `<span class="git-status" data-status="${escapeHtml(code)}" title="${escapeHtml(STATUS[code] ?? code)}">${escapeHtml(code === "?" ? "U" : code)}</span><span class="git-path mono">${escapeHtml(file.path)}</span>`;
			if (index !== " " && index !== "?") head.append(el("span", "git-staged", "Staged"));
			if (tree !== " ") {
				const stage = el("button", "button git-stage", "Stage");
				stage.type = "button";
				stage.addEventListener("click", () => void this.#post({ action: "stage", path: file.path }));
				head.append(stage);
			}
			section.append(head);
			const patch = unstaged.get(file.path) ?? staged.get(file.path);
			if (patch) {
				const diff = el("div", "git-diff");
				section.append(diff);
				renderDiff(diff, patch, file.path, this.#onComment);
			}
			list.append(section);
		}
	}
}
