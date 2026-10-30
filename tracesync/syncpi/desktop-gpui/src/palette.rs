// The command palette, as in Delta and the web view (src/web/palette.ts): ⌘K searches everything, ⌘⇧P opens on
// commands, ⌘T on threads, ⌘P on files; ⌘1–⌘4 switch tabs. Arrows move, Enter runs, Esc closes. The same box picks
// the agent's model (⌘⌥/): models under the provider serving them, with the thinking level. It's a view of its own;
// the app (main.rs) runs what's picked.
use crate::host::Host;
use crate::keymap::{self, Command};
use crate::theme::{self, Palette, sz};
use crate::icons;
use gpui::{prelude::FluentBuilder, *};
use gpui_component::input::{Input, InputEvent, InputState};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    All,
    Threads,
    Commands,
    Files,
    /// The model picker; not one of the tabs.
    Models,
}
pub const THINKING: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TABS: [(Tab, &str); 4] = [(Tab::All, "All"), (Tab::Threads, "Threads"), (Tab::Commands, "Commands"), (Tab::Files, "Files")];

#[derive(Clone)]
pub enum Target {
    Command(String),
    Thread(String),
    File(String),
    Model(String),
}

/// What the palette asks of the app: run what was picked (with the thinking level, for a model), or close.
pub enum PaletteEvent {
    Run(Target, String),
    Close,
}

/// A thread the palette can go to.
#[derive(Clone)]
pub struct ThreadRow {
    pub id: String,
    pub title: String,
    pub project: String,
    pub recent: f64,
}

#[derive(Clone)]
struct Row {
    title: String,
    detail: String,
    keys: Option<String>,
    section: String,
    /// A vendor mark (asset path) shown before the title.
    icon: Option<String>,
    current: bool,
    target: Target,
}

pub struct PaletteView {
    tab: Tab,
    selected: usize,
    /// Select the model in use once the list has it (the models arrive after the picker opens).
    select_current: bool,
    /// Scroll the selected row into view on the next frame.
    follow: bool,
    thinking: String,
    input: Entity<InputState>,
    scroll: ScrollHandle,
    threads: Vec<ThreadRow>,
    current_model: String,
    files: Rc<RefCell<Option<Vec<String>>>>,
    models: Rc<RefCell<Option<Vec<Value>>>>,
    _subscription: Subscription,
}

impl EventEmitter<PaletteEvent> for PaletteView {}

impl PaletteView {
    /// Opens on `tab`; the open thread's files and models (`thread`) load from the host as it opens.
    pub fn new(tab: Tab, threads: Vec<ThreadRow>, thread: Option<String>, current_model: String, thinking: String, host: Host, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = if tab == Tab::Models { "Select a model…" } else { "Search commands, threads and files…" };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        input.update(cx, |state, cx| state.focus(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
            InputEvent::Change => {
                this.selected = 0;
                this.follow = true;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.run(this.selected, window, cx),
            _ => {}
        });
        let (files, models) = (Rc::new(RefCell::new(None)), Rc::new(RefCell::new(None)));
        if let Some(id) = thread {
            let (files_slot, models_slot) = (files.clone(), models.clone());
            cx.spawn(async move |this, cx| {
                let (h1, id1) = (host.clone(), id.clone());
                let listed = cx.background_executor().spawn(async move { h1.get(&format!("/api/sessions/{id1}/files")) }).await;
                *files_slot.borrow_mut() = Some(listed.ok().and_then(|v| serde_json::from_value(v["files"].clone()).ok()).unwrap_or_default());
                let _ = this.update(cx, |_, cx| cx.notify());
                if tab == Tab::Models {
                    let found = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/models")) }).await;
                    *models_slot.borrow_mut() = Some(found.ok().and_then(|v| v["models"].as_array().cloned()).unwrap_or_default());
                    let _ = this.update(cx, |_, cx| cx.notify());
                }
            })
            .detach();
        }
        Self {
            tab,
            selected: 0,
            select_current: tab == Tab::Models,
            follow: true,
            thinking: if thinking.is_empty() { "medium".into() } else { thinking },
            input,
            scroll: ScrollHandle::new(),
            threads,
            current_model,
            files,
            models,
            _subscription: subscription,
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |state, cx| state.focus(window, cx));
    }

    fn query(&self, cx: &App) -> String {
        self.input.read(cx).value().trim().to_owned()
    }

    fn command_rows(commands: &[Command], query: &str, section: &str) -> Vec<Row> {
        let mut rows: Vec<(i32, Row)> = commands
            .iter()
            .filter_map(|c| {
                let s = score(&c.title, query).max(score(&c.group, query).map(|s| s - 10))?;
                Some((s, Row { title: c.title.clone(), detail: c.group.clone(), keys: c.keys.clone(), section: section.to_owned(), icon: None, current: false, target: Target::Command(c.id.clone()) }))
            })
            .collect();
        if !query.is_empty() {
            rows.sort_by(|a, b| b.0.cmp(&a.0));
        }
        rows.into_iter().map(|(_, r)| r).collect()
    }

    fn thread_rows(&self, query: &str, limit: usize) -> Vec<Row> {
        let mut rows: Vec<(i32, f64, Row)> = self
            .threads
            .iter()
            .filter_map(|t| {
                let found = score(&t.title, query).max(score(&t.project, query).map(|s| s - 20))?;
                Some((found, t.recent, Row { title: t.title.clone(), detail: t.project.clone(), keys: None, section: "Threads".into(), icon: None, current: false, target: Target::Thread(t.id.clone()) }))
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.total_cmp(&a.1)));
        rows.into_iter().take(limit).map(|(_, _, r)| r).collect()
    }

    fn file_rows(&self, query: &str, limit: usize) -> Vec<Row> {
        let files = self.files.borrow();
        let mut rows: Vec<(i32, Row)> = files
            .iter()
            .flatten()
            .filter_map(|path| {
                let name = path.rsplit('/').next().unwrap_or(path);
                let s = score(path, query)? + if score(name, query).unwrap_or(0) > 0 { 200 } else { 0 };
                let dir = path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
                Some((s, Row { title: name.to_owned(), detail: dir, keys: None, section: "Files".into(), icon: Some("syncpi/code.svg".into()), current: false, target: Target::File(path.clone()) }))
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.detail.len().cmp(&b.1.detail.len())));
        rows.into_iter().take(limit).map(|(_, r)| r).collect()
    }

    /// Models under the provider that serves them, as in Delta's picker; the one in use is checked.
    fn model_rows(&self, query: &str) -> Vec<Row> {
        let models = self.models.borrow();
        let mut rows: Vec<(i32, Row)> = models
            .iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str().unwrap_or_default().to_owned();
                let name = m["name"].as_str().unwrap_or(&id).to_owned();
                let s = score(&name, query).max(score(&id, query).map(|s| s - 5))?;
                let vendor = icons::model_vendor(&id);
                let provider = id.split('/').next().unwrap_or("").to_owned();
                Some((
                    s,
                    Row {
                        title: match &vendor {
                            Some((vendor, _)) => format!("{vendor}: {name}"),
                            None => name,
                        },
                        detail: id.clone(),
                        keys: None,
                        section: icons::provider_name(&provider),
                        icon: Some(vendor.map(|(_, path)| path).unwrap_or_default()),
                        current: id == self.current_model,
                        target: Target::Model(id),
                    },
                ))
            })
            .collect();
        if !query.is_empty() {
            rows.sort_by(|a, b| b.0.cmp(&a.0));
        }
        // Grouped by provider; the sort is stable, so the order within a group stays.
        rows.sort_by(|a, b| a.1.section.cmp(&b.1.section));
        rows.into_iter().map(|(_, r)| r).collect()
    }

    fn rows(&self, cx: &App) -> Vec<Row> {
        let query = self.query(cx);
        let commands = keymap::commands();
        match self.tab {
            Tab::Commands => Self::command_rows(&commands, &query, "Commands"),
            Tab::Threads => self.thread_rows(&query, 80),
            Tab::Files => self.file_rows(&query, 60),
            Tab::Models => self.model_rows(&query),
            Tab::All if query.is_empty() => {
                let quick: Vec<Command> = commands.iter().filter(|c| c.quick).cloned().collect();
                let mut rows = Self::command_rows(&quick, "", "Quick actions");
                rows.extend(self.thread_rows("", 6).into_iter().map(|r| Row { section: "Recent threads".into(), ..r }));
                rows.extend(Self::command_rows(&commands.iter().filter(|c| !c.quick).cloned().collect::<Vec<_>>(), "", "Commands"));
                rows
            }
            Tab::All => {
                let mut rows = Self::command_rows(&commands, &query, "Commands");
                rows.truncate(8);
                rows.extend(self.thread_rows(&query, 6));
                rows.extend(self.file_rows(&query, 12));
                rows
            }
        }
    }

    fn run(&mut self, index: usize, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.rows(cx).into_iter().nth(index) else { return };
        cx.emit(PaletteEvent::Run(row.target, self.thinking.clone()));
    }

    /// Keys the palette handles before its search field sees them.
    fn key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let cmd = event.keystroke.modifiers.platform;
        let count = self.rows(cx).len();
        match key {
            "escape" => cx.emit(PaletteEvent::Close),
            "down" | "up" if count > 0 => {
                self.selected = if key == "down" { (self.selected + 1) % count } else { (self.selected + count - 1) % count };
                self.select_current = false;
                self.follow = true;
                cx.notify();
            }
            "1" | "2" | "3" | "4" if cmd && self.tab != Tab::Models => {
                self.tab = TABS[key.parse::<usize>().unwrap_or(1) - 1].0;
                self.selected = 0;
                cx.notify();
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn row(&self, n: usize, row: &Row, selected: bool, query: &str, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let marked = HighlightStyle { color: Some(p.accent), ..Default::default() };
        let title = StyledText::new(row.title.clone()).with_highlights(match_ranges(&row.title, query).into_iter().map(|r| (r, marked)));
        div()
            .id(SharedString::from(format!("palette-row-{n}")))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .py(px(7.))
            .rounded(px(7.))
            .cursor_pointer()
            .when(selected, |d| d.bg(p.sunken))
            .children(row.icon.as_ref().map(|path| {
                div().size(px(18.)).flex_shrink_0().flex().items_center().justify_center().when(!path.is_empty(), |d| {
                    d.child(svg().path(path.clone()).size(px(15.)).text_color(if path.starts_with("syncpi/") { p.muted } else { p.ink }))
                })
            }))
            .child(div().flex_shrink_0().text_size(sz(14.)).text_color(p.ink).child(title))
            .child(div().flex_1().min_w_0().truncate().text_size(sz(12.5)).text_color(p.muted).child(row.detail.clone()))
            .children(row.keys.as_deref().map(|k| kbd(&keymap::format(k), p)))
            .when(row.current, |d| d.child(div().text_color(p.accent).child("✓")))
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if this.selected != n {
                    this.selected = n;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| this.run(n, window, cx)))
    }
}

impl Render for PaletteView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows(cx);
        if self.select_current
            && let Some(at) = rows.iter().position(|r| r.current)
        {
            self.selected = at;
            self.select_current = false;
            self.follow = true;
        }
        self.selected = self.selected.min(rows.len().saturating_sub(1));
        let (tab, selected, follow) = (self.tab, self.selected, std::mem::take(&mut self.follow));
        let thinking = self.thinking.clone();
        let query = self.query(cx);
        let p = theme::palette(cx);
        let mut list = div().id("palette-list").track_scroll(&self.scroll).flex().flex_col().px(px(6.)).pb_2().max_h(px(420.)).overflow_y_scroll();
        let mut section = String::new();
        let mut child = 0;
        for (n, row) in rows.iter().enumerate() {
            if row.section != section {
                if child > 0 {
                    list = list.child(div().h(px(1.)).mx(px(-6.)).mt_1().bg(p.rule));
                    child += 1;
                }
                section = row.section.clone();
                list = list.child(section_label(section.clone(), &p));
                child += 1;
            }
            if follow && n == selected {
                self.scroll.scroll_to_item(child);
            }
            list = list.child(self.row(n, row, n == selected, &query, &p, cx));
            child += 1;
        }
        if rows.is_empty() {
            let loading = match tab {
                Tab::Models => self.models.borrow().is_none(),
                Tab::Files => self.files.borrow().is_none(),
                _ => false,
            };
            let empty = if loading {
                "Loading…"
            } else if tab == Tab::Files && self.files.borrow().as_ref().is_some_and(Vec::is_empty) {
                "No project files yet."
            } else {
                "Nothing matches."
            };
            list = list.child(div().px_3().py_4().text_size(sz(13.5)).text_color(p.muted).child(empty));
        }
        let bar = div().flex().gap_1().px(px(10.)).py_2().border_b_1().border_color(p.rule);
        let bar = if tab == Tab::Models {
            bar.child(div().text_size(sz(12.)).text_color(p.muted).mr_1().child("Thinking")).children(THINKING.iter().map(|level| {
                let level = *level;
                div()
                    .id(SharedString::from(format!("thinking-{level}")))
                    .px_2()
                    .py(px(3.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .font_family(theme::MONO)
                    .text_size(sz(11.5))
                    .when(level == thinking, |d| d.bg(p.sunken).text_color(p.ink))
                    .when(level != thinking, |d| d.text_color(p.muted))
                    .child(level)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.thinking = level.into();
                        cx.notify();
                    }))
            }))
        } else {
            bar.children(TABS.iter().enumerate().map(|(n, (t, label))| {
                let t = *t;
                div()
                    .id(SharedString::from(format!("palette-tab-{n}")))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px_2()
                    .py(px(3.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_size(sz(12.5))
                    .when(t == tab, |d| d.bg(p.sunken).text_color(p.ink))
                    .when(t != tab, |d| d.text_color(p.muted))
                    .child(label.to_string())
                    .child(kbd(&keymap::format(&format!("cmd-{}", n + 1)), &p))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.tab = t;
                        this.selected = 0;
                        cx.notify();
                    }))
            }))
        };
        let card = div()
            .w(px(600.))
            .mt(px(90.))
            .flex()
            .flex_col()
            .rounded(px(12.))
            .bg(p.raised)
            .border_1()
            .border_color(p.rule)
            .shadow_lg()
            .overflow_hidden()
            .capture_key_down(cx.listener(Self::key))
            .child(div().px_4().py_3().border_b_1().border_color(p.rule).child(Input::new(&self.input).appearance(false).px_0().text_size(sz(15.))))
            .child(bar)
            .child(list);
        scrim("palette", card, &p, cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Close)))
    }
}

/// A card over the app, dimmed around it; a click outside it calls `close`.
pub fn scrim(id: &'static str, card: impl IntoElement, p: &Palette, close: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> AnyElement {
    div()
        .id(SharedString::from(format!("{id}-scrim")))
        .occlude()
        .absolute()
        .inset_0()
        .bg(p.ink.opacity(0.12))
        .flex()
        .justify_center()
        .items_start()
        .on_click(close)
        // Clicks inside the card stay there.
        .child(div().id(SharedString::from(format!("{id}-card"))).on_click(|_, _, cx| cx.stop_propagation()).child(card))
        .into_any_element()
}

pub fn kbd(text: &str, p: &Palette) -> Div {
    div()
        .flex_shrink_0()
        .px(px(5.))
        .py(px(1.))
        .rounded(px(4.))
        .border_1()
        .border_color(p.rule)
        .bg(p.sunken)
        .font_family(theme::MONO)
        .text_size(sz(11.))
        .text_color(p.muted)
        .child(text.to_owned())
}

pub fn section_label(text: String, p: &Palette) -> Div {
    div().px(px(10.)).pt_3().pb(px(6.)).text_size(sz(12.5)).text_color(p.muted).child(text)
}


/// Subsequence match, scored so that earlier, contiguous and word-start matches rank first; None when it doesn't
/// match. The same scoring as score() in src/web/palette.ts.
pub fn score(text: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let q_len = q.len();
    let haystack: String = t.iter().collect();
    let needle: String = q.iter().collect();
    if let Some(byte) = haystack.find(&needle) {
        let at = haystack[..byte].chars().count();
        let inside_word = at > 0 && t[at - 1].is_alphanumeric();
        return Some(1000 - at as i32 - if inside_word { 50 } else { 0 });
    }
    let (mut i, mut points, mut last) = (0usize, 0i32, -2i64);
    for ch in q {
        let found = (i..t.len()).find(|&n| t[n] == ch)?;
        points += if found as i64 == last + 1 { 5 } else { 1 };
        if found == 0 || matches!(t[found - 1], ' ' | '/' | '.' | '_' | '-') {
            points += 3;
        }
        last = found as i64;
        i = found + 1;
    }
    // Letters scattered across the text match nearly anything; keep runs and word starts.
    (points >= q_len as i32 * 3).then_some(points)
}

/// Byte ranges of `text` that `query` matched, as score() matches them, for highlighting.
fn match_ranges(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    if query.is_empty() {
        return vec![];
    }
    let lower: Vec<(usize, char)> = text
        .char_indices()
        .map(|(i, c)| (i, c.to_lowercase().next().unwrap_or(c)))
        .collect();
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let range = |n: usize| {
        lower[n].0..lower[n].0 + text[lower[n].0..].chars().next().map_or(1, char::len_utf8)
    };
    // A contiguous match first, as score() prefers it.
    if let Some(start) = (0..lower.len())
        .find(|&s| s + q.len() <= lower.len() && (0..q.len()).all(|k| lower[s + k].1 == q[k]))
    {
        return (start..start + q.len()).map(range).collect();
    }
    let mut out = vec![];
    let mut i = 0;
    for ch in q {
        let Some(found) = (i..lower.len()).find(|&n| lower[n].1 == ch) else {
            return vec![];
        };
        out.push(range(found));
        i = found + 1;
    }
    out
}
