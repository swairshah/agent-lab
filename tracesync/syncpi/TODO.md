# TODO

Larger pieces of work for syncpi, with the design thinking so far. Smaller items and the Delta parity list are in
`docs/delta-features.md` (section 7).

## 1. Let the agent run apps on the VM and hand out URLs

**Goal.** The agent on the session VM can start an app (a dev server, an API, a demo), keep it running, and give
people a URL to open it. Since everyone signs in with exe.dev, these URLs can sit behind exe.dev's login instead of
being public.

**What exe.dev gives us.** The VM's port 8000 is served at `https://<vm>.exe.xyz/` and is this session's server
(`provision.ts` runs `exe share port <vm> 8000` and `share set-public`). exe.dev also proxies other ports at
`https://<vm>.exe.xyz:<port>/` for signed-in users (we used this for moonlet "portals"). To verify: which port range,
whether the login is per VM owner or per exe.dev user, and how to make one port public.

**Tools for the agent on the VM.**

| Tool | What it does |
|---|---|
| `service_start` | Starts a named, supervised process (`name`, `command`, `port`, `cwd`, `env`). Logs go to `.syncpi/services/<name>.log`. Returns the URL. Refuses port 8000. |
| `service_list` | Running services: name, command, port, URL, status, uptime. |
| `service_logs` | The last lines of a service's log. |
| `service_restart`, `service_stop` | What they say. |
| `port_url` | The URL for a port someone started by hand. |
| `preview_screenshot` | Opens a URL in headless Chrome and returns a screenshot, so the agent can see what it built. The image also becomes an artifact. |

Services are declared in `.syncpi/services.yaml`, so they come back after the VM restarts. The supervisor is the
session server, or one systemd user unit per service.

**In the apps.** A Services panel (web and desktop) lists services with their URL, status and logs, plus restart and
stop. A chip in the status bar shows how many are running. "Open" opens the URL in a browser, or in a preview pane
inside the app. A service URL in a reply becomes a link card.

**Safety.** Only admins can make a port public, and the agent has to ask first. URLs behind the exe.dev login are
the default.

**Open questions.**
- Services per session, or per VM? Several sessions share the host VM, so names and ports must not clash.
- Does a service survive the end of the run that started it? Yes, until stopped. Stop it when the session is removed.

## 2. Remote tools that local agents can call

**Problem.** A request from someone's terminal runs its tools on their own machine (`src/server/devices.ts`). Some
tools only make sense on the VM: the services and ports above, previews, VM-only toolchains and secrets. And agents
outside syncpi (plain pi, Claude Code, Codex on the laptop) can't reach the VM at all.

**Inside syncpi: route tools by where they belong.** Give each tool a home: `requester` (today's default: file and
shell tools run where the request came from) or `vm` (services, previews, VM resources). The per-tool-call env
callback in pi-durable already picks the machine; it picks the VM for `vm` tools whoever asked. The tool list
shown to the model says where each tool runs.

**Outside syncpi: expose VM tools to local agents.**
- An MCP endpoint on the session server (`/<id>/mcp`), authenticated with the member's token. Any MCP client can use
  it: Claude Code, Codex, pi with an MCP extension.
- A pi extension (`syncpi-remote`) that registers the same tools in a local pi session, for people who use pi
  directly.
- Tools to offer: `vm_exec` (run a command on the VM), the `service_*` tools, `preview_screenshot`, and file read
  and write in the VM's copy.
- Permissions follow session roles: viewers get nothing, editors get everything except making ports public, admins
  get everything. Each call is logged in the thread as a notice ("Ada's Claude Code ran `npm test` on the VM").

**Open question.** Should a local agent's calls show up in the shared thread like the syncpi agent's? Probably as
one line each, so people know what happened on the shared machine.

## 3. Tags on the session's history, and views built from them

**Goal.** Mark points in a session's history and build views on top of those marks. Example: "the web page as it
looked at each step", a filmstrip of screenshots of the app across the session, each linked to the moment in the
thread that produced it.

**Tags.** A tag is a mark on a pi-durable entry:

```
{ id, conversation, entry, label, kind, data, author, at }
```

- Stored as custom pi-durable entries (`appendEntry` with a typed entry), so they're part of the history, survive
  restarts, and follow forks and branches like everything else.
- Who adds them: people (a "tag this moment" action on any message), the agent (a `tag` tool: "login works now"),
  and syncpi itself (automatic tags on edits, test runs, deploys, service starts).
- What a tag can carry: a git snapshot of the project (`git stash create`, or a commit on a hidden ref), a screenshot
  of a service URL, test results, or the artifacts from that turn.

**Views.** A view is a query over tags plus a way to draw them.
- Built in:
  - a timeline of all tags;
  - the page over time: screenshots of a URL, as a filmstrip with a slider and side-by-side comparison;
  - files over time: the diff between two tags;
  - test status over time;
  - cost and tokens over time.
- Custom: a view spec in `.syncpi/views/<name>.json` (which tags, which fields, which layout), or an HTML artifact
  that reads `/api/tags`. People can ask the agent to make a view ("show me how the landing page changed").
- From any tag: jump to that point in the thread, open the project as it was then, or fork the conversation from
  there. pi-durable forks at an entry; the git snapshot restores the files.

**In the apps.** A rail beside the thread marks tags, as Delta's message rail does. Views open in the side panel. The
terminal UI gets `/tags` and `/view <name>`, with screenshots opened in the browser.

**Open questions.**
- Screenshots on a schedule, at every turn that touched the app, or only when asked? Probably "after each turn that
  edited files while a service is running", plus on demand.
- Where screenshots live: `.syncpi/snapshots/` on the VM (not synced) with a file API, or as attachments in pi-durable.
- How much history to keep, and pruning.

## Smaller items in flight

- Diagram viewer (Preview and Source tabs, pan and zoom, recenter, copy): built for web and desktop, still to verify
  and commit.
- Provisioning copies huge files (a 16 GB `model.safetensors` stalled `finetune`): skip big and ignored files in
  `projectTar`, and give the copy a timeout and a cancel.
- Desktop settings (⌘,), KaTeX math, clickable file paths, skills in the `/` menu, @people and @threads, a context
  ring, a diff base switcher: see `docs/delta-features.md`.
