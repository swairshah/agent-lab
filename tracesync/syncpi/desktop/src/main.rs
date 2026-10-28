mod backend;
mod icons;
mod message;
mod theme;
mod transcript;
use backend::{Backend, Event};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    ActiveTheme, Root, Sizable,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    text::TextView,
    *,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc::{Receiver, Sender},
    time::{Duration, Instant},
};

actions!(
    syncpi,
    [
        NewThread,
        AddProject,
        SearchThreads,
        OpenFiles,
        OpenTerminal,
        ReviewChanges,
        ShareThread,
        ToggleTheme,
        StopAgent,
        Quit
    ]
);
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}
fn array(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}
fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
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
    search: Entity<InputState>,
    editor: Entity<InputState>,
    fields: HashMap<&'static str, Entity<InputState>>,
    _subscriptions: Vec<Subscription>,
    prefs: Preferences,
    modal: String,
    pane: String,
    project: String,
    filter: String,
    archived: bool,
    showing: String,
    where_vm: bool,
    steer: bool,
    collapsed: HashSet<String>,
    thinking: HashSet<String>,
    scroll: ScrollHandle,
    files: Vec<String>,
    file_path: String,
    file_hash: String,
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
        theme::apply(prefs.dark, Some(window), cx);
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(1, 14)
                .placeholder("@ for files, / for commands, ! for a terminal. ⌘↩ to send")
        });
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Search threads, projects, and tags…")
        });
        let editor = cx.new(|cx| {
            InputState::new(window, cx)
                .code_editor("plain")
                .line_number(true)
        });
        let subscriptions = vec![
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
            cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify()),
            cx.subscribe_in(&editor, window, |this, _, event, _, cx| {
                if matches!(event, InputEvent::Change) && !this.file_path.is_empty() {
                    this.prefs.files.insert(
                        format!("{}:{}", this.active, this.file_path),
                        (
                            this.editor.read(cx).value().to_string(),
                            this.file_hash.clone(),
                        ),
                    );
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
            search,
            editor,
            fields: HashMap::new(),
            _subscriptions: subscriptions,
            prefs,
            modal: String::new(),
            pane: String::new(),
            project: String::new(),
            filter: "all".into(),
            archived: false,
            showing: "main".into(),
            where_vm: false,
            steer: false,
            collapsed: HashSet::new(),
            thinking: HashSet::new(),
            scroll: ScrollHandle::new(),
            files: vec![],
            file_path: String::new(),
            file_hash: String::new(),
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
                            }
                            "git" => self.git = value,
                            "models" => self.models = array(&value, "models"),
                            "sync" => self.notice("Project synchronized", cx),
                            "title" => self.notice("Thread title updated", cx),
                            "saved" => {}
                            _ if tag.starts_with("file:") => {
                                self.file_path = tag[5..].into();
                                self.file_hash = text(&value, "hash");
                                let key = format!("{}:{}", self.active, self.file_path);
                                let saved = self.prefs.files.get(&key).cloned();
                                let content = if let Some((text, base)) = saved {
                                    self.file_hash = base;
                                    text
                                } else {
                                    text(&value, "text")
                                };
                                self.editor
                                    .update(cx, |editor, cx| editor.set_value(content, window, cx));
                            }
                            _ if tag.starts_with("saved:") => {
                                self.file_hash = text(&value, "hash");
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
            "model" => {
                self.field("model", text(&self.native["main"], "model"), window, cx);
                self.field(
                    "thinking",
                    text(&self.native["main"], "thinkingLevel"),
                    window,
                    cx,
                );
                self.request("models", "GET", "models", None);
            }
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
            "search" => {
                self.search.update(cx, |s, cx| s.set_value("", window, cx));
                self.search.update(cx, |s, cx| s.focus(window, cx));
            }
            _ => {}
        }
        let first = match kind {
            "create" => "dir",
            "join" => "url",
            "rename" => "title",
            "tags" => "tags",
            "model" => "model",
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
            "new" => self.open_modal("create", window, cx),
            "project" => self.choose_project(window, cx),
            "search" => self.open_modal("search", window, cx),
            "join" => self.open_modal("join", window, cx),
            "theme" => {
                self.prefs.dark = !self.prefs.dark;
                theme::apply(self.prefs.dark, Some(window), cx);
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
            "rename" | "tags" | "model" | "compact" | "reset" | "branches" | "invite" | "name"
            | "preview" | "actions" | "file" | "commit" => self.open_modal(name, window, cx),
            _ => {}
        }
        cx.notify();
    }
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let kind = self.modal.clone();
        match kind.as_str(){
  "create"=>{let dir=self.value("dir",cx);if dir.trim().is_empty(){self.notice("Choose a project folder",cx);return;}self.busy=true;self.backend.request("create","POST","/api/sessions",Some(json!({"dir":dir,"title":self.value("title",cx),"compute":self.value("compute",cx),"model":self.value("model",cx),"thinkingLevel":self.value("thinking",cx),"vm":self.value("vm",cx),"setupModel":self.value("setupModel",cx)})));return;},
  "join"=>{self.busy=true;self.backend.request("join","POST","/api/join",Some(json!({"url":self.value("url",cx),"name":self.value("name",cx)})));return;},
  "rename"=>self.decorate(json!({"title":self.value("title",cx)})),"tags"=>self.decorate(json!({"tags":self.value("tags",cx).split(',').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>()})),
  "model"=>self.send(json!({"type":"configure","model":self.value("model",cx),"thinkingLevel":self.value("thinking",cx)})),
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
  "stop"=>self.send(json!({"type":"abort"})),"env"=>self.showing="setup".into(),"members"|"who"|"links"=>self.set_pane("people",cx),"session-share"=>self.send(json!({"type":"invite"})),"compact"=>if arg.is_empty(){self.open_modal("compact",window,cx)}else{self.send(json!({"type":"compact","instructions":arg}))},"new"=>self.open_modal("reset",window,cx),"name"=>self.send(json!({"type":"rename","name":arg})),"model"=>self.open_modal("model",window,cx),"sync"=>self.request("sync","POST","sync",Some(json!({}))),"web"=>cx.open_url(&text(&self.selected(),"url")),"where"=>self.where_vm=arg=="vm","tree"=>{if let Some(index)=arg.strip_prefix('b').and_then(|s|s.parse::<usize>().ok()){if let Some(branch)=array(&self.native,"branches").get(index){self.send(json!({"type":"switchBranch","id":branch["id"]}));}}else if let Ok(n)=arg.parse::<usize>(){let users:Vec<_>=array(&self.native["main"],"items").into_iter().filter(|i|i["kind"]=="user").collect();if let Some(item)=users.get(n.saturating_sub(1)){self.send(json!({"type":"fork","before":item["key"]}));}}else{self.open_modal("branches",window,cx);}},
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
        let actions = [
            ("actions", "More", "ellipsis", IconName::Ellipsis),
            ("changes", "Changes", "changes", IconName::Replace),
            ("terminal", "Terminal", "terminal", IconName::SquareTerminal),
            ("share", "Share", "share", IconName::Globe),
            ("files", "Files", "files", IconName::PanelRight),
        ];
        div()
            .h(px(49.))
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .when(!self.sidebar, |bar| bar.pl(px(92.)))
            .border_b_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().background)
            .child(
                Button::new("sidebar-toggle")
                    .ghost()
                    .small()
                    .icon(IconName::PanelLeft)
                    .tooltip("Toggle sidebar")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.run_action("sidebar", window, cx)),
                    ),
            )
            .child(label(title).text_sm().flex_1().overflow_hidden())
            .children(actions.into_iter().map(|(action, title, id, icon)| {
                Button::new(id)
                    .ghost()
                    .small()
                    .icon(icon)
                    .tooltip(title)
                    .disabled(self.active.is_empty())
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.run_action(action, window, cx)),
                    )
            }))
            .into_any_element()
    }
    fn sidebar(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut directories: Vec<(String, String)> = vec![];
        for s in &self.sessions {
            let dir = text(s, "dir");
            if !directories.iter().any(|(d, _)| d == &dir) {
                directories.push((dir, text(s, "name")));
            }
        }
        let mut shown: Vec<_> = self
            .sessions
            .iter()
            .filter(|s| {
                flag(s, "archived") == self.archived
                    && (self.project.is_empty() || text(s, "dir") == self.project)
                    && (self.filter != "saved" || flag(s, "bookmarked"))
            })
            .cloned()
            .collect();
        shown.sort_by_key(|s| {
            (
                !flag(s, "pinned"),
                std::cmp::Reverse(
                    s[if self.filter == "recent" {
                        "lastOpened"
                    } else {
                        "createdAt"
                    }]
                    .as_u64()
                    .unwrap_or_default(),
                ),
            )
        });
        let border = cx.theme().border;
        let muted = cx.theme().muted_foreground;
        let surface = theme::palette(cx).surface;
        div()
            .w(px(252.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .bg(surface)
            .border_r_1()
            .border_color(border)
            .child(
                div()
                    .h(px(49.))
                    .flex()
                    .items_center()
                    .pl(px(91.))
                    .pr_2()
                    .gap_1()
                    .border_b_1()
                    .border_color(border)
                    .child(
                        Button::new("search")
                            .ghost()
                            .small()
                            .icon(IconName::Search)
                            .tooltip("Search threads")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_modal("search", window, cx)
                            })),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("archives")
                            .ghost()
                            .small()
                            .icon(icons::icon("archive"))
                            .tooltip("Archived threads")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_action("archives", window, cx)
                            })),
                    ),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_2()
                    .pt_4()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px_2()
                            .text_xs()
                            .text_color(muted)
                            .child("Projects")
                            .child(
                                Button::new("add-project")
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Plus)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.choose_project(window, cx)
                                    })),
                            ),
                    )
                    .children(directories.into_iter().map(|(dir, name)| {
                        let current = dir == self.project;
                        div()
                            .id(eid(format!("project-{dir}")))
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_3()
                            .py_2()
                            .rounded_md()
                            .cursor_pointer()
                            .when(current, |s| s.bg(cx.theme().selection))
                            .hover(|s| s.bg(cx.theme().muted))
                            .child(Icon::new(IconName::Folder).size_4().text_color(muted))
                            .child(name)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.project = if this.project == dir {
                                    String::new()
                                } else {
                                    dir.clone()
                                };
                                cx.notify();
                            }))
                    }))
                    .child(
                        div()
                            .mt_6()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px_2()
                            .text_xs()
                            .text_color(muted)
                            .child(if self.archived {
                                "Archived threads"
                            } else {
                                "Threads"
                            })
                            .child(
                                Button::new("new-thread")
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Plus)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_modal("create", window, cx)
                                    })),
                            ),
                    )
                    .child(
                        div().flex().gap_1().mt_2().mb_2().children(
                            [("all", "All"), ("saved", "Saved"), ("recent", "Recent")]
                                .into_iter()
                                .map(|(filter, title)| {
                                    Button::new(filter)
                                        .ghost()
                                        .xsmall()
                                        .label(title)
                                        .when(self.filter == filter, |b| b.bg(cx.theme().muted))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.filter = filter.into();
                                            cx.notify();
                                        }))
                                }),
                        ),
                    )
                    .child(
                        Button::new("new-thread-row")
                            .ghost()
                            .small()
                            .icon(IconName::Plus)
                            .label("New thread")
                            .w_full()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_modal("create", window, cx)
                            })),
                    )
                    .children(shown.into_iter().map(|s| {
                        let id = text(&s, "id");
                        let selected = id == self.active;
                        let title = text(&s, "title");
                        let name = if title.is_empty() {
                            text(&s, "name")
                        } else {
                            title
                        };
                        let symbol = if flag(&s, "pinned") {
                            icons::icon("pin")
                        } else if flag(&s, "bookmarked") {
                            icons::icon("bookmark")
                        } else if s["status"] == "provisioning" {
                            Icon::new(IconName::LoaderCircle)
                        } else {
                            icons::icon("message-square")
                        };
                        div()
                            .id(eid(format!("thread-{id}")))
                            .flex()
                            .gap_2()
                            .items_center()
                            .py_2()
                            .px_3()
                            .my_1()
                            .rounded_md()
                            .cursor_pointer()
                            .when(selected, |s| s.bg(cx.theme().selection))
                            .hover(|s| s.bg(cx.theme().muted))
                            .child(symbol.size_4().text_color(muted).flex_shrink_0())
                            .child(
                                div()
                                    .flex_1()
                                    .overflow_hidden()
                                    .child(label(name).text_sm().whitespace_nowrap())
                                    .when(!array(&s, "tags").is_empty(), |d| {
                                        d.child(
                                            label(
                                                array(&s, "tags")
                                                    .iter()
                                                    .filter_map(Value::as_str)
                                                    .collect::<Vec<_>>()
                                                    .join(" · "),
                                            )
                                            .text_xs()
                                            .text_color(muted),
                                        )
                                    }),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select(id.clone(), window, cx)
                            }))
                    })),
            )
            .child(
                div()
                    .h(px(46.))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .border_t_1()
                    .border_color(border)
                    .child(
                        {
                            let name = text(&self.catalog["identity"], "name");
                            let color = theme::person_color(&name);
                            div()
                                .size_6()
                                .rounded_full()
                                .bg(color.opacity(0.16))
                                .text_color(color)
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(10.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(theme::initials(&name))
                        },
                    )
                    .child(
                        label(text(&self.catalog["identity"], "name"))
                            .flex_1()
                            .text_sm(),
                    )
                    .child(
                        Button::new("theme")
                            .ghost()
                            .small()
                            .icon(if self.prefs.dark {
                                IconName::Sun
                            } else {
                                IconName::Moon
                            })
                            .tooltip("Toggle theme")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_action("theme", window, cx)
                            })),
                    ),
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
                        .child(Input::new(&self.editor).h_full().bordered(false))
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
                        for (n, line) in diff.lines().enumerate() {
                            let color: Hsla = if line.starts_with('+') {
                                rgb(0x438858).into()
                            } else if line.starts_with('-') {
                                rgb(0xb85a5a).into()
                            } else {
                                cx.theme().foreground
                            };
                            body = body.child(
                                div()
                                    .id(eid(format!("{key}-{n}")))
                                    .px_3()
                                    .text_xs()
                                    .font_family("Menlo")
                                    .text_color(color)
                                    .child(line.to_owned()),
                            );
                        }
                    }
                }
            }
            "people" => {
                let admin = self.role() == "admin";
                body = body.child(
                    div()
                        .flex()
                        .gap_2()
                        .p_3()
                        .child(
                            Button::new("invite-person")
                                .small()
                                .label("Invite")
                                .disabled(!admin)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_modal("invite", window, cx)
                                })),
                        )
                        .child(
                            Button::new("rename-me")
                                .ghost()
                                .small()
                                .label("Rename me")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_modal("name", window, cx)
                                })),
                        ),
                );
                for m in array(&self.native, "members") {
                    let id = text(&m, "id");
                    let online = array(&self.native, "online")
                        .iter()
                        .any(|p| text(p, "memberId") == id);
                    let member = id.clone();
                    let remove = id.clone();
                    body = body.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .p_3()
                            .border_b_1()
                            .border_color(border)
                            .child(
                                div()
                                    .size_2()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(muted)
                                    .when(online, |d| d.bg(rgb(0x438858))),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .child(label(text(&m, "name")).text_sm())
                                    .child(label(text(&m, "email")).text_xs().text_color(muted)),
                            )
                            .child(
                                Button::new(eid(format!("role-{id}")))
                                    .ghost()
                                    .xsmall()
                                    .label(text(&m, "role"))
                                    .disabled(!admin || flag(&m, "creator"))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.target_member = member.clone();
                                        this.modal = "role".into();
                                        cx.notify();
                                    })),
                            )
                            .when(admin && !flag(&m, "creator"), |d| {
                                d.child(
                                    Button::new(eid(format!("remove-{id}")))
                                        .ghost()
                                        .xsmall()
                                        .label("Remove")
                                        .on_click(cx.listener(move |this, _, _, _| {
                                            this.send(json!({"type":"remove","memberId":remove}))
                                        })),
                                )
                            }),
                    );
                }
                if admin {
                    body = body.child(label("Active invites").text_xs().text_color(muted).p_3());
                    for invite in array(&self.native, "invites") {
                        let code = text(&invite, "code");
                        body = body.child(
                            div()
                                .flex()
                                .gap_2()
                                .items_center()
                                .px_3()
                                .py_2()
                                .child(
                                    label(format!(
                                        "{} · {}",
                                        if text(&invite, "email").is_empty() {
                                            "Link".into()
                                        } else {
                                            text(&invite, "email")
                                        },
                                        text(&invite, "role")
                                    ))
                                    .text_xs()
                                    .flex_1(),
                                )
                                .child(
                                    Button::new(eid(format!("revoke-{code}")))
                                        .ghost()
                                        .xsmall()
                                        .label("Revoke")
                                        .on_click(cx.listener(move |this, _, _, _| {
                                            this.send(json!({"type":"revoke","code":code}))
                                        })),
                                ),
                        );
                    }
                }
                body = body
                    .child(label("Environment").text_xs().text_color(muted).p_3())
                    .child(label(text(&self.native["env"], "summary")).text_xs().px_3())
                    .child(
                        label(format!(
                            "{} Pi skills loaded",
                            self.native["context"]["skillCount"]
                                .as_u64()
                                .unwrap_or_default()
                        ))
                        .text_xs()
                        .text_color(muted)
                        .p_3(),
                    );
            }
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
                            "people" => "People & environment",
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
                    .text_size(px(11.))
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
            "search" => "Search threads",
            "rename" => "Rename thread",
            "tags" => "Thread tags",
            "model" => "Model and thinking",
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
            _ => "Thread actions",
        };
        let mut card = div()
            .w(px(490.))
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
                    )
                    .child(self.dialog_field("title", "Thread title"));
                let compute = self.value("compute", cx);
                content=content.child(label("Run the agent on").text_xs().mb_2()).child(div().flex().gap_2().mb_3().children([("local","This Mac"),("host","exe.dev VM")].into_iter().map(|(value,title)|Button::new(value).small().label(title).when(compute==value,|b|b.primary()).on_click(cx.listener(move|this,_,window,cx|{if let Some(field)=this.fields.get("compute"){field.update(cx,|s,cx|s.set_value(value,window,cx));}cx.notify();}))))).child(self.dialog_field("model","Model (provider/model)"))
.child(self.dialog_field("setupModel","Setup agent model (blank uses main model)")).child(self.dialog_field("thinking","Thinking (off, minimal, low, medium, high, xhigh)")).when(compute=="host",|d|d.child(self.dialog_field("vm","Host VM (blank uses syncpi)"))).child(label("Uses your Pi login locally and the exe.dev LLM integration on a VM. API keys stay on this Mac.").text_xs().text_color(muted));
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
            "search" => {
                content = content.child(Input::new(&self.search).mb_3());
                let query = self.search.read(cx).value().to_lowercase();
                for s in self
                    .sessions
                    .clone()
                    .into_iter()
                    .filter(|s| s.to_string().to_lowercase().contains(&query))
                {
                    let id = text(&s, "id");
                    content = content.child(
                        Button::new(eid(format!("search-{id}")))
                            .ghost()
                            .label(format!(
                                "{} · {}{}",
                                text(&s, "title"),
                                text(&s, "name"),
                                if flag(&s, "archived") {
                                    " · archived"
                                } else {
                                    ""
                                }
                            ))
                            .w_full()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select(id.clone(), window, cx);
                                this.modal.clear();
                                cx.notify();
                            })),
                    );
                }
            }
            "rename" => content = content.child(self.dialog_field("title", "Title")),
            "tags" => {
                content = content.child(self.dialog_field("tags", "Tags, separated by commas"))
            }
            "model" => {
                content = content
                    .child(self.dialog_field("model", "Model (provider/model)"))
                    .child(self.dialog_field("thinking", "Thinking level"));
                let mut choices = div()
                    .id("available-models")
                    .max_h(px(220.))
                    .overflow_y_scroll();
                for model in &self.models {
                    let id = text(model, "id");
                    let selected = id == self.value("model", cx);
                    choices = choices.child(
                        Button::new(eid(format!("model-choice-{id}")))
                            .ghost()
                            .xsmall()
                            .label(id.clone())
                            .w_full()
                            .when(selected, |b| b.primary())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(input) = this.fields.get("model") {
                                    input.update(cx, |s, cx| s.set_value(id.clone(), window, cx));
                                }
                                cx.notify();
                            })),
                    );
                }
                content = content.child(choices);
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
            "actions" => {
                let s = self.selected();
                let actions = [
                    ("rename", "Rename thread"),
                    ("title", "Regenerate title"),
                    ("tags", "Edit tags…"),
                    (
                        "pin",
                        if flag(&s, "pinned") {
                            "Unpin thread"
                        } else {
                            "Pin thread"
                        },
                    ),
                    (
                        "bookmark",
                        if flag(&s, "bookmarked") {
                            "Remove bookmark"
                        } else {
                            "Bookmark thread"
                        },
                    ),
                    (
                        "archive",
                        if flag(&s, "archived") {
                            "Reopen thread"
                        } else {
                            "Archive thread"
                        },
                    ),
                    ("branches", "Thread branches"),
                    ("compact", "Summarize context"),
                    ("reset", "Start a new context"),
                    ("model", "Model and thinking…"),
                    ("preview", "Open preview"),
                    ("sync", "Sync project now"),
                    ("reveal", "Show project in Finder"),
                    ("zed", "Open in Zed"),
                    ("update", "Update session server"),
                ];
                for (action, title) in actions {
                    content = content.child(
                        Button::new(eid(format!("action-{action}")))
                            .ghost()
                            .small()
                            .label(title)
                            .w_full()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.modal.clear();
                                this.run_action(action, window, cx);
                            })),
                    );
                }
            }
            _ => {}
        }
        card = card.child(content);
        if !["search", "share", "actions", "branches", "role"].contains(&kind.as_str()) {
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
            .text_size(px(14.))
            .on_action(
                cx.listener(|this, _: &NewThread, window, cx| {
                    this.open_modal("create", window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &AddProject, window, cx| this.choose_project(window, cx)),
            )
            .on_action(cx.listener(|this, _: &SearchThreads, window, cx| {
                this.open_modal("search", window, cx)
            }))
            .on_action(cx.listener(|this, _: &OpenFiles, _, cx| this.set_pane("files", cx)))
            .on_action(cx.listener(|this, _: &ReviewChanges, _, cx| this.set_pane("changes", cx)))
            .on_action(cx.listener(|this, _: &OpenTerminal, window, cx| {
                this.run_action("terminal", window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &ShareThread, _, _| this.send(json!({"type":"invite"}))),
            )
            .on_action(
                cx.listener(|this, _: &ToggleTheme, window, cx| {
                    this.run_action("theme", window, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &StopAgent, _, cx| {
                if !this.modal.is_empty() {
                    this.modal.clear();
                    cx.notify();
                } else {
                    this.send(json!({"type":"abort"}));
                }
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
            .when(!self.toast.is_empty(), |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(42.))
                        .left(px(300.))
                        .right(px(35.))
                        .rounded_lg()
                        .px_4()
                        .py_3()
                        .bg(cx.theme().foreground)
                        .text_color(cx.theme().background)
                        .text_sm()
                        .child(self.toast.clone()),
                )
            })
    }
}
fn main() -> anyhow::Result<()> {
    let (backend, receiver) = Backend::launch()?;
    let shutdown = backend.clone();
    Application::new()
        .with_assets(icons::Assets)
        .run(move |cx| {
            gpui_component::init(cx);
            theme::load_fonts(cx);
            cx.bind_keys([
                KeyBinding::new("cmd-n", NewThread, None),
                KeyBinding::new("cmd-o", AddProject, None),
                KeyBinding::new("cmd-k", SearchThreads, None),
                KeyBinding::new("cmd-p", OpenFiles, None),
                KeyBinding::new("ctrl-`", OpenTerminal, None),
                KeyBinding::new("cmd-shift-d", ReviewChanges, None),
                KeyBinding::new("cmd-shift-s", ShareThread, None),
                KeyBinding::new("cmd-shift-l", ToggleTheme, None),
                KeyBinding::new("escape", StopAgent, Some("SyncPi")),
                KeyBinding::new("cmd-q", Quit, None),
            ]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.set_menus(vec![
                Menu {
                    name: "SyncPi".into(),
                    items: vec![MenuItem::action("Quit SyncPi", Quit)],
                },
                Menu {
                    name: "File".into(),
                    items: vec![
                        MenuItem::action("New Thread", NewThread),
                        MenuItem::action("Add Project…", AddProject),
                        MenuItem::action("Search Threads…", SearchThreads),
                        MenuItem::separator(),
                        MenuItem::action("Open Files", OpenFiles),
                        MenuItem::action("Open Terminal", OpenTerminal),
                        MenuItem::action("Review Changes", ReviewChanges),
                        MenuItem::action("Share Thread", ShareThread),
                    ],
                },
                Menu {
                    name: "View".into(),
                    items: vec![MenuItem::action("Toggle Light/Dark Theme", ToggleTheme)],
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
