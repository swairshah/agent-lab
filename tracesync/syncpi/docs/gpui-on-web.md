# If we move the UI to GPUI: one Rust UI for the desktop and the web

Today syncpi has one UI in both places because it is a web UI: `src/web` runs in the browser, and the desktop app
(`desktop/`) is a Tauri shell around the same pages. The earlier native desktop app was written with GPUI (tagged
`gpui-desktop-final`) and was dropped partly because it could not also run in a browser.

That is not a hard limit. A GPUI app can be compiled to WebAssembly and run in a browser, drawing the whole window
into a `<canvas>`. The same Rust UI then runs natively on the desktop and on the web. This note records how, in case
we want to go back to GPUI.

## How it works

GPUI separates the UI (views, elements, layout, text, keymaps) from a platform layer (windows, input, fonts,
drawing) for each OS. Running in a browser means adding a web platform layer and building for `wasm32`:

| Piece | Native desktop | Browser |
|---|---|---|
| UI code (views, elements, Taffy layout, keymap) | GPUI | the same GPUI code, compiled to wasm |
| Platform layer | GPUI's macOS / Linux / Windows layer | a web layer: the window is a full-page `<canvas>`, DOM events become GPUI events |
| Rendering | Metal (macOS) or Vulkan through GPUI's renderer | wgpu: WebGPU where the browser has it, WebGL2 as a fallback, into the canvas |
| Text | the OS's font stack | shaping in Rust (e.g. cosmic-text), glyphs drawn on the canvas or into a wgpu atlas |
| Typing, IME, clipboard | native | a hidden 1px `<textarea>` that receives keystrokes and composition, mirrored into GPUI; the Clipboard API |
| Network | native sockets | `fetch` and `WebSocket` through a small HTTP/WebSocket client for wasm |
| Syntax highlighting | tree-sitter, linked in | tree-sitter grammars built as separate `.wasm` files and loaded on demand |

Build it with `wasm-bindgen` (or `wasm-pack`) into a `<name>_bg.wasm` and a small JavaScript loader, host both as
static files, and serve an HTML page that is little more than the canvas, the hidden textarea, and a script that
loads the module. The page has almost no DOM: everything you see is pixels drawn by the Rust code.

For syncpi this would mean:

- **The server and protocol stay as they are.** `src/server` and the WebSocket protocol in `src/shared/protocol.ts`
  don't care what draws the UI. The Rust client would speak the same messages (as it did in the GPUI desktop app).
- **Shared drafts and live files need a Rust Yjs.** `yrs` (Yjs in Rust) reads and writes the same updates as the
  `yjs` package the server uses, so drafts, carets and live files would keep working with web and terminal clients.
- **The UI is rewritten in Rust once**, from `src/web` to GPUI views, and that one version is built twice: natively
  for the desktop app and to wasm for the browser. Tauri goes away.
- **The terminal client is unaffected.**

## What it costs

- **The web platform layer has to exist.** GPUI's own repository ships native platforms; a web layer (window,
  events, text drawing, IME mirror, HTTP client) and a wgpu renderer that works in the browser are needed. Check
  whether a maintained one is available upstream before planning around it; writing our own is a large job.
- **A large download.** A full GPUI app in wasm is tens of megabytes before compression, against a few hundred KB for
  the current web UI. It needs good caching and a loading screen, and the first open is slow on a poor connection.
- **The browser's built-ins are gone.** No HTML text means no browser find (⌘F), no native text selection or
  right-click menu, no spellcheck, no screen-reader support, no translation, and no extensions that read the page.
  Each one we want has to be rebuilt inside the app.
- **Input is hand-built.** Keyboard shortcuts that the browser keeps for itself, IME composition for non-Latin
  languages, and dead keys all go through the hidden textarea and need care to get right.
- **Rendering differences.** WebGPU isn't in every browser; the WebGL2 fallback must be tested, and high-DPI
  canvases at full window size use a lot of GPU memory.
- **One Rust codebase for all UI.** That is the point, but it also means every UI change is a Rust change and a wasm
  rebuild, and HTML-only conveniences (artifact iframes, Mermaid, embedded web pages) need another approach, such as
  overlaying real DOM elements on the canvas.

## What it gains

- One UI codebase that runs natively on the desktop, with GPUI's speed and memory use rather than a webview's.
- The same pixels on the desktop and the web.
- Client logic (sync, Yjs, the protocol) shared in Rust between the desktop and the browser.

## When it is worth it

Stay on the web stack while the desktop app's speed is acceptable: one UI in both places already comes for free
with Tauri, and the browser's text, accessibility and find come with it. Move to GPUI plus wasm if the desktop app
needs native performance that a webview can't give, and a web platform layer for GPUI is available to build on.

If we do it, a sensible order is:

1. Start from `gpui-desktop-final` and bring the native app up to the current web UI's features.
2. Replace the TypeScript client logic it needs with Rust (the protocol types, `yrs` for drafts and live files).
3. Build the same crate for `wasm32-unknown-unknown` with the web platform layer and wgpu, and serve it from the
   session server in place of `src/web`.
4. Keep the HTML UI available until the wasm build covers the things it can't do yet (find, selection, artifacts).
