# Productionization: sessions in sandboxes, syncpi as a service

Not started. This is the plan for when the product's shape has settled: every session runs in its own sandbox
(E2B, Modal, or a stop-on-idle microVM), syncpi.exe.xyz becomes the control plane (accounts, the session registry,
routing, the model proxy), and the service opens to other people.

What it's for:

1. **Isolation.** Each session in its own sandbox, not one shared host for every session.
2. **Scale.** As many sessions as people start, not the 50 VMs exe.dev allows.
3. **A service.** Other people can sign up. syncpi.exe.xyz only manages users and routes to sandboxes; coordination,
   file sync and the agent run in each session's sandbox.

The estimates below are for working as we have been: an agent writing the code, a person reviewing and directing.

## What carries over unchanged

The session server is already self-contained. One Node process holds a session:

- the thread (pi-durable on SQLite);
- file sync over HTTP and the WebSocket;
- the device tunnel that runs a person's requests on their own machine;
- presence, drafts, side threads, and comments on graphics.

It needs Node, git, the project folder, a writable disk and one port. None of it knows about exe.dev, and the
clients (terminal, web view, desktop app, pi extension) only need a URL and a token. Moving a session into a sandbox
changes where it runs, not what it is.

Running tools on a person's machine also works as it does now. The connection becomes client → router → sandbox
instead of client → exe.dev's proxy → VM. The router has to pass WebSockets through without cutting long-lived
connections. Clients already ping every 30 seconds and reconnect on their own.

## What is tied to exe.dev, and what replaces it

| Piece | Now (exe.dev) | Then | Effort |
|---|---|---|---|
| **Creating sessions** (`src/cli/provision.ts`) | SSH into a VM, copy the project with tar, run the server under systemd; `syncpi update` over SSH | A provider interface (create, start, stop, upload, URL) with E2B or Modal behind it; a sandbox image with Node, git, Playwright and Chromium | 3–5 days |
| **Waking and sleeping** | VMs stay up; the shared host closes idle sessions in memory | A sandbox stops when its session is idle (see below) and is woken when someone comes back | 2–3 days |
| **Routing and HTTPS** | `https://<vm>.exe.xyz`, through exe.dev's proxy | A router at syncpi.exe.xyz: session id → its sandbox; wakes it; proxies HTTP and WebSocket traffic. Sandbox URLs are public and change when a sandbox restarts, so clients don't use them directly | 3–5 days |
| **Keeping state** | The VM's disk | The sandbox's own pause/resume (E2B), a volume (Modal), or `session.sqlite` and the project copied to object storage on stop. pi-durable already resumes runs after a restart | 2–4 days |
| **Models** | exe.dev's LLM gateway (`llm.int.exe.xyz`); no keys on the VM | A model proxy in the control plane, holding provider keys or people's own; each sandbox gets a short-lived token for its session only | 3–5 days; 1–2 weeks with limits |
| **Identity** | "Login with exe" headers (9 places in the server); email invites checked against them | Accounts in the control plane (Google or GitHub sign-in, or email links); signed tokens from it, checked by the server in place of the exe headers. Member tokens and roles inside a session stay as they are | 1–2 weeks |
| **CLI, app, pi extension** | Creating a session runs SSH from the person's Mac (needs an exe.dev account and SSH keys) | They call the control plane's "create session" API; nobody needs exe.dev | 2–3 days |
| **VM tools** (`remote_bash`, `record_browser`, the setup agent) | A persistent VM: what the setup agent installs stays | Pause/resume or a volume keeps installs; without one, every wake starts from the image, so common toolchains go into it | 1–3 days |
| **The inbox** (desktop app) | The app keeps a connection to every thread, for mentions | Mentions worked out where messages arrive and kept in the control plane; the app asks it | 1–2 days |

## Who pays for what

- **People pay for their models**, for example with their own API keys. The keys stay with the model proxy, never in
  a sandbox, as today no key is copied to a VM.
- **The service pays for sandbox time.** Tools that run on a person's own machine cost it nothing.

This makes the model proxy the main control on cost and abuse, and sandbox hours the main bill. So when a sandbox
may stop matters more than anything else in the design.

## Idle: when a sandbox stops

Today a session is idle when nobody is connected, nothing is running, and it has been quiet for 15 minutes
(`Room.idle`). On exe.dev that only closes it in memory, so it costs nothing either way. With sandboxes:

- **Connections can't keep a sandbox up.** The desktop app connects to every thread its person has, in the
  background, for the inbox. With the rule as it is, every session of everyone with the app open would never stop.
- **Idle means no activity:** no run going, no messages, no typing, comments or marks for N minutes. Then the sandbox
  stops even with clients connected. Their connections drop, they reconnect through the router, and the router wakes
  the sandbox only when someone does something in it.
- **The inbox moves off live connections** (the table above).
- **An open thread with nothing happening sleeps.** The page shows it's asleep and wakes it on the next message.
  With E2B's resume that takes about a second.
- **A run in progress keeps it up**, including one whose tools run on someone's machine.

This is about 2–4 days on top of the table: half for the activity rule and waking, half for the inbox.

## Phases

1. **Sandboxes for one person (1–2 weeks).**
   - The provider interface and one provider.
   - The router that wakes sandboxes; state that survives stopping; the activity-based idle rule.
   - A model proxy using the owner's keys.
   - The CLI and app creating sessions through the control plane.

   Isolation per session and no 50-VM cap, with exe.dev still handling sign-in.
2. **The control plane, for other people (2–3 weeks).**
   - Accounts, and a registry of sessions with their sandboxes.
   - Invites without exe login; signed tokens for sandboxes.
   - Per-person usage limits in the model proxy; people's own keys.
   - The inbox from the control plane.
3. **A public service (2–3 weeks).**
   - Quotas and limits on sandbox hours; billing, if the service charges for compute.
   - Abuse handling: the agents run arbitrary code.
   - Deleting accounts and data; backups; monitoring.
   - Image updates in place of `syncpi update`.

About 6–8 weeks to a public service; the first phase alone gives a working version for one person.

## Choosing the sandbox

- **E2B fits best.** Pausing keeps the whole sandbox, files and running processes, so a session wakes as it was
  rather than restarting. Each port gets an HTTPS URL, which should carry WebSockets. Images build from a Dockerfile.
- **Modal suits heavier compute.** Its sandboxes have lifetime caps, and keeping state needs volumes or snapshots,
  some of it in beta.
- **A stop-on-idle microVM (Fly Machines or similar)** is the cheaper middle option. The provider's own proxy
  stops a machine when idle and starts it on the next request, with a disk attached. That removes most of the
  router and wake-up work (about a week) and keeps VM-level isolation, with less of a ready-made sandbox SDK.

Check before choosing, since these change often:

- maximum sandbox lifetime, and how long a paused sandbox is kept;
- how many sandboxes can run at once, per account;
- WebSockets on public URLs, and their idle timeouts;
- resume time, and pricing while paused.

## Decisions to make first

- **Whose model keys.** People's own (simplest, no billing for models) or the service's (needs metering and billing).
- **Sign-in.** Which providers; whether exe.dev sign-in stays as one of them.
- **Where a session's files live when it sleeps.** The provider's pause, a volume, or object storage: this decides
  wake time and what a person's data costs to keep.
- **Limits.** Sandbox hours per person, concurrent sessions, how long an untouched session is kept before it's
  deleted.
