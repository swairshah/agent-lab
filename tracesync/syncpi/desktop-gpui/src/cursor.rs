// A text cursor in the thread, as in Delta: a caret that moves through the messages' text like in a document. Left
// and Right move by character, Up and Down by line (keeping the column), across messages; Shift or a mouse drag
// selects; Enter comments on the selection (or the caret's line) with the box right under it; Esc clears. Up from the
// composer's first line puts the caret at the end of the thread, and Down past the end goes back.
//
// Messages are drawn by free functions (message.rs, prose.rs), so each text registers itself here as the frame
// renders, in order, with its layout and the thread row it's in; keys and clicks move through the texts of the frame
// before. Each text paints its own part of the selection and the caret (prose::visual_lines). The thread is a
// virtual list: only rows on screen are laid out, so a key that reaches a text off screen reveals its row and is
// tried again on the next tick (take_retry).
use gpui::{AnyElement, Hsla, ListState, Pixels, Point, TextLayout, point, px};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// A comment made on a message's text: it shows there, inline (as in Delta).
#[derive(Clone)]
pub struct Mark {
    pub excerpt: String,
    pub note: String,
    pub author: String,
}

/// A place in the thread's text: a text (by id) and a byte offset in it.
#[derive(Clone, Debug, PartialEq)]
pub struct Pos {
    pub id: String,
    pub index: usize,
}

#[derive(Clone)]
struct Text {
    id: String,
    message: String,
    text: String,
    layout: TextLayout,
    /// The thread row it's in.
    row: usize,
}

#[derive(Default)]
struct State {
    drawing: Vec<Text>,
    last: Vec<Text>,
    caret: Option<Pos>,
    anchor: Option<Pos>,
    /// The column Up and Down keep to.
    goal_x: Option<Pixels>,
    dragging: bool,
    clicked: bool,
    focused: bool,
    tint: Option<Hsla>,
    caret_color: Option<Hsla>,
    /// An element to draw right after the block with this id (the comment box).
    after: Option<(String, AnyElement)>,
    follow: bool,
    scroll: Option<ListState>,
    /// The thread row being built, and a key to try again once an off-screen row is revealed.
    row: usize,
    retry: Option<(String, bool)>,
    /// Texts painted this frame and the last: only those are laid out (the rest are off screen).
    painted: HashSet<String>,
    painted_before: HashSet<String>,
    /// The comment box just opened: scroll it into view when it's drawn.
    reveal_box: bool,
    /// Comments by the message they're on, the ones already placed this frame, and their color.
    marks: HashMap<String, Vec<Mark>>,
    placed: HashSet<(String, usize)>,
    mark_color: Option<Hsla>,
    /// Where each text is in the order, and the selection as (text order, offset) pairs, worked out once per frame
    /// on the first paint rather than by every text.
    order: Option<(
        HashMap<String, usize>,
        Option<((usize, usize), (usize, usize))>,
    )>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// The message key in an id like "assistant-12-block-0-3" or "user-live:4-block-1".
fn message_of(id: &str) -> String {
    let rest = id.split_once('-').map_or(id, |(_, rest)| rest);
    rest.split("-block").next().unwrap_or(rest).to_owned()
}

/// Starts a frame: the selection tint, the caret color, whether the thread has focus (the caret shows only then),
/// and the comment box to draw under its block.
pub fn begin(
    tint: Hsla,
    caret: Hsla,
    focused: bool,
    after: Option<(String, AnyElement)>,
    scroll: &ListState,
) {
    STATE.with_borrow_mut(|s| {
        if !s.drawing.is_empty() {
            s.last = std::mem::take(&mut s.drawing);
            s.painted_before = std::mem::take(&mut s.painted);
        }
        s.tint = Some(tint);
        s.caret_color = Some(caret);
        s.focused = focused;
        s.after = after;
        s.scroll = Some(scroll.clone());
        s.placed.clear();
        s.order = None;
    });
}

/// This frame's comments on messages, by message key, and the color they're marked in.
pub fn set_marks(marks: HashMap<String, Vec<Mark>>, color: Hsla) {
    STATE.with_borrow_mut(|s| {
        s.marks = marks;
        s.mark_color = Some(color);
    });
}

fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The byte ranges of `full` (text `id`) that comments were made on, and their color.
pub fn marked(id: &str, full: &str) -> (Vec<(usize, usize)>, Option<Hsla>) {
    STATE.with_borrow(|s| {
        let mut ranges = vec![];
        for mark in s.marks.get(&message_of(id)).into_iter().flatten() {
            for line in mark
                .excerpt
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
            {
                if let Some(at) = full.find(line) {
                    ranges.push((at, at + line.len()));
                }
            }
        }
        (ranges, s.mark_color)
    })
}

/// The comments to show under block `id` (whose text is `text`): those on its message whose text is in it, not
/// already shown under an earlier block.
pub fn notes_under(id: &str, text: &str) -> Vec<Mark> {
    STATE.with_borrow_mut(|s| {
        let message = message_of(id);
        let block = squash(text);
        let mut out = vec![];
        for (n, mark) in s
            .marks
            .get(&message)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let first = mark
                .excerpt
                .lines()
                .map(squash)
                .find(|l| !l.is_empty())
                .unwrap_or_default();
            let probe: String = first.chars().take(80).collect();
            if !probe.is_empty() && block.contains(&probe) && s.placed.insert((message.clone(), n))
            {
                out.push(mark);
            }
        }
        out
    })
}

fn texts(s: &State) -> &Vec<Text> {
    if s.drawing.is_empty() {
        &s.last
    } else {
        &s.drawing
    }
}

/// The thread row the texts registered next are in.
pub fn row(index: usize) {
    STATE.with_borrow_mut(|s| s.row = index);
}

/// A key that reached a text off screen: its row has been revealed, so try it again (from the app's poll).
pub fn take_retry() -> Option<(String, bool)> {
    STATE.with_borrow_mut(|s| s.retry.take())
}

/// Brings the row of text `id` on screen, and the comment box that opens under it into view once it's drawn.
pub fn reveal_box(id: &str) {
    STATE.with_borrow_mut(|s| {
        if let (Some(list), Some(t)) = (&s.scroll, texts(s).iter().find(|t| t.id == id)) {
            list.scroll_to_reveal_item(t.row);
        }
        s.reveal_box = true;
    });
}

/// Whether the comment box should scroll itself into view (taken once).
pub fn take_reveal_box() -> bool {
    STATE.with_borrow_mut(|s| std::mem::take(&mut s.reveal_box))
}

/// Registers a text as it's drawn. Only messages' texts take the cursor.
pub fn register(id: &str, text: &str, layout: &TextLayout) {
    if !(id.starts_with("assistant-") || id.starts_with("user-")) {
        return;
    }
    STATE.with_borrow_mut(|s| {
        s.drawing.push(Text {
            id: id.to_owned(),
            message: message_of(id),
            text: text.to_owned(),
            layout: layout.clone(),
            row: s.row,
        })
    });
}

/// What a text paints: its selected byte range, the caret's offset if it's in it, and the colors.
pub struct Paint {
    pub selected: Option<(usize, usize)>,
    pub caret: Option<usize>,
    pub tint: Hsla,
    pub caret_color: Hsla,
    /// The caret just moved here: scroll it into view.
    pub follow: bool,
}

pub fn paint_for(id: &str, len: usize) -> Option<Paint> {
    STATE.with_borrow_mut(|s| {
        s.painted.insert(id.to_owned());
        let (tint, caret_color) = (s.tint?, s.caret_color?);
        if s.order.is_none() {
            let order: HashMap<String, usize> = texts(s)
                .iter()
                .enumerate()
                .map(|(n, t)| (t.id.clone(), n))
                .collect();
            let range = match (&s.anchor, &s.caret) {
                (Some(a), Some(b)) if a != b => match (order.get(&a.id), order.get(&b.id)) {
                    (Some(&oa), Some(&ob)) => Some(if (oa, a.index) <= (ob, b.index) {
                        ((oa, a.index), (ob, b.index))
                    } else {
                        ((ob, b.index), (oa, a.index))
                    }),
                    _ => None,
                },
                _ => None,
            };
            s.order = Some((order, range));
        }
        let (order, range) = s.order.as_ref()?;
        let me = *order.get(id)?;
        let selected = range.and_then(|(start, end)| {
            if !(start.0 <= me && me <= end.0) {
                return None;
            }
            let from = if me == start.0 { start.1 } else { 0 };
            let to = if me == end.0 { end.1 } else { len };
            (from < to).then_some((from, to.min(len)))
        });
        let caret = s
            .caret
            .as_ref()
            .filter(|c| c.id == id && s.focused)
            .map(|c| c.index.min(len));
        let follow = caret.is_some() && std::mem::take(&mut s.follow);
        Some(Paint {
            selected,
            caret,
            tint,
            caret_color,
            follow,
        })
    })
}

pub fn scroll() -> Option<ListState> {
    STATE.with_borrow(|s| s.scroll.clone())
}

/// The element to draw right under the block `id` when the comment box belongs to it (taken once).
pub fn after(id: &str) -> Option<AnyElement> {
    STATE.with_borrow_mut(|s| {
        let mine = |at: &str| at == id || at.starts_with(&format!("{id}-"));
        if s.after.as_ref().is_some_and(|(at, _)| mine(at)) {
            s.after.take().map(|(_, e)| e)
        } else {
            None
        }
    })
}

/// A press on a text: the caret goes there (Shift keeps the selection's start), and a drag can follow.
pub fn press(id: &str, index: usize, shift: bool) {
    STATE.with_borrow_mut(|s| {
        let pos = Pos {
            id: id.to_owned(),
            index,
        };
        if !(shift && s.caret.is_some()) {
            s.anchor = Some(pos.clone());
        }
        s.caret = Some(pos);
        s.goal_x = None;
        s.dragging = true;
        s.clicked = true;
    });
}

/// The pointer moved over a text with the button down: the selection follows it.
pub fn drag(id: &str, index: usize) -> bool {
    STATE.with_borrow_mut(|s| {
        if !s.dragging {
            return false;
        }
        let pos = Pos {
            id: id.to_owned(),
            index,
        };
        if s.caret.as_ref() == Some(&pos) {
            return false;
        }
        s.caret = Some(pos);
        true
    })
}

pub fn release() {
    STATE.with_borrow_mut(|s| s.dragging = false);
}

/// Whether a text was pressed since last asked (the thread then takes focus).
pub fn take_click() -> bool {
    STATE.with_borrow_mut(|s| std::mem::take(&mut s.clicked))
}

pub fn clear() {
    STATE.with_borrow_mut(|s| {
        s.caret = None;
        s.anchor = None;
        s.goal_x = None;
    });
}

/// Puts the caret at the end of the thread's text. Returns false when there's no text.
pub fn to_end() -> bool {
    STATE.with_borrow_mut(|s| {
        let Some(last) = texts(s).last().cloned() else {
            return false;
        };
        let pos = Pos {
            id: last.id,
            index: last.text.len(),
        };
        s.anchor = Some(pos.clone());
        s.caret = Some(pos);
        s.goal_x = None;
        s.follow = true;
        true
    })
}

fn safe<T>(f: impl FnOnce() -> T) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).ok()
}

fn index_at(layout: &TextLayout, at: Point<Pixels>) -> usize {
    match layout.index_for_position(at) {
        Ok(i) | Err(i) => i,
    }
}

/// What a key did.
pub enum Moved {
    /// Nothing (not a cursor key, or no caret).
    No,
    /// The caret moved, or the selection changed.
    Yes,
    /// Down past the end of the thread: back to the composer.
    Out,
}

/// Arrow keys: Left/Right by character, Up/Down by line keeping the column; Shift extends the selection.
pub fn key(key: &str, shift: bool) -> Moved {
    STATE.with_borrow_mut(|s| {
        let Some(caret) = s.caret.clone() else {
            return Moved::No;
        };
        let list = texts(s).clone();
        let Some(at) = list.iter().position(|t| t.id == caret.id) else {
            return Moved::No;
        };
        let here = &list[at];
        let index = caret.index.min(here.text.len());
        // The caret's text, or the one a key moves into, isn't laid out (off screen): reveal its row, try again.
        let painted = if s.drawing.is_empty() {
            &s.painted_before
        } else {
            &s.painted
        };
        let painted = painted.clone();
        let laid_out = |t: &Text| painted.contains(&t.id);
        let reveal = |t: &Text, s: &mut State| {
            if let Some(list) = &s.scroll {
                list.scroll_to_reveal_item(t.row);
            }
            s.retry = Some((key.to_owned(), shift));
            Moved::Yes
        };
        if (key == "up" || key == "down") && !laid_out(here) {
            return reveal(here, s);
        }
        let next = match key {
            "left" => {
                if index > 0 {
                    let i = here.text[..index]
                        .char_indices()
                        .last()
                        .map_or(0, |(i, _)| i);
                    Some(Pos {
                        id: here.id.clone(),
                        index: i,
                    })
                } else {
                    at.checked_sub(1).and_then(|i| list.get(i)).map(|t| Pos {
                        id: t.id.clone(),
                        index: t.text.len(),
                    })
                }
            }
            "right" => {
                if index < here.text.len() {
                    let i = here.text[index..]
                        .char_indices()
                        .nth(1)
                        .map_or(here.text.len(), |(i, _)| index + i);
                    Some(Pos {
                        id: here.id.clone(),
                        index: i,
                    })
                } else {
                    list.get(at + 1).map(|t| Pos {
                        id: t.id.clone(),
                        index: 0,
                    })
                }
            }
            "up" | "down" => {
                let Some(Some(p)) = safe(|| here.layout.position_for_index(index)) else {
                    return Moved::No;
                };
                let Some(height) = safe(|| here.layout.line_height()) else {
                    return Moved::No;
                };
                let Some(bounds) = safe(|| here.layout.bounds()) else {
                    return Moved::No;
                };
                let x = *s.goal_x.get_or_insert(p.x);
                let y = if key == "up" {
                    p.y - height * 0.5
                } else {
                    p.y + height * 1.5
                };
                if y >= bounds.top() && y < bounds.bottom() {
                    Some(Pos {
                        id: here.id.clone(),
                        index: index_at(&here.layout, point(x, y)),
                    })
                } else {
                    // Into the text before or after, on its last or first line.
                    let other = if key == "up" {
                        at.checked_sub(1).and_then(|i| list.get(i))
                    } else {
                        list.get(at + 1)
                    };
                    match other {
                        Some(t) if !laid_out(t) => return reveal(t, s),
                        Some(t) => safe(|| {
                            let b = t.layout.bounds();
                            let h = t.layout.line_height();
                            let y = if key == "up" {
                                b.bottom() - h * 0.5
                            } else {
                                b.top() + h * 0.5
                            };
                            Pos {
                                id: t.id.clone(),
                                index: index_at(&t.layout, point(x.max(b.left()), y)),
                            }
                        }),
                        None if key == "down" => {
                            s.caret = None;
                            s.anchor = None;
                            s.goal_x = None;
                            return Moved::Out;
                        }
                        None => None,
                    }
                }
            }
            _ => return Moved::No,
        };
        let Some(next) = next else { return Moved::Yes };
        if key == "left" || key == "right" {
            s.goal_x = None;
        }
        if !shift {
            s.anchor = Some(next.clone());
        }
        s.caret = Some(next);
        s.follow = true;
        Moved::Yes
    })
}

/// What Enter comments on: the selected text, or the caret's line; with the message key and the block to put the
/// box under.
pub fn quote() -> Option<(String, String, String)> {
    STATE.with_borrow(|s| {
        let list = texts(s);
        let (a, b) = (s.anchor.as_ref()?, s.caret.as_ref()?);
        let order = |p: &Pos| list.iter().position(|t| t.id == p.id);
        let (oa, ob) = (order(a)?, order(b)?);
        let ((i, from), (j, to)) = if (oa, a.index) <= (ob, b.index) {
            ((oa, a.index), (ob, b.index))
        } else {
            ((ob, b.index), (oa, a.index))
        };
        if (i, from) == (j, to) {
            // No selection: the line the caret is on.
            let t = &list[i];
            let line = safe(|| {
                let p = t.layout.position_for_index(from)?;
                let b = t.layout.bounds();
                let start = index_at(&t.layout, point(b.left(), p.y + px(1.)));
                let end = index_at(&t.layout, point(b.right(), p.y + px(1.)));
                Some((start, end.max(start)))
            })
            .flatten()
            .unwrap_or((0, t.text.len()));
            let text = t
                .text
                .get(line.0..line.1)
                .unwrap_or(&t.text)
                .trim()
                .to_owned();
            return (!text.is_empty()).then(|| (t.message.clone(), text, t.id.clone()));
        }
        let mut parts = vec![];
        for (k, t) in list.iter().enumerate().take(j + 1).skip(i) {
            let start = if k == i { from } else { 0 };
            let end = if k == j { to } else { t.text.len() };
            parts.push(t.text.get(start..end).unwrap_or("").to_owned());
        }
        let text = parts.join("\n").trim().to_owned();
        (!text.is_empty()).then(|| (list[i].message.clone(), text, list[j].id.clone()))
    })
}
