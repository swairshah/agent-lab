// Settings (⌘,), native, with the web view's sections (src/web/settings.ts): General (your name, appearance, where
// your requests run, the model, context), People (roles, removing, invites), Branches, Environment (the setup
// agent's work), Session. What it shows is the host's snapshot of the thread (GET …/native), read again while it's
// open; what it changes goes to the thread's server as the web view sends it.
use crate::Desktop;
use crate::palette::{THINKING, scrim};
use crate::theme::{self, Palette, initials, palette, person_color, sz};
use gpui::{prelude::FluentBuilder, *};
use gpui_component::input::{Input, InputEvent, InputState};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq)]
pub enum Section {
    General,
    People,
    Branches,
    Environment,
    Session,
}

const SECTIONS: [(Section, &str); 5] = [
    (Section::General, "General"),
    (Section::People, "People"),
    (Section::Branches, "Branches"),
    (Section::Environment, "Environment"),
    (Section::Session, "Session"),
];
const ROLES: [&str; 3] = ["admin", "editor", "viewer"];

pub struct SettingsState {
    pub section: Section,
    /// The thread as the host has it (members, invites, branches, the environment, the model).
    pub snapshot: Value,
    name: Entity<InputState>,
    model: Entity<InputState>,
    email: Entity<InputState>,
    thinking: Option<String>,
    role: &'static str,
    days: u32,
    /// The fields were filled from the snapshot once (later snapshots don't overwrite what's being typed).
    filled: bool,
}

impl Desktop {
    pub fn open_settings(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        if self.active.is_none() {
            return self.toast("Open a thread first.", true, cx);
        }
        let field = |placeholder: &str, window: &mut Window, cx: &mut Context<Self>| cx.new(|cx| InputState::new(window, cx).placeholder(placeholder.to_owned()));
        let name = field("Your name", window, cx);
        let model = field("anthropic/claude-opus-5-5", window, cx);
        let email = field("Email, or leave empty for a link", window, cx);
        for (input, what) in [(&name, 0), (&model, 1), (&email, 2)] {
            let subscription = cx.subscribe_in(input, window, move |this, _, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    match what {
                        0 => this.settings_rename(cx),
                        1 => this.settings_model(cx),
                        _ => this.settings_invite(window, cx),
                    }
                }
            });
            self._subscriptions.push(subscription);
        }
        self.settings = Some(SettingsState { section, snapshot: Value::Null, name, model, email, thinking: None, role: "editor", days: 7, filled: false });
        self.refresh_settings(cx);
        if section == Section::People {
            self.post_to_thread(json!({ "type": "invites" }), cx);
        }
        cx.notify();
    }

    /// Reads the thread's snapshot again (on opening, then every second while Settings is open).
    pub fn refresh_settings(&mut self, cx: &mut Context<Self>) {
        let (Some(id), Some(_)) = (self.active.clone(), &self.settings) else { return };
        let host = self.host.clone();
        cx.spawn(async move |this, cx| {
            let read = cx.background_executor().spawn(async move { host.get(&format!("/api/sessions/{id}/native")) }).await;
            let _ = this.update(cx, |this, cx| {
                if let (Ok(snapshot), Some(settings)) = (read, &mut this.settings)
                    && snapshot != settings.snapshot
                {
                    settings.snapshot = snapshot;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn settings_rename(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = &self.settings else { return };
        let name = settings.name.read(cx).value().trim().to_owned();
        if !name.is_empty() && name != settings.snapshot["me"]["name"].as_str().unwrap_or_default() {
            self.post_to_thread(json!({ "type": "rename", "name": name }), cx);
            self.toast("Name saved", false, cx);
        }
    }

    fn settings_model(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = &self.settings else { return };
        let model = settings.model.read(cx).value().trim().to_owned();
        let thinking = settings.thinking.clone().or_else(|| settings.snapshot["main"]["thinkingLevel"].as_str().map(str::to_owned)).unwrap_or_else(|| "medium".into());
        if !model.is_empty() {
            self.post_to_thread(json!({ "type": "configure", "model": model, "thinkingLevel": thinking }), cx);
            self.toast("Model changed", false, cx);
        }
    }

    fn settings_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(settings) = &self.settings else { return };
        let email = settings.email.read(cx).value().trim().to_owned();
        let mut invite = json!({ "type": "invite", "role": settings.role });
        if email.is_empty() {
            invite["expiresInDays"] = json!(settings.days);
        } else {
            invite["email"] = json!(email);
        }
        settings.email.update(cx, |state, cx| state.set_value("", window, cx));
        self.post_to_thread(invite, cx);
        self.post_to_thread(json!({ "type": "invites" }), cx);
        self.toast(if email.is_empty() { "Link made: it's in Active invites" } else { "Invite sent" }, false, cx);
    }

    pub fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        self.focus_thread(window, cx);
        cx.notify();
    }

    pub fn settings_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = palette(cx);
        let dark = self.is_dark(window);
        let theme_pref = self.prefs.theme.clone().unwrap_or_else(|| "system".into());
        let where_vm = self.prefs.where_vm.unwrap_or(false);
        let thread = self.active.as_deref().and_then(|id| self.thread(id)).cloned();
        let settings = self.settings.as_mut()?;
        let snap = settings.snapshot.clone();
        let me = snap["me"].clone();
        let role = me["role"].as_str().unwrap_or("viewer").to_owned();
        let admin = role == "admin";
        // The fields start from what the thread has.
        if !settings.filled && !snap.is_null() {
            settings.filled = true;
            let (name, model) = (me["name"].as_str().unwrap_or_default().to_owned(), snap["main"]["model"].as_str().unwrap_or_default().to_owned());
            settings.name.update(cx, |state, cx| state.set_value(name, window, cx));
            settings.model.update(cx, |state, cx| state.set_value(model, window, cx));
        }
        let section = settings.section;
        let thinking = settings.thinking.clone().or_else(|| snap["main"]["thinkingLevel"].as_str().map(str::to_owned)).unwrap_or_else(|| "medium".into());
        let (invite_role, days) = (settings.role, settings.days);
        let (name_input, model_input, email_input) = (settings.name.clone(), settings.model.clone(), settings.email.clone());

        let nav = div().w(px(170.)).flex_none().flex().flex_col().gap(px(2.)).p_3().border_r_1().border_color(p.rule).bg(p.sunken).children(SECTIONS.iter().map(|(s, label)| {
            let s = *s;
            div()
                .id(SharedString::from(format!("settings-{label}")))
                .px_2()
                .py(px(5.))
                .rounded(px(6.))
                .text_size(sz(13.5))
                .cursor_pointer()
                .when(s == section, |d| d.bg(p.rule).text_color(p.ink))
                .when(s != section, |d| d.text_color(p.ink_2).hover(|h| h.bg(p.rule.opacity(0.6))))
                .child(label.to_string())
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(settings) = &mut this.settings {
                        settings.section = s;
                    }
                    if s == Section::People {
                        this.post_to_thread(json!({ "type": "invites" }), cx);
                    }
                    cx.notify();
                }))
        }));

        let mut body = div().flex().flex_col().gap_4();
        match section {
            Section::General => {
                body = body.child(heading("General", &p)).child(field(
                    "Your name",
                    div().flex().gap_2().child(input_box(&name_input, &p).flex_1()).child(button("rename-save", "Save", false, &p).on_click(cx.listener(|this, _, _, cx| this.settings_rename(cx)))),
                    &p,
                ));
                let themes = [("system", "Match the system"), ("light", "Light"), ("dark", "Dark")];
                body = body.child(field(
                    "Appearance",
                    segments("theme", &themes, &theme_pref, &p, cx, |this, value, window, cx| {
                        this.prefs.theme = (value != "system").then(|| value.to_owned());
                        this.save_prefs();
                        this.apply_theme(window, cx);
                    }),
                    &p,
                ));
                let _ = dark;
                body = body.child(field(
                    "Your requests run on",
                    segments("where", &[("device", "This Mac"), ("vm", "The session VM")], if where_vm { "vm" } else { "device" }, &p, cx, |this, value, _, cx| {
                        this.prefs.where_vm = Some(value == "vm");
                        this.save_prefs();
                        crate::thread::set_where_vm(value == "vm");
                        cx.notify();
                    }),
                    &p,
                ));
                if admin {
                    let levels: Vec<(&str, &str)> = THINKING.iter().map(|t| (*t, *t)).collect();
                    body = body.child(field(
                        "Model",
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(div().flex().gap_2().child(input_box(&model_input, &p).flex_1()).child(button("model-use", "Use", false, &p).on_click(cx.listener(|this, _, _, cx| this.settings_model(cx)))))
                            .child(div().flex().items_center().gap_2().child(div().text_size(sz(12.5)).text_color(p.muted).child("Thinking")).child(segments("thinking", &levels, &thinking, &p, cx, |this, value, _, cx| {
                                if let Some(settings) = &mut this.settings {
                                    settings.thinking = Some(value.to_owned());
                                }
                                cx.notify();
                            })))
                            .child(div().text_size(sz(12.5)).text_color(p.muted).child("Or pick one from the list with ⌘⌥/.")),
                        &p,
                    ));
                }
                if role != "viewer" {
                    body = body.child(field(
                        "Context",
                        div()
                            .flex()
                            .gap_2()
                            .child(button("compact", "Summarize older messages", false, &p).on_click(cx.listener(|this, _, _, cx| {
                                this.settings = None;
                                this.confirm(crate::dialogs::Confirm::Compact, cx);
                            })))
                            .when(admin, |d| {
                                d.child(button("reset", "Start a new context", false, &p).on_click(cx.listener(|this, _, _, cx| {
                                    this.settings = None;
                                    this.confirm(crate::dialogs::Confirm::NewContext, cx);
                                })))
                            }),
                        &p,
                    ));
                }
            }
            Section::People => {
                body = body.child(heading("People", &p));
                let online: Vec<String> = snap["online"].as_array().into_iter().flatten().filter_map(|o| o["memberId"].as_str().map(str::to_owned)).collect();
                let mut people = div().flex().flex_col();
                for m in snap["members"].as_array().into_iter().flatten() {
                    let id = m["id"].as_str().unwrap_or_default().to_owned();
                    let name = m["name"].as_str().unwrap_or("someone").to_owned();
                    let creator = m["creator"].as_bool().unwrap_or(false);
                    let their_role = m["role"].as_str().unwrap_or("viewer").to_owned();
                    let color = person_color(&name, p.dark);
                    let here = online.contains(&id);
                    let mut row = div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .py(px(7.))
                        .border_b_1()
                        .border_color(p.rule)
                        .child(
                            div()
                                .relative()
                                .size(px(28.))
                                .rounded_full()
                                .bg(color.opacity(0.18))
                                .text_color(color)
                                .text_size(sz(11.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(initials(&name))
                                .when(here, |d| d.child(div().absolute().right(px(-1.)).bottom(px(-1.)).size(px(9.)).rounded_full().bg(p.ok).border_2().border_color(p.raised))),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(div().text_size(sz(14.)).child(format!("{name}{}", if Some(id.as_str()) == me["id"].as_str() { "  (you)" } else { "" })))
                                .children(m["email"].as_str().map(|e| div().text_size(sz(12.)).text_color(p.muted).child(e.to_owned()))),
                        );
                    if admin && !creator {
                        let roles: Vec<(&str, &str)> = ROLES.iter().map(|r| (*r, *r)).collect();
                        let (member, removing) = (id.clone(), id.clone());
                        row = row
                            .child(segments(&format!("role-{id}"), &roles, &their_role, &p, cx, move |this, value, _, cx| {
                                this.post_to_thread(json!({ "type": "setRole", "memberId": member, "role": value }), cx);
                            }))
                            .child(link(&format!("remove-{id}"), "Remove", p.removed).on_click(cx.listener(move |this, _, _, cx| {
                                this.post_to_thread(json!({ "type": "remove", "memberId": removing }), cx);
                            })));
                    } else {
                        row = row.child(div().text_size(sz(12.5)).text_color(p.muted).child(if creator { "admin · created the session".to_owned() } else { their_role }));
                    }
                    people = people.child(row);
                }
                body = body.child(people);
                if admin {
                    let roles = [("editor", "Editor"), ("viewer", "Viewer"), ("admin", "Admin")];
                    let expiry = [("7", "7 days"), ("1", "1 day"), ("30", "30 days"), ("0", "Never")];
                    body = body
                        .child(subheading("Invite", &p))
                        .child(div().flex().gap_2().child(input_box(&email_input, &p).flex_1()).child(button("invite", "Invite", true, &p).on_click(cx.listener(|this, _, window, cx| this.settings_invite(window, cx)))))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_3()
                                .child(segments("invite-role", &roles, invite_role, &p, cx, |this, value, _, cx| {
                                    if let Some(settings) = &mut this.settings {
                                        settings.role = ROLES.iter().find(|r| **r == value).copied().unwrap_or("editor");
                                    }
                                    cx.notify();
                                }))
                                .child(segments("invite-days", &expiry, &days.to_string(), &p, cx, |this, value, _, cx| {
                                    if let Some(settings) = &mut this.settings {
                                        settings.days = value.parse().unwrap_or(7);
                                    }
                                    cx.notify();
                                })),
                        )
                        .child(subheading("Active invites", &p));
                    let invites = snap["invites"].as_array().cloned().unwrap_or_default();
                    if invites.is_empty() {
                        body = body.child(div().text_size(sz(13.)).text_color(p.muted).child("No active invites"));
                    }
                    for i in invites {
                        let code = i["code"].as_str().unwrap_or_default().to_owned();
                        let revoking = code.clone();
                        let until = i["expiresAt"].as_f64().map(|t| format!(" · expires in {}", days_from_now(t))).unwrap_or_default();
                        body = body.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_3()
                                .py(px(6.))
                                .border_b_1()
                                .border_color(p.rule)
                                .child(
                                    div()
                                        .flex_1()
                                        .child(div().text_size(sz(13.5)).child(i["email"].as_str().unwrap_or("Link").to_owned()))
                                        .child(div().text_size(sz(12.)).text_color(p.muted).child(format!("{} · used {}{until}", i["role"].as_str().unwrap_or("editor"), i["uses"].as_u64().unwrap_or(0)))),
                                )
                                .child(link(&format!("revoke-{code}"), "Revoke", p.removed).on_click(cx.listener(move |this, _, _, cx| {
                                    this.post_to_thread(json!({ "type": "revoke", "code": revoking }), cx);
                                    this.post_to_thread(json!({ "type": "invites" }), cx);
                                }))),
                        );
                    }
                }
            }
            Section::Branches => {
                body = body.child(heading("Branches", &p)).child(div().text_size(sz(13.)).text_color(p.muted).child("Everyone follows the branch you pick. To make one, use Edit & fork on a message, or /tree <n>."));
                let current = snap["currentBranch"].as_i64().unwrap_or(0);
                let branches = snap["branches"].as_array().cloned().unwrap_or_default();
                if branches.is_empty() {
                    body = body.child(div().text_size(sz(13.)).text_color(p.muted).child("One branch so far."));
                }
                for b in branches {
                    let id = b["id"].as_i64().unwrap_or(0);
                    body = body.child(
                        div()
                            .id(SharedString::from(format!("settings-branch-{id}")))
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_2()
                            .py(px(6.))
                            .rounded(px(6.))
                            .when(admin, |d| d.cursor_pointer().hover(|s| s.bg(p.sunken)))
                            .child(div().size(px(8.)).rounded_full().when(id == current, |d| d.bg(p.accent)).when(id != current, |d| d.border_1().border_color(p.rule_strong)))
                            .child(div().flex_1().text_size(sz(13.5)).child(b["label"].as_str().unwrap_or("Branch").to_owned()))
                            .child(div().text_size(sz(12.)).text_color(p.muted).child(b["by"].as_str().unwrap_or_default().to_owned()))
                            .when(admin, |d| {
                                d.on_click(cx.listener(move |this, _, _, cx| {
                                    this.post_to_thread(json!({ "type": "switchBranch", "id": id }), cx);
                                }))
                            }),
                    );
                }
            }
            Section::Environment => {
                let env = &snap["env"];
                let status = match env["status"].as_str().unwrap_or("pending") {
                    "running" => "Setting up",
                    "ready" => "Ready",
                    "failed" => "Setup failed",
                    _ => "Waiting to start",
                };
                body = body
                    .child(heading("Environment", &p))
                    .child(div().text_size(sz(14.)).text_color(if status == "Setup failed" { p.removed } else { p.ink }).child(status))
                    .children(env["error"].as_str().or(env["activity"].as_str()).map(|d| div().font_family(theme::MONO).text_size(sz(12.)).text_color(p.muted).child(d.to_owned())))
                    .children(env["summary"].as_str().map(|s| div().p_3().rounded(px(6.)).bg(p.code).font_family(theme::MONO).text_size(sz(12.)).whitespace_normal().child(s.to_owned())))
                    .child(div().child(button("env-open", "View the setup agent's thread", false, &p).on_click(cx.listener(|this, _, window, cx| {
                        this.settings = None;
                        this.run(&crate::keymap::RunCommand { id: "agent.setup".into() }, window, cx);
                    }))));
            }
            Section::Session => {
                let mut rows: Vec<(&str, String)> = vec![];
                if let Some(t) = &thread {
                    rows.push(("Project", t.dir.clone()));
                    rows.push(("Thread", t.shown_title()));
                    if let Some(vm) = &t.vm {
                        rows.push(("VM", format!("{vm}.exe.xyz")));
                    }
                }
                rows.push(("Model", snap["main"]["model"].as_str().unwrap_or_default().to_owned()));
                if let Some(target) = snap["target"].as_str().filter(|t| !t.is_empty()) {
                    rows.push(("Runs on", target.to_owned()));
                }
                rows.push(("Your role", role.clone()));
                if let Some(state) = snap["connection"].as_str() {
                    rows.push(("Connection", state.to_owned()));
                }
                body = body.child(heading("Session", &p)).children(rows.into_iter().map(|(k, v)| {
                    div().flex().gap_3().py(px(4.)).child(div().w(px(100.)).flex_none().text_size(sz(12.5)).text_color(p.muted).child(k)).child(div().flex_1().min_w_0().text_size(sz(13.)).whitespace_normal().child(v))
                }));
            }
        }
        let card = div()
            .w(px(760.))
            .h(px(560.))
            .mt(px(80.))
            .flex()
            .rounded(px(12.))
            .bg(p.raised)
            .border_1()
            .border_color(p.rule)
            .shadow_lg()
            .overflow_hidden()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    this.close_settings(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(nav)
            .child(div().id("settings-body").flex_1().min_w_0().overflow_y_scroll().p_5().child(body))
            .child(
                div()
                    .id("settings-close")
                    .absolute()
                    .top(px(10.))
                    .right(px(10.))
                    .p(px(5.))
                    .rounded(px(5.))
                    .text_color(p.muted)
                    .cursor_pointer()
                    .hover(|s| s.bg(p.sunken).text_color(p.ink))
                    .child(gpui_component::Icon::new(gpui_component::IconName::Close).size(px(14.)))
                    .on_click(cx.listener(|this, _, window, cx| this.close_settings(window, cx))),
            );
        Some(scrim("settings", div().relative().child(card), &p, cx.listener(|this, _, window, cx| this.close_settings(window, cx))))
    }
}

fn heading(text: &str, p: &Palette) -> Div {
    div().text_size(sz(17.)).font_weight(FontWeight::SEMIBOLD).text_color(p.ink).child(text.to_owned())
}

fn subheading(text: &str, p: &Palette) -> Div {
    div().mt_2().text_size(sz(13.5)).font_weight(FontWeight::SEMIBOLD).text_color(p.ink).child(text.to_owned())
}

fn field(label: &str, control: impl IntoElement, p: &Palette) -> Div {
    div().flex().flex_col().gap(px(6.)).child(div().text_size(sz(12.5)).text_color(p.muted).child(label.to_owned())).child(control)
}

fn input_box(input: &Entity<InputState>, p: &Palette) -> Div {
    div().px_2().py(px(5.)).rounded(px(6.)).border_1().border_color(p.rule_strong).bg(p.paper).child(Input::new(input).appearance(false).px_0().py(px(1.)).text_size(sz(14.)))
}

fn button(id: &str, label: &str, primary: bool, p: &Palette) -> Stateful<Div> {
    div()
        .id(SharedString::from(id.to_owned()))
        .flex_none()
        .px_3()
        .py(px(5.))
        .rounded(px(6.))
        .text_size(sz(13.))
        .cursor_pointer()
        .when(primary, |d| d.bg(p.accent).text_color(p.accent_ink))
        .when(!primary, |d| d.border_1().border_color(p.rule_strong).text_color(p.ink).hover(|s| s.bg(p.sunken)))
        .child(label.to_owned())
}

fn link(id: &str, label: &str, color: Hsla) -> Stateful<Div> {
    div().id(SharedString::from(id.to_owned())).flex_none().text_size(sz(12.5)).text_color(color).cursor_pointer().child(label.to_owned())
}

/// A choice among a few values, as buttons side by side; `pick` runs with the value clicked.
fn segments(id: &str, options: &[(&str, &str)], current: &str, p: &Palette, cx: &mut Context<Desktop>, pick: impl Fn(&mut Desktop, &str, &mut Window, &mut Context<Desktop>) + 'static) -> Div {
    let pick = std::rc::Rc::new(pick);
    div().flex().flex_none().p(px(2.)).gap(px(2.)).rounded(px(7.)).bg(p.sunken).children(options.iter().map(|(value, label)| {
        let (value, pick) = (value.to_string(), pick.clone());
        let on = value == current;
        div()
            .id(SharedString::from(format!("{id}-{value}")))
            .px_2()
            .py(px(3.))
            .rounded(px(5.))
            .text_size(sz(12.5))
            .cursor_pointer()
            .when(on, |d| d.bg(p.raised).text_color(p.ink).shadow_sm())
            .when(!on, |d| d.text_color(p.muted).hover(|s| s.text_color(p.ink)))
            .child(label.to_string())
            .on_click(cx.listener(move |this, _, window, cx| pick(this, &value, window, cx)))
    }))
}

fn days_from_now(at_ms: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.);
    let days = ((at_ms - now) / 86_400_000.).ceil().max(0.) as u64;
    match days {
        0 => "less than a day".into(),
        1 => "1 day".into(),
        n => format!("{n} days"),
    }
}
