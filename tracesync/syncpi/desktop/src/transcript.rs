// The thread, drawn like the web view (src/web/thread-view.ts): an avatar column and the content for each row, the
// model's mark on the agent's replies, thinking and tool calls as one quiet line until opened, edits open with their
// diff. The composer is the thread's next row; a status bar under it shows where requests run and what's happening.
use crate::theme::{self, MONO, Palette};
use crate::{Desktop, array, eid, flag, icons, label, message, text};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    Disableable, Icon, IconName, Sizable,
    button::{Button, ButtonVariants},
    input::Input,
};
use serde_json::{Value, json};

const MEASURE: f32 = 760.;
const AVATAR: f32 = 30.;

fn avatar_person(name: &str) -> Div {
    let color = theme::person_color(name);
    div()
        .size(px(AVATAR))
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(color.opacity(0.16))
        .text_color(color)
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(theme::initials(name))
}

fn avatar_model(model: &str, p: &Palette) -> Div {
    let base = div()
        .size(px(AVATAR))
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(p.raised)
        .border_1()
        .border_color(p.rule)
        .text_color(p.ink);
    match icons::model_vendor(model) {
        Some((_, path)) => base.child(svg().path(path).size(px(16.)).text_color(p.ink)),
        None => {
            let id = model.split_once('/').map_or(model, |(_, id)| id);
            base.font_family(MONO)
                .text_size(px(11.))
                .child(id.chars().next().unwrap_or('?').to_uppercase().to_string())
        }
    }
}

/// One row of the thread: avatar column (or the space for it) and the content.
fn row(avatar: Option<Div>, content: impl IntoElement) -> Div {
    div()
        .w_full()
        .max_w(px(MEASURE))
        .min_w_0()
        .flex_shrink_0()
        .flex()
        .items_start()
        .gap(px(14.))
        .child(avatar.unwrap_or_else(|| div().w(px(AVATAR)).flex_shrink_0()))
        .child(div().flex_1().min_w_0().flex().flex_col().child(content))
}

/// Lines added and removed in a unified patch.
pub(crate) fn patch_stats(patch: &str) -> (usize, usize) {
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
pub(crate) fn diff_view(id: String, patch: &str, p: &Palette) -> Stateful<Div> {
    let (mut old, mut new, mut hunks) = (0usize, 0usize, 0usize);
    let mut lines = div().flex().flex_col().min_w_full();
    for line in patch.lines().take(600) {
        // Everything before the first hunk is metadata: file names, modes, index lines.
        if hunks == 0 && !line.starts_with("@@") {
            continue;
        }
        if let Some(header) = line.strip_prefix("@@") {
            // @@ -a,b +c,d @@
            let mut numbers = header.split_whitespace();
            old = numbers
                .next()
                .and_then(|n| n.trim_start_matches('-').split(',').next()?.parse().ok())
                .unwrap_or(1);
            new = numbers
                .next()
                .and_then(|n| n.trim_start_matches('+').split(',').next()?.parse().ok())
                .unwrap_or(1);
            if hunks > 0 {
                lines = lines.child(
                    div()
                        .h(px(18.))
                        .pl(px(82.))
                        .bg(p.sunken)
                        .text_color(p.faint)
                        .child("⋯"),
                );
            }
            hunks += 1;
            continue;
        }
        let (mark, body) = line.split_at(line.len().min(1));
        let (bg, fg, left, right) = match mark {
            "+" => {
                new += 1;
                (
                    p.added.opacity(0.12),
                    p.ink,
                    String::new(),
                    (new - 1).to_string(),
                )
            }
            "-" => {
                old += 1;
                (
                    p.removed.opacity(0.12),
                    p.ink,
                    (old - 1).to_string(),
                    String::new(),
                )
            }
            _ => {
                old += 1;
                new += 1;
                (
                    transparent_black(),
                    p.ink_2,
                    (old - 1).to_string(),
                    (new - 1).to_string(),
                )
            }
        };
        let gutter = |n: String| {
            div()
                .w(px(34.))
                .flex_shrink_0()
                .text_right()
                .pr_2()
                .text_color(p.faint)
                .child(n)
        };
        lines = lines.child(
            div()
                .flex()
                .bg(bg)
                .text_color(fg)
                .child(gutter(left))
                .child(gutter(right))
                .child(
                    div()
                        .w(px(14.))
                        .flex_shrink_0()
                        .text_color(if mark == "+" {
                            p.added
                        } else if mark == "-" {
                            p.removed
                        } else {
                            p.faint
                        })
                        .child(mark.to_owned()),
                )
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
        .text_size(px(12.))
        .line_height(px(19.))
        .child(lines)
}

fn verb(tool: &str) -> &str {
    match tool {
        "bash" => "Ran",
        "edit" => "Edited",
        "write" => "Wrote",
        "read" => "Read",
        other => other,
    }
}

impl Desktop {
    pub(crate) fn transcript(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = theme::palette(cx);
        if self.active.is_empty() {
            return self.welcome(&p, cx);
        }
        let selected = self.selected();
        let status = text(&selected, "status");
        if status == "provisioning" || status == "failed" {
            return self.preparing(&selected, &p, cx);
        }
        let state = self.native[&self.showing].clone();
        let items = array(&state, "items");
        let mut thread = div()
            .id("transcript")
            .w_full()
            .min_w_0()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .px(px(28.))
            .pt(px(28.))
            .pb(px(160.))
            .flex()
            .flex_col()
            .items_center();
        let mut previous_agent = false;
        let mut model_of_turn = text(&state, "model");
        for item in &items {
            let kind = text(item, "kind");
            let key = text(item, "key");
            let agent = kind == "assistant" || kind == "tool";
            if kind == "assistant" && !text(item, "model").is_empty() {
                model_of_turn = text(item, "model");
            }
            let element = match kind.as_str() {
                "user" => Some(self.user_row(item, &key, &p, window, cx).mt(px(22.))),
                "assistant" => {
                    self.assistant_row(item, &key, previous_agent, &model_of_turn, &p, window, cx)
                }
                "tool" => Some(self.tool_row(item, &key, previous_agent, &model_of_turn, &p, cx)),
                "notice" => Some(
                    div()
                        .w_full()
                        .max_w(px(MEASURE))
                        .mt(px(22.))
                        .flex()
                        .items_center()
                        .gap_3()
                        .text_color(p.muted)
                        .text_size(px(13.))
                        .italic()
                        .child(div().flex_1().h(px(1.)).bg(p.rule))
                        .child(text(item, "text"))
                        .child(div().flex_1().h(px(1.)).bg(p.rule)),
                ),
                _ => None,
            };
            if let Some(element) = element {
                // Consecutive agent rows sit closer together under one avatar.
                thread = thread.child(if agent && previous_agent {
                    element.mt(px(10.))
                } else if agent {
                    element.mt(px(22.))
                } else {
                    element
                });
                previous_agent = agent;
            }
        }
        if self.showing == "main" && self.role() != "viewer" {
            thread = thread.child(self.composer_row(&p, cx));
        } else if self.role() == "viewer" {
            thread = thread.child(label("You can read this thread. Ask an admin to make you an editor to talk to the agent.").mt(px(26.)).text_color(p.muted).text_size(px(13.)));
        }
        div()
            .size_full()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .when(self.showing == "setup", |d| {
                d.child(
                    div()
                        .flex()
                        .justify_center()
                        .items_center()
                        .gap_3()
                        .py(px(7.))
                        .bg(p.sunken)
                        .border_b_1()
                        .border_color(p.rule)
                        .text_size(px(12.5))
                        .text_color(p.ink_2)
                        .child("The setup agent's thread: it prepares the environment.")
                        .child(
                            Button::new("setup-back")
                                .ghost()
                                .xsmall()
                                .label("Back to the conversation")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.showing = "main".into();
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(thread)
            .child(self.status_bar(&state, &p, cx))
            .into_any_element()
    }

    fn user_row(
        &self,
        item: &Value,
        key: &str,
        p: &Palette,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let id = text(item, "memberId");
        let name = array(&self.native, "members")
            .iter()
            .find(|m| text(m, "id") == id)
            .map(|m| text(m, "name"))
            .unwrap_or_else(|| text(item, "author"));
        let body = text(item, "text");
        let color = theme::person_color(&name);
        let fork = (self.role() == "admin"
            && self.showing == "main"
            && key.chars().all(|c| c.is_ascii_digit()))
        .then(|| {
            let before = key.to_owned();
            let draft = body.clone();
            Button::new(eid(format!("fork-{key}")))
                .ghost()
                .xsmall()
                .label("Edit & fork")
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.send(json!({"type":"fork","before":before}));
                    this.composer.update(cx, |s, cx| {
                        s.set_value(draft.clone(), window, cx);
                        s.focus(window, cx);
                    });
                }))
        });
        let attachments = array(item, "attachments");
        let group = SharedString::from(format!("message-{key}"));
        row(
            Some(avatar_person(&name)),
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .h(px(20.))
                        .text_size(px(12.))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color)
                                .child(name),
                        )
                        .child(div().flex_1())
                        // Shown while the pointer is over the message, as on the web.
                        .children(fork.map(|b| {
                            div()
                                .invisible()
                                .group_hover(group.clone(), |s| s.visible())
                                .child(b)
                        })),
                )
                .when(!body.is_empty(), |d| {
                    d.child(
                        div()
                            .text_size(px(15.))
                            .line_height(px(24.))
                            .text_color(p.ink)
                            .child(body),
                    )
                })
                .when(!attachments.is_empty(), |d| {
                    d.child(div().flex().flex_wrap().gap_2().mt_2().children(
                        attachments.iter().map(|a| {
                            div()
                                .flex()
                                .items_center()
                                .gap_1()
                                .px_2()
                                .py(px(3.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.rule)
                                .bg(p.surface)
                                .font_family(MONO)
                                .text_size(px(12.))
                                .text_color(p.ink_2)
                                .when(text(a, "kind") == "image", |d| {
                                    d.child(Icon::new(IconName::Frame).size_3())
                                })
                                .child(text(a, "name"))
                        }),
                    ))
                }),
        )
        .group(group)
    }

    #[allow(clippy::too_many_arguments)]
    fn assistant_row(
        &self,
        item: &Value,
        key: &str,
        previous_agent: bool,
        model: &str,
        p: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let body = text(item, "text");
        let thinking = text(item, "thinking");
        let error = text(item, "error");
        let streaming = flag(item, "streaming");
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
                    .text_size(px(15.))
                    .text_color(p.muted)
                    .cursor_pointer()
                    .hover(|s| s.text_color(p.ink_2))
                    .child(if streaming && body.is_empty() {
                        "Thinking…"
                    } else {
                        "Thinking"
                    })
                    .child(
                        Icon::new(if open {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .size_3()
                        .text_color(p.faint),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.thinking.remove(&k) {
                            this.thinking.insert(k.clone());
                        }
                        cx.notify();
                    })),
            );
            if open {
                content = content.child(
                    div()
                        .my_1()
                        .pl_3()
                        .border_l_2()
                        .border_color(p.rule_strong)
                        .text_size(px(13.5))
                        .text_color(p.ink_2)
                        .child(thinking),
                );
            }
        }
        if !body.is_empty() {
            content = content.child(div().text_size(px(15.)).line_height(px(25.)).child(
                message::render(&format!("assistant-{key}"), &body, window, cx),
            ));
        }
        if !error.is_empty() {
            content = content.child(label(error).text_size(px(13.)).text_color(p.removed));
        }
        Some(row(
            (!previous_agent).then(|| avatar_model(model, p)),
            content,
        ))
    }

    fn tool_row(
        &self,
        item: &Value,
        key: &str,
        previous_agent: bool,
        model: &str,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> Div {
        let tool = text(item, "name");
        let status = text(item, "status");
        let args = &item["args"];
        let detail = ["command", "path", "file_path", "url", "pattern"]
            .iter()
            .find_map(|k| args[*k].as_str())
            .unwrap_or("");
        let summary = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        let patch = item["details"]["patch"].as_str().unwrap_or("").to_owned();
        let stats = (!patch.is_empty()).then(|| patch_stats(&patch));
        // Edits are what people come to see, so they start open; everything else starts closed.
        let toggled = self.collapsed.contains(key);
        let open = (!patch.is_empty()) != toggled || status == "error";
        let k = key.to_owned();
        let header = div()
            .id(eid(format!("tool-{key}")))
            .w_full()
            .min_w_0()
            .flex()
            .items_center()
            .gap_2()
            .h(px(24.))
            .text_size(px(15.))
            .cursor_pointer()
            .child(
                div()
                    .flex_shrink_0()
                    .text_color(if status == "error" {
                        p.removed
                    } else {
                        p.ink_2
                    })
                    .child(verb(&tool).to_owned()),
            )
            .when(status == "running" || status == "pending", |d| {
                d.child(
                    Icon::new(IconName::LoaderCircle)
                        .size_3()
                        .text_color(p.warn),
                )
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(MONO)
                    .text_size(px(12.5))
                    .text_color(p.muted)
                    .child(summary),
            )
            .when_some(stats, |d, (added, removed)| {
                d.child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .gap_1()
                        .font_family(MONO)
                        .text_size(px(12.))
                        .child(div().text_color(p.added).child(format!("+{added}")))
                        .child(div().text_color(p.removed).child(format!("−{removed}"))),
                )
            })
            .child(
                Icon::new(if open {
                    IconName::ChevronDown
                } else {
                    IconName::ChevronRight
                })
                .size_3()
                .flex_shrink_0()
                .text_color(p.faint),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.collapsed.remove(&k) {
                    this.collapsed.insert(k.clone());
                }
                cx.notify();
            }));
        let mut content = div().flex().flex_col().child(header);
        if open {
            let output = text(item, "output");
            let written = args["content"].as_str().filter(|_| tool == "write");
            let body = if !patch.is_empty() {
                Some(diff_view(format!("diff-{key}"), &patch, p).into_any_element())
            } else if let Some(source) = written {
                Some(
                    div()
                        .id(eid(format!("write-{key}")))
                        .max_h(px(420.))
                        .overflow_scroll()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(p.rule)
                        .bg(p.raised)
                        .p_3()
                        .font_family(MONO)
                        .text_size(px(12.))
                        .child(source.to_owned())
                        .into_any_element(),
                )
            } else if !output.trim().is_empty() {
                let tail: String = output
                    .chars()
                    .rev()
                    .take(20_000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                Some(
                    div()
                        .id(eid(format!("output-{key}")))
                        .max_h(px(300.))
                        .overflow_scroll()
                        .rounded(px(8.))
                        .bg(p.sunken)
                        .px_3()
                        .py_2()
                        .font_family(MONO)
                        .text_size(px(12.))
                        .text_color(p.ink_2)
                        .child(tail.trim_end().to_owned())
                        .into_any_element(),
                )
            } else {
                None
            };
            if let Some(body) = body {
                content = content.child(div().pt_1().pb_1().child(body));
            }
        }
        row((!previous_agent).then(|| avatar_model(model, p)), content)
    }

    /// The next row of the thread: your avatar and a plain place to type. Enter starts a new line; ⌘↩ sends.
    fn composer_row(&self, _p: &Palette, _cx: &mut Context<Self>) -> Div {
        let name = text(&self.native["me"], "name");
        row(
            Some(avatar_person(&name)),
            Input::new(&self.composer)
                .appearance(false)
                .px_0()
                .py(px(2.))
                .w_full()
                .text_size(px(15.)),
        )
        .mt(px(26.))
    }

    fn status_bar(&self, state: &Value, p: &Palette, cx: &mut Context<Self>) -> Div {
        let busy = flag(state, "busy");
        let compacting = flag(state, "compacting");
        let mut activity = vec![];
        if let Some(retry) = state["retry"].as_str() {
            activity.push(format!("Retrying: {retry}"));
        } else if busy {
            activity.push("Working".to_owned());
        }
        if compacting {
            activity.push("Summarizing older messages".to_owned());
        }
        let queued = state["queued"].as_u64().unwrap_or(0);
        if queued > 0 {
            activity.push(format!("{queued} queued"));
        }
        let branch = array(&self.native, "branches")
            .iter()
            .find(|b| b["id"] == self.native["currentBranch"])
            .map(|b| text(b, "label"))
            .unwrap_or_else(|| "main".into());
        let branches = array(&self.native, "branches").len();
        let model = text(&self.native["main"], "model");
        let cost = state["cost"].as_f64().unwrap_or(0.);
        let sync = &self.native["sync"];
        let conflicts = !array(sync, "conflicts").is_empty();
        let admin = self.role() == "admin";
        let editor = self.role() != "viewer";
        let local = self.selected()["compute"] == "local";
        div()
            .h(px(34.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap_1()
            .pl_3()
            .pr_2()
            .border_t_1()
            .border_color(p.rule)
            .bg(p.paper)
            .text_size(px(12.))
            .text_color(p.muted)
            .when(!local, |d| {
                d.child(
                    Button::new("where")
                        .ghost()
                        .xsmall()
                        .label(if self.where_vm {
                            "Runs on the session VM"
                        } else {
                            "Runs on this Mac"
                        })
                        .tooltip("Where your requests run")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.where_vm = !this.where_vm;
                            cx.notify();
                        })),
                )
            })
            .when(branches > 1, |d| {
                d.child(
                    Button::new("branch-chip")
                        .ghost()
                        .xsmall()
                        .icon(icons::icon("git-branch"))
                        .label(branch)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_modal("branches", window, cx)
                        })),
                )
            })
            .child(div().px_1().child(format!(
                "↑{} ↓{} {}",
                sync["pushed"].as_u64().unwrap_or(0),
                sync["pulled"].as_u64().unwrap_or(0),
                if conflicts {
                    "conflicts saved"
                } else {
                    "synced"
                }
            )))
            .child(
                Button::new("setup-chip")
                    .ghost()
                    .xsmall()
                    .label("Setup agent")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.run_action("setup", window, cx)),
                    ),
            )
            .child(div().flex_1())
            .when(busy || compacting, |d| {
                d.child(
                    Icon::new(IconName::LoaderCircle)
                        .size_3()
                        .text_color(p.muted),
                )
            })
            .child(div().px_1().child(activity.join(" · ")))
            .when(busy && editor && self.showing == "main", |d| {
                d.child(
                    Button::new("stop")
                        .ghost()
                        .xsmall()
                        .label("Stop")
                        .tooltip("Stop the agent (Esc)")
                        .on_click(cx.listener(|this, _, _, _| this.send(json!({"type":"abort"})))),
                )
            })
            .when(cost > 0., |d| {
                d.child(div().px_1().child(format!("${cost:.2}")))
            })
            .child(
                Button::new("model-chip")
                    .ghost()
                    .xsmall()
                    .when_some(icons::model_vendor(&model), |b, (_, path)| {
                        b.icon(Icon::default().path(path))
                    })
                    .label(if model.is_empty() {
                        "model".to_owned()
                    } else {
                        model
                    })
                    .disabled(!admin)
                    .tooltip("Change the agent's model")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_modal("model", window, cx)),
                    ),
            )
            .when(editor && self.showing == "main", |d| {
                d.child(
                    Button::new("send")
                        .ghost()
                        .small()
                        .icon(IconName::ArrowRight)
                        .tooltip(if busy {
                            "Queue (⌘↩)"
                        } else {
                            "Send (⌘↩)"
                        })
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                )
            })
    }

    fn welcome(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .child(
                label("A shared place to build.")
                    .text_size(px(24.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.ink),
            )
            .child(
                label("Your project, your agent, and everyone on the same page.")
                    .text_size(px(14.))
                    .text_color(p.muted),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .mt_3()
                    .child(
                        Button::new("open-project")
                            .primary()
                            .label("Open a project")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.choose_project(window, cx)),
                            ),
                    )
                    .child(Button::new("join").label("Join a shared thread").on_click(
                        cx.listener(|this, _, window, cx| this.open_modal("join", window, cx)),
                    )),
            )
            .child(
                label("The agent runs on its own, with your pi setup.")
                    .text_size(px(12.))
                    .mt_6()
                    .text_color(p.muted),
            )
            .into_any_element()
    }

    fn preparing(&self, selected: &Value, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let failed = text(selected, "status") == "failed";
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_2()
            .child(
                label(if failed {
                    "Could not prepare this workspace"
                } else {
                    "Preparing your workspace…"
                })
                .text_size(px(17.))
                .text_color(p.ink),
            )
            .child(
                label(text(selected, if failed { "error" } else { "step" }))
                    .max_w(px(600.))
                    .text_size(px(13.))
                    .text_color(p.muted),
            )
            .when(failed, |d| {
                d.child(Button::new("retry").mt_2().label("Retry setup").on_click(
                    cx.listener(|this, _, window, cx| this.run_action("retry", window, cx)),
                ))
            })
            .into_any_element()
    }
}

/// `git diff` output as one block per file: its path, lines added and removed, and the diff.
pub(crate) fn file_diffs(id: &str, diff: &str, p: &Palette) -> Vec<Div> {
    let mut sections: Vec<(String, String)> = vec![];
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest.rsplit(" b/").next().unwrap_or(rest).to_owned();
            sections.push((path, String::new()));
        } else if let Some((_, patch)) = sections.last_mut() {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    sections
        .into_iter()
        .enumerate()
        .map(|(n, (path, patch))| {
            let (added, removed) = patch_stats(&patch);
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .font_family(MONO)
                        .text_size(px(12.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_color(p.ink)
                                .child(path),
                        )
                        .child(div().text_color(p.added).child(format!("+{added}")))
                        .child(div().text_color(p.removed).child(format!("−{removed}"))),
                )
                .child(diff_view(format!("{id}-{n}"), &patch, p))
        })
        .collect()
}
