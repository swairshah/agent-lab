mod backend;
mod citations;
mod diagram;
mod icons;
mod keymap;
mod message;
mod palette;
mod prose;
mod settings;
mod sidebar;
mod theme;
mod transcript;
use backend::{Backend, Event};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    ActiveTheme, Root, Sizable,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenu},
    text::TextView,
    *,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::{Receiver, Sender},
    time::{Duration, Instant},
};

use keymap::RunCommand;
use palette::{PaletteState, Tab};
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}
fn array(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}
fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
/// The highlighter language for a file, from its extension.
fn language_of(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "md" | "mdx" => "markdown",
        "json" | "jsonc" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" | "htm" => "html",
        "css" | "scss" => "css",
        "sh" | "bash" | "zsh" => "bash",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "cs" => "csharp",
        "java" => "java",
        "swift" => "swift",
        "sql" => "sql",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "scala" => "scala",
        "proto" => "proto",
        _ => "plain",
    }
}
fn label(text: impl Into<SharedString>) -> Div {
    div().child(text.into())
}
fn eid(value: String) -> ElementId {
    SharedString::from(value).into()
}
struct TerminalTab {
    id: usize,
    session: String,
    parser: vt100::Parser,
    sender: Sender<String>,
    closed: bool,
}
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct Preferences {
    active: String,
    dark: bool,
    sidebar: Option<bool>,
    /// Text size, as a scale of the default (⌘+ / ⌘− / ⌘0).
    zoom: Option<f32>,
    drafts: HashMap<String, String>,
    files: HashMap<String, (String, String)>,
}
fn preference_path() -> std::path::PathBuf {
    std::env::var_os("SYNCPI_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".syncpi")
        })
        .join("desktop-ui.json")
}

struct Desktop {
    backend: Backend,
    receiver: Receiver<Event>,
    sessions: Vec<Value>,
    catalog: Value,
    native: Value,
    active: String,
    composer: Entity<InputState>,
    editor: Entity<InputState>,
    fields: HashMap<&'static str, Entity<InputState>>,
    _subscriptions: Vec<Subscription>,
    prefs: Preferences,
    modal: String,
    pane: String,
    project: String,
    archived: bool,
    showing: String,
    where_vm: bool,
    steer: bool,
    collapsed: HashSet<String>,
    /// Projects folded in the sidebar.
    folded: HashSet<String>,
    /// The new-thread dialog's extra options are showing.
    advanced: bool,
    palette: Option<PaletteState>,
    palette_input: Entity<InputState>,
    palette_scroll: ScrollHandle,
    /// Lines of the open file being commented on, and the comment being written.
    comment_lines: Option<(usize, usize)>,
    comment_input: Entity<InputState>,
    thinking: HashSet<String>,
    scroll: ScrollHandle,
    files: Vec<String>,
    file_path: String,
    file_hash: String,
    /// The open file as the project has it, to tell a real local edit from the file as loaded.
    file_text: String,
    /// A cited file being opened, and the line to put the cursor on when it arrives.
    cite_line: Option<(String, usize)>,
    git: Value,
    share_url: String,
    models: Vec<Value>,
    last_invite: String,
    target_member: String,
    terminals: Vec<TerminalTab>,
    terminal_id: usize,
    terminal_visible: bool,
    terminal_focus: FocusHandle,
    focus: FocusHandle,
    toast: String,
    toast_at: Instant,
    last_error: String,
    busy: bool,
    sidebar: bool,
}
impl Desktop {
    fn new(
        backend: Backend,
        receiver: Receiver<Event>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let prefs: Preferences = std::fs::read(preference_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        theme::apply(prefs.dark, prefs.zoom.unwrap_or(1.), Some(window), cx);
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(1, 14)
                .placeholder("@ for files, / for commands, ! for a terminal. ⌘↩ to send")
        });
        let editor = cx.new(|cx| {
            InputState::new(window, cx)
                .code_editor("plain")
                .line_number(true)
        });
        let palette_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Search commands, threads and files…")
        });
        let comment_input = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(2, 8)
                .placeholder("Comment on these lines. ⌘↩ to send")
        });
        let subscriptions = vec![
            cx.subscribe_in(&comment_input, window, |this, _, event, window, cx| {
                if let InputEvent::PressEnter { secondary: true } = event {
                    this.send_comment(window, cx);
                }
            }),
            cx.subscribe_in(
                &palette_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::Change => {
                        if let Some(state) = this.palette.as_mut() {
                            state.selected = 0;
                        }
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => {
                        let index = this.palette.as_ref().map_or(0, |s| s.selected);
                        this.run_palette_row(index, window, cx);
                    }
                    _ => {}
                },
            ),
            cx.subscribe_in(
                &composer,
                window,
                |this, _, event, window, cx| match event {
                    // Enter starts a new line; ⌘↩ sends.
                    InputEvent::PressEnter { secondary: true } => this.submit(window, cx),
                    InputEvent::Change => {
                        this.prefs.drafts.insert(
                            this.active.clone(),
                            this.composer.read(cx).value().to_string(),
                        );
                        this.persist();
                        cx.notify();
                    }
                    _ => {}
                },
            ),
            cx.subscribe_in(&editor, window, |this, _, event, _, cx| {
                if matches!(event, InputEvent::Change) && !this.file_path.is_empty() {
                    // A draft is kept only while the editor differs from the file.
                    let key = format!("{}:{}", this.active, this.file_path);
                    let value = this.editor.read(cx).value().to_string();
                    if value == this.file_text {
                        this.prefs.files.remove(&key);
                    } else {
                        this.prefs
                            .files
                            .insert(key, (value, this.file_hash.clone()));
                    }
                    this.persist();
                }
            }),
        ];
        let active = prefs.active.clone();
        backend.select(&active);
        let sidebar = prefs.sidebar.unwrap_or(true);
        let focus = cx.focus_handle();
        if active.is_empty() {
            focus.focus(window);
        } else {
            let draft = prefs.drafts.get(&active).cloned().unwrap_or_default();
            composer.update(cx, |state, cx| {
                state.set_value(draft, window, cx);
                state.focus(window, cx);
            });
        }
        let this = Self {
            backend,
            receiver,
            sessions: vec![],
            catalog: Value::Null,
            native: Value::Null,
            active,
            composer,
            editor,
            fields: HashMap::new(),
            _subscriptions: subscriptions,
            prefs,
            modal: String::new(),
            pane: String::new(),
            project: String::new(),
            archived: false,
            showing: "main".into(),
            where_vm: false,
            steer: false,
            collapsed: HashSet::new(),
            folded: HashSet::new(),
            advanced: false,
            palette: None,
            palette_input,
            palette_scroll: ScrollHandle::new(),
            comment_lines: None,
            comment_input,
            thinking: HashSet::new(),
            scroll: ScrollHandle::new(),
            files: vec![],
            file_path: String::new(),
            file_hash: String::new(),
            file_text: String::new(),
            cite_line: None,
            git: Value::Null,
            share_url: String::new(),
            models: vec![],
            last_invite: String::new(),
            target_member: String::new(),
            terminals: vec![],
            terminal_id: 0,
            terminal_visible: false,
            terminal_focus: cx.focus_handle(),
            focus,
            toast: String::new(),
            toast_at: Instant::now(),
            last_error: String::new(),
            busy: false,
            sidebar,
        };
        // The project's files, so file names in backticks can link to them.
        if !this.active.is_empty() {
            this.request("files", "GET", "files", None);
        }
        cx.spawn_in(window, async move |entity, cx| {
            loop {
                smol::Timer::after(Duration::from_millis(60)).await;
                if entity
                    .update_in(cx, |this, window, cx| this.poll(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        this
    }
    fn persist(&self) {
        let p = preference_path();
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(&self.prefs) {
            let temp = p.with_extension("tmp");
            let _ = std::fs::write(&temp, bytes);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(temp, p);
        }
    }
    fn notice(&mut self, message: impl Into<String>, cx: &mut Context<Self>) {
        self.toast = message.into();
        self.toast_at = Instant::now();
        cx.notify();
    }
    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let events: Vec<_> = self.receiver.try_iter().collect();
        let mut changed = false;
        for event in events {
            changed = true;
            match event {
                Event::Catalog(data) => {
                    self.sessions = array(&data, "sessions");
                    self.catalog = data;
                }
                Event::Snapshot(id, data) if id == self.active => {
                    let old_rev = self.native[&self.showing]["rev"].as_u64();
                    let new_rev = data[&self.showing]["rev"].as_u64();
                    if old_rev != new_rev {
                        let offset = self.scroll.offset();
                        let max = self.scroll.max_offset();
                        if -offset.y + px(120.) >= max.height {
                            self.scroll.scroll_to_bottom();
                        }
                    }
                    let error = text(&data, "error");
                    if !error.is_empty() && error != self.last_error {
                        self.notice(error.clone(), cx);
                        self.last_error = error;
                    }
                    if let Some(url) = data["lastInvite"]["url"].as_str() {
                        if self.last_invite != url {
                            self.last_invite = url.into();
                            self.share_url = url.into();
                            self.modal = "share".into();
                        }
                    }
                    self.native = data;
                }
                Event::Reply {
                    session,
                    tag,
                    value,
                } => {
                    self.busy = false;
                    if tag == "create" || tag == "join" {
                        if let Some(id) = value["id"].as_str() {
                            self.select(id.to_owned(), window, cx);
                            self.modal.clear();
                        }
                    } else if session == self.active {
                        match tag.as_str() {
                            "files" => {
                                self.files = array(&value, "files")
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect();
                                citations::set_files(&self.files);
                            }
                            "git" => self.git = value,
                            "models" => self.models = array(&value, "models"),
                            "sync" => self.notice("Project synchronized", cx),
                            "title" => self.notice("Thread title updated", cx),
                            "saved" => {}
                            _ if tag.starts_with("file:") => {
                                self.file_path = tag[5..].into();
                                self.file_hash = text(&value, "hash");
                                self.file_text = text(&value, "text");
                                let key = format!("{}:{}", self.active, self.file_path);
                                let saved = self.prefs.files.get(&key).cloned();
                                let content = if let Some((text, base)) = saved {
                                    self.file_hash = base;
                                    text
                                } else {
                                    text(&value, "text")
                                };
                                let language = language_of(&self.file_path);
                                let cited = self
                                    .cite_line
                                    .take()
                                    .filter(|(path, _)| *path == self.file_path)
                                    .map(|(_, line)| line);
                                self.editor.update(cx, |editor, cx| {
                                    editor.set_highlighter(language, cx);
                                    editor.set_value(content, window, cx);
                                    // Opened from a citation: the cursor goes to the cited line.
                                    if let Some(line) = cited {
                                        editor.set_cursor_position(
                                            gpui_component::input::Position::new(
                                                line.saturating_sub(1) as u32,
                                                0,
                                            ),
                                            window,
                                            cx,
                                        );
                                    }
                                });
                            }
                            _ if tag.starts_with("saved:") => {
                                self.file_hash = text(&value, "hash");
                                self.file_text = self.editor.read(cx).value().to_string();
                                self.prefs
                                    .files
                                    .remove(&format!("{}:{}", self.active, &tag[6..]));
                                self.persist();
                                self.notice("File saved · changes sync to collaborators", cx);
                            }
                            _ => {}
                        }
                    }
                }
                // Not every project uses git; the changes pane says so instead of an error.
                Event::Error(error) if error.contains("not a git repository") => {
                    self.git = json!({ "notGit": true });
                }
                Event::Error(error) => {
                    self.busy = false;
                    if error != self.last_error {
                        self.last_error = error.clone();
                        self.notice(error, cx);
                    }
                }
                Event::Terminal(id, data) => {
                    if let Some(tab) = self.terminals.iter_mut().find(|t| t.id == id) {
                        tab.parser.process(data.as_bytes());
                    }
                }
                Event::TerminalClosed(id, message) => {
                    if let Some(tab) = self.terminals.iter_mut().find(|t| t.id == id) {
                        tab.closed = true;
                        tab.parser
                            .process(format!("\r\n[{message}]\r\n").as_bytes());
                    }
                }
                _ => {}
            }
        }
        for (path, lines) in citations::take() {
            self.cite_line = lines.map(|(start, _)| (path.clone(), start));
            self.open_file(path, cx);
            changed = true;
        }
        if !self.toast.is_empty() && self.toast_at.elapsed() > Duration::from_secs(7) {
            self.toast.clear();
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }
    fn selected(&self) -> Value {
        self.sessions
            .iter()
            .find(|s| s["id"].as_str() == Some(&self.active))
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn role(&self) -> String {
        text(&self.native["me"], "role")
    }
    fn request(&self, tag: &str, method: &str, verb: &str, body: Option<Value>) {
        if !self.active.is_empty() {
            self.backend.request(
                tag,
                method,
                &format!("/api/sessions/{}/{}", self.active, verb),
                body,
            );
        }
    }
    fn send(&self, message: Value) {
        if !self.active.is_empty() {
            self.backend.send(&self.active, message);
        }
    }
    fn select(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.active == id {
            return;
        }
        self.active = id.clone();
        self.prefs.active = id.clone();
        self.backend.select(&id);
        self.request("files", "GET", "files", None);
        self.native = Value::Null;
        self.file_path.clear();
        self.files.clear();
        self.pane.clear();
        self.showing = "main".into();
        self.terminal_visible = false;
        self.last_error.clear();
        self.composer.update(cx, |state, cx| {
            state.set_value(
                self.prefs.drafts.get(&id).cloned().unwrap_or_default(),
                window,
                cx,
            );
            // Opening a thread puts the cursor where you write.
            state.focus(window, cx);
        });
        self.persist();
        cx.notify();
    }
    fn field(
        &mut self,
        name: &'static str,
        value: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.fields.insert(
            name,
            cx.new(|cx| InputState::new(window, cx).default_value(value)),
        );
    }
    fn value(&self, name: &'static str, cx: &App) -> String {
        self.fields
            .get(name)
            .map(|s| s.read(cx).value().to_string())
            .unwrap_or_default()
    }
    fn open_modal(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.modal = kind.into();
        self.fields.clear();
        self.busy = false;
        let s = self.selected();
        match kind {
            "create" => {
                self.field(
                    "dir",
                    if self.project.is_empty() {
                        text(&s, "dir")
                    } else {
                        self.project.clone()
                    },
                    window,
                    cx,
                );
                self.field("title", String::new(), window, cx);
                self.field("compute", "local".into(), window, cx);
                self.field(
                    "model",
                    text(&self.catalog["defaults"], "model"),
                    window,
                    cx,
                );
                self.field(
                    "thinking",
                    text(&self.catalog["defaults"], "thinkingLevel"),
                    window,
                    cx,
                );
                self.field("vm", String::new(), window, cx);
                self.field("setupModel", String::new(), window, cx);
            }
            "settings" => self.field("name", text(&self.native["me"], "name"), window, cx),
            "join" => {
                self.field("url", String::new(), window, cx);
                self.field("name", text(&self.catalog["identity"], "name"), window, cx);
            }
            "rename" => self.field("title", text(&s, "title"), window, cx),
            "tags" => self.field(
                "tags",
                array(&s, "tags")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                window,
                cx,
            ),
            "compact" => self.field("instructions", String::new(), window, cx),
            "invite" => {
                self.field("email", String::new(), window, cx);
                self.field("role", "editor".into(), window, cx);
                self.field("days", "7".into(), window, cx);
                self.field("uses", String::new(), window, cx);
            }
            "file" => self.field("path", String::new(), window, cx),
            "commit" => self.field("message", String::new(), window, cx),
            "name" => self.field("name", text(&self.native["me"], "name"), window, cx),
            "preview" => self.field("url", "http://localhost:3000".into(), window, cx),
            _ => {}
        }
        let first = match kind {
            "create" => "dir",
            "join" => "url",
            "rename" => "title",
            "tags" => "tags",
            "compact" => "instructions",
            "invite" => "email",
            "file" => "path",
            "commit" => "message",
            "name" => "name",
            "preview" => "url",
            _ => "",
        };
        if let Some(field) = self.fields.get(first) {
            field.update(cx, |s, cx| s.focus(window, cx));
        }
        cx.notify();
    }
    /// Starts a thread in `dir` straight away, as ⌘N does in Delta: same place to run as the open thread when it's
    /// in the same project, the default model, a title from the first message. A new folder goes through the dialog.
    fn new_thread(&mut self, dir: String, window: &mut Window, cx: &mut Context<Self>) {
        if dir.is_empty() {
            return self.choose_project(window, cx);
        }
        let current = self.selected();
        let same = text(&current, "dir") == dir;
        let compute = if same && !text(&current, "compute").is_empty() {
            text(&current, "compute")
        } else {
            "local".into()
        };
        self.busy = true;
        self.notice("Starting a thread…", cx);
        self.backend.request(
            "create",
            "POST",
            "/api/sessions",
            Some(json!({
                "dir": dir,
                "title": "",
                "compute": compute,
                "model": text(&self.catalog["defaults"], "model"),
                "thinkingLevel": text(&self.catalog["defaults"], "thinkingLevel"),
                "vm": if same { text(&current, "vm") } else { String::new() },
                "setupModel": "",
            })),
        );
    }
    /// The project new threads go to: the one picked in the sidebar, else the open thread's.
    fn current_project(&self) -> String {
        if self.project.is_empty() {
            text(&self.selected(), "dir")
        } else {
            self.project.clone()
        }
    }
    fn choose_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let response = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open a project".into()),
        });
        cx.spawn_in(window, async move |entity, cx| {
            if let Ok(Ok(Some(paths))) = response.await {
                if let Some(path) = paths.first() {
                    let path = path.to_string_lossy().to_string();
                    let _ = entity.update_in(cx, |this, window, cx| {
                        this.open_modal("create", window, cx);
                        if let Some(field) = this.fields.get("dir") {
                            field.update(cx, |s, cx| s.set_value(path, window, cx));
                        }
                    });
                }
            }
        })
        .detach();
    }
    fn set_pane(&mut self, pane: &str, cx: &mut Context<Self>) {
        if self.pane == pane {
            self.pane.clear();
        } else {
            self.pane = pane.into();
            self.file_path.clear();
            match pane {
                "files" => self.request("files", "GET", "files", None),
                "changes" => self.request("git", "GET", "git", None),
                "people" => self.send(json!({"type":"invites"})),
                _ => {}
            }
        }
        cx.notify();
    }
    fn decorate(&self, patch: Value) {
        self.request("decorate", "POST", "decorate", Some(patch));
    }
    fn run_action(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        match name {
            "new" => self.new_thread(self.current_project(), window, cx),
            "project" => self.choose_project(window, cx),
            "search" => self.open_palette(Tab::Threads, window, cx),
            "join" => self.open_modal("join", window, cx),
            "theme" => {
                self.prefs.dark = !self.prefs.dark;
                theme::apply(self.prefs.dark, self.zoom(), Some(window), cx);
                self.persist();
            }
            "sidebar" => {
                self.sidebar = !self.sidebar;
                self.prefs.sidebar = Some(self.sidebar);
                self.persist();
            }
            "archives" => self.archived = !self.archived,
            "files" | "changes" | "people" => self.set_pane(name, cx),
            "setup" => {
                self.showing = if self.showing == "main" {
                    "setup".into()
                } else {
                    "main".into()
                }
            }
            "terminal" => {
                self.terminal_visible = !self.terminal_visible;
                if self.terminal_visible {
                    if !self
                        .terminals
                        .iter()
                        .any(|t| t.session == self.active && !t.closed)
                    {
                        self.new_terminal(cx);
                    } else if let Some(t) = self
                        .terminals
                        .iter()
                        .find(|t| t.session == self.active && !t.closed)
                    {
                        self.terminal_id = t.id;
                    }
                    self.terminal_focus.focus(window);
                }
            }
            "share" => self.send(json!({"type":"invite"})),
            "stop" => self.send(json!({"type":"abort"})),
            "pin" => self.decorate(json!({"pinned":!flag(&self.selected(),"pinned")})),
            "bookmark" => self.decorate(json!({"bookmarked":!flag(&self.selected(),"bookmarked")})),
            "archive" => self.decorate(json!({"archived":!flag(&self.selected(),"archived")})),
            "sync" => self.request("sync", "POST", "sync", Some(json!({}))),
            "title" => {
                self.notice("Generating a title…", cx);
                self.request("title", "POST", "title", Some(json!({})));
            }
            "reveal" | "zed" => self.request(
                "reveal",
                "POST",
                "reveal",
                Some(json!({"editor":name=="zed"})),
            ),
            "update" => self.request("update", "POST", "update", Some(json!({}))),
            "retry" => self.request("retry", "POST", "retry", Some(json!({}))),
            "model" => self.pick_model(window, cx),
            "rename" | "tags" | "compact" | "reset" | "branches" | "invite" | "name"
            | "preview" | "file" | "commit" => self.open_modal(name, window, cx),
            _ => {}
        }
        cx.notify();
    }
    /// What each command in src/shared/keymap.json does in the desktop app.
    pub(crate) fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            "palette.all" => self.open_palette(Tab::All, window, cx),
            "palette.commands" => self.open_palette(Tab::Commands, window, cx),
            "palette.threads" => self.open_palette(Tab::Threads, window, cx),
            "palette.files" => self.open_palette(Tab::Files, window, cx),
            "app.keymap" => self.open_modal("keymap", window, cx),
            "app.settings" => {
                if self.modal == "settings" {
                    self.modal.clear();
                    cx.notify();
                } else {
                    self.open_modal("settings", window, cx);
                }
            }
            "app.zoomIn" | "app.zoomOut" | "app.zoomReset" => {
                let zoom = match id {
                    "app.zoomIn" => self.zoom() + 0.1,
                    "app.zoomOut" => self.zoom() - 0.1,
                    _ => 1.,
                };
                self.set_zoom(zoom, window, cx);
            }
            "thread.bookmark" => self.run_action("bookmark", window, cx),
            "thread.tags" => self.open_modal("tags", window, cx),
            "project.preview" => self.open_modal("preview", window, cx),
            "project.update" => self.run_action("update", window, cx),
            "app.theme" => self.run_action("theme", window, cx),
            "app.quit" => cx.quit(),
            "thread.new" => self.run_action("new", window, cx),
            "project.add" => self.choose_project(window, cx),
            "thread.share" => self.run_action("share", window, cx),
            "thread.join" => self.open_modal("join", window, cx),
            "thread.next" | "thread.previous" => {
                let order = self.thread_order();
                if let Some(at) = order.iter().position(|t| *t == self.active) {
                    let next = if id == "thread.next" {
                        (at + 1) % order.len()
                    } else {
                        (at + order.len() - 1) % order.len()
                    };
                    self.select(order[next].clone(), window, cx);
                } else if let Some(first) = order.first() {
                    self.select(first.clone(), window, cx);
                }
            }
            "thread.rename" => self.open_modal("rename", window, cx),
            "thread.title" => self.run_action("title", window, cx),
            "thread.pin" => self.run_action("pin", window, cx),
            "thread.archive" => self.run_action("archive", window, cx),
            "thread.archives" => self.run_action("archives", window, cx),
            "agent.stop" => {
                if self.palette.is_some() {
                    self.close_palette(window, cx);
                } else if !self.modal.is_empty() {
                    self.modal.clear();
                    cx.notify();
                } else {
                    self.send(json!({"type":"abort"}));
                }
            }
            "agent.model" => self.pick_model(window, cx),
            "agent.compact" => self.open_modal("compact", window, cx),
            "agent.newContext" => self.open_modal("reset", window, cx),
            "agent.branches" => self.open_modal("branches", window, cx),
            "agent.setup" => self.run_action("setup", window, cx),
            "view.sidebar" => self.run_action("sidebar", window, cx),
            "view.changes" => self.set_pane("changes", cx),
            "view.files" => self.set_pane("files", cx),
            "view.people" => self.set_pane("people", cx),
            "view.terminal" => self.run_action("terminal", window, cx),
            "file.comment" => self.start_comment(window, cx),
            "project.sync" => self.run_action("sync", window, cx),
            "project.reveal" => self.run_action("reveal", window, cx),
            "project.zed" => self.run_action("zed", window, cx),
            "project.web" => {
                let url = text(&self.selected(), "url");
                if !url.is_empty() {
                    cx.open_url(&url);
                }
            }
            _ => {}
        }
    }
    /// Starts a comment on the lines selected in the open file (or the cursor's line), as in Delta.
    pub(crate) fn start_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.file_path.is_empty() || self.pane != "files" {
            return self.notice("Open a file and select lines to comment on them.", cx);
        }
        let text = self.editor.read(cx).value().to_string();
        let selection = self.editor.update(cx, |editor, cx| {
            editor.selected_text_range(true, window, cx)
        });
        let Some(selection) = selection else { return };
        // UTF-16 offsets to 1-based line numbers.
        let line_at = |offset: usize| {
            let mut units = 0;
            let mut line = 1;
            for ch in text.chars() {
                if units >= offset {
                    break;
                }
                units += ch.len_utf16();
                if ch == '\n' {
                    line += 1;
                }
            }
            line
        };
        let start = line_at(selection.range.start);
        // A selection ending at the start of a line doesn't include that line.
        let end = line_at(
            selection
                .range
                .end
                .saturating_sub(1)
                .max(selection.range.start),
        )
        .max(start);
        self.comment_lines = Some((start, end));
        self.comment_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }
    /// Sends the comment being written, with the lines it's about, to the thread as its own message.
    fn send_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((start, end)) = self.comment_lines else {
            return;
        };
        let note = self.comment_input.read(cx).value().trim().to_owned();
        if note.is_empty() {
            return;
        }
        let excerpt = self
            .editor
            .read(cx)
            .value()
            .lines()
            .skip(start - 1)
            .take(end - start + 1)
            .collect::<Vec<_>>()
            .join("\n");
        self.send(json!({
            "type": "submit",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "text": "",
            "mode": "followUp",
            "where": if self.where_vm { "vm" } else { "device" },
            "comments": [{ "path": self.file_path, "start": start, "end": end, "excerpt": excerpt, "text": note }],
        }));
        self.comment_lines = None;
        self.comment_input
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.notice(
            format!(
                "Comment on {}:{} sent",
                self.file_path,
                if start == end {
                    start.to_string()
                } else {
                    format!("{start}-{end}")
                }
            ),
            cx,
        );
    }
    pub(crate) fn zoom(&self) -> f32 {
        self.prefs.zoom.unwrap_or(1.)
    }
    /// Scales all text, from 80% to 150%, and remembers it.
    fn set_zoom(&mut self, zoom: f32, window: &mut Window, cx: &mut Context<Self>) {
        let zoom = (zoom * 10.).round().clamp(8., 15.) / 10.;
        self.prefs.zoom = Some(zoom);
        self.persist();
        theme::apply(self.prefs.dark, zoom, Some(window), cx);
        self.notice(format!("Text size {}%", (zoom * 100.).round()), cx);
    }
    /// Opens a project file in the files pane.
    pub(crate) fn open_file(&mut self, path: String, cx: &mut Context<Self>) {
        self.pane = "files".into();
        if self.files.is_empty() {
            self.request("files", "GET", "files", None);
        }
        let query = reqwest::Url::parse_with_params("http://x", &[("path", &path)])
            .map(|u| u.query().unwrap_or("").to_owned())
            .unwrap_or_default();
        self.request(
            &format!("file:{path}"),
            "GET",
            &format!("file?{query}"),
            None,
        );
        cx.notify();
    }
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let kind = self.modal.clone();
        match kind.as_str(){
  "create"=>{let dir=self.value("dir",cx);if dir.trim().is_empty(){self.notice("Choose a project folder",cx);return;}self.busy=true;self.backend.request("create","POST","/api/sessions",Some(json!({"dir":dir,"title":self.value("title",cx),"compute":self.value("compute",cx),"model":self.value("model",cx),"thinkingLevel":self.value("thinking",cx),"vm":self.value("vm",cx),"setupModel":self.value("setupModel",cx)})));return;},
  "join"=>{self.busy=true;self.backend.request("join","POST","/api/join",Some(json!({"url":self.value("url",cx),"name":self.value("name",cx)})));return;},
  "rename"=>self.decorate(json!({"title":self.value("title",cx)})),"tags"=>self.decorate(json!({"tags":self.value("tags",cx).split(',').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>()})),
  "compact"=>self.send(json!({"type":"compact","instructions":self.value("instructions",cx)})),"reset"=>self.send(json!({"type":"new"})),
  "invite"=>{let uses=self.value("uses",cx).parse::<u32>().ok();let email=self.value("email",cx);self.send(json!({"type":"invite","email":if email.is_empty(){None}else{Some(email)},"role":self.value("role",cx),"expiresInDays":self.value("days",cx).parse::<f64>().unwrap_or(7.),"maxUses":uses}));},
  "name"=>self.send(json!({"type":"rename","name":self.value("name",cx)})),
  "file"=>{self.file_path=self.value("path",cx);self.file_hash="none".into();self.pane="files".into();self.editor.update(cx,|s,cx|s.set_value("",window,cx));},
  "commit"=>self.request("git","POST","git",Some(json!({"action":"commit","message":self.value("message",cx)}))),
  "preview"=>{let url=self.value("url",cx);if url.starts_with("http://")||url.starts_with("https://"){cx.open_url(&url);}else{self.notice("Use an HTTP or HTTPS address",cx);return;}},_=>{}
 }
        self.modal.clear();
        cx.notify();
    }
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let message = self.composer.read(cx).value().trim().to_owned();
        if message.is_empty() || self.active.is_empty() || self.role() == "viewer" {
            return;
        }
        if message.starts_with('!') {
            let command = message[1..].trim();
            self.terminal_visible = true;
            if !self
                .terminals
                .iter()
                .any(|t| t.id == self.terminal_id && t.session == self.active && !t.closed)
            {
                self.new_terminal(cx);
            }
            if let Some(t) = self.terminals.iter().find(|t| t.id == self.terminal_id) {
                let _ = t.sender.send(format!("{command}\r"));
            }
        } else if !self.slash(&message, window, cx) {
            self.send(json!({"type":"submit","requestId":uuid::Uuid::new_v4().to_string(),"text":message,"mode":if self.steer{"steer"}else{"followUp"},"where":if self.where_vm{"vm"}else{"device"}}));
            let s = self.selected();
            if text(&s, "title").is_empty() || text(&s, "title") == "New thread" {
                self.decorate(json!({"title":message.lines().next().unwrap_or("").chars().take(75).collect::<String>()}));
            }
        }
        self.composer
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.prefs.drafts.remove(&self.active);
        self.persist();
        self.steer = false;
        self.scroll.scroll_to_bottom();
        cx.notify();
    }
    fn slash(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !message.starts_with('/') {
            return false;
        }
        let mut parts = message[1..].splitn(2, ' ');
        let command = parts.next().unwrap_or("");
        let arg = parts.next().unwrap_or("").trim();
        match command{
  "stop"=>self.send(json!({"type":"abort"})),"env"=>self.showing="setup".into(),"members"|"who"|"links"=>self.set_pane("people",cx),"session-share"=>self.send(json!({"type":"invite"})),"compact"=>if arg.is_empty(){self.open_modal("compact",window,cx)}else{self.send(json!({"type":"compact","instructions":arg}))},"new"=>self.open_modal("reset",window,cx),"name"=>self.send(json!({"type":"rename","name":arg})),"model"=>self.pick_model(window,cx),"sync"=>self.request("sync","POST","sync",Some(json!({}))),"web"=>cx.open_url(&text(&self.selected(),"url")),"where"=>self.where_vm=arg=="vm","tree"=>{if let Some(index)=arg.strip_prefix('b').and_then(|s|s.parse::<usize>().ok()){if let Some(branch)=array(&self.native,"branches").get(index){self.send(json!({"type":"switchBranch","id":branch["id"]}));}}else if let Ok(n)=arg.parse::<usize>(){let users:Vec<_>=array(&self.native["main"],"items").into_iter().filter(|i|i["kind"]=="user").collect();if let Some(item)=users.get(n.saturating_sub(1)){self.send(json!({"type":"fork","before":item["key"]}));}}else{self.open_modal("branches",window,cx);}},
  "steer"=>self.send(json!({"type":"submit","requestId":uuid::Uuid::new_v4().to_string(),"text":arg,"mode":"steer","where":if self.where_vm{"vm"}else{"device"}})),
  "revoke"=>self.send(json!({"type":"revoke","code":arg})),"remove"=>{let member=array(&self.native,"members").into_iter().find(|m|text(m,"name")==arg||text(m,"id")==arg||text(m,"email")==arg);self.send(json!({"type":"remove","memberId":member.map(|m|text(&m,"id")).unwrap_or_else(||arg.into())}));},
  "role"=>{let words:Vec<_>=arg.split_whitespace().collect();if words.len()==2{let member=array(&self.native,"members").into_iter().find(|m|text(m,"name")==words[0]||text(m,"id")==words[0]||text(m,"email")==words[0]);self.send(json!({"type":"setRole","memberId":member.map(|m|text(&m,"id")).unwrap_or_else(||words[0].into()),"role":words[1]}));}},
  "invite"=>{let mut data=json!({"type":"invite"});let words:Vec<_>=arg.split_whitespace().collect();let mut i=0;while i<words.len(){let w=words[i];if w.contains('@'){data["email"]=json!(w);}else if ["admin","editor","viewer"].contains(&w){data["role"]=json!(w);}else if w=="never"{data["expiresInDays"]=json!(0);}else if w=="--uses"{i+=1;data["maxUses"]=json!(words.get(i).and_then(|s|s.parse::<u32>().ok()));}else if let Some(n)=w.strip_suffix('d').and_then(|s|s.parse::<f64>().ok()){data["expiresInDays"]=json!(n);}else if let Some(n)=w.strip_suffix('h').and_then(|s|s.parse::<f64>().ok()){data["expiresInDays"]=json!(n/24.);}i+=1;}self.send(data);},
  "ssh"=>{let vm=text(&self.selected(),"vm");if !vm.is_empty(){self.terminal_visible=true;self.new_terminal(cx);if let Some(t)=self.terminals.iter().find(|t|t.id==self.terminal_id){let _=t.sender.send(format!("ssh {vm}.exe.xyz\r"));}}},"quit"=>cx.quit(),_=>return false
 }
        true
    }
    fn new_terminal(&mut self, cx: &mut Context<Self>) {
        if self.active.is_empty() || self.role() == "viewer" {
            return;
        }
        let id = self.terminals.last().map(|t| t.id + 1).unwrap_or(1);
        let sender = self.backend.terminal(&self.active, id);
        self.terminals.push(TerminalTab {
            id,
            session: self.active.clone(),
            parser: vt100::Parser::new(16, 100, 3000),
            sender,
            closed: false,
        });
        self.terminal_id = id;
        self.terminal_visible = true;
        cx.notify();
    }
    fn terminal_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        let data = if key.modifiers.platform && key.key == "v" {
            cx.read_from_clipboard()
                .and_then(|c| c.text())
                .unwrap_or_default()
        } else if key.modifiers.platform {
            return;
        } else if key.modifiers.control && key.key.len() == 1 {
            String::from_utf8(vec![key.key.as_bytes()[0] & 0x1f]).unwrap_or_default()
        } else {
            match key.key.as_str() {
                "enter" => "\r".into(),
                "backspace" => "\x7f".into(),
                "escape" => "\x1b".into(),
                "tab" => "\t".into(),
                "up" => "\x1b[A".into(),
                "down" => "\x1b[B".into(),
                "right" => "\x1b[C".into(),
                "left" => "\x1b[D".into(),
                "home" => "\x1b[H".into(),
                "end" => "\x1b[F".into(),
                _ => key.key_char.clone().unwrap_or_default(),
            }
        };
        if !data.is_empty() {
            if let Some(tab) = self.terminals.iter().find(|t| t.id == self.terminal_id) {
                let _ = tab.sender.send(data);
            }
            cx.stop_propagation();
        }
    }
    fn toolbar(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.selected();
        let title = if self.active.is_empty() {
            "SyncPi".into()
        } else {
            let t = text(&selected, "title");
            if t.is_empty() {
                text(&selected, "name")
            } else {
                t
            }
        };
        let empty = self.active.is_empty();
        let actions = [
            (
                "changes",
                "Review changes (⇧⌘D)",
                "changes",
                IconName::Replace,
            ),
            (
                "terminal",
                "Terminal (⌃`)",
                "terminal",
                IconName::SquareTerminal,
            ),
            ("share", "Share (⇧⌘S)", "share", IconName::Globe),
            ("files", "Files (⇧⌘E)", "files", IconName::PanelRight),
        ];
        let pinned = flag(&selected, "pinned");
        let bookmarked = flag(&selected, "bookmarked");
        let archived = flag(&selected, "archived");
        // The thread's actions, as a menu of shared commands (with their shortcuts), as in Delta.
        let menu = Button::new("thread-menu")
            .ghost()
            .icon(IconName::Ellipsis)
            .tooltip("Thread actions")
            .disabled(empty)
            .dropdown_menu_with_anchor(Corner::TopRight, move |menu: PopupMenu, _, _| {
                let item = |menu: PopupMenu, label: &str, id: &str| {
                    menu.menu(
                        label.to_owned(),
                        Box::new(RunCommand {
                            id: id.to_owned().into(),
                        }),
                    )
                };
                let menu = item(menu, "Rename", "thread.rename");
                let menu = item(menu, "Regenerate title", "thread.title");
                let menu = item(menu, "Edit tags", "thread.tags");
                let menu = item(menu, if pinned { "Unpin" } else { "Pin" }, "thread.pin");
                let menu = item(
                    menu,
                    if bookmarked {
                        "Remove bookmark"
                    } else {
                        "Bookmark"
                    },
                    "thread.bookmark",
                );
                let menu = item(
                    menu,
                    if archived { "Restore" } else { "Archive" },
                    "thread.archive",
                )
                .separator();
                let menu = item(menu, "Change model", "agent.model");
                let menu = item(menu, "Branches", "agent.branches");
                let menu = item(menu, "Summarize older messages", "agent.compact");
                let menu = item(menu, "Start a new context", "agent.newContext").separator();
                let menu = item(menu, "Open a dev server preview", "project.preview");
                let menu = item(menu, "Open the thread in a browser", "project.web");
                let menu = item(menu, "Reveal the project in Finder", "project.reveal");
                let menu = item(menu, "Open the project in Zed", "project.zed");
                let menu = item(menu, "Sync the project now", "project.sync");
                item(menu, "Update the session server", "project.update")
            });
        div()
            .h(px(49.))
            .flex()
            .items_center()
            .gap_1()
            .px_3()
            .when(!self.sidebar, |bar| bar.pl(px(92.)))
            .border_b_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().background)
            .child(
                Button::new("sidebar-toggle")
                    .ghost()
                    .icon(IconName::PanelLeft)
                    .tooltip("Toggle sidebar (⌘B)")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.run_action("sidebar", window, cx)),
                    ),
            )
            .child(
                label(title)
                    .text_size(theme::sz(14.))
                    .flex_1()
                    .overflow_hidden(),
            )
            .child(menu)
            .children(actions.into_iter().map(|(action, title, id, icon)| {
                Button::new(id)
                    .ghost()
                    .icon(icon)
                    .tooltip(title)
                    .disabled(empty)
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.run_action(action, window, cx)),
                    )
            }))
            .child(
                Button::new("settings")
                    .ghost()
                    .icon(IconName::Settings)
                    .tooltip("Settings (⌘,)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.run_command("app.settings", window, cx)
                    })),
            )
            .into_any_element()
    }
    fn inspector(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let border = cx.theme().border;
        let muted = cx.theme().muted_foreground;
        let mut body = div()
            .id("inspector-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col();
        match self.pane.as_str() {
            "files" => {
                if self.file_path.is_empty() {
                    body = body.child(
                        div()
                            .flex()
                            .justify_between()
                            .p_2()
                            .child(label("Project files").text_xs().text_color(muted))
                            .child(
                                Button::new("new-file")
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Plus)
                                    .label("New")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_modal("file", window, cx)
                                    })),
                            ),
                    );
                    for path in &self.files {
                        let p = path.clone();
                        body = body.child(
                            Button::new(eid(format!("file-{path}")))
                                .ghost()
                                .small()
                                .label(format!("▤ {path}"))
                                .w_full()
                                .on_click(cx.listener(move |this, _, _, _| {
                                    let encoded = reqwest::Url::parse_with_params(
                                        "http://x",
                                        &[("path", &p)],
                                    )
                                    .unwrap()
                                    .query()
                                    .unwrap()
                                    .to_owned();
                                    this.request(
                                        &format!("file:{p}"),
                                        "GET",
                                        &format!("file?{encoded}"),
                                        None,
                                    );
                                })),
                        );
                    }
                } else {
                    let dirty = self
                        .prefs
                        .files
                        .contains_key(&format!("{}:{}", self.active, self.file_path));
                    body = body
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_1()
                                .p_2()
                                .border_b_1()
                                .border_color(border)
                                .child(
                                    Button::new("back-files")
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::ChevronLeft)
                                        .label("Files")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.file_path.clear();
                                            cx.notify();
                                        })),
                                )
                                .child(label(self.file_path.clone()).flex_1().text_xs())
                                .child(
                                    Button::new("comment-file")
                                        .ghost()
                                        .xsmall()
                                        .icon(icons::icon("message-square"))
                                        .label("Comment")
                                        .tooltip("Comment on the selected lines (⌥⌘M)")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.start_comment(window, cx)
                                        })),
                                )
                                .child(
                                    Button::new("mention-file")
                                        .ghost()
                                        .xsmall()
                                        .label("@")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            let value = format!(
                                                "{}\n@{} ",
                                                this.composer.read(cx).value(),
                                                this.file_path
                                            );
                                            this.composer.update(cx, |s, cx| {
                                                s.set_value(value, window, cx);
                                                s.focus(window, cx);
                                            });
                                        })),
                                )
                                .child(
                                    Button::new("save-file")
                                        .primary()
                                        .xsmall()
                                        .label("Save")
                                        .disabled(self.role() == "viewer")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.backend.save_file(
                                                &this.active,
                                                &this.file_path,
                                                &this.file_hash,
                                                this.editor.read(cx).value().to_string(),
                                            )
                                        })),
                                ),
                        )
                        .child(
                            Input::new(&self.editor)
                                .h_full()
                                .bordered(false)
                                .font_family(theme::MONO)
                                .text_size(theme::sz(12.5)),
                        )
                        .when_some(self.comment_lines, |d, (start, end)| {
                            let p = theme::palette(cx);
                            d.child(
                                div()
                                    .flex_shrink_0()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .m_2()
                                    .p_2()
                                    .rounded(px(8.))
                                    .border_l_2()
                                    .border_color(p.accent)
                                    .bg(p.surface)
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .text_size(theme::sz(12.))
                                            .text_color(p.muted)
                                            .child(div().flex_1().child(format!(
                                                "Comment on {}:{}",
                                                self.file_path,
                                                if start == end {
                                                    start.to_string()
                                                } else {
                                                    format!("{start}-{end}")
                                                }
                                            )))
                                            .child(
                                                Button::new("cancel-comment")
                                                    .ghost()
                                                    .xsmall()
                                                    .label("Cancel")
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.comment_lines = None;
                                                        cx.notify();
                                                    })),
                                            ),
                                    )
                                    .child(Input::new(&self.comment_input).w_full()),
                            )
                        })
                        .child(
                            label(if dirty {
                                "Unsaved draft saved locally"
                            } else {
                                "Saved"
                            })
                            .text_xs()
                            .text_color(muted)
                            .p_2(),
                        );
                }
            }
            "changes" if flag(&self.git, "notGit") => {
                body = body.child(
                    label("This project isn't a git repository, so there's nothing to review here. The agent's edits show in the thread.")
                        .p_4()
                        .text_size(theme::sz(13.))
                        .text_color(muted),
                );
            }
            "changes" => {
                body = body.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .p_3()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(icons::icon("git-branch").size_3())
                                .child(label(text(&self.git, "branch")).text_xs()),
                        )
                        .child(
                            Button::new("commit")
                                .small()
                                .label("Commit staged")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_modal("commit", window, cx)
                                })),
                        ),
                );
                for f in array(&self.git, "files") {
                    let path = text(&f, "path");
                    let p = path.clone();
                    body = body.child(
                        div()
                            .flex()
                            .items_center()
                            .px_2()
                            .child(
                                label(text(&f, "status"))
                                    .text_xs()
                                    .text_color(rgb(0x438858)),
                            )
                            .child(label(path).flex_1().text_xs())
                            .child(
                                Button::new(eid(format!("stage-{p}")))
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Plus)
                                    .on_click(cx.listener(move |this, _, _, _| {
                                        this.request(
                                            "git",
                                            "POST",
                                            "git",
                                            Some(json!({"action":"stage","path":p})),
                                        )
                                    })),
                            ),
                    );
                }
                for (key, title) in [("diff", "Unstaged changes"), ("staged", "Staged changes")] {
                    body = body.child(
                        label(title)
                            .text_xs()
                            .text_color(muted)
                            .p_3()
                            .border_t_1()
                            .border_color(border),
                    );
                    let diff = text(&self.git, key);
                    if diff.is_empty() {
                        body = body.child(label("No changes").p_3().text_xs().text_color(muted));
                    } else {
                        let palette = theme::palette(cx);
                        body = body.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_4()
                                .px_3()
                                .pb_3()
                                .children(transcript::file_diffs(key, &diff, &palette)),
                        );
                    }
                }
            }
            "people" => body = body.child(self.people_pane(cx)),
            _ => {}
        }
        div()
            .w(px(440.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(border)
            .child(
                div()
                    .h(px(38.))
                    .flex()
                    .items_center()
                    .px_3()
                    .gap_2()
                    .border_b_1()
                    .border_color(border)
                    .child(
                        label(match self.pane.as_str() {
                            "changes" => "Review changes",
                            "people" => "People",
                            _ => "Files",
                        })
                        .flex_1()
                        .text_xs(),
                    )
                    .child(
                        Button::new("refresh-inspector")
                            .ghost()
                            .xsmall()
                            .icon(icons::icon("refresh-cw"))
                            .tooltip("Refresh")
                            .on_click(cx.listener(|this, _, _, _| {
                                let p = this.pane.clone();
                                this.request(
                                    if p == "changes" { "git" } else { "files" },
                                    "GET",
                                    if p == "changes" { "git" } else { "files" },
                                    None,
                                );
                            })),
                    )
                    .child(
                        Button::new("close-inspector")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.pane.clear();
                                cx.notify();
                            })),
                    ),
            )
            .child(body)
            .into_any_element()
    }
    fn terminal_view(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let active = self.terminals.iter().find(|t| t.id == self.terminal_id);
        let contents = active
            .map(|t| t.parser.screen().contents())
            .unwrap_or_default();
        div()
            .id("native-terminal")
            .h(px(292.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(cx.theme().border)
            .track_focus(&self.terminal_focus)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| this.terminal_focus.focus(window)),
            )
            .on_key_down(cx.listener(Self::terminal_key))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .px_3()
                    .py_1()
                    .child(label("Terminal").text_xs())
                    .child(
                        label(text(&self.selected(), "dir"))
                            .text_xs()
                            .text_color(muted)
                            .flex_1(),
                    )
                    .child(
                        Button::new("new-terminal")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Plus)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_terminal(cx);
                                this.terminal_focus.focus(window);
                            })),
                    )
                    .child(
                        Button::new("close-terminal")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.terminal_visible = false;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div().flex().px_3().gap_1().children(
                    self.terminals
                        .iter()
                        .filter(|t| t.session == self.active)
                        .map(|t| {
                            let id = t.id;
                            Button::new(eid(format!("terminal-tab-{id}")))
                                .ghost()
                                .xsmall()
                                .label(format!(
                                    "zsh {id}{}",
                                    if t.closed { " · exited" } else { "" }
                                ))
                                .when(id == self.terminal_id, |b| b.bg(cx.theme().muted))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.terminal_id = id;
                                    this.terminal_focus.focus(window);
                                    cx.notify();
                                }))
                        }),
                ),
            )
            .child(
                div()
                    .id("terminal-content")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_4()
                    .py_1()
                    .font_family("Menlo")
                    .text_size(theme::sz(11.))
                    .child(contents),
            )
            .into_any_element()
    }
    fn dialog_field(&self, name: &'static str, title: &str) -> AnyElement {
        let field = self.fields.get(name).cloned();
        div()
            .id(name)
            .flex()
            .flex_col()
            .gap_2()
            .mb_3()
            .child(label(title.to_owned()).text_xs())
            .when_some(field.clone(), |d, state| {
                d.child(Input::new(&state).small())
            })
            .on_click(move |_, window, cx| {
                if let Some(state) = &field {
                    state.update(cx, |s, cx| s.focus(window, cx));
                }
            })
            .into_any_element()
    }
    fn dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let kind = self.modal.clone();
        let title = match kind.as_str() {
            "create" => "New thread",
            "join" => "Join a shared thread",
            "rename" => "Rename thread",
            "tags" => "Thread tags",
            "compact" => "Summarize older messages",
            "reset" => "Start a new context?",
            "branches" => "Thread branches",
            "share" => "Share this thread",
            "invite" => "Invite someone",
            "role" => "Choose a role",
            "file" => "Create a file",
            "commit" => "Commit staged changes",
            "name" => "Your display name",
            "preview" => "Open a development preview",
            "keymap" => "Keyboard shortcuts",
            "settings" => "Settings",
            _ => "",
        };
        let mut card = div()
            .w(px(if kind == "settings" { 568. } else { 490. }))
            .max_h(px(720.))
            .flex()
            .flex_col()
            .rounded_xl()
            .bg(cx.theme().background)
            .border_1()
            .border_color(cx.theme().border)
            .shadow_lg()
            .p_5()
            .child(
                div()
                    .flex()
                    .items_center()
                    .mb_4()
                    .child(label(title).text_lg().flex_1())
                    .child(
                        Button::new("close-modal")
                            .ghost()
                            .small()
                            .icon(IconName::Close)
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.modal.clear();
                                cx.notify();
                            })),
                    ),
            );
        let mut content = div().id("modal-content").min_h_0().overflow_y_scroll();
        match kind.as_str() {
            "keymap" => content = content.child(self.keymap_sheet(cx)),
            "settings" => content = content.child(self.settings(window, cx)),
            "create" => {
                content = content
                    .child(self.dialog_field("dir", "Project folder"))
                    .child(
                        Button::new("browse-folder")
                            .ghost()
                            .small()
                            .label("Browse…")
                            .mb_3()
                            .on_click(
                                cx.listener(|this, _, window, cx| this.choose_project(window, cx)),
                            ),
                    );
                let compute = self.value("compute", cx);
                let advanced = self.advanced;
                content = content
                    .child(label("Run the agent on").text_xs().mb_2())
                    .child(div().flex().gap_2().mb_3().children([("local", "This Mac"), ("host", "exe.dev VM")].into_iter().map(|(value, title)| {
                        Button::new(value).small().label(title).when(compute == value, |b| b.primary()).on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(field) = this.fields.get("compute") {
                                field.update(cx, |s, cx| s.set_value(value, window, cx));
                            }
                            cx.notify();
                        }))
                    })))
                    .child(
                        Button::new("advanced")
                            .ghost()
                            .xsmall()
                            .icon(if advanced { IconName::ChevronDown } else { IconName::ChevronRight })
                            .label("More options")
                            .mb_2()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.advanced = !this.advanced;
                                cx.notify();
                            })),
                    )
                    .when(advanced, |d| {
                        d.child(self.dialog_field("model", "Model (provider/model)"))
                            .child(self.dialog_field("setupModel", "Setup agent model (blank uses the main model)"))
                            .child(self.dialog_field("thinking", "Thinking (off, minimal, low, medium, high, xhigh)"))
                            .when(compute == "host", |d| d.child(self.dialog_field("vm", "Host VM (blank uses syncpi)")))
                    })
                    .child(label("Local threads use your pi login; VM threads use the exe.dev LLM integration. API keys stay on this Mac.").text_xs().text_color(muted));
            }
            "join" => {
                content = content
                    .child(self.dialog_field("url", "Invite link"))
                    .child(self.dialog_field("name", "Your name"))
                    .child(
                        label("The project downloads to this Mac and stays in sync.")
                            .text_xs()
                            .text_color(muted),
                    );
                if let Some(url) = self.catalog["login"]["url"].as_str() {
                    let url = url.to_owned();
                    content = content
                        .child(
                            label(format!(
                                "Compare sign-in code {}",
                                text(&self.catalog["login"], "check")
                            ))
                            .mt_3(),
                        )
                        .child(
                            Button::new("approve-login")
                                .label("Open browser sign-in")
                                .on_click(move |_, _, cx| cx.open_url(&url)),
                        );
                }
            }
            "rename" => content = content.child(self.dialog_field("title", "Title")),
            "tags" => {
                content = content.child(self.dialog_field("tags", "Tags, separated by commas"))
            }
            "compact" => {
                content = content
                    .child(self.dialog_field("instructions", "Optional summary instructions"))
            }
            "reset" => content = content.child(
                label(
                    "The agent starts fresh. Earlier messages remain visible in the shared thread.",
                )
                .text_sm()
                .text_color(muted),
            ),
            "branches" => {
                for b in array(&self.native, "branches") {
                    let id = b["id"].clone();
                    let current = id == self.native["currentBranch"];
                    content = content.child(
                        Button::new(eid(format!("branch-{id}")))
                            .ghost()
                            .icon(if current {
                                Icon::new(IconName::Check)
                            } else {
                                icons::icon("git-branch")
                            })
                            .label(text(&b, "label"))
                            .w_full()
                            .disabled(self.role() != "admin")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.send(json!({"type":"switchBranch","id":id}));
                                this.modal.clear();
                                cx.notify();
                            })),
                    );
                }
            }
            "share" => {
                let url = self.share_url.clone();
                content=content.child(label("Anyone with this invite link can join with the role and expiry set on the invite.").text_sm().text_color(muted)).child(TextView::markdown("share-link",url.clone(),window,cx).selectable(true)).child(Button::new("copy-share").primary().label("Copy invite link").mt_3().on_click(cx.listener(move|this,_,_,cx|{cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));this.notice("Invite link copied",cx);})));
            }
            "invite" => {
                content = content
                    .child(self.dialog_field("email", "Email (blank creates a link)"))
                    .child(self.dialog_field("role", "Role: viewer, editor, or admin"))
                    .child(self.dialog_field("days", "Expires in days (0 means never)"))
                    .child(self.dialog_field("uses", "Maximum uses (blank means unlimited)"))
            }
            "role" => {
                for role in ["viewer", "editor", "admin"] {
                    let member = self.target_member.clone();
                    content =
                        content.child(Button::new(role).ghost().label(role).w_full().on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.send(json!({"type":"setRole","memberId":member,"role":role}));
                                this.modal.clear();
                                cx.notify();
                            }),
                        ));
                }
            }
            "file" => content = content.child(self.dialog_field("path", "Relative file path")),
            "commit" => content = content.child(self.dialog_field("message", "Commit message")),
            "name" => content = content.child(self.dialog_field("name", "Name")),
            "preview" => {
                content = content.child(self.dialog_field("url", "Development server URL"))
            }
            _ => {}
        }
        card = card.child(content);
        if !["share", "branches", "role", "keymap", "settings"].contains(&kind.as_str()) {
            card = card.child(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .mt_5()
                    .child(
                        Button::new("cancel-dialog")
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.modal.clear();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("confirm-dialog")
                            .primary()
                            .label(if self.busy {
                                "Working…"
                            } else {
                                match kind.as_str() {
                                    "create" => "Create thread",
                                    "join" => "Join thread",
                                    "reset" => "Start new context",
                                    "compact" => "Summarize",
                                    _ => "Save",
                                }
                            })
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.confirm(window, cx))),
                    ),
            );
        }
        div()
            .occlude()
            .absolute()
            .inset_0()
            .bg(rgba(0x00000033))
            .flex()
            .items_center()
            .justify_center()
            .child(card)
            .into_any_element()
    }
}
impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pane = if self.pane.is_empty() {
            None
        } else {
            Some(self.inspector(window, cx))
        };
        let transcript = self.transcript(window, cx);
        let terminal = if self.terminal_visible {
            Some(self.terminal_view(window, cx))
        } else {
            None
        };
        let palette = self.palette_overlay(window, cx);
        let dialog = if self.modal.is_empty() {
            None
        } else {
            Some(self.dialog(window, cx))
        };
        div()
            .key_context("SyncPi")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .font_family(theme::SANS)
            .font_weight(FontWeight::NORMAL)
            .text_size(theme::sz(14.))
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| {
                this.run_command(&action.id, window, cx)
            }))
            .when(self.sidebar, |d| d.child(self.sidebar(window, cx)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(self.toolbar(window, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .child(div().flex_1().min_w_0().child(transcript))
                            .children(pane),
                    )
                    .children(terminal),
            )
            .children(dialog)
            .children(palette)
            .when(!self.toast.is_empty(), |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(48.))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .max_w(px(520.))
                                .rounded(px(8.))
                                .px(px(14.))
                                .py(px(9.))
                                .shadow_lg()
                                .bg(cx.theme().foreground)
                                .text_color(cx.theme().background)
                                .text_size(theme::sz(13.))
                                .child(self.toast.clone()),
                        ),
                )
            })
    }
}
fn main() -> anyhow::Result<()> {
    let (backend, receiver) = Backend::launch()?;
    let shutdown = backend.clone();
    let app = Application::new().with_assets(icons::Assets);
    // File citations come back from the OS as syncpi://open/... URLs (see citations.rs).
    app.on_open_urls(|urls| urls.iter().for_each(|url| citations::handle_url(url)));
    app.run(move |cx| {
        gpui_component::init(cx);
        theme::load_fonts(cx);
        keymap::bind(cx);
        cx.on_action(|action: &RunCommand, cx| {
            if action.id == "app.quit" {
                cx.quit();
            }
        });
        let item = |id: &str| {
            let title = keymap::command(id).map(|c| c.title).unwrap_or_default();
            MenuItem::action(
                title,
                RunCommand {
                    id: id.to_owned().into(),
                },
            )
        };
        cx.set_menus(vec![
            Menu {
                name: "SyncPi".into(),
                items: vec![item("app.keymap"), MenuItem::separator(), item("app.quit")],
            },
            Menu {
                name: "File".into(),
                items: vec![
                    item("thread.new"),
                    item("project.add"),
                    item("thread.join"),
                    MenuItem::separator(),
                    item("thread.share"),
                    item("thread.rename"),
                    item("thread.archive"),
                ],
            },
            Menu {
                name: "View".into(),
                items: vec![
                    item("palette.all"),
                    item("palette.commands"),
                    item("palette.threads"),
                    item("palette.files"),
                    MenuItem::separator(),
                    item("view.sidebar"),
                    item("view.changes"),
                    item("view.files"),
                    item("view.terminal"),
                    MenuItem::separator(),
                    item("app.theme"),
                ],
            },
            Menu {
                name: "Agent".into(),
                items: vec![
                    item("agent.model"),
                    item("agent.compact"),
                    item("agent.newContext"),
                    item("agent.branches"),
                    item("agent.setup"),
                    MenuItem::separator(),
                    item("agent.stop"),
                ],
            },
        ]);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1380.), px(900.)),
                    cx,
                ))),
                window_min_size: Some(size(px(840.), px(580.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("SyncPi".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(16.), px(17.))),
                }),
                ..Default::default()
            },
            move |window, cx| {
                let view = cx.new(|cx| Desktop::new(backend, receiver, window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            },
        )
        .expect("Open SyncPi window");
        cx.activate(true);
    });
    shutdown.shutdown();
    Ok(())
}
