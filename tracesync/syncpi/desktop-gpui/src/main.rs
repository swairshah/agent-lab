// SyncPi as a native GPUI app. The window, its sidebar of projects and threads, menus and dialogs are GPUI, drawn
// natively as Delta draws everything; each thread is still the web view (src/web), embedded in a webview, until
// its parts are made native one by one. The app runs the same local host as the Tauri app (dist/desktop-host.mjs),
// which serves the thread pages and keeps their connections, file sync and tools.
mod artifact;
mod citations;
mod cursor;
mod diagram;
mod dialogs;
mod host;
mod icons;
mod inbox;
mod keymap;
mod message;
mod palette;
mod panel;
mod prose;
mod settings;
mod sidebar;
mod terminal;
mod theme;
mod thread;

use gpui::{prelude::FluentBuilder, *};
use gpui_component::{Root, webview::WebView, wry};
use host::{Catalog, Host};
use keymap::RunCommand;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use theme::{palette, sz};
use dialogs::{Ask, Confirm, Dialog, open_url};
use palette::{PaletteEvent, PaletteView, Tab, Target};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use thread::{ThreadEvent, ThreadView};

/// Thread pages kept loaded, so going back to a recent one is instant (as the Tauri app's shell keeps them).
const KEEP: usize = 4;

/// The commands the app itself handles when a thread is its web page; that page has the rest.
const SHELL: &[&str] = &["thread.new", "project.add", "thread.next", "thread.previous", "view.sidebar", "app.quit"];

/// What the app remembers between runs (~/.syncpi/desktop-gpui.json): text size, light or dark, the name to join
/// threads as, the last preview address.
#[derive(Serialize, Deserialize, Default)]
struct Prefs {
    zoom: Option<f32>,
    theme: Option<String>,
    name: Option<String>,
    preview: Option<String>,
    /// Threads drawn natively (the default), or as the web view.
    web: Option<bool>,
    /// This person's requests run on the session's VM rather than this Mac.
    where_vm: Option<bool>,
    /// The inbox's items read, and those already seen (announced), by id (inbox.rs).
    #[serde(default)]
    inbox_read: Vec<String>,
    #[serde(default)]
    inbox_seen: Vec<String>,
}

fn prefs_path() -> std::path::PathBuf {
    std::env::var_os("SYNCPI_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".syncpi"))
        .join("desktop-gpui.json")
}

pub struct Desktop {
    pub host: Host,
    pub catalog: Catalog,
    /// The thread shown.
    pub active: Option<String>,
    /// Loaded thread pages, the most recent last.
    pages: Vec<(String, Entity<WebView>)>,
    /// What each thread's page last said it's doing (bridge.ts "activity").
    pub busy: HashMap<String, bool>,
    /// The webview that takes the host's cookie (from its launch link) before any page loads; gone once it has.
    cookie: Option<wry::WebView>,
    cookie_ready: Arc<AtomicBool>,
    /// Messages from pages (bridge.ts), by thread: drained on the next tick.
    inbox: Arc<Mutex<Vec<(String, String)>>>,
    sidebar_open: bool,
    pub error: Option<String>,
    /// Threads drawn natively (View → Native thread), instead of their web pages: one view per thread opened.
    native: bool,
    threads: HashMap<String, Entity<ThreadView>>,
    /// Each thread's side thread (this person's, /side), once opened, and whether it's the one shown.
    sides: HashMap<String, Entity<ThreadView>>,
    _subscriptions: Vec<Subscription>,
    /// Terminals under a native thread (terminal.rs), by thread, with the one shown; and whether they're shown.
    terminals: HashMap<String, (Vec<Entity<terminal::TerminalView>>, usize)>,
    terminal_open: bool,
    /// The panel beside a native thread (panel.rs), one per thread, and whether it's open.
    panels: HashMap<String, Entity<panel::PanelView>>,
    panel_open: bool,
    /// The setup and land agents' threads, once opened, by thread; and which of them (or the side thread) is shown.
    asides: HashMap<(String, &'static str), Entity<ThreadView>>,
    aside: Option<&'static str>,
    palette: Option<Entity<PaletteView>>,
    dialog: Option<Dialog>,
    /// A short note at the bottom of the window, and whether it's an error; it goes after a few seconds.
    toast: Option<(String, bool, Instant)>,
    prefs: Prefs,
    settings: Option<settings::SettingsState>,
    ticks: u64,
    /// The inbox's items (mentions and tags in drafts, every thread), and the inbox when it's open.
    mentions: Vec<Value>,
    inbox_open: Option<inbox::InboxState>,
    inbox_focus: FocusHandle,
    started_ms: f64,
    /// A message to scroll to once its thread is drawn (thread, item key), and a draft to join there.
    reveal: Option<(String, String, Option<String>)>,
    /// The sidebar lists archived threads instead (⌘Y).
    archives: bool,
}

impl Desktop {
    fn new(host: Host, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let ready = Arc::new(AtomicBool::new(false));
        let flag = ready.clone();
        let cookie = wry::WebViewBuilder::new()
            .with_url(&host.launch)
            .with_visible(false)
            .with_on_page_load_handler(move |_, url| {
                // The launch link answers with the cookie and a redirect to "/": by then the cookie is set.
                if !url.contains("key=") {
                    flag.store(true, Ordering::SeqCst);
                }
            })
            .build_as_child(window)
            .map_err(|e| eprintln!("syncpi: the cookie webview: {e}"))
            .ok();
        let this = Self {
            host,
            catalog: Catalog::default(),
            active: None,
            pages: Vec::new(),
            busy: HashMap::new(),
            cookie,
            cookie_ready: ready,
            inbox: Arc::new(Mutex::new(Vec::new())),
            sidebar_open: true,
            error: None,
            native: true,
            threads: HashMap::new(),
            sides: HashMap::new(),
            _subscriptions: Vec::new(),
            terminals: HashMap::new(),
            terminal_open: false,
            panels: HashMap::new(),
            panel_open: false,
            asides: HashMap::new(),
            aside: None,
            palette: None,
            dialog: None,
            toast: None,
            prefs: std::fs::read(prefs_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default(),
            archives: false,
            settings: None,
            ticks: 0,
            mentions: Vec::new(),
            inbox_open: None,
            inbox_focus: cx.focus_handle(),
            started_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.),
            reveal: None,
        };
        // The thread list every second and a half, as the Tauri shell polls it; page messages every tick.
        cx.spawn_in(window, async move |this, cx| {
            let mut tick = 0u32;
            loop {
                if tick % 6 == 0 {
                    let host = this.update(cx, |this, _| this.host.clone()).ok();
                    let Some(host) = host else { break };
                    let catalog = cx.background_executor().spawn(async move { host.catalog() }).await;
                    if this.update_in(cx, |this, window, cx| this.catalog_loaded(catalog, window, cx)).is_err() {
                        break;
                    }
                }
                if this.update_in(cx, |this, window, cx| this.tick(window, cx)).is_err() {
                    break;
                }
                tick += 1;
                cx.background_executor().timer(Duration::from_millis(250)).await;
            }
        })
        .detach();
        cx.observe_window_appearance(window, |this, window, cx| this.apply_theme(window, cx)).detach();
        let mut this = this;
        // Threads are native unless the web view was chosen (View → Web thread); SYNCPI_GPUI_NATIVE=0 or 1 for tests.
        this.native = match std::env::var("SYNCPI_GPUI_NATIVE").as_deref() {
            Ok("0") => false,
            Ok(_) => true,
            Err(_) => this.prefs.web != Some(true),
        };
        this.apply_theme(window, cx);
        thread::set_where_vm(this.prefs.where_vm.unwrap_or(false));
        this
    }

    fn catalog_loaded(&mut self, catalog: anyhow::Result<Catalog>, window: &mut Window, cx: &mut Context<Self>) {
        match catalog {
            Ok(catalog) => {
                if catalog != self.catalog {
                    self.catalog = catalog;
                    cx.notify();
                }
                self.error = None;
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        // At first, the thread opened last.
        if self.active.is_none() {
            let last = self
                .catalog
                .sessions
                .iter()
                .filter(|t| !t.archived)
                .max_by(|a, b| a.last_opened.unwrap_or(a.created_at).total_cmp(&b.last_opened.unwrap_or(b.created_at)))
                .map(|t| t.id.clone());
            if let Some(id) = last {
                self.show(&id, window, cx);
            }
        }
        // A thread whose setup finished gets its page (or native view).
        if let Some(id) = self.active.clone() {
            self.ensure_page(&id, window, cx);
            self.ensure_thread(&id, window, cx);
        }
    }

    fn save_prefs(&self) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.prefs) {
            let path = prefs_path();
            let _ = std::fs::create_dir_all(path.parent().unwrap());
            let _ = std::fs::write(path, bytes);
        }
    }

    fn is_dark(&self, window: &Window) -> bool {
        match self.prefs.theme.as_deref() {
            Some("dark") => true,
            Some("light") => false,
            _ => dark(window),
        }
    }

    fn apply_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        theme::apply(self.is_dark(window), self.prefs.zoom.unwrap_or(1.), Some(window), cx);
        cx.notify();
    }

    /// ⌘+ / ⌘− / ⌘0: text size, by tenths, kept between runs (no note about it, as asked).
    fn zoom(&mut self, by: f32, window: &mut Window, cx: &mut Context<Self>) {
        let zoom = if by == 0. { 1. } else { ((self.prefs.zoom.unwrap_or(1.) + by) * 10.).round().clamp(8., 15.) / 10. };
        self.prefs.zoom = Some(zoom);
        self.save_prefs();
        self.apply_theme(window, cx);
    }

    pub fn toast(&mut self, text: impl Into<String>, error: bool, cx: &mut Context<Self>) {
        self.toast = Some((text.into(), error, Instant::now()));
        cx.notify();
    }

    /// The thread view shown: the thread's, or its side, setup or land thread.
    fn shown_view(&self) -> Option<Entity<ThreadView>> {
        let id = self.active.as_ref()?;
        let aside = match self.aside {
            Some("side") => self.sides.get(id).cloned(),
            Some(conv) => self.asides.get(&(id.clone(), conv)).cloned(),
            None => None,
        };
        aside.or_else(|| self.threads.get(id).cloned())
    }

    /// The thread's own view (not an aside), for what goes to the whole thread.
    fn main_view(&self) -> Option<Entity<ThreadView>> {
        self.threads.get(self.active.as_ref()?).cloned()
    }

    pub fn focus_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = self.shown_view() {
            view.update(cx, |view, cx| view.focus_composer(window, cx));
        }
    }

    pub fn post_to_thread(&mut self, message: Value, cx: &mut Context<Self>) {
        match self.main_view() {
            Some(view) => view.update(cx, |view, cx| view.post(message, cx)),
            None => self.toast("Open a thread first.", true, cx),
        }
    }

    pub fn decorate(&mut self, id: &str, patch: Value, cx: &mut Context<Self>) {
        let host = self.host.clone();
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let done = cx.background_executor().spawn(async move { host.post(&format!("/api/sessions/{id}/decorate"), &patch).and_then(|_| host.catalog()) }).await;
            let _ = this.update(cx, |this, cx| match done {
                Ok(catalog) => {
                    this.catalog = catalog;
                    cx.notify();
                }
                Err(e) => this.toast(e.to_string(), true, cx),
            });
        })
        .detach();
    }

    /// A request to the open thread's host route, with a note before and after.
    fn thread_verb(&mut self, verb: &'static str, body: Value, before: Option<&'static str>, after: Option<&'static str>, cx: &mut Context<Self>) {
        let Some(id) = self.active.clone() else { return self.toast("Open a thread first.", true, cx) };
        if let Some(note) = before {
            self.toast(note, false, cx);
        }
        let host = self.host.clone();
        cx.spawn(async move |this, cx| {
            let done = cx.background_executor().spawn(async move { host.post(&format!("/api/sessions/{id}/{verb}"), &body) }).await;
            let _ = this.update(cx, |this, cx| match done {
                Ok(_) => {
                    if let Some(note) = after {
                        this.toast(note, false, cx);
                    }
                }
                Err(e) => this.toast(e.to_string(), true, cx),
            });
        })
        .detach();
    }

    fn open_palette(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        let (model, thinking) = self.main_view().map(|v| v.read(cx).model()).unwrap_or_default();
        if tab == Tab::Models && self.main_view().is_some_and(|v| v.read(cx).role() != "admin") {
            return self.toast("Only admins can change the model.", true, cx);
        }
        let threads = self
            .catalog
            .sessions
            .iter()
            .filter(|t| !t.archived)
            .map(|t| palette::ThreadRow { id: t.id.clone(), title: t.shown_title(), project: t.name.clone(), recent: t.last_opened.unwrap_or(t.created_at) })
            .collect();
        let (host, thread) = (self.host.clone(), self.active.clone().filter(|id| self.thread(id).is_some_and(|t| t.ready())));
        let view = cx.new(|cx| PaletteView::new(tab, threads, thread, model, thinking, host, window, cx));
        let subscription = cx.subscribe_in(&view, window, |this, _, event, window, cx| {
            match event {
                PaletteEvent::Close => {}
                PaletteEvent::Run(target, thinking) => {
                    let (target, thinking) = (target.clone(), thinking.clone());
                    this.palette = None;
                    match target {
                        Target::Command(id) => return this.run(&RunCommand { id: id.into() }, window, cx),
                        Target::Thread(id) => return this.show(&id, window, cx),
                        Target::File(path) => this.open_file(path, window, cx),
                        Target::Model(model) => this.post_to_thread(json!({ "type": "configure", "model": model, "thinkingLevel": thinking }), cx),
                    }
                }
            }
            this.palette = None;
            this.focus_thread(window, cx);
            cx.notify();
        });
        self._subscriptions.push(subscription);
        self.palette = Some(view);
        cx.notify();
    }

    /// A project file, from the palette: in a tab of the panel.
    fn open_file(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_panel(false, |panel, cx| {
            panel.open_file(path, cx);
            false
        }, window, cx);
    }

    /// Share (⇧⌘S): a new invite link to the thread, shown to copy.
    fn share(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.active.clone() else { return self.toast("Open a thread first.", true, cx) };
        let host = self.host.clone();
        cx.spawn(async move |this, cx| {
            let made = cx
                .background_executor()
                .spawn(async move {
                    let before = host.get(&format!("/api/sessions/{id}/native"))?["lastInvite"]["url"].clone();
                    host.post(&format!("/api/sessions/{id}/send"), &json!({ "type": "invite" }))?;
                    for _ in 0..40 {
                        std::thread::sleep(Duration::from_millis(150));
                        let invite = host.get(&format!("/api/sessions/{id}/native"))?["lastInvite"].clone();
                        if invite["url"].is_string() && invite["url"] != before {
                            return Ok(invite);
                        }
                    }
                    anyhow::bail!("The thread's server didn't make a link. Only admins can share a thread.")
                })
                .await;
            let _ = this.update(cx, |this, cx| match made {
                Ok(invite) => {
                    let role = invite["invite"]["role"].as_str().unwrap_or("editor");
                    this.dialog = Some(Dialog::Link {
                        title: "Share this thread".into(),
                        url: invite["url"].as_str().unwrap_or_default().to_owned(),
                        detail: format!("Anyone with this link joins as {} {role}, with `syncpi --url <link>` or Join a shared thread in the app.", if role.starts_with(['a', 'e']) { "an" } else { "a" }),
                    });
                    cx.notify();
                }
                Err(e) => this.toast(e.to_string(), true, cx),
            });
        })
        .detach();
    }

    /// The thread's branches (/tree): asked of the server, then listed.
    fn branches(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.active.clone() else { return };
        self.post_to_thread(json!({ "type": "branches" }), cx);
        let host = self.host.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(600)).await;
            let read = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/native")) }).await;
            let _ = this.update(cx, |this, cx| match read {
                Ok(v) => {
                    this.dialog = Some(Dialog::Branches { list: v["branches"].as_array().cloned().unwrap_or_default(), current: v["currentBranch"].as_i64().unwrap_or(0) });
                    cx.notify();
                }
                Err(e) => this.toast(e.to_string(), true, cx),
            });
        })
        .detach();
    }

    /// Shows the setup or land agent's thread (or the side thread), natively, over the thread.
    fn open_aside(&mut self, conv: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.active.clone() else { return };
        if !self.native {
            return self.toast("Switch to the native thread (View) for this.", true, cx);
        }
        if conv == "side" {
            if !self.sides.contains_key(&id) {
                let side = self.thread_view(&id, "side", window, cx);
                self.sides.insert(id.clone(), side);
            }
        } else if !self.asides.contains_key(&(id.clone(), conv)) {
            let view = self.thread_view(&id, conv, window, cx);
            self.asides.insert((id.clone(), conv), view);
        }
        self.aside = Some(conv);
        self.focus_thread(window, cx);
        cx.notify();
    }

    /// Takes the pages' messages, and loads the waiting page once the cookie is set.
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Tests run commands once the thread is open (SYNCPI_GPUI_TEST_COMMAND=id,id…), as their shortcuts would.
        if let Ok(commands) = std::env::var("SYNCPI_GPUI_TEST_COMMAND")
            && !TEST_COMMAND.get()
            && self.main_view().is_some_and(|v| !v.read(cx).role().is_empty())
        {
            TEST_COMMAND.set(true);
            for id in commands.split(',') {
                self.run(&RunCommand { id: id.trim().to_owned().into() }, window, cx);
            }
        }
        // Tests open a file in the panel with lines selected (SYNCPI_GPUI_TEST_FILE=path:from-to).
        if let Ok(spec) = std::env::var("SYNCPI_GPUI_TEST_FILE")
            && !TEST_FILE.get()
            && self.main_view().is_some_and(|v| !v.read(cx).role().is_empty())
        {
            TEST_FILE.set(true);
            let (path, lines) = spec.split_once(':').unwrap_or((&spec, ""));
            let range = lines.split_once('-').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)));
            let path = path.to_owned();
            self.open_file(path.clone(), window, cx);
            if let (Some(range), Some(panel)) = (range, self.panel(window, cx)) {
                panel.update(cx, |panel, cx| panel.select_lines(&path, range, cx));
            }
        }
        // The open panel follows what the thread produces.
        if self.panel_open && self.ticks % 2 == 0 {
            self.panel(window, cx);
        }
        // Settings shows the thread as it is now.
        self.ticks += 1;
        if self.settings.is_some() && self.ticks % 4 == 0 {
            self.refresh_settings(cx);
        }
        if self.ticks % 16 == 2 {
            self.refresh_inbox(cx);
        }
        // An inbox item opened: its message, once the thread has drawn it; or the draft it tagged you in.
        if let Some((thread, key, draft)) = self.reveal.clone()
            && self.active.as_deref() == Some(thread.as_str())
            && let Some(view) = self.threads.get(&thread).cloned()
        {
            let done = match draft {
                Some(owner) if view.read(cx).has_draft(&owner) => {
                    view.update(cx, |view, cx| view.join_draft(owner, window, cx));
                    true
                }
                Some(_) => view.update(cx, |view, cx| view.reveal_key(&key, cx)),
                None => view.update(cx, |view, cx| view.reveal_key(&key, cx)),
            };
            if done || self.ticks % 40 == 0 {
                self.reveal = None;
            }
        }
        if self.toast.as_ref().is_some_and(|(_, error, at)| at.elapsed() > Duration::from_secs(if *error { 6 } else { 3 })) {
            self.toast = None;
            cx.notify();
        }
        if self.cookie.is_some() && self.cookie_ready.load(Ordering::SeqCst) {
            self.cookie = None;
            if let Some(id) = self.active.clone() {
                self.ensure_page(&id, window, cx);
            }
        }
        let messages: Vec<(String, String)> = std::mem::take(&mut *self.inbox.lock().unwrap());
        for (id, body) in messages {
            let Ok(message) = serde_json::from_str::<Value>(&body) else { continue };
            match message["event"].as_str() {
                Some("activity") => {
                    let busy = message["busy"].as_bool().unwrap_or(false);
                    if self.busy.get(&id) != Some(&busy) {
                        self.busy.insert(id, busy);
                        cx.notify();
                    }
                }
                // A new thread is named after its first message at once, then gets a short title written from it.
                Some("title") => {
                    let Some(title) = message["title"].as_str().map(str::to_owned) else { continue };
                    let untitled = self.thread(&id).is_some_and(|t| t.title.as_deref().is_none_or(|s| s.trim().is_empty() || s == "New thread"));
                    if untitled {
                        let host = self.host.clone();
                        cx.background_executor()
                            .spawn(async move {
                                let _ = host.post(&format!("/api/sessions/{id}/decorate"), &json!({ "title": title }));
                                let _ = host.post(&format!("/api/sessions/{id}/title"), &json!({}));
                            })
                            .detach();
                    }
                }
                _ => {}
            }
        }
    }

    pub fn thread(&self, id: &str) -> Option<&host::Thread> {
        self.catalog.sessions.iter().find(|t| t.id == id)
    }

    /// Shows a thread: its page when it's ready (loaded once, kept while recent), else how its setup is going.
    pub fn show(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.active.as_deref() != Some(id) {
            self.aside = None;
        }
        self.active = Some(id.to_owned());
        for (page_id, page) in &self.pages {
            if page_id != id || self.native {
                page.update(cx, |p, _| p.hide());
            }
        }
        self.ensure_page(id, window, cx);
        self.ensure_thread(id, window, cx);
        let host = self.host.clone();
        let id = id.to_owned();
        cx.background_executor()
            .spawn(async move {
                let _ = host.post(&format!("/api/sessions/{id}/open"), &json!({}));
            })
            .detach();
        cx.notify();
    }

    /// The native view of a thread, when threads are drawn natively (it follows the thread live from then on).
    fn ensure_thread(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.native || self.threads.contains_key(id) || !self.thread(id).is_some_and(|t| t.ready()) {
            return;
        }
        let view = self.thread_view(id, "main", window, cx);
        self.threads.insert(id.to_owned(), view);
    }

    /// A native view of a thread's conversation ("main" or "side"), and what it asks of the app.
    fn thread_view(&mut self, id: &str, conv: &'static str, window: &mut Window, cx: &mut Context<Self>) -> Entity<ThreadView> {
        let host = self.host.clone();
        let view = cx.new(|cx| ThreadView::new(id.to_owned(), host, conv, window, cx));
        view.update(cx, |view, cx| view.focus_composer(window, cx));
        let thread = id.to_owned();
        let subscription = cx.subscribe_in(&view, window, move |this, _, event, window, cx| match event {
            ThreadEvent::Side => {
                if this.active.as_deref() == Some(thread.as_str()) {
                    this.open_aside("side", window, cx);
                }
            }
            ThreadEvent::Changes => this.toggle_panel(true, |panel, cx| {
                let same = panel.active == panel::Tab::Changes;
                panel.show_changes(cx);
                same
            }, window, cx),
            ThreadEvent::Terminal(command) => this.new_terminal(Some(command.clone()), window, cx),
            ThreadEvent::Run(id) if id == "thread.ssh" => {
                match this.active.as_deref().and_then(|t| this.thread(t)).and_then(|t| t.vm.clone()) {
                    Some(vm) => this.new_terminal(Some(format!("ssh {vm}.exe.xyz")), window, cx),
                    None => this.toast("This thread runs on this machine, not a VM.", true, cx),
                }
            }
            ThreadEvent::Run(id) => this.run(&RunCommand { id: id.clone().into() }, window, cx),
            ThreadEvent::Where(vm) => {
                this.prefs.where_vm = Some(*vm);
                this.save_prefs();
                thread::set_where_vm(*vm);
                this.toast(if *vm { "Your requests run on the session VM" } else { "Your requests run on this Mac" }, false, cx);
            }
            ThreadEvent::Back => {
                this.aside = None;
                if let Some(main) = this.threads.get(&thread) {
                    main.update(cx, |main, cx| main.focus_composer(window, cx));
                }
                cx.notify();
            }
        });
        self._subscriptions.push(subscription);
        view
    }

    fn ensure_page(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.native || self.cookie.is_some() || !self.thread(id).is_some_and(|t| t.ready()) {
            return;
        }
        if let Some(index) = self.pages.iter().position(|(p, _)| p == id) {
            let page = self.pages.remove(index);
            page.1.update(cx, |p, _| p.show());
            self.pages.push(page);
            return;
        }
        let inbox = self.inbox.clone();
        let from = id.to_owned();
        let built = wry::WebViewBuilder::new()
            .with_url(self.host.page(id))
            .with_ipc_handler(move |request| inbox.lock().unwrap().push((from.clone(), request.body().clone())))
            // Links that open a new window go to the browser.
            .with_new_window_req_handler(|url, _| {
                let _ = std::process::Command::new("open").arg(url).spawn();
                wry::NewWindowResponse::Deny
            })
            .build_as_child(window);
        match built {
            Ok(webview) => {
                let page = cx.new(|cx| WebView::new(webview, window, cx));
                self.pages.push((id.to_owned(), page));
                while self.pages.len() > KEEP {
                    self.pages.remove(0);
                }
            }
            Err(e) => self.error = Some(format!("couldn't open the thread's page: {e}")),
        }
    }

    /// New project: pick a folder, say where it runs, and its first thread opens.
    pub fn new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose the project's folder".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else { return };
            let Some(dir) = paths.first().map(|p| p.to_string_lossy().to_string()) else { return };
            let answer = this
                .update_in(cx, |_, window, cx| {
                    window.prompt(
                        PromptLevel::Info,
                        "Where should this project run?",
                        Some("On this Mac, its agent uses your pi login. On an exe.dev VM, it runs on the shared syncpi host."),
                        &["This Mac", "An exe.dev VM", "Cancel"],
                        cx,
                    )
                })
                .ok();
            let Some(answer) = answer else { return };
            let compute = match answer.await {
                Ok(0) => "local",
                Ok(1) => "host",
                _ => return,
            };
            let _ = this.update_in(cx, |this, window, cx| this.create(json!({ "dir": dir, "compute": compute }), window, cx));
        })
        .detach();
    }

    /// ⌘N: a thread in the current project at once, run where the open thread runs, as in Delta.
    pub fn new_thread(&mut self, dir: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.active.as_deref().and_then(|id| self.thread(id)).cloned();
        let Some(dir) = dir.or_else(|| current.as_ref().map(|t| t.dir.clone())) else {
            return self.new_project(window, cx);
        };
        let same = current.as_ref().filter(|t| t.dir == dir);
        let compute = if same.is_some_and(|t| t.compute == "host") { "host" } else { "local" };
        let vm = same.and_then(|t| t.vm.clone());
        self.create(json!({ "dir": dir, "compute": compute, "vm": vm }), window, cx);
    }

    fn create(&mut self, mut input: Value, window: &mut Window, cx: &mut Context<Self>) {
        input["title"] = json!("");
        input["setupModel"] = json!("");
        if let Some(model) = &self.catalog.defaults.model {
            input["model"] = json!(model);
        }
        if let Some(level) = &self.catalog.defaults.thinking_level {
            input["thinkingLevel"] = json!(level);
        }
        let host = self.host.clone();
        cx.spawn_in(window, async move |this, cx| {
            let created = cx.background_executor().spawn(async move { host.post("/api/sessions", &input).and_then(|v| Ok((v, host.catalog()?))) }).await;
            let _ = this.update_in(cx, |this, window, cx| match created {
                Ok((value, catalog)) => {
                    this.catalog = catalog;
                    if let Some(id) = value["id"].as_str() {
                        this.show(id, window, cx);
                    }
                }
                Err(e) => {
                    let _ = window.prompt(PromptLevel::Critical, "Couldn't start the thread", Some(&e.to_string()), &["OK"], cx);
                }
            });
        })
        .detach();
    }

    /// The open thread's panel, made the first time it's needed.
    fn panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<panel::PanelView>> {
        let id = self.active.clone()?;
        if !self.panels.contains_key(&id) {
            let host = self.host.clone();
            let view = cx.new(|cx| panel::PanelView::new(host, id.clone(), window, cx));
            let subscription = cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
                panel::PanelEvent::Send(message) => {
                    let mut message = message.clone();
                    message["where"] = json!(if this.prefs.where_vm.unwrap_or(false) { "vm" } else { "device" });
                    this.post_to_thread(message, cx);
                    this.toast("Comment sent", false, cx);
                }
                panel::PanelEvent::Close => {
                    this.panel_open = false;
                    this.focus_thread(window, cx);
                    cx.notify();
                }
            });
            self._subscriptions.push(subscription);
            self.panels.insert(id.clone(), view);
        }
        let panel = self.panels.get(&id).cloned()?;
        if let Some(thread) = self.main_view() {
            let artifacts = thread.read(cx).artifacts();
            panel.update(cx, |panel, cx| panel.set_artifacts(artifacts, cx));
        }
        Some(panel)
    }

    /// A new terminal for the open thread (running `command` when given), shown.
    fn new_terminal(&mut self, command: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.active.clone() else { return self.toast("Open a thread first.", true, cx) };
        let host = self.host.clone();
        let view = cx.new(|cx| terminal::TerminalView::new(host, &id, command, cx));
        view.read(cx).focus(window);
        let (list, shown) = self.terminals.entry(id).or_default();
        list.push(view);
        *shown = list.len() - 1;
        self.terminal_open = true;
        cx.notify();
    }

    /// ctrl-`: the terminals, shown or hidden (the first one made when there's none).
    fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.native {
            return self.toast("Switch to the native thread (View) for this.", true, cx);
        }
        let Some(id) = self.active.clone() else { return };
        if self.terminals.get(&id).is_none_or(|(list, _)| list.is_empty()) {
            return self.new_terminal(None, window, cx);
        }
        self.terminal_open = !self.terminal_open;
        if self.terminal_open
            && let Some((list, shown)) = self.terminals.get(&id)
        {
            list[*shown].read(cx).focus(window);
        } else {
            self.focus_thread(window, cx);
        }
        cx.notify();
    }

    /// The terminals under the thread: their tabs, + for another, and the one shown.
    fn terminal_pane(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let id = self.active.clone()?;
        let (list, shown) = self.terminals.get(&id).filter(|(l, _)| self.terminal_open && !l.is_empty())?;
        let p = palette(cx);
        let mut tabs = div().h(px(32.)).flex_none().flex().items_center().gap_1().px_2().border_t_1().border_b_1().border_color(p.rule).bg(p.surface);
        for (n, view) in list.iter().enumerate() {
            let on = n == *shown;
            let (pick, close) = (id.clone(), id.clone());
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("terminal-tab-{n}")))
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .py(px(3.))
                    .rounded(px(5.))
                    .text_size(sz(12.))
                    .cursor_pointer()
                    .when(on, |d| d.bg(p.sunken).text_color(p.ink))
                    .when(!on, |d| d.text_color(p.muted))
                    .child(div().max_w(px(180.)).truncate().child(view.read(cx).title.clone()))
                    .child(
                        div()
                            .id(SharedString::from(format!("terminal-close-{n}")))
                            .child(gpui_component::Icon::new(gpui_component::IconName::Close).size(px(11.)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                if let Some((list, shown)) = this.terminals.get_mut(&close) {
                                    list.remove(n);
                                    *shown = (*shown).min(list.len().saturating_sub(1));
                                    if list.is_empty() {
                                        this.terminal_open = false;
                                        this.focus_thread(window, cx);
                                    }
                                }
                                cx.notify();
                            })),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some((list, shown)) = this.terminals.get_mut(&pick) {
                            *shown = n;
                            list[n].read(cx).focus(window);
                        }
                        cx.notify();
                    })),
            );
        }
        let button = |id: &'static str, icon: gpui_component::IconName, tip: &'static str| {
            div().id(id).p(px(4.)).rounded(px(5.)).text_color(p.muted).cursor_pointer().hover(|s| s.bg(p.sunken).text_color(p.ink)).child(gpui_component::Icon::new(icon).size(px(13.))).tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(tip).build(window, cx))
        };
        tabs = tabs
            .child(button("terminal-new", gpui_component::IconName::Plus, "New terminal").on_click(cx.listener(|this, _, window, cx| this.new_terminal(None, window, cx))))
            .child(div().flex_1())
            .child(button("terminal-hide", gpui_component::IconName::ChevronDown, "Hide (ctrl-`)").on_click(cx.listener(|this, _, window, cx| this.toggle_terminal(window, cx))));
        Some(div().h(px(280.)).flex_none().flex().flex_col().child(tabs).child(div().flex_1().min_h_0().child(list[*shown].clone())).into_any_element())
    }

    /// Opens the panel on what `with` shows; the same command again closes it.
    fn toggle_panel(&mut self, toggle: bool, with: impl FnOnce(&mut panel::PanelView, &mut Context<panel::PanelView>) -> bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.native {
            return self.toast("Switch to the native thread (View) for this.", true, cx);
        }
        let Some(panel) = self.panel(window, cx) else { return self.toast("Open a thread first.", true, cx) };
        let same = panel.update(cx, |panel, cx| with(panel, cx));
        self.panel_open = !(toggle && self.panel_open && same);
        cx.notify();
    }

    /// Shows an artifact opened from the thread in the panel.
    fn open_panel(&mut self, shown: artifact::Shown, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_panel(false, |panel, cx| {
            panel.preview(shown, cx);
            false
        }, window, cx);
    }

    fn step(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let order: Vec<String> = sidebar::groups(&self.catalog, false).into_iter().flat_map(|g| g.threads.into_iter().map(|t| t.id)).collect();
        if order.is_empty() {
            return;
        }
        let at = self.active.as_ref().and_then(|id| order.iter().position(|o| o == id)).unwrap_or(0) as isize;
        let next = (at + by).rem_euclid(order.len() as isize) as usize;
        self.show(&order[next].clone(), window, cx);
    }

    /// Every command (src/shared/keymap.json), from its shortcut, the menus or the palette.
    pub fn run(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        let id = action.id.to_string();
        // A thread shown as its web page has its own commands.
        if !self.native && !SHELL.contains(&id.as_str()) && !id.starts_with("app.") && id != "view.native" {
            return;
        }
        let thread = self.active.clone().unwrap_or_default();
        let current = self.thread(&thread).cloned();
        let editor = |this: &mut Self, cx: &mut Context<Self>| -> bool {
            let role = this.main_view().map(|v| v.read(cx).role()).unwrap_or_default();
            if role == "viewer" {
                this.toast("Viewers can't do that; ask an admin to make you an editor.", true, cx);
            }
            role != "viewer"
        };
        match id.as_str() {
            "palette.all" => self.open_palette(Tab::All, window, cx),
            "palette.commands" => self.open_palette(Tab::Commands, window, cx),
            "palette.files" => self.open_palette(Tab::Files, window, cx),
            "palette.threads" => self.open_palette(Tab::Threads, window, cx),
            "agent.model" => self.open_palette(Tab::Models, window, cx),
            "inbox.toggle" => self.toggle_inbox(window, cx),
            "app.keymap" => {
                self.dialog = Some(Dialog::Keymap);
                cx.notify();
            }
            "app.zoomIn" => self.zoom(0.1, window, cx),
            "app.zoomOut" => self.zoom(-0.1, window, cx),
            "app.zoomReset" => self.zoom(0., window, cx),
            "app.theme" => {
                self.prefs.theme = Some(if self.is_dark(window) { "light" } else { "dark" }.into());
                self.save_prefs();
                self.apply_theme(window, cx);
            }
            "app.quit" => cx.quit(),
            "thread.new" => self.new_thread(None, window, cx),
            "project.add" => self.new_project(window, cx),
            "thread.join" => self.join("", window, cx),
            "thread.next" => self.step(1, window, cx),
            "thread.previous" => self.step(-1, window, cx),
            "thread.share" => self.share(cx),
            "thread.archives" => {
                self.archives = !self.archives;
                cx.notify();
            }
            "view.sidebar" => {
                self.sidebar_open = !self.sidebar_open;
                cx.notify();
            }
            "view.native" => {
                self.native = !self.native;
                self.prefs.web = Some(!self.native);
                self.save_prefs();
                if let Some(id) = self.active.clone() {
                    self.show(&id, window, cx);
                }
            }
            _ if current.is_none() => self.toast("Open a thread first.", true, cx),
            "thread.rename" => self.ask("Rename thread", "Title", &current.as_ref().unwrap().shown_title(), "Rename", "", Ask::Rename(thread), window, cx),
            "thread.title" => self.thread_verb("title", json!({}), Some("Writing a title…"), None, cx),
            "thread.pin" => self.decorate(&thread, json!({ "pinned": !current.as_ref().unwrap().pinned }), cx),
            "thread.bookmark" => {
                let on = !current.as_ref().unwrap().bookmarked;
                self.toast(if on { "Bookmarked" } else { "Bookmark removed" }, false, cx);
                self.decorate(&thread, json!({ "bookmarked": on }), cx);
            }
            "thread.archive" => {
                let archived = !current.as_ref().unwrap().archived;
                self.decorate(&thread, json!({ "archived": archived }), cx);
                if archived {
                    self.step(1, window, cx);
                }
            }
            "thread.tags" => self.ask("Tags", "Tags, separated by commas", &current.as_ref().unwrap().tags.join(", "), "Save", "", Ask::Tags(thread), window, cx),
            "project.sync" => self.thread_verb("sync", json!({}), Some("Syncing…"), Some("Project synchronized"), cx),
            "project.reveal" => self.thread_verb("reveal", json!({ "editor": false }), None, None, cx),
            "project.zed" => self.thread_verb("reveal", json!({ "editor": true }), None, None, cx),
            "project.update" => self.thread_verb("update", json!({}), Some("Updating the server…"), Some("Server updated"), cx),
            "project.preview" => {
                let last = self.prefs.preview.clone().unwrap_or_else(|| "http://localhost:3000".into());
                self.ask("Preview", "Address", &last, "Open", "Opens in your browser.", Ask::Preview, window, cx);
            }
            "project.web" => {
                let host = self.host.clone();
                cx.spawn(async move |this, cx| {
                    let link = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{thread}/weblink")) }).await;
                    let _ = this.update(cx, |this, cx| match link {
                        Ok(v) => open_url(v["url"].as_str().unwrap_or_default()),
                        Err(e) => this.toast(e.to_string(), true, cx),
                    });
                })
                .detach();
            }
            "agent.stop" => {
                if let Some(view) = self.shown_view() {
                    view.update(cx, |view, cx| view.stop(cx));
                }
            }
            "agent.compact" if editor(self, cx) => self.confirm(Confirm::Compact, cx),
            "agent.newContext" => {
                if self.main_view().is_some_and(|v| v.read(cx).role() != "admin") {
                    return self.toast("Only admins can start a new context.", true, cx);
                }
                self.confirm(Confirm::NewContext, cx);
            }
            "agent.branches" => self.branches(cx),
            "view.changes" => self.toggle_panel(true, |panel, cx| {
                let same = panel.active == panel::Tab::Changes;
                panel.show_changes(cx);
                same
            }, window, cx),
            "view.git" => self.toggle_panel(true, |panel, cx| {
                let same = panel.active == panel::Tab::Git;
                panel.show_git(cx);
                same
            }, window, cx),
            "view.files" => {
                let open = self.panel_open;
                self.toggle_panel(false, |panel, cx| {
                    if !open && panel.tree_open {
                        return false;
                    }
                    panel.toggle_tree(cx);
                    false
                }, window, cx);
            }
            "view.terminal" => self.toggle_terminal(window, cx),
            "file.comment" => self.toast("Pick lines by their numbers in a file's tab, then write the comment under them.", false, cx),
            "app.settings" => self.open_settings(settings::Section::General, window, cx),
            "view.people" => self.open_settings(settings::Section::People, window, cx),
            "agent.setup" => self.open_aside("setup", window, cx),
            "agent.side" => self.open_aside("side", window, cx),
            "agent.landThread" => self.open_aside("land", window, cx),
            "agent.land" if editor(self, cx) => {
                self.post_to_thread(json!({ "type": "land", "where": "device" }), cx);
                self.open_aside("land", window, cx);
            }
            "agent.compact" | "agent.land" => {}
            other => {
                if let Some(command) = keymap::command(other) {
                    self.toast(format!("{} isn't in the native app yet.", command.title), true, cx);
                }
            }
        }
    }

    fn main_pane(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let thread = self.active.as_deref().and_then(|id| self.thread(id));
        let state = |title: String, detail: String| {
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .child(div().text_size(sz(22.)).text_color(p.ink).child(title))
                .child(div().max_w(px(480.)).text_size(sz(13.5)).text_color(p.muted).child(detail))
                .into_any_element()
        };
        match thread {
            None if self.catalog.sessions.iter().all(|t| t.archived) => div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(div().text_size(sz(26.)).text_color(p.ink).child("Start a thread"))
                .child(div().text_size(sz(13.5)).text_color(p.muted).child("Open a project folder and talk to an agent about it, alone or with others."))
                .child(
                    div()
                        .id("empty-new-project")
                        .px_4()
                        .py_2()
                        .rounded_md()
                        .bg(p.accent)
                        .text_color(p.accent_ink)
                        .text_size(sz(13.5))
                        .cursor_pointer()
                        .child("New project")
                        .on_click(cx.listener(|this, _, window, cx| this.new_project(window, cx))),
                )
                .into_any_element(),
            None => div().size_full().into_any_element(),
            Some(t) if t.status.as_deref() == Some("failed") => state("Setup failed".into(), t.error.clone().unwrap_or_default()),
            Some(t) if !t.ready() => state("Preparing the thread".into(), t.step.clone().unwrap_or_else(|| "Starting".into())),
            Some(_) if self.native => match self.shown_view() {
                Some(view) => {
                    let panel = self.panel_open.then(|| self.active.as_ref().and_then(|id| self.panels.get(id).cloned())).flatten();
                    let wide = panel.as_ref().is_some_and(|p| p.read(cx).tree_open);
                    let terminals = self.terminal_pane(cx);
                    div()
                        .size_full()
                        .flex()
                        .child(div().flex_1().min_w_0().h_full().flex().flex_col().child(div().flex_1().min_h_0().child(view.clone())).children(terminals))
                        .children(panel.map(|panel| div().w(px(if wide { 820. } else { 600. })).flex_none().h_full().border_l_1().border_color(palette(cx).rule).child(panel)))
                        .into_any_element()
                }
                None => state("Opening".into(), String::new()),
            },
            Some(t) => match self.pages.iter().find(|(id, _)| *id == t.id) {
                Some((_, page)) => div().size_full().child(page.clone()).into_any_element(),
                None => state("Opening".into(), String::new()),
            },
        }
    }
}

thread_local! {
    static TEST_COMMAND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TEST_FILE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A query string's value, escaped.
fn url_escape(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Dark when the system is (SYNCPI_GPUI_THEME=dark or light overrides it, for tests).
fn dark(window: &Window) -> bool {
    match std::env::var("SYNCPI_GPUI_THEME").as_deref() {
        Ok("dark") => true,
        Ok("light") => false,
        _ => matches!(window.appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark),
    }
}

impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // An artifact's Open (artifact.rs) asks for the panel.
        if let Some(shown) = artifact::take_open() {
            self.open_panel(shown, window, cx);
        }
        let p = palette(cx);
        let dialog = self.dialog_view(cx);
        let settings = self.settings_view(window, cx);
        let inbox = self.inbox_view(cx);
        let toast = self.toast.as_ref().map(|(text, error, _)| {
            div()
                .absolute()
                .bottom(px(28.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .px_3()
                        .py(px(7.))
                        .rounded(px(8.))
                        .bg(if *error { p.removed } else { p.ink })
                        .text_color(p.paper)
                        .text_size(sz(13.))
                        .shadow_md()
                        .child(text.clone()),
                )
        });
        div()
            .relative()
            .size_full()
            .flex()
            .bg(p.paper)
            .text_color(p.ink)
            .font_family(theme::SANS)
            .key_context("SyncPi")
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| this.run(action, window, cx)))
            .when(self.sidebar_open, |d| d.child(sidebar::render(self, window, cx)))
            .child(div().flex_1().h_full().min_w_0().child(self.main_pane(window, cx)))
            .children(self.palette.clone())
            .children(settings)
            .children(inbox)
            .children(dialog)
            .children(toast)
    }
}

fn main() -> anyhow::Result<()> {
    let host = Host::start()?;
    let shutdown = host.clone();
    let app = Application::new().with_assets(icons::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        theme::load_fonts(cx);
        // Every command's shortcut. Find belongs to a native thread (a thread's web page keeps its own); Esc stops
        // the agent only outside text fields, which use it themselves.
        let bindings: Vec<KeyBinding> = keymap::commands()
            .into_iter()
            .filter_map(|c| {
                let keys = c.keys?;
                let context = match c.id.as_str() {
                    id if id.starts_with("find.") => Some("ThreadView"),
                    "agent.stop" => Some("ThreadView && !Input"),
                    _ => None,
                };
                Some(KeyBinding::new(&keys, RunCommand { id: c.id.into() }, context))
            })
            .chain([KeyBinding::new("cmd-q", RunCommand { id: "app.quit".into() }, None)])
            .collect();
        cx.bind_keys(bindings);
        cx.on_action(|action: &RunCommand, cx| {
            if action.id == "app.quit" {
                cx.quit();
            }
        });
        let item = |id: &str| {
            let title = keymap::command(id).map(|c| c.title).unwrap_or_else(|| id.to_owned());
            MenuItem::action(title, RunCommand { id: id.to_owned().into() })
        };
        cx.set_menus(vec![
            Menu {
                name: "SyncPi".into(),
                items: vec![item("app.keymap"), MenuItem::separator(), MenuItem::action("Quit SyncPi", RunCommand { id: "app.quit".into() })],
            },
            Menu {
                name: "File".into(),
                items: vec![item("project.add"), item("thread.new"), item("thread.join"), MenuItem::separator(), item("thread.share"), item("thread.rename"), item("thread.archive")],
            },
            // The thread's page is a native webview: these reach it as the standard Edit commands.
            Menu {
                name: "Edit".into(),
                items: vec![
                    MenuItem::os_action("Cut", RunCommand { id: "edit.cut".into() }, OsAction::Cut),
                    MenuItem::os_action("Copy", RunCommand { id: "edit.copy".into() }, OsAction::Copy),
                    MenuItem::os_action("Paste", RunCommand { id: "edit.paste".into() }, OsAction::Paste),
                    MenuItem::os_action("Select All", RunCommand { id: "edit.selectAll".into() }, OsAction::SelectAll),
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
                    item("thread.archives"),
                    item("app.theme"),
                    item("app.zoomIn"),
                    item("app.zoomOut"),
                    item("app.zoomReset"),
                    MenuItem::action("Native or web thread", RunCommand { id: "view.native".into() }),
                    MenuItem::separator(),
                    item("thread.next"),
                    item("thread.previous"),
                ],
            },
            Menu {
                name: "Agent".into(),
                items: vec![
                    item("agent.stop"),
                    item("agent.model"),
                    item("agent.side"),
                    MenuItem::separator(),
                    item("agent.compact"),
                    item("agent.newContext"),
                    item("agent.branches"),
                    MenuItem::separator(),
                    item("agent.land"),
                    item("agent.landThread"),
                    item("agent.setup"),
                ],
            },
        ]);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        // SYNCPI_GPUI_WINDOW=x,y,w,h places the window (tests put it off screen); otherwise centered.
        let bounds = std::env::var("SYNCPI_GPUI_WINDOW")
            .ok()
            .and_then(|v| {
                let n: Vec<f32> = v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
                (n.len() == 4).then(|| Bounds::new(point(px(n[0]), px(n[1])), size(px(n[2]), px(n[3]))))
            })
            .unwrap_or_else(|| Bounds::centered(None, size(px(1380.), px(900.)), cx));
        let background = std::env::var_os("SYNCPI_GPUI_WINDOW").is_some();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(720.), px(480.))),
                focus: !background,
                // Placed for a test: above other windows, so the corner left on screen keeps it drawing (GPUI stops
                // drawing a window macOS reports as covered), without ever taking focus.
                kind: if background { WindowKind::PopUp } else { WindowKind::Normal },
                titlebar: Some(TitlebarOptions {
                    title: Some("SyncPi".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(16.), px(17.))),
                }),
                ..Default::default()
            },
            move |window, cx| {
                let view = cx.new(|cx| Desktop::new(host, window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            },
        )
        .expect("open the SyncPi window");
        if !background {
            cx.activate(true);
        }
    });
    shutdown.stop();
    Ok(())
}
