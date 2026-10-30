// The panel beside the thread, native, laid out as the web view's (src/web/panel.ts) and Delta's: tabs along the
// top (Changes, Git, then one per open file or preview), the open tab below, and the project tree beside it (⇧⌘E).
// Changes lists every artifact the thread produced, grouped by file, newest first, and shows the selected one large.
// A file tab shows the file as it is now (Markdown rendered, code with line numbers); lines can be selected and
// commented on, and Edit writes it together with whoever else has it open (the host keeps its Yjs document). Git
// shows what's uncommitted, to stage and commit.
use crate::artifact::{self, Art, Shown};
use crate::host::Host;
use crate::message;
use crate::theme::{MONO, Palette, palette, sz};
use crate::thread::{diff_view, patch_stats};
use gpui::{prelude::FluentBuilder, *};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::webview::WebView;
use gpui_component::{Icon, IconName, wry};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

#[derive(Clone, PartialEq)]
pub enum Tab {
    Changes,
    Git,
    File(String),
    /// An artifact opened from the thread (its card's Open): a page, an image, Markdown.
    Preview(String),
}

/// What the panel asks of the app: send this to the thread (a comment on lines), or close.
pub enum PanelEvent {
    Send(Value),
    Close,
}

struct FileTab {
    path: String,
    /// The file as read, or why it couldn't be.
    text: Option<Result<String, String>>,
    /// Markdown shown rendered (else its source).
    rendered: bool,
    /// Lines selected (1-based, inclusive), to comment on.
    lines: Option<(usize, usize)>,
    editing: Option<Editor>,
    /// Showing the file as it was before the thread's last turn (Delta's version picker), and that version, or
    /// why it can't be shown.
    before: bool,
    earlier: Option<Result<String, String>>,
}

struct Editor {
    input: Entity<InputState>,
    /// The text last written from here, and how many writes were posted (the host echoes the count it has taken).
    written: String,
    writes: u64,
    ready: bool,
    others: Vec<String>,
    _subscription: Subscription,
}

enum Job {
    Post(String, Value),
}

pub struct PanelView {
    host: Host,
    id: String,
    artifacts: Vec<Art>,
    selected: Option<String>,
    tabs: Vec<FileTab>,
    previews: Vec<(String, Shown)>,
    pub active: Tab,
    pub tree_open: bool,
    files: Option<Vec<String>>,
    expanded: HashSet<String>,
    /// Files marked seen, at the key of their newest change (a newer change shows them again).
    seen: HashMap<String, String>,
    git: Option<Result<Value, String>>,
    commit: Entity<InputState>,
    comment: Entity<InputState>,
    /// A webview for the HTML artifact or page shown, by what it shows.
    webview: Option<(String, Entity<WebView>)>,
    worker: std::sync::mpsc::Sender<Job>,
    /// Find in the open file (⌘F while the panel has focus): its field, the current match, and a line to scroll to.
    find: Option<(Entity<InputState>, usize, Subscription)>,
    scroll_to: Option<usize>,
    code_scroll: ScrollHandle,
    focus: FocusHandle,
    /// Text that arrived for an editor (path, text), set on the next frame.
    pending_text: HashMap<String, String>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PanelEvent> for PanelView {}

impl PanelView {
    pub fn new(host: Host, id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let commit = cx.new(|cx| InputState::new(window, cx).placeholder("Commit message"));
        let comment = cx.new(|cx| InputState::new(window, cx).multi_line(true).auto_grow(1, 6).placeholder("Comment on these lines. ⌘↩ to send"));
        let subscriptions = vec![
            cx.subscribe_in(&commit, window, |this, _, event, _, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.commit(cx);
                }
            }),
            cx.subscribe_in(&comment, window, |this, _, event, window, cx| {
                if let InputEvent::PressEnter { secondary: true } = event {
                    this.send_comment(window, cx);
                }
            }),
        ];
        // Writes to a file being edited, in order; a run typed faster than it's posted only needs its last.
        let (worker, jobs) = std::sync::mpsc::channel::<Job>();
        let worker_host = host.clone();
        std::thread::spawn(move || {
            while let Ok(Job::Post(mut path, mut body)) = jobs.recv() {
                while let Ok(Job::Post(next_path, next_body)) = jobs.try_recv() {
                    let same_write = next_path == path && body["text"].is_string() && next_body["text"].is_string() && body["path"] == next_body["path"];
                    if !same_write {
                        let _ = worker_host.post(&path, &body);
                    }
                    (path, body) = (next_path, next_body);
                }
                if let Err(e) = worker_host.post(&path, &body) {
                    eprintln!("syncpi: the panel: {e}");
                }
            }
        });
        // While a file is being edited: what the others wrote, a few times a second.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                if this.update(cx, |this, cx| this.poll_editors(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            host,
            id,
            artifacts: vec![],
            selected: None,
            tabs: vec![],
            previews: vec![],
            active: Tab::Changes,
            tree_open: false,
            files: None,
            expanded: HashSet::new(),
            seen: HashMap::new(),
            git: None,
            commit,
            comment,
            webview: None,
            worker,
            pending_text: HashMap::new(),
            find: None,
            scroll_to: None,
            code_scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    /// The text Find searches: the open file as shown (its earlier version when that's shown).
    fn find_text(&self) -> Option<String> {
        let Tab::File(path) = &self.active else { return None };
        let tab = self.tabs.iter().find(|t| t.path == *path)?;
        let text = if tab.before { tab.earlier.as_ref()?.as_ref().ok()? } else { tab.text.as_ref()?.as_ref().ok()? };
        Some(text.clone())
    }

    /// The lines (1-based) where the query is, ignoring case.
    fn find_lines(&self, cx: &App) -> Vec<usize> {
        let (Some((input, _, _)), Some(text)) = (&self.find, self.find_text()) else { return vec![] };
        let query = input.read(cx).value().trim().to_lowercase();
        if query.is_empty() {
            return vec![];
        }
        text.split('\n').enumerate().filter(|(_, l)| l.to_lowercase().contains(&query)).map(|(n, _)| n + 1).collect()
    }

    /// Tests: Edit on the open file, as a click on it would; false until it's read.
    pub fn edit_for_test(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Tab::File(path) = self.active.clone() else { return false };
        if self.find_text().is_none() {
            return false;
        }
        self.start_editing(path, window, cx);
        true
    }

    /// Tests: Find `query` in the open file, once it's read; false until then.
    pub fn find_for_test(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.find_text().is_none() {
            return false;
        }
        self.open_find(window, cx);
        if let Some((input, _, _)) = &self.find {
            input.update(cx, |state, cx| state.set_value(query.to_owned(), window, cx));
        }
        self.step_find(1, window, cx);
        true
    }

    fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find_text().is_none() {
            return;
        }
        if let Some((input, _, _)) = &self.find {
            input.update(cx, |state, cx| state.focus(window, cx));
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in the file"));
        input.update(cx, |state, cx| state.focus(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
            InputEvent::Change => {
                if let Some(find) = &mut this.find {
                    find.1 = 0;
                }
                this.reveal_found(cx);
            }
            InputEvent::PressEnter { .. } => this.step_find(1, window, cx),
            _ => {}
        });
        self.find = Some((input, 0, subscription));
        cx.notify();
    }

    fn step_find(&mut self, by: isize, _window: &mut Window, cx: &mut Context<Self>) {
        let count = self.find_lines(cx).len();
        let Some(find) = &mut self.find else { return };
        if count > 0 {
            find.1 = (find.1 as isize + by).rem_euclid(count as isize) as usize;
        }
        self.reveal_found(cx);
    }

    fn reveal_found(&mut self, cx: &mut Context<Self>) {
        let lines = self.find_lines(cx);
        self.scroll_to = self.find.as_ref().and_then(|f| lines.get(f.1).copied());
        cx.notify();
    }

    fn command(&mut self, action: &crate::keymap::RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        match action.id.as_ref() {
            "find.open" => self.open_find(window, cx),
            "find.next" if self.find.is_some() => self.step_find(1, window, cx),
            "find.previous" if self.find.is_some() => self.step_find(-1, window, cx),
            _ => cx.propagate(),
        }
    }

    fn find_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (input, current, _) = self.find.as_ref()?;
        let p = palette(cx);
        let count = self.find_lines(cx).len();
        let label = if count == 0 { "0/0".to_owned() } else { format!("{}/{count}", current + 1) };
        let button = |id: &'static str, icon: IconName| div().id(id).p(px(4.)).rounded(px(5.)).text_color(p.muted).cursor_pointer().hover(|s| s.bg(p.sunken).text_color(p.ink)).child(Icon::new(icon).size(px(13.)));
        Some(
            div()
                .h(px(38.))
                .flex_none()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .border_b_1()
                .border_color(p.rule)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        this.find = None;
                        this.scroll_to = None;
                        window.focus(&this.focus);
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
                .child(div().flex_1().child(Input::new(input).appearance(true).text_size(sz(13.))))
                .child(div().w(px(48.)).text_right().font_family(MONO).text_size(sz(12.)).text_color(p.muted).child(label))
                .child(button("file-find-previous", IconName::ChevronUp).on_click(cx.listener(|this, _, window, cx| this.step_find(-1, window, cx))))
                .child(button("file-find-next", IconName::ChevronDown).on_click(cx.listener(|this, _, window, cx| this.step_find(1, window, cx))))
                .child(button("file-find-close", IconName::Close).on_click(cx.listener(|this, _, window, cx| {
                    this.find = None;
                    this.scroll_to = None;
                    window.focus(&this.focus);
                    cx.notify();
                })))
                .into_any_element(),
        )
    }

    /// What the panel shows, as follow.ts names it for others following this person: "changes", a file's path, or
    /// nothing they can follow.
    pub fn shown(&self) -> Option<String> {
        match &self.active {
            Tab::Changes => Some("changes".into()),
            Tab::File(path) => Some(path.clone()),
            _ => None,
        }
    }

    /// The thread's artifacts changed: a file the thread changed again is read again in its tab (unless it's being
    /// edited there), and earlier versions read so far are out of date.
    pub fn set_artifacts(&mut self, artifacts: Vec<Art>, cx: &mut Context<Self>) {
        if artifacts == self.artifacts {
            return;
        }
        let fresh: Vec<String> = artifacts.iter().filter(|a| !self.artifacts.contains(a)).filter_map(|a| a.path.clone()).collect();
        self.artifacts = artifacts;
        let mut reread = vec![];
        for tab in &mut self.tabs {
            tab.earlier = None;
            if tab.editing.is_none() && fresh.iter().any(|p| *p == tab.path || p.ends_with(&format!("/{}", tab.path))) {
                reread.push(tab.path.clone());
            }
        }
        for path in reread {
            self.read_file(path, cx);
        }
        let shown_before = match &self.active {
            Tab::File(path) => self.tabs.iter().find(|t| t.path == *path && t.before).map(|t| t.path.clone()),
            _ => None,
        };
        if let Some(path) = shown_before {
            self.read_earlier(path, cx);
        }
        cx.notify();
    }

    /// The file as it was before the thread's last turn, from the session's server.
    fn read_earlier(&mut self, path: String, cx: &mut Context<Self>) {
        let (host, id) = (self.host.clone(), self.id.clone());
        cx.spawn(async move |this, cx| {
            let query = crate::url_escape(&path);
            let read = cx.background_executor().spawn(async move { host.raw(&format!("/session/{id}/api/file?path={query}&at=before-last-turn")) }).await;
            let earlier = match read {
                Ok((200, bytes)) => Ok(String::from_utf8_lossy(&bytes).to_string()),
                Ok((_, bytes)) => Err(match serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["reason"].as_str().map(str::to_owned)).as_deref() {
                    Some("no-turn") => "The agent hasn't taken a turn yet.".to_owned(),
                    Some("absent") => format!("{path} didn't exist before the last turn."),
                    _ => "Couldn't load the earlier version.".to_owned(),
                }),
                Err(e) => Err(e.to_string()),
            };
            let _ = this.update(cx, |this, cx| {
                if let Some(tab) = this.tabs.iter_mut().find(|t| t.path == path) {
                    tab.earlier = Some(earlier);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn show_changes(&mut self, cx: &mut Context<Self>) {
        self.active = Tab::Changes;
        cx.notify();
    }

    pub fn show_git(&mut self, cx: &mut Context<Self>) {
        self.active = Tab::Git;
        self.load_git(None, cx);
        cx.notify();
    }

    pub fn toggle_tree(&mut self, cx: &mut Context<Self>) {
        self.tree_open = !self.tree_open;
        if self.tree_open {
            self.load_files(cx);
        }
        cx.notify();
    }

    /// An artifact opened from the thread: shown in a tab of its own.
    pub fn preview(&mut self, shown: Shown, cx: &mut Context<Self>) {
        let title = shown.title().to_owned();
        self.previews.retain(|(t, _)| *t != title);
        self.previews.push((title.clone(), shown));
        self.active = Tab::Preview(title);
        cx.notify();
    }

    fn load_files(&mut self, cx: &mut Context<Self>) {
        let (host, id) = (self.host.clone(), self.id.clone());
        cx.spawn(async move |this, cx| {
            let listed = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/files")) }).await;
            let _ = this.update(cx, |this, cx| {
                this.files = Some(listed.ok().and_then(|v| serde_json::from_value(v["files"].clone()).ok()).unwrap_or_default());
                cx.notify();
            });
        })
        .detach();
    }

    /// Opens a project file in its tab (reading it again when it's open already).
    pub fn open_file(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.tabs.iter().any(|t| t.path == path) {
            self.tabs.push(FileTab { path: path.clone(), text: None, rendered: true, lines: None, editing: None, before: false, earlier: None });
        }
        self.active = Tab::File(path.clone());
        self.read_file(path, cx);
        cx.notify();
    }

    /// Selects lines of an open file (tests).
    pub fn select_lines(&mut self, path: &str, lines: (usize, usize), cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.iter_mut().find(|t| t.path == path) {
            tab.lines = Some(lines);
            cx.notify();
        }
    }

    fn read_file(&mut self, path: String, cx: &mut Context<Self>) {
        let (host, id) = (self.host.clone(), self.id.clone());
        cx.spawn(async move |this, cx| {
            let query = crate::url_escape(&path);
            let read = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/file?path={query}")) }).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(tab) = this.tabs.iter_mut().find(|t| t.path == path) {
                    tab.text = Some(read.map(|v| v["text"].as_str().unwrap_or_default().to_owned()).map_err(|e| e.to_string()));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn close_tab(&mut self, tab: &Tab, cx: &mut Context<Self>) {
        match tab {
            Tab::File(path) => {
                if let Some(at) = self.tabs.iter().position(|t| t.path == *path) {
                    if self.tabs[at].editing.is_some() {
                        self.stop_editing(path, cx);
                    }
                    self.tabs.remove(at);
                }
            }
            Tab::Preview(title) => self.previews.retain(|(t, _)| t != title),
            _ => return,
        }
        if self.active == *tab {
            self.active = Tab::Changes;
        }
        cx.notify();
    }

    fn load_git(&mut self, action: Option<Value>, cx: &mut Context<Self>) {
        let (host, id) = (self.host.clone(), self.id.clone());
        cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        Some(body) => host.post(&format!("/api/sessions/{id}/git"), &body),
                        None => host.get(&format!("/api/sessions/{id}/git")),
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.git = Some(read.map_err(|e| e.to_string()));
                cx.notify();
            });
        })
        .detach();
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        let message = self.commit.read(cx).value().trim().to_owned();
        if message.is_empty() {
            return;
        }
        self.load_git(Some(json!({ "action": "commit", "message": message })), cx);
    }

    /// Lines of a file, picked by their numbers: a click picks one, a shift-click extends to it.
    fn pick_line(&mut self, path: &str, line: usize, extend: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.iter_mut().find(|t| t.path == path) else { return };
        tab.lines = match (tab.lines, extend) {
            (Some((a, _)), true) => Some((a.min(line), a.max(line))),
            (Some((a, b)), false) if a == line && b == line => None,
            _ => Some((line, line)),
        };
        if tab.lines.is_some() {
            self.comment.update(cx, |state, cx| state.focus(window, cx));
        }
        cx.notify();
    }

    /// The comment on the selected lines goes to the thread, quoting them, as the web view's line comments do.
    fn send_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Tab::File(path) = self.active.clone() else { return };
        let Some(tab) = self.tabs.iter_mut().find(|t| t.path == path) else { return };
        let (Some((start, end)), Some(Ok(text))) = (tab.lines, &tab.text) else { return };
        let note = self.comment.read(cx).value().trim().to_owned();
        if note.is_empty() {
            return;
        }
        let excerpt: Vec<&str> = text.split('\n').skip(start - 1).take(end - start + 1).collect();
        cx.emit(PanelEvent::Send(json!({
            "type": "submit",
            "requestId": format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()),
            "text": "",
            "mode": "interrupt",
            "comments": [{ "path": path, "start": start, "end": end, "excerpt": excerpt.join("\n"), "text": note }],
        })));
        tab.lines = None;
        self.comment.update(cx, |state, cx| state.set_value("", window, cx));
        cx.notify();
    }

    /// Edit: the file becomes a document written together; the editor opens once the server has sent it.
    fn start_editing(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        let language = path.rsplit('.').next().unwrap_or("text").to_owned();
        let input = cx.new(|cx| InputState::new(window, cx).code_editor(language).line_number(true).soft_wrap(false));
        let watched = path.clone();
        let subscription = cx.subscribe_in(&input, window, move |this, _, event, _, cx| {
            if let InputEvent::Change = event {
                this.typed(&watched, cx);
            }
        });
        if let Some(tab) = self.tabs.iter_mut().find(|t| t.path == path) {
            tab.editing = Some(Editor { input, written: String::new(), writes: 0, ready: false, others: vec![], _subscription: subscription });
        }
        let _ = self.worker.send(Job::Post(format!("/api/sessions/{}/filedoc", self.id), json!({ "path": path, "open": true })));
        cx.notify();
    }

    fn stop_editing(&mut self, path: &str, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.iter_mut().find(|t| t.path == path) {
            tab.editing = None;
        }
        let _ = self.worker.send(Job::Post(format!("/api/sessions/{}/filedoc", self.id), json!({ "path": path, "open": false })));
        // Afterwards the tab shows the file as it is now (the server writes it as people type).
        let path = path.to_owned();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(600)).await;
            let _ = this.update(cx, |this, cx| this.read_file(path, cx));
        })
        .detach();
        cx.notify();
    }

    fn typed(&mut self, path: &str, cx: &mut Context<Self>) {
        let id = self.id.clone();
        let Some(editor) = self.tabs.iter_mut().find(|t| t.path == path).and_then(|t| t.editing.as_mut()) else { return };
        if !editor.ready {
            return;
        }
        let state = editor.input.read(cx);
        let value = state.value().to_string();
        if value == editor.written {
            return;
        }
        let caret = value[..state.cursor().min(value.len())].encode_utf16().count();
        editor.written = value.clone();
        editor.writes += 1;
        let _ = self.worker.send(Job::Post(format!("/api/sessions/{id}/filedoc"), json!({ "path": path, "text": value, "caret": caret, "seq": editor.writes })));
    }

    /// Each file being edited, as the host has it now: what the others wrote goes into the editor (once the host
    /// has every write from here), and who else is in it.
    fn poll_editors(&mut self, cx: &mut Context<Self>) {
        for tab in &self.tabs {
            if tab.editing.is_none() {
                continue;
            }
            let (host, id, path) = (self.host.clone(), self.id.clone(), tab.path.clone());
            cx.spawn(async move |this, cx| {
                let query = crate::url_escape(&path);
                let now = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/filedoc?path={query}")) }).await;
                let Ok(now) = now else { return };
                let _ = this.update(cx, |this, cx| {
                    let Some(editor) = this.tabs.iter_mut().find(|t| t.path == path).and_then(|t| t.editing.as_mut()) else { return };
                    editor.others = now["writers"].as_array().into_iter().flatten().filter_map(|w| w["name"].as_str().map(str::to_owned)).collect();
                    // Only once the host has every write from here, counted as they are now (one typed while this
                    // was asked for makes the answer stale).
                    if !now["ready"].as_bool().unwrap_or(false) || now["seq"].as_u64().unwrap_or(0) < editor.writes {
                        return;
                    }
                    let remote = now["text"].as_str().unwrap_or_default().to_owned();
                    if !editor.ready || (remote != editor.written && editor.input.read(cx).value() == editor.written.as_str()) {
                        // Set on the next frame (it needs the window); marked ready and written only then.
                        this.pending_text.insert(path.clone(), remote);
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }
}

impl PanelView {
    fn tab_bar(&self, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let mut tabs: Vec<(Tab, String, bool)> = vec![(Tab::Changes, format!("Changes{}", if self.artifacts.is_empty() { String::new() } else { format!(" {}", self.artifacts.len()) }), false), (Tab::Git, "Git".into(), false)];
        tabs.extend(self.tabs.iter().map(|t| (Tab::File(t.path.clone()), t.path.rsplit('/').next().unwrap_or(&t.path).to_owned(), true)));
        tabs.extend(self.previews.iter().map(|(title, _)| (Tab::Preview(title.clone()), title.rsplit('/').next().unwrap_or(title).to_owned(), true)));
        let mut bar = div().id("panel-tabs").h(px(40.)).flex_none().flex().items_end().gap(px(2.)).px_2().border_b_1().border_color(p.rule).overflow_x_scroll();
        for (n, (tab, label, closable)) in tabs.into_iter().enumerate() {
            let on = tab == self.active;
            let (open, close) = (tab.clone(), tab.clone());
            bar = bar.child(
                div()
                    .id(SharedString::from(format!("panel-tab-{n}")))
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .h(px(32.))
                    .px_2()
                    .rounded_t(px(6.))
                    .text_size(sz(12.5))
                    .cursor_pointer()
                    .when(on, |d| d.bg(p.raised).text_color(p.ink).border_1().border_b_0().border_color(p.rule))
                    .when(!on, |d| d.text_color(p.muted).hover(|s| s.text_color(p.ink)))
                    .child(label)
                    .when(closable, |d| {
                        d.child(
                            div()
                                .id(SharedString::from(format!("panel-close-{n}")))
                                .p(px(2.))
                                .rounded(px(4.))
                                .hover(|s| s.bg(p.sunken))
                                .child(Icon::new(IconName::Close).size(px(11.)))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.close_tab(&close, cx);
                                })),
                        )
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.active = open.clone();
                        if open == Tab::Git {
                            this.load_git(None, cx);
                        }
                        cx.notify();
                    })),
            );
        }
        bar.child(div().flex_1()).child(
            div()
                .flex()
                .items_center()
                .h(px(32.))
                .gap_1()
                .child(icon_button("panel-tree", Icon::default().path("syncpi/code.svg"), self.tree_open, p).on_click(cx.listener(|this, _, _, cx| this.toggle_tree(cx))))
                .child(icon_button("panel-hide", Icon::new(IconName::Close), false, p).on_click(cx.listener(|_, _, _, cx| cx.emit(PanelEvent::Close)))),
        )
    }

    /// Newest change per file, by file.
    fn newest(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for a in &self.artifacts {
            if let Some(path) = &a.path {
                out.insert(path.clone(), a.key.clone());
            }
        }
        out
    }

    fn changes(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        if self.artifacts.is_empty() {
            return empty("Changes the agent makes, files it writes, and HTML or SVG it produces show up here.", &p);
        }
        let selected = self.selected.clone().filter(|k| self.artifacts.iter().any(|a| a.key == *k)).unwrap_or_else(|| self.artifacts.last().unwrap().key.clone());
        let newest = self.newest();
        let mut groups: Vec<(String, Vec<Art>)> = vec![];
        for a in self.artifacts.iter().rev() {
            let group = a.path.clone().unwrap_or_else(|| "Snippets".into());
            match groups.iter_mut().find(|(g, _)| *g == group) {
                Some((_, list)) => list.push(a.clone()),
                None => groups.push((group, vec![a.clone()])),
            }
        }
        let mut list = div().id("changes-list").w(px(210.)).flex_none().h_full().overflow_y_scroll().border_r_1().border_color(p.rule).py_1();
        for (group, arts) in groups {
            let seen = newest.get(&group).is_some_and(|k| self.seen.get(&group) == Some(k));
            let marking = group.clone();
            list = list.child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .pt_2()
                    .pb_1()
                    .child(div().flex_1().min_w_0().truncate().font_family(MONO).text_size(sz(11.5)).text_color(if seen { p.faint } else { p.ink_2 }).child(group.clone()))
                    .when(newest.contains_key(&group), |d| {
                        d.child(
                            div()
                                .id(SharedString::from(format!("seen-{group}")))
                                .flex_none()
                                .text_size(sz(11.))
                                .text_color(if seen { p.accent } else { p.faint })
                                .cursor_pointer()
                                .child(if seen { "✓ Seen" } else { "Seen" })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let newest = this.newest();
                                    if this.seen.remove(&marking).is_none()
                                        && let Some(key) = newest.get(&marking)
                                    {
                                        this.seen.insert(marking.clone(), key.clone());
                                    }
                                    cx.notify();
                                })),
                        )
                    }),
            );
            if seen {
                continue;
            }
            let count = arts.len();
            for (n, a) in arts.into_iter().enumerate() {
                let on = a.key == selected;
                let label = match a.source {
                    "reply" => a.title.clone(),
                    _ if a.kind == "diff" => "Edit".into(),
                    _ => "Written".into(),
                };
                let stats = (a.kind == "diff").then(|| patch_stats(&a.content));
                let key = a.key.clone();
                list = list.child(
                    div()
                        .id(SharedString::from(format!("change-{}", a.key)))
                        .flex()
                        .items_center()
                        .gap_2()
                        .mx_1()
                        .px_2()
                        .py(px(4.))
                        .rounded(px(5.))
                        .text_size(sz(12.5))
                        .cursor_pointer()
                        .when(on, |d| d.bg(p.sunken).text_color(p.ink))
                        .when(!on, |d| d.text_color(p.ink_2).hover(|s| s.bg(p.sunken.opacity(0.6))))
                        .child(div().flex_1().child(label))
                        .when(n == 0 && count > 1, |d| d.child(div().text_size(sz(11.)).text_color(p.faint).child("latest")))
                        .children(stats.map(|(added, removed)| div().flex().gap_1().font_family(MONO).text_size(sz(11.)).child(div().text_color(p.added).child(format!("+{added}"))).child(div().text_color(p.removed).child(format!("−{removed}")))))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected = Some(key.clone());
                            cx.notify();
                        })),
                );
            }
        }
        let art = self.artifacts.iter().find(|a| a.key == selected).cloned().unwrap();
        let big = self.artifact_view(&art, window, cx);
        div().size_full().flex().child(list).child(div().flex_1().min_w_0().h_full().child(big)).into_any_element()
    }

    /// An artifact shown large: a diff, a page, an image, Markdown or code.
    fn artifact_view(&mut self, art: &Art, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let head = div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(34.))
            .flex_none()
            .border_b_1()
            .border_color(p.rule)
            .child(div().font_family(MONO).text_size(sz(10.5)).text_color(p.accent).child(art.kind.to_uppercase()))
            .child(div().flex_1().min_w_0().truncate().text_size(sz(12.5)).text_color(p.ink_2).child(art.title.clone()))
            .children(art.path.clone().map(|path| {
                link_button(&format!("open-{}", art.key), "Open file", &p).on_click(cx.listener(move |this, _, _, cx| this.open_file(path.clone(), cx)))
            }));
        let body: AnyElement = match art.kind {
            "diff" => div().id("art-diff").size_full().overflow_y_scroll().p_3().child(diff_view(format!("panel-{}", art.key), &art.content, &p).max_h(px(100000.))).into_any_element(),
            "html" => self.webview_for(&art.key, |b| b.with_incognito(true).with_html(&art.content), window, cx),
            "svg" => {
                let (image, natural) = artifact::svg_image(&art.content);
                div().size_full().flex().items_center().justify_center().bg(gpui::white()).child(artifact::picture(image, 520., natural)).into_any_element()
            }
            "markdown" => div().id("art-md").size_full().overflow_y_scroll().px_5().py_4().text_size(sz(14.5)).line_height(sz(23.)).child(message::render(&format!("art-{}", art.key), &art.content, window, cx)).into_any_element(),
            _ => code_lines(&format!("art-{}", art.key), &art.lang, &art.content, None, &p, cx, None),
        };
        div().size_full().flex().flex_col().child(head).child(div().flex_1().min_h_0().child(body)).into_any_element()
    }

    /// A webview showing `key` (built once, kept while it's what's shown).
    fn webview_for(&mut self, key: &str, build: impl FnOnce(wry::WebViewBuilder) -> wry::WebViewBuilder, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.webview.as_ref().is_none_or(|(k, _)| k != key) {
            self.webview = build(wry::WebViewBuilder::new()).build_as_child(window).ok().map(|w| (key.to_owned(), cx.new(|cx| WebView::new(w, window, cx))));
        }
        match &self.webview {
            Some((_, view)) => div().size_full().child(view.clone()).into_any_element(),
            None => empty("Couldn't show this page.", &palette(cx)),
        }
    }

    fn file_view(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let Some(tab) = self.tabs.iter().find(|t| t.path == path) else { return empty("", &p) };
        let markdown = artifact::kind_of_path(path) == artifact::Kind::Markdown;
        let (editing, rendered, lines, before) = (tab.editing.is_some(), tab.rendered, tab.lines, tab.before);
        let found = self.find_lines(cx);
        let current = self.find.as_ref().and_then(|f| found.get(f.1).copied());
        let scroll = self.code_scroll.clone();
        let others = tab.editing.as_ref().map(|e| e.others.clone()).unwrap_or_default();
        let ready = tab.editing.as_ref().is_some_and(|e| e.ready);
        let (edit_path, toggle_path, reload_path) = (path.to_owned(), path.to_owned(), path.to_owned());
        let head = div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(34.))
            .flex_none()
            .border_b_1()
            .border_color(p.rule)
            .child(div().flex_1().min_w_0().truncate().font_family(MONO).text_size(sz(12.)).text_color(p.ink_2).child(path.to_owned()))
            .when(editing && !others.is_empty(), |d| d.child(div().text_size(sz(12.)).text_color(p.muted).child(format!("with {}", others.join(", ")))))
            .when(markdown && !editing, |d| {
                d.child(link_button("md-toggle", if rendered { "Source" } else { "Rendered" }, &p).on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(tab) = this.tabs.iter_mut().find(|t| t.path == toggle_path) {
                        tab.rendered = !tab.rendered;
                    }
                    cx.notify();
                })))
            })
            .when(!editing, |d| {
                // Delta's version picker: the file now, or as it was before the thread's last turn.
                let (latest_path, before_path) = (reload_path.clone(), reload_path.clone());
                let option = |id: &'static str, label: &'static str, on: bool| {
                    div().id(id).px_2().py(px(2.)).rounded(px(5.)).text_size(sz(12.)).cursor_pointer().when(on, |d| d.bg(p.raised).text_color(p.ink).shadow_sm()).when(!on, |d| d.text_color(p.muted)).child(label)
                };
                d.child(
                    div()
                        .flex()
                        .p(px(2.))
                        .gap(px(2.))
                        .rounded(px(6.))
                        .bg(p.sunken)
                        .child(option("version-latest", "Latest", !before).on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(tab) = this.tabs.iter_mut().find(|t| t.path == latest_path) {
                                tab.before = false;
                            }
                            cx.notify();
                        })))
                        .child(option("version-before", "Before last turn", before).on_click(cx.listener(move |this, _, _, cx| {
                            let load = this.tabs.iter_mut().find(|t| t.path == before_path).map(|tab| {
                                tab.before = true;
                                tab.lines = None;
                                tab.earlier.is_none()
                            });
                            if load == Some(true) {
                                this.read_earlier(before_path.clone(), cx);
                            }
                            cx.notify();
                        }))),
                )
            })
            .when(!editing && !before, |d| d.child(link_button("file-reload", "Reload", &p).on_click(cx.listener(move |this, _, _, cx| this.read_file(reload_path.clone(), cx)))))
            .when(!before, |d| d.child(link_button("file-edit", if editing { "Done" } else { "Edit" }, &p).on_click(cx.listener(move |this, _, window, cx| {
                if editing {
                    this.stop_editing(&edit_path, cx);
                } else {
                    this.start_editing(edit_path.clone(), window, cx);
                }
            }))));
        let body: AnyElement = if let Some(editor) = &tab.editing {
            if ready {
                div().size_full().font_family(MONO).text_size(sz(12.5)).child(Input::new(&editor.input).appearance(false).h_full()).into_any_element()
            } else {
                empty("Opening the file to write together…", &p)
            }
        } else if before {
            // An earlier version is for reading: no comments on lines that may not exist any more.
            match &tab.earlier {
                None => empty("Loading…", &p),
                Some(Err(e)) => empty(e, &p),
                Some(Ok(text)) if markdown && rendered => div().id("file-md-before").size_full().overflow_y_scroll().px_5().py_4().text_size(sz(14.5)).line_height(sz(23.)).child(message::render(&format!("before-{path}"), text, window, cx)).into_any_element(),
                Some(Ok(text)) => code_lines_found(&format!("before-{path}"), path.rsplit('.').next().unwrap_or(""), text, None, (&found, current), Some(&scroll), &p, cx, None),
            }
        } else {
            match &tab.text {
                None => empty("Opening…", &p),
                Some(Err(e)) => empty(e, &p),
                Some(Ok(text)) if markdown && rendered => div().id("file-md").size_full().overflow_y_scroll().px_5().py_4().text_size(sz(14.5)).line_height(sz(23.)).child(message::render(&format!("file-{path}"), text, window, cx)).into_any_element(),
                Some(Ok(text)) => {
                    let lang = path.rsplit('.').next().unwrap_or("").to_owned();
                    let picking = path.to_owned();
                    let pick: std::rc::Rc<dyn Fn(&mut Self, usize, bool, &mut Window, &mut Context<Self>)> = std::rc::Rc::new(move |this, line, shift, window, cx| this.pick_line(&picking, line, shift, window, cx));
                    code_lines_found(&format!("file-{path}"), &lang, text, lines, (&found, current), Some(&scroll), &p, cx, Some(pick))
                }
            }
        };
        let comment_bar = lines.filter(|_| !editing).map(|(start, end)| {
            div()
                .flex_none()
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .border_t_1()
                .border_color(p.rule)
                .bg(p.raised)
                .child(div().text_size(sz(12.5)).text_color(p.muted).child(if start == end { format!("Comment on line {start}") } else { format!("Comment on lines {start}–{end}") }))
                .child(div().px_2().py(px(5.)).rounded(px(6.)).border_1().border_color(p.rule_strong).bg(p.paper).child(Input::new(&self.comment).appearance(false).px_0().text_size(sz(14.))))
                .child(div().flex().justify_end().child(link_button("comment-lines", "Comment", &p).on_click(cx.listener(|this, _, window, cx| this.send_comment(window, cx)))))
        });
        div().size_full().flex().flex_col().child(head).child(div().flex_1().min_h_0().child(body)).children(comment_bar).into_any_element()
    }

    fn git_view(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let git = match &self.git {
            None => return empty("Reading git…", &p),
            Some(Err(e)) => return empty(e, &p),
            Some(Ok(git)) => git.clone(),
        };
        let files = git["files"].as_array().cloned().unwrap_or_default();
        let mut body = div().flex().flex_col().gap_3().p_3();
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(Icon::default().path("syncpi/git-branch.svg").size(px(14.)).text_color(p.muted))
                .child(div().font_family(MONO).text_size(sz(12.5)).child(git["branch"].as_str().unwrap_or("(no branch)").to_owned()))
                .child(div().flex_1())
                .child(link_button("git-refresh", "Refresh", &p).on_click(cx.listener(|this, _, _, cx| this.load_git(None, cx)))),
        );
        if files.is_empty() {
            return body.child(div().text_size(sz(13.)).text_color(p.muted).child("Nothing uncommitted.")).into_any_element();
        }
        body = body.child(
            div()
                .flex()
                .gap_2()
                .child(div().flex_1().px_2().py(px(5.)).rounded(px(6.)).border_1().border_color(p.rule_strong).bg(p.paper).child(Input::new(&self.commit).appearance(false).px_0().text_size(sz(13.5))))
                .child(link_button("git-commit", "Commit staged", &p).on_click(cx.listener(|this, _, _, cx| this.commit(cx)))),
        );
        let patches = |diff: &str| -> HashMap<String, String> {
            let mut out = HashMap::new();
            for part in diff.split("\ndiff --git ").map(|s| s.trim_start_matches("diff --git ")) {
                let Some(first) = part.lines().next() else { continue };
                let path = first.split(" b/").nth(1).unwrap_or("").to_owned();
                if !path.is_empty() {
                    out.insert(path, format!("diff --git {part}"));
                }
            }
            out
        };
        let (unstaged, staged) = (patches(git["diff"].as_str().unwrap_or("")), patches(git["staged"].as_str().unwrap_or("")));
        for f in files {
            let status = f["status"].as_str().unwrap_or("  ").to_owned();
            let path = f["path"].as_str().unwrap_or_default().to_owned();
            let is_staged = !status.starts_with(' ') && !status.starts_with('?');
            let patch = unstaged.get(&path).or(staged.get(&path)).cloned();
            let staging = path.clone();
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().w(px(22.)).font_family(MONO).text_size(sz(11.5)).text_color(if status.contains('?') { p.added } else { p.warn }).child(status.trim().to_owned()))
                            .child(div().flex_1().min_w_0().truncate().font_family(MONO).text_size(sz(12.5)).child(path.clone()))
                            .when(is_staged, |d| d.child(div().text_size(sz(11.5)).text_color(p.ok).child("staged")))
                            .when(!is_staged || unstaged.contains_key(&path), |d| {
                                d.child(link_button(&format!("stage-{path}"), "Stage", &p).on_click(cx.listener(move |this, _, _, cx| this.load_git(Some(json!({ "action": "stage", "path": staging })), cx))))
                            }),
                    )
                    .children(patch.map(|patch| diff_view(format!("git-{path}"), &patch, &p))),
            );
        }
        div().id("git-body").size_full().overflow_y_scroll().child(body).into_any_element()
    }

    /// The project's files as a tree (⇧⌘E): folders open and close; files the thread changed are marked.
    fn tree(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let Some(files) = &self.files else { return div().w(px(230.)).p_3().text_size(sz(12.5)).text_color(p.muted).child("Reading the project…").into_any_element() };
        let changed: HashSet<String> = self
            .artifacts
            .iter()
            .filter(|a| a.source != "reply")
            .filter_map(|a| a.path.clone())
            .flat_map(|path| files.iter().filter(move |f| **f == path || path.ends_with(&format!("/{f}"))).cloned())
            .collect();
        let mut list = div().id("tree").w(px(230.)).flex_none().h_full().overflow_y_scroll().border_l_1().border_color(p.rule).bg(p.sunken).py_1();
        let mut shown_dirs: HashSet<String> = HashSet::new();
        let mut sorted = files.clone();
        sorted.sort();
        for file in &sorted {
            let parts: Vec<&str> = file.split('/').collect();
            // Its folders, each once, while every folder above is open.
            let mut visible = true;
            for depth in 0..parts.len() - 1 {
                let dir = parts[..=depth].join("/");
                if !visible {
                    break;
                }
                if shown_dirs.insert(dir.clone()) {
                    let open = self.expanded.contains(&dir);
                    let toggling = dir.clone();
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("dir-{dir}")))
                            .flex()
                            .items_center()
                            .gap_1()
                            .h(px(24.))
                            .pl(px(8. + depth as f32 * 12.))
                            .text_size(sz(12.5))
                            .text_color(p.ink_2)
                            .cursor_pointer()
                            .hover(|s| s.bg(p.rule.opacity(0.5)))
                            .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).size(px(12.)).text_color(p.faint))
                            .child(parts[depth].to_owned())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.expanded.remove(&toggling) {
                                    this.expanded.insert(toggling.clone());
                                }
                                cx.notify();
                            })),
                    );
                }
                visible = self.expanded.contains(&dir);
            }
            if !visible {
                continue;
            }
            let opening = file.clone();
            let on = self.active == Tab::File(file.clone());
            list = list.child(
                div()
                    .id(SharedString::from(format!("file-{file}")))
                    .flex()
                    .items_center()
                    .gap_1()
                    .h(px(24.))
                    .pl(px(21. + (parts.len() - 1) as f32 * 12.))
                    .pr_2()
                    .text_size(sz(12.5))
                    .cursor_pointer()
                    .when(on, |d| d.bg(p.rule))
                    .hover(|s| s.bg(p.rule.opacity(0.5)))
                    .child(div().flex_1().min_w_0().truncate().text_color(if changed.contains(file) { p.accent } else { p.ink }).child(parts[parts.len() - 1].to_owned()))
                    .when(changed.contains(file), |d| d.child(div().size(px(6.)).rounded_full().bg(p.accent)))
                    .on_click(cx.listener(move |this, _, _, cx| this.open_file(opening.clone(), cx))),
            );
        }
        list.into_any_element()
    }
}

impl PanelView {
    /// Text that arrived for an editor, set on the next frame (setting it needs the window).
    fn apply_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (path, text) in std::mem::take(&mut self.pending_text) {
            let Some(editor) = self.tabs.iter_mut().find(|t| t.path == path).and_then(|t| t.editing.as_mut()) else { continue };
            // Typed in since the text arrived: what's typed wins, and the next poll brings the rest.
            if editor.ready && editor.input.read(cx).value() != editor.written.as_str() {
                continue;
            }
            Self::set_editor_text(editor, text, window, cx);
        }
    }

    fn set_editor_text(editor: &mut Editor, text: String, window: &mut Window, cx: &mut Context<Self>) {
        // Written first: setting the value reports a change, which must not go back to the host as typing.
        editor.ready = true;
        editor.written = text.clone();
        let cursor = editor.input.read(cx).cursor().min(text.len());
        let mut at = cursor;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        editor.input.update(cx, |state, cx| {
            state.set_value(text.clone(), window, cx);
            let before = &text[..at];
            let line = before.matches('\n').count() as u32;
            let character = before.rsplit('\n').next().unwrap_or("").chars().count() as u32;
            state.set_cursor_position(gpui_component::input::Position { line, character }, window, cx);
        });
    }
}

impl Render for PanelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.apply_pending(window, cx);
        let p = palette(cx);
        let active = self.active.clone();
        let body = match &active {
            Tab::Changes => self.changes(window, cx),
            Tab::Git => self.git_view(cx),
            Tab::File(path) => self.file_view(&path.clone(), window, cx),
            Tab::Preview(title) => match self.previews.iter().find(|(t, _)| t == title).map(|(_, s)| s.clone()) {
                Some(Shown::Html { content, .. }) => self.webview_for(&format!("preview-{title}"), |b| b.with_incognito(true).with_html(&content), window, cx),
                Some(Shown::Page { url, .. }) => self.webview_for(&format!("page-{url}"), |b| b.with_url(&url), window, cx),
                Some(Shown::Image { image, .. }) => div().size_full().flex().items_center().justify_center().p_4().bg(gpui::white()).child(img(image).max_w_full().max_h_full().object_fit(ObjectFit::Contain)).into_any_element(),
                Some(Shown::Markdown { content, title }) => div().id("preview-md").size_full().overflow_y_scroll().px_5().py_4().text_size(sz(14.5)).line_height(sz(23.)).child(message::render(&format!("preview-{title}"), &content, window, cx)).into_any_element(),
                None => empty("", &p),
            },
        };
        // A webview not shown this frame is hidden (it would draw over the panel otherwise).
        let showing_page = matches!(&active, Tab::Preview(t) if self.previews.iter().any(|(pt, s)| pt == t && matches!(s, Shown::Html { .. } | Shown::Page { .. })))
            || (active == Tab::Changes && self.selected_art().is_some_and(|a| a.kind == "html"));
        if let Some((_, view)) = &self.webview {
            view.update(cx, |w, _| if showing_page { w.show() } else { w.hide() });
        }
        let tree = self.tree_open.then(|| self.tree(cx));
        // Find's current line, a few lines from the top.
        if let Some(line) = self.scroll_to.take() {
            let height = sz(19.).to_pixels(window.rem_size());
            let x = self.code_scroll.offset().x;
            self.code_scroll.set_offset(point(x, -(height * (line.saturating_sub(4)) as f32)));
        }
        let find = self.find_bar(cx);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(p.surface)
            .key_context("Panel")
            .track_focus(&self.focus)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, _| {
                if this.find.is_none() {
                    window.focus(&this.focus);
                }
            }))
            .on_action(cx.listener(|this, action: &crate::keymap::RunCommand, window, cx| this.command(action, window, cx)))
            .child(self.tab_bar(&p, cx))
            .children(find)
            .child(div().flex_1().min_h_0().flex().child(div().flex_1().min_w_0().h_full().bg(p.raised).child(body)).children(tree))
    }
}

impl PanelView {
    fn selected_art(&self) -> Option<&Art> {
        let key = self.selected.clone().or_else(|| self.artifacts.last().map(|a| a.key.clone()))?;
        self.artifacts.iter().find(|a| a.key == key)
    }
}

/// Code with line numbers and syntax colors. With `pick`, the numbers select lines (shift extends) to comment on;
/// `selected` lines are tinted.
fn code_lines(id: &str, lang: &str, text: &str, selected: Option<(usize, usize)>, p: &Palette, cx: &mut Context<PanelView>, pick: Option<std::rc::Rc<dyn Fn(&mut PanelView, usize, bool, &mut Window, &mut Context<PanelView>)>>) -> AnyElement {
    code_lines_found(id, lang, text, selected, (&[], None), None, p, cx, pick)
}

/// Code with line numbers, with Find's lines tinted (the current one more) and its scroll followed.
#[allow(clippy::too_many_arguments)]
fn code_lines_found(id: &str, lang: &str, text: &str, selected: Option<(usize, usize)>, found: (&[usize], Option<usize>), scroll: Option<&ScrollHandle>, p: &Palette, cx: &mut Context<PanelView>, pick: Option<std::rc::Rc<dyn Fn(&mut PanelView, usize, bool, &mut Window, &mut Context<PanelView>)>>) -> AnyElement {
    let shown: String = text.split('\n').take(5000).collect::<Vec<_>>().join("\n");
    let lines = message::highlighted_lines(lang, &shown, cx);
    let width = (lines.len().to_string().len() as f32 * 8. + 18.).max(34.);
    let mut column = div().flex().flex_col().min_w_full().py_2();
    for (n, line) in lines.into_iter().enumerate() {
        let number = n + 1;
        let on = selected.is_some_and(|(a, b)| a <= number && number <= b);
        let hit = found.0.contains(&number);
        let current = found.1 == Some(number);
        let pick = pick.clone();
        column = column.child(
            div()
                .flex()
                .when(hit, |d| d.bg(hsla(43. / 360., 1., 0.62, if current { 0.38 } else { 0.16 })))
                .when(on, |d| d.bg(p.accent.opacity(0.12)))
                .child(
                    div()
                        .id(SharedString::from(format!("{id}-line-{number}")))
                        .w(px(width))
                        .flex_none()
                        .text_right()
                        .pr_3()
                        .text_color(if on { p.accent } else { p.faint })
                        .when(pick.is_some(), |d| d.cursor_pointer().hover(|s| s.text_color(p.ink)))
                        .child(number.to_string())
                        .when_some(pick, |d, pick| d.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| pick(this, number, event.modifiers().shift, window, cx)))),
                )
                .child(div().whitespace_nowrap().pr_4().child(line)),
        );
    }
    let mut view = div().id(SharedString::from(id.to_owned())).size_full().overflow_scroll().font_family(MONO).text_size(sz(12.)).line_height(sz(19.));
    if let Some(scroll) = scroll {
        view = view.track_scroll(scroll);
    }
    view.child(column).into_any_element()
}

fn empty(text: &str, p: &Palette) -> AnyElement {
    div().size_full().flex().items_center().justify_center().p_5().text_size(sz(13.)).text_color(p.muted).child(text.to_owned()).into_any_element()
}

fn link_button(id: &str, label: &str, p: &Palette) -> Stateful<Div> {
    div()
        .id(SharedString::from(id.to_owned()))
        .flex_none()
        .px_2()
        .py(px(3.))
        .rounded(px(5.))
        .border_1()
        .border_color(p.rule)
        .text_size(sz(12.))
        .text_color(p.ink_2)
        .cursor_pointer()
        .hover(|s| s.bg(p.sunken).text_color(p.ink))
        .child(label.to_owned())
}

fn icon_button(id: &'static str, icon: Icon, on: bool, p: &Palette) -> Stateful<Div> {
    div().id(id).p(px(5.)).rounded(px(5.)).text_color(if on { p.accent } else { p.muted }).cursor_pointer().hover(|s| s.bg(p.sunken)).child(icon.size(px(14.)))
}

