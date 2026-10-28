// A project file as Delta shows it: read-only, highlighted code where lines are selected by clicking, dragging or
// shift-clicking a line. A small comment icon sits on the selection, and the comment box opens right under the
// selected lines. "Edit" switches to the editor (main.rs) for changing the file.
use crate::theme::{self, MONO, Palette};
use crate::{Desktop, eid};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    ActiveTheme, Sizable,
    button::{Button, ButtonVariants},
    input::Input,
};
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock};

/// Lines past this are left to the editor, so a huge file stays quick to show.
const MAX_LINES: usize = 4000;

type LineStyles = Vec<Vec<(Range<usize>, HighlightStyle)>>;

/// Syntax colors for each line of `text`, cached for the file on screen.
fn line_styles(language: &str, text: &str, cx: &App) -> Arc<LineStyles> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    static LAST: OnceLock<Mutex<Option<(u64, Arc<LineStyles>)>>> = OnceLock::new();
    let mut hasher = DefaultHasher::new();
    (language, text, cx.theme().is_dark()).hash(&mut hasher);
    let key = hasher.finish();
    let mut last = LAST.get_or_init(Default::default).lock().unwrap();
    if let Some((k, styles)) = last.as_ref() {
        if *k == key {
            return styles.clone();
        }
    }
    let mut highlighter = gpui_component::highlighter::SyntaxHighlighter::new(language);
    highlighter.update(None, &gpui_component::input::Rope::from_str(text));
    let styles = highlighter.styles(&(0..text.len()), &cx.theme().highlight_theme);
    // Split the file's styles into each line's, with offsets from the line's start.
    let mut starts = vec![0];
    starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
    let mut lines: LineStyles = vec![vec![]; starts.len()];
    for (range, style) in styles {
        let mut line = starts
            .partition_point(|&s| s <= range.start)
            .saturating_sub(1);
        while line < starts.len() && starts[line] < range.end {
            let start = starts[line];
            let end = starts.get(line + 1).map_or(text.len(), |e| e - 1);
            let (a, b) = (range.start.max(start), range.end.min(end));
            if a < b {
                lines[line].push((a - start..b - start, style));
            }
            line += 1;
        }
    }
    let lines = Arc::new(lines);
    *last = Some((key, lines.clone()));
    lines
}

impl Desktop {
    /// The selected lines, first to last (1-based).
    pub(crate) fn selected_lines(&self) -> Option<(usize, usize)> {
        self.line_selection.map(|(a, b)| (a.min(b), a.max(b)))
    }

    /// Opens the comment box under the selected lines.
    pub(crate) fn comment_on_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lines) = self.selected_lines() else {
            return;
        };
        self.comment_lines = Some(lines);
        let (start, end) = lines;
        let placeholder = if start == end {
            format!("Comment on line {start}")
        } else {
            format!("Comment on lines {start}–{end}")
        };
        self.comment_input.update(cx, |input, cx| {
            input.set_placeholder(placeholder, window, cx);
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    fn select_line(&mut self, line: usize, extend: bool, cx: &mut Context<Self>) {
        self.line_selection = match (self.line_selection, extend) {
            (Some((anchor, _)), true) => Some((anchor, line)),
            // A second click on the only selected line clears it.
            (Some((a, b)), false) if a == line && b == line => None,
            _ => Some((line, line)),
        };
        self.line_drag = self.line_selection.is_some();
        self.comment_lines = None;
        cx.notify();
    }

    pub(crate) fn file_view(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = theme::palette(cx);
        let text = self.editor.read(cx).value().to_string();
        let styles = line_styles(crate::language_of(&self.file_path), &text, cx);
        let selected = self.selected_lines();
        let commenting = self.comment_lines;
        let mut list = div()
            .flex()
            .flex_col()
            .py_2()
            .font_family(MONO)
            .text_size(theme::sz(12.5))
            .line_height(theme::sz(20.));
        let count = text.split('\n').count();
        for (n, line) in text.split('\n').take(MAX_LINES).enumerate() {
            let number = n + 1;
            let in_selection = selected.is_some_and(|(a, b)| (a..=b).contains(&number));
            // The comment button hangs under the selection's last line, at its left edge.
            let last = selected.is_some_and(|(_, b)| b == number);
            let styled = StyledText::new(if line.is_empty() {
                " ".to_owned()
            } else {
                line.to_owned()
            })
            .with_highlights(styles.get(n).cloned().unwrap_or_default());
            list = list.child(
                div()
                    .id(eid(format!("line-{number}")))
                    .relative()
                    .flex()
                    .items_start()
                    .when(in_selection, |d| d.bg(p.accent.opacity(0.12)))
                    .cursor_text()
                    .child(
                        div()
                            .w(px(52.))
                            .flex_shrink_0()
                            .pr_3()
                            .text_right()
                            .text_color(if in_selection { p.accent } else { p.faint })
                            .child(number.to_string()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pr_3()
                            .whitespace_normal()
                            .child(styled),
                    )
                    // The comment icon sits on the selection's first line, as soon as lines are selected.
                    .when(last && commenting.is_none() && !self.line_drag, |d| {
                        // Painted after the lines below it, which it overlaps.
                        d.child(deferred(
                            div()
                                .id("comment-selection")
                                .absolute()
                                .left(px(44.))
                                .bottom(px(-13.))
                                .flex()
                                .items_center()
                                .gap_1()
                                .h(px(24.))
                                .pl(px(7.))
                                .pr(px(9.))
                                .rounded_full()
                                .bg(p.accent)
                                .text_color(p.accent_ink)
                                .shadow_md()
                                .cursor_pointer()
                                .font_family(theme::SANS)
                                .text_size(theme::sz(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .hover(|s| s.bg(p.accent.opacity(0.9)))
                                .child(
                                    svg()
                                        .path("syncpi/message-square.svg")
                                        .size(px(13.))
                                        .text_color(p.accent_ink),
                                )
                                .child("Comment")
                                .tooltip(|window, cx| {
                                    gpui_component::tooltip::Tooltip::new(
                                        "Comment on these lines (⌥⌘M)",
                                    )
                                    .build(window, cx)
                                })
                                // A click on the button isn't a click on the line under it.
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.comment_on_selection(window, cx)
                                })),
                        ))
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            this.select_line(number, e.modifiers.shift, cx)
                        }),
                    )
                    .on_mouse_move(cx.listener(move |this, e: &MouseMoveEvent, _, cx| {
                        // A drag ends when the button is up, wherever it was released.
                        if e.pressed_button != Some(MouseButton::Left) {
                            this.line_drag = false;
                        } else if this.line_drag {
                            if let Some((anchor, head)) = this.line_selection {
                                if head != number {
                                    this.line_selection = Some((anchor, number));
                                    cx.notify();
                                }
                            }
                        }
                    })),
            );
            // The comment box opens right under the lines it's about.
            if commenting.is_some_and(|(_, end)| end == number) {
                list = list.child(self.comment_box(&p, cx));
            }
        }
        if count > MAX_LINES {
            list = list.child(
                div()
                    .px_4()
                    .py_2()
                    .font_family(theme::SANS)
                    .text_color(p.muted)
                    .child(format!(
                        "{} more lines. Use Edit to see them.",
                        count - MAX_LINES
                    )),
            );
        }
        div()
            .id("file-view")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.file_scroll)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.line_drag = false;
                    cx.notify();
                }),
            )
            .child(list)
            .into_any_element()
    }

    fn comment_box(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        div()
            .pl(px(52.))
            .pr_3()
            .py_2()
            .font_family(theme::SANS)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_2()
                    .rounded(px(8.))
                    .bg(p.raised)
                    .shadow_sm()
                    .capture_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                        if e.keystroke.key == "escape" {
                            this.comment_lines = None;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    }))
                    .child(
                        Input::new(&self.comment_input)
                            .appearance(false)
                            .w_full()
                            .text_size(theme::sz(13.5)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap_1()
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(theme::sz(11.5))
                                    .text_color(p.muted)
                                    .child("⌘↩ to send, Esc to cancel"),
                            )
                            .child(
                                Button::new("cancel-comment")
                                    .ghost()
                                    .xsmall()
                                    .label("Cancel")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.comment_lines = None;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("send-comment")
                                    .primary()
                                    .xsmall()
                                    .label("Comment")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.send_comment(window, cx)
                                    })),
                            ),
                    ),
            )
    }
}
