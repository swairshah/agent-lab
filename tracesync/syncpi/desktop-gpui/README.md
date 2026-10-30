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

View → Native thread (preview) draws threads natively (`src/thread.rs`), from the host's snapshot of a thread
(`/api/sessions/<id>/native`, polled while it's on screen) and its `send` route, as the earlier native app did (tag
`gpui-desktop-final`, whose Markdown, code, Mermaid and text-cursor modules it reuses):

- a person's message on one line, their name in their color, then what they wrote;
- the agent's replies as Markdown (lists, code highlighted with tree-sitter, Mermaid) under the model's mark, with
  thinking as one line that opens;
- a tool call as one quiet line that opens to its output, an edit open with its diff, a run of quiet calls as one
  line ("Ran 1 command, read 1 file");
- notices, the composer as the last row (⌘↩ sends, as in the web view), and a status bar with Stop.

Not native yet: artifacts (HTML previews, images, the side panel), comments, side threads, Find, drafts written
together, the inbox, settings. Switch back to the web view for those. `SYNCPI_GPUI_NATIVE=1` starts in native mode.

## Testing without taking the screen

`SYNCPI_GPUI_WINDOW=x,y,w,h` places the window and opens it without focus, as a floating panel: macOS keeps a corner
of it on screen, and GPUI stops drawing a window macOS reports as covered, so the corner stays above other windows.
`SYNCPI_FAUX=1` runs the host with the scripted model; `SYNCPI_HOME` points at a test home. Capture the window with
`screencapture -x -o -l <window id>`.
