# session-share

One pi-durable session that Claude Code, Codex and pi all work in, taking turns in the same folder. It is a prototype of the delta-claude pattern, moved onto pi-durable.

- Each agent keeps its own native history. Claude Code resumes its own transcript, Codex resumes its own thread, and pi runs on the shared conversation itself.
- Every native message is recorded into one pi-durable conversation as a `share.message` entry. The entry holds the message in pi-ai's shape, the agent, session and person it came from, and the raw native message.
- Before an agent takes a turn, it is told what the others did since it last worked. Claude Code gets this through a `UserPromptSubmit` hook. Codex gets it before its prompt. pi gets it as the entries' model messages. Thinking is never passed on.
- One agent holds the turn at a time (the `share.lease` document). A second agent is refused until the first finishes, or until 10 minutes pass without a heartbeat.
- `checkpoint <label>` tags the session at an entry. It also stores the files as they are, as a git commit under `refs/session-share/checkpoints/`. The checkout's index and HEAD are not touched.
- `fork <label>` goes back to a checkpoint. A pi-durable fork at the checkpoint becomes the active conversation, and the files are put back as they were. What was there before is tagged first (`before going back to <label>`), so it can be gone back to the same way. pi's history is the conversation, so pi goes back with it. A Claude Code or Codex session can't be rewound, so the native sessions of every branch are retired in the fork: they are refused with a message, and new ones are told everything up to the checkpoint.

## Use

```sh
npm install
alias session-share="$PWD/bin/session-share.mjs"

cd some/project
session-share claude                      # Claude Code with this session's hooks (this run only, via --settings)
session-share codex "fix the failing test" # one Codex turn: codex exec --json, resuming this session's thread
session-share pi "review what they did"    # one pi turn on the shared conversation (pi's default model and logins)
session-share log                          # the whole session as text
session-share view                         # URL of a live web view
session-share checkpoint "tests green"
session-share checkpoints
session-share fork "tests green"           # back to that checkpoint: the session and the files
session-share branches
session-share status | stop
```

`SESSION_SHARE_MEMBER` sets your name; the default is git's `user.name`. The session lives in `<project>/.session-share/`. That folder holds `session.sqlite`, `branches.json` (the forks, and which one is active), the daemon's `server.json` and logs. It is added to `.git/info/exclude`.

## How it fits together

```
claude ──hooks──┐                                 ┌── view.html (polls /items)
codex exec ─────┼── HTTP (token) ── daemon ───────┤
session-share pi┘                    │            └── session-share log
                                     ▼
                     pi-durable Harness (SQLite), root conversation
                     share.message · share.prompt · pi.assistant · pi.tool-result
                     share.turn · share.checkpoint · share.fork · docs: share.lease, share.sessions
```

- `src/claude.ts` and `src/codex.ts` turn a transcript line into normalized messages. They skip each agent's own framing: system reminders, environment context, meta rows and subagent rows.
- `src/store.ts` reads transcripts from the offset it last stopped at. Writes are keyed by native id, so reading a transcript twice records nothing twice. The store also holds the lease and the cursor for each native session: the last entry that session was told about.
- `src/narrate.ts` writes the text an agent is given about the others. It is about 60k characters, newest first, with a note when older items are left out.
- `src/server.ts` is the one process that owns the storage. pi-durable allows one process per storage.

## Tests

```sh
npm test          # parsers, narration, and the whole loop with faux pi and a stand-in codex
npm run typecheck
```

On 2026-10-28 it was also run by hand with the real agents (Claude Code with Haiku, Codex, and pi with gpt-5.6-sol), in that order, in one folder. Each agent described the earlier agents' work correctly from the narration alone. `fork` was then run on that session. The files went back to the checkpoint, the newer ones were kept under the saved ref, and a pi turn with the real model saw the session only up to the checkpoint.

## Not done yet

- **Interactive Codex.** Only `codex exec` turns are supported. Codex hooks need a trust approval in `~/.codex/config.toml`, so they are left alone.
- **Rebuilding native transcripts.** A native transcript is never rebuilt from the shared session. A Claude or Codex session that started elsewhere sees the others' work only as narration.
- **Resuming a native session in a fork.** Claude Code and Codex sessions from before a fork are retired rather than rewound; that needs the native transcript rebuild above.
- **Live context.** An agent is told what the others did only when its turn starts, not during it.
