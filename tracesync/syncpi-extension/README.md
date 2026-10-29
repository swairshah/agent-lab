# syncpi-extension

`/sync` in pi makes the pi session a [syncpi](../syncpi) session. Others join it from syncpi's web view, its app or its terminal, and take turns with you. Your pi keeps running your turns, with your model, tools, extensions and modes.

```sh
npm install                      # needs ../syncpi built (npm run build there)
pi -e ./src/index.ts             # or: pi install ./  (then it loads in every pi session)
```

In pi:

| Command | What it does |
|---|---|
| `/sync` | Starts a syncpi session for this folder (or rejoins it), with what this pi session had so far. Options: `--local` (a server on this machine instead of the exe.dev host), `--vm <name>`, `--model provider/id` (the server agent's model), `--name <you>` |
| `/session-share` | A link for others to join, as editors, for 7 days |
| `/invite name@example.com` | An invite only that person can use (they sign in with exe.dev) |
| `/sync status` | The session's URL, and your own link to its web view |
| `/sync stop` | Stops syncing. The session keeps the whole shared conversation and carries on locally |

A session that was synced when it was last open syncs again when you resume it.

## How it works

The syncpi session's thread (a pi-durable conversation on the syncpi server) and this pi session hold the same conversation.

- **Your turns run in pi.** Each message pi adds to the session (yours, its answers, its tool results) is recorded into the thread as soon as pi saves it. While pi runs, its partial answer and running tools go to everyone watching. Tools only your pi has show in the thread like any other.
- **Other people's turns run on the syncpi server's agent.** That agent sees your turns as its own history: your messages, pi's answers, the tool calls and their results. Their turns come back into this session as `syncpi` messages, which show in the transcript. Before every model call the extension swaps them for the messages they stand for (pi's `context` hook), so your model sees a collaborator's message as a user message and the server's answer as an assistant message.
- **One agent works at a time.** Before pi runs, the extension asks the server for the turn. If the server's agent is running, it is stopped when you may stop it (your own run, or anyone's if you're an admin); otherwise pi waits for it to finish. While pi has the turn:
  - other people's messages wait for it to end;
  - `/steer` reaches pi's run at its next step, and is recorded as theirs;
  - an admin's message (or one of yours from another client) stops pi's run.
- **Files** are kept in sync with the session's copy, and this machine is your device for requests you send from syncpi's other clients, as with syncpi's own terminal client.

The extension uses syncpi through its `syncpi/client` export. The server side is `src/server/pi-turns.ts` and the `record`, `turn` and `live` messages in syncpi's protocol.

## Tests

```sh
npm test    # builds ../syncpi, then runs test/sync.ts
```

`test/sync.ts` runs a real pi in RPC mode with this extension and a scripted model (`test/faux-pi.ts`, which also adds two tools only that pi has), against a local syncpi server with its own scripted model. A collaborator joins over the protocol. Nine checks:

1. `/sync` shares what the pi session had.
2. A pi turn with its own tool reaches the thread in order.
3. The server's agent sees that turn as real messages.
4. pi's model sees the collaborator's turn as a user message and an answer.
5. A collaborator watches pi's tool run live and steers it.
6. An editor's message waits for pi's turn.
7. The owner stops their pi's run from another client.
8. A pi message stops the server's run.
9. `/sync stop` carries on locally with the whole conversation.

## Not done yet

- **In pi, other people's runs show only when each message is finished.** The footer shows whose turn it is, but not their partial answers.
- **pi's own `/new`, `/tree` and `/compact`** change only this pi session. The thread keeps everything, and pi's context and the thread's can then differ.
- **Side threads, `/land` and `/tree` on the thread** are syncpi's, from its web view, app or terminal.
- **Only tried with the scripted models.** Not yet with real models, or with a VM session.
