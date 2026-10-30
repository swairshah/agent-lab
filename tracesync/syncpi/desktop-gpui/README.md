# SyncPi in GPUI

A native GPUI app for SyncPi, next to the Tauri app (`desktop/`), which stays as it is. The goal is Delta's feel:
Delta is entirely native GPUI (Zed's `gpui` and `ui`, AppKit and Metal, no webview). This gets there in steps.

```sh
npm run gpui        # builds the web app and the host, then runs this app (cargo run)
```

## Now (step 1): a native frame around the web view

- **Native, in GPUI:** the window and its title bar, the sidebar (projects and threads, who else is in each project
  and whether they're there now, new project and new thread), the menus, the native folder picker and dialogs, and
  the app's own shortcuts (⌘O new project, ⌘N new thread, ⌘{ ⌘} between threads).
- **Still the web view:** each thread is the page the browser and the Tauri app show (`src/web`), in an embedded
  webview (`gpui-component`'s, on `wry`), opened as `/session/<id>/?embedded=1`. It reports what it's doing and its
  title through the webview's IPC (`src/web/bridge.ts`); its own shortcuts (⌘K, ⌘F, ⌘P, ⇧⌘P …) stay its own.
- **The same host as the Tauri app:** this starts `dist/desktop-host.mjs`, which keeps each thread's connection,
  syncs project files, runs the agent's tools on this Mac and serves the pages. The app calls its API with the
  launch link's secret; the webviews get its cookie from the launch link, opened once in a hidden webview.

Nothing in the web app or the host changed for this.

A webview is a native view above GPUI's drawing, so nothing GPUI draws can sit over a thread: dialogs are the
system's (the folder picker, "Where should this project run?").

## Step 2, in progress: the thread, native

View → Native thread (preview) draws threads natively (`src/thread.rs`), followed live through the host's stream of a
thread (`/api/sessions/<id>/stream`: server-sent events, at most one every 33 ms, carrying only the items that changed)
and sending through its `send` route. It reuses the earlier native app's Markdown, code, Mermaid and text-cursor
modules (tag `gpui-desktop-final`). It looks like the web view in the app (src/web/style.css, html[data-desktop]): a
left-aligned column up to 820px, a 24px mark, 15px text on a 23px line, rows 16px apart, code on the code
background.

- a person's message on one line, their name in their color, then what they wrote;
- the agent's replies as Markdown (lists, code highlighted with tree-sitter, Mermaid) under the model's mark, with
  thinking as one line that opens;
- a tool call as one quiet line that opens to its output, an edit open with its diff, a run of quiet calls as one
  line ("Ran 1 command, read 1 file");
- notices, the composer as the last row (⌘↩ sends, as in the web view), and a status bar with Stop.

- artifacts, as the web view finds them (src/shared/artifacts.ts): a file the agent wrote (HTML, SVG, Markdown), HTML
  and SVG blocks in a reply, and screenshots and recordings from its browser tools, each a card in the thread (SVG
  and images drawn natively; SVG rendered to PNG with resvg, since gpui 0.2.2 swaps red and blue in an SVG image).
  Open shows one in the panel beside the thread: HTML in a private webview (its own data store, no bridge to the
  app), a recording in a webview that plays it, images and Markdown natively.

- Find (⌘F) in people's and the agent's messages: the count, ⌘G / ⇧⌘G or Enter to move, the matches tinted in the
  text (the current one more strongly; prose.rs paints them from cursor.rs), Esc to close. Tool output isn't searched
  yet.

- side threads: /side [new] [question] opens this person's side thread (the host streams it with `?conv=side`), with
  its banner, Start over and Back; the composer also takes /queue, /steer and /stop, on whichever thread it's in.

- comments on messages: a press on a message's text puts the thread's caret there (arrows move it, Shift selects),
  Enter opens a comment box under the selection, ⌘↩ sends it at once with what's in the composer. Comments people
  made show where they were made (the text marked, the note under it) and as cards on the message that sent them.

- drafts written together: what's typed in the composer is this person's shared draft, live for everyone (with
  their cursor); others' drafts show at the end of the thread as they're written ("typing…", their cursors), with
  Write together to join one (Back to yours to leave it); sending sends it for everyone who wrote it; @names tag.
  The host keeps the drafts' Yjs documents (runtime.ts) and takes the composer's plain text (`POST …/draft`), so
  the app has no CRDT of its own.

- the command palette (⌘K, ⇧⌘P, ⌘P, ⌘T), the model picker (⌘⌥/) with the thinking level, and every command of
  src/shared/keymap.json from its shortcut, the menus or the palette: thread actions (rename, regenerate the title,
  pin, bookmark, tags, archive, share with a link to copy, join a shared thread), the agent's (stop, summarize, new
  context, branches, the setup and land agents' threads, land, side thread), the project's (sync, reveal, Zed, a
  browser, a preview, update the server), text size and light or dark (kept in ~/.syncpi/desktop-gpui.json), the
  keyboard shortcuts. The sidebar has search, the archive (⌘Y), the theme, pins, bookmarks, tags and a right-click
  menu. Threads are native by default; View → Native or web thread switches.

- Settings (⌘,): your name, appearance, where your requests run (this Mac or the session VM), the model and
  thinking level, context; people (roles, removing) and invites (email or link, role, expiry; revoking);
  branches; the environment the setup agent prepared; the session.

- the inbox (⇧⌘J, and in the sidebar with the unread count): mentions and tags in drafts across every thread;
  opening one goes to the message, or joins the draft; a note when one arrives.

Not native yet: the changes and files panel, git, the terminal. Switch to the web view for those (View → Native or web thread). `SYNCPI_GPUI_NATIVE=1` or `0` overrides it.

## Testing without taking the screen

`SYNCPI_GPUI_WINDOW=x,y,w,h` places the window and opens it without focus, as a floating panel: macOS keeps a corner
of it on screen, and GPUI stops drawing a window macOS reports as covered, so the corner stays above other windows.
`SYNCPI_GPUI_TEST_OPEN=html|svg|image|markdown` opens the first artifact of that kind, as a click on its Open would.
`SYNCPI_GPUI_TEST_FIND=<text>` searches for it once the thread has loaded, and `SYNCPI_GPUI_TEST_SEND=<text>` sends
it from the composer; `SYNCPI_GPUI_TEST_COMMENT=<quoted>|<comment>` comments on the first reply with that text;
`SYNCPI_GPUI_TEST_COMMAND=<id>,…` runs commands once the thread is open; `SYNCPI_GPUI_TEST_TYPE=<text>` types it in the composer, and `SYNCPI_GPUI_TEST_JOIN=<text>` joins someone's draft and
adds the text to it. `SYNCPI_FAUX=1` runs the host with the
scripted model; `SYNCPI_HOME` points at a test home; `SYNCPI_GPUI_THEME=dark`
(or `light`) overrides the system's appearance. Capture the window with
`screencapture -x -o -l <window id>`.
