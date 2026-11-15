# Agent elements

UI elements that people and the agent share (a calendar, a checklist), worked out here before they go into the app at
`~/work/buisn/long-horizon-agent`. Read `README.md` for the design and `UI-GUIDELINES.md` before touching anything on
the screen.

## What this is

- An element is defined once in `src/elements/<id>/element.ts`: its state, its named actions (pure functions from the
  state and arguments to the next state, each with a one-line summary), and a text view for the agent.
- From that, the agent gets tools (`src/agent.ts`): `<id>_read`, one per action (each takes the `version` it last read
  and is refused if the element changed since), `<id>_history`, `<id>_revert`. A prompt section tells it, at every
  step, what people changed since it last looked.
- Every change, by a person or the agent, is a numbered version with who made it (`src/store.ts`). Nothing is
  overwritten; a revert is a new version.
- People change an element through its component (`view.tsx`), which calls the same actions through `act`.
- The lab (`src/lab/`) is a local chat with only the elements you pick: `npm run lab -- --ui calendar,checklist`.

## Commands

```bash
npm test                                  # every element alone, and the look check
npm run typecheck
npm run lab -- --ui calendar,checklist    # http://localhost:8300, the test model ("tool <name> <json>" calls a tool)
npm run lab -- --ui calendar --model anthropic/claude-sonnet-5.5   # a real model (OPENROUTER_API_KEY in .env)
npm run lab -- --fresh                    # start from an empty data/lab.sqlite
npm run check:ui                          # the look keeps the app's
npm run sync:ui                           # take the app's conversation styles again after the app changes
```

Run `npm run typecheck` and `npm test` before calling something done. The lab builds the page on start; after changing
only the page, `node build.mjs` and reload.

## Rules

- Node runs the TypeScript directly (type stripping): no enums, no parameter properties, imports end in `.ts`. Only
  `src/lab/web` is bundled (esbuild, Preact).
- An action's `apply` is pure: no clock (use `ctx.now`), no network, no randomness. It throws, in plain words a person
  or the model can act on, when the change cannot be made. Its `summary` says what changed, naming the item.
- A component changes its element only through `act`. It never edits state directly.
- Never change the store's history: no updates or deletes of `el_ops` rows.
- A new element: `src/elements/<id>/` with `element.ts`, `view.tsx`, `view.css` and a test using `testElement`
  (`src/testing.ts`); list it in `src/elements/index.ts` and `src/lab/web/views.ts`.

## The look

The screen must look like the app's. `UI-GUIDELINES.md` is the full rule; in short:

- Use the tokens and the base's classes (`src/ui/base.css`). No colors, fonts or shadows of your own.
- An element's own classes start with `el-<id>-`, the lab's with `lab-`. States go in attributes (`aria-*`, `data-*`),
  not bare classes.
- Do not edit `src/ui/chat.css` or the token block of `src/ui/base.css`: they are the app's. Change the app, then
  `npm run sync:ui` (chat) or copy the tokens again; `npm run check:ui` fails until they match.
- The conversation uses the app's markup (rows, folded tool calls in words, the composer as the next row, the status
  bar). Say a tool call in words, never its tool name.
- Motion at most 300ms, easing out. The office's words: file, practitioner, facility. No ids or technical words on the
  screen. No stat strips.

The look check finds the app at `~/work/buisn/long-horizon-agent`, or at `LONG_HORIZON_AGENT`.

## Git

This folder is its own git repository, inside `~/work/agents/agent-lab` but not yet part of that repository's history.
Commit here. `.env` (the model key), `data/` and `node_modules/` stay out of git.

## Not done yet

Going into the app (scope per file, the store in the workspace database, elements switched on in Settings, the app's
calendar and checklist as elements) is described at the end of `README.md`, with the open questions: snapshots,
roles, approval of some agent changes, merging instead of refusing.
