// Settings (⌘, or the gear), as in the web view: you, how the app looks, the agent, people and the session.
use crate::theme::{self, MONO, Palette};
use crate::{Desktop, icons, text};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    Disableable, Icon, IconName, Sizable,
    button::{Button, ButtonVariants},
    input::Input,
};
use serde_json::json;

/// A titled group of rows on a card, separated by thin rules, as in macOS settings.
pub(crate) fn group(title: &str, rows: Vec<AnyElement>, p: &Palette) -> Div {
    let count = rows.len();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .pl_1()
                .text_size(theme::sz(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.muted)
                .child(title.to_owned()),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .rounded(px(10.))
                .border_1()
                .border_color(p.rule)
                .bg(p.raised)
                .children(rows.into_iter().enumerate().map(move |(n, row)| {
                    div()
                        .when(n + 1 < count, |d| d.border_b_1().border_color(p.rule))
                        .child(row)
                })),
        )
}

/// One setting: its name on the left, the control on the right.
pub(crate) fn row(label: &str, control: impl IntoElement, p: &Palette) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .min_h(theme::sz(44.))
        .px_3()
        .py(px(6.))
        .child(
            div()
                .flex_1()
                .text_size(theme::sz(13.5))
                .text_color(p.ink)
                .child(label.to_owned()),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_end()
                .gap_2()
                .min_w_0()
                .child(control),
        )
        .into_any_element()
}

/// A read-only value, in mono and truncated from the left when long.
fn value(text: String, p: &Palette) -> Div {
    div()
        .max_w(px(300.))
        .truncate()
        .font_family(MONO)
        .text_size(theme::sz(12.5))
        .text_color(p.ink_2)
        .child(text)
}

impl Desktop {
    pub(crate) fn settings(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Div {
        let p = theme::palette(cx);
        let admin = self.role() == "admin";
        let editor = self.role() != "viewer" && !self.active.is_empty();
        let dark = self.prefs.dark;
        let zoom = self.zoom();
        let model = text(&self.native["main"], "model");
        let thinking = text(&self.native["main"], "thinkingLevel");
        let selected = self.selected();
        let info = |key: &str| text(&selected, key);
        let name = self.fields.get("name").cloned();
        let you = group(
            "You",
            vec![row(
                "Name",
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .when_some(name, |d, state| {
                        d.child(div().w(px(200.)).child(Input::new(&state).small()))
                    })
                    .child(
                        Button::new("save-name")
                            .small()
                            .label("Save")
                            .disabled(self.active.is_empty())
                            .on_click(cx.listener(|this, _, _, cx| {
                                let name = this.value("name", cx);
                                if !name.trim().is_empty() {
                                    this.send(json!({"type": "rename", "name": name.trim()}));
                                    this.notice("Name saved", cx);
                                }
                            })),
                    ),
                &p,
            )],
            &p,
        );
        let appearance = group(
            "Appearance",
            vec![
                row(
                    "Theme",
                    div()
                        .flex()
                        .gap_1()
                        .child(
                            Button::new("light")
                                .small()
                                .label("Light")
                                .when(!dark, |b| b.primary())
                                .on_click(cx.listener(|this, _, window, cx| {
                                    if this.prefs.dark {
                                        this.run_action("theme", window, cx);
                                    }
                                })),
                        )
                        .child(
                            Button::new("dark")
                                .small()
                                .label("Dark")
                                .when(dark, |b| b.primary())
                                .on_click(cx.listener(|this, _, window, cx| {
                                    if !this.prefs.dark {
                                        this.run_action("theme", window, cx);
                                    }
                                })),
                        ),
                    &p,
                ),
                row(
                    "Text size",
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .child(
                            Button::new("actual")
                                .ghost()
                                .small()
                                .label("Reset")
                                .tooltip("Actual size (⌘0)")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.run_command("app.zoomReset", window, cx)
                                })),
                        )
                        .child(
                            Button::new("smaller")
                                .small()
                                .icon(IconName::Minus)
                                .tooltip("Smaller (⌘−)")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.run_command("app.zoomOut", window, cx)
                                })),
                        )
                        .child(
                            div()
                                .w(px(48.))
                                .text_center()
                                .text_size(theme::sz(13.))
                                .child(format!("{}%", (zoom * 100.).round())),
                        )
                        .child(
                            Button::new("bigger")
                                .small()
                                .icon(IconName::Plus)
                                .tooltip("Bigger (⌘=)")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.run_command("app.zoomIn", window, cx)
                                })),
                        ),
                    &p,
                ),
            ],
            &p,
        );
        let mut agent_rows = vec![row(
            "Model",
            Button::new("change-model")
                .small()
                .when_some(icons::model_vendor(&model), |b, (_, path)| {
                    b.icon(Icon::default().path(path))
                })
                .label(if model.is_empty() {
                    "Choose a model".to_owned()
                } else {
                    model.clone()
                })
                .disabled(!admin)
                .tooltip("Only admins change the model (⌥⌘/)")
                .on_click(cx.listener(|this, _, window, cx| {
                    this.modal.clear();
                    this.pick_model(window, cx);
                })),
            &p,
        )];
        if !thinking.is_empty() {
            agent_rows.push(row("Thinking", value(thinking, &p), &p));
        }
        agent_rows.push(row(
            "Older messages",
            Button::new("compact-now")
                .small()
                .label("Summarize now")
                .disabled(!editor)
                .on_click(
                    cx.listener(|this, _, window, cx| this.open_modal("compact", window, cx)),
                ),
            &p,
        ));
        agent_rows.push(row(
            "Context",
            Button::new("new-context")
                .small()
                .label("Start a new context")
                .disabled(!admin)
                .on_click(cx.listener(|this, _, window, cx| this.open_modal("reset", window, cx))),
            &p,
        ));
        let agent = group("Agent", agent_rows, &p);
        let people = group(
            "People",
            vec![row(
                "Members and invites",
                Button::new("people")
                    .small()
                    .icon(crate::icons::icon("users"))
                    .label("Open")
                    .disabled(self.active.is_empty())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.modal.clear();
                        this.set_pane("people", cx);
                    })),
                &p,
            )],
            &p,
        );
        let runs_on = if selected["compute"] == "local" {
            "This Mac".to_owned()
        } else {
            format!(
                "{}.exe.xyz",
                if info("vm").is_empty() {
                    "syncpi".to_owned()
                } else {
                    info("vm")
                }
            )
        };
        div()
            .flex()
            .flex_col()
            .gap_5()
            .w(px(520.))
            .child(you)
            .child(appearance)
            .child(agent)
            .child(people)
            .when(!self.active.is_empty(), |d| {
                d.child(group(
                    "Session",
                    vec![
                        row("Project", value(info("dir"), &p), &p),
                        row("Runs on", value(runs_on, &p), &p),
                        row("Link", value(info("url"), &p), &p),
                    ],
                    &p,
                ))
            })
    }

    /// People, invites and the environment, in the same cards as settings.
    pub(crate) fn people_pane(&mut self, cx: &mut Context<Self>) -> Div {
        let p = theme::palette(cx);
        let admin = self.role() == "admin";
        let me = text(&self.native["me"], "id");
        let online: Vec<String> = crate::array(&self.native, "online")
            .iter()
            .map(|o| text(o, "memberId"))
            .collect();
        let members: Vec<AnyElement> = crate::array(&self.native, "members")
            .iter()
            .map(|m| {
                let id = text(m, "id");
                let name = text(m, "name");
                let email = text(m, "email");
                let creator = crate::flag(m, "creator");
                let color = theme::person_color(&name);
                let (member, remove) = (id.clone(), id.clone());
                let who = div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .min_w_0()
                    .child(
                        div()
                            .relative()
                            .size(px(28.))
                            .flex_shrink_0()
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(color.opacity(0.16))
                            .text_color(color)
                            .text_size(theme::sz(10.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(theme::initials(&name))
                            .when(online.contains(&id), |d| {
                                d.child(
                                    div()
                                        .absolute()
                                        .right(px(-1.))
                                        .bottom(px(-1.))
                                        .size(px(9.))
                                        .rounded_full()
                                        .bg(p.ok)
                                        .border_2()
                                        .border_color(p.raised),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_w_0()
                            .child(div().text_size(theme::sz(13.5)).text_color(p.ink).child(
                                if id == me {
                                    format!("{name} (you)")
                                } else {
                                    name.clone()
                                },
                            ))
                            .when(!email.is_empty(), |d| {
                                d.child(
                                    div()
                                        .truncate()
                                        .text_size(theme::sz(12.))
                                        .text_color(p.muted)
                                        .child(email),
                                )
                            }),
                    );
                let role = if creator {
                    "admin · created it".to_owned()
                } else {
                    text(m, "role")
                };
                let controls = div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(
                        Button::new(SharedString::from(format!("role-{id}")))
                            .ghost()
                            .small()
                            .label(role)
                            .disabled(!admin || creator)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.target_member = member.clone();
                                this.modal = "role".into();
                                cx.notify();
                            })),
                    )
                    .when(admin && !creator, |d| {
                        d.child(
                            Button::new(SharedString::from(format!("remove-{id}")))
                                .ghost()
                                .small()
                                .icon(IconName::Close)
                                .tooltip("Remove from the session")
                                .on_click(cx.listener(move |this, _, _, _| {
                                    this.send(json!({"type": "remove", "memberId": remove}))
                                })),
                        )
                    });
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .min_h(theme::sz(52.))
                    .px_3()
                    .py(px(6.))
                    .child(who)
                    .child(controls)
                    .into_any_element()
            })
            .collect();
        let invites: Vec<AnyElement> = crate::array(&self.native, "invites")
            .iter()
            .map(|invite| {
                let code = text(invite, "code");
                let who = if text(invite, "email").is_empty() {
                    "Anyone with the link".to_owned()
                } else {
                    text(invite, "email")
                };
                row(
                    &who,
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .text_size(theme::sz(12.5))
                                .text_color(p.muted)
                                .child(text(invite, "role")),
                        )
                        .child(
                            Button::new(SharedString::from(format!("revoke-{code}")))
                                .ghost()
                                .small()
                                .label("Revoke")
                                .on_click(cx.listener(move |this, _, _, _| {
                                    this.send(json!({"type": "revoke", "code": code}))
                                })),
                        ),
                    &p,
                )
            })
            .collect();
        let summary = text(&self.native["env"], "summary");
        let status = text(&self.native["env"], "status");
        let skills = self.native["context"]["skillCount"]
            .as_u64()
            .unwrap_or_default();
        let actions = div()
            .flex()
            .gap_2()
            .child(
                Button::new("invite-person")
                    .small()
                    .primary()
                    .icon(IconName::Plus)
                    .label("Invite")
                    .disabled(!admin)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_modal("invite", window, cx)),
                    ),
            )
            .child(
                Button::new("rename-me")
                    .small()
                    .label("Change my name")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_modal("name", window, cx)),
                    ),
            );
        div()
            .flex()
            .flex_col()
            .gap_5()
            .p_4()
            .child(actions)
            .child(group("People", members, &p))
            .when(admin, |d| {
                d.child(group(
                    "Invites",
                    if invites.is_empty() {
                        vec![
                            div()
                                .px_3()
                                .py_3()
                                .text_size(theme::sz(13.))
                                .text_color(p.muted)
                                .child("No invites waiting. Invite someone, or share a link.")
                                .into_any_element(),
                        ]
                    } else {
                        invites
                    },
                    &p,
                ))
            })
            .child(group(
                "Environment",
                vec![
                    row(
                        "Setup agent",
                        div()
                            .text_size(theme::sz(12.5))
                            .text_color(if status == "failed" {
                                p.removed
                            } else {
                                p.muted
                            })
                            .child(match status.as_str() {
                                "ready" => "Ready",
                                "running" => "Setting up…",
                                "failed" => "Failed",
                                _ => "Waiting",
                            }),
                        &p,
                    ),
                    row(
                        "Pi skills",
                        div()
                            .text_size(theme::sz(12.5))
                            .text_color(p.muted)
                            .child(format!("{skills} loaded")),
                        &p,
                    ),
                    div()
                        .px_3()
                        .py_3()
                        .text_size(theme::sz(13.5))
                        .child(if summary.is_empty() {
                            div()
                                .text_color(p.muted)
                                .child("The setup agent hasn't written notes yet.")
                                .into_any_element()
                        } else {
                            crate::prose::render("env-summary", &summary, cx)
                        })
                        .into_any_element(),
                ],
                &p,
            ))
    }
}
