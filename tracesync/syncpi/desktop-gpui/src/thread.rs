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
}

pub struct ThreadView {
    id: String,
    host: Host,
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
    _subscriptions: Vec<Subscription>,
}

struct FindBar {
    input: Entity<InputState>,
    matches: Vec<(String, usize)>,
    current: usize,
    _subscription: Subscription,
}

impl ThreadView {
    pub fn new(id: String, host: Host, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(1, 14)
                .placeholder("Message the agent. Enter for a new line, ⌘↩ to send")
        });
        let subscriptions = vec![cx.subscribe_in(&composer, window, |this, _, event, window, cx| {
            // Enter starts a new line; ⌘↩ sends, as in the web view.
            if let InputEvent::PressEnter { secondary: true } = event {
                this.submit(window, cx);
            }
        })];
        // The host's stream, read on a thread of its own; each event reaches the view on the main thread. It ends
        // when the view goes (its receiver with it), and starts again when the host's connection drops.
        let (events, mut received) = futures::channel::mpsc::unbounded::<Value>();
        let stream_host = host.clone();
        let path = format!("/api/sessions/{id}/stream");
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
        self.meta = json!({ "me": event["me"], "members": event["members"], "online": event["online"], "target": event["target"] });
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

    /// Scrolls the current match's row into view.
    fn reveal(&mut self, cx: &mut Context<Self>) {
        let Some((key, _)) = self.find.as_ref().and_then(|f| f.matches.get(f.current)) else { return };
        if let Some(&row) = self.row_of.get(key) {
            self.list.scroll_to_reveal_item(row);
        }
        cx.notify();
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

    fn send(&self, message: Value, cx: &mut Context<Self>) {
        let host = self.host.clone();
        let path = format!("/api/sessions/{}/send", self.id);
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = host.post(&path, &message) {
                    eprintln!("syncpi: sending to the thread: {e}");
                }
            })
            .detach();
    }

    /// ⌘↩: the composer's text to the agent. As in the web view, it stops the run in progress (when this person may)
    /// and runs on this Mac.
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        let request = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        self.send(json!({ "type": "submit", "requestId": request, "text": text, "mode": "interrupt", "where": "device" }), cx);
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        self.send(json!({ "type": "abort" }), cx);
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

    fn user_row(&self, item: &Value, key: &str, p: &Palette, window: &mut Window, cx: &mut App) -> AnyElement {
        let name = self.name_of(&text(item, "memberId"), item["author"].as_str().unwrap_or("someone").to_owned());
        let color = theme::person_color(&name, p.dark);
        let body = text(item, "text");
        div()
            .w(px(content_width() + AVATAR + GAP))
            .flex()
            .items_start()
            .gap(px(12.))
            .child(div().flex_none().text_size(sz(13.5)).line_height(sz(LINE)).font_weight(FontWeight::SEMIBOLD).text_color(color).child(name))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(sz(15.))
                    .line_height(sz(LINE))
                    .child(message::render(&format!("user-{key}"), &keep_breaks(&body), window, cx)),
            )
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
        let main = self.main.clone();
        let items = std::mem::take(&mut self.items);
        // The text cursor in messages (cursor.rs, prose.rs): not focused here; no comments on messages yet.
        crate::cursor::set_marks(Default::default(), p.removed);
        crate::cursor::begin(p.accent.opacity(0.22), p.accent, false, None, &self.list);
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
        let viewer = self.meta["me"]["role"] == "viewer";
        rows.push(
            div()
                .mt(px(18.))
                .child(if viewer {
                    div().text_size(sz(13.)).text_color(p.muted).child("You can read this thread. Ask an admin to make you an editor to talk to the agent.").into_any_element()
                } else {
                    row(
                        Some(avatar_person(&text(&self.meta["me"], "name"), p.dark)),
                        div().w_full().child(Input::new(&self.composer).appearance(false).px_0().py(px(2.)).w_full().text_size(sz(15.))),
                    )
                    .into_any_element()
                })
                .into_any_element(),
        );
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
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| this.command(action, window, cx)))
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
fn patch_stats(patch: &str) -> (usize, usize) {
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
fn diff_view(id: String, patch: &str, p: &Palette) -> Stateful<Div> {
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
