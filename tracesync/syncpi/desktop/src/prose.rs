// Markdown prose (paragraphs, headings, quotes, rules) drawn with GPUI's own text element. gpui-component's TextView
// sized itself from an earlier layout, so long text measured shorter than it drew and ran over the next message, or
// was drawn at almost no width, one letter per line. StyledText measures against the width it gets. Links are
// clickable ranges: file citations (syncpi://open/..., see citations.rs) open in the app, web links in the browser.
use crate::theme::{self, MONO, Palette, SANS};

use gpui::*;
use markdown::mdast::Node;
use markdown::{ParseOptions, to_mdast};

/// Inline styles in effect while walking the tree.
#[derive(Clone, Copy, Default)]
struct Style {
    bold: bool,
    italic: bool,
    code: bool,
    strike: bool,
    link: bool,
}

/// Text with its runs and its links, built from inline nodes.
#[derive(Default)]
struct Inline {
    text: String,
    runs: Vec<TextRun>,
    links: Vec<(std::ops::Range<usize>, String)>,
}

impl Inline {
    fn push(&mut self, s: &str, style: Style, p: &Palette) {
        if s.is_empty() {
            return;
        }
        let mut font = font(if style.code { MONO } else { SANS });
        if style.bold {
            font.weight = FontWeight::SEMIBOLD;
        }
        if style.italic {
            font.style = FontStyle::Italic;
        }
        self.text.push_str(s);
        self.runs.push(TextRun {
            len: s.len(),
            font,
            color: if style.link { p.accent } else { p.ink },
            background_color: style.code.then_some(p.sunken),
            underline: style.link.then(|| UnderlineStyle {
                thickness: px(1.),
                color: Some(p.accent.opacity(0.5)),
                wavy: false,
            }),
            strikethrough: style.strike.then(|| StrikethroughStyle {
                thickness: px(1.),
                color: Some(p.muted),
            }),
        });
    }

    fn walk(&mut self, nodes: &[Node], style: Style, p: &Palette) {
        for node in nodes {
            match node {
                Node::Text(t) => self.push(&t.value, style, p),
                Node::Strong(n) => self.walk(
                    &n.children,
                    Style {
                        bold: true,
                        ..style
                    },
                    p,
                ),
                Node::Emphasis(n) => self.walk(
                    &n.children,
                    Style {
                        italic: true,
                        ..style
                    },
                    p,
                ),
                Node::Delete(n) => self.walk(
                    &n.children,
                    Style {
                        strike: true,
                        ..style
                    },
                    p,
                ),
                Node::InlineCode(c) => self.push(
                    &c.value,
                    Style {
                        code: true,
                        ..style
                    },
                    p,
                ),
                Node::InlineMath(m) => self.push(
                    &m.value,
                    Style {
                        code: true,
                        ..style
                    },
                    p,
                ),
                Node::Break(_) => self.push("\n", style, p),
                Node::Image(i) => self.push(&i.alt, style, p),
                Node::Html(h) => self.push(&h.value, style, p),
                Node::Link(l) => {
                    let start = self.text.len();
                    self.walk(
                        &l.children,
                        Style {
                            link: true,
                            ..style
                        },
                        p,
                    );
                    self.links.push((start..self.text.len(), l.url.clone()));
                }
                other => {
                    if let Some(children) = other.children() {
                        self.walk(children, style, p);
                    } else {
                        self.push(&other.to_string(), style, p);
                    }
                }
            }
        }
    }
}

/// Text that wraps to its width, with clickable links.
fn text(id: String, nodes: &[Node], p: &Palette) -> AnyElement {
    let mut inline = Inline::default();
    inline.walk(nodes, Style::default(), p);
    if inline.text.is_empty() {
        return div().into_any_element();
    }
    let (ranges, urls): (Vec<_>, Vec<_>) = inline.links.into_iter().unzip();
    let full = inline.text.clone();
    let styled = StyledText::new(inline.text).with_runs(inline.runs);
    if ranges.is_empty() {
        return visual_lines(&id, &full, styled, p, |s| s.into_any_element());
    }
    let link_id = id.clone();
    visual_lines(&id, &full, styled, p, move |styled| {
        InteractiveText::new(SharedString::from(link_id), styled)
            .on_click(ranges, move |index, window, cx| {
                let url: &String = &urls[index];
                if url.starts_with("syncpi://") {
                    crate::citations::handle_url(url);
                    window.refresh();
                } else if url.starts_with("http://")
                    || url.starts_with("https://")
                    || url.starts_with("mailto:")
                {
                    cx.open_url(url);
                }
            })
            .into_any_element()
    })
}

/// The byte offset in `layout` under a point; 0 when it isn't laid out yet.
fn index_at(layout: &TextLayout, at: Point<Pixels>) -> usize {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match layout.index_for_position(at) {
            Ok(i) | Err(i) => i,
        }
    }))
    .unwrap_or(0)
}

/// Text the thread's cursor moves through (cursor.rs): registered as it's drawn; a press puts the caret where it
/// lands and a drag selects; after layout it paints its part of the selection and the caret, and scrolls the caret
/// into view when it just moved here.
pub(crate) fn visual_lines(
    id: &str,
    full: &str,
    styled: StyledText,
    _p: &Palette,
    wrap: impl FnOnce(StyledText) -> AnyElement,
) -> AnyElement {
    let layout = styled.layout().clone();
    crate::cursor::register(id, full, &layout);
    let len = full.len();
    let (measure, press, drag) = (layout.clone(), layout.clone(), layout.clone());
    let (paint_id, press_id, drag_id) = (id.to_owned(), id.to_owned(), id.to_owned());
    div()
        .relative()
        .w_full()
        .min_w_0()
        .child(
            // Under the text: the selection, then the caret over it.
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let Some(paint) = crate::cursor::paint_for(&paint_id, len) else {
                        return;
                    };
                    let Ok((bounds, height)) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            (measure.bounds(), measure.line_height())
                        }))
                    else {
                        return;
                    };
                    if height <= px(0.) {
                        return;
                    }
                    let at = |i: usize| -> Option<Point<Pixels>> {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            measure.position_for_index(i)
                        }))
                        .ok()
                        .flatten()
                        .or_else(|| {
                            // The end of the text: just after its last character.
                            let last = full_len_prev(len);
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                measure.position_for_index(last)
                            }))
                            .ok()
                            .flatten()
                            .map(|p| point(p.x + height * 0.45, p.y))
                        })
                    };
                    if let Some((from, to)) = paint.selected {
                        if let (Some(a), Some(b)) = (at(from), at(to)) {
                            let mut y = a.y;
                            while y <= b.y + px(0.5) {
                                let left = if (y - a.y).abs() < px(0.5) {
                                    a.x
                                } else {
                                    bounds.left()
                                };
                                let right = if (y - b.y).abs() < px(0.5) {
                                    b.x
                                } else {
                                    bounds.right()
                                };
                                if right > left {
                                    window.paint_quad(fill(
                                        Bounds::new(point(left, y), size(right - left, height)),
                                        paint.tint,
                                    ));
                                }
                                y += height;
                            }
                        }
                    }
                    if let Some(index) = paint.caret {
                        if let Some(c) = at(index) {
                            window.paint_quad(fill(
                                Bounds::new(point(c.x - px(1.), c.y), size(px(2.), height)),
                                paint.caret_color,
                            ));
                            if paint.follow {
                                if let Some(scroll) = crate::cursor::scroll() {
                                    let view = scroll.bounds();
                                    let mut offset = scroll.offset();
                                    let margin = height * 2.;
                                    if c.y < view.top() + margin {
                                        offset.y += view.top() + margin - c.y;
                                    } else if c.y + height > view.bottom() - margin {
                                        offset.y -= c.y + height - (view.bottom() - margin);
                                    }
                                    scroll.set_offset(offset);
                                    window.refresh();
                                }
                            }
                        }
                    }
                },
            )
            .absolute()
            .inset_0(),
        )
        .child(wrap(styled))
        .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, _, _| {
            crate::cursor::press(&press_id, index_at(&press, e.position), e.modifiers.shift);
        })
        .on_mouse_move(move |e: &MouseMoveEvent, window, _| {
            if e.pressed_button == Some(MouseButton::Left)
                && crate::cursor::drag(&drag_id, index_at(&drag, e.position))
            {
                window.refresh();
            }
        })
        .on_mouse_up(MouseButton::Left, |_, _, _| crate::cursor::release())
        .into_any_element()
}

/// A position just before the end, for measuring where the end of a text is.
fn full_len_prev(len: usize) -> usize {
    len.saturating_sub(1)
}

fn block(id: String, node: &Node, p: &Palette) -> AnyElement {
    match node {
        Node::Paragraph(n) => div()
            .w_full()
            .min_w_0()
            .child(text(id, &n.children, p))
            .into_any_element(),
        Node::Heading(h) => {
            let size = match h.depth {
                1 => 22.,
                2 => 19.,
                3 => 16.5,
                _ => 15.,
            };
            div()
                .w_full()
                .min_w_0()
                .pt_2()
                .text_size(theme::sz(size))
                .line_height(theme::sz(size * 1.35))
                .font_weight(FontWeight::SEMIBOLD)
                .child(text(id, &h.children, p))
                .into_any_element()
        }
        Node::Blockquote(q) => div()
            .w_full()
            .min_w_0()
            .pl_3()
            .border_l_2()
            .border_color(p.rule_strong)
            .text_color(p.ink_2)
            .flex()
            .flex_col()
            .gap_2()
            .children(
                q.children
                    .iter()
                    .enumerate()
                    .map(|(n, child)| block(format!("{id}-{n}"), child, p)),
            )
            .into_any_element(),
        Node::ThematicBreak(_) => div()
            .w_full()
            .h(px(1.))
            .my_2()
            .bg(p.rule)
            .into_any_element(),
        other => div()
            .w_full()
            .min_w_0()
            .child(text(id, std::slice::from_ref(other), p))
            .into_any_element(),
    }
}

/// A block as a line of the thread's cursor (cursor.rs): tinted when selected, clickable, with the comment box
/// right under it when it's open there.
pub(crate) fn as_line(id: String, _text: &str, element: AnyElement) -> AnyElement {
    let after = crate::cursor::after(&id);
    let line = div().w_full().min_w_0().child(element);
    match after {
        Some(after) => div()
            .w_full()
            .flex()
            .flex_col()
            .gap_2()
            .child(line)
            .child(after)
            .into_any_element(),
        None => line.into_any_element(),
    }
}

/// Markdown prose as wrapping native text.
pub fn render(id: &str, source: &str, cx: &App) -> AnyElement {
    let p = theme::palette(cx);
    let nodes = match to_mdast(&crate::citations::rewrite(source), &ParseOptions::gfm()) {
        Ok(Node::Root(root)) => root.children,
        _ => return div().w_full().child(source.to_owned()).into_any_element(),
    };
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap_2()
        .children(nodes.iter().enumerate().map(|(n, node)| {
            let id = format!("{id}-{n}");
            as_line(id.clone(), &node.to_string(), block(id, node, &p))
        }))
        .into_any_element()
}
