// A line cursor in the thread, as in Delta (and the web view's text cursor): each line of a message as it's shown on
// screen (a wrapped line of a paragraph, a line of a code block) is a stop. Up and Down move between lines across messages, Shift extends a range, Enter
// comments on it with the box right under it, Esc clears. Up from the composer's first line enters at the bottom,
// and Down past the last line goes back to the composer.
//
// Messages are drawn by free functions (message.rs, prose.rs), so the lines they draw are collected here as the frame
// renders, in order; the next key press moves through the list from the frame before.
use gpui::{AnyElement, Hsla, ScrollHandle};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
pub struct Line {
    /// The element id of the line's block, stable across frames.
    pub id: String,
    /// The key of the message it's in.
    pub message: String,
    pub text: String,
}

#[derive(Default)]
struct Frame {
    drawing: Vec<Line>,
    last: Vec<Line>,
    highlight: HashSet<String>,
    tint: Option<Hsla>,
    /// An element to draw right after the line with this id (the comment box).
    after: Option<(String, AnyElement)>,
    clicked: Option<String>,
    /// Where each text's visual lines start (byte offsets), measured after layout, keyed by the text's id, with the
    /// text's length and width they were measured at.
    starts: HashMap<String, (usize, f32, Vec<usize>)>,
    /// The line to scroll into view once it's drawn, and the thread's scroll handle.
    follow: Option<String>,
    scroll: Option<ScrollHandle>,
}

thread_local! {
    static FRAME: RefCell<Frame> = RefCell::new(Frame::default());
}

/// Starts collecting a frame's lines; `highlight` are the ids to tint, `after` goes right under its line.
pub fn begin(
    highlight: HashSet<String>,
    tint: Hsla,
    after: Option<(String, AnyElement)>,
    scroll: &ScrollHandle,
) {
    FRAME.with_borrow_mut(|f| {
        f.scroll = Some(scroll.clone());
        if !f.drawing.is_empty() {
            f.last = std::mem::take(&mut f.drawing);
        }
        f.highlight = highlight;
        f.tint = Some(tint);
        f.after = after;
    });
}

/// The message key in an id like "assistant-12-block-0-3" or "user-live:4-block-1".
fn message_of(id: &str) -> String {
    let rest = id.split_once('-').map_or(id, |(_, rest)| rest);
    rest.split("-block").next().unwrap_or(rest).to_owned()
}

/// Records a line as it's drawn; returns the tint to draw it with, if it's in the selection.
pub fn line(id: &str, text: &str) -> Option<Hsla> {
    FRAME.with_borrow_mut(|f| {
        if !(id.starts_with("assistant-") || id.starts_with("user-")) {
            return None;
        }
        f.drawing.push(Line {
            id: id.to_owned(),
            message: message_of(id),
            text: text.trim().to_owned(),
        });
        if f.highlight.contains(id) {
            f.tint
        } else {
            None
        }
    })
}

/// The element to draw right under the block `id` when the box belongs to one of its lines, if any (taken once).
pub fn after(id: &str) -> Option<AnyElement> {
    FRAME.with_borrow_mut(|f| {
        let in_block = |at: &str| {
            let block = at.split('#').next().unwrap_or(at);
            block == id || block.starts_with(&format!("{id}-"))
        };
        if f.after.as_ref().is_some_and(|(at, _)| in_block(at)) {
            f.after.take().map(|(_, e)| e)
        } else {
            None
        }
    })
}

/// The lines of the last frame drawn, in order.
pub fn lines() -> Vec<Line> {
    FRAME.with_borrow(|f| {
        if f.drawing.is_empty() {
            f.last.clone()
        } else {
            f.drawing.clone()
        }
    })
}

/// A line was clicked; the thread picks it up on the same click.
pub fn click(id: &str) {
    FRAME.with_borrow_mut(|f| f.clicked = Some(id.to_owned()));
}

pub fn take_click() -> Option<String> {
    FRAME.with_borrow_mut(|f| f.clicked.take())
}

/// Where the visual lines of text `id` start, as measured last time it was drawn.
pub fn starts(id: &str, len: usize) -> Vec<usize> {
    FRAME.with_borrow(|f| {
        f.starts
            .get(id)
            .filter(|(l, _, _)| *l == len)
            .map(|(_, _, s)| s.clone())
            .unwrap_or_else(|| vec![0])
    })
}

/// Records where text `id`'s visual lines start; returns whether that changed (the lines need drawing again).
pub fn store_starts(id: &str, len: usize, width: f32, starts: Vec<usize>) -> bool {
    FRAME.with_borrow_mut(|f| {
        let changed = f
            .starts
            .get(id)
            .is_none_or(|(l, w, s)| *l != len || (*w - width).abs() > 0.5 || *s != starts);
        if changed {
            f.starts.insert(id.to_owned(), (len, width, starts));
        }
        changed
    })
}

/// Whether text `id` was measured at this length and width (no need to measure again).
pub fn measured(id: &str, len: usize, width: f32) -> bool {
    FRAME.with_borrow(|f| {
        f.starts
            .get(id)
            .is_some_and(|(l, w, _)| *l == len && (*w - width).abs() <= 0.5)
    })
}

/// Asks for the line `id` to be scrolled into view when it's next drawn.
pub fn follow(id: &str) {
    FRAME.with_borrow_mut(|f| f.follow = Some(id.to_owned()));
}

/// The line to follow if it's this one (taken), with the thread's scroll handle.
pub fn take_follow(id: &str) -> Option<ScrollHandle> {
    FRAME.with_borrow_mut(|f| {
        if f.follow.as_deref() == Some(id) {
            f.follow = None;
            f.scroll.clone()
        } else {
            None
        }
    })
}
