# frontdesk

A swappable "frontdesk" model in front of one durable [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
session. Long work is delegated to background workers running stronger models.

| | Frontend | Model |
|---|---|---|
| `npm run cli` | text, in the terminal | `openai/gpt-5.6-luna` (pi-durable runs it) |
| `npm run web` | voice, in the browser (mic) | `gpt-realtime-2.1` over WebRTC, with a server-side sideband |
| [`ios/`](ios/README.md) | voice, one-button iOS app (client of `npm run web`) | same as the web page |
| workers | background pi-durable conversations | `anthropic/claude-opus-5-5` ("opus", default) or `openai/gpt-5.6-sol` ("sol") |

Both frontends read and write the same root conversation in one SQLite file (`.data/session.sqlite`). Both use the
same `delegate()` function. Both serve the session inspector on `http://localhost:4318`. Only one frontend runs at a
time, because pi-durable storage has a single owner.

## Run

```bash
npm install
export OPENAI_API_KEY=...      # luna, sol, realtime
export ANTHROPIC_API_KEY=...   # opus
npm run cli                    # text frontdesk + inspector at http://localhost:4318
npm run web                    # opens http://localhost:4318: "Start voice" + inspector
npm run inspect                # inspector only, no frontend
```

No keys? `FRONTDESK_FAUX=1 npm run cli` runs every model as a scripted faux model, so you can watch the
delegation flow and the inspector. `npm run smoke` runs the end-to-end check in faux mode: text delegation, voice
delegation, voice event bridging, the realtime seed, and handing a voice session back to text.

| Env | Default |
|---|---|
| `FRONTDESK_DB` | `.data/session.sqlite` |
| `FRONTDESK_WORKSPACE` | current directory (workers' `cwd`) |
| `FRONTDESK_PORT` | `4318` |
| `FRONTDESK_HOST` | `127.0.0.1`; set e.g. `0.0.0.0` for the iOS app on your LAN (requires a token) |
| `FRONTDESK_TOKEN` | unset; when set, every request needs `Authorization: Bearer <token>` (browser: open `/?token=<token>` once) |
| `FRONTDESK_TEXT_MODEL` / `FRONTDESK_VOICE_MODEL` | `gpt-5.6-luna` / `gpt-realtime-2.1` |
| `FRONTDESK_OPUS_MODEL` / `FRONTDESK_SOL_MODEL` | `claude-opus-5-5` / `gpt-5.6-sol` |
| `FRONTDESK_DEFAULT_WORKER` | `opus` |
| `FRONTDESK_VOICE`, `FRONTDESK_TRANSCRIBE_MODEL` | `marin`, `gpt-4o-mini-transcribe` |
| `FRONTDESK_NO_OPEN=1` | don't open a browser on `npm run web` |

## Why not GPT-Live (`gpt-live-1`) for voice

GPT-Live has two delegation modes:

- **`delegation: { type: "responses" }`**: OpenAI runs the backend model inside the Live session. You pick a Responses
  model, its instructions and function/web-search tools, and `response.event` streams back. The backend is
  OpenAI-hosted and Responses-only, so Claude Opus can't be the backend. Its conversation lives in the Live session,
  not in pi-durable, so durability, inspection and resume are lost. This doesn't fit.
- **`delegation: { type: "client" }`**: your app handles the work, which is the control we want. But
  `session.delegation.created` carries only `{ id, target }`: *"This object contains metadata, not the task text."*
  The Live model never writes a task brief. Your app has to rebuild "what was asked" from transcript deltas, which
  have no turn boundaries. Results go back only as `session.commentary.append` / `session.thinking.append`, at most
  500 tokens per append. The model has no `action`/`name`/`worker` arguments to fill in, and no way to message,
  stop or query a specific worker. Integrations report that overlapping delegations end up sharing one transcript
  buffer.
- Other limits: frontend instructions are immutable after start, the delegation type can't change mid-session, and
  startup history is capped at 128 text messages / 8,192 tokens.

So GPT-Live keeps the *orchestration* on OpenAI's side. Client mode gives you an opaque "please do something now"
signal, not a structured delegation. The text frontdesk delegates with a typed tool call
(`delegate({action, name, task, worker})`), and GPT-Live client mode can't express the same call.

**gpt-realtime-2.1** fits: it supports function tools, so the voice model calls the exact same `delegate` schema with
an explicit brief. Our server runs it through the same `delegate()` function as the text frontdesk.

## How it fits together

```
          npm run cli                                   npm run web
  ┌───────────────────────┐                ┌────────────────────────────────────┐
  │ gpt-5.6-luna          │                │ browser ⇄ WebRTC ⇄ gpt-realtime-2.1│
  │ (pi-durable generation│                │          sideband WS ⇅ VoiceBridge │
  │  on the root conv.)   │                │ (transcripts → entries, tool calls │
  │ tool: delegate ───────┼──┐          ┌──┼── → delegate(), reports → speech) │
  └───────────────────────┘  │          │  └────────────────────────────────────┘
                             ▼          ▼
                 ┌──────────────────────────────────────────┐
                 │ pi-durable Harness · SQLite (.data/...)  │
                 │ root conversation (shared transcript)    │
                 │  app.workers doc: name → worker conv     │
                 │  background Anchor + Reporter tasks      │
                 │ worker conversations: opus / sol         │
                 │  CodingTools (read/write/edit/bash)      │
                 │  + fetch_url                             │
                 └──────────────────────────────────────────┘
                                   ▲
                        inspector (SSE): http://localhost:4318
```

- **`src/delegation.ts`**: the delegation layer (pi-durable's background-subagent pattern). `delegate()` starts a
  worker conversation owned by a background anchor task, configures its model, tools, instructions and `cwd`, and
  creates a durable Reporter task that sends the brief and waits for the answer. The text frontdesk calls it as a
  pi-durable tool. The voice bridge calls it directly through the Harness. Same code, same state.
- **Reports**: when a worker answers, the Reporter routes the result by the active frontend:
  - text: the result is submitted to the root as a follow-up input, and luna relays it.
  - voice: the result is written to the root as an `app.report` entry. The bridge injects it into the realtime call
    as a system message and asks for a spoken response. A report that arrives mid-utterance is queued until the
    response ends.
- **Voice in the shared transcript** (`src/voice.ts`): user transcripts, spoken replies, the realtime model's tool
  calls and their results are written into the root as `app.voice-*` entries, with real pi-ai `user` / `assistant` /
  `toolResult` messages. When you go back to `npm run cli`, luna sees the voice conversation as normal history.
  Tool-call IDs are normalized by pi-ai. When a call starts, the bridge seeds the realtime session with the last 40
  messages of the root, so voice continues where text left off.
- **Durability**: every worker turn, tool call and report is a pi-durable commit. Kill the process mid-task, restart
  either frontend, and `harness.resume()` picks up unfinished workers and reporters. Request IDs prevent double
  delivery. The realtime call itself is not durable; restarting `npm run web` needs a new "Start voice".
- **Inspector** (`src/inspector.ts`, `public/`): lists the root and every worker conversation. It live-streams
  `conversation.viewState()` (entries plus `pi.live` partials, tool output, agent doc) and `harness.taskGraph()` over
  SSE, and shows usage per model.

## Delegate tool

```
delegate({ action: "start",   name, task, worker?: "opus" | "sol" })
delegate({ action: "message", name, task, followUp? })   // steer (default) or queue after the current answer
delegate({ action: "stop",    name })
delegate({ action: "status",  name? })
delegate({ action: "result",  name })                    // the worker's latest full answer
```

The CLI also has `/status`, `/stop <worker>`, `/abort` (stops the frontdesk's current run; workers keep going) and
`/quit`.

## Backlog

- **Phone frontend (Twilio).** Answering calls: a Twilio Elastic SIP trunk sends calls to OpenAI's SIP endpoint;
  `realtime.call.incoming` webhook → `calls.accept(call_id, sessionConfig())` → `OpenAIRealtimeWS({ callID })` →
  `bridge.attach()`. Calling out: Twilio's voice API dials and bridges the call to the same SIP endpoint. Needs a caller
  allowlist, a public HTTPS webhook URL and, for third-party calls, a dedicated "caller" worker. No 10DLC needed
  (SMS only).
- **Single `serve` process** with a frontend lease, so the CLI, web page, iOS app and phone can share one running
  session at the same time.
- **iOS:** push notifications for worker reports when no call is live, and a text mode.

## Notes

- pi-durable is experimental (1.1.0 here); its API changes between releases.
- Workers have `bash`/`write`/`edit` in `FRONTDESK_WORKSPACE` with no approval gate. Add a `beforeTool` hook in
  `src/harness.ts` if you want one.
- Running `npm run cli` and `npm run web` at the same time on one DB is not supported (no cross-process locking).
  Use different `FRONTDESK_DB`/`FRONTDESK_PORT` values for separate sessions.
