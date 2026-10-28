// Following someone, as in Delta: click a face at the top and your view goes where theirs does: the thread they're
// in and how far down, the file they have open and where in it, and the file they're editing, live, with their
// cursor. Scrolling, clicking or typing yourself (or Esc) stops it. Everyone shares where they are (protocol.ts View)
// for this, a few times a second at most.
import type { ConvName, View } from "../shared/protocol.ts";
import { $ } from "./dom.ts";
import type { ArtifactPanel } from "./panel.ts";
import type { SessionClient } from "./session.ts";

export type FollowOptions = {
	session: SessionClient;
	scroller: HTMLElement;
	box: HTMLElement;
	panel: ArtifactPanel;
	showing: () => ConvName;
	show: (conv: ConvName) => void;
	notify: (text: string) => void;
};

export class Follow {
	readonly #o: FollowOptions;
	#following: string | undefined;
	#sent = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Set while this page moves itself to follow, so those scrolls aren't taken for the person's own. */
	#moving = false;

	constructor(options: FollowOptions) {
		this.#o = options;
		const share = () => this.share();
		document.addEventListener("scroll", share, { capture: true, passive: true });
		document.addEventListener("click", share, true);
		options.panel.onEditing = share;
		options.session.on("connection", () => {
			this.#sent = "";
			share();
		});
		options.session.on("views", () => this.#apply());
		// Doing something yourself stops following.
		const stop = (event: Event) => {
			if (this.#following === undefined || this.#moving) return;
			// The faces and the bar have their own say.
			if ((event.target as Element | null)?.closest?.("#presence, #follow-bar")) return;
			this.stop();
		};
		for (const type of ["wheel", "touchmove", "mousedown"]) document.addEventListener(type, stop, { capture: true, passive: true });
		document.addEventListener("keydown", (event) => {
			if (this.#following === undefined) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.stop();
			} else if (!event.metaKey && !event.ctrlKey) stop(event);
		}, true);
		$("follow-stop").addEventListener("click", () => this.stop());
		$("presence").addEventListener("click", (event) => {
			const id = (event.target as HTMLElement).closest<HTMLElement>("[data-member]")?.dataset.member;
			if (id === undefined) return;
			if (this.#following === id) this.stop();
			else this.follow(id);
		});
	}

	get following(): string | undefined {
		return this.#following;
	}

	follow(memberId: string): void {
		const session = this.#o.session;
		if (memberId === session.me?.id) return;
		if (!session.views.has(memberId)) return this.#o.notify(`${session.nameOf(memberId)} isn't anywhere to follow right now.`);
		this.#following = memberId;
		this.#render();
		this.#apply();
	}

	stop(): void {
		if (this.#following === undefined) return;
		this.#following = undefined;
		this.#render();
	}

	/** Set while this person is using Find: where its matches take them isn't shared. */
	paused = false;

	/** Where this person is now, for anyone following them; sent when it changes, a few times a second at most. */
	share(): void {
		if (this.#timer !== undefined || this.paused) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const view = JSON.stringify(this.#mine());
			if (view === this.#sent) return;
			this.#sent = view;
			this.#o.session.send({ type: "view", view: JSON.parse(view) as View });
		}, 150);
	}

	#mine(): View {
		const { scroller, box, panel, showing } = this.#o;
		const top = scroller.getBoundingClientRect().top;
		const node = [...box.querySelectorAll<HTMLElement>(":scope > [data-key]")].find((n) => n.getBoundingClientRect().bottom > top + 1);
		const view: View = { conv: showing(), panel: panel.shown };
		if (node !== undefined) {
			view.at = node.dataset.key;
			view.offset = Math.round(top - node.getBoundingClientRect().top);
		}
		if (view.panel !== null) view.scroll = Math.round(panel.scroll * 1000) / 1000;
		if (panel.editing !== undefined) view.editing = panel.editing;
		return view;
	}

	/** Goes where the person followed is now. */
	#apply(): void {
		const id = this.#following;
		if (id === undefined) return;
		const { session, scroller, box, panel, showing, show } = this.#o;
		const view = session.views.get(id)?.view;
		if (view === undefined) {
			this.#o.notify(`${session.nameOf(id)} left.`);
			return this.stop();
		}
		this.#moving = true;
		if (view.conv !== showing()) show(view.conv);
		const node = view.at === undefined ? null : box.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(view.at)}"]`);
		if (node !== null) scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (view.offset ?? 0);
		if (view.panel === null) {
			if (panel.editing !== undefined) panel.stopEditing();
			if (panel.shown !== null) panel.toggle(false);
		} else if (view.panel === "changes") {
			if (panel.editing !== undefined) panel.stopEditing();
			if (panel.shown !== "changes") panel.showChanges();
		} else if (view.editing === view.panel) void panel.editPath(view.panel);
		else {
			if (panel.editing !== undefined) panel.stopEditing();
			if (panel.shown !== view.panel) void panel.openPath(view.panel);
		}
		// The panel's tab may still be opening: its scroll goes in once it's there.
		requestAnimationFrame(() => {
			if (view.panel !== null && view.scroll !== undefined) panel.scroll = view.scroll;
			setTimeout(() => (this.#moving = false), 60);
		});
	}

	#render(): void {
		const id = this.#following;
		const bar = $("follow-bar");
		bar.hidden = id === undefined;
		if (id !== undefined) $("follow-name").textContent = this.#o.session.nameOf(id);
		for (const face of $("presence").querySelectorAll<HTMLElement>("[data-member]")) face.classList.toggle("followed", face.dataset.member === id);
	}

	/** The faces at the top changed: the one being followed stays marked. */
	refresh(): void {
		this.#render();
	}
}
