# Find and the palette: what was built

This is how [search-spec.md](search-spec.md) was implemented, what was measured, and where the implementation is
narrower than the spec.

## Where it lives

| Piece | File |
|---|---|
| Literal matching, the palette's ranking and highlighting positions (no DOM) | `src/shared/search.ts` |
| Find's controller and bar: query, matches, the current match, highlights, focus | `src/web/find.ts` |
| Reading what a view shows as searchable text, and mapping offsets back to DOM ranges | `src/web/find-text.ts` |
| The conversation as a Find target (its rows' marked parts, folds, holding the scroll) | `ThreadView.findTarget` in `src/web/thread-view.ts` |
| The open file or change as a Find target (code, Markdown, diff, editor) | `ArtifactPanel.findTarget` in `src/web/panel.ts` |
| Which pane ⌘F searches, the shortcuts, the terminal's keys | `src/web/main.ts` |
| Forwarding from the app's sidebar, closing Find in a thread put away | `src/web/shell.ts` |
| Find in the app's Edit menu | `desktop/src/main.rs` |
| The palette | `src/web/palette.ts` |

The conversation's searchable text is whatever its rows mark with `data-find`: message bodies (with their code, read
from Pierre's lines in its shadow root, not its gutter), thinking, a tool call's argument and output, comments,
attachment names, notices, errors and milestones. Controls inside them (Copy, buttons, avatars, author lines, line
numbers, previews) are skipped. A long tool output showing only its end is searched in full, and shown in full when
a match above the cut is visited.

## Tests

`npm run test:search` runs:

- `test/search-unit.ts` (14 tests): literal matching, UTF-16 offsets after emoji and case changes, which match stays
  current, the palette's file eligibility, ranking ties and highlight positions.
- `test/search.ts` (31 checks, Chrome via Playwright): Find in the conversation, files, Markdown, the editor, an
  older version, a diff and a preview; the palette in a browser; and the app's shell through the desktop host, with
  threads, the sidebar and a terminal.

`npm run bench:search` measures timings in Chrome; `npm run bench:search -- --webkit` also runs the same page in a
WKWebView (macOS), the app's engine.

## Measurements

Measured on 2026-10-28 on an Apple M4 Max (16 cores), in Chrome 156 and in the system WKWebView (WebKit 605.1.15,
macOS 27.2). The conversation fixture has 2,000 searchable blocks, 2.14 MB of text: 1,000 replies of about 1 KB and
1,000 folded tool outputs of about 1 KB. The palette fixture has 10,000 file paths and 1,000 thread titles. Each
query ran 20 times after one untimed run.

In Chrome, each time runs from setting the query to just after the next frame is painted, so it includes up to one
frame of waiting (about 16 ms at 60 Hz):

| Query | Results | p50 ms | p95 ms |
|---|---|---|---|
| Find "cart total" | 190 matches | 19.8 | 22.0 |
| Find "the" | 8,953 matches | 20.7 | 22.1 |
| Find "unicode emoji" | 61 matches | 19.7 | 20.8 |
| Find "zzz-not-there" | 0 matches | 16.2 | 18.2 |
| Find "s" | 108,852 matches | 23.4 | 25.7 |
| Palette, All, "cart" | 20 rows | 16.6 | 18.1 |
| Palette, Files, "src" | 60 rows | 16.4 | 30.6 |
| Palette, Threads, "session" | 80 rows | 16.7 | 18.4 |

Opening Find and running the first query, which reads all 2,000 blocks, took 48 ms. Both release targets are met:
Find's worst p95 was 26 ms against 100 ms, and the palette's was 31 ms against 50 ms.

The WKWebView runs off screen, where WebKit throttles timers and pauses frames, so there each time is the work a
query causes (counting, highlighting, drawing the palette's rows), without the paint. The worst p95 was 12 ms for
Find ("s", 108,852 matches) and 18 ms for the palette (Files, "src"). The first query took 13 ms. The CSS Custom
Highlight API is present there; all 190 highlights for "cart total" covered exactly the match, and the current match
had its box.

The first benchmark run found two problems, since fixed. Highlighting 108,852 matches overflowed the call stack. And
measuring every block's position to find the visible ones took 150 ms. Find now highlights at most the matches near
the view once there are more than 1,000, and the count still covers all of them. It finds the visible blocks by
binary search.

## Where it differs from the spec

- **No chunked searching.** Counting runs in one animation frame. Reading 2 MB the first time took 48 ms in Chrome and
  13 ms in WebKit, so it isn't split into chunks. "Searching…" shows only while a code view is still being drawn.
- **Artifact cards in the thread aren't searched.** A diff, written file or HTML preview inside the thread
  contributes nothing beyond its tool's argument, which names the file. Its contents are searched in the side panel,
  where Find handles code, Markdown and diffs.
- **Restoring folds.** Closing Find closes the folds it opened. If the person closed one meanwhile, it stays closed.
  If they closed and then reopened one, Find closes it anyway.
- **Text areas.** A match in the file editor is selected and boxed, and other matches there aren't highlighted.
- **Not tested:** Linux and Windows (Ctrl+K in a terminal there depends on how the menu accelerator is routed), a
  screen reader (only the accessibility tree is checked), the packaged app's own window (WebKit was tested through a
  WKWebView with the same page), and history arriving or a branch switching while Find is open. The latter two run
  through the same code as other updates, and the unit tests cover which match stays current.
