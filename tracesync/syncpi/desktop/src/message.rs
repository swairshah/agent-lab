// Native message blocks grow to their content. Wide tables and code scroll inside their own bounds.
use gpui::{prelude::FluentBuilder, *};
use gpui_component::ActiveTheme;
use markdown::{ParseOptions, mdast::Node};

#[derive(Debug, PartialEq)]
pub enum Block {
    Prose(String),
    Table(Vec<Vec<String>>),
    Code {
        language: String,
        content: String,
    },
    List {
        start: Option<u32>,
        items: Vec<(Option<bool>, String)>,
    },
    /// A GitHub alert: > [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
    Alert {
        kind: String,
        body: String,
    },
}

/// The alert a blockquote's text starts with, and the rest of its text without the quote markers.
fn alert(quoted: &str) -> Option<(String, String)> {
    let text: String = quoted
        .lines()
        .map(|line| {
            line.trim_start()
                .strip_prefix('>')
                .map_or(line, |l| l.strip_prefix(' ').unwrap_or(l))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let rest = text.trim_start().strip_prefix("[!")?;
    let (kind, body) = rest.split_once(']')?;
    ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
        .contains(&kind)
        .then(|| (kind.to_owned(), body.trim().to_owned()))
}
pub fn blocks(source: &str) -> Vec<Block> {
    let Ok(Node::Root(root)) = markdown::to_mdast(source, &ParseOptions::gfm()) else {
        return vec![Block::Prose(source.into())];
    };
    let mut result = vec![];
    for node in root.children {
        let Some(position) = node.position() else {
            continue;
        };
        let begin = position.start.offset;
        let end = position.end.offset;
        let replacement = match &node {
            Node::Table(table) => Some(Block::Table(
                table
                    .children
                    .iter()
                    .filter_map(|row| {
                        let Node::TableRow(row) = row else {
                            return None;
                        };
                        Some(
                            row.children
                                .iter()
                                .map(|cell| {
                                    cell.children()
                                        .and_then(|children| {
                                            let first = children.first()?.position()?;
                                            let last = children.last()?.position()?;
                                            source.get(first.start.offset..last.end.offset)
                                        })
                                        .unwrap_or("")
                                        .trim()
                                        .to_owned()
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            )),
            Node::Code(code) => Some(Block::Code {
                language: code.lang.clone().unwrap_or_default(),
                content: code.value.clone(),
            }),
            Node::List(list) => Some(Block::List {
                start: if list.ordered {
                    Some(list.start.unwrap_or(1))
                } else {
                    None
                },
                items: list
                    .children
                    .iter()
                    .filter_map(|item| {
                        let Node::ListItem(item) = item else {
                            return None;
                        };
                        let first = item.children.first()?.position()?;
                        let last = item.children.last()?.position()?;
                        let source = source.get(first.start.offset..last.end.offset)?.to_owned();
                        Some((item.checked, source))
                    })
                    .collect(),
            }),
            Node::Blockquote(_) => match alert(source.get(begin..end).unwrap_or("")) {
                Some((kind, body)) => Some(Block::Alert { kind, body }),
                None => Some(Block::Prose(
                    source.get(begin..end).unwrap_or("").to_owned(),
                )),
            },
            _ => Some(Block::Prose(
                source.get(begin..end).unwrap_or("").to_owned(),
            )),
        };
        if let Some(block) = replacement {
            result.push(block);
        }
    }
    result
}
pub fn render(id: &str, source: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let border = cx.theme().border;
    let muted = cx.theme().muted_foreground;
    let mut container = div()
        .w_full()
        .h_auto()
        .min_w_0()
        .flex()
        .flex_col()
        .gap_3()
        .flex_shrink_0();
    for (index, block) in blocks(source).into_iter().enumerate() {
        let block_id = format!("{id}-block-{index}");
        match block {
            Block::Prose(source) => {
                container = container.child(crate::prose::render(&block_id, &source, cx));
            }
            Block::List { start, items } => {
                let mut list = div()
                    .w_full()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .flex_shrink_0();
                for (item_index, (checked, source)) in items.into_iter().enumerate() {
                    let marker = match checked {
                        Some(true) => {
                            gpui_component::Icon::new(gpui_component::IconName::CircleCheck)
                                .size_3()
                                .into_any_element()
                        }
                        Some(false) => gpui_component::Icon::new(gpui_component::IconName::Minus)
                            .size_3()
                            .into_any_element(),
                        None => div()
                            .child(
                                start
                                    .map(|n| format!("{}.", n as usize + item_index))
                                    .unwrap_or_else(|| "•".into()),
                            )
                            .into_any_element(),
                    };
                    list = list.child(
                        div()
                            .w_full()
                            .min_w_0()
                            .flex()
                            .items_start()
                            .gap_2()
                            .flex_shrink_0()
                            .child(div().w(px(18.)).flex_shrink_0().child(marker))
                            .child(div().flex_1().min_w_0().child(render(
                                &format!("{block_id}-item-{item_index}"),
                                &source,
                                window,
                                cx,
                            ))),
                    );
                }
                container = container.child(list);
            }
            Block::Code { language, content } if language == "mermaid" => {
                container = container.child(crate::diagram::view(
                    &block_id,
                    &content,
                    crate::transcript::content_width(),
                    cx,
                ));
            }
            Block::Alert { kind, body } => {
                let p = crate::theme::palette(cx);
                let color = match kind.as_str() {
                    "NOTE" => hsla(215. / 360., 0.5, 0.47, 1.),
                    "TIP" => p.ok,
                    "IMPORTANT" => hsla(266. / 360., 0.45, 0.52, 1.),
                    "WARNING" => p.warn,
                    _ => p.removed,
                };
                container = container.child(
                    div()
                        .w_full()
                        .flex_shrink_0()
                        .pl_3()
                        .pr_3()
                        .py_2()
                        .border_l_3()
                        .border_color(color)
                        .bg(color.opacity(0.07))
                        .rounded_r(px(8.))
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(crate::theme::sz(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(color)
                                .child(kind.to_uppercase()),
                        )
                        .child(render(&format!("{block_id}-alert"), &body, window, cx)),
                );
            }
            Block::Code { language, content } => {
                let copy = content.clone();
                container = container.child(
                    div()
                        .w_full()
                        .min_w_0()
                        .flex_shrink_0()
                        .rounded_md()
                        .border_1()
                        .border_color(border)
                        .overflow_hidden()
                        .child(
                            div()
                                .h(px(28.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .px_3()
                                .bg(cx.theme().muted)
                                .text_xs()
                                .text_color(muted)
                                .child(if language.is_empty() {
                                    "Code".into()
                                } else {
                                    language.clone()
                                })
                                .child(
                                    gpui_component::button::Button::new(SharedString::from(
                                        format!("copy-{block_id}"),
                                    ))
                                    .ghost()
                                    .xsmall()
                                    .icon(gpui_component::IconName::Copy)
                                    .tooltip("Copy code")
                                    .on_click(
                                        move |_, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                copy.clone(),
                                            ))
                                        },
                                    ),
                                ),
                        )
                        .child(
                            div()
                                .id(SharedString::from(block_id))
                                .w_full()
                                .min_w_0()
                                .overflow_x_scroll()
                                .px_3()
                                .py_3()
                                .font_family(crate::theme::MONO)
                                .text_size(crate::theme::sz(12.5))
                                .line_height(relative(1.6))
                                .child(
                                    div()
                                        .min_w_full()
                                        .flex_shrink_0()
                                        .whitespace_nowrap()
                                        .child(highlighted(&language, content, cx)),
                                ),
                        ),
                );
            }
            Block::Table(rows) => {
                let columns = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
                let mut table = div()
                    .w_full()
                    .min_w(px((columns as f32 * 170.).min(1000.)))
                    .h_auto()
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .border_1()
                    .border_color(border)
                    .rounded_md()
                    .overflow_hidden();
                let row_count = rows.len();
                for (row_index, row) in rows.into_iter().enumerate() {
                    let mut line = div()
                        .w_full()
                        .min_w_0()
                        .h_auto()
                        .flex()
                        .flex_shrink_0()
                        .when(row_index == 0, |d| d.bg(cx.theme().muted))
                        .when(row_index + 1 < row_count, |d| {
                            d.border_b_1().border_color(border)
                        });
                    for column in 0..columns {
                        let content = row.get(column).cloned().unwrap_or_default();
                        line = line.child(
                            div()
                                .flex_1()
                                .flex_basis(px(0.))
                                .min_w_0()
                                .h_auto()
                                .px_3()
                                .py_2()
                                .whitespace_normal()
                                .when(row_index == 0, |d| d.font_weight(FontWeight::MEDIUM))
                                .when(column + 1 < columns, |d| {
                                    d.border_r_1().border_color(border)
                                })
                                .child(crate::prose::render(
                                    &format!("{block_id}-row-{row_index}-cell-{column}"),
                                    &content,
                                    cx,
                                )),
                        );
                    }
                    table = table.child(line);
                }
                container = container.child(
                    div()
                        .id(SharedString::from(block_id))
                        .w_full()
                        .min_w_0()
                        .h_auto()
                        .flex_shrink_0()
                        .overflow_x_scroll()
                        .child(table),
                );
            }
        }
    }
    container.into_any_element()
}
use gpui_component::Sizable;
use gpui_component::button::ButtonVariants;

#[cfg(test)]
mod tests {
    use super::{Block, blocks};
    #[test]
    fn gfm_tables_preserve_inline_content_and_escaped_pipes() {
        let source = "Intro.\n\n| Before | After |\n| --- | --- |\n| `a\\|b` | **native** |\n\nAfter the table.";
        let parsed = blocks(source);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0], Block::Prose("Intro.".into()));
        let Block::Table(rows) = &parsed[1] else {
            panic!("Expected a table");
        };
        assert_eq!(rows[1], vec!["`a\\|b`", "**native**"]);
        assert_eq!(parsed[2], Block::Prose("After the table.".into()));
    }
    #[test]
    fn list_items_keep_their_own_content_and_nested_blocks() {
        let parsed = blocks(
            "3. First **item**\n4. Second item\n\n- [x] Complete\n- [ ] Pending\n  - Nested",
        );
        let Block::List { start, items } = &parsed[0] else {
            panic!("Expected ordered list");
        };
        assert_eq!(*start, Some(3));
        assert_eq!(
            items,
            &vec![
                (None, "First **item**".into()),
                (None, "Second item".into())
            ]
        );
        let Block::List { items, .. } = &parsed[1] else {
            panic!("Expected task list");
        };
        assert_eq!(items[0], (Some(true), "Complete".into()));
        assert_eq!(items[1].0, Some(false));
        assert!(items[1].1.contains("- Nested"));
    }
    #[test]
    fn code_fences_with_table_syntax_and_unicode_are_not_tables() {
        let source = "Résumé 🦀\n\n```sh\nprintf '| a | b |'\n```\n\nFinished.";
        let parsed = blocks(source);
        assert_eq!(parsed[0], Block::Prose("Résumé 🦀".into()));
        assert_eq!(
            parsed[1],
            Block::Code {
                language: "sh".into(),
                content: "printf '| a | b |'".into()
            }
        );
        assert_eq!(parsed[2], Block::Prose("Finished.".into()));
    }
}

/// Code with syntax colors (tree-sitter, through gpui-component), kept per block and theme since a frame may draw it
/// many times. Unknown languages stay plain.
fn highlighted(language: &str, code: String, cx: &App) -> StyledText {
    use std::collections::HashMap;
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::sync::{Mutex, OnceLock};
    type Styles = Vec<(std::ops::Range<usize>, HighlightStyle)>;
    static CACHE: OnceLock<Mutex<HashMap<u64, Styles>>> = OnceLock::new();
    let theme = &cx.theme().highlight_theme;
    let mut hasher = DefaultHasher::new();
    (language, &code, cx.theme().is_dark()).hash(&mut hasher);
    let key = hasher.finish();
    let styles = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(key)
        .or_insert_with(|| {
            let mut highlighter =
                gpui_component::highlighter::SyntaxHighlighter::new(&language.to_lowercase());
            highlighter.update(None, &gpui_component::input::Rope::from_str(&code));
            highlighter.styles(&(0..code.len()), theme)
        })
        .clone();
    StyledText::new(code).with_highlights(styles)
}
