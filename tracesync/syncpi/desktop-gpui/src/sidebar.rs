// The sidebar, native: threads by project, as the Tauri app's shell shows them (src/web/shell.ts renderSidebar). A
// project shows who else is in it (avatars, a dot for whoever is there now); a shared thread shows a people icon.
use crate::{
    Desktop,
    host::{Catalog, Person, Thread},
    theme::{initials, palette, person_color, sz},
};
use crate::keymap::RunCommand;
use gpui::{prelude::FluentBuilder, *};
use gpui_component::{Icon, IconName, menu::ContextMenuExt};
use std::collections::HashMap;

pub struct Group {
    pub dir: String,
    pub threads: Vec<Thread>,
}

/// Threads by project: projects with the most recent thread first, and their threads newest first (pinned ones
/// first). Archived threads only when `archived` (the archive's list), and only they.
pub fn groups(catalog: &Catalog, archived: bool) -> Vec<Group> {
    let mut by_dir: HashMap<String, Vec<Thread>> = HashMap::new();
    for t in catalog.sessions.iter().filter(|t| t.archived == archived) {
        by_dir.entry(t.dir.clone()).or_default().push(t.clone());
    }
    let recent = |t: &Thread| t.last_opened.unwrap_or(t.created_at).max(t.created_at);
    let mut out: Vec<Group> = by_dir
        .into_iter()
        .map(|(dir, mut threads)| {
            threads.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.created_at.total_cmp(&a.created_at)));
            Group { dir, threads }
        })
        .collect();
    out.sort_by(|a, b| {
        let at = |g: &Group| g.threads.iter().map(recent).fold(0., f64::max);
        at(b).total_cmp(&at(a))
    });
    out
}

fn project_name(dir: &str) -> String {
    dir.trim_end_matches('/').rsplit('/').next().unwrap_or(dir).to_owned()
}

/// Everyone in a project's threads, whoever is there now first.
fn people(threads: &[Thread]) -> Vec<Person> {
    let mut seen: Vec<Person> = Vec::new();
    for p in threads.iter().flat_map(|t| t.people.clone().unwrap_or_default()) {
        match seen.iter_mut().find(|s| s.name == p.name) {
            Some(s) => s.online |= p.online,
            None => seen.push(p),
        }
    }
    seen.sort_by(|a, b| b.online.cmp(&a.online));
    seen
}

/// "Shared with Bob and Carol; Bob is here now."
pub fn shared_with(people: &[Person]) -> String {
    let list = |names: Vec<&str>| match names.len() {
        0 | 1 => names.join(""),
        n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
    };
    let here: Vec<&str> = people.iter().filter(|p| p.online).map(|p| p.name.as_str()).collect();
    let all = list(people.iter().map(|p| p.name.as_str()).collect());
    if here.is_empty() {
        format!("Shared with {all}")
    } else {
        let verb = if here.len() == 1 { "is" } else { "are" };
        format!("Shared with {all}; {} {verb} here now", list(here))
    }
}

fn avatar(person: &Person, dark: bool, edge: Hsla, ok: Hsla) -> impl IntoElement {
    let color = person_color(&person.name, dark);
    div()
        .relative()
        .size(px(18.))
        .rounded_full()
        .border_1()
        .border_color(edge)
        .bg(color.opacity(0.18))
        .text_color(color)
        .text_size(px(8.))
        .font_weight(FontWeight::SEMIBOLD)
        .flex()
        .items_center()
        .justify_center()
        .child(initials(&person.name))
        .when(person.online, |d| {
            d.child(div().absolute().right(px(-2.)).bottom(px(-2.)).size(px(7.)).rounded_full().bg(ok).border_1().border_color(edge))
        })
}

fn tooltip(text: String) -> impl Fn(&mut Window, &mut App) -> AnyView {
    move |window, cx| gpui_component::tooltip::Tooltip::new(text.clone()).build(window, cx)
}

/// A button in the sidebar's head that runs a command.
fn head_button(id: &'static str, icon: Icon, tip: &'static str, command: &'static str, p: &crate::theme::Palette, cx: &mut Context<Desktop>) -> impl IntoElement {
    div()
        .id(id)
        .p(px(5.))
        .rounded(px(5.))
        .text_color(p.muted)
        .hover(|s| s.bg(p.rule))
        .cursor_pointer()
        .child(icon.size(px(15.)))
        .tooltip(tooltip(tip.into()))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, _, window, cx| this.run(&RunCommand { id: command.into() }, window, cx)))
}

pub fn render(desktop: &Desktop, _window: &mut Window, cx: &mut Context<Desktop>) -> AnyElement {
    let p = palette(cx);
    let active = desktop.active.clone();
    let project = active.as_deref().and_then(|id| desktop.thread(id)).map(|t| t.dir.clone());
    let mut list = div().id("sidebar-list").flex_1().overflow_y_scroll().px(px(6.)).pb_3().flex().flex_col();
    list = list.child(
        div()
            .flex()
            .items_center()
            .px(px(8.))
            .pt(px(10.))
            .pb(px(4.))
            .text_size(sz(12.5))
            .text_color(p.muted)
            .child(div().flex_1().child(if desktop.archives { "Archived" } else { "Projects" }))
            .when(!desktop.archives, |d| d.child(
                div()
                    .id("new-project")
                    .p(px(4.))
                    .rounded(px(5.))
                    .text_color(p.muted)
                    .hover(|s| s.bg(p.rule).text_color(p.ink))
                    .cursor_pointer()
                    .child(Icon::new(IconName::FolderOpen).size(px(15.)))
                    .tooltip(tooltip("New project: open a folder (⌘O)".into()))
                    .on_click(cx.listener(|this, _, window, cx| this.new_project(window, cx))),
            )),
    );
    let groups = groups(&desktop.catalog, desktop.archives);
    // Threads with mentions not yet read (the inbox's), as the Tauri app's sidebar marks them.
    let unread: std::collections::HashSet<String> = desktop.unread_mentions().iter().filter_map(|i| i["thread"].as_str().map(str::to_owned)).collect();
    if groups.is_empty() {
        list = list.child(div().px(px(8.)).py_1().text_size(sz(13.)).text_color(p.muted).child(if desktop.archives { "No archived threads." } else { "No threads yet." }));
    }
    for group in groups {
        let dir = group.dir.clone();
        let everyone = people(&group.threads);
        let current = project.as_deref() == Some(dir.as_str());
        let mut avatars = div().flex().items_center().id(SharedString::from(format!("people-{dir}")));
        for (n, person) in everyone.iter().take(3).enumerate() {
            avatars = avatars.child(div().when(n > 0, |d| d.ml(px(-5.))).child(avatar(person, p.dark, p.sunken, p.ok)));
        }
        if everyone.len() > 3 {
            avatars = avatars.child(div().ml(px(3.)).text_size(sz(11.)).text_color(p.muted).child(format!("+{}", everyone.len() - 3)));
        }
        let add_dir = dir.clone();
        list = list.child(
            div()
                .id(SharedString::from(format!("project-{dir}")))
                .group("project")
                .flex()
                .items_center()
                .gap(px(7.))
                .h(px(30.))
                .px(px(8.))
                .rounded(px(6.))
                .text_size(sz(13.5))
                .text_color(if current { p.accent } else { p.ink })
                .child(Icon::new(IconName::Folder).size(px(16.)).text_color(p.muted))
                .child(div().flex_1().min_w_0().truncate().child(project_name(&dir)))
                .when(!everyone.is_empty(), |d| d.child(avatars.tooltip(tooltip(shared_with(&everyone)))))
                .child(
                    div()
                        .id(SharedString::from(format!("add-{dir}")))
                        .invisible()
                        .group_hover("project", |s| s.visible())
                        .p(px(4.))
                        .rounded(px(5.))
                        .text_color(p.muted)
                        .hover(|s| s.bg(p.rule).text_color(p.ink))
                        .cursor_pointer()
                        .child(Icon::new(IconName::Plus).size(px(14.)))
                        .tooltip(tooltip("New thread in this project".into()))
                        .on_click(cx.listener(move |this, _, window, cx| this.new_thread(Some(add_dir.clone()), window, cx))),
                ),
        );
        for t in group.threads {
            let id = t.id.clone();
            let selected = active.as_deref() == Some(t.id.as_str());
            let others = t.people.clone().unwrap_or_default();
            let busy = desktop.busy.get(&t.id).copied().unwrap_or(false) || t.status.as_deref() == Some("provisioning");
            let failed = t.status.as_deref() == Some("failed");
            let pressed = t.id.clone();
            let (archived, pinned, bookmarked) = (t.archived, t.pinned, t.bookmarked);
            let item = |title: &'static str, id: &'static str| (title, RunCommand { id: id.into() });
            list = list.child(
                div()
                    .id(SharedString::from(format!("thread-{}", t.id)))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(30.))
                    .pl(px(31.))
                    .pr(px(8.))
                    .rounded(px(6.))
                    .text_size(sz(13.5))
                    .text_color(if selected { p.ink } else { p.ink_2 })
                    .when(selected, |d| d.bg(p.ink.opacity(0.08)))
                    .hover(|s| s.bg(p.ink.opacity(0.05)))
                    .child(div().flex_1().min_w_0().truncate().child(t.shown_title()))
                    .when(unread.contains(&t.id), |d| d.child(div().flex_none().size(px(7.)).rounded_full().bg(p.accent)))
                    .children(t.tags.iter().take(2).map(|tag| {
                        div().flex_none().px(px(5.)).rounded(px(4.)).bg(p.rule).text_size(sz(11.)).text_color(p.muted).child(tag.clone())
                    }))
                    .when(bookmarked, |d| d.child(Icon::default().path("syncpi/bookmark.svg").size(px(13.)).text_color(p.muted)))
                    .when(pinned, |d| d.child(Icon::default().path("syncpi/pin.svg").size(px(13.)).text_color(p.muted)))
                    .when(!others.is_empty(), |d| {
                        let online = others.iter().any(|o| o.online);
                        d.child(
                            div()
                                .id(SharedString::from(format!("shared-{}", t.id)))
                                .child(Icon::default().path("syncpi/users.svg").size(px(14.)).text_color(if online { p.ok } else { p.muted }))
                                .tooltip(tooltip(shared_with(&others))),
                        )
                    })
                    .when(failed, |d| d.child(Icon::new(IconName::TriangleAlert).size(px(14.)).text_color(p.removed)))
                    .when(busy && !failed, |d| d.child(div().size(px(7.)).rounded_full().bg(p.accent)))
                    .on_click(cx.listener(move |this, _, window, cx| this.show(&id, window, cx)))
                    // A right click opens the thread, then its menu acts on it, as in the Tauri app's sidebar.
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, _, window, cx| {
                            if this.active.as_deref() != Some(pressed.as_str()) {
                                this.show(&pressed, window, cx);
                            }
                        }),
                    )
                    .context_menu(move |menu, _, _| {
                        let mut menu = menu;
                        for (title, action) in [
                            item("Rename…", "thread.rename"),
                            item("Regenerate title", "thread.title"),
                            item(if pinned { "Unpin" } else { "Pin" }, "thread.pin"),
                            item(if bookmarked { "Remove bookmark" } else { "Bookmark" }, "thread.bookmark"),
                            item("Tags…", "thread.tags"),
                            item("Share…", "thread.share"),
                            item(if archived { "Restore" } else { "Archive" }, "thread.archive"),
                        ] {
                            menu = menu.menu(title, Box::new(action));
                        }
                        menu.separator()
                            .menu("Reveal in Finder", Box::new(RunCommand { id: "project.reveal".into() }))
                            .menu("Open in Zed", Box::new(RunCommand { id: "project.zed".into() }))
                            .menu("Open in a browser", Box::new(RunCommand { id: "project.web".into() }))
                    }),
            );
        }
    }
    div()
        .w(px(252.))
        .h_full()
        .flex()
        .flex_col()
        .flex_none()
        .bg(p.sunken)
        .border_r_1()
        .border_color(p.rule)
        .child(
            // Room for the window's traffic lights; dragging here moves the window, as a title bar does.
            div()
                .id("sidebar-head")
                .h(px(44.))
                .flex_none()
                .flex()
                .items_center()
                .justify_end()
                .gap(px(2.))
                .pl(px(76.))
                .pr(px(6.))
                .on_mouse_down(MouseButton::Left, |event, window, _| {
                    if event.click_count == 2 {
                        window.titlebar_double_click();
                    } else {
                        window.start_window_move();
                    }
                })
                .child({
                    let unread = desktop.unread_mentions().len();
                    div()
                        .relative()
                        .child(head_button("sidebar-inbox", Icon::new(IconName::Inbox), "Inbox (⇧⌘J)", "inbox.toggle", &p, cx))
                        .when(unread > 0, |d| {
                            d.child(
                                div()
                                    .absolute()
                                    .top(px(-1.))
                                    .right(px(-3.))
                                    .min_w(px(14.))
                                    .h(px(14.))
                                    .px(px(3.))
                                    .rounded_full()
                                    .bg(p.accent)
                                    .text_color(p.accent_ink)
                                    .text_size(px(9.5))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(unread.to_string()),
                            )
                        })
                })
                .child(head_button("sidebar-search", Icon::new(IconName::Search), "Go to thread (⌘T)", "palette.threads", &p, cx))
                .child(head_button(
                    "sidebar-archives",
                    Icon::default().path("syncpi/archive.svg").text_color(if desktop.archives { p.accent } else { p.muted }),
                    if desktop.archives { "Back to threads (⌘Y)" } else { "Archived threads (⌘Y)" },
                    "thread.archives",
                    &p,
                    cx,
                ))
                .child(head_button("sidebar-theme", Icon::new(if p.dark { IconName::Sun } else { IconName::Moon }), "Switch light or dark (⇧⌘L)", "app.theme", &p, cx))
                .child(
                    div()
                        .id("new-thread")
                        .p(px(5.))
                        .rounded(px(5.))
                        .text_color(p.muted)
                        .hover(|s| s.bg(p.rule).text_color(p.ink))
                        .cursor_pointer()
                        .child(Icon::new(IconName::Plus).size(px(16.)))
                        .tooltip(tooltip("New thread (⌘N)".into()))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(|this, _, window, cx| this.new_thread(None, window, cx))),
                ),
        )
        .child(list)
        .when_some(desktop.error.clone(), |d, error| d.child(div().px_3().py_2().text_size(sz(12.)).text_color(p.removed).child(error)))
        .into_any_element()
}
