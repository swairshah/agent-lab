// The command palette, as in Delta and the web view (src/web/palette.ts): ⌘K searches everything, ⌘⇧P opens on
// commands, ⌘T on threads, ⌘P on files; ⌘1–⌘4 switch tabs. Arrows move, Enter runs, Esc closes.
use crate::keymap::{self, Command};
use crate::theme::{self, Palette};
use crate::{Desktop, eid, text};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::input::Input;

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    All,
    Threads,
    Commands,
    Files,
}
const TABS: [(Tab, &str); 4] = [
    (Tab::All, "All"),
    (Tab::Threads, "Threads"),
    (Tab::Commands, "Commands"),
    (Tab::Files, "Files"),
];

pub struct PaletteState {
    pub tab: Tab,
    pub selected: usize,
}

#[derive(Clone)]
pub enum Target {
    Command(String),
    Thread(String),
    File(String),
}

#[derive(Clone)]
pub struct Row {
    title: String,
    detail: String,
    keys: Option<String>,
    section: &'static str,
    pub target: Target,
}

/// Subsequence match, scored so that earlier, contiguous and word-start matches rank first; None when it doesn't
/// match. The same scoring as score() in src/web/palette.ts.
pub fn score(text: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let q: Vec<char> = query.to_lowercase().chars().collect();
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
    Some(points)
}

fn thread_title(session: &serde_json::Value) -> String {
    let title = text(session, "title");
    if title.is_empty() {
        text(session, "name")
    } else {
        title
    }
}

impl Desktop {
    pub(crate) fn open_palette(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = Some(PaletteState { tab, selected: 0 });
        self.palette_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        // Files come from the project; ask for the current list.
        if tab == Tab::Files || tab == Tab::All {
            self.request("files", "GET", "files", None);
        }
        cx.notify();
    }

    pub(crate) fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        // Back to writing.
        self.composer
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    fn command_rows(&self, commands: &[Command], query: &str, section: &'static str) -> Vec<Row> {
        let mut rows: Vec<(i32, Row)> = commands
            .iter()
            .filter_map(|c| {
                let s = score(&c.title, query).max(score(&c.group, query).map(|s| s - 10))?;
                Some((
                    s,
                    Row {
                        title: c.title.clone(),
                        detail: c.group.clone(),
                        keys: c.keys.clone(),
                        section,
                        target: Target::Command(c.id.clone()),
                    },
                ))
            })
            .collect();
        if !query.is_empty() {
            rows.sort_by(|a, b| b.0.cmp(&a.0));
        }
        rows.into_iter().map(|(_, r)| r).collect()
    }

    fn thread_rows(&self, query: &str, limit: usize) -> Vec<Row> {
        let mut rows: Vec<(i32, u64, Row)> = self
            .sessions
            .iter()
            .filter(|s| !s["archived"].as_bool().unwrap_or(false))
            .filter_map(|s| {
                let title = thread_title(s);
                let project = text(s, "name");
                let found = score(&title, query).max(score(&project, query).map(|s| s - 20))?;
                let recent = s["lastOpened"]
                    .as_u64()
                    .or(s["createdAt"].as_u64())
                    .unwrap_or_default();
                Some((
                    found,
                    recent,
                    Row {
                        title,
                        detail: project,
                        keys: None,
                        section: "Threads",
                        target: Target::Thread(text(s, "id")),
                    },
                ))
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        rows.into_iter().take(limit).map(|(_, _, r)| r).collect()
    }

    fn file_rows(&self, query: &str, limit: usize) -> Vec<Row> {
        let mut rows: Vec<(i32, Row)> = self
            .files
            .iter()
            .filter_map(|path| {
                let name = path.rsplit('/').next().unwrap_or(path);
                let s = score(path, query)?
                    + if score(name, query).unwrap_or(0) > 0 {
                        200
                    } else {
                        0
                    };
                let dir = path
                    .rsplit_once('/')
                    .map(|(d, _)| d.to_owned())
                    .unwrap_or_default();
                Some((
                    s,
                    Row {
                        title: name.to_owned(),
                        detail: dir,
                        keys: None,
                        section: "Files",
                        target: Target::File(path.clone()),
                    },
                ))
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.detail.len().cmp(&b.1.detail.len())));
        rows.into_iter().take(limit).map(|(_, r)| r).collect()
    }

    pub(crate) fn palette_rows(&self, cx: &App) -> Vec<Row> {
        let Some(state) = &self.palette else {
            return vec![];
        };
        let query = self.palette_input.read(cx).value().trim().to_owned();
        let commands = keymap::commands();
        match state.tab {
            Tab::Commands => self.command_rows(&commands, &query, "Commands"),
            Tab::Threads => self.thread_rows(&query, 60),
            Tab::Files => self.file_rows(&query, 60),
            Tab::All if query.is_empty() => {
                let quick: Vec<Command> = commands.iter().filter(|c| c.quick).cloned().collect();
                let mut rows = self.command_rows(&quick, "", "Quick actions");
                rows.extend(self.thread_rows("", 6).into_iter().map(|r| Row {
                    section: "Recent threads",
                    ..r
                }));
                rows.extend(
                    self.command_rows(
                        &commands
                            .iter()
                            .filter(|c| !c.quick)
                            .cloned()
                            .collect::<Vec<_>>(),
                        "",
                        "Commands",
                    ),
                );
                rows
            }
            Tab::All => {
                let mut rows = self.command_rows(&commands, &query, "Commands");
                rows.truncate(6);
                rows.extend(self.thread_rows(&query, 6));
                rows.extend(self.file_rows(&query, 10));
                rows
            }
        }
    }

    pub(crate) fn run_palette_row(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(row) = self.palette_rows(cx).into_iter().nth(index) else {
            return;
        };
        self.close_palette(window, cx);
        match row.target {
            Target::Command(id) => self.run_command(&id, window, cx),
            Target::Thread(id) => self.select(id, window, cx),
            Target::File(path) => self.open_file(path, cx),
        }
    }

    /// Keys the palette handles before its search field sees them.
    fn palette_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let cmd = event.keystroke.modifiers.platform;
        let count = self.palette_rows(cx).len();
        let Some(state) = self.palette.as_mut() else {
            return;
        };
        match key {
            "escape" => self.close_palette(window, cx),
            "down" | "up" if count > 0 => {
                state.selected = if key == "down" {
                    (state.selected + 1) % count
                } else {
                    (state.selected + count - 1) % count
                };
                cx.notify();
            }
            "1" | "2" | "3" | "4" if cmd => {
                state.tab = TABS[key.parse::<usize>().unwrap_or(1) - 1].0;
                state.selected = 0;
                if state.tab == Tab::Files {
                    self.request("files", "GET", "files", None);
                }
                cx.notify();
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    pub(crate) fn palette_overlay(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let state = self.palette.as_ref()?;
        let (tab, selected) = (state.tab, state.selected);
        let p = theme::palette(cx);
        let rows = self.palette_rows(cx);
        let mut list = div()
            .id("palette-list")
            .flex()
            .flex_col()
            .px(px(6.))
            .pb_2()
            .max_h(px(420.))
            .overflow_y_scroll();
        let mut section = "";
        for (n, row) in rows.iter().enumerate() {
            if row.section != section {
                section = row.section;
                list = list.child(section_label(section, &p));
            }
            list = list.child(self.palette_row(n, row, n == selected, &p, cx));
        }
        if rows.is_empty() {
            list = list.child(
                div()
                    .px_3()
                    .py_4()
                    .text_size(px(13.5))
                    .text_color(p.muted)
                    .child(if tab == Tab::Files && self.files.is_empty() {
                        "No project files yet."
                    } else {
                        "Nothing matches."
                    }),
            );
        }
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
            .capture_key_down(cx.listener(Self::palette_key))
            .child(
                div().px_4().py_3().border_b_1().border_color(p.rule).child(
                    Input::new(&self.palette_input)
                        .appearance(false)
                        .px_0()
                        .text_size(px(15.)),
                ),
            )
            .child(
                div()
                    .flex()
                    .gap_1()
                    .px(px(10.))
                    .py_2()
                    .border_b_1()
                    .border_color(p.rule)
                    .children(TABS.iter().enumerate().map(|(n, (t, label))| {
                        let t = *t;
                        div()
                            .id(eid(format!("palette-tab-{n}")))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .px_2()
                            .py(px(3.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .text_size(px(12.5))
                            .when(t == tab, |d| d.bg(p.sunken).text_color(p.ink))
                            .when(t != tab, |d| d.text_color(p.muted))
                            .child(label.to_string())
                            .child(kbd(&keymap::format(&format!("cmd-{}", n + 1)), &p))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(state) = this.palette.as_mut() {
                                    state.tab = t;
                                    state.selected = 0;
                                }
                                cx.notify();
                            }))
                    })),
            )
            .child(list);
        Some(
            div()
                .id("palette-scrim")
                .occlude()
                .absolute()
                .inset_0()
                .bg(p.ink.opacity(0.12))
                .flex()
                .justify_center()
                .items_start()
                .on_click(cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                // Clicks inside the card stay there.
                .child(
                    div()
                        .id("palette-card")
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(card),
                )
                .into_any_element(),
        )
    }

    fn palette_row(
        &self,
        n: usize,
        row: &Row,
        selected: bool,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        div()
            .id(eid(format!("palette-row-{n}")))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .py(px(7.))
            .rounded(px(7.))
            .cursor_pointer()
            .when(selected, |d| d.bg(p.sunken))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(14.))
                    .text_color(p.ink)
                    .child(row.title.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.5))
                    .text_color(p.muted)
                    .child(row.detail.clone()),
            )
            .children(row.keys.as_deref().map(|k| kbd(&keymap::format(k), p)))
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if let Some(state) = this.palette.as_mut() {
                    if state.selected != n {
                        state.selected = n;
                        cx.notify();
                    }
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| this.run_palette_row(n, window, cx)))
    }

    /// Every shortcut, grouped as in the palette (⌘/).
    pub(crate) fn keymap_sheet(&self, cx: &App) -> Div {
        let p = theme::palette(cx);
        let mut groups: Vec<(String, Vec<Command>)> = vec![];
        for c in keymap::commands().into_iter().filter(|c| c.keys.is_some()) {
            match groups.iter_mut().find(|(g, _)| *g == c.group) {
                Some((_, list)) => list.push(c),
                None => groups.push((c.group.clone(), vec![c])),
            }
        }
        groups.push(("Composer".into(), vec![]));
        let row = |title: String, keys: String| {
            div()
                .flex()
                .items_center()
                .justify_between()
                .py(px(3.))
                .text_size(px(13.5))
                .child(title)
                .child(kbd(&keys, &p))
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .children(groups.into_iter().map(|(group, list)| {
                let mut section = div()
                    .flex()
                    .flex_col()
                    .child(section_label_static(group, &p));
                if list.is_empty() {
                    section = section
                        .child(row("Send a message".into(), keymap::format("cmd-enter")))
                        .child(row("New line".into(), keymap::format("enter")));
                }
                section.children(list.into_iter().map(|c| {
                    row(
                        c.title,
                        keymap::format(c.keys.as_deref().unwrap_or_default()),
                    )
                }))
            }))
    }
}

fn kbd(text: &str, p: &Palette) -> Div {
    div()
        .flex_shrink_0()
        .px(px(5.))
        .py(px(1.))
        .rounded(px(4.))
        .border_1()
        .border_color(p.rule)
        .bg(p.sunken)
        .font_family(theme::MONO)
        .text_size(px(11.))
        .text_color(p.muted)
        .child(text.to_owned())
}

fn section_label(text: &'static str, p: &Palette) -> Div {
    section_label_static(text.to_owned(), p)
}

fn section_label_static(text: String, p: &Palette) -> Div {
    div()
        .px(px(10.))
        .pt_3()
        .pb(px(6.))
        .font_family(theme::MONO)
        .text_size(px(10.5))
        .text_color(p.muted)
        .child(text.to_uppercase())
}
