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

/// The visual line of `layout` under a point, 0 when it isn't laid out yet.
fn line_at(layout: &TextLayout, y: Pixels) -> usize {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let bounds = layout.bounds();
        let height = layout.line_height();
        if height <= px(0.) {
            return 0;
        }
        (f32::from((y - bounds.top()).max(px(0.))) / f32::from(height)) as usize
    }))
    .unwrap_or(0)
}

/// Text whose lines on screen are stops of the thread's cursor (cursor.rs): each visual line is registered (from the
/// line starts measured the last time it was drawn), tinted when selected, and clickable; after layout, the line
/// starts are measured again, and the line the cursor moved to is scrolled into view.
pub(crate) fn visual_lines(
    id: &str,
    full: &str,
    styled: StyledText,
    p: &Palette,
    wrap: impl FnOnce(StyledText) -> AnyElement,
) -> AnyElement {
    let layout = styled.layout().clone();
    let len = full.len();
    let starts = crate::cursor::starts(id, len);
    let mut tinted: Vec<(usize, Hsla)> = vec![];
    for (k, start) in starts.iter().enumerate() {
        let end = starts.get(k + 1).copied().unwrap_or(len).min(len);
        let text = full.get(*start..end).unwrap_or("");
        if let Some(tint) = crate::cursor::line(&format!("{id}#{k}"), text) {
            tinted.push((k, tint));
        }
    }
    let line_count = starts.len();
    let (measure, click, follow_id) = (layout.clone(), layout.clone(), id.to_owned());
    let click_id = id.to_owned();
    let _ = p;
    div()
        .relative()
        .w_full()
        .min_w_0()
        .child(
            // Under the text: measures its visual lines and tints the selected ones.
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    let Ok(text_bounds) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| measure.bounds()))
                    else {
                        return;
                    };
                    let height = measure.line_height();
                    if height <= px(0.) {
                        return;
                    }
                    let width = f32::from(text_bounds.size.width);
                    let lines = (f32::from(text_bounds.size.height) / f32::from(height))
                        .round()
                        .max(1.) as usize;
                    if !crate::cursor::measured(&follow_id, len, width) || lines != line_count {
                        let mut found = vec![0];
                        for k in 1..lines {
                            let y = text_bounds.top() + height * (k as f32 + 0.5);
                            let index =
                                match measure.index_for_position(point(text_bounds.left(), y)) {
                                    Ok(i) | Err(i) => i,
                                };
                            if index > *found.last().unwrap() && index < len {
                                found.push(index);
                            }
                        }
                        if crate::cursor::store_starts(&follow_id, len, width, found) {
                            window.refresh();
                        }
                    }
                    for (k, tint) in &tinted {
                        let top = text_bounds.top() + height * *k as f32;
                        window.paint_quad(fill(
                            Bounds::new(point(bounds.left(), top), size(bounds.size.width, height)),
                            *tint,
                        ));
                    }
                    // The cursor moved to one of these lines: keep it in view.
                    for k in 0..line_count {
                        if let Some(scroll) =
                            crate::cursor::take_follow(&format!("{follow_id}#{k}"))
                        {
                            let top = text_bounds.top() + height * k as f32;
                            let view = scroll.bounds();
                            let mut offset = scroll.offset();
                            let margin = height * 2.;
                            if top < view.top() + margin {
                                offset.y += view.top() + margin - top;
                            } else if top + height > view.bottom() - margin {
                                offset.y -= top + height - (view.bottom() - margin);
                            }
                            scroll.set_offset(offset);
                            window.refresh();
                        }
                    }
                },
            )
            .absolute()
            .inset_0(),
        )
        .child(wrap(styled))
        .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, _, _| {
            let k = line_at(&click, e.position.y).min(line_count.saturating_sub(1));
            crate::cursor::click(&format!("{click_id}#{k}"));
        })
        .into_any_element()
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
