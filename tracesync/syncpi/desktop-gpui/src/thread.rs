// A thread, native: drawn like the web view (src/web/thread-view.ts) from the host's snapshot of it
// (/api/sessions/<id>/native: the same thread state the web view renders, src/shared/thread.ts). A person's message
// is one line, their name then what they wrote; the agent's replies are Markdown under the model's mark, thinking
// and tool calls one quiet line each until opened, edits open with their diff, a run of quiet calls is one line
// ("Read 3 files"). The composer is the last row; under it, a status bar says what's happening, with Stop.
//
// Ported in parts from the earlier native app (tag gpui-desktop-final, transcript.rs).
use crate::host::Host;
use crate::theme::{self, MONO, Palette, palette, sz};
use crate::artifact::{self, Kind, Shown};
use crate::keymap::RunCommand;
use crate::{icons, message};
use gpui::{prelude::FluentBuilder, *};
use gpui_component::{
    Icon, IconName,
    input::{Input, InputEvent, InputState},
};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    collections::HashSet,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

// The web view's desktop layout (src/web/style.css, html[data-desktop]): a column up to 820px, left-aligned 16px in,
// a 24px mark beside the agent's rows, 15px text on a 23px line.
const MEASURE: f32 = 820.;
const AVATAR: f32 = 24.;
const GAP: f32 = 14.;
const LEFT: f32 = 16.;
const RIGHT: f32 = 20.;
const LINE: f32 = 23.;

/// The content column's width for this frame (message.rs sizes diagrams by it). Rows get explicit widths: with only
/// percentages and a max width, GPUI measured wrapped text at one width and drew it at another.
static CONTENT: AtomicU32 = AtomicU32::new(782);

pub(crate) fn content_width() -> f32 {
    CONTENT.load(Ordering::Relaxed) as f32
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_owned()
}

fn eid(s: String) -> ElementId {
    ElementId::Name(s.into())
}

thread_local! {
    static TEST_FIND: Cell<bool> = const { Cell::new(false) };
    static TEST_SEND: Cell<bool> = const { Cell::new(false) };
    static TEST_COMMENT: Cell<bool> = const { Cell::new(false) };
    static TEST_TYPE: Cell<bool> = const { Cell::new(false) };
    static TEST_JOIN: Cell<bool> = const { Cell::new(false) };
}

/// What a thread view asks of the app: show this person's side thread, or go back to the thread.
pub enum ThreadEvent {
    Side,
    Back,
    /// The changes chip in the status bar: the panel's Changes.
    Changes,
    /// `!cmd` in the composer: run it in a new terminal.
    Terminal(String),
    /// A slash command that's the app's to run (a command id of src/shared/keymap.json, or "thread.ssh").
    Run(String),
    /// /where: this person's requests run on the VM (true) or this Mac.
    Where(bool),
}

/// The composer's slash commands, as the web view's (src/web/composer.ts COMMANDS): name and what it does.
const COMMANDS: &[(&str, &str)] = &[
    ("invite", "Invite by email, or make a link: [email] [role] [7d|never]"),
    ("session-share", "Make a share link"),
    ("members", "People, roles and invites"),
    ("name", "Change your name"),
    ("role", "Change someone's role: <name> <admin|editor|viewer>"),
    ("remove", "Remove someone from the session"),
    ("links", "Invites that still work"),
    ("revoke", "Revoke an invite"),
    ("compact", "Summarize older messages now"),
    ("new", "Start a new context (admins)"),
    ("tree", "Branches; /tree <n> branches before message n"),
    ("model", "Change the agent's model (admins)"),
    ("settings", "Settings (⌘,)"),
    ("remote", "Run this request on the session VM (keeps going if you close the app): /remote <task>"),
    ("steer", "Add to what the agent is doing, without stopping it: /steer <message>"),
    ("queue", "Send after the agent's current run, without stopping it: /queue <message>"),
    ("stop", "Stop the agent"),
    ("side", "Your private side thread, forked from this one, to ask about it: /side [question], /side new"),
    ("env", "The setup agent's thread"),
    ("land", "Land this thread's changes on main (the project's land skill)"),
    ("changes", "Changes and artifacts"),
    ("sync", "Sync the project with this machine now"),
    ("web", "Open the thread in a browser"),
    ("ssh", "A terminal on the thread's VM"),
    ("quit", "Quit SyncPi"),
    ("where", "Run your requests here or on the VM: /where here, /where vm"),
];

/// What the server takes (src/shared/protocol.ts ATTACHMENT_LIMITS).
const MAX_ATTACHMENTS: usize = 8;
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_TEXT: usize = 256 * 1024;

/// A file to send with the next message: its name, type, and contents in base64.
#[derive(Clone)]
struct Attachment {
    name: String,
    mime: String,
    data: String,
    image: Option<Arc<Image>>,
}

/// Completions under the composer: a slash command, or someone to mention; what to put in place of the word typed.
struct Completion {
    items: Vec<(String, String, String)>,
    selected: usize,
    /// Where the word being completed starts in the composer's text.
    from: usize,
}

pub struct ThreadView {
    id: String,
    host: Host,
    /// "main", the shared thread, or "side": this person's private side thread (/side), a fork of it.
    conv: &'static str,
    /// The thread's state (ThreadState without its items), its items in order, and who's here ({ me, members,
    /// online, target }), kept up to date from the host's stream (/api/sessions/<id>/stream).
    main: Value,
    items: Vec<Value>,
    meta: Value,
    list: ListState,
    composer: Entity<InputState>,
    /// Thinking opened, tool calls opened or closed against their default, groups of quiet calls opened.
    thinking: HashSet<String>,
    toggled: HashSet<String>,
    groups: HashSet<String>,
    /// Images fetched from the host (screenshots), by path: None while one is loading.
    images: Rc<std::cell::RefCell<std::collections::HashMap<String, Option<Arc<Image>>>>>,
    /// The thread's width last frame, measured, for the column.
    width: Rc<Cell<f32>>,
    loaded: bool,
    /// Find (⌘F): its field, the matches (a message's key and the match's place among that message's), the current.
    find: Option<FindBar>,
    /// Each item's row in the list, last frame: Find scrolls to its match's.
    row_of: std::collections::HashMap<String, usize>,
    focus: FocusHandle,
    /// A comment being written on a message's text: the message's key, the quoted text, the block its box goes under.
    comment: Option<(String, String, String)>,
    comment_input: Entity<InputState>,
    /// The host requests, in order (a message, then its draft cleared; draft changes as they were typed).
    worker: std::sync::mpsc::Sender<Job>,
    /// Drafts being written (the host keeps their Yjs documents; runtime.ts draftsNow): owner, name, text, writers.
    drafts: Vec<Value>,
    /// Whose draft the composer writes: someone's it joined (Write together), or this person's (None).
    joined: Option<String>,
    /// The text last written to that draft from here, and how many writes were posted (the host echoes the count it
    /// has, so a stream event from before a write doesn't take back what was just typed).
    written: String,
    writes: u64,
    attachments: Vec<Attachment>,
    completion: Option<Completion>,
    /// What this person last sent from here (↑ in an empty composer brings it back), and a note to show.
    last_sent: String,
    note: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// A request to the host, made in order on the thread view's worker.
enum Job {
    Send(Value),
    Draft { owner: Option<String>, text: String, caret: usize, seq: u64 },
}

struct FindBar {
    input: Entity<InputState>,
    matches: Vec<(String, usize)>,
    current: usize,
    _subscription: Subscription,
}

impl ThreadView {
    pub fn new(id: String, host: Host, conv: &'static str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = if conv == "side" {
            "Ask about the thread. Only you see this. ⌘↩ to send"
        } else if conv == "land" {
            "Tell the land agent something. ⌘↩ to send"
        } else {
            "Message the agent. Enter for a new line, ⌘↩ to send; /side, /queue, /steer, /stop"
        };
        let composer = cx.new(|cx| InputState::new(window, cx).multi_line(true).auto_grow(1, 14).placeholder(placeholder));
        let comment_input = cx.new(|cx| InputState::new(window, cx).multi_line(true).auto_grow(1, 8).placeholder("Comment on this. ⌘↩ to send"));
        let subscriptions = vec![
            cx.subscribe_in(&composer, window, |this, _, event, window, cx| match event {
                // Enter starts a new line; ⌘↩ sends, as in the web view.
                InputEvent::PressEnter { secondary: true } => this.submit(window, cx),
                InputEvent::Change => {
                    this.typed(cx);
                    this.complete(cx);
                }
                _ => {}
            }),
            cx.subscribe_in(&comment_input, window, |this, _, event, window, cx| {
                if let InputEvent::PressEnter { secondary: true } = event {
                    this.send_comment(window, cx);
                }
            }),
        ];
        let (worker, jobs) = std::sync::mpsc::channel::<Job>();
        let worker_host = host.clone();
        let thread_id = id.clone();
        std::thread::spawn(move || {
            while let Ok(mut job) = jobs.recv() {
                // Draft changes typed faster than they're posted: only the last of a run is needed.
                while let Job::Draft { .. } = job {
                    match jobs.try_recv() {
                        Ok(next @ Job::Draft { .. }) => job = next,
                        Ok(next) => {
                            post(&worker_host, &thread_id, job);
                            job = next;
                        }
                        Err(_) => break,
                    }
                }
                post(&worker_host, &thread_id, job);
            }
        });
        // The host's stream, read on a thread of its own; each event reaches the view on the main thread. It ends
        // when the view goes (its receiver with it), and starts again when the host's connection drops.
        let (events, mut received) = futures::channel::mpsc::unbounded::<Value>();
        let stream_host = host.clone();
        let path = format!("/api/sessions/{id}/stream?conv={conv}");
        std::thread::spawn(move || {
            while !events.is_closed() {
                let _ = stream_host.events(&path, |event| events.unbounded_send(event).is_ok());
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        cx.spawn(async move |this, cx| {
            use futures::StreamExt;
            while let Some(event) = received.next().await {
                if this.update(cx, |this, cx| this.apply(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            id,
            host,
            conv,
            main: Value::Null,
            items: Vec::new(),
            meta: Value::Null,
            list: ListState::new(0, ListAlignment::Bottom, px(1200.)),
            composer,
            thinking: HashSet::new(),
            toggled: HashSet::new(),
            groups: HashSet::new(),
            images: Default::default(),
            width: Rc::new(Cell::new(900.)),
            loaded: false,
            find: None,
            row_of: Default::default(),
            focus: cx.focus_handle(),
            comment: None,
            comment_input,
            worker,
            drafts: vec![],
            joined: None,
            written: String::new(),
            writes: 0,
            attachments: vec![],
            completion: None,
            last_sent: String::new(),
            note: None,
            _subscriptions: subscriptions,
        }
    }

    /// One event of the stream: the changed items replace theirs, then the items take the order of `keys`.
    fn apply(&mut self, event: Value, cx: &mut Context<Self>) {
        let mut by_key: std::collections::HashMap<String, Value> = self.items.drain(..).map(|i| (text(&i, "key"), i)).collect();
        for item in event["changed"].as_array().into_iter().flatten() {
            by_key.insert(text(item, "key"), item.clone());
        }
        self.items = event["keys"].as_array().into_iter().flatten().filter_map(|k| by_key.remove(k.as_str()?)).collect();
        self.main = event["state"].clone();
        self.meta = json!({ "me": event["me"], "members": event["members"], "online": event["online"], "target": event["target"], "role": event["role"] });
        self.drafts = event["drafts"].as_array().cloned().unwrap_or_default();
        self.loaded = true;
        if self.find.is_some() {
            self.recount(false, cx);
        }
        cx.notify();
    }

    /// Puts the caret in the composer (the thread was just opened).
    pub fn focus_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |state, cx| state.focus(window, cx));
    }

    /// ⌘F: Find in the thread's messages (people's and the agent's), with the selection's text if there is one.
    fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(find) = &self.find {
            find.input.update(cx, |state, cx| state.focus(window, cx));
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in the thread"));
        let subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
            InputEvent::Change => {
                this.recount(true, cx);
                this.reveal(cx);
            }
            InputEvent::PressEnter { .. } => this.step(1, window, cx),
            _ => {}
        });
        input.update(cx, |state, cx| state.focus(window, cx));
        self.find = Some(FindBar { input, matches: vec![], current: 0, _subscription: subscription });
        cx.notify();
    }

    fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find = None;
        crate::cursor::set_find(None);
        self.focus_composer(window, cx);
        cx.notify();
    }

    fn query(&self, cx: &App) -> String {
        self.find.as_ref().map(|f| f.input.read(cx).value().trim().to_lowercase()).unwrap_or_default()
    }

    /// Counts the matches again (the query changed, or the thread did); `restart` goes back to the first.
    fn recount(&mut self, restart: bool, cx: &mut Context<Self>) {
        let query = self.query(cx);
        let mut matches = vec![];
        for item in &self.items {
            if item["kind"] != "user" && item["kind"] != "assistant" {
                continue;
            }
            let key = text(item, "key");
            for n in 0..crate::cursor::occurrences(&text(item, "text"), &query).len() {
                matches.push((key.clone(), n));
            }
        }
        if let Some(find) = &mut self.find {
            let current = find.matches.get(find.current).cloned();
            find.current = if restart { 0 } else { current.and_then(|c| matches.iter().position(|m| *m == c)).unwrap_or(0) };
            find.matches = matches;
        }
        cx.notify();
    }

    fn step(&mut self, by: isize, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(find) = &mut self.find else { return };
        if find.matches.is_empty() {
            return;
        }
        find.current = (find.current as isize + by).rem_euclid(find.matches.len() as isize) as usize;
        self.reveal(cx);
        cx.notify();
    }

    /// Scrolls the row of item `key` into view (from the inbox); false until the thread has drawn it.
    pub fn reveal_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let Some(&row) = self.row_of.get(key) else { return false };
        self.list.scroll_to_reveal_item(row);
        cx.notify();
        true
    }

    /// What the thread produced, for the panel (edits, files written, HTML and SVG in replies).
    pub fn artifacts(&self) -> Vec<artifact::Art> {
        artifact::thread_artifacts(&self.items)
    }

    /// Whether someone's draft is here to join.
    pub fn has_draft(&self, owner: &str) -> bool {
        self.drafts.iter().any(|d| text(d, "owner") == owner && !text(d, "text").is_empty())
    }

    /// Scrolls the current match's row into view.
    fn reveal(&mut self, cx: &mut Context<Self>) {
        let Some((key, _)) = self.find.as_ref().and_then(|f| f.matches.get(f.current)) else { return };
        if let Some(&row) = self.row_of.get(key) {
            self.list.scroll_to_reveal_item(row);
        }
        cx.notify();
    }

    /// Keys while the thread itself has focus (a press on a message's text put the caret there, as in Delta): arrows
    /// move the caret (Shift selects), Enter comments on the selection (or the caret's line), Esc clears.
    fn thread_key(&mut self, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if key.modifiers.alt || key.modifiers.control || (key.modifiers.platform && key.key != "enter") {
            return false;
        }
        match key.key.as_str() {
            "up" | "down" | "left" | "right" => match crate::cursor::key(&key.key, key.modifiers.shift) {
                crate::cursor::Moved::No => return false,
                crate::cursor::Moved::Yes => {}
                crate::cursor::Moved::Out => self.focus_composer(window, cx),
            },
            "enter" => {
                let Some(quote) = crate::cursor::quote() else { return false };
                self.open_comment(quote, window, cx);
            }
            "escape" => crate::cursor::clear(),
            _ => return false,
        }
        cx.notify();
        true
    }

    fn open_comment(&mut self, quote: (String, String, String), window: &mut Window, cx: &mut Context<Self>) {
        crate::cursor::reveal_box(&quote.2);
        self.comment = Some(quote);
        self.comment_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    fn close_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.comment = None;
        window.focus(&self.focus);
        cx.notify();
    }

    /// ⌘↩ in the comment box: the comment goes out at once, as in the web view, quoting the text it's on, with whatever
    /// is written in the composer.
    fn send_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((message, excerpt, _)) = self.comment.clone() else { return };
        let note = self.comment_input.read(cx).value().trim().to_owned();
        if note.is_empty() {
            return;
        }
        let written = self.composer.read(cx).value().trim().to_owned();
        let mut submit = json!({
            "type": "submit",
            "requestId": request_id(),
            "text": written,
            "mode": "interrupt",
            "where": where_to(),
            "comments": [{ "path": "", "start": 0, "end": 0, "excerpt": excerpt, "text": note, "message": message }],
        });
        if self.conv != "main" {
            submit["conv"] = json!(self.conv);
        }
        self.send(submit, cx);
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        crate::cursor::clear();
        self.comment = None;
        self.focus_composer(window, cx);
        cx.notify();
    }

    /// The box under the text being commented on: the quote, the comment, Cancel and Comment.
    fn comment_box(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let quote = self.comment.as_ref().map(|c| c.1.clone()).unwrap_or_default();
        let shown: String = if quote.chars().count() > 160 { quote.chars().take(160).collect::<String>() + "…" } else { quote };
        let button = |id: &'static str, label: &'static str, primary: bool| {
            div()
                .id(id)
                .px_2()
                .py(px(3.))
                .rounded(px(5.))
                .text_size(sz(12.5))
                .cursor_pointer()
                .when(primary, |d| d.bg(p.accent).text_color(p.accent_ink))
                .when(!primary, |d| d.text_color(p.muted).hover(|s| s.bg(p.sunken).text_color(p.ink)))
                .child(label)
        };
        div()
            .relative()
            .my_1()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .rounded(px(8.))
            .border_1()
            .border_color(p.rule_strong)
            .bg(p.raised)
            .shadow_sm()
            // Just opened: scroll it into view, with a little room below.
            .child(
                canvas(
                    |_, _, _| {},
                    |bounds, _, window, _| {
                        if !crate::cursor::take_reveal_box() {
                            return;
                        }
                        if let Some(list) = crate::cursor::scroll() {
                            let view = list.viewport_bounds();
                            let below = bounds.bottom() + px(40.) - view.bottom();
                            if below > px(0.) {
                                list.scroll_by(below);
                                window.refresh();
                            }
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    this.close_comment(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(div().pl_2().border_l_2().border_color(p.accent).text_size(sz(13.)).text_color(p.ink_2).child(shown))
            .child(Input::new(&self.comment_input).appearance(false).w_full().text_size(sz(14.)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(div().flex_1())
                    .child(button("comment-cancel", "Cancel", false).on_click(cx.listener(|this, _, window, cx| this.close_comment(window, cx))))
                    .child(button("comment-send", "Comment", true).on_click(cx.listener(|this, _, window, cx| this.send_comment(window, cx)))),
            )
            .into_any_element()
    }

    fn command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        match action.id.as_ref() {
            "find.open" => self.open_find(window, cx),
            "find.next" if self.find.is_some() => self.step(1, window, cx),
            "find.previous" if self.find.is_some() => self.step(-1, window, cx),
            _ => cx.propagate(),
        }
    }

    fn find_bar(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(find) = &self.find else { return div().into_any_element() };
        let count = if find.matches.is_empty() { "0/0".to_owned() } else { format!("{}/{}", find.current + 1, find.matches.len()) };
        let button = |id: &'static str, icon: IconName| {
            div().id(id).p(px(4.)).rounded(px(5.)).text_color(p.muted).cursor_pointer().hover(|s| s.bg(p.sunken).text_color(p.ink)).child(Icon::new(icon).size(px(14.)))
        };
        div()
            .h(px(40.))
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .pl(px(LEFT))
            .pr_2()
            .border_b_1()
            .border_color(p.rule)
            .bg(p.surface)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    this.close_find(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(div().text_size(sz(12.5)).text_color(p.muted).child("Conversation"))
            .child(div().flex_1().child(Input::new(&find.input).appearance(true).text_size(sz(13.5))))
            .child(div().w(px(56.)).text_right().font_family(MONO).text_size(sz(12.)).text_color(p.muted).child(count))
            .child(button("find-previous", IconName::ChevronUp).on_click(cx.listener(|this, _, window, cx| this.step(-1, window, cx))))
            .child(button("find-next", IconName::ChevronDown).on_click(cx.listener(|this, _, window, cx| this.step(1, window, cx))))
            .child(button("find-close", IconName::Close).on_click(cx.listener(|this, _, window, cx| this.close_find(window, cx))))
            .into_any_element()
    }

    fn send(&self, message: Value, _cx: &mut Context<Self>) {
        let _ = self.worker.send(Job::Send(message));
    }

    fn me(&self) -> String {
        text(&self.meta["me"], "id")
    }

    /// The draft the composer writes: one it joined, or this person's.
    fn draft_owner(&self) -> String {
        self.joined.clone().unwrap_or_else(|| self.me())
    }

    /// The composer changed: the same text goes into the shared draft, for everyone (not in a side thread, which is
    /// private; and a question for it stops at "/side" for the others, as in the web view).
    fn typed(&mut self, cx: &mut Context<Self>) {
        if self.conv != "main" || self.meta["role"] == "viewer" {
            return;
        }
        let state = self.composer.read(cx);
        let value = state.value().to_string();
        let caret = utf16_len(&value[..state.cursor().min(value.len())]);
        let shared = if value.trim_start().starts_with("/side") { "/side".to_owned() } else { value };
        self.put_draft(shared, caret);
    }

    fn put_draft(&mut self, text: String, caret: usize) {
        if text == self.written {
            return;
        }
        self.written = text.clone();
        self.writes += 1;
        let _ = self.worker.send(Job::Draft { owner: self.joined.clone(), text, caret, seq: self.writes });
    }

    /// The draft as the others changed it (someone writing it with you, or sending it): into the composer, keeping
    /// the cursor where it was in the text around it. Only once the host has had every write from here.
    fn adopt_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.conv != "main" || !self.loaded || self.meta["me"].is_null() {
            return;
        }
        let owner = self.draft_owner();
        let draft = self.drafts.iter().find(|d| text(d, "owner") == owner).cloned();
        // A draft you joined was sent or cleared: back to yours.
        if self.joined.is_some() && draft.as_ref().is_none_or(|d| text(d, "text").is_empty()) {
            self.joined = None;
            self.written = String::new();
            self.composer.update(cx, |state, cx| state.set_value("", window, cx));
            return self.adopt_draft(window, cx);
        }
        let Some(draft) = draft else { return };
        if draft["seq"].as_u64().unwrap_or(0) < self.writes {
            return;
        }
        let remote = text(&draft, "text");
        let current = self.composer.read(cx).value().to_string();
        if remote == self.written || current != self.written && !self.written.is_empty() || remote == current {
            return;
        }
        let cursor = self.composer.read(cx).cursor().min(current.len());
        // Where the cursor goes: same place if the change was after it, moved by its size if before.
        let common = current.bytes().zip(remote.bytes()).take_while(|(a, b)| a == b).count();
        let mut at = if cursor <= common { cursor } else { (cursor as isize + remote.len() as isize - current.len() as isize).max(0) as usize };
        at = at.min(remote.len());
        while !remote.is_char_boundary(at) {
            at -= 1;
        }
        self.written = remote.clone();
        let focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        self.composer.update(cx, |state, cx| {
            state.set_value(remote.clone(), window, cx);
            if focused {
                let before = &remote[..at];
                let line = before.matches('\n').count() as u32;
                let character = before.rsplit('\n').next().unwrap_or("").chars().count() as u32;
                state.set_cursor_position(gpui_component::input::Position { line, character }, window, cx);
            }
        });
    }

    /// Write together: the composer writes `owner`'s draft with them; yours waits as you left it.
    pub fn join_draft(&mut self, owner: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.drafts.iter().find(|d| text(d, "owner") == owner) else { return };
        let body = text(draft, "text");
        self.joined = Some(owner);
        self.written = body.clone();
        self.composer.update(cx, |state, cx| {
            state.set_value(body, window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    fn leave_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.joined = None;
        self.written = String::new();
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        self.adopt_draft(window, cx);
        cx.notify();
    }

    /// Above the composer: whose draft it's writing when it isn't yours, or who's writing yours with you.
    fn draft_with(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.conv != "main" {
            return None;
        }
        let owner = self.draft_owner();
        let draft = self.drafts.iter().find(|d| text(d, "owner") == owner)?;
        let others: Vec<String> = draft["writers"].as_array().into_iter().flatten().map(|w| text(w, "name")).filter(|n| !n.is_empty()).collect();
        let label = match &self.joined {
            Some(_) => format!("Writing {}'s draft{}", text(draft, "name"), if others.len() > 1 { format!(" with {}", others.join(", ")) } else { String::new() }),
            None if !others.is_empty() => format!("Writing with {}", others.join(", ")),
            None => return None,
        };
        Some(
            div()
                .flex()
                .items_center()
                .gap_2()
                .mb_1()
                .text_size(sz(12.5))
                .text_color(p.muted)
                .child(label)
                .when(self.joined.is_some(), |d| {
                    d.child(
                        div()
                            .id("draft-back")
                            .px_1()
                            .rounded(px(4.))
                            .text_color(p.accent)
                            .cursor_pointer()
                            .hover(|s| s.bg(p.sunken))
                            .child("Back to yours")
                            .on_click(cx.listener(|this, _, window, cx| this.leave_draft(window, cx))),
                    )
                })
                .into_any_element(),
        )
    }

    /// Others' drafts as they write them, at the end of the thread, as in Delta: who, "typing…" (or who they're
    /// writing with), the text with the others' cursors in it, and Write together for editors. Not commands.
    fn typing_rows(&self, p: &Palette, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if self.conv != "main" {
            return vec![];
        }
        let (me, mine) = (self.me(), self.draft_owner());
        let can_write = matches!(self.meta["role"].as_str(), Some("editor" | "admin"));
        let mut rows = vec![];
        for draft in &self.drafts {
            let owner = text(draft, "owner");
            let body = text(draft, "text");
            if owner == me || owner == mine || body.trim().is_empty() || body.trim_start().starts_with(['/', '!']) {
                continue;
            }
            let name = self.name_of(&owner, text(draft, "name"));
            let others: Vec<String> = draft["writers"].as_array().into_iter().flatten().filter(|w| text(w, "id") != owner).map(|w| text(w, "name")).collect();
            let status = if others.is_empty() { "typing…".to_owned() } else { format!("writing with {}…", others.join(", ")) };
            // The others' cursors, as a bar in their color where each is.
            let mut carets: Vec<(usize, String)> = draft["writers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|w| text(w, "id") != me)
                .map(|w| (byte_of_utf16(&body, w["caret"].as_u64().unwrap_or(0) as usize), text(w, "name")))
                .collect();
            carets.sort();
            let mut line = div().flex().flex_wrap().items_baseline().whitespace_normal();
            let mut from = 0;
            for (at, who) in carets {
                if at < from {
                    continue;
                }
                line = line.child(body[from..at].to_owned()).child(div().w(px(2.)).h(px(17.)).bg(theme::person_color(&who, p.dark)));
                from = at;
            }
            line = line.child(body[from..].to_owned());
            let joining = owner.clone();
            rows.push(
                div()
                    .w(px(content_width() + AVATAR + GAP))
                    .flex()
                    .items_start()
                    .gap(px(12.))
                    .child(div().flex_none().text_size(sz(13.5)).line_height(sz(LINE)).font_weight(FontWeight::SEMIBOLD).text_color(theme::person_color(&name, p.dark)).child(name.clone()))
                    .child(div().flex_1().min_w_0().text_size(sz(15.)).line_height(sz(LINE)).text_color(p.ink_2).child(line))
                    .child(div().flex_none().text_size(sz(12.5)).line_height(sz(LINE)).text_color(p.faint).child(status))
                    .when(can_write, |d| {
                        d.child(
                            div()
                                .id(eid(format!("join-{owner}")))
                                .flex_none()
                                .px_2()
                                .rounded(px(5.))
                                .text_size(sz(12.5))
                                .line_height(sz(LINE))
                                .text_color(p.accent)
                                .cursor_pointer()
                                .hover(|s| s.bg(p.sunken))
                                .child("Write together")
                                .on_click(cx.listener(move |this, _, window, cx| this.join_draft(joining.clone(), window, cx))),
                        )
                    })
                    .into_any_element(),
            );
        }
        rows
    }

    /// ⌘↩: the composer's text to the agent. As in the web view, it stops the run in progress (when this person may)
    /// and runs on this Mac. /queue waits for the run instead, /steer joins it, /stop stops it, and /side [new]
    /// [question] opens this person's side thread (forked again with "new"), asking it the question.
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        self.completion = None;
        self.note = None;
        // `!cmd`: a command for a new terminal on this Mac, not a message.
        if let Some(command) = text.strip_prefix('!').map(str::trim).filter(|c| !c.is_empty()) {
            cx.emit(ThreadEvent::Terminal(command.to_owned()));
            self.composer.update(cx, |state, cx| state.set_value("", window, cx));
            return;
        }
        // What was written together goes out for everyone who wrote it (the server reads the draft's writers), and
        // the draft is emptied after it.
        let draft = (self.conv == "main" && !text.starts_with('/')).then(|| self.draft_owner());
        let (command, rest) = match text.strip_prefix('/') {
            Some(after) => {
                let (word, rest) = after.split_once(char::is_whitespace).unwrap_or((after, ""));
                (word, rest.trim().to_owned())
            }
            None => ("", text.clone()),
        };
        let mut conv = if self.conv == "main" { Value::Null } else { json!(self.conv) };
        let (command, rest) = if self.attachments.is_empty() || matches!(command, "" | "queue" | "steer" | "remote") { (command, rest) } else { ("", text.clone()) };
        let words: Vec<String> = rest.split_whitespace().map(str::to_owned).collect();
        let member = |this: &Self, query: &str| -> String {
            this.meta["members"].as_array().into_iter().flatten().find(|m| self::text(m, "name") == query || self::text(m, "email") == query || self::text(m, "id") == query).map(|m| self::text(m, "id")).unwrap_or_else(|| query.to_owned())
        };
        match command {
            "invite" => match parse_invite(&rest) {
                Ok(mut invite) => {
                    invite["type"] = json!("invite");
                    self.send(invite, cx);
                    self.note = Some("Invite made: it's in Settings → People".into());
                }
                Err(e) => return self.say(e, cx),
            },
            "session-share" => cx.emit(ThreadEvent::Run("thread.share".into())),
            "members" | "links" => cx.emit(ThreadEvent::Run("view.people".into())),
            "settings" | "model" => cx.emit(ThreadEvent::Run("app.settings".into())),
            "name" if !rest.is_empty() => self.send(json!({ "type": "rename", "name": rest }), cx),
            "role" if words.len() == 2 => {
                let id = member(self, &words[0]);
                self.send(json!({ "type": "setRole", "memberId": id, "role": words[1] }), cx);
            }
            "remove" if !rest.is_empty() => {
                let id = member(self, &rest);
                self.send(json!({ "type": "remove", "memberId": id }), cx);
            }
            "revoke" if !rest.is_empty() => self.send(json!({ "type": "revoke", "code": rest }), cx),
            "compact" if !rest.is_empty() => self.send(json!({ "type": "compact", "instructions": rest }), cx),
            "compact" => cx.emit(ThreadEvent::Run("agent.compact".into())),
            "new" => cx.emit(ThreadEvent::Run("agent.newContext".into())),
            "tree" => match rest.parse::<usize>() {
                // Before the nth message people sent: the thread branches there, and the message comes back to edit.
                Ok(n) => {
                    let users: Vec<&Value> = self.items.iter().filter(|i| i["kind"] == "user" && self::text(i, "key").chars().all(|c| c.is_ascii_digit())).collect();
                    match users.get(n.wrapping_sub(1)) {
                        Some(item) => {
                            let (key, body) = (self::text(item, "key"), self::text(item, "text"));
                            return self.fork(key, body, window, cx);
                        }
                        None => return self.say(format!("There's no message {n}."), cx),
                    }
                }
                Err(_) => cx.emit(ThreadEvent::Run("agent.branches".into())),
            },
            "remote" => {
                if rest.is_empty() {
                    return self.say("Say what to do: /remote <task>".into(), cx);
                }
                let mut message = json!({ "type": "submit", "requestId": request_id(), "text": rest, "mode": "interrupt", "where": "vm" });
                self.attach(&mut message);
                self.send(message, cx);
            }
            "env" => cx.emit(ThreadEvent::Run("agent.setup".into())),
            "land" => cx.emit(ThreadEvent::Run("agent.land".into())),
            "changes" => cx.emit(ThreadEvent::Run("view.changes".into())),
            "sync" => cx.emit(ThreadEvent::Run("project.sync".into())),
            "web" => cx.emit(ThreadEvent::Run("project.web".into())),
            "quit" => cx.emit(ThreadEvent::Run("app.quit".into())),
            "ssh" => cx.emit(ThreadEvent::Run("thread.ssh".into())),
            "where" => match rest.as_str() {
                "vm" => cx.emit(ThreadEvent::Where(true)),
                "here" | "device" | "mac" => cx.emit(ThreadEvent::Where(false)),
                _ => return self.say("Use /where here or /where vm".into(), cx),
            },
            "stop" => self.stop(cx),
            "side" => {
                let fresh = rest == "new" || rest.starts_with("new ");
                let question = if fresh { rest.trim_start_matches("new").trim().to_owned() } else { rest };
                let mut message = json!({ "type": "side", "requestId": request_id(), "where": where_to() });
                if fresh {
                    message["fresh"] = json!(true);
                }
                if !question.is_empty() {
                    message["text"] = json!(question);
                }
                self.send(message, cx);
                cx.emit(ThreadEvent::Side);
            }
            "queue" | "steer" | "" => {
                if rest.is_empty() && self.attachments.is_empty() {
                    return;
                }
                let mode = match command {
                    "queue" => "followUp",
                    "steer" => "steer",
                    _ => "interrupt",
                };
                let mut message = json!({ "type": "submit", "requestId": request_id(), "text": rest, "mode": mode, "where": where_to() });
                if !conv.is_null() {
                    message["conv"] = conv.take();
                }
                self.attach(&mut message);
                if let Some(owner) = &draft {
                    message["draft"] = json!(owner);
                }
                self.send(message, cx);
            }
            // Anything else goes as written (a message that starts with a slash).
            _ => self.send(json!({ "type": "submit", "requestId": request_id(), "text": text, "mode": "interrupt", "where": where_to(), "conv": conv }), cx),
        }
        if !text.is_empty() {
            self.last_sent = text.clone();
        }
        self.attachments.clear();
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        if self.conv == "main" {
            self.put_draft(String::new(), 0);
            if self.joined.is_some() {
                self.joined = None;
                self.written = String::new();
            }
        }
    }

    /// A note under the composer (a command's usage, why a file wasn't attached).
    fn say(&mut self, note: String, cx: &mut Context<Self>) {
        self.note = Some(note);
        cx.notify();
    }

    fn attach(&mut self, message: &mut Value) {
        if !self.attachments.is_empty() {
            message["attachments"] = Value::Array(self.attachments.iter().map(|a| json!({ "name": a.name, "mimeType": a.mime, "data": a.data })).collect());
        }
    }

    /// Edit & fork (admins): the thread branches just before message `key`, and its text comes back to edit.
    fn fork(&mut self, key: String, body: String, window: &mut Window, cx: &mut Context<Self>) {
        self.send(json!({ "type": "fork", "before": key }), cx);
        self.composer.update(cx, |state, cx| {
            state.set_value(body, window, cx);
            state.focus(window, cx);
        });
    }

    /// Files dropped on the thread, or an image pasted: attached to the next message, within the server's limits.
    pub fn add_files(&mut self, paths: &[std::path::PathBuf], cx: &mut Context<Self>) {
        for path in paths {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            match std::fs::read(path) {
                Ok(bytes) => self.add_bytes(name, bytes, cx),
                Err(e) => self.say(format!("Couldn't read {name}: {e}"), cx),
            }
        }
    }

    fn add_bytes(&mut self, name: String, bytes: Vec<u8>, cx: &mut Context<Self>) {
        if self.attachments.len() >= MAX_ATTACHMENTS {
            return self.say(format!("At most {MAX_ATTACHMENTS} files at a time."), cx);
        }
        let mime = match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "text/plain",
        };
        let is_image = mime.starts_with("image/");
        if is_image && bytes.len() > MAX_IMAGE {
            return self.say(format!("{name} is larger than {} MB", MAX_IMAGE / 1024 / 1024), cx);
        }
        if !is_image && (bytes.len() > MAX_TEXT || std::str::from_utf8(&bytes).is_err()) {
            return self.say(format!("{name} isn't text, or is larger than {} KB", MAX_TEXT / 1024), cx);
        }
        let image = is_image.then(|| Arc::new(Image::from_bytes(artifact::image_format(&name), bytes.clone())));
        self.attachments.push(Attachment { name, mime: mime.into(), data: base64(&bytes), image });
        self.note = None;
        cx.notify();
    }

    /// Completions for the word being typed: a slash command at the start, or @someone.
    fn complete(&mut self, cx: &mut Context<Self>) {
        let state = self.composer.read(cx);
        let value = state.value().to_string();
        let caret = state.cursor().min(value.len());
        let before = &value[..caret];
        let word_start = before.rfind(char::is_whitespace).map(|i| i + 1).unwrap_or(0);
        let word = &before[word_start..];
        let items: Vec<(String, String, String)> = if word_start == 0 && word.starts_with('/') && !before.contains('\n') {
            let typed = &word[1..];
            COMMANDS.iter().filter(|(name, _)| name.starts_with(typed)).map(|(name, about)| (format!("/{name}"), about.to_string(), format!("/{name} "))).collect()
        } else if let Some(typed) = word.strip_prefix('@') {
            let me = text(&self.meta["me"], "id");
            self.meta["members"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| text(m, "id") != me && text(m, "name").to_lowercase().starts_with(&typed.to_lowercase()))
                .map(|m| (format!("@{}", text(m, "name")), text(m, "role"), format!("@{} ", text(m, "name"))))
                .collect()
        } else {
            vec![]
        };
        let fresh = !items.is_empty() && !(items.len() == 1 && items[0].0 == word);
        self.completion = fresh.then(|| Completion { items, selected: 0, from: word_start });
        cx.notify();
    }

    fn accept_completion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(completion) = self.completion.take() else { return };
        let Some((_, _, insert)) = completion.items.get(completion.selected).cloned() else { return };
        let value = self.composer.read(cx).value().to_string();
        let caret = self.composer.read(cx).cursor().min(value.len());
        let next = format!("{}{insert}{}", &value[..completion.from], &value[caret..]);
        let at = completion.from + insert.len();
        self.composer.update(cx, |state, cx| {
            state.set_value(next.clone(), window, cx);
            let before = &next[..at];
            let line = before.matches('\n').count() as u32;
            let character = before.rsplit('\n').next().unwrap_or("").chars().count() as u32;
            state.set_cursor_position(gpui_component::input::Position { line, character }, window, cx);
        });
        self.completion = None;
        cx.notify();
    }

    /// Keys the composer's completions and attachments take before the text field: arrows and Tab or Enter in the
    /// list, Esc to close it, ⌘V with an image, ↑ in an empty composer for the last message.
    fn composer_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let m = event.keystroke.modifiers;
        if let Some(completion) = &mut self.completion {
            let count = completion.items.len();
            match key {
                "down" => completion.selected = (completion.selected + 1) % count,
                "up" => completion.selected = (completion.selected + count - 1) % count,
                "tab" => return { self.accept_completion(window, cx); cx.stop_propagation() },
                "enter" if !m.platform => return { self.accept_completion(window, cx); cx.stop_propagation() },
                "escape" => self.completion = None,
                _ => return,
            }
            cx.stop_propagation();
            return cx.notify();
        }
        if m.platform && key == "v"
            && let Some(item) = cx.read_from_clipboard()
            && let Some(image) = item.entries().iter().find_map(|e| if let ClipboardEntry::Image(image) = e { Some(image.clone()) } else { None })
        {
            let extension = match image.format {
                ImageFormat::Jpeg => "jpg",
                ImageFormat::Gif => "gif",
                ImageFormat::Webp => "webp",
                _ => "png",
            };
            self.add_bytes(format!("pasted.{extension}"), image.bytes.clone(), cx);
            return cx.stop_propagation();
        }
        if key == "up" && !m.modified() && self.composer.read(cx).value().is_empty() && !self.last_sent.is_empty() {
            let last = self.last_sent.clone();
            self.composer.update(cx, |state, cx| state.set_value(last, window, cx));
            cx.stop_propagation();
        }
    }

    /// Under the composer: completions, files to send, a note.
    fn composer_extras(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        let mut extras = div().flex().flex_col().gap_1();
        if !self.attachments.is_empty() {
            let mut chips = div().flex().flex_wrap().gap_2().pt_1();
            for (n, a) in self.attachments.iter().enumerate() {
                chips = chips.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .pl_1()
                        .pr(px(4.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.rule)
                        .bg(p.raised)
                        .text_size(sz(12.))
                        .children(a.image.clone().map(|image| img(image).size(px(28.)).rounded(px(4.)).object_fit(ObjectFit::Cover)))
                        .child(div().max_w(px(200.)).truncate().child(a.name.clone()))
                        .child(
                            div()
                                .id(eid(format!("detach-{n}")))
                                .text_color(p.muted)
                                .cursor_pointer()
                                .child(Icon::new(IconName::Close).size(px(11.)))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if n < this.attachments.len() {
                                        this.attachments.remove(n);
                                    }
                                    cx.notify();
                                })),
                        ),
                );
            }
            extras = extras.child(chips);
        }
        if let Some(completion) = &self.completion {
            let mut list = div().mt_1().flex().flex_col().py_1().rounded(px(8.)).border_1().border_color(p.rule).bg(p.raised).shadow_md().max_h(px(240.)).overflow_hidden();
            for (n, (label, detail, _)) in completion.items.iter().enumerate().take(9) {
                let on = n == completion.selected;
                list = list.child(
                    div()
                        .id(eid(format!("completion-{n}")))
                        .flex()
                        .gap_3()
                        .px_3()
                        .py(px(4.))
                        .cursor_pointer()
                        .when(on, |d| d.bg(p.sunken))
                        .child(div().flex_none().font_family(MONO).text_size(sz(12.5)).text_color(p.ink).child(label.clone()))
                        .child(div().flex_1().min_w_0().truncate().text_size(sz(12.5)).text_color(p.muted).child(detail.clone()))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(c) = &mut this.completion {
                                c.selected = n;
                            }
                            this.accept_completion(window, cx);
                        })),
                );
            }
            extras = extras.child(list);
        }
        if let Some(note) = &self.note {
            extras = extras.child(div().text_size(sz(12.5)).text_color(p.warn).child(note.clone()));
        }
        extras
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        let mut message = json!({ "type": "abort" });
        if self.conv == "side" || self.conv == "land" {
            message["conv"] = json!(self.conv);
        }
        self.send(message, cx);
    }

    /// A message to the thread's server, from the app (a model change, compacting, landing…).
    pub fn post(&self, message: Value, cx: &mut Context<Self>) {
        self.send(message, cx);
    }

    /// The thread's model and thinking level.
    pub fn model(&self) -> (String, String) {
        (text(&self.main, "model"), text(&self.main, "thinkingLevel"))
    }

    pub fn role(&self) -> String {
        text(&self.meta, "role")
    }

    /// Over a side thread: whose it is, Start over (fork it again from the thread as it is now), Back. Over the setup
    /// or land agent's thread: what it is, Back.
    fn side_banner(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        if self.conv == "setup" || self.conv == "land" {
            let what = if self.conv == "setup" { "The setup agent's thread: how this project's environment was prepared" } else { "The land agent's thread: getting this thread's changes onto main" };
            return div()
                .h(px(38.))
                .flex_none()
                .flex()
                .items_center()
                .gap_2()
                .pl(px(LEFT))
                .pr_2()
                .border_b_1()
                .border_color(p.rule)
                .bg(p.sunken)
                .text_size(sz(12.5))
                .child(div().flex_1().text_color(p.ink_2).child(what))
                .child(
                    div()
                        .id("aside-back")
                        .px_2()
                        .py(px(3.))
                        .rounded(px(5.))
                        .text_color(p.ink_2)
                        .cursor_pointer()
                        .hover(|s| s.bg(p.rule).text_color(p.ink))
                        .child("Back to the thread")
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ThreadEvent::Back))),
                )
                .into_any_element();
        }
        if self.conv != "side" {
            return div().into_any_element();
        }
        let button = |id: &'static str, label: &'static str| {
            div().id(id).px_2().py(px(3.)).rounded(px(5.)).text_color(p.ink_2).cursor_pointer().hover(|s| s.bg(p.sunken).text_color(p.ink)).child(label)
        };
        div()
            .h(px(38.))
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .pl(px(LEFT))
            .pr_2()
            .border_b_1()
            .border_color(p.rule)
            .bg(p.accent_soft)
            .text_size(sz(12.5))
            .child(div().flex_1().text_color(p.ink_2).child("Your side thread · only you see it, and it can't change files"))
            .child(button("side-fresh", "Start over").on_click(cx.listener(|this, _, _, cx| {
                this.send(json!({ "type": "side", "requestId": request_id(), "fresh": true, "where": where_to() }), cx);
            })))
            .child(button("side-back", "Back to the thread").on_click(cx.listener(|_, _, _, cx| cx.emit(ThreadEvent::Back))))
            .into_any_element()
    }

    /// An image the host serves, fetched once (in the background) and kept; None until it has arrived.
    fn remote_image(&self, path: String, format: ImageFormat, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        if let Some(found) = self.images.borrow().get(&path) {
            return found.clone();
        }
        self.images.borrow_mut().insert(path.clone(), None);
        let host = self.host.clone();
        let images = self.images.clone();
        cx.spawn(async move |this, cx| {
            let fetched = cx.background_executor().spawn({
                let path = path.clone();
                async move { host.bytes(&path) }
            });
            if let Ok(bytes) = fetched.await {
                images.borrow_mut().insert(path, Some(Arc::new(Image::from_bytes(format, bytes))));
                let _ = this.update(cx, |_, cx| cx.notify());
            }
        })
        .detach();
        None
    }

    /// A screenshot or recording from the agent's browser tools (on the VM), served through the host.
    fn recording(&self, name: &str) -> String {
        let file = name.rsplit('/').next().unwrap_or(name);
        format!("/session/{}/api/recording?name={}", self.id, file)
    }

    /// A tool call's artifact, shown under its line: a file it wrote (HTML, SVG, Markdown), a screenshot, a recording.
    fn tool_artifact(&self, item: &Value, key: &str, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let tool = text(item, "name");
        let args = &item["args"];
        let details = &item["details"];
        if tool == "write" {
            let path = args["path"].as_str().or(args["file_path"].as_str())?.to_owned();
            let content = args["content"].as_str()?.to_owned();
            let kind = artifact::kind_of_path(&path);
            return match kind {
                Kind::Svg => {
                    let (image, natural) = artifact::svg_image(&content);
                    Some(artifact::card(format!("art-{key}"), kind, path.clone(), artifact::picture(image.clone(), 320., natural), Some(Shown::Image { title: path, image }), p))
                }
                Kind::Html => Some(artifact::card(format!("art-{key}"), kind, path.clone(), artifact::excerpt("html", &content, cx), Some(Shown::Html { title: path, content }), p)),
                Kind::Markdown => {
                    let body = div()
                        .id(eid(format!("md-{key}")))
                        .max_h(px(360.))
                        .overflow_y_scroll()
                        .px(px(14.))
                        .py(px(10.))
                        .text_size(sz(14.))
                        .line_height(sz(22.))
                        .child(message::render(&format!("md-{key}"), &content, window, cx))
                        .into_any_element();
                    Some(artifact::card(format!("art-{key}"), kind, path.clone(), body, Some(Shown::Markdown { title: path, content }), p))
                }
                _ => None,
            };
        }
        if tool == "screenshot_browser" {
            let name = details["image"].as_str()?.to_owned();
            let title = args["title"].as_str().unwrap_or("Screenshot").to_owned();
            let path = self.recording(&name);
            let body = match self.remote_image(path, artifact::image_format(&name), cx) {
                Some(image) => {
                    return Some(artifact::card(format!("art-{key}"), Kind::Image, title.clone(), artifact::picture(image.clone(), 420., None), Some(Shown::Image { title, image }), p));
                }
                None => div().p_3().text_size(sz(12.5)).text_color(p.muted).child("Loading the screenshot…").into_any_element(),
            };
            return Some(artifact::card(format!("art-{key}"), Kind::Image, title, body, None, p));
        }
        if tool == "record_browser" {
            let video = details["video"].as_str()?.to_owned();
            let title = args["title"].as_str().unwrap_or("Recording").to_owned();
            let poster = details["poster"].as_str().map(|poster| (self.recording(poster), poster.to_owned()));
            let body = match poster.and_then(|(path, name)| self.remote_image(path, artifact::image_format(&name), cx)) {
                Some(image) => artifact::picture(image, 320., None),
                None => div().p_3().text_size(sz(12.5)).text_color(p.muted).child("A recording: Open plays it.").into_any_element(),
            };
            let url = format!("{}{}", self.host.origin, self.recording(&video));
            return Some(artifact::card(format!("art-{key}"), Kind::Image, title.clone(), body, Some(Shown::Page { title, url }), p));
        }
        None
    }

    fn name_of(&self, member: &str, fallback: String) -> String {
        self.meta["members"]
            .as_array()
            .and_then(|m| m.iter().find(|m| text(m, "id") == member))
            .map(|m| text(m, "name"))
            .unwrap_or(fallback)
    }

    fn user_row(&self, item: &Value, key: &str, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let name = self.name_of(&text(item, "memberId"), item["author"].as_str().unwrap_or("someone").to_owned());
        let color = theme::person_color(&name, p.dark);
        let body = text(item, "text");
        // The comments first, then what was written with them, as Delta shows it (thread-view.ts #user).
        let comments: Vec<Value> = item["comments"].as_array().cloned().unwrap_or_default();
        let mut content = div().flex_1().min_w_0().flex().flex_col().gap_2().text_size(sz(15.)).line_height(sz(LINE));
        if !comments.is_empty() {
            let mut cards = div().flex().flex_col().gap_2();
            for c in &comments {
                cards = cards.child(comment_card(c, &name, p));
            }
            content = content.child(cards);
        }
        if !body.is_empty() {
            content = content.child(message::render(&format!("user-{key}"), &keep_breaks(&body), window, cx));
        }
        // What was sent with it: images (served by the host) and files.
        let attached: Vec<Value> = item["attachments"].as_array().cloned().unwrap_or_default();
        if !attached.is_empty() {
            let mut files = div().flex().flex_wrap().gap_2();
            for a in attached {
                let name = text(&a, "name");
                let image = a["url"].as_str().filter(|_| a["kind"] == "image").and_then(|url| {
                    let path = if url.starts_with('/') { url.to_owned() } else { format!("/session/{}/{url}", self.id) };
                    self.remote_image(path, artifact::image_format(&name), cx)
                });
                files = files.child(match image {
                    Some(image) => div().rounded(px(6.)).overflow_hidden().border_1().border_color(p.rule).child(img(image).max_h(px(160.)).max_w(px(260.)).object_fit(ObjectFit::Contain)).into_any_element(),
                    None => div().px_2().py(px(2.)).rounded(px(5.)).border_1().border_color(p.rule).bg(p.raised).font_family(MONO).text_size(sz(12.)).text_color(p.ink_2).child(name).into_any_element(),
                });
            }
            content = content.child(files);
        }
        let with: Vec<String> = item["with"].as_array().into_iter().flatten().filter_map(|w| w.as_str().map(str::to_owned)).collect();
        // Edit & fork (admins, in the shared thread): branch just before this message and edit it.
        let can_fork = self.role() == "admin" && self.conv == "main" && key.chars().all(|c| c.is_ascii_digit());
        let (fork_key, fork_text) = (key.to_owned(), body.clone());
        div()
            .w(px(content_width() + AVATAR + GAP))
            .flex()
            .items_start()
            .gap(px(12.))
            .group("user-row")
            .child(div().flex_none().text_size(sz(13.5)).line_height(sz(LINE)).font_weight(FontWeight::SEMIBOLD).text_color(color).child(name))
            .child(content)
            .when(!with.is_empty(), |d| d.child(div().flex_none().text_size(sz(12.)).line_height(sz(LINE)).text_color(p.faint).child(format!("with {}", with.join(", ")))))
            .when(can_fork, |d| {
                d.child(
                    div()
                        .id(eid(format!("fork-{key}")))
                        .flex_none()
                        .invisible()
                        .group_hover("user-row", |s| s.visible())
                        .px_2()
                        .rounded(px(5.))
                        .text_size(sz(12.))
                        .line_height(sz(LINE))
                        .text_color(p.muted)
                        .cursor_pointer()
                        .hover(|s| s.bg(p.sunken).text_color(p.ink))
                        .child("Edit & fork")
                        .tooltip(|window, cx| gpui_component::tooltip::Tooltip::new("Branch the thread just before this message and edit it").build(window, cx))
                        .on_click(cx.listener(move |this, _, window, cx| this.fork(fork_key.clone(), fork_text.clone(), window, cx))),
                )
            })
            .into_any_element()
    }

    fn assistant_row(&self, item: &Value, key: &str, avatar: bool, model: &str, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let body = text(item, "text");
        let thinking = text(item, "thinking");
        let error = text(item, "error");
        let streaming = item["streaming"].as_bool().unwrap_or(false);
        // A turn that only called tools has nothing of its own to show.
        if body.is_empty() && thinking.is_empty() && error.is_empty() && !streaming {
            return None;
        }
        let mut content = div().flex().flex_col().gap_1();
        if !thinking.is_empty() {
            let open = self.thinking.contains(key);
            let k = key.to_owned();
            content = content.child(
                div()
                    .id(eid(format!("thinking-{key}")))
                    .flex()
                    .items_center()
                    .gap_1()
                    .text_size(sz(15.))
                    .text_color(p.muted)
                    .cursor_pointer()
                    .hover(|s| s.text_color(p.ink_2))
                    .child(if streaming && body.is_empty() { "Thinking…" } else { "Thinking" })
                    .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).size_3().text_color(p.faint))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.thinking.remove(&k) {
                            this.thinking.insert(k.clone());
                        }
                        cx.notify();
                    })),
            );
            if open {
                content = content.child(div().mt(px(6.)).mb(px(4.)).pl(px(12.)).border_l_2().border_color(p.rule_strong).text_size(sz(13.5)).line_height(sz(21.)).text_color(p.ink_2).child(thinking.clone()));
            }
        }
        if !body.is_empty() {
            content = content.child(div().text_size(sz(15.)).line_height(sz(LINE)).child(message::render(&format!("assistant-{key}"), &body, window, cx)));
        } else if streaming && thinking.is_empty() {
            content = content.child(div().text_size(sz(15.)).text_color(p.muted).child("…"));
        }
        if !error.is_empty() {
            content = content.child(div().text_size(sz(13.)).text_color(p.removed).child(error));
        }
        Some(row(avatar.then(|| avatar_model(model, p)), content).into_any_element())
    }

    /// One tool call: a quiet line, opening to its diff, written file or output. Edits start open.
    fn tool_content(&self, item: &Value, key: &str, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let tool = text(item, "name");
        let status = text(item, "status");
        let args = &item["args"];
        let detail = ["command", "path", "file_path", "url", "pattern", "title"].iter().find_map(|k| args[*k].as_str()).unwrap_or("");
        let summary = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        let patch = item["details"]["patch"].as_str().unwrap_or("").to_owned();
        let stats = (!patch.is_empty()).then(|| patch_stats(&patch));
        // Edits and artifacts (a written page, a screenshot) are what people come to see: they start open.
        let artifact = self.tool_artifact(item, key, p, window, cx);
        let open = (!patch.is_empty() || artifact.is_some()) != self.toggled.contains(key) || status == "error";
        let k = key.to_owned();
        let header = div()
            .id(eid(format!("tool-{key}")))
            .w_full()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_h(sz(LINE))
            .text_size(sz(15.))
            .cursor_pointer()
            .child(div().flex_shrink_0().text_color(if status == "error" { p.removed } else { p.ink_2 }).child(verb(&tool).to_owned()))
            .when(status == "running" || status == "pending", |d| d.child(Icon::new(IconName::LoaderCircle).size_3().text_color(p.warn)))
            .child(div().min_w_0().truncate().font_family(MONO).text_size(sz(12.5)).text_color(p.muted).child(summary))
            .when_some(stats, |d, (added, removed)| {
                d.child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .gap_1()
                        .font_family(MONO)
                        .text_size(sz(12.))
                        .child(div().text_color(p.added).child(format!("+{added}")))
                        .child(div().text_color(p.removed).child(format!("−{removed}"))),
                )
            })
            .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).size_3().flex_shrink_0().text_color(p.faint))
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.toggled.remove(&k) {
                    this.toggled.insert(k.clone());
                }
                cx.notify();
            }));
        let mut content = div().flex().flex_col().child(header);
        if open {
            let output = text(item, "output");
            let written = args["content"].as_str().filter(|_| tool == "write");
            let body = if let Some(artifact) = artifact {
                Some(artifact)
            } else if !patch.is_empty() {
                Some(diff_view(format!("diff-{key}"), &patch, p).into_any_element())
            } else if let Some(source) = written {
                Some(code_box(format!("write-{key}"), source.to_owned(), p).into_any_element())
            } else if !output.trim().is_empty() {
                // The end of a long output, as the web view shows it.
                let tail: String = output.chars().rev().take(20_000).collect::<Vec<_>>().into_iter().rev().collect();
                Some(code_box(format!("output-{key}"), tail.trim_end().to_owned(), p).into_any_element())
            } else {
                None
            };
            if let Some(body) = body {
                content = content.child(div().pt(px(6.)).pb(px(4.)).child(body));
            }
        }
        content
    }

    /// A run of quiet tool calls as one line ("Ran 1 command, read 3 files"), opening to one line per call.
    fn group_row(&self, tools: &[&Value], avatar: bool, model: &str, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let key = format!("group-{}", text(tools[0], "key"));
        let open = self.groups.contains(&key);
        let running = tools.iter().any(|t| t["status"] == "running" || t["status"] == "pending");
        let names: Vec<String> = tools.iter().map(|t| text(t, "name")).collect();
        let k = key.clone();
        let mut content = div().flex().flex_col().child(
            div()
                .id(eid(key.clone()))
                .flex()
                .items_center()
                .gap(px(8.))
                .min_h(sz(LINE))
                .text_size(sz(15.))
                .text_color(p.muted)
                .hover(|s| s.text_color(p.ink_2))
                .cursor_pointer()
                .child(group_summary(&names))
                .when(running, |d| d.child(Icon::new(IconName::LoaderCircle).size_3().text_color(p.warn)))
                .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).size_3().text_color(p.faint))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.groups.remove(&k) {
                        this.groups.insert(k.clone());
                    }
                    cx.notify();
                })),
        );
        if open {
            for tool in tools {
                content = content.child(div().pt(px(2.)).child(self.tool_content(tool, &text(tool, "key"), p, window, cx)));
            }
        }
        row(avatar.then(|| avatar_model(model, p)), content).into_any_element()
    }

    fn status_bar(&self, main: &Value, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let busy = main["busy"].as_bool().unwrap_or(false);
        let retry = text(main, "retry");
        let model = text(main, "model");
        let target = text(&self.meta, "target");
        div()
            .h(px(30.))
            .flex_none()
            .flex()
            .items_center()
            .gap_3()
            .pl(px(LEFT))
            .pr(px(6.))
            .border_t_1()
            .border_color(p.rule)
            .bg(p.paper)
            .text_size(sz(12.))
            .text_color(p.muted)
            .child(div().truncate().child(if target.is_empty() { String::new() } else { format!("Runs on {target}") }))
            .child(div().flex_1())
            .children({
                // Every line the thread's changes added and removed; a click shows them (⇧⌘D).
                let (mut added, mut removed, mut files) = (0, 0, std::collections::HashSet::new());
                for a in artifact::thread_artifacts(&self.items) {
                    match a.source {
                        "edit" => {
                            let (plus, minus) = patch_stats(&a.content);
                            added += plus;
                            removed += minus;
                        }
                        "write" => added += a.content.lines().count(),
                        _ => continue,
                    }
                    files.extend(a.path);
                }
                (added + removed > 0).then(|| {
                    div()
                        .id("changes-chip")
                        .flex()
                        .gap_1()
                        .px_2()
                        .rounded(px(4.))
                        .font_family(MONO)
                        .cursor_pointer()
                        .hover(|s| s.bg(p.sunken))
                        .child(div().text_color(p.added).child(format!("+{added}")))
                        .child(div().text_color(p.removed).child(format!("−{removed}")))
                        .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(format!("This thread changed {} file{}. Click to see the changes.", files.len(), if files.len() == 1 { "" } else { "s" })).build(window, cx))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ThreadEvent::Changes)))
                })
            })
            .when(!retry.is_empty(), |d| d.child(div().text_color(p.warn).child(retry)))
            .when(busy, |d| {
                d.child(div().flex().items_center().gap_1().child(Icon::new(IconName::LoaderCircle).size_3().text_color(p.accent)).child("Working"))
                    .child(
                        div()
                            .id("stop")
                            .px_2()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(|s| s.bg(p.sunken).text_color(p.ink))
                            .child("Stop")
                            .on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
                    )
            })
            .child(div().font_family(MONO).child(model))
            .into_any_element()
    }
}

impl Render for ThreadView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        let column = (self.width.get() - LEFT - RIGHT).clamp(320., MEASURE);
        CONTENT.store((column - AVATAR - GAP) as u32, Ordering::Relaxed);
        if !self.loaded {
            return div().size_full().flex().items_center().justify_center().text_color(p.muted).child("Loading the thread…").into_any_element();
        }
        // Tests search for something once the thread has loaded (SYNCPI_GPUI_TEST_FIND), as typing it into Find would.
        if let Ok(query) = std::env::var("SYNCPI_GPUI_TEST_FIND")
            && self.find.is_none()
            && !self.items.is_empty()
            && !TEST_FIND.replace(true)
        {
            self.open_find(window, cx);
            if let Some(find) = &self.find {
                find.input.update(cx, |state, cx| state.set_value(query, window, cx));
            }
            self.recount(true, cx);
            self.step(1, window, cx);
        }
        // Tests send something from the composer once the thread has loaded (SYNCPI_GPUI_TEST_SEND), as typing it and
        // pressing ⌘↩ would.
        if let Ok(text) = std::env::var("SYNCPI_GPUI_TEST_SEND")
            && self.conv == "main"
            && !self.items.is_empty()
            && !TEST_SEND.replace(true)
        {
            self.composer.update(cx, |state, cx| state.set_value(text, window, cx));
            self.submit(window, cx);
        }
        // Tests comment on a message's text once the thread has loaded (SYNCPI_GPUI_TEST_COMMENT=<quoted>|<comment>),
        // as selecting it, pressing Enter, writing and pressing ⌘↩ would.
        if let Ok(spec) = std::env::var("SYNCPI_GPUI_TEST_COMMENT")
            && let Some((quoted, note)) = spec.split_once('|')
            && self.conv == "main"
            && !TEST_COMMENT.get()
            && let Some(item) = self.items.iter().find(|i| i["kind"] == "assistant" && text(i, "text").contains(quoted))
        {
            TEST_COMMENT.set(true);
            self.comment = Some((text(item, "key"), quoted.to_owned(), String::new()));
            self.comment_input.update(cx, |state, cx| state.set_value(note.to_owned(), window, cx));
            self.send_comment(window, cx);
        }
        self.adopt_draft(window, cx);
        // Tests type into the composer once the thread has loaded (SYNCPI_GPUI_TEST_TYPE), and join someone's draft
        // once there is one, adding to it (SYNCPI_GPUI_TEST_JOIN=<text>), as a person would.
        if let Ok(typed) = std::env::var("SYNCPI_GPUI_TEST_TYPE")
            && self.conv == "main"
            && !self.meta["me"].is_null()
            && !TEST_TYPE.replace(true)
        {
            self.composer.update(cx, |state, cx| state.set_value(typed, window, cx));
        }
        if let Ok(more) = std::env::var("SYNCPI_GPUI_TEST_JOIN")
            && self.conv == "main"
            && !TEST_JOIN.get()
            && let Some(owner) = self.drafts.iter().map(|d| text(d, "owner")).find(|o| *o != self.me() && self.drafts.iter().any(|d| text(d, "owner") == *o && !text(d, "text").is_empty()))
        {
            TEST_JOIN.set(true);
            self.join_draft(owner, window, cx);
            let body = format!("{}{more}", self.written);
            self.composer.update(cx, |state, cx| state.set_value(body, window, cx));
        }
        let main = self.main.clone();
        let items = std::mem::take(&mut self.items);
        // Comments people made on messages' text, shown there, inline (cursor.rs, prose.rs), as in Delta.
        let mut marks: std::collections::HashMap<String, Vec<crate::cursor::Mark>> = Default::default();
        for item in items.iter().filter(|i| i["kind"] == "user") {
            let author = self.name_of(&text(item, "memberId"), item["author"].as_str().unwrap_or("someone").to_owned());
            for c in item["comments"].as_array().into_iter().flatten() {
                if let Some(message) = c["message"].as_str() {
                    marks.entry(message.to_owned()).or_default().push(crate::cursor::Mark { excerpt: text(c, "excerpt"), note: text(c, "text"), author: author.clone() });
                }
            }
        }
        crate::cursor::set_marks(marks, p.removed);
        // The thread's text cursor: the caret shows while the thread has focus; the comment box under its block.
        let after = self.comment.as_ref().map(|c| (c.2.clone(), self.comment_box(&p, cx)));
        crate::cursor::begin(p.accent.opacity(0.22), p.accent, self.focus.is_focused(window), after, &self.list);
        // Find's matches, painted in the messages' text (prose.rs); the colors of the web view's (--find).
        let query = self.query(cx);
        crate::cursor::set_find(self.find.as_ref().filter(|_| !query.is_empty()).map(|f| crate::cursor::Find {
            query: query.clone(),
            current: f.matches.get(f.current).cloned(),
            color: hsla(43. / 360., 1., 0.62, if p.dark { 0.3 } else { 0.32 }),
            current_color: hsla(28. / 360., 1., 0.58, if p.dark { 0.45 } else { 0.5 }),
        }));
        let mut row_of = std::collections::HashMap::new();
        let mut rows: Vec<AnyElement> = vec![];
        let mut previous_agent = false;
        let mut model = text(&main, "model");
        for unit in display_units(&items) {
            let item = match unit {
                Unit::Group(tools) if tools.len() > 1 => {
                    crate::cursor::row(rows.len());
                    for tool in &tools {
                        row_of.insert(text(tool, "key"), rows.len());
                    }
                    let gap = if previous_agent { 10. } else { 16. };
                    rows.push(div().mt(px(gap)).child(self.group_row(&tools, !previous_agent, &model, &p, window, cx)).into_any_element());
                    previous_agent = true;
                    continue;
                }
                Unit::Group(tools) => tools[0],
                Unit::Item(item) => item,
            };
            crate::cursor::row(rows.len());
            let kind = text(item, "kind");
            let key = text(item, "key");
            row_of.insert(key.clone(), rows.len());
            let agent = kind == "assistant" || kind == "tool";
            if kind == "assistant" && !text(item, "model").is_empty() {
                model = text(item, "model");
            }
            let element = match kind.as_str() {
                "user" => Some(self.user_row(item, &key, &p, window, cx)),
                "assistant" => self.assistant_row(item, &key, !previous_agent, &model, &p, window, cx),
                "tool" => Some(row((!previous_agent).then(|| avatar_model(&model, &p)), self.tool_content(item, &key, &p, window, cx)).into_any_element()),
                "notice" => Some(
                    div()
                        .w(px(column))
                        .mt(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .text_color(p.muted)
                        .text_size(sz(13.5))
                        .italic()
                        .child(div().flex_1().h(px(1.)).bg(p.rule))
                        .child(text(item, "text"))
                        .child(div().flex_1().h(px(1.)).bg(p.rule))
                        .into_any_element(),
                ),
                _ => None,
            };
            if let Some(element) = element {
                // Consecutive agent rows sit closer together under one mark.
                let gap = if agent && previous_agent { 10. } else { 16. };
                rows.push(div().mt(px(gap)).child(element).into_any_element());
                previous_agent = agent;
            }
        }
        // The items were taken for this frame's rows (not copied): back where they were.
        self.items = items;
        self.row_of = row_of;
        for typing in self.typing_rows(&p, cx) {
            rows.push(div().mt(px(16.)).child(typing).into_any_element());
        }
        let viewer = self.meta["me"]["role"] == "viewer";
        let with = self.draft_with(&p, cx);
        if self.conv == "setup" {
            rows.push(div().mt(px(18.)).text_size(sz(13.)).text_color(p.muted).child("The setup agent works on its own; its thread is here to read.").into_any_element());
        } else {
        rows.push(
            div()
                .mt(px(18.))
                .child(if viewer {
                    div().text_size(sz(13.)).text_color(p.muted).child("You can read this thread. Ask an admin to make you an editor to talk to the agent.").into_any_element()
                } else {
                    row(
                        Some(avatar_person(&text(&self.meta["me"], "name"), p.dark)),
                        div()
                            .w_full()
                            .children(with)
                            .child(div().capture_key_down(cx.listener(Self::composer_key)).child(Input::new(&self.composer).appearance(false).px_0().py(px(2.)).w_full().text_size(sz(15.))))
                            .child(self.composer_extras(&p, cx)),
                    )
                    .into_any_element()
                })
                .into_any_element(),
        );
        }
        // The list follows its rows: new ones are measured from the old last row (the composer).
        let count = rows.len();
        if self.list.item_count() != count {
            let old = self.list.item_count();
            let from = old.saturating_sub(1).min(count);
            self.list.splice(from..old, count - from);
        }
        let last = count.saturating_sub(1);
        let rows: Vec<Option<AnyElement>> = rows
            .into_iter()
            .enumerate()
            .map(|(n, row)| {
                Some(
                    div()
                        .w_full()
                        .pl(px(LEFT))
                        .pr(px(RIGHT))
                        .when(n == 0, |d| d.pt(px(14.)))
                        .when(n == last, |d| d.pb(px(120.)))
                        .flex()
                        .flex_col()
                        .items_start()
                        .child(row)
                        .into_any_element(),
                )
            })
            .collect();
        let rows = Rc::new(std::cell::RefCell::new(rows));
        let width = self.width.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(p.paper)
            .text_color(p.ink)
            .font_family(theme::SANS)
            .key_context("ThreadView")
            .track_focus(&self.focus)
            // Files dropped on the thread go with the next message.
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.add_files(paths.paths(), cx);
                this.focus_composer(window, cx);
            }))
            // A press on a message's text put the caret there (prose.rs): the thread takes focus.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    if crate::cursor::take_click() {
                        this.comment = None;
                        window.focus(&this.focus);
                        cx.notify();
                    }
                }),
            )
            .on_mouse_up(MouseButton::Left, |_, _, _| crate::cursor::release())
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.focus.is_focused(window) && this.comment.is_none() && this.thread_key(&event.keystroke, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| this.command(action, window, cx)))
            .child(self.side_banner(&p, cx))
            .child(self.find_bar(&p, cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(canvas(move |bounds, _, _| width.set(f32::from(bounds.size.width)), |_, _, _, _| {}).absolute().size_full())
                    .child(list(self.list.clone(), move |n, _, _| rows.borrow_mut().get_mut(n).and_then(Option::take).unwrap_or_else(|| div().into_any_element())).size_full()),
            )
            .child(self.status_bar(&main, &p, cx))
            .into_any_element()
    }
}

impl EventEmitter<ThreadEvent> for ThreadView {}

fn post(host: &Host, id: &str, job: Job) {
    let result = match job {
        Job::Send(message) => host.post(&format!("/api/sessions/{id}/send"), &message),
        Job::Draft { owner, text, caret, seq } => {
            let mut body = json!({ "text": text, "caret": caret, "seq": seq });
            if let Some(owner) = owner {
                body["owner"] = json!(owner);
            }
            host.post(&format!("/api/sessions/{id}/draft"), &body)
        }
    };
    if let Err(e) = result {
        eprintln!("syncpi: sending to the thread: {e}");
    }
}

/// The length of `text` in UTF-16 units, as the drafts (JavaScript strings, Yjs) count.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The byte offset in `text` of UTF-16 offset `units`.
fn byte_of_utf16(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (at, c) in text.char_indices() {
        if count >= units {
            return at;
        }
        count += c.len_utf16();
    }
    text.len()
}

/// A comment someone sent (thread-view.ts #comment): on part of a message, its quote and the note; on lines of a
/// file, where, the first lines and the note.
fn comment_card(c: &Value, name: &str, p: &Palette) -> AnyElement {
    let card = div().flex().flex_col().gap(px(6.)).p(px(10.)).rounded(px(8.)).border_1().border_color(p.rule).bg(p.raised).text_size(sz(13.5)).line_height(relative(1.45));
    let note = div()
        .flex()
        .items_start()
        .gap_2()
        .child(div().flex_none().text_size(sz(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(theme::person_color(name, p.dark)).child(name.to_owned()))
        .child(div().flex_1().min_w_0().text_color(p.ink).child(text(c, "text")));
    if c["message"].is_string() {
        return card
            .child(div().text_size(sz(11.5)).text_color(p.muted).child("On a message"))
            .child(div().pl(px(10.)).border_l_2().border_color(p.rule_strong).text_color(p.ink_2).child(text(c, "excerpt")))
            .child(note)
            .into_any_element();
    }
    let start = c["start"].as_u64().unwrap_or(0);
    let end = c["end"].as_u64().unwrap_or(start);
    let place = if start == end { format!("{}:{start}", text(c, "path")) } else { format!("{}:{start}-{end}", text(c, "path")) };
    let excerpt = text(c, "excerpt");
    let lines: Vec<&str> = excerpt.split('\n').collect();
    let mut code = div().flex().flex_col().px(px(8.)).py(px(6.)).rounded(px(6.)).bg(p.code).font_family(MONO).text_size(sz(12.)).line_height(relative(1.5));
    for (n, line) in lines.iter().take(6).enumerate() {
        code = code.child(
            div()
                .flex()
                .gap_3()
                .child(div().w(px(28.)).flex_none().text_right().text_color(p.faint).child((start + n as u64).to_string()))
                .child(div().flex_1().min_w_0().whitespace_nowrap().overflow_hidden().child(if line.is_empty() { " ".to_owned() } else { (*line).to_owned() })),
        );
    }
    if lines.len() > 6 {
        code = code.child(div().text_color(p.faint).child(format!("{} more lines", lines.len() - 6)));
    }
    card.child(div().font_family(MONO).text_size(sz(12.)).text_color(p.accent).child(place)).child(code).child(note).into_any_element()
}

static WHERE_VM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Where this person's requests run (Settings → Your requests run on): this Mac, or the session's VM.
pub fn set_where_vm(vm: bool) {
    WHERE_VM.store(vm, std::sync::atomic::Ordering::Relaxed);
}

fn where_to() -> &'static str {
    if WHERE_VM.load(std::sync::atomic::Ordering::Relaxed) { "vm" } else { "device" }
}

/// /invite's words (src/shared/commands.ts parseInvite): an email, a role, an expiry (7d, 12h, never), --uses N.
fn parse_invite(arg: &str) -> Result<Value, String> {
    let mut out = json!({});
    let words: Vec<&str> = arg.split_whitespace().collect();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if w == "--link" || w == "link" {
        } else if w.contains('@') {
            out["email"] = json!(w);
        } else if ["admin", "editor", "viewer"].contains(&w) {
            out["role"] = json!(w);
        } else if let Some(days) = w.strip_suffix('d').and_then(|d| d.parse::<f64>().ok()) {
            out["expiresInDays"] = json!(days);
        } else if let Some(hours) = w.strip_suffix('h').and_then(|h| h.parse::<f64>().ok()) {
            out["expiresInDays"] = json!(hours / 24.);
        } else if w == "never" {
            out["expiresInDays"] = json!(0);
        } else if w == "--uses" && words.get(i + 1).is_some_and(|n| n.parse::<u32>().is_ok()) {
            i += 1;
            out["maxUses"] = json!(words[i].parse::<u32>().unwrap());
        } else {
            return Err(format!("Don't understand \"{w}\"; usage: /invite [email] [admin|editor|viewer] [7d|12h|never] [--uses N]"));
        }
        i += 1;
    }
    Ok(out)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for (k, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if k <= chunk.len() {
                out.push(TABLE[(n >> shift & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn request_id() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos())
}

/// One row of the thread: the mark's column (or the space for it) and the content, at the column's width.
fn row(avatar: Option<Div>, content: impl IntoElement) -> Div {
    let width = content_width();
    div()
        .w(px(width + AVATAR + GAP))
        .flex_shrink_0()
        .flex()
        .items_start()
        .gap(px(GAP))
        .child(avatar.unwrap_or_else(|| div().w(px(AVATAR)).flex_shrink_0()))
        .child(div().w(px(width)).flex_shrink_0().flex().flex_col().child(content))
}

fn avatar_person(name: &str, dark: bool) -> Div {
    let color = theme::person_color(name, dark);
    div()
        .size(px(AVATAR))
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(color.opacity(0.16))
        .text_color(color)
        .text_size(sz(9.5))
        .font_weight(FontWeight::SEMIBOLD)
        .child(theme::initials(name))
}

fn avatar_model(model: &str, p: &Palette) -> Div {
    let base = div().size(px(AVATAR)).flex_shrink_0().rounded_full().flex().items_center().justify_center().bg(p.raised).border_1().border_color(p.rule).text_color(p.ink);
    match icons::model_vendor(model) {
        Some((_, path)) => base.child(svg().path(path).size(px(14.)).text_color(p.ink)),
        None => {
            let id = model.split_once('/').map_or(model, |(_, id)| id);
            base.font_family(MONO).text_size(sz(9.5)).child(id.chars().next().unwrap_or('?').to_uppercase().to_string())
        }
    }
}

/// A tool's output or a written file, as the web view's .tool-output: the code background, 12px mono.
fn code_box(id: String, body: String, p: &Palette) -> Stateful<Div> {
    div()
        .id(eid(id))
        .max_h(px(300.))
        .overflow_scroll()
        .rounded(px(8.))
        .bg(p.code)
        .px(px(12.))
        .py(px(9.))
        .font_family(MONO)
        .text_size(sz(12.))
        .line_height(sz(18.))
        .text_color(p.ink_2)
        .child(body)
}

fn verb(tool: &str) -> &str {
    match tool {
        "bash" => "Ran",
        "edit" => "Edited",
        "write" => "Wrote",
        "read" => "Read",
        "remote_bash" => "Ran on the VM",
        "record_browser" => "Recorded",
        "screenshot_browser" => "Screenshot",
        other => other,
    }
}

/// Lines added and removed in a unified patch.
pub(crate) fn patch_stats(patch: &str) -> (usize, usize) {
    patch.lines().fold((0, 0), |(a, r), line| {
        if line.starts_with("+++") || line.starts_with("---") {
            (a, r)
        } else if line.starts_with('+') {
            (a + 1, r)
        } else if line.starts_with('-') {
            (a, r + 1)
        } else {
            (a, r)
        }
    })
}

/// A unified patch as a diff: added and removed lines tinted, with old and new line numbers.
pub(crate) fn diff_view(id: String, patch: &str, p: &Palette) -> Stateful<Div> {
    let (mut old, mut new, mut hunks) = (0usize, 0usize, 0usize);
    let mut lines = div().flex().flex_col().min_w_full();
    for line in patch.lines().take(600) {
        // Everything before the first hunk is metadata: file names, modes, index lines.
        if hunks == 0 && !line.starts_with("@@") {
            continue;
        }
        if let Some(header) = line.strip_prefix("@@") {
            let mut numbers = header.split_whitespace();
            old = numbers.next().and_then(|n| n.trim_start_matches('-').split(',').next()?.parse().ok()).unwrap_or(1);
            new = numbers.next().and_then(|n| n.trim_start_matches('+').split(',').next()?.parse().ok()).unwrap_or(1);
            if hunks > 0 {
                lines = lines.child(div().h(px(18.)).pl(px(82.)).bg(p.sunken).text_color(p.faint).child("⋯"));
            }
            hunks += 1;
            continue;
        }
        let (mark, body) = line.split_at(line.len().min(1));
        let (bg, fg, left, right) = match mark {
            "+" => {
                new += 1;
                (p.added.opacity(0.12), p.ink, String::new(), (new - 1).to_string())
            }
            "-" => {
                old += 1;
                (p.removed.opacity(0.12), p.ink, (old - 1).to_string(), String::new())
            }
            _ => {
                old += 1;
                new += 1;
                (transparent_black(), p.ink_2, (old - 1).to_string(), (new - 1).to_string())
            }
        };
        let gutter = |n: String| div().w(px(34.)).flex_shrink_0().text_right().pr_2().text_color(p.faint).child(n);
        lines = lines.child(
            div()
                .flex()
                .bg(bg)
                .text_color(fg)
                .child(gutter(left))
                .child(gutter(right))
                .child(div().w(px(14.)).flex_shrink_0().text_color(if mark == "+" { p.added } else if mark == "-" { p.removed } else { p.faint }).child(mark.to_owned()))
                .child(div().whitespace_nowrap().pr_4().child(body.to_owned())),
        );
    }
    div()
        .id(eid(id))
        .w_full()
        .max_h(px(420.))
        .overflow_scroll()
        .rounded(px(8.))
        .border_1()
        .border_color(p.rule)
        .bg(p.raised)
        .py_1()
        .font_family(MONO)
        .text_size(sz(12.))
        .line_height(sz(19.))
        .child(lines)
}

fn is_quiet(item: &Value) -> bool {
    item["kind"] == "tool" && ["read", "ls", "find", "grep", "bash"].contains(&text(item, "name").as_str()) && item["status"] != "error"
}

/// "Ran 1 command, read 3 files": what a run of quiet calls did. As toolGroupSummary() in src/shared/thread.ts.
fn group_summary(names: &[String]) -> String {
    let mut counts: Vec<(&str, usize)> = vec![];
    for name in names {
        match counts.iter_mut().find(|(n, _)| n == name) {
            Some((_, c)) => *c += 1,
            None => counts.push((name, 1)),
        }
    }
    let text = counts
        .iter()
        .map(|(name, n)| {
            let (one, many, verb) = match *name {
                "ls" => ("directory", "directories", "listed"),
                "read" => ("file", "files", "read"),
                "find" => ("time", "times", "looked for files"),
                "grep" => ("time", "times", "searched"),
                "bash" => ("command", "commands", "ran"),
                other => ("time", "times", other),
            };
            format!("{verb} {n} {}", if *n == 1 { one } else { many })
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

enum Unit<'a> {
    Item(&'a Value),
    Group(Vec<&'a Value>),
}

/// The thread's rows: each item on its own, except a run of quiet tool calls (and the empty tool-only turns between
/// them), which becomes one group. As displayUnits() in src/web/thread-view.ts.
fn display_units(items: &[Value]) -> Vec<Unit<'_>> {
    let mut units: Vec<Unit> = vec![];
    let silent = |i: &Value| {
        i["kind"] == "assistant" && text(i, "text").is_empty() && text(i, "thinking").is_empty() && text(i, "error").is_empty() && !i["streaming"].as_bool().unwrap_or(false)
    };
    let mut in_group = false;
    for item in items {
        if is_quiet(item) {
            match units.last_mut() {
                Some(Unit::Group(tools)) if in_group => tools.push(item),
                _ => units.push(Unit::Group(vec![item])),
            }
            in_group = true;
        } else if in_group && silent(item) {
            continue;
        } else {
            in_group = false;
            units.push(Unit::Item(item));
        }
    }
    units
}

/// Single line breaks as Markdown hard breaks, outside code fences, so a message keeps the lines it was written in.
fn keep_breaks(text: &str) -> String {
    let mut fenced = false;
    text.lines()
        .map(|line| {
            if line.trim_start().starts_with("```") {
                fenced = !fenced;
                return line.to_owned();
            }
            if fenced || line.trim().is_empty() { line.to_owned() } else { format!("{line}  ") }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    // Not a glob: gpui's `test` attribute would shadow the standard one.
    use super::{base64, parse_invite};

    #[test]
    fn invites_read_as_the_web_view_reads_them() {
        let invite = parse_invite("ada@example.com viewer 7d").unwrap();
        assert_eq!(invite["email"].as_str(), Some("ada@example.com"));
        assert_eq!(invite["role"].as_str(), Some("viewer"));
        assert_eq!(invite["expiresInDays"].as_f64(), Some(7.));
        let link = parse_invite("never --uses 3").unwrap();
        assert_eq!(link["expiresInDays"].as_f64(), Some(0.));
        assert_eq!(link["maxUses"].as_u64(), Some(3));
        assert_eq!(parse_invite("12h").unwrap()["expiresInDays"].as_f64(), Some(0.5));
        assert!(parse_invite("soon").is_err());
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}
