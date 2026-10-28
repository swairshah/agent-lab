// Terminals in the app (ctrl-`): shells in the project's folder on this machine, in tabs under the thread. The app's
// host runs each one (a PTY, src/desktop/host.ts) and streams it over a WebSocket; xterm draws it. `!cmd` in the
// composer runs a command in a new one. Only in the app: a browser has no shell to give.
import { $, el } from "./dom.ts";

type Tab = { id: number; title: string; view: HTMLElement; socket: WebSocket; closed: boolean; fit(): void; focus(): void };

export class Terminals {
	readonly #thread: string;
	readonly #root = $("terminal");
	readonly #tabs = $("terminal-tabs");
	readonly #views = $("terminal-views");
	#all: Tab[] = [];
	#current = 0;
	#next = 1;

	constructor(thread: string) {
		this.#thread = thread;
		new ResizeObserver(() => this.#tab()?.fit()).observe(this.#views);
		// Dragging the top edge sets the height.
		$("terminal-resize").addEventListener("mousedown", (event) => {
			event.preventDefault();
			const start = event.clientY;
			const height = this.#root.offsetHeight;
			const move = (e: MouseEvent) => (this.#root.style.height = `${Math.max(120, Math.min(innerHeight - 160, height + start - e.clientY))}px`);
			const up = () => {
				removeEventListener("mousemove", move);
				removeEventListener("mouseup", up);
			};
			addEventListener("mousemove", move);
			addEventListener("mouseup", up);
		});
	}

	get open(): boolean {
		return !this.#root.hidden;
	}

	/** Shows the terminals (making one if there's none), or hides them. */
	toggle(): void {
		if (this.open) return this.#hide();
		this.#root.hidden = false;
		if (this.#all.every((t) => t.closed)) void this.add();
		else this.#show(this.#current);
	}

	/** A new terminal; with `command`, runs it there. */
	async add(command?: string): Promise<void> {
		this.#root.hidden = false;
		const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
		if (!document.querySelector('link[href$="xterm.css"]')) document.head.append(Object.assign(el("link"), { rel: "stylesheet", href: "xterm.css" }));
		const style = getComputedStyle(document.documentElement);
		const term = new Terminal({
			fontFamily: style.getPropertyValue("--mono"),
			fontSize: 12.5,
			cursorBlink: true,
			allowProposedApi: false,
			theme: { background: style.getPropertyValue("--sunken").trim(), foreground: style.getPropertyValue("--ink").trim(), cursor: style.getPropertyValue("--accent").trim(), selectionBackground: style.getPropertyValue("--accent-soft").trim() },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		const view = el("div", "terminal-view");
		this.#views.append(view);
		term.open(view);
		const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/terminal/${this.#thread}`);
		const id = this.#next++;
		const tab: Tab = {
			id,
			title: command ? command.split(/\s+/)[0]! : "zsh",
			view,
			socket,
			closed: false,
			fit: () => {
				if (view.hidden || view.offsetWidth === 0) return;
				fit.fit();
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
			},
			focus: () => term.focus(),
		};
		socket.onopen = () => {
			tab.fit();
			if (command) socket.send(JSON.stringify({ data: `${command}\r` }));
		};
		socket.onmessage = (event) => {
			const m = JSON.parse(String(event.data)) as { data?: string; exitCode?: number; error?: string };
			if (m.data !== undefined) term.write(m.data);
			if (m.error !== undefined) term.write(`\r\n${m.error}\r\n`);
			if (m.exitCode !== undefined) term.write(`\r\n[exited with ${m.exitCode}]\r\n`);
		};
		socket.onclose = () => {
			tab.closed = true;
			this.#renderTabs();
		};
		term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ data })));
		term.onTitleChange((title) => {
			tab.title = title || tab.title;
			this.#renderTabs();
		});
		this.#all.push(tab);
		this.#show(id);
	}

	#tab(): Tab | undefined {
		return this.#all.find((t) => t.id === this.#current);
	}

	#show(id: number): void {
		this.#current = id;
		for (const t of this.#all) t.view.hidden = t.id !== id;
		this.#renderTabs();
		requestAnimationFrame(() => {
			this.#tab()?.fit();
			this.#tab()?.focus();
		});
	}

	#close(id: number): void {
		const tab = this.#all.find((t) => t.id === id);
		if (tab === undefined) return;
		tab.socket.close();
		tab.view.remove();
		this.#all = this.#all.filter((t) => t.id !== id);
		const last = this.#all.at(-1);
		if (last === undefined) this.#hide();
		else this.#show(last.id);
	}

	#hide(): void {
		this.#root.hidden = true;
		$("input").focus();
	}

	#renderTabs(): void {
		this.#tabs.replaceChildren(
			...this.#all.map((t) => {
				const tab = el("div", "terminal-tab");
				tab.setAttribute("aria-selected", String(t.id === this.#current));
				tab.dataset.closed = String(t.closed);
				const name = el("button", "terminal-name", t.title);
				name.type = "button";
				name.addEventListener("click", () => this.#show(t.id));
				const close = el("button", "terminal-close", "×");
				close.type = "button";
				close.title = "Close this terminal";
				close.addEventListener("click", () => this.#close(t.id));
				tab.append(name, close);
				return tab;
			}),
		);
		const add = el("button", "icon-button small", "+");
		add.type = "button";
		add.title = "New terminal";
		add.addEventListener("click", () => void this.add());
		const hide = el("button", "icon-button small terminal-hide", "⌄");
		hide.type = "button";
		hide.title = "Hide terminals (⌃`)";
		hide.addEventListener("click", () => this.#hide());
		this.#tabs.append(add, el("span", "spacer"), hide);
	}
}
