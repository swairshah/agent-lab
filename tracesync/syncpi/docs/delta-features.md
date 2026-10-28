# Delta feature reference

This is a catalog of what the Delta desktop app (version 0.22, a GPUI app forked from Zed) offers, written so that we can add the useful parts to syncpi one at a time. It covers the command palette, keybindings, the composer, how the agent's rich output is rendered, the built-in skills, and the window layout. The last section is a prioritized list of features to bring over.

Sources: the text embedded in `/Applications/Delta.app/Contents/MacOS/delta-app` (skill files, the agent system prompt, action names and descriptions, settings labels), the app's own Keymap reference and menu bar, and read-only looks at the running app on 2026-10-27. Where a detail comes only from embedded strings and was not seen in the UI, the text says so.

## Vocabulary

Delta's nouns differ a little from syncpi's, so here they are up front.

| Delta term | Meaning | Nearest syncpi idea |
|---|---|---|
| Thread | One conversation with an agent. Can be shared with other people, who see it live. | A session's main conversation |
| Project | A local folder (usually a Git repo) attached to Delta. Threads are grouped under projects. | The project folder |
| Delta worktree | A versioned copy of a repository that Delta keeps in sync through its own virtual file system. Each thread works in its own worktrees. | The synced project copy |
| Subthread | A child thread. Kinds: review fork, Land fork, plain fork, subagent. | None yet |
| Land Changes | A button that opens a Land subthread, which runs the project's `land` skill to merge or push the work. | None yet |
| Runner | Where an agent's turns execute: this machine, another of your machines, or a Cloud Runner (an E2B sandbox). | `/where here|vm` |
| Profile | A named subagent configuration (model, prompt, tools, shared or isolated worktree). Shipped profiles are Scout, Worker and Reviewer. | None yet |

## 1. Command palette

`cmd-shift-p` and `cmd-k` open the same palette. `cmd-shift-p` opens it on the Commands tab, and `cmd-k` opens it on the All tab. `cmd-t` (Go to Thread) opens it on Threads and `cmd-p` (Go to File) on Files.

The palette has four tabs, switched with `cmd-1` to `cmd-4` while it is open:

| Tab | Key | Contents |
|---|---|---|
| All | `cmd-1` | Recent files, Quick Actions, Recent Threads, then Commands, in that order |
| Threads | `cmd-2` | Thread search |
| Commands | `cmd-3` | Every action available in the current focus context, with its shortcut |
| Files | `cmd-4` | Files in the current thread's worktrees |

**Ask Delta mode.** `Tab` switches the palette to a free-text box labelled "Ask about Delta...", with the hint "Ask how to do something in Delta, then press enter." The question goes to an agent loaded with the built-in `delta-help` skill (see section 5). `Tab` again goes back to search. Pasting a shared-thread link into the palette offers "Join Shared Thread".

**Quick Actions** (always at the top of All and Commands): New Thread `cmd-n`, Add Project `cmd-o`, Archive Thread `cmd-w`, Share Thread `cmd-shift-s`.

The command list depends on focus: composer-only commands such as Toggle Model Selector do not appear when the file pane has focus. Notable groups:

| Group | Commands |
|---|---|
| Threads | New Thread, New Empty Thread (no project), Go to Thread, Next/Previous Thread, Join Thread, Share Thread, Rename Thread (`F2`), Regenerate Thread Title, Pin/Unpin, Toggle Thread Bookmarked, Toggle Thread Read Status, Edit Thread Tags, Manage Tags, Archive, Reopen Archived Thread, Delete Thread, View Thread Details, Collapse Child Threads |
| Review and diffs | Review Changes, Create Review Thread, Open Branch Diff (against the default branch), Open Uncommitted Diff, Open Last Turn Diff (only the latest assistant turn), Cycle Diff Base |
| Subthreads | View All Subthreads, Send Message to Fork, Open Parent Thread, Open As Primary, Toggle Archived Subthreads |
| Panels and layout | Toggle Sidebar, Toggle Right-Side Drawer, Toggle Project Panel, Toggle Changes Panel, Toggle Outline, Toggle Inbox, Toggle Thread History, Split Pane (up/down/left/right), Toggle Zoom, Toggle Theme, Toggle Typewriter Mode, Toggle Centered Content, Make Content Full Width, Toggle Line Width Ruler |
| Comments | Add Comment, Toggle Comment Mode, Toggle Comment Visibility, Toggle Delivered Comments |
| Agent settings | Configure Model Providers, Edit Agent Profiles, Edit Global Rules (personal AGENTS.md), Create Prepare Script |
| Integrations | Open in Zed, Open in Claude Code (through the Delta plugin), Open Git Project, Install CLI |
| App | Open Settings `cmd-,`, Open Log Viewer, Open Delta Inspector, Pause Connectivity, Send Feedback, Sign In/Out, Check for Updates, Quit |

## 2. Keybindings

Delta ships a Keymap window (`cmd-/`, also under Help > Keymap). It groups bindings into Global, Sidebar, Composer, Thread, File Pane, File Editor, Search, View, Window, Changes and Projects, and it has a search box that matches action names or keys. The tables below cover agent, thread, panel and navigation bindings. Generic editing bindings (word movement, selection and so on) are left out.

### Threads and navigation

| Key | Action | What it does |
|---|---|---|
| `cmd-n` | New Thread | New thread in the current project |
| `cmd-shift-n` | New Empty Thread | New thread with no project |
| `cmd-o` | Add Project | Attach a local folder |
| `cmd-t` | Go to Thread | Palette on the Threads tab |
| `cmd-p` | Go to File | Palette on the Files tab |
| `cmd-}` / `cmd-alt-right` | Next Thread | Next thread in the sidebar |
| `cmd-{` / `cmd-alt-left` | Previous Thread | Previous thread in the sidebar |
| `ctrl-tab` / `ctrl-shift-tab` | Next / Previous Recent Thread | Move through threads in viewing order |
| `cmd-shift-t` | Reopen Archived Thread | Restore the last archived thread |
| `cmd-w` | Archive Thread | Archive, or close the focused tab in the file pane |
| `F2` | Rename Thread | |
| `cmd-d` | Toggle Thread Bookmarked | |
| `cmd-alt-p` | Toggle Thread Pinned | |
| `cmd-shift-u` | Toggle Thread Read Status | |
| `cmd-y` | Toggle Thread History | Show archived threads in the sidebar |
| `cmd-alt-b` | Show Bookmarked Threads | |
| `cmd-shift-j` | Toggle Inbox | Notifications (mentions, invitations, finished agents) |
| `cmd-shift-r` | Mark All Inbox Notifications Read | Global context |
| `cmd-1` | Focus Thread Editor | Outside the palette |

### Thread and composer

| Key | Action | What it does |
|---|---|---|
| `cmd-enter` (or `enter`) | Send Message | `enter` is newline by default; a setting ("Send With Modifier") swaps them |
| `cmd-shift-enter` | Send Message to Fork | Sends the draft to a new subthread instead of this one |
| `enter` / `shift-enter` | Newline | |
| `!` at line start | Open Interactive Shell At Line Start | Turns the composer line into a shell command run in the thread |
| `?` at start | Address Draft To Agent | Marks a draft as addressed to the agent (in a shared draft) |
| `escape` | Cancel Generation | Stop the current response |
| `ctrl-space` | Mention Picker Invoke | Open the `@` picker without typing `@` |
| `cmd-enter` in the picker | Mention Picker Confirm And Send | Insert the selected skill and send at once |
| `cmd-alt-/` | Toggle Model Selector | Model picker |
| `alt-tab` | Cycle Favorite Models | Rotate through starred models |
| `cmd-alt-k` | Toggle Thinking | Thinking on or off |
| `cmd-alt-'` | Toggle Thinking Selector | Thinking effort picker |
| `ctrl-'` | Cycle Thinking Effort | Next effort level |
| `cmd-alt-f` | Toggle Fast Mode | Faster model responses |
| `cmd-alt-.` | Toggle Runner Selector | Choose where turns run |
| `cmd-alt-o` | Toggle Project Picker | Switch the thread's active project |
| `ctrl-cmd-b` | Toggle Branch Picker | Switch branch |
| `cmd-shift-o` | Open Git Project | Clone or open a repo |
| `cmd-shift-r` | Create Review Thread | Start a review subthread of this thread |
| `cmd-shift-l` | Land Changes | Open a Land subthread |
| `cmd-alt-r` | Revert to Cursor | Rewind the conversation to the message under the cursor |
| `cmd-[` / `cmd-]` | Previous / Next Message | Move through messages |
| `cmd-alt-l` | Copy Share Link | Link to the cursor position in a shared thread |
| `cmd-alt-c` | Copy Thread Content | Thread as readable text |
| `ctrl-alt-cmd-f` | Follow Next Collaborator | Follow another participant's view, cycling on repeat |
| `ctrl-backtick` | Open Terminal | |

### Subthreads

| Key | Action | What it does |
|---|---|---|
| `cmd-j` | View All Subthreads | Subthread picker |
| `cmd-1` … `cmd-5` in the picker | Show All / Review / Land / Plain Forks / Subagents | Filter the picker |
| `cmd-alt-u` | Open Parent Thread | |
| `cmd-enter` | Open As Primary | Promote a focused child tab to the main column |

### Panels, panes and review

| Key | Action | What it does |
|---|---|---|
| `cmd-b` | Toggle Sidebar | Left thread sidebar |
| `cmd-r` | Toggle Right-Side Drawer | Right pane |
| `cmd-shift-e` | Toggle Project Panel Focus | File tree |
| `cmd-shift-d` | Toggle Changes Panel Focus | Changed-files list, opens the review diff |
| `alt-shift-d` | Review Changes | Open or activate the thread's review |
| `alt-tab` (diff) | Cycle Diff Base | Switch between branch, uncommitted and last-turn diffs |
| `cmd-?` | Toggle File Pane Focus | Move focus between file pane and thread |
| `cmd-shift-o` (file) | Toggle Outline | Symbol outline of the active file |
| `cmd-2` … `cmd-9` | Focus Pane 1–8 | |
| `ctrl-1` … `ctrl-9` | Focus File Tab 1–9 | |
| `cmd-alt-right` / `cmd-alt-left` | Next / Previous File Tab | In the file pane |
| `cmd-shift-k` then arrow | Split pane / activate pane in that direction | |
| `cmd-[` / `cmd-]` (diff) | Previous / Next File | In a diff |
| `shift-enter` (diff) | Expand Excerpts | Show more context around a hunk |
| `cmd-alt-m` | Add Comment | Comment on the selection in a file, diff or message |
| `cmd-alt-c` (file) | Toggle Comment Mode | Typing creates comments instead of edits |
| `cmd-alt-v` | Toggle Comment Visibility | |
| `cmd-shift-m` | Toggle Delivered Comments | Show comments already sent to the agent |
| `cmd-alt-shift-t` | Toggle Typewriter Mode | |
| `cmd-alt-shift-l` | Open Log Viewer | |
| `cmd-alt-i` | Open Delta Inspector | Developer view of replicated history |
| `cmd-/` | View Keymap | |

## 3. Composer

The composer sits at the bottom of the thread column. Its status row, left to right, as seen in the running app: project and branch (`agent-lab / main`, which opens the project and branch pickers), a subthread button, a context-usage ring (opens a "Context Window" menu), a light bulb (thinking on/off), the effort level (`Max`), a model-cycling control, the model name (`MoonshotAI: Kimi K3`) and the send button.

### The `/` menu

Typing `/` lists built-in commands followed by skills. Skills show their source (built-in, global, project) so duplicates can be told apart. The built-in commands found in the binary:

| Command | Description shown |
|---|---|
| `/add-project` | Add a project to this thread |
| `/approve` | Approve this thread (in a review) |
| `/request-changes` | Request changes to this thread (in a review) |
| `/review` | Start a review of this thread |
| `/compact` | Compact the current thread (model summary) |
| `/soft-compact` | Compact the thread without relying on an LLM |
| `/change-model` | Open the model picker |
| `/set-thinking-level` | Change the thinking level |
| `/toggle-fast` | Toggle fast mode |
| (fork) | Create an isolated fork with this thread's history |
| `/send-feedback` | Send feedback about Delta |

Choosing a skill attaches the skill's full instructions to the message rather than asking the model to load it. `cmd-enter` in the menu inserts the skill and sends in one step. Skills with `user-invocable: false` are hidden from the menu.

### `@` mentions

The `@` picker (also `ctrl-space`) has four groups: **Delta** ("Ask about using Delta", which routes the question to the help skill), **Files & Directories**, **Threads** and **Users**. Mentions are stored as Markdown links: `[title](delta://thread/<id>)` for threads and `[@](delta://user/<id>)` for people. The agent is told how to read both, to copy user links exactly, and that its own mentions notify no one. Mentioning a person in a message or comment sends them a notification ("Mention and Invitation Notifications" setting).

### Model picker

A search box ("Select a model..."), then models grouped under the provider that serves them (the group header in the running app was "OpenRouter"). Each row has the vendor's mark and a `Vendor: Model` label, for example "Anthropic: Claude Opus 5.5", "OpenAI: GPT-5.6 Sol", "Z.ai: GLM 5.2", "DeepSeek: DeepSeek V4 Pro 0813". The current model has a check mark. A "Filter Model List" button at the bottom edits which models appear. Hovering the model control shows "Change Model, Using MoonshotAI: Kimi K3 via OpenRouter" and "Cycle Favorite Models".

Providers in settings include Anthropic and OpenAI subscriptions, OpenRouter (with provider ordering and an allow-list), Ollama, LM Studio, LiteLLM, xAI, Baseten and Mistral. Custom providers can send extra headers, and `{thread_id}` in a header value is replaced by the requesting thread's ID.

### Modes and toggles

- **Thinking effort.** A per-model list of supported levels (the running app showed `Max`). Some levels force thinking on ("Thinking is always on at this effort level"). Cycle with `ctrl-'`.
- **Fast mode.** "Enables or disables faster model responses" (`cmd-alt-f`, `/toggle-fast`).
- **Runner.** Where turns execute: this machine, another of your machines that has "Run Turns on This Machine" turned on, or a Cloud Runner. Turns from the web client run on one of these.
- **Delegation.** A setting for how readily the agent hands work to subagents; the lowest level is "Only When Asked". Max agents per thread and overall are also settings.

### Attachments and drafts

Pasted images are accepted in PNG, JPEG, WebP, GIF, SVG, BMP, TIFF and ICO; other formats are refused with "Refusing to paste image with unsupported format". Several people can edit the same unsent draft; the user turn records whoever pressed Send as a `[name]: ` prefix the model sees. A draft starting with `?` is addressed to the agent, and `!` at a line start opens an interactive shell instead of sending.

## 4. Rendering the agent's output

Delta does not have an HTML artifact system like Claude.ai's. Rich output comes from a fixed set of Markdown conventions plus a few structured XML blocks that the app parses while the reply streams. All of it is defined in the agent's system prompt and in built-in skills.

### Markdown conventions in the system prompt

The prompt section "Delta renders your messages as markdown" tells the agent to:

- write `<`, `>` and `&` literally, never as HTML entities, because code is shown verbatim;
- use backticks for file, directory, function and class names (these become links that open the file in the right pane, as seen in the running app);
- use LaTeX for math, `$...$` inline and `$$` on its own lines for display (rendered with bundled KaTeX fonts);
- embed images with `![description](source)`, where the source can be `scratch://<path>` (the agent's scratch area), `worktree://<worktree-uuid>/<path>`, an absolute path, or an http(s) URL;
- use GitHub alert blockquotes (`> [!WARNING]`, also NOTE, TIP, IMPORTANT, CAUTION), but only "when an action you took created a risk the user must handle now".

Tables render as real tables (seen in the running app, both in the thread and in the right pane's Markdown view).

### Mermaid diagrams

Fenced ` ```mermaid ` blocks render natively, through a Rust Mermaid renderer bundled in the binary (`merman-render`, themed against mermaid 11.16.1) rather than a webview. Supported types: flowchart/graph, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph, mindmap, timeline, quadrantChart, xychart-beta and journey. Other types show as code. The prompt adds three rules: quote labels that contain punctuation (`A["Fix everyone's bugs"]`), no inline HTML such as `<br/>` in labels, and no `%%{init}%%`, `classDef` or hardcoded colors, because diagrams are recolored to the theme. It also asks for tall rather than wide layouts, since the column is narrow. Diagrams are keyboard-navigable: actions exist to focus a diagram, step to the next or previous node, and exit.

### Structured blocks

| Block | Produced by | What the app shows |
|---|---|---|
| `<change-guide>` with `<excerpt>` and `<related-location/>` | `explain-change` and `change-guide-format` skills | A guided walkthrough of a code change: prose sections, each excerpt replaced by a focused inline diff loaded from the named file and line range, related locations grouped under "Related files". Attributes set the comparison (`branch`, `uncommitted`, or `direct` with commit hashes) and a short imperative title that names the review thread. Excerpts start loading while the reply is still streaming. |
| `<comment-reply>` | System prompt, "Replying to Comments" | The answer is attached to an existing comment thread on a message, file or diff instead of appearing as plain prose. The agent identifies the thread by echoing its `<quote>`, `<file>` or `<context>`. |
| `<land-result outcome="landed\|failed" ...>` | `report-landed` skill | A structured result card for a Land run (target branch, commit, CI status and links), copied into the parent thread. Ordinary prose publishes nothing to the parent. |

### The right pane

The right pane is a full file viewer and editor, with tabs and splits. The running app showed a Markdown file rendered as a document (headings, tables, code blocks), with a breadcrumb (`frontdesk/README.md › # frontdesk`), a version picker (`Latest`), search, an edit toggle, a comment toggle and a menu. Other views that open there:

- **Diffs.** Review Changes shows the thread's changes against a base that can be cycled: branch (against the default branch), uncommitted, or last turn only. Files can be folded and marked seen; Copy Link To Location makes a shareable link to a diff line or comment.
- **Changes panel.** A tree of changed files that opens the review diff.
- **Project panel.** A file tree with copy path, reveal in Finder and so on.
- **Outline.** Symbols of the active file.
- **Subagent and subthread tabs.** Children can open as tabs here or be promoted to the main column.
- **Terminals.** Inline terminals in the thread, plus background terminals listed per thread ("Stop All Background Terminals").
- **Tool output.** File links in tool output open the file at that location (`tools_ui::OpenToolFileAtCursor`).

### Previews

There is no built-in HTML preview pane. Web previews are only described for Cloud Runners: the `cloud-runner-preview` skill tells the agent to bind to `0.0.0.0` and run `delta-runner preview url <port>` to get a stable HTTPS URL that any signed-in user with thread access can open.

## 5. Skills

A skill is a folder with a `SKILL.md` (YAML frontmatter, then instructions), following the Agent Skills format. The system prompt lists available skills in an `<available_skills>` block (name, description, source and, for project skills, the worktree), and the agent loads one with a `skill` tool. A person can attach one directly from the `/` menu.

### Built-in skills

| Skill | Purpose | Invocation |
|---|---|---|
| `create-skill` | Write or update a `SKILL.md`, choosing project or global scope | Model or `/create-skill` |
| `explain-change` | Write a guided walkthrough of an existing change in a sensible reading order, with focused inline diffs | Person only (`disable-model-invocation: true`) |
| `change-guide-format` | The `<change-guide>` output contract that `explain-change` loads first | Hidden from `/`, model only |
| `delta-threads` | Search, read, list, tree, fork and create threads through a `delta_thread` tool (mirrors the `delta thread ...` CLI); explains `merge_worktrees` and thread vs share links | Model or `/delta-threads` |
| `delta-help` | Answer how-to and shortcut questions about Delta, give settings links, edit settings and agent profiles through a `delta_settings` tool; downloads a product guide on use | Hidden; used by Ask Delta and `@Delta` |
| `set-up-land` | Research how a project lands changes, propose a `land` skill in a fixed short format, write it after approval | Started by Land Changes when no Land skill exists |
| `choose-land-skill` | Explain that several skills claim `delta-action: land` and the person must pick one from `/` | Started by Land Changes on ambiguity |
| `report-landed` | Rules for the `<land-result>` block | Hidden, model only |
| `cloud-runner-preview` | Start services and give preview URLs on a Cloud Runner | Hidden, model only |

Embedded help topics also exist outside skills, for example one on connecting MCP servers (OAuth 2.1 under Settings > MCP; the agent is told it cannot do this for the user).

### Scope and frontmatter rules

- **Project skills** live in `.agents/skills/<name>/SKILL.md` in an attached project. A skill with the same name in `.delta/skills` overrides it.
- **Global skills** live in `~/.agents/skills/<name>/SKILL.md`. Settings describes them as available "to every Delta thread and to other compatible agent tools". They need the local machine, so they are not available in the browser or on a Cloud Runner.
- **Built-in skills** ship in the binary. Sources are labelled `builtin`, `global` or `project`.
- `name` is lowercase letters, digits and hyphens, at most 64 bytes, and matches the folder name. `description` is required, at most 1024 bytes, and should say what the skill does and when to use it.
- `user-invocable: false` hides a skill from the `/` menu. `disable-model-invocation: true` means only a person can invoke it; the `skill` tool refuses it.
- `metadata.delta-action: land` marks a skill as the target of the Land Changes button.
- Supporting files sit beside `SKILL.md` and are referenced by relative path. Project skill files are read with `read_file`; global skill files through the terminal.
- Skills that fail to parse are reported as diagnostics ("Delta couldn't load skills for ...") rather than silently skipped.

Related instruction files: project `AGENTS.md`/`AGENT.md` (nested ones apply to their subtree and are supplied automatically by `read_file`), a personal `AGENTS.md` ("Edit Global Rules"), and a project prepare script at `.agents/prepare` ("Create Prepare Script") that sets up a new worktree.

## 6. Panels and layout

The window has three columns: the sidebar, the thread, and the right pane.

**Sidebar (left, `cmd-b`).** Top row: sidebar toggle, search, history (archived threads) and inbox. Then a **Projects** section, with each project's threads nested under it, and a **Threads** section for threads with no project. Threads can be pinned, bookmarked, tagged with colored tags, marked unread, archived and deleted. Child threads nest under their parent with an active-child count, and can be collapsed. Rows show a running indicator, a pulsing title while one is generated, and a Land result ("Landed Changes" or "Failed to Land Changes"). Threads can be dragged. The bottom shows the signed-in user.

**Thread column.** A header with the thread title, a review/checklist control, a Land Changes (rocket) control and a Share button. The transcript has a message rail for jumping between user messages, collapsible tool calls ("Collapse All Tools" setting), inline diffs, terminals, and subagent cards with status (queued, waiting for worktree sync, failed, stopped). Review events appear in the thread as markers: Create review, Approve, Approve with edits, Request changes, Request changes with edits, Merge, Land, Landed, Land Failed. Prose width is adjustable (ruler, centered or full width).

**Right pane (`cmd-r`).** File tabs and splits, the project panel, the changes panel and diff review, subthread tabs, and the file viewer described in section 4. The header has buttons for maximizing, splitting and adding tabs.

**Terminal.** `ctrl-backtick` opens a terminal. The composer's `!` prefix runs a shell inline in the thread. Background terminals keep running per thread and can be stopped together. Agents cannot start background terminals; the prompt tells them to ask the user to move one to the background.

**Status bar.** The composer's bottom row doubles as the status bar (see section 3). A connection indicator shows states such as Offline, Signing in, Connecting, Connected, Connection failed and Update required.

**Presence and following.** Shared threads are live for everyone: participants can read, comment and edit alongside the agent. "Follow Next Collaborator" follows another person's view and cycles through collaborators. Comments can be left on messages, files and diff lines; they are delivered to the agent with the next turn and can be shown or hidden.

**Sharing.** Share Thread (`cmd-shift-s`) makes a join link (`https://delta.dev/join/<id>`), or copies it if the thread is already shared. Copy Share Link copies a link to the cursor position. Join Thread opens a shared link. A "Default Visibility" setting controls new threads. When the agent opens a pull request from a shared thread whose base repository is private, it is told to add an "Open in Delta" link to the PR description.

**Subthreads and review.** Create Review Thread starts a review subthread whose reviewer can approve or request changes, with or without edits. Isolated children keep their changes until merged back with `merge_worktrees`; shared-mode children edit the parent's checkout directly. Revert Conversation to Cursor rewinds a thread; forks can start from any point.

**Land Changes (`cmd-shift-l`).** Opens a Land subthread for the current top-level thread. If the project has exactly one skill with `metadata.delta-action: land`, it runs that skill. If there is none, `set-up-land` researches the repo and proposes one. If there are several, `choose-land-skill` asks the person to pick from `/`. The run ends with a `<land-result>` block that becomes the parent thread's Land status.

**Other surfaces.** Settings pages (Appearance, General, Integrations including GitHub, MCP, LLM Providers, Skills, Subagents and Agent Profiles, Thread, Runners, Experimental), a token and cost usage window, a notification inbox, a feedback form, a log viewer and developer inspectors.

## 7. Features worth adding to syncpi

Ordered by value for the effort, cheapest high-impact first. Sizes: S is about a day, M a few days, L a week or more. Features syncpi already has (HTML and SVG previews, diffs, file `@` completion, attachments, `/compact`) are left out.

| # | Feature | Description | Size |
|---|---|---|---|
| 1 | Mermaid diagrams | Render ` ```mermaid ` blocks in the web view (mermaid.js, themed to light and dark) and add Delta's diagram rules to the agent prompt | S |
| 2 | Rendering rules in the system prompt | Tell the agent what renders: literal `<>&`, backticked file names, KaTeX math, image sources, alerts, mermaid, html/svg blocks | S |
| 3 | Math and alert blocks | KaTeX for `$...$` and `$$`, GitHub-style `> [!WARNING]` alerts | S |
| 4 | Clickable file references | Backticked paths and tool-output paths open the file (or its latest artifact) in the side panel | S |
| 5 | Keymap and command palette | One palette (`cmd-k`) with tabs for commands, files and threads, each command showing its shortcut, plus a searchable keymap sheet (`cmd-/`) | M |
| 6 | Model picker grouped by provider | Search box, vendor marks, provider headers, favorites with a cycle key, thinking effort selector next to it | S |
| 7 | `@` mentions for people and threads | Extend the `@` file completion to members (with a notification) and to other sessions | M |
| 8 | Skills in the `/` menu | List the user's pi skills in `/` completion and attach the full skill to the message on selection, honoring `user-invocable` and `disable-model-invocation` | M |
| 9 | Diff review with a base switcher | A review view of all session changes with branch, uncommitted and last-turn bases, file folding and "seen" marks | M |
| 10 | Comments on messages and diff lines | Select text, comment, deliver comments to the agent with the next turn, and let the agent reply in place with a `<comment-reply>` block | M |
| 11 | Change guide | An `explain-change` style skill and a `<change-guide>` renderer that turns excerpts into focused inline diffs | M |
| 12 | Context usage ring and compaction choices | Show context fill in the status bar, with "summarize now" and a non-LLM soft compaction | S |
| 13 | Thread sidebar | Several threads per project in the desktop app, with pin, bookmark, archive, unread and tags | L |
| 14 | Land Changes | A button that runs a project `land` skill in a child conversation and shows a structured result; offer to write the skill when none exists | L |
| 15 | Review and forks as child threads | Create a review child that can approve or request changes, and forks from any message, merged back explicitly | L |
| 16 | Follow a collaborator | Show who is viewing what, and follow another person's scroll position and open file | M |

Items 1 to 4 build directly on syncpi's existing Markdown and artifact code (`src/web/markdown.ts`, `src/web/artifacts.ts`) and need no server changes. Items 5, 6 and 12 are UI over data the server already sends. Items 13 to 15 need server support for more than one conversation per session.
