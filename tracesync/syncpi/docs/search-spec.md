---
title: Find and navigation search
subtitle: Implementation specification for syncpi desktop and web
date: October 2026
abstract: Add a scoped Find bar for text in the current conversation or file, and refine the existing command palette for navigating commands, threads, and project files. Both features run locally over data already available to the client. Neither submits a message to the agent.
toc: true
fonts: local
theme: auto
---

## Product contract

Cmd+F finds text within the view the user is reading. Cmd+K opens a palette for navigating the app or running a command. The controls must have different labels and different matching rules.

| Property | Find | Navigation search |
|---|---|---|
| Primary shortcut on macOS | Cmd+F | Cmd+K |
| Primary shortcut elsewhere | Ctrl+F | Ctrl+K |
| Label | Find in conversation or Find in file | Search commands, threads and files |
| Query meaning | Literal text occurrence | Ranked name or path match |
| Results | Highlighted occurrences and a current/total count | Grouped selectable rows |
| Action | Reveal the next occurrence | Open a resource or run a command |
| Scope | Current conversation branch or active text artifact | Available commands, known threads, current project paths |
| Network requirement | None for loaded text | None for known metadata |
| Agent interaction | None | Only when an explicitly selected command invokes an agent action |

The user has observed both shortcuts in Delta. Delta's published guide verifies a command palette that searches commands and threads, separate file navigation, and Find actions in editors. The guide does not establish every detail of conversation Find. The requirements below are proposed syncpi behavior, not a claim that Delta uses the same algorithms, indexes, ranking, or UI internals.

Full conversation search across all sessions is outside this release. There is no embedding index, model call, web search, repository content search, or search-and-replace.

## Existing code

The app already has most of the navigation palette. Extend it rather than building another dialog.

| Location | Existing behavior | Required work |
|---|---|---|
| `src/shared/keymap.json` | Defines palette shortcuts for desktop and web | Add Find commands and clarify palette labels |
| `src/shared/keymap.ts` | Maps `cmd` to Ctrl outside macOS | Reuse for new shortcuts |
| `src/web/palette.ts` | All, Threads, Commands, Files tabs; fuzzy matching; keyboard selection | Fix candidate eligibility, focus restoration, accessibility, and deterministic ordering |
| `src/web/main.ts` | Wires palette to session files, shell threads, and command handlers | Own one Find controller and route focused-view requests |
| `src/web/shell.ts` | Forwards commands to the active thread iframe | Forward Find without searching hidden frames |
| `src/web/thread-view.ts` | Revision-based row replacement and grouped tool rows | Expose searchable blocks and reveal a particular match |
| `src/shared/thread.ts` | Stores messages, tool calls, comments, notices, and revisions | Supply stable item identities and invalidate changed items |
| `src/web/panel.ts` | Manages file tabs and selected artifacts | Supply an active file/artifact Find adapter |
| `src/web/index.html` and `src/web/style.css` | Hold dialogs and common UI styling | Add a compact Find bar and highlight styles |

The standalone web view currently has no thread provider. Do not show a Threads tab there until a provider exists. Embedded pages receive known thread metadata through the shell. The shell must explicitly declare whether archived threads are included; do not assume the current provider includes them.

The palette currently calculates file eligibility after adding a basename bonus. A failed path match can therefore be promoted by an unrelated score. Filter on a successful match before applying bonuses. The existing highlight helper also mixes string indices with code-point iteration. Fix matching and highlighting together so emoji before a match do not shift the highlighted characters.

## Find interface

### Placement and state

Place one non-modal Find bar at the top of the target pane. It must remain visible while that pane scrolls, without covering the first matching line. It contains a search input, current/total count, previous and next buttons, a Match case toggle, and a close button. The visible scope label identifies the conversation, file path, or artifact title.

Use the existing typography, surface, border, and accent variables. Distinguish the active occurrence with an outline as well as a different background. Opening Find must not resize the entire app or produce a toast.

| State | Required presentation |
|---|---|
| Empty query | No highlights; count is 0/0 |
| Matching query | Count such as 3/12; active occurrence outlined |
| No matches | Count is 0/0 and text says No matches |
| Rebuilding results | Retain the input and indicate Searching only if the update takes over 150 ms |
| Incomplete conversation history | Scope says Loaded conversation |
| Unsupported artifact | Explain that Find is unavailable for this view |
| Target removed | Close the bar and restore focus to the conversation |

Keep the query and Match case state in memory per target during the page's lifetime. Do not persist query strings in local storage, session storage, URLs, telemetry, or shared state.

### Keyboard behavior

Cmd+F opens Find for the focused pane and selects the existing query. If Find is already open, the shortcut focuses its input without resetting it. A plain-text selection inside the target seeds the query when it is at most 256 UTF-16 code units and contains no line break. Otherwise retain the prior query.

Enter selects the next occurrence. Shift+Enter selects the previous occurrence. Navigation wraps at both ends. Cmd+G and Cmd+Shift+G perform the same actions while Find is open. Off macOS, use Ctrl+G and Ctrl+Shift+G. If Find is closed, leave these keys alone in this release.

Escape closes Find before any agent-stop handler can run. Closing restores the previous focus target and selection when that target still exists. Navigation must not move focus out of the Find input. Clicking a result highlight is not required.

Regular expressions and whole-word matching are deferred. Text such as `.*`, `[Ada]`, or `src/foo.ts` must be treated literally.

### Scope routing

| Focus at invocation | Find target |
|---|---|
| Conversation, composer, or its controls | Current main or setup conversation, whichever is displayed |
| File tab or text artifact | Active text view and selected version |
| Editable file text area | Its current unsaved contents |
| Project tree or sidebar | Active conversation |
| Another modal dialog | Do not override that dialog's input behavior |
| Interactive terminal | Do not intercept Cmd+F in this release |
| HTML/SVG preview iframe | Do not inspect its DOM or intercept its internal shortcuts |

The last active pane determines the target when a native menu dispatches Find without a DOM keyboard event. Opening the Find input must not change that remembered pane. A file version change creates a new target; switching back restores the previous target's in-memory query.

## Searchable text

### Conversation contents

Search the current displayed branch, including any earlier entries already prepended into the client. The setup conversation is a separate scope. Do not combine both conversations or search other branches.

| Content | Included text |
|---|---|
| User message | Message body and submitted comment text/excerpts |
| Assistant message | Rendered reply text and code |
| Thinking disclosure | Displayable thinking text, including when folded |
| Tool call | Displayable argument and output text, including when folded |
| Notice or error | Displayed text |
| Attachment | Displayed filename only |
| Pending message or draft | Excluded until it becomes a committed thread item |
| Terminal | Excluded, including live output |
| Image, recording, preview | Excluded beyond the displayed filename or caption |
| UI controls | Excluded, including Copy, timestamps, avatars, line numbers, and fold summaries |

Search canonical display blocks, not `JSON.stringify(item)` or the entire page's `textContent`. A tool output rendered both as a preview and as a detailed view counts once in the conversation. Distinct tool arguments and outputs may each contain occurrences. Do not index hidden metadata, tokens, model instructions, attachment payloads, or undisplayed structured tool details.

Give each block an item key and a part identifier. Treat block boundaries as search boundaries. A query can span adjacent inline text nodes in one paragraph, including emphasis and links, but cannot span two messages or separate tool fields. Code blocks preserve their line breaks. Display text contains no Markdown formatting delimiters.

### File contents

Search only the active textual view. In source mode, search source text. In rendered Markdown mode, search rendered text. In a diff, search displayed old and new code columns in display order, excluding line-number gutters and controls. A line displayed on both sides can legitimately contain two occurrences.

Use the selected file version, not the latest remote file when an older version is visible. Never fetch a different version merely to complete Find. For an editable text area, reveal a match using its selection and scroll APIs without changing its value or firing a save.

### Completeness

The first release searches text already available to the view. It must not silently download all history whenever the user types. If the client cannot prove that it has the whole branch, label the scope Loaded conversation and state that unloaded history is excluded. Once more history arrives, incorporate it and update the count.

Searching all durable history requires a later authenticated history-search API. Keep that work separate from the local Find release.

## Matching and rendering

### Literal matching

Match case is off by default. Escape the input before constructing a JavaScript regular expression, and use global, Unicode, case-insensitive matching when Match case is off. Use global and Unicode flags when it is on. This defines JavaScript Unicode case matching, not locale-specific full case folding or accent removal.

Keep offsets in UTF-16 code units, as used by JavaScript strings and DOM Range. Do not lowercase the indexed text and then reuse offsets in the original string. Case conversions can change lengths. Do not normalize either string unless an explicit source-offset mapping is introduced.

Return non-overlapping occurrences in block order, then offset order. For example, `aa` in `aaaa` returns two matches. Empty input returns none. Spaces in the input are significant and must not be trimmed. Limit the input to 512 UTF-16 code units with a visible explanation when the limit is reached.

### Find adapters

Add `src/web/find.ts` for controller state and `src/shared/search.ts` for pure literal matching. Views provide adapters rather than exposing their DOM to a global page search.

```ts caption="Suggested interface for a searchable view."
type SearchBlock = {
  id: string;
  revision: number;
  text: string;
};
type FindMatch = { blockId: string; start: number; end: number };
interface FindTarget {
  id: string;
  label: string;
  blocks(): readonly SearchBlock[];
  reveal(match: FindMatch): Promise<void>;
}
```

Add a separate highlight adapter that maps a block's text offsets to live DOM ranges. The controller owns query, matches, active identity, target, and focus restoration. The view owns text extraction, disclosure expansion, and DOM mapping.

Use a dedicated CSS Custom Highlight registry name where the target webview supports it. Provide a tested fallback using text-node wrapping outside editable controls, or a positioned range-rectangle layer. Feature detection is required. Never rewrite a message with `innerHTML` to add marks, and never replace the full terminal or artifact subtree.

Opening a folded match expands all containing disclosures before scrolling. Record which disclosures Find opened and their prior state. On closing, restore them unless the user explicitly toggled them during the search. Use a reveal generation token so an older asynchronous reveal cannot steal focus or scroll after a query or target change.

### Updates and scrolling

Cache searchable text by block ID and revision. Rebuild changed blocks after rendering completes, and discard DOM ranges for replaced rows. Theme changes, member renames, branch changes, and file refreshes can replace DOM even if the query is unchanged.

Retain the active block and offset when still valid. If the occurrence disappears, select the nearest following occurrence in document order, otherwise the last remaining one. Closing the bar clears all highlight registries and stale ranges.

While Find is open, suspend conversation auto-follow scrolling. New model tokens must not move the reader away from a match. Resume the normal follow policy after Find closes only if the user is near the bottom. Recompute counts during streaming at most once per animation frame; large jobs must yield rather than blocking typing.

## Navigation palette

### Entry points

Keep the existing palette and its All, Threads, Commands, and Files tabs. Cmd+K opens All. Cmd+Shift+P opens Commands. Cmd+P opens Files. Cmd+T opens Threads only in clients with a thread provider. Use corresponding Ctrl shortcuts outside macOS.

Keep the current Cmd+1 through Cmd+4 tab switching where tabs are available. Plain Tab must move keyboard focus normally. Delta's Ask Delta mode is not part of this specification.

Rename Search everything to Search commands, threads and files, adapting the label when threads are unavailable. The palette searches names and paths, not conversation bodies or file contents.

### Ranking rules

Reuse the current substring and subsequence scoring as a starting point. Extract pure functions into the shared search module only when both palette and tests need them. Find must not call fuzzy matching.

First determine whether a candidate matches. Then apply field bonuses to valid matches. Rank a file by the maximum valid full-path score or basename score plus a basename bonus. A failed match stays excluded regardless of bonuses. Thread title ranks above project-name-only matches. Commands match titles and group names.

Tie-break deterministically by normalized label, then stable ID. Empty queries retain curated quick actions and existing command ordering. Recent-thread ordering is deferred until the provider supplies a reliable recent-use field.

| Tab | Maximum displayed results |
|---|---|
| All | 6 threads, 8 commands, 12 files |
| Threads | 80 |
| Commands | All eligible commands |
| Files | 60 |

Keep categories grouped in the order Threads, Commands, Files. Do not compare category scores as if they formed one global ranking. If results exceed a cap, show a non-selectable count and an action to open the relevant tab. In a capped tab, instruct the user to refine the query.

Highlight the characters matched in the displayed label or detail. If a match exists only in a project's name or file directory, show that field rather than suggesting the title matched. Escape all user-supplied text before creating markup.

### Execution and focus

Arrow keys move through result rows and wrap. Enter activates only the selected row. Escape and clicking outside close the dialog and restore the original focus and selection. Mouse hover must not replace keyboard selection immediately after a redraw, preserving the existing pointer suppression.

Only include commands registered for the current client. Recheck authorization when executing a command, because a collaborator's role can change while the dialog is open. An empty result set must never activate the previously selected row.

Use a modal dialog with an accessible title. Use a combobox input with `aria-controls`, `aria-expanded`, and `aria-activedescendant`, and a listbox containing stable option IDs. Announce counts through a polite live region without reading every result on every keystroke.

The Files tab currently offers Create file for a missing path. Keep creation separate from matching results, clearly label it, validate paths using existing project-file validation, and hide it from viewers. Search queries alone must never create files.

## Desktop and web

Register `find.open`, `find.next`, and `find.previous` in the shared keymap so native menus, the palette, and DOM shortcuts call the same handlers. Add shell forwarding for active-thread Find commands. With no active thread, leave Find unavailable rather than searching the sidebar.

Browser keyboard events do not cross iframe boundaries. Install handlers in both the shell and the thread page, and forward an action exactly once through the existing `syncpiRun` route. Never search every cached thread iframe. Hidden frames must not retain visible Find bars or focus.

Cmd+K belongs to an interactive shell when the terminal has focus. Cmd+Shift+P remains the app's command-palette escape route. Inspect terminal focus before invoking the generic palette handler, including native menu accelerator routing. On Linux and Windows, preserve Ctrl+K in the terminal under the same rule.

Use `preventDefault` only after syncpi accepts a shortcut. Do not intercept shortcuts during IME composition. A modal dialog gets Escape before Find, Find gets it before the composer, and terminal input remains governed by the terminal. Verify browser-native Find is suppressed only when an app Find target actually opens.

Search is local UI state. Opening Find, changing a query, or navigating matches must not broadcast to collaborators, mark messages read, stop generation, submit model input, or edit files. Authorized thread metadata and already-loaded content remain subject to existing access controls.

## Implementation sequence

| Phase | Deliverable | Completion check |
|---|---|---|
| 1 | Pure literal matcher, file ranking eligibility fix, Unicode-safe highlight positions | Unit tests pass without DOM |
| 2 | Find controller, bar, and conversation adapter | Main/setup scopes, folded tools, streaming, and close behavior pass browser tests |
| 3 | File/artifact adapters | Rendered/source modes, dirty edits, versions, and diffs pass tests |
| 4 | Keymap, shell forwarding, terminal ownership, palette accessibility | Desktop and standalone web shortcut tests pass |
| 5 | Performance and accessibility pass | Large fixture timings, keyboard navigation, and screen-reader checks recorded |

Do not introduce a server search endpoint, a persistent database, or a new framework in these phases. If an existing artifact renderer cannot expose correct offsets safely, show Find unavailable for that view until its adapter is implemented. Do not ship incorrect match counts as a fallback.

## Acceptance tests

### Find behavior

| Scenario | Expected result |
|---|---|
| A phrase appears in two messages | Count includes both; Enter and Shift+Enter wrap |
| A phrase crosses an emphasized inline span | One match with correct range |
| A phrase crosses two messages | No match |
| A query includes regex punctuation | Literal matching without syntax errors |
| Case toggle changes eligibility | Count and highlights update together |
| Emoji or mixed scripts precede a match | Correct visible characters are highlighted |
| Match occurs in a folded tool or thinking block | Count includes it; navigation opens the containing disclosure |
| Query matches a Copy label or line number only | No match |
| New tokens arrive during Find | Counts update; scroll remains at the active occurrence |
| Theme resets conversation rendering | Highlights reattach without duplicate marks |
| Branch switches | No stale match references remain |
| Older history is prepended | Count grows; existing active occurrence stays selected |
| Escape closes Find while the agent is running | Agent continues; composer receives restored focus if it was the origin |
| Unsaved file contains a match | Search uses the edit buffer and does not save |
| Old file version differs from current | Only the displayed version is searched |
| Find closes after expanding a fold | Previous fold state is restored unless changed by the user |

### Palette behavior

| Scenario | Expected result |
|---|---|
| Cmd+K in a conversation | All tab opens and focuses the input |
| Cmd+K in a terminal | Shell receives it |
| Cmd+Shift+P in a terminal | Commands tab opens |
| Standalone web has no thread provider | No Threads tab or misleading global-history claim |
| A basename matches but its path starts late | Candidate ranks by the best valid field |
| Neither file field matches | Bonuses cannot make the file eligible |
| Match is only in the directory | Directory is shown and highlighted |
| Several rows have equal scores | Ordering is stable across redraws |
| User enters text with HTML syntax | Text displays safely |
| No rows match | Enter does nothing |
| Role becomes viewer while palette is open | Mutating actions are refused at execution |
| User cancels the dialog | Original editor selection is restored |

### Performance and delivery

Measure on a named reference machine and record fixture size. Target p95 below 100 ms from input to painted results for a 2 MB conversation with 2,000 blocks, and below 50 ms for 10,000 file paths and 1,000 known thread titles. These are release targets, not measured current performance. Use incremental extraction and cooperative scheduling before adding workers.

For larger conversations, yield in short chunks and show Searching rather than silently truncating counts. Cancel stale work when the query changes. Highlight visible matches plus the active occurrence if painting all matches exceeds the frame budget; the total count must still cover every indexed block.

Add unit tests for matching and ranking, plus Playwright tests for focus, folded content, live updates, and iframe routing. The repository currently has smoke and desktop tests but no dedicated search test command. Add `test:search` for the new suite and document its runner configuration.

Run `npm run test:search`, `npm run typecheck`, and `npm run build` before declaring the implementation complete. Also test the packaged desktop webview on macOS and one supported Linux or Windows environment. A Chromium browser test alone does not establish WKWebView highlight support or native menu shortcut behavior.

## Deferred work

Cross-session message search, complete durable-history search, repository content search, regular expressions, replacement, terminal scrollback search, semantic matching, and Ask Delta command suggestions are separate features. None is required for the local Find and navigation palette described here.
