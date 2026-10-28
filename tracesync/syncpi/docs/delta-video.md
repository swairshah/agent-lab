# What Delta's launch video shows, and what syncpi can take from it

Source: "Introducing Delta: Code review without pull requests" (`data/`, 8 min). One person works on an issue in
Delta's own repository, pulls in a coworker, reviews and lands the change. Transcribed and checked against frames on
2026-10-28.

## The flow, step by step

1. **Starts from an issue.** "Read DEL-2060 and explain it to me": the agent reads the tracker issue and restates it.
2. **Inline comments on the reply.** Select a line of the agent's answer, comment ("great, do this"; "where should this
   go?"). Several comments go together ("2 comments"), and the agent **answers each one right under it** (a reply arrow
   under the quoted comment), not just in one block at the end.
3. **Links to code** in the answer open the file; the code shows highlighted inline.
4. **"Run the app and take a screenshot"**, before and after the change: the agent runs the app itself and the
   screenshots show inline in the thread ("Show image scratch/after.png").
5. **Share with the org.** The coworker's avatar appears at the top when she joins (from the desktop app or the web
   app; the same link works for both).
6. **You see others typing, live.** "This is just updating in real time as she's typing." Her draft appears as she
   types, not only when she sends.
7. **A group chat with the agent.** Either person can ask the agent; it sees the whole thread.
8. **Follow a collaborator.** He follows her and sees what she sees: she opens the file from the agent's link, and he
   watches her edit the copy in it, live.
9. **The diff.** The "+217 −40" in the status bar opens a full-width diff tab. Each file has a **"Mark file as seen"**
   checkbox; seen files drop out until unchecked. The diff is **relative to main, the last commit, or the last turn**.
   Selecting lines of the diff and commenting puts the comment, with that code, in the thread.
10. **Review subthread.** A guided review: the agent writes a walkthrough of the change for reviewers (the
    `/explain-change` skill), with the main thread's context. The link opens in Delta or the web app. Reviewers
    **Approve / Request changes / Approve with edits**; a reviewer's agent can make the edits in the review's own copy
    of the files, and the author presses **Pull changes** to bring them back.
11. **Land.** The rocket button opens a land subthread running the repo's `/land` skill (push, run CI, resolve
    conflicts, merge without a pull request); the first time, Delta helps write that skill. The thread shows CI
    running and then "Landed on main".
12. **Subthreads** (review, land, subagents) are listed under the thread.
13. **The scrollbar is a map of the thread.** Marks for each turn; clicking one jumps there; hovering shows a summary
    of that turn (who asked, what the agent did, the model) and lets you bookmark it.
14. **Where tools run follows the sender.** Her request ran terminal commands on her machine, because she was in the
    desktop app (no terminal in a browser).

## Where syncpi is

| In the video | syncpi |
|---|---|
| Inline comments on replies, sent together | Yes (comments go at once, one per message) |
| Agent answers each comment under it | No: the reply is one message |
| Links to code, highlighted code | Yes |
| Agent shows the running app | **New today:** `record_browser` (a video of a browser on the VM) |
| Collaborator presence, web and desktop share one link | Yes |
| Live drafts / typing | No |
| Group chat with the agent, tools run on the sender's machine | Yes |
| Follow a collaborator | No |
| Diff from the status bar; mark files seen; since main / last commit / last turn | Partly: Changes panel, git sheet, "Before last turn" for a file |
| Comment on diff lines into the thread | Yes |
| Review subthread, approve, pull changes | No (branches exist) |
| Land button running a `/land` skill | No (pi skills load already) |
| Subthreads under the thread | No (branches are in settings) |
| Scrollbar map with turn summaries | No |
| Mentions and an inbox | Yes |

## Easy to add next (a day or less each)

1. **The scrollbar map.** Marks beside the thread for each message (yours, others', the agent's), click to jump, hover
   for the first line and who wrote it. All the data is in the thread state.
2. **Live typing.** Send drafts as presence (debounced, never stored): "Francisca is typing…" under the thread, or her
   text as it's written, as Delta shows.
3. **Mark files as seen** in the Changes panel and the git sheet, kept per person; the counts in the status bar.
4. **A "+N −M" chip in the status bar** that opens the thread's changes, as in Delta.
5. **Screenshots as well as video:** a `screenshot_browser` tool on the recorder that returns an image the model also
   sees, so it can check its own work, and that shows inline in the thread.
6. **Answers under comments:** when a message carries several comments, ask the agent to answer in `<reply to="n">`
   sections and show each under its comment.

## Bigger

- Follow a collaborator (share each person's open file and scroll position in presence).
- Review subthreads with approve / request changes / pull changes, built on branches.
- A Land button that runs the project's `land` skill in a branch, offering to write it the first time.
- Live co-editing of files (Yjs, planned separately).
- Diff "since main / last commit / last turn" for the whole project.
