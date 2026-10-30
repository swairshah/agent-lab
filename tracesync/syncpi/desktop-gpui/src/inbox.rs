// The inbox (⇧⌘J), native, as the web view's (src/web/inbox.ts): messages that mention you and drafts you're tagged
// in, across every thread (the host follows shared threads for this: GET /api/inbox). Unread (⌘1) or all (⌘2);
// arrows move, Enter opens the message in its thread, or joins the draft. What's been read is kept with the app's
// preferences; a mention that arrives while the app is open shows a note.
use crate::Desktop;
use crate::palette::{kbd, scrim};
use crate::theme::{initials, palette, person_color, sz};
use gpui::{prelude::FluentBuilder, *};
use serde_json::Value;

pub struct InboxState {
    unread: bool,
    selected: usize,
    scroll: ScrollHandle,
}

/// One item's id, as the web view names it (what's been read is kept by it).
pub fn item_id(item: &Value) -> String {
    let comment = item["comment"].as_u64().map(|n| n.to_string()).unwrap_or_else(|| "m".into());
    format!("{}/{}/{comment}", item["thread"].as_str().unwrap_or_default(), item["key"].as_str().unwrap_or_default())
}

impl Desktop {
    /// Reads the inbox from the host (every few seconds); new mentions since the app opened get a note.
    pub fn refresh_inbox(&mut self, cx: &mut Context<Self>) {
        let host = self.host.clone();
        cx.spawn(async move |this, cx| {
            let read = cx.background_executor().spawn(async move { host.get("/api/inbox") }).await;
            let Ok(value) = read else { return };
            let items = value["items"].as_array().cloned().unwrap_or_default();
            let _ = this.update(cx, |this, cx| {
                let started = this.started_ms;
                let fresh: Vec<Value> = items
                    .iter()
                    .filter(|i| !this.prefs.inbox_seen.contains(&item_id(i)) && !this.prefs.inbox_read.contains(&item_id(i)) && i["at"].as_f64().unwrap_or(0.) >= started - 60_000.)
                    .cloned()
                    .collect();
                let unseen = items.iter().any(|i| !this.prefs.inbox_seen.contains(&item_id(i)));
                if unseen {
                    for i in &items {
                        let id = item_id(i);
                        if !this.prefs.inbox_seen.contains(&id) {
                            this.prefs.inbox_seen.push(id);
                        }
                    }
                    let keep = this.prefs.inbox_seen.len().saturating_sub(3000);
                    this.prefs.inbox_seen.drain(..keep);
                    this.save_prefs();
                }
                if let Some(first) = fresh.first() {
                    let what = if first["draft"].is_string() { "tagged you in a draft" } else { "mentioned you" };
                    this.toast(format!("{} {what} in {}", first["author"].as_str().unwrap_or("Someone"), first["threadTitle"].as_str().unwrap_or("a thread")), false, cx);
                }
                if items != this.mentions {
                    this.mentions = items;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn unread_mentions(&self) -> Vec<Value> {
        self.mentions.iter().filter(|i| !self.prefs.inbox_read.contains(&item_id(i))).cloned().collect()
    }

    pub fn toggle_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inbox_open.take().is_some() {
            self.focus_thread(window, cx);
        } else {
            // Unread first when there's anything unread (or the items haven't arrived yet), as the web view does.
            let unread = self.mentions.is_empty() || !self.unread_mentions().is_empty();
            self.inbox_open = Some(InboxState { unread, selected: 0, scroll: ScrollHandle::new() });
            self.refresh_inbox(cx);
            window.focus(&self.inbox_focus);
        }
        cx.notify();
    }

    fn inbox_rows(&self) -> Vec<Value> {
        match &self.inbox_open {
            Some(state) if state.unread => self.unread_mentions(),
            _ => self.mentions.clone(),
        }
    }

    fn open_mention(&mut self, item: Value, window: &mut Window, cx: &mut Context<Self>) {
        let id = item_id(&item);
        if !self.prefs.inbox_read.contains(&id) {
            self.prefs.inbox_read.push(id);
            let keep = self.prefs.inbox_read.len().saturating_sub(3000);
            self.prefs.inbox_read.drain(..keep);
            self.save_prefs();
        }
        self.inbox_open = None;
        let thread = item["thread"].as_str().unwrap_or_default().to_owned();
        self.show(&thread, window, cx);
        // Where it was said, once the thread is drawn; a tag in a draft joins the draft.
        self.reveal = Some((thread, item["key"].as_str().unwrap_or_default().to_owned(), item["draft"].as_str().map(str::to_owned)));
        cx.notify();
    }

    fn inbox_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let rows = self.inbox_rows();
        let Some(state) = &mut self.inbox_open else { return };
        let key = event.keystroke.key.as_str();
        let cmd = event.keystroke.modifiers.platform;
        match key {
            "escape" => {
                self.inbox_open = None;
                self.focus_thread(window, cx);
            }
            "1" | "2" if cmd => {
                state.unread = key == "1";
                state.selected = 0;
            }
            "down" | "up" if !rows.is_empty() => {
                state.selected = if key == "down" { (state.selected + 1) % rows.len() } else { (state.selected + rows.len() - 1) % rows.len() };
                state.scroll.scroll_to_item(state.selected);
            }
            "enter" => {
                if let Some(item) = rows.get(state.selected).cloned() {
                    self.open_mention(item, window, cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    pub fn inbox_view(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = palette(cx);
        let rows = self.inbox_rows();
        let unread_count = self.unread_mentions().len();
        let state = self.inbox_open.as_mut()?;
        state.selected = state.selected.min(rows.len().saturating_sub(1));
        let (unread, selected) = (state.unread, state.selected);
        let read: Vec<String> = self.prefs.inbox_read.clone();
        let tab = |id: &'static str, label: String, keys: &str, on: bool| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(6.))
                .px_2()
                .py(px(3.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_size(sz(12.5))
                .when(on, |d| d.bg(p.sunken).text_color(p.ink))
                .when(!on, |d| d.text_color(p.muted))
                .child(label)
                .child(kbd(keys, &p))
        };
        let mut list = div().id("inbox-list").track_scroll(&state.scroll).flex().flex_col().p(px(6.)).max_h(px(460.)).overflow_y_scroll();
        if rows.is_empty() {
            list = list.child(div().px_3().py_4().text_size(sz(13.5)).text_color(p.muted).child(if unread { "No unread notifications" } else { "Nobody has mentioned you yet" }));
        }
        for (n, item) in rows.iter().enumerate() {
            let author = item["author"].as_str().unwrap_or("Someone").to_owned();
            let color = person_color(&author, p.dark);
            let what = if item["draft"].is_string() {
                "tagged you in a draft"
            } else if item["comment"].is_number() {
                "mentioned you in a comment"
            } else {
                "mentioned you"
            };
            let is_unread = !read.contains(&item_id(item));
            let opening = item.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("inbox-{n}")))
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .when(n == selected, |d| d.bg(p.sunken))
                    .child(div().flex_none().size(px(26.)).rounded_full().bg(color.opacity(0.18)).text_color(color).text_size(sz(10.5)).font_weight(FontWeight::SEMIBOLD).flex().items_center().justify_center().child(initials(&author)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_1()
                                    .text_size(sz(13.))
                                    .text_color(p.ink_2)
                                    .child(div().font_weight(FontWeight::SEMIBOLD).text_color(p.ink).child(author.clone()))
                                    .child(what)
                                    .child("in")
                                    .child(div().text_color(p.ink).child(item["threadTitle"].as_str().unwrap_or("a thread").to_owned()))
                                    .children(item["at"].as_f64().map(|at| div().text_color(p.faint).child(ago(at)))),
                            )
                            .child(div().mt(px(2.)).text_size(sz(13.5)).text_color(p.ink).line_clamp(2).child(item["text"].as_str().unwrap_or_default().to_owned())),
                    )
                    .when(is_unread, |d| d.child(div().mt(px(6.)).size(px(7.)).rounded_full().bg(p.accent)))
                    .on_click(cx.listener(move |this, _, window, cx| this.open_mention(opening.clone(), window, cx))),
            );
        }
        let card = div()
            .w(px(560.))
            .mt(px(90.))
            .flex()
            .flex_col()
            .rounded(px(12.))
            .bg(p.raised)
            .border_1()
            .border_color(p.rule)
            .shadow_lg()
            .overflow_hidden()
            .track_focus(&self.inbox_focus)
            .capture_key_down(cx.listener(Self::inbox_key))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px(px(14.))
                    .py(px(10.))
                    .border_b_1()
                    .border_color(p.rule)
                    .child(div().mr_2().text_size(sz(15.)).font_weight(FontWeight::SEMIBOLD).child("Inbox"))
                    .child(tab("inbox-unread", format!("Unread ({unread_count})"), "⌘1", unread).on_click(cx.listener(|this, _, _, cx| {
                        if let Some(state) = &mut this.inbox_open {
                            state.unread = true;
                            state.selected = 0;
                        }
                        cx.notify();
                    })))
                    .child(tab("inbox-all", "All".into(), "⌘2", !unread).on_click(cx.listener(|this, _, _, cx| {
                        if let Some(state) = &mut this.inbox_open {
                            state.unread = false;
                            state.selected = 0;
                        }
                        cx.notify();
                    })))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("inbox-read-all")
                            .px_2()
                            .py(px(3.))
                            .rounded(px(6.))
                            .text_size(sz(12.5))
                            .text_color(p.muted)
                            .cursor_pointer()
                            .hover(|s| s.bg(p.sunken).text_color(p.ink))
                            .child("Mark all read")
                            .on_click(cx.listener(|this, _, _, cx| {
                                for i in this.mentions.clone() {
                                    let id = item_id(&i);
                                    if !this.prefs.inbox_read.contains(&id) {
                                        this.prefs.inbox_read.push(id);
                                    }
                                }
                                this.save_prefs();
                                cx.notify();
                            })),
                    ),
            )
            .child(list);
        Some(scrim(
            "inbox",
            card,
            &p,
            cx.listener(|this, _, window, cx| {
                this.inbox_open = None;
                this.focus_thread(window, cx);
                cx.notify();
            }),
        ))
    }
}

/// "3 min ago", from a time in milliseconds.
pub fn ago(at_ms: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.);
    let s = ((now - at_ms) / 1000.).max(0.) as u64;
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", s / 60),
        3600..86400 => format!("{} h ago", s / 3600),
        _ => format!("{} d ago", s / 86400),
    }
}
