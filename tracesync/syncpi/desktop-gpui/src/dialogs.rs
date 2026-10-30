// The app's dialogs, native, as the Tauri app's shell has them (src/web/shell.html): a one-field question (rename a
// thread, its tags, a preview's address), joining a shared thread, confirming what can't be undone, the thread's
// branches, a share link, the keyboard shortcuts. One at a time, over the app; Esc or a click outside closes it.
use crate::Desktop;
use crate::keymap;
use crate::palette::{kbd, scrim, section_label};
use crate::theme::{self, Palette, palette, sz};
use gpui::{prelude::FluentBuilder, *};
use gpui_component::input::{Input, InputEvent, InputState};
use serde_json::{Value, json};

/// What a one-field question does with its answer.
#[derive(Clone)]
pub enum Ask {
    Rename(String),
    Tags(String),
    Preview,
}

/// What a confirmation does.
#[derive(Clone)]
pub enum Confirm {
    Compact,
    NewContext,
}

pub enum Dialog {
    Ask { title: String, label: String, hint: String, ok: String, input: Entity<InputState>, then: Ask },
    Join { url: Entity<InputState>, name: Entity<InputState>, error: Option<String>, busy: bool },
    Confirm { title: String, detail: String, ok: String, then: Confirm },
    /// The thread's branches (/tree): the server's list and the current one.
    Branches { list: Vec<Value>, current: i64 },
    Link { title: String, url: String, detail: String },
    Keymap,
}

impl Desktop {
    fn field(&mut self, value: &str, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder.to_owned()));
        input.update(cx, |state, cx| {
            state.set_value(value.to_owned(), window, cx);
            state.focus(window, cx);
        });
        // Enter answers.
        let subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.answer(window, cx);
            }
        });
        self._subscriptions.push(subscription);
        input
    }

    /// A one-field question.
    pub fn ask(&mut self, title: &str, label: &str, value: &str, ok: &str, hint: &str, then: Ask, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.field(value, "", window, cx);
        self.dialog = Some(Dialog::Ask { title: title.into(), label: label.into(), hint: hint.into(), ok: ok.into(), input, then });
        cx.notify();
    }

    pub fn join(&mut self, link: &str, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.prefs.name.clone().unwrap_or_else(|| self.catalog.identity.name.clone());
        let name = self.field(&name, "Your name", window, cx);
        let url = self.field(link, "https://…/s/…", window, cx);
        self.dialog = Some(Dialog::Join { url, name, error: None, busy: false });
        cx.notify();
    }

    pub fn confirm(&mut self, then: Confirm, cx: &mut Context<Self>) {
        let (title, detail, ok) = match then {
            Confirm::Compact => ("Summarize older messages?", "The agent's context keeps a summary of the older messages instead of all of them. Everyone's thread stays as it is.", "Summarize"),
            Confirm::NewContext => ("Start a new context?", "The agent starts again without the conversation so far, for everyone in the thread. The messages stay in the thread.", "Start over"),
        };
        self.dialog = Some(Dialog::Confirm { title: title.into(), detail: detail.into(), ok: ok.into(), then });
        cx.notify();
    }

    pub fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = None;
        self.focus_thread(window, cx);
        cx.notify();
    }

    /// The dialog's main button (or Enter in its field).
    pub fn answer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = &mut self.dialog else { return };
        match dialog {
            Dialog::Ask { input, then, .. } => {
                let value = input.read(cx).value().trim().to_owned();
                let then = then.clone();
                self.close_dialog(window, cx);
                match then {
                    Ask::Rename(id) if !value.is_empty() => self.decorate(&id, json!({ "title": value }), cx),
                    Ask::Tags(id) => {
                        let tags: Vec<String> = value.split(',').map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).collect();
                        self.decorate(&id, json!({ "tags": tags }), cx)
                    }
                    Ask::Preview if !value.is_empty() => {
                        if !(value.starts_with("http://") || value.starts_with("https://")) {
                            return self.toast("Use an http:// or https:// address.", true, cx);
                        }
                        self.prefs.preview = Some(value.clone());
                        self.save_prefs();
                        open_url(&value);
                    }
                    _ => {}
                }
            }
            Dialog::Join { url, name, error, busy } => {
                if *busy {
                    return;
                }
                let link = url.read(cx).value().trim().to_owned();
                let who = name.read(cx).value().trim().to_owned();
                if link.is_empty() {
                    *error = Some("Paste the link someone shared with you.".into());
                    return cx.notify();
                }
                *busy = true;
                *error = None;
                if !who.is_empty() {
                    self.prefs.name = Some(who.clone());
                    self.save_prefs();
                }
                let host = self.host.clone();
                cx.spawn_in(window, async move |this, cx| {
                    let joined = cx.background_executor().spawn(async move { host.post("/api/join", &json!({ "url": link, "name": who })).and_then(|v| Ok((v, host.catalog()?))) }).await;
                    let _ = this.update_in(cx, |this, window, cx| match joined {
                        Ok((value, catalog)) => {
                            this.catalog = catalog;
                            this.dialog = None;
                            if let Some(id) = value["id"].as_str() {
                                this.show(id, window, cx);
                            }
                        }
                        Err(e) => {
                            if let Some(Dialog::Join { error, busy, .. }) = &mut this.dialog {
                                *error = Some(e.to_string());
                                *busy = false;
                            }
                            cx.notify();
                        }
                    });
                })
                .detach();
                cx.notify();
            }
            Dialog::Confirm { then, .. } => {
                let message = match then {
                    Confirm::Compact => json!({ "type": "compact" }),
                    Confirm::NewContext => json!({ "type": "new" }),
                };
                self.close_dialog(window, cx);
                self.post_to_thread(message, cx);
            }
            Dialog::Link { url, .. } => {
                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                self.close_dialog(window, cx);
                self.toast("Link copied", false, cx);
            }
            Dialog::Branches { .. } | Dialog::Keymap => self.close_dialog(window, cx),
        }
    }

    pub fn dialog_view(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = palette(cx);
        let dialog = self.dialog.as_ref()?;
        let button = |id: &'static str, label: String, primary: bool| {
            div()
                .id(id)
                .px_3()
                .py(px(5.))
                .rounded(px(6.))
                .text_size(sz(13.))
                .cursor_pointer()
                .when(primary, |d| d.bg(p.accent).text_color(p.accent_ink))
                .when(!primary, |d| d.border_1().border_color(p.rule).text_color(p.ink_2).hover(|s| s.bg(p.sunken)))
                .child(label)
        };
        let field_box = |input: &Entity<InputState>| div().px_2().py(px(5.)).rounded(px(6.)).border_1().border_color(p.rule_strong).bg(p.paper).child(Input::new(input).appearance(false).px_0().py(px(1.)).text_size(sz(14.)));
        let label = |text: String| div().text_size(sz(12.5)).text_color(p.muted).child(text);
        let mut body = div().flex().flex_col().gap_3();
        let mut ok: Option<String> = None;
        let mut width = 440.;
        match dialog {
            Dialog::Ask { title, label: what, hint, ok: done, input, .. } => {
                body = body.child(heading(title, &p)).child(div().flex().flex_col().gap_1().child(label(what.clone())).child(field_box(input)));
                if !hint.is_empty() {
                    body = body.child(div().text_size(sz(12.5)).text_color(p.muted).child(hint.clone()));
                }
                ok = Some(done.clone());
            }
            Dialog::Join { url, name, error, busy } => {
                body = body
                    .child(heading("Join a shared thread", &p))
                    .child(div().flex().flex_col().gap_1().child(label("Share link".into())).child(field_box(url)))
                    .child(div().flex().flex_col().gap_1().child(label("Your name".into())).child(field_box(name)));
                if let Some(login) = &self.catalog.login {
                    let url = login.url.clone();
                    body = body.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_1()
                            .text_size(sz(12.5))
                            .text_color(p.ink_2)
                            .child("Sign in to join:")
                            .child(div().id("join-login").text_color(p.accent).cursor_pointer().child("open the sign-in page").on_click(move |_, _, _| open_url(&url)))
                            .child(format!("and check it shows {}.", login.check)),
                    );
                }
                if let Some(error) = error {
                    body = body.child(div().text_size(sz(12.5)).text_color(p.removed).child(error.clone()));
                }
                ok = Some(if *busy { "Joining…".into() } else { "Join".into() });
            }
            Dialog::Confirm { title, detail, ok: done, .. } => {
                body = body.child(heading(title, &p)).child(div().text_size(sz(13.5)).text_color(p.ink_2).child(detail.clone()));
                ok = Some(done.clone());
            }
            Dialog::Link { title, url, detail } => {
                body = body
                    .child(heading(title, &p))
                    .child(div().px_2().py(px(6.)).rounded(px(6.)).bg(p.sunken).font_family(theme::MONO).text_size(sz(12.5)).text_color(p.ink).child(url.clone()))
                    .child(div().text_size(sz(12.5)).text_color(p.muted).child(detail.clone()));
                ok = Some("Copy link".into());
            }
            Dialog::Branches { list, current } => {
                body = body.child(heading("Branches", &p));
                if list.is_empty() {
                    body = body.child(div().text_size(sz(13.)).text_color(p.muted).child("This thread has one branch. Branch it from a message with /tree <n> in the composer."));
                }
                for branch in list {
                    let id = branch["id"].as_i64().unwrap_or(0);
                    let here = id == *current;
                    let title = branch["label"].as_str().or(branch["title"].as_str()).map(str::to_owned).unwrap_or_else(|| format!("Branch {id}"));
                    let detail = branch["by"].as_str().map(|by| format!("by {by}")).unwrap_or_default();
                    body = body.child(
                        div()
                            .id(SharedString::from(format!("branch-{id}")))
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_2()
                            .py(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|s| s.bg(p.sunken))
                            .child(div().flex_1().min_w_0().child(div().text_size(sz(13.5)).child(title)).child(div().truncate().text_size(sz(12.)).text_color(p.muted).child(detail)))
                            .when(here, |d| d.child(div().text_color(p.accent).child("✓")))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.post_to_thread(json!({ "type": "switchBranch", "id": id }), cx);
                                this.close_dialog(window, cx);
                            })),
                    );
                }
            }
            Dialog::Keymap => {
                width = 520.;
                body = body.child(heading("Keyboard shortcuts", &p)).child(keymap_sheet(&p));
            }
        }
        let has_ok = ok.is_some();
        let buttons = div()
            .flex()
            .justify_end()
            .gap_2()
            .child(button("dialog-cancel", if has_ok { "Cancel".into() } else { "Close".into() }, !has_ok).on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))))
            .when_some(ok, |d, ok| d.child(button("dialog-ok", ok, true).on_click(cx.listener(|this, _, window, cx| this.answer(window, cx)))));
        let card = div()
            .w(px(width))
            .mt(px(110.))
            .p_5()
            .flex()
            .flex_col()
            .gap_4()
            .rounded(px(12.))
            .bg(p.raised)
            .border_1()
            .border_color(p.rule)
            .shadow_lg()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    this.close_dialog(window, cx);
                    cx.stop_propagation();
                }
            }))
            // Only the body scrolls; the buttons stay in view.
            .child(div().id("dialog-body").max_h(px(520.)).overflow_y_scroll().child(body))
            .child(buttons);
        Some(scrim("dialog", card, &p, cx.listener(|this, _, window, cx| this.close_dialog(window, cx))))
    }
}

fn heading(text: &str, p: &Palette) -> Div {
    div().text_size(sz(16.)).font_weight(FontWeight::SEMIBOLD).text_color(p.ink).child(text.to_owned())
}

/// Every shortcut, grouped as in the palette (⌘/).
fn keymap_sheet(p: &Palette) -> Div {
    let mut groups: Vec<(String, Vec<keymap::Command>)> = vec![];
    for c in keymap::commands().into_iter().filter(|c| c.keys.is_some()) {
        match groups.iter_mut().find(|(g, _)| *g == c.group) {
            Some((_, list)) => list.push(c),
            None => groups.push((c.group.clone(), vec![c])),
        }
    }
    let row = |title: String, keys: String| div().flex().items_center().justify_between().py(px(3.)).text_size(sz(13.5)).child(title).child(kbd(&keys, p));
    let composer = div()
        .flex()
        .flex_col()
        .child(section_label("Composer".into(), p))
        .child(row("Send a message".into(), keymap::format("cmd-enter")))
        .child(row("New line".into(), keymap::format("enter")));
    div()
        .flex()
        .flex_col()
        .gap_1()
        .children(groups.into_iter().map(|(group, list)| {
            div().flex().flex_col().child(section_label(group, p)).children(list.into_iter().map(|c| row(c.title, keymap::format(c.keys.as_deref().unwrap_or_default()))))
        }))
        .child(composer)
}

/// Opens an address in the browser.
pub fn open_url(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}
