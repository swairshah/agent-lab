# One task, end to end, in Delta and in syncpi

On 2026-10-28 we gave both apps the same small job and followed it all the way through, rather than cataloguing
features. The project was `tiny-cart` (in `~/work/agents/delta-lab/`): a cart module with two bugs (quantities
ignored, a 10% discount leaving fractional cents) and two failing tests. The prompt in both was: "The tests in this
project fail. Find the bugs in cart.js, fix them so npm test passes, and explain briefly what was wrong." Delta ran
its default `6.1 Sol` model; syncpi ran pi's default, `openai-codex/gpt-5.6-sol`. Both fixed both bugs.

## What Delta did

**Opening the project.** Add Project (⌘O) refused a folder without a Git remote: "Delta needs one to work with a
repository". With a local bare repository added as `origin`, it accepted it and named the project after the remote
(`tiny-cart-remote`), not the folder. syncpi takes any folder.

**Where the agent works.** Delta never touched the folder we opened. Each thread gets its own checkout inside the
project, `.delta/worktrees/<thread>/<repo>`, cloned through `.delta/clones/` (both ignored through
`.git/info/exclude`). The fix sat uncommitted in that checkout. syncpi's agent edits the project folder itself (or
the VM's copy), and every collaborator's copy syncs to it.

**The run.** As soon as the message was sent, the thread got a short written title ("Fix cart.js bugs and passing
tests"). The thread showed one summary line for the quiet calls ("Listed a directory, read 4 files, ran a command"),
the edit as an open diff of just the changed lines, and `npm test` as a terminal block: its last lines, "Show 7 More
Lines", and the time it took (176ms). Then a short answer naming the file.

**Reviewing.** Review Changes (⌥⇧D) opens a Changes pane with a "Since" menu: Branch (and which one), Last Commit or
Last Turn, each with its +/− counts. Each file has a checkbox for marking it reviewed. Create Review Thread (⌘⇧R)
forks the thread: the fork, nested under its parent in the sidebar, "starts with an isolated copy of the parent
thread's context and changes" and runs the `/explain-change` skill. That skill writes a **change guide**: a title,
sections in plain language ("Count every unit, then discount") with the relevant diffs inline. Delta validates the
guide ("Change guide rejected, retrying"). Submit Review offers Request Changes or Approve; approving put a green
"Approve: Calculate cart totals correctly" entry in the parent thread, and the reviewer's avatar with a check next to
the review.

**Landing.** Land Changes (⌘⇧L, the rocket) forks again, into a landing thread. With no landing setup, the agent
asked how this project lands changes, whether conflicts should be resolved or stop for a person, and then wrote
`.agents/skills/land/SKILL.md`: commit to `main`, push to `origin`, check `origin/main` first, run `npm test`, verify
the push, stop on conflicts. Its frontmatter is what ties it to the button: `metadata: delta-action: land`, plus
`disable-model-invocation: true`, so the agent cannot land on its own; a person picks `/land` from the slash menu
(which also offers "Send in Fork", ⌘⇧↩). It then pushed two commits ("Add project landing skill" and "Fix cart
quantities and round discounted totals to whole cents"), and both threads got a green "Landed: main • 3239769" card;
the landing thread also recorded "External changes: new commit 3239769".

So Delta's loop is: a thread works in its own checkout → a review fork explains the change and is approved → a
landing fork runs the project's own landing skill → each step leaves a card in the parent thread.

## What syncpi did, and what changed

The same prompt, in the app on a fresh copy of the project, finished with the same fix and `npm test` passing.
Three differences were fixed the same day (commit `fa64459`):

- **The edit showed folded.** A row kept the closed state it had while its tool was running, before there was a diff;
  now only a finished row's state carries over, so edits open with their diff, as in Delta.
- **The test output filled the screen.** Long output now shows its last 10 lines under "Show N more lines".
- **The title was the whole first message.** A new thread now gets a short written title, as in Delta.

## What syncpi doesn't have yet, by size

| Delta | syncpi now | What it would take |
|---|---|---|
| Changes "Since" Branch / Last Commit / Last Turn, per-file "reviewed" checkboxes | The thread's changes panel; uncommitted git changes (⇧⌘G) | A "since" choice over the git sheet. The Last Turn base exists: each turn snapshots the files (`src/server/history.ts`), and a file tab's version picker already shows "Before last turn". Small to medium. |
| Review fork running `/explain-change`, a validated change guide, Approve / Request Changes recorded in the parent | Branches (Edit & fork) inside one thread | A "Review changes" command that branches the thread and asks for a change guide (a skill), plus review cards. Medium. |
| Land Changes driven by a project skill (`metadata: delta-action: land`), landing fork, "Landed" card | Stage and commit in the git sheet; no push | A "Land changes" command that runs the project's `land` skill in a branch, or asks the agent to write one, as Delta does. pi already loads skills. Medium. |
| A checkout per thread, so threads don't collide and the opened folder stays as it was | One shared copy per thread, synced to everyone | The biggest difference, and a design choice: syncpi's point is that everyone, and the agent, work on the same files live. Per-thread worktrees would need the sync to follow a worktree, not the folder. Large; worth deciding deliberately. |
| Forks listed under their parent in the sidebar | Branches listed in settings | Show a thread's branches under it in the sidebar. Small. |
| Command blocks with their duration | No timing | Record start and end of each tool call. Small. |
| Requires a pushed Git remote | Any folder | Keep: it's an advantage. |
