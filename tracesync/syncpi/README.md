# syncpi

A multiplayer pi session. Run `syncpi` in a project folder and you get:

- **A session on a shared exe.dev VM.** Every session lives on one host VM, `syncpi.exe.xyz`, at `https://syncpi.exe.xyz/<id>/`. That keeps you within exe.dev's VM limit. The first session creates the VM and installs the server. After that, starting a session copies the project to its own directory there, which takes a few seconds. `--vm <name>` puts a session on another VM instead, which is created if it doesn't exist. The session opens immediately, setup runs in the background with progress in the status line, and messages typed meanwhile are sent once it's up. The pi-durable agent keeps running when your laptop is closed.
- **A background setup agent.** While you start talking, a second agent installs the project's toolchains and dependencies, runs the build and tests once, and writes `.syncpi/ENVIRONMENT.md`. The main agent reads those notes. You can watch the setup agent with `/env` (terminal) or the "Setup agent" tab (web). It is not part of the shared thread.
- **The same thread in the terminal and the browser.** `/web` opens the thread in a browser. Both views update live.
- **Sharing.** `/session-share` makes a link. Someone can open it in a browser, or run `syncpi --url <link>`. With `--url`, the project is downloaded into `~/.syncpi/projects/<name>` and kept in sync both ways. Everyone talks to the same agent, and each message shows who sent it.

```bash
npm install && npm run build && npm link   # puts `syncpi` on your PATH

cd ~/code/my-project
syncpi                       # start (or rejoin) this folder's session
syncpi --url https://syncpi-my-project-ab12.exe.xyz/s/<code>   # join someone's session
syncpi ls                    # sessions on this machine
syncpi rm my-project         # forget a session; deletes the VM if you own it
syncpi update                # after rebuilding, push the new server to the host (starting a session also does)
```

## Your pi setup

syncpi's agent is not pi, but it uses your pi setup the way pi would. When you start or join a session from a terminal, syncpi loads your pi resources for that folder with pi's own loaders (`createAgentSessionServices`). That loading runs in a separate process, because it runs your extensions' code.

- **Skills and AGENTS.md:** your skills, and the AGENTS.md / CLAUDE.md files pi would read there (your global `~/.pi/agent/AGENTS.md` included), go into the agent's instructions while one of your requests runs. Skill files stay on your machine; the agent reads them there, because that's where your requests run. Requests from a browser run on the VM and get the project's own AGENTS.md / CLAUDE.md. Each person's setup applies only to their own requests.
- **Prompt templates:** `/name args` expands before sending, with `$1`…`$n`, `$@` and `$ARGUMENTS`, as in pi. The templates show up in `/` completion.
- **Models in `--local` sessions:** exactly the models your pi has, including providers your extensions add and your subscription logins. Sessions on the host use the exe.dev LLM integration instead.
- `--no-pi` turns all of this off.

Not yet: tools from your pi extensions (planned to run on your machine for your requests).

## Context: /compact, /new, /tree

- The agent summarizes older messages on its own before its context fills up (pi-durable's automatic compaction, in the background). The status line shows "summarizing older messages…" while it runs.
- `/compact [instructions]` (editors) summarizes now.
- `/new` (admins) starts a new context. Earlier messages stay in the thread, but the agent no longer sees them.
- `/tree` lists the messages and the thread's branches. `/tree <n>` (admins) branches just before message *n* and puts that message back in your editor, to edit and resend, as in pi. `/tree b<k>` switches back to another branch. A branch switch moves everyone, since there is one shared thread; the header shows which branch you are on.
- People always see the whole thread, including what came before a `/new` or a summary. A client that connects gets the current context plus up to 500 earlier entries.

## Where the agent's tools run

On the machine of whoever asked. A message you send from your terminal runs its tools on your computer, in your copy of the project, with your toolchains (Xcode, simulators, local databases). A message from Bob's terminal runs on Bob's computer. A message from a browser runs on the session VM. The changes sync to everyone either way. `/where vm` (or `/where here`) switches where your messages run.

- A run stays on the machine of the person who started it. Steers from someone else become follow-ups, so nobody can direct commands onto another person's machine.
- When the next run is on a different machine, the copies are brought in step first. Every connected client pushes its local changes, the server rescans, and the new machine pulls everything up to that point.
- If the sender's machine is offline, the run waits up to a minute for it, then its tool calls fail with a message saying so.
- The agent loop, the transcript and the model calls stay on the VM. Only file operations and commands travel. They use pi-env's daemon on your machine, reached through your client's WebSocket (`src/server/devices.ts`, `src/server/relay.ts`, `src/cli/device.ts`).

Inside the terminal UI: Enter sends a message (queued while the agent is busy). Esc stops the agent. The commands are `/session-share`, `/invite`, `/members`, `/web`, `/env`, `/steer <msg>`, `/stop`, `/compact`, `/new`, `/tree`, `/sync`, `/where here|vm`, `/name`, `/open`, `/ssh`, and `/quit`. Leaving does not stop the session.

## Models

No API keys are copied anywhere.

- **On a VM**, models go through the exe.dev LLM integration at `https://llm.int.exe.xyz`. That integration is attached to every VM by default. The VM's private pi `models.json` points the built-in `anthropic` and `openai` providers at it. The VM never holds a credential; exe.dev uses its gateway or whatever source the integration is set to (for example a ChatGPT subscription).
- **With `--local`**, the server uses pi's own `ModelRuntime`. That is your pi login (`~/.pi/agent/auth.json`, including OAuth subscriptions), plus `models.json`. Whatever `pi` can use, the session can use.
- **The default model** is pi's default (`defaultProvider`/`defaultModel` and the thinking level in `~/.pi/agent/settings.json`). On a VM, `openai-codex/<id>` becomes `openai/<id>` through the integration. A provider the integration doesn't serve falls back to `anthropic/claude-opus-5-5`. Override with `--model provider/id` and `--setup-model provider/id`.

`--faux` swaps in a scripted model (and implies `--local`), for testing.

## How it fits together

```
 your terminal (syncpi TUI) ─┐                   exe.dev VM  syncpi-<project>-xxxx
 your browser (/web) ────────┤  WebSocket        ┌───────────────────────────────────────────────┐
 bob: syncpi --url ──────────┼─────────────────▶ │ syncpi server (systemd, port 8000)             │
 bob's browser (/s/<code>) ──┘  + file API       │  pi-durable Harness · ~/.syncpi/session.sqlite │
                                                 │   main conversation: shared, attributed        │
 local folders ◀── two-way file sync ──────────▶ │   setup conversation: background env prep      │
 (yours: the project dir;                        │  tools run in ~/<project> (NodeExecutionEnv)   │
  bob's: ~/.syncpi/projects/<name>)              └───────────────────────────────────────────────┘
```

- `src/server/` is the session owner. It holds one pi-durable Harness with two conversations. Each client gets its own `watchEvents()` stream for each conversation. That stream gives a snapshot and then every commit, without gaps, so a reconnect always starts from a fresh snapshot. Messages are submitted with `requestId`s, so a resend after a dropped connection is not posted twice.
- `src/shared/thread.ts` turns agent events into display items. The terminal UI (`src/cli/tui.ts`, pi-tui) and the web view (`src/web/`) both render that same state.
- `src/shared/files.ts` and `src/cli/sync.ts` do file sync. Both sides hash the synced files: what git sees (tracked files, plus untracked files that are not ignored), minus `.git`, `.syncpi/` and `node_modules`. The server sends changes over the WebSocket. Clients rescan their folder every 1.5 s, and upload with compare-and-swap on the content hash. If a file changed on both sides, your local version wins and is pushed. The other side's version is saved under `~/.syncpi/conflicts/<id>/`.
- `src/server/main.ts` serves one session (`--state <dir>`, for `--local`) or a whole host (`--sessions <dir>`). On a host, each session is a `Room` (`src/server/room.ts`) under `/<id>/`, opened on first use. A room closes after 15 idle minutes, and is dropped when its directory is removed. On the host VM, session state is in `~/.syncpi-sessions/<id>/` and projects are in `~/projects/<id>/<name>/`. All sessions on one host share its Linux user, so they are not isolated from each other. That is fine for one person's sessions; use `--vm` for a session that needs its own machine.
- `src/cli/provision.ts` sets up the host and the session, in a detached `syncpi __provision <id>` process that reports each step in the session record (log: `~/.syncpi/sessions/<id>.log`). It runs `ssh exe.dev new --tag=syncpi`, makes port 8000 public, installs Node 22 if it is missing, and copies the project (with `.git`) and the bundled server. It then writes `~/.syncpi/server.json` and starts the `syncpi` unit. The VM name is chosen up front, so the session's URL is known before the VM exists.

## The web view

`/web` in the terminal, or any share link in a browser, opens the session's web view. It shows the same thread as the
terminal UI and keeps out of the way. The thread fills the page, the composer is its next row, and a status bar shows
where your requests run, the branch, activity and the model. Everything else is in settings (the gear, or ⌘,): your
name and theme, the model and context, people and invites, branches, the environment the setup agent prepared, and
session details. It follows the system's light or dark theme by default and works on phones.

- **Thread.** Each reply shows the mark of the model that wrote it (Anthropic, OpenAI, Kimi, …, from
  `@lobehub/icons-static-svg`). Thinking and tool calls are one line each until opened; edits open with their diff.

- **Artifacts.** Edits show as diffs, rendered by Pierre (`@pierre/diffs`, with Shiki highlighting) from the patch
  pi-durable's `edit` tool records. Files the agent writes show as highlighted code. HTML and SVG, whether written to
  a file or in a ```` ```html ```` / ```` ```svg ```` block in a reply, get a live preview with a Code tab. Markdown
  files render, and images load through the file API. Previews run in an iframe sandboxed without
  `allow-same-origin`, so the agent's HTML can't reach the page, its storage or your token.
- **Changes panel.** Every artifact in the thread, grouped by file with the newest change first; "Open" on any
  artifact shows it there, full size.
- **Composer.** Enter starts a new line and ⌘↩ (Ctrl+Enter) sends. Drop, paste or attach files: images go to the
  model as images (PNG, JPEG, GIF, WebP, up to 5 MB) and text files go in the message (up to 256 KB), at most 8 per
  message. `/` completes commands (the same ones as the terminal), `@` completes project files, drafts survive
  reloads, and messages typed while offline are sent once the connection is back.
- **Terminal UI.** Edits show as colored diffs. HTML, SVG, markdown and image artifacts get a number:
  `/open <n>` opens one in your browser, from your synced copy, or from `~/.syncpi/artifacts/` for a snippet in a
  reply. `/open` lists them.
- **Embedding.** An app can show the web view in a webview or an iframe by opening the session URL with
  `?embedded=1`. See `src/web/bridge.ts` for the messages: activity, the thread's title, and actions such as opening
  a terminal one way; theme, share, panel and dialogs the other.

## The desktop app

`npm run package:mac` builds `dist/SyncPi.app`. It is the web view in a native window (Tauri, `desktop/`). The app
starts its local host (`src/desktop/host.ts`), which keeps each thread's connection, syncs project files to this Mac,
runs the agent's tools here when a request runs on this machine, and serves the pages. The window shows a sidebar
of threads by project (`src/web/shell.ts`) beside the open thread, which is the same page a browser gets, loaded
through the host so the page never holds the thread's token. Recent threads stay loaded, so switching is instant.

The app adds what a browser can't do: new threads from a project folder (⌘N, ⌘O), joining a share link, terminals
on this Mac (⌃\`, or `!cmd` in the composer), the project's uncommitted git changes (⇧⌘G), revealing the project in
Finder or Zed, and text size (⌘+, ⌘−). The menu bar is built from `src/shared/keymap.json`, so menu items and
shortcuts run the same commands. The previous native (GPUI) app is at the tag `gpui-desktop-final`.

The web view's code is in `src/web/`, one module per concern (see `main.ts`). Artifact detection is shared with the
terminal UI in `src/shared/artifacts.ts`. The bundle is split, so the artifact renderers load only when an artifact
is shown; the main script is about 95 KB.

## People, roles and invites

Whoever creates a session is its admin, and can't be removed or demoted. Roles:

| | viewer | editor | admin |
|---|:-:|:-:|:-:|
| Read the thread, open the web view, get the project and its changes | ✓ | ✓ | ✓ |
| Talk to the agent, push file edits, run requests on their own machine | | ✓ | ✓ |
| Stop a run they started | | ✓ | ✓ |
| Stop anyone's run, invite, change roles, remove people, revoke invites | | | ✓ |

- `/invite ada@x.com [role]` makes a link only that person can use. They sign in with exe.dev as that email; anyone without an account can create one there with the same email. From a terminal, `syncpi --url <link>` opens the sign-in page and asks them to approve a short code it prints. Members invited by email can come back in any browser by signing in with exe.dev.
- `/invite [role] [7d|12h|never] [--uses N]` (or `/session-share`) makes a link anyone can use. Links expire after 7 days by default, email invites after 30.
- `/members`, `/role <name> <role>`, `/remove <name>`, `/links`, `/revoke <code>`. The web view's People panel has the same controls for admins.
- Anyone can change their own name with `/name <new name>` (or "Rename me" in the web view). Past messages show the new name.
- Removing someone takes effect at once. Their tokens stop working, their open terminals and tabs are disconnected with a "removed" notice, connections that run requests on their machine close, and their queued messages are withdrawn. Invites they made, and invites addressed to them, are revoked. Their messages stay in the thread, and their local copy of the project stays on their machine.
- The server stores only SHA-256 hashes of tokens, one per place someone signed in.

## Access and trust

- exe.dev's proxy reaches the server over loopback, so the server can't tell its identity headers from ones a process on the VM sends. Anyone whose requests run on the VM (editors, from a browser or with `/where vm`) could therefore impersonate an email or edit the session's files there. The trust boundary is: editors are trusted with the VM. Running VM-side agent commands as a separate, unprivileged user would remove this, and is not done yet.
- The agent runs commands on your machine only for requests you sent from your terminal. Those commands run with your user's permissions, as `pi` would. Files in your copy can be edited by collaborators' requests through sync, so review what the agent runs on a codebase others are changing.
- No model credentials are on the VM. Anyone in the session does spend your exe.dev LLM allocation (or the subscription the integration uses) through the agent. In a `--local` session the agent runs on your machine with your pi login, so share those only with people you would hand your laptop to.
- Only the owner has SSH access to the VM. Ports other than 8000 are only reachable by the owner's exe.dev login.

## Tests

```bash
npm run typecheck
npm run smoke      # local server + scripted model: owner and collaborator, chat, sharing, two-way sync, rejoin
```

Verified on 2026-10-27:
- On a real exe.dev VM with Claude Opus 5.5, a collaborator joined with `--url` and asked the agent to fix a failing test. The fix reached both local folders, and the web view showed the same thread live. Creating the VM and starting the server took about a minute.
- After the auth change, a VM session ran `openai/gpt-5.6-sol` through the exe.dev integration. The server process had no API keys, and the setup agent finished.
- A VM session ran a request from this Mac's terminal on the Mac (`sw_vers`, an edit, `npm test`), tunneled through the VM. The edit reached the VM's copy.
- A `--local` session ran pi's default `openai-codex/gpt-5.6-sol` on the pi OAuth login. Messages typed before the server was up were delivered once it was.

## Not done yet

- Real merging. Conflicts keep both versions, but there is no 3-way merge.
- Syncing git state. Commits the agent makes stay on the VM; only working-tree files sync.
- Live terminals or previews of servers on the VM, for collaborators.
- Build outputs and dependencies are per machine. A request that runs on your Mac after one ran on the VM rebuilds locally.
