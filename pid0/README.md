# pid0

One coding-agent CLI that drives Claude Code, Codex, Antigravity and pi. It talks to each of them over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), lets you pick the harness and the model inside it, and keeps every session in a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) store. Its command line follows pi-coding-agent's.

- **One conversation, several harnesses.** `/harness codex` in the middle of a session moves the conversation to Codex. The harness you switch to is told what happened so far with its next prompt; the one you left is told what it missed when you come back.
- **Model choice inside the harness.** `/model`, `--model claude/opus:high`, Ctrl+P. pid0 reads the models, thinking levels and modes each harness offers over ACP and sets them there.
- **pi-durable sessions.** A session is one SQLite file under `~/.pid0/sessions/<folder>/`. Messages, tool calls, plans and shell commands are pi-durable entries; `/tree` branches are pi-durable forks; `/compact` is a pi-durable reset with a handoff note.
- **pi's terminal UI.** The interactive mode is built from pi 1.5.0's own components: its settings list, themes, `keybindings.json`, session, tree and fork selectors, message and tool rendering, prompt templates and skills. `--print`, `--mode json` and `--mode rpc` work as in pi.

## Use

```sh
cd pid0 && npm install
alias pid0="$PWD/bin/pid0.mjs"     # Node 22.19 or newer; it runs the TypeScript directly

pid0 harnesses                     # which harnesses are installed
pid0                               # the terminal UI, in the current folder
pid0 --harness codex --model gpt:high
pid0 -p "Summarize this repository"
git diff | pid0 -p "Review this change"
pid0 -c                            # continue this folder's latest session
pid0 -c --harness pi -p "check what Claude did"   # same session, another harness
pid0 --list-models
```

### Harnesses

| Name | What pid0 runs | Needs |
|---|---|---|
| `claude` | `claude-agent-acp`, else `npx -y @agentclientprotocol/claude-agent-acp` | the login your `claude` uses |
| `codex` | `codex-acp`, else `npx -y @agentclientprotocol/codex-acp` | the login your `codex` uses |
| `antigravity` | `agy acp` (built into agy 1.5+), else `agy-acp` / `antigravity-acp` on PATH | the `agy` CLI, signed in |
| `pi` | `pi-acp`, else `npx -y pi-acp` | `pi` on PATH, with a provider login |

Any other ACP agent can be added, and the built-in commands overridden, in `~/.pid0/settings.json`:

```json
{
  "defaultHarness": "claude",
  "harnesses": {
    "gemini": { "label": "Gemini CLI", "command": ["gemini", "--acp"] },
    "pi": { "env": { "PI_ACP_PI_COMMAND": "/opt/pi/bin/pi" } }
  }
}
```

Each harness signs in the way its own CLI does. pid0 points the Claude Code and Codex adapters at the `claude` and `codex` you have installed (when they are on PATH), so they run your version with your login. An `ANTHROPIC_API_KEY` in the environment is passed to Claude Code only if you approved that key in Claude Code itself; otherwise your Claude login is used, as in `claude`. To use the key anyway, set `"useApiKey": true` on the harness in settings.

`PID0_<NAME>_COMMAND` overrides one harness's command for a run. `pid0 auth login <harness> [method]` runs a harness's own sign-in; `pid0 auth check <harness>` prints `ready` or `not_ready`.

### Models

`--model` takes a model id or part of its name, optionally `harness/` in front and `:<thinking>` behind: `opus`, `claude/sonnet`, `codex/gpt-5:high`. `--thinking` and `--agent-mode` set the harness's thinking level and mode (for example `plan`). The choices come from the harness: ACP session config options (`model`, `thought_level`, `mode`), and the older `models` field with `session/set_model` for agents that still use it. A choice made in the terminal UI is remembered per harness.

`--models a,b,c` (or `scopedModels` in settings) is the list Ctrl+P cycles through; entries can name different harnesses, so one key moves between, say, `claude/opus` and `codex/gpt-5`.

### In the terminal UI

The UI reads pi's own folder (`~/.pi/agent`, or `PID0_PI_DIR`): `settings.json` for the settings `/settings` shows, `keybindings.json`, `themes/`, `prompts/` and `skills/`. So pid0 looks and behaves like your pi, and a setting changed in either shows in both. pid0's own choices (harnesses, default models, permissions, MCP servers, sessions) stay in `~/.pid0`.

pi's commands: `/settings`, `/model`, `/scoped-models`, `/thinking`, `/export`, `/import`, `/share`, `/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`, `/tree`, `/login`, `/logout`, `/new`, `/compact`, `/resume`, `/reload`, `/debug`, `/quit`. pid0 adds `/harness`, `/mode` (the harness's own modes, such as plan), `/permissions` and `/mcp`. Prompt templates are `/name`, skills `/skill:name`, and anything else starting with `/` goes to the harness, whose own commands appear in the `/` menu. `!cmd` runs a shell command; `!!cmd` keeps it from the agent.

Keys are pi's and follow `keybindings.json`; `/hotkeys` lists them. A message sent while the agent works is queued as a follow-up. Double Esc on an empty editor opens `/tree` or `/fork`, as the setting says.

When a harness asks permission for a tool, pid0 shows the harness's own options. `--permissions allow|deny` answers for you; outside the terminal UI the default is `allow`, as nobody is there to ask.

### Sessions

`-c`, `-r`, `--session <path|id>`, `--session-id <id>`, `--fork <path|id>`, `--session-dir <dir>`, `--no-session` and `-n <name>` work as in pi. `PID0_DIR` moves `~/.pid0`; `PID0_SESSION_DIR` or `sessionDir` moves the sessions.

### MCP servers

```sh
pid0 mcp add docs -- npx -y some-mcp-server
pid0 mcp add api --url https://example.com/mcp --header Authorization="Bearer …"
pid0 mcp list
```

These go in `~/.pid0/mcp.json` (`-l`: the project's `.pid0/mcp.json`) and are handed to every harness when its session starts, so one list serves all four. `--no-mcp` leaves them out for a run.

### JSON and RPC

`--mode json` writes a session header and then one event per line, in pi's shapes where they apply: `agent_start`, `turn_start`, `message_start|update|end`, `tool_execution_start|update|end`, `turn_end`, `agent_end`, `agent_settled`, `queue_update`, `compaction_start|end`. pid0 adds `harness_changed`, `model_changed`, `mode_changed`, `plan_update`, `usage_update`, `notice`.

`--mode rpc` reads commands on stdin: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `compact`, `bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`; and `set_harness`, `get_harnesses`, `set_mode`, `get_available_modes`, `list_sessions`, `navigate_tree`. With `--permissions ask` a tool permission arrives as a `permission_request` event and is answered with `{"type":"permission_response","id":…,"optionId":…}`.

## What differs from pi

pid0 does not run a model loop of its own; the harness does. That decides what cannot carry over:

- **Extensions and packages.** pi extensions hook into pi's own loop, so they do not load, and `pi install`, `update`, `config` have no counterpart. Tools and context files (`AGENTS.md`) are each harness's own; pid0 refuses `--tools`, `-e`, `-nc`, `--api-key`, `--offline` and the trust flags with that explanation.
- **Settings that belong to pi's loop.** `/settings` lists them all, as pi does, but transport, cache warming, HTTP idle timeout, steering mode, image settings and per-model thinking levels have no effect on a harness. Auto-compact, follow-up mode, theme, thinking visibility, double-escape action, tree filter, paddings, autocomplete size, quiet startup, hardware cursor, clear on shrink, terminal progress and terminal mode do apply.
- **Steering.** ACP has no way to add a message to a running turn, so every message sent mid-turn is a follow-up.
- **`/tree` and `/fork`.** A harness cannot rewind its own session. After you move to another point, the harness starts a fresh native session and is given the conversation up to that point as text. Files are not rewound, branches are not summarized, and entries cannot be labeled.
- **`/compact` and auto-compact.** The current harness writes a handoff summary; the session is reset to it and every harness starts fresh from the summary. Auto-compact does this when the harness reports its context 90% full.
- **`/model`** lists the current harness's models, with the other harnesses as entries that switch first. **`/scoped-models`** offers the current harness's models; entries for other harnesses come from `--models` or settings.
- **`/login` and `/logout`** use what the harness offers over ACP. A sign-in that needs a terminal runs with `pid0 auth login`.
- **`/share`** makes a secret gist with `gh`. **`/import`** takes a pid0 JSONL export. **`/bug`** and **`/trust`** only explain that they do not apply.
- **Cost and context** in the footer are what the harness reports, for its current native session.

## How it fits together

```
 terminal UI ─┐                         ┌─ claude-agent-acp ── Claude Code
 --print      ├─ Pid0Session ── ACP ────┼─ codex-acp ───────── Codex
 --mode json  │   (session.ts) (stdio)  ├─ agy acp ─────────── Antigravity
 --mode rpc  ─┘        │                └─ pi-acp ──────────── pi
                       ▼
        pi-durable Harness on SQLite, one file per session
        entries: pid0.user · pid0.assistant · pid0.tool · pid0.plan · pid0.shell · pid0.turn · pid0.switch · pi.reset
        docs:    pid0.session (id, folder, name, active branch) · pid0.natives (per branch: each harness's
                 native session id, model, thinking, mode, and the last entry it has been told about)
```

- `src/acp.ts`: one harness process as an ACP client connection (the official `@agentclientprotocol/sdk`): sessions, prompts, cancel, model/thinking/mode, and the client side the agent calls back into (file reads and writes, terminals, permission requests).
- `src/harnesses.ts`: the four harnesses and how each is started; settings can add more.
- `src/store.ts`: the pi-durable store: entries, documents, branches (forks), copies, listing, and a lock so two pid0s do not write one session.
- `src/session.ts`: the engine all modes share. Before a prompt it resumes the harness's native session when the harness can (`session/resume`, else `session/load`), otherwise starts one and puts the part of the conversation that harness has not seen in front of the prompt (`src/narrate.ts`, about 60k characters, newest kept).
- `src/modes/`: `interactive.ts` (pi's components on `@earendil-works/pi-tui`), `print.ts` (text and JSON), `rpc.ts`.
- `src/resources.ts`, `src/pi.ts`: pi's settings, prompt templates, skills, themes and keybindings, loaded through `@earendil-works/pi-coding-agent` 1.5.0. Some of pi's modules (theme, keybindings, chat viewport) are not part of its public exports and are imported by file path, which is why the pi packages are pinned to 1.5.0.

User and assistant entries also carry pi-ai messages in the entry's `model` field, so `conversation.context()` gives a pi-readable transcript of the session.

## Tests

```sh
npm test          # the engine, the CLI and the terminal UI against a scripted ACP agent (test/fake-agent.ts)
npm run typecheck
```

Run by hand on 2026-11-26 with the real Claude Code adapter (`@agentclientprotocol/claude-agent-acp` 0.113.0): model list, one turn with a file read, and a continued turn in JSON mode. Codex, pi and Antigravity were not run live: their commands and model mechanisms come from reading the adapters' sources (`@agentclientprotocol/codex-acp` 2.12.1, `pi-acp` 0.0.35, `antigravity-acp` 1.2.0) and, for the native `agy acp`, from its documentation.

## Not done yet

- **Rewinding a harness.** Claude Code and Codex advertise `session/fork` over ACP; pid0 does not use it yet, so branches always start a fresh native session.
- **Showing images** that tools return. Pasting an image from the clipboard works.
- **Terminal output while a command runs.** Claude Code sends it in tool-call `_meta`, which pid0 does not read; the output appears when the tool finishes.
- **pi extensions.** Their commands and UI could be hosted; their tools could only reach a harness as an MCP server.
