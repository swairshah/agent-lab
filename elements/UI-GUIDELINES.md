# UI guidelines

An element is built here and then goes into the app (`~/work/buisn/long-horizon-agent`). It has to look and read as if it had
always been there. These are the app's rules, written down. `npm run check:ui` checks the ones a program can check (and
`npm test` runs it); the rest are checked by reading the screen against this page.

## Who reads the screen

People who are not technical, working on many things at once and coming back to the same screens all day. So the
screen is quiet, and the important thing is plain. They use their own words for their work, not the software's.

## The look

The app's look is the Delta app's: warm grey paper, near-black ink, one blue accent, IBM Plex Sans with Lilex for
figures. It has a light and a dark version, picked by the person's system or by a switch.

**Never write a color, a font or a shadow of your own.** Use the tokens. They are the app's, value for value, in
`src/ui/base.css` (the check compares them with the app's `style.css`). Dark mode then comes for free.

| Token | What it is for |
|---|---|
| `--paper` | The page |
| `--raised` | Things above the page: inputs, cards, popovers, a hovered row |
| `--sunken` | Hover on a quiet control; a note on the page (a person's change in the conversation) |
| `--code` | Code and raw output |
| `--ink` | Text |
| `--ink-2` | Secondary text: notes, details |
| `--muted` | Labels, meta, quiet controls |
| `--faint` | Weekday letters, days outside the month, disabled |
| `--rule` | Every line between things |
| `--rule-strong` | Input and button borders, an empty mark |
| `--accent` | The primary action, links, "today", what waits on the people looking at it |
| `--accent-soft` | A highlight: the moment a link led to, an agent wake-up |
| `--ok` | Done, verified, settled |
| `--warn` | Waiting on someone outside; a revert |
| `--removed` | Blocked, failed, destructive (Remove, Cancel it) |
| `--focus` | The focus ring |
| `--shadow` | Only for what floats: popovers, toasts, dialogs |

Colors carry the same meaning everywhere: green is settled, blue is on you or the action to take, amber is
waiting on someone outside, red is blocked or destructive. Do not use them for decoration.

## Type

All text is `var(--sans)`; figures that line up (versions, counts, times in lists) are `var(--mono)`. There is no
serif.

| What | How |
|---|---|
| Body, conversation | 14px, line height 1.55 |
| A row's title (an item, an entry) | 13.5px |
| Meta under a row, help under a field | 12–12.5px, `--muted` |
| A section's label | `.section-label`: 10.5px mono capitals, spaced, `--muted` ("COMING UP", "NOV 15 · TODAY") |
| A field's label | `.form-field label`: the same small mono capitals |
| A heading in a panel | 13px, weight 600 (the month's name) |
| An eyebrow above a title | `.eyebrow`: 11px mono capitals in `--accent` |

Weights are 400, 500 and 600. Nothing is bold for emphasis in a row; the title is enough.

## Layout

- **Lines, not boxes.** Rows are separated by a 1px `--rule` line. A card or a border around a group is the exception:
  a popover, a form being filled in, a history list.
- **Shadows only for what floats** above the page (`--shadow`): a popover, a toast, a dialog.
- **Corners**: 5–6px for controls and day cells, 8px for rows and toasts, 10px for cards and popovers, round (999px) for
  pills and switches.
- **Rows** have 8px of space above and below. A list of rows has no gap; the lines separate them.
- **A panel** is at most about 560px wide. On a phone everything is one column, with a 16px gutter and no sideways
  scrolling.
- **No stat strips.** No row of big numbers with small labels under them. Say a count in a sentence ("3 of 16 done") or
  show it as a mark per item.

## The conversation

The conversation is the app's, not one made to look like it. `src/ui/chat.css` is the app's own thread, message box
and status bar rules, written by `npm run sync:ui` from the app's stylesheets (do not edit it; change the app and sync).
The lab draws it with the app's markup:

| Row | Markup |
|---|---|
| A person's message | `article.msg.msg-user` with `--person` (their color), `.msg-who > .author`, `.msg-content > .msg-body.prose` (markdown) |
| The agent's reply | `article.msg.msg-agent` with the model's mark (`.avatar.model-avatar`) and `.msg-body.prose` |
| A tool call | in an agent row, `details.fold.tool.tool-<done|error|running>` with `.tool-verb` (what it did, in words) and `.tool-arg` (on what); the raw result folded in `.tool-body > pre.tool-output` |
| Calls one after another | one row: a short verb ("Made 2 changes") and what they touched ("5 steps on the calendar and the checklist") |
| A person's change on the screen | `.notice`, the app's centred line: "Ada changed the calendar: …" |
| What woke the agent | `.wake` with `.wake-kind` and `.wake-text` |
| The message box | the next row of the thread: `form.msg.composer` with the person's avatar, a growing `textarea` and a send icon button |
| While the agent works | a Stop icon button beside Send in the message box; no status bar under it |

A tool call is said in words ("Changed the calendar", "Read the checklist"), never as its tool name.

## Building blocks

Use the base's classes (`src/ui/base.css`, the app's own rules) before writing anything:

| Need | Class |
|---|---|
| An action | `.button`; the one main action of a form `.button.primary` |
| A quiet action in a row | `.text-button` ("Mark done", "Cancel it") |
| A link-like action | `.link`; destructive `.link.danger` |
| An icon on its own | `.icon-button` (`.small` in a dense place), with an `aria-label` |
| On or off | `.switch` with `role="switch"` and `aria-checked`, and `.switch-knob` inside |
| A labelled field | `.form-field` with a `label`, and `.field-help` under it |
| A checklist | `ul.checklist > li.check-row` with a `.check-mark` button, `.check-main`, `.check-title`, `.check-note`; the row's state as `.check-verified`, `.check-waiting` or `.check-blocked` |
| A list of dated entries | `ul.event-list > li.event` with `.event-dot` (`.tone-scheduled` for one still to come), `.event-main`, `.event-title`, `.event-meta`, `.event-actions` |
| A pill to pick | `.chip` |
| A time of day | `TimeField` (`src/ui/pickers.tsx`, the app's): a field that opens hour, minute and AM/PM wheels. Never the browser's own `<input type="time">` or date picker |
| A passing message | `.toast`; `data-tone="error"` when something was refused |
| Quiet text | `.muted`, `.small` |

An element adds only its own layout, in `src/elements/<id>/view.css`, with class names that start with `el-<id>-`. The
lab's own classes start with `lab-`. A state goes in an attribute, not a bare class: `aria-selected`, `aria-checked`,
`aria-expanded`, or `data-…` (`data-today`). So nothing an element writes can collide with the app's classes.

## Motion

- At most 300ms, and usually 120–200ms. Something people do many times a day (switching tabs, opening a row) gets no
  motion at all.
- Ease out: `ease-out` or `cubic-bezier(0.23, 1, 0.32, 1)`. Never ease in: the screen should answer at once.
- Move `transform` and `opacity`. Do not animate size or position.
- Under `prefers-reduced-motion` the base turns animation off; the screen must still read without it.

## Words

- **The people's words**: what they call their work, never the software's names for it (no "entity", "record", "op").
- **Plain sentences.** "Nothing on this day." "What blocks it?" Never a technical word on the screen: no ids, no
  JSON, no "null", no "API", no field names. An element's ids (`e1`, `i2`) are for the agent, not for people.
- **Buttons say what happens**: "Mark done", "Cancel it", "Put back", "Remove". Not "OK", not "Submit".
- **Dates** as people say them: "Mar 1, 2027", "Sun, Nov 15", "Nov 15 · Today". Times as on the clock in lists.
- **An empty element gives something to go from**: say it is empty, and put the way to add the first thing right
  there.
- **A refusal says why and what to do**: "Calendar changed since you opened it: …". The page catches up on its own.
- **People are they/them** unless they said otherwise.

## Accessibility

- Every control is a `button`, `input` or `select`, never a clickable `div`. An icon-only button has an `aria-label`.
- Focus shows (`:focus-visible` uses `--focus`). Enter submits a form; Escape closes what is open.
- Hit areas are at least 24px. Row actions that appear on hover also appear on focus, and always on touch screens.

## Elements in particular

- A component changes its element only through `act`: the same actions the agent calls. It never changes its state
  directly, so every change is a version with who made it.
- It shows the element's state, not the version or the history: the page around it (the lab, the app's panel) shows
  those, the same way for every element.
- It handles a refused change by doing nothing more: `act` resolves false, and the page says why and catches up.

## What the check checks

`npm run check:ui` (and `npm test`) fails when:

- a token in `src/ui/base.css` differs from the app's, or one is missing or extra;
- `src/ui/chat.css` or `src/ui/pickers.css` is not the app's as it is now (run `npm run sync:ui`);
- an element's `view.css` or the lab's `lab.css` writes a color (hex, rgb, hsl, …) or names a font;
- a transition or animation takes over 300ms, or eases in;
- a stylesheet defines a class without its prefix (`el-<id>-`, `lab-`) that is not one of the base's;
- a component uses a class that is neither the base's nor its own, or sets a color inline.

It warns when a component shows words that look technical. Everything else on this page is checked by reading the
screen in the lab, in light and in dark.
