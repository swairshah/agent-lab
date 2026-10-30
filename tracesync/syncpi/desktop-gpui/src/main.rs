// SyncPi as a native GPUI app. The window, its sidebar of projects and threads, menus and dialogs are GPUI, drawn
// natively as Delta draws everything; each thread is still the web view (src/web), embedded in a webview, until
// its parts are made native one by one. The app runs the same local host as the Tauri app (dist/desktop-host.mjs),
// which serves the thread pages and keeps their connections, file sync and tools.
mod artifact;
mod citations;
mod cursor;
mod diagram;
mod host;
mod icons;
mod keymap;
mod message;
mod prose;
mod sidebar;
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
use thread::ThreadView;

/// Thread pages kept loaded, so going back to a recent one is instant (as the Tauri app's shell keeps them).
const KEEP: usize = 4;

/// The commands the app itself handles; every other shortcut belongs to the thread's page.
const NATIVE: &[&str] = &["thread.new", "project.add", "thread.next", "thread.previous", "view.sidebar", "app.quit"];

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
    /// What the panel beside a native thread shows (an artifact opened from it), and its webview when it has one.
    panel: Option<(artifact::Shown, Option<Entity<WebView>>)>,
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
            native: std::env::var("SYNCPI_GPUI_NATIVE").as_deref() == Ok("1"),
            threads: HashMap::new(),
            panel: None,
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
        cx.observe_window_appearance(window, |_, window, cx| {
            theme::apply(dark(window), 1., Some(window), cx);
            cx.notify();
        })
        .detach();
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

    /// Takes the pages' messages, and loads the waiting page once the cookie is set.
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
            self.panel = None;
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
        let host = self.host.clone();
        let view = cx.new(|cx| ThreadView::new(id.to_owned(), host, window, cx));
        view.update(cx, |view, cx| view.focus_composer(window, cx));
        self.threads.insert(id.to_owned(), view);
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

    /// Shows an artifact in the panel: HTML in a private webview (its own data store: no cookies, nothing to reach the
    /// app with), a page the host serves (a recording) in one with the host's cookie, images and Markdown natively.
    fn open_panel(&mut self, shown: artifact::Shown, window: &mut Window, cx: &mut Context<Self>) {
        self.panel = None;
        let builder = match &shown {
            artifact::Shown::Html { content, .. } => Some(wry::WebViewBuilder::new().with_incognito(true).with_html(content)),
            artifact::Shown::Page { url, .. } => Some(wry::WebViewBuilder::new().with_url(url)),
            _ => None,
        };
        let webview = builder.and_then(|b| b.build_as_child(window).map_err(|e| self.error = Some(e.to_string())).ok()).map(|w| cx.new(|cx| WebView::new(w, window, cx)));
        self.panel = Some((shown, webview));
        cx.notify();
    }

    fn panel_view(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let Some((shown, webview)) = &self.panel else { return div().into_any_element() };
        let body = match (shown, webview) {
            (_, Some(webview)) => div().size_full().child(webview.clone()).into_any_element(),
            (artifact::Shown::Image { image, .. }, _) => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .p_4()
                .bg(gpui::white())
                .child(img(image.clone()).max_w_full().max_h_full().object_fit(ObjectFit::Contain))
                .into_any_element(),
            (artifact::Shown::Markdown { content, title }, _) => div()
                .id("panel-markdown")
                .size_full()
                .overflow_y_scroll()
                .px_5()
                .py_4()
                .text_size(sz(14.5))
                .line_height(sz(23.))
                .child(div().child(message::render(&format!("panel-{title}"), content, window, cx)))
                .into_any_element(),
            _ => div().into_any_element(),
        };
        div()
            .w(px(480.))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(p.rule)
            .bg(p.surface)
            .child(
                div()
                    .h(px(40.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_2()
                    .pl_4()
                    .pr_2()
                    .border_b_1()
                    .border_color(p.rule)
                    .child(div().flex_1().min_w_0().truncate().text_size(sz(13.)).text_color(p.ink_2).child(shown.title().to_owned()))
                    .child(
                        div()
                            .id("panel-close")
                            .p(px(5.))
                            .rounded(px(5.))
                            .text_color(p.muted)
                            .hover(|s| s.bg(p.sunken).text_color(p.ink))
                            .cursor_pointer()
                            .child(gpui_component::Icon::new(gpui_component::IconName::Close).size(px(14.)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.panel = None;
                                cx.notify();
                            })),
                    ),
            )
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    fn step(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let order: Vec<String> = sidebar::groups(&self.catalog).into_iter().flat_map(|g| g.threads.into_iter().map(|t| t.id)).collect();
        if order.is_empty() {
            return;
        }
        let at = self.active.as_ref().and_then(|id| order.iter().position(|o| o == id)).unwrap_or(0) as isize;
        let next = (at + by).rem_euclid(order.len() as isize) as usize;
        self.show(&order[next].clone(), window, cx);
    }

    fn run(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        match action.id.as_ref() {
            "thread.new" => self.new_thread(None, window, cx),
            "project.add" => self.new_project(window, cx),
            "thread.next" => self.step(1, window, cx),
            "thread.previous" => self.step(-1, window, cx),
            "view.sidebar" => {
                self.sidebar_open = !self.sidebar_open;
                cx.notify();
            }
            "view.native" => {
                self.native = !self.native;
                if let Some(id) = self.active.clone() {
                    self.show(&id, window, cx);
                }
            }
            "app.quit" => cx.quit(),
            _ => {}
        }
    }

    fn main_pane(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
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
            Some(t) if self.native => match self.threads.get(&t.id) {
                Some(view) => div()
                    .size_full()
                    .flex()
                    .child(div().flex_1().min_w_0().h_full().child(view.clone()))
                    .when(self.panel.is_some(), |d| d.child(self.panel_view(window, cx)))
                    .into_any_element(),
                None => state("Opening".into(), String::new()),
            },
            Some(t) => match self.pages.iter().find(|(id, _)| *id == t.id) {
                Some((_, page)) => div().size_full().child(page.clone()).into_any_element(),
                None => state("Opening".into(), String::new()),
            },
        }
    }
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
        div()
            .size_full()
            .flex()
            .bg(p.paper)
            .text_color(p.ink)
            .font_family(theme::SANS)
            .key_context("SyncPi")
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| this.run(action, window, cx)))
            .when(self.sidebar_open, |d| d.child(sidebar::render(self, window, cx)))
            .child(div().flex_1().h_full().min_w_0().child(self.main_pane(window, cx)))
    }
}

fn main() -> anyhow::Result<()> {
    let host = Host::start()?;
    let shutdown = host.clone();
    let app = Application::new().with_assets(icons::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        theme::load_fonts(cx);
        let bindings: Vec<KeyBinding> = keymap::commands()
            .into_iter()
            .filter(|c| NATIVE.contains(&c.id.as_str()))
            .filter_map(|c| Some(KeyBinding::new(&c.keys?, RunCommand { id: c.id.into() }, None)))
            .chain([
                KeyBinding::new("cmd-q", RunCommand { id: "app.quit".into() }, None),
                // Find in a native thread; a thread's web page keeps its own.
                KeyBinding::new("cmd-f", RunCommand { id: "find.open".into() }, Some("ThreadView")),
                KeyBinding::new("cmd-g", RunCommand { id: "find.next".into() }, Some("ThreadView")),
                KeyBinding::new("cmd-shift-g", RunCommand { id: "find.previous".into() }, Some("ThreadView")),
            ])
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
            Menu { name: "SyncPi".into(), items: vec![MenuItem::action("Quit SyncPi", RunCommand { id: "app.quit".into() })] },
            Menu { name: "File".into(), items: vec![item("project.add"), item("thread.new")] },
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
                    item("view.sidebar"),
                    MenuItem::action("Native thread (preview)", RunCommand { id: "view.native".into() }),
                    MenuItem::separator(),
                    item("thread.next"),
                    item("thread.previous"),
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
                theme::apply(dark(window), 1., Some(window), cx);
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
