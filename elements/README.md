# Agent elements

UI elements that people and the agent share, worked out apart from the app (`../long-horizon-agent`) before they go
into it. An element is something on the screen, such as a calendar or a checklist, that both people and the agent
change, with every change a version anyone can read, attribute and revert.

```bash
npm install
npm test                                   # each element alone (its actions, tools, history), and the look check
npm run check:ui                           # the elements and the lab keep the app's look (UI-GUIDELINES.md)
npm run lab -- --ui calendar,checklist     # a local chat with only those elements (the test model)
npm run lab -- --ui calendar --model anthropic/claude-sonnet-5.5    # a real model (OPENROUTER_API_KEY in .env)
```

The lab is at http://localhost:8300. Open it in two windows with two names to see two people and the agent on the
same element. Elements not named in `--ui` can be switched on from the page. `--fresh` starts from nothing.

## 1. An element, and what the agent gets from it

An element is defined once (`src/element.ts`): its state, its **actions** (pure functions from the state and some
arguments to the next state, each with a one-line summary of what it did), and a **view** (the state as text, for the
agent). See `src/elements/calendar/element.ts`.

From that definition the agent gets (`src/agent.ts`):

| Tool | What it does |
|---|---|
| `calendar_read` | The element now, as text, and its version |
| `calendar_<action>` | One per action, taking the action's arguments and the `version` it last read. Refused if the element changed since, with what changed, so the agent never changes what it has not seen |
| `calendar_history` | Every change: version, time, who, what |
| `calendar_revert` | Puts an earlier version back, as a new version, with a reason |

People change the element through its component (`view.tsx`), which calls the same actions. So there is one way to
change an element, and every change, whoever makes it, goes through it.

**History and revert** (`src/store.ts`): each change is a row with the state after it. Nothing is overwritten. A
revert is one more row that puts an earlier state back, so it is itself in the history and can be reverted. Any version
can be read back.

## 2. Testing one alone

- **In code** (`src/testing.ts`): `testElement(def)` gives the element a temporary store. `act` and `revert` change it
  as a person would; `callTool` runs one of its tools as the agent would (a real pi-durable Harness, a scripted model);
  `sectionText` is what the agent is told about it at its next step. See `src/elements/*/…test.ts`.
- **In a chat** (`npm run lab -- --ui <ids>`): the elements on the right, the conversation on the left, each element
  with its history and Put back. With the test model, `tool calendar_read {}` makes it call a tool; with a real model
  it is a real session.

## 3. How a change is recorded in the agent's session

The session's transcript is the record of what happened. Each kind of change is in it once:

| Who | In the transcript | How the agent knows |
|---|---|---|
| The agent | Its tool call; the result carries the element, the new version and the summary | It made it |
| A person | A `ui.op` entry ("Ada changed Calendar: Added e2 … v3") that people see and the model does not | At its next step, the `ui_elements` prompt section lists each element's version, the version the agent last saw, and every change people made since |
| A person, with an action marked `wakes` | Also a `ui.wake` input that messages the agent now | The message itself |

The element's history points back into the transcript: an agent's change carries its tool call's id, so the history's
"In the chat" goes to the moment it happened.

## Adding an element

1. `src/elements/<id>/element.ts`: `defineElement({ id, title, description, initial, view, actions })`. Write each
   action's `apply` as a pure function that throws, in plain words, when the change cannot be made.
2. `view.tsx`: a component taking `{ state, version, act }` (`src/view.ts`) that changes the element only through `act`,
   built from the base's classes, and `view.css` for its own layout only, with classes starting `el-<id>-`. Follow
   [UI-GUIDELINES.md](UI-GUIDELINES.md): it is the app's look, written down.
3. A test with `testElement`.
4. List it in `src/elements/index.ts` and `src/lab/web/views.ts`, then try it: `npm run lab -- --ui <id>`.
5. `npm run check:ui` (also in `npm test`): its look keeps the app's.

## Going into the app

How this maps onto `long-horizon-agent`, when we do it:

- **Scope** is the file: `case:<id>` (the lab has one scope). The General conversation reads every file's elements.
- **Store**: `el_ops` and `el_seen` go in the workspace database beside pi-durable's tables, as the app's own tables do.
- **Agent**: `elementsAgent(...)` gives one pi-durable extension per element, installed and removed like the app's
  extensions; a workspace switches elements on in Settings, as plugins are now. `ExtensionDef` can carry elements, so
  a plugin brings its own.
- **Screen**: the side panel's tabs (Calendar, the file's checklist) become element components; WebSocket frames
  replace the lab's server-sent events; `ui.op` entries get a line in the thread view.
- **Calendar and checklist**: today they are the app's own tables (`events`, `cases.checklist`) changed by its own
  tools. Moving them onto elements gives them versions, history and revert. They need their wake-ups and expiry
  reminders kept, which the element's actions can schedule.
- **Checks**: `ext:check` gains an element check (actions named, summaries written, a view, a test).

Open questions:

- **Snapshots**: every version keeps the whole state. Fine for a calendar; a large element needs snapshots every N
  versions with the actions replayed between.
- **Roles**: a viewer must not act. The lab has no roles.
- **Approval**: should some agent changes wait for a person's yes (cancelling an entry someone else made)? An action
  could be marked `needsApproval`.
- **Merging**: today a stale change is refused and the agent reads again. Changes to different items could be merged
  instead of refused.
