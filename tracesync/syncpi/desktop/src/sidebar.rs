// The left rail, as in Delta: each project with its threads under it, newest first and pinned on top. A project
// folds; "+" on a project starts a thread there. The archive shows archived threads instead.
use crate::keymap::RunCommand;
use crate::theme::{self, Palette};
use crate::{Desktop, array, eid, flag, icons, label, text};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::menu::{ContextMenuExt, PopupMenu};
use gpui_component::{
    Icon, IconName, Sizable,
    button::{Button, ButtonVariants},
};
use serde_json::Value;

/// When a thread was last active, for ordering.
fn recency(session: &Value) -> u64 {
    session["lastOpened"]
        .as_u64()
        .or(session["createdAt"].as_u64())
        .unwrap_or_default()
}

fn title(session: &Value) -> String {
    let title = text(session, "title");
    if title.is_empty() {
        text(session, "name")
    } else {
        title
    }
}

impl Desktop {
    /// Threads in the order the sidebar shows them, for next and previous thread.
    pub(crate) fn thread_order(&self) -> Vec<String> {
        let mut threads: Vec<&Value> = self
            .sessions
            .iter()
            .filter(|s| flag(s, "archived") == self.archived)
            .collect();
        threads.sort_by_key(|s| (!flag(s, "pinned"), std::cmp::Reverse(recency(s))));
        let mut projects: Vec<String> = vec![];
        for s in &threads {
            let dir = text(s, "dir");
            if !projects.contains(&dir) {
                projects.push(dir);
            }
        }
        projects
            .iter()
            .filter(|dir| !self.folded.contains(*dir))
            .flat_map(|dir| {
                threads
                    .iter()
                    .filter(move |s| text(s, "dir") == **dir)
                    .map(|s| text(s, "id"))
            })
            .collect()
    }

    pub(crate) fn sidebar(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = theme::palette(cx);
        let mut threads: Vec<&Value> = self
            .sessions
            .iter()
            .filter(|s| flag(s, "archived") == self.archived)
            .collect();
        threads.sort_by_key(|s| (!flag(s, "pinned"), std::cmp::Reverse(recency(s))));
        // Projects in the order of their most recent thread.
        let mut projects: Vec<(String, String)> = vec![];
        for s in &threads {
            let dir = text(s, "dir");
            if !projects.iter().any(|(d, _)| d == &dir) {
                projects.push((dir, text(s, "name")));
            }
        }
        let mut list = div().flex().flex_col().gap(px(1.));
        if self.archived {
            list = list.child(self.caption("Archived threads", None, &p, cx));
            list = list.children(threads.iter().map(|s| self.thread_row(s, false, &p, cx)));
            if threads.is_empty() {
                list = list.child(
                    label("Nothing archived.")
                        .px_3()
                        .py_2()
                        .text_size(theme::sz(13.))
                        .text_color(p.muted),
                );
            }
        } else {
            list = list.child(
                self.caption(
                    "Projects",
                    Some(
                        Button::new("add-project")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Plus)
                            .tooltip("Open a project (⌘O)")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.choose_project(window, cx)),
                            ),
                    ),
                    &p,
                    cx,
                ),
            );
            for (dir, name) in projects {
                let folded = self.folded.contains(&dir);
                list = list.child(self.project_row(&dir, &name, folded, &p, cx));
                if !folded {
                    list = list.children(
                        threads
                            .iter()
                            .filter(|s| text(s, "dir") == dir)
                            .map(|s| self.thread_row(s, true, &p, cx)),
                    );
                }
            }
            if threads.is_empty() {
                list = list.child(
                    label("Open a project to start a thread.")
                        .px_3()
                        .py_2()
                        .text_size(theme::sz(13.))
                        .text_color(p.muted),
                );
            }
        }
        let name = text(&self.catalog["identity"], "name");
        let color = theme::person_color(&name);
        div()
            .w(px(252.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .bg(p.surface)
            .border_r_1()
            .border_color(p.rule)
            .child(
                div()
                    .h(px(49.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .pl(px(91.))
                    .pr_2()
                    .gap_1()
                    .child(
                        Button::new("search")
                            .ghost()
                            .small()
                            .icon(IconName::Search)
                            .tooltip("Go to thread (⌘T)")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_palette(crate::palette::Tab::Threads, window, cx)
                            })),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("archives")
                            .ghost()
                            .small()
                            .icon(icons::icon("archive"))
                            .when(self.archived, |b| b.bg(p.sunken))
                            .tooltip(if self.archived {
                                "Back to threads"
                            } else {
                                "Archived threads"
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_action("archives", window, cx)
                            })),
                    ),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_2()
                    .pt_2()
                    .pb_4()
                    .child(list),
            )
            .child(
                div()
                    .h(px(46.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .border_t_1()
                    .border_color(p.rule)
                    .child(
                        div()
                            .size(px(24.))
                            .rounded_full()
                            .bg(color.opacity(0.16))
                            .text_color(color)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(theme::sz(10.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(theme::initials(&name)),
                    )
                    .child(
                        label(name)
                            .flex_1()
                            .text_size(theme::sz(13.))
                            .text_color(p.ink_2),
                    )
                    .child(
                        Button::new("theme")
                            .ghost()
                            .small()
                            .icon(if self.prefs.dark {
                                IconName::Sun
                            } else {
                                IconName::Moon
                            })
                            .tooltip("Light or dark (⌘⇧L)")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_action("theme", window, cx)
                            })),
                    ),
            )
            .into_any_element()
    }

    fn caption(
        &self,
        title: &str,
        action: Option<Button>,
        p: &Palette,
        _cx: &mut Context<Self>,
    ) -> Div {
        div()
            .flex()
            .items_center()
            .justify_between()
            .h(px(28.))
            .pl_2()
            .text_size(theme::sz(12.))
            .text_color(p.muted)
            .child(title.to_owned())
            .children(action)
    }

    fn project_row(
        &self,
        dir: &str,
        name: &str,
        folded: bool,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let group = SharedString::from(format!("project-{dir}"));
        let toggle = dir.to_owned();
        let target = dir.to_owned();
        div()
            .id(eid(format!("project-{dir}")))
            .group(group.clone())
            .flex()
            .items_center()
            .gap_2()
            .min_h(theme::sz(30.))
            .pl_2()
            .pr_1()
            .mt_1()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(p.sunken))
            .child(
                Icon::new(if folded {
                    IconName::Folder
                } else {
                    IconName::FolderOpen
                })
                .size_4()
                .text_color(p.muted),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(theme::sz(13.5))
                    .text_color(p.ink)
                    .child(name.to_owned()),
            )
            .child(
                div().invisible().group_hover(group, |s| s.visible()).child(
                    Button::new(eid(format!("new-in-{dir}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Plus)
                        .tooltip("New thread in this project")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.project = target.clone();
                            this.new_thread(target.clone(), window, cx);
                        })),
                ),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.folded.remove(&toggle) {
                    this.folded.insert(toggle.clone());
                }
                cx.notify();
            }))
    }

    fn thread_row(
        &self,
        s: &Value,
        nested: bool,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = text(s, "id");
        let selected = id == self.active;
        let pinned = flag(s, "pinned");
        let archived = flag(s, "archived");
        let menu_id = eid(format!("menu-{id}"));
        let focus = id.clone();
        let working = s["status"] == "provisioning";
        let failed = s["status"] == "failed";
        let tags = array(s, "tags")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" · ");
        let row = div()
            .id(eid(format!("thread-{id}")))
            .flex()
            .items_center()
            .gap_2()
            .min_h(theme::sz(30.))
            .pl(px(if nested { 32. } else { 10. }))
            .pr_2()
            .rounded(px(6.))
            .cursor_pointer()
            .when(selected, |d| d.bg(p.accent_soft))
            .when(!selected, |d| d.hover(|s| s.bg(p.sunken)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(theme::sz(13.5))
                    .text_color(if selected { p.ink } else { p.ink_2 })
                    .child(title(s)),
            )
            .when(!tags.is_empty(), |d| {
                d.child(
                    div()
                        .flex_shrink_0()
                        .max_w(px(80.))
                        .truncate()
                        .text_size(theme::sz(11.))
                        .text_color(p.muted)
                        .child(tags),
                )
            })
            .when(flag(s, "pinned"), |d| {
                d.child(icons::icon("pin").size_3().text_color(p.muted))
            })
            .when(working, |d| {
                d.child(
                    Icon::new(IconName::LoaderCircle)
                        .size_3()
                        .text_color(p.warn),
                )
            })
            .when(failed, |d| {
                d.child(Icon::new(IconName::CircleX).size_3().text_color(p.removed))
            })
            .on_click(cx.listener(move |this, _, window, cx| this.select(id.clone(), window, cx)))
            // A right-click opens the thread too, so its menu acts on it.
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, _, window, cx| this.select(focus.clone(), window, cx)),
            );
        // As in Delta's sidebar. Each row's menu sits under its own id, so menus don't share their open state.
        div()
            .id(menu_id)
            .child(row.context_menu(move |menu: PopupMenu, _, _| {
                let item = |label: &str, id: &str| {
                    (
                        label.to_owned(),
                        Box::new(RunCommand {
                            id: id.to_owned().into(),
                        }) as Box<dyn Action>,
                    )
                };
                let items = [
                    item("Share", "thread.share"),
                    item(if pinned { "Unpin" } else { "Pin" }, "thread.pin"),
                    item("Rename", "thread.rename"),
                    item("Regenerate title", "thread.title"),
                ];
                let more = [
                    item("Open in browser", "project.web"),
                    item("Reveal in Finder", "project.reveal"),
                ];
                let mut menu = menu;
                for (label, action) in items {
                    menu = menu.menu(label, action);
                }
                menu = menu.separator();
                for (label, action) in more {
                    menu = menu.menu(label, action);
                }
                let (label, action) = item(
                    if archived { "Restore" } else { "Archive" },
                    "thread.archive",
                );
                menu.separator().menu(label, action)
            }))
            .into_any_element()
    }
}
