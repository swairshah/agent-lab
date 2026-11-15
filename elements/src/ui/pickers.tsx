// The app's time field (long-horizon-agent/src/web/ui/pickers.tsx), in place of the browser's own picker, which the
// browser draws, scrolls in jumps and looks like nothing else here. A field-looking button opens a popover of three
// wheels: hour, minute (to the five), morning or afternoon. Its styles are the app's (src/ui/pickers.css, synced).
// The value is kept as <input type="time"> keeps it ("15:30"); empty means no time, when `optional`.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

const CLOCK = (
	<svg viewBox="0 0 20 20" aria-hidden="true">
		<circle cx="10" cy="10" r="6.5" />
		<path d="M10 6.5V10l2.5 1.5" />
	</svg>
);

/** The field and its popover; a click outside it or Escape closes it. */
function Picker(props: { label: string; text: string; icon: ComponentChildren; open: boolean; setOpen: (open: boolean) => void; children: ComponentChildren }) {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!props.open) return;
		const away = (event: MouseEvent) => !box.current?.contains(event.target as Node) && props.setOpen(false);
		const escape = (event: KeyboardEvent) => event.key === "Escape" && props.setOpen(false);
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);
		return () => (document.removeEventListener("mousedown", away), document.removeEventListener("keydown", escape));
	}, [props.open]);
	return (
		<div class="picker" ref={box}>
			<button type="button" class="picker-field" aria-label={props.label} aria-haspopup="dialog" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)}>
				{props.icon}
				<span>{props.text}</span>
			</button>
			{props.open ? (
				<div class="picker-pop" role="dialog" aria-label={props.label}>
					{props.children}
				</div>
			) : null}
		</div>
	);
}

/** One row of a wheel, in pixels; the CSS sets the same height. */
const ROW = 30;

/**
 * A column that scrolls freely and settles on the row in the middle band, as a phone's time wheel does. Scrolling,
 * a click on a row and the arrow keys all move it; it reports a row once it has come to rest.
 */
function Wheel(props: { label: string; items: string[]; index: number; onChange: (index: number) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const settle = useRef(0);
	const [centered, setCentered] = useState(props.index);
	const target = useRef(props.index);
	const latest = useRef(props);
	latest.current = props;
	useLayoutEffect(() => void (ref.current && (ref.current.scrollTop = props.index * ROW)), []);
	const go = (index: number) => {
		target.current = Math.max(0, Math.min(props.items.length - 1, index));
		ref.current?.scrollTo({ top: target.current * ROW, behavior: "smooth" });
	};
	const onScroll = () => {
		const index = Math.round(ref.current!.scrollTop / ROW);
		setCentered(index);
		clearTimeout(settle.current);
		settle.current = window.setTimeout(() => {
			target.current = index;
			if (index !== latest.current.index) latest.current.onChange(index);
		}, 90);
	};
	useEffect(() => () => clearTimeout(settle.current), []);
	return (
		<div
			class="wheel"
			ref={ref}
			role="listbox"
			aria-label={props.label}
			tabIndex={0}
			onScroll={onScroll}
			onWheel={(e) => {
				// A mouse wheel's notch is one row; a trackpad's small, continuous movement scrolls freely and snaps.
				if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) return;
				e.preventDefault();
				const notches = e.deltaMode === 0 ? Math.max(1, Math.round(Math.abs(e.deltaY) / 100)) : 1;
				go(target.current + Math.sign(e.deltaY) * notches);
			}}
			onKeyDown={(e) => {
				if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				go(target.current + (e.key === "ArrowUp" ? -1 : 1));
			}}
		>
			{props.items.map((item, i) => (
				<div key={item} class="wheel-row" role="option" aria-selected={i === centered} onClick={() => go(i)}>
					{item}
				</div>
			))}
		</div>
	);
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
const HALVES = ["AM", "PM"];

/**
 * A time of day, to the five minutes. With `optional`, an empty value reads "No time", the wheels open on 9:00 AM,
 * and the popover has a way back to no time.
 */
export function TimeField(props: { value: string; onChange: (value: string) => void; label?: string; optional?: boolean }) {
	const [open, setOpen] = useState(false);
	const empty = props.value === "";
	const [h, m] = (empty ? "09:00" : props.value).split(":").map(Number) as [number, number];
	const pm = h >= 12;
	const set = (hour: number, minute: number) => props.onChange(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
	const text = empty ? "No time" : new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	return (
		<Picker label={props.label ?? "Time"} text={text} icon={CLOCK} open={open} setOpen={setOpen}>
			<div class="wheels">
				<Wheel label="Hour" items={HOURS} index={(h % 12 || 12) - 1} onChange={(i) => set(((i + 1) % 12) + (pm ? 12 : 0), m)} />
				<span class="wheels-colon">:</span>
				<Wheel label="Minute" items={MINUTES} index={Math.round(m / 5) % 12} onChange={(i) => set(h, i * 5)} />
				<Wheel label="Morning or afternoon" items={HALVES} index={pm ? 1 : 0} onChange={(i) => set((h % 12) + (i === 1 ? 12 : 0), m)} />
			</div>
			{props.optional ? (
				<div class="picker-foot">
					{empty ? (
						<button type="button" class="link" onClick={() => set(h, m)}>
							Use {text === "No time" ? "9:00 AM" : text}
						</button>
					) : (
						<button type="button" class="link" onClick={() => (props.onChange(""), setOpen(false))}>
							No time
						</button>
					)}
				</div>
			) : null}
		</Picker>
	);
}
