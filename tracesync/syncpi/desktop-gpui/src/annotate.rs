// Comments on part of a graphic, native, as the web view's (src/web/annotate.ts): Comment turns on comment mode on an
// SVG or an image (a screenshot); a click marks a point and a drag an area, and a box opens there for the comment
// (Enter adds it, Esc drops it, ⌘↩ adds it and sends). Comments wait on the graphic, numbered, shared live with
// everyone in the thread (the server keeps them; the host streams them), with a bar under it to Send them all: one
// message with a picture of the graphic marked with them, as the web view sends it.
//
// A mark is a point or an area in fractions of the graphic's box (protocol.ts Mark), so it lands on the same spot on
// every screen. The keys are the web view's, so marks made in either show in both: `file:<path>` for a file the
// agent wrote, `<message key>:block<n>` for HTML or SVG in a reply, `shot:<image>` for a screenshot.
//
// Graphics are drawn by free functions (message.rs, thread.rs), so what they need is kept here, per thread view
// frame, as the text cursor's is (cursor.rs): the marks, who this person is, what's being written, and messages
// for the thread view to send.
use crate::theme::{Palette, initials, person_color, sz};
use gpui::{prelude::FluentBuilder, *};
use gpui_component::input::{Input, InputEvent, InputState};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// What a graphic is, to draw it marked when its comments are sent.
#[derive(Clone)]
pub enum Source {
    Svg(String),
    Raster(Vec<u8>, &'static str),
}

struct Editing {
    key: String,
    mark: Value,
    input: Entity<InputState>,
    _subscription: Subscription,
}

#[derive(Default)]
struct State {
    marks: HashMap<String, Vec<Value>>,
    me: (String, String),
    commenting: HashSet<String>,
    /// A drag being made on a graphic: its key, and where it started and is now (fractions).
    drag: Option<(String, Point<f32>, Point<f32>)>,
    editing: Option<Editing>,
    bounds: HashMap<String, Bounds<Pixels>>,
    graphics: HashMap<String, (String, Source)>,
    outbox: Vec<Value>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// The thread's marks as the host has them, and who this person is; once a frame.
pub fn set(marks: &Value, me_id: String, me_name: String) {
    STATE.with_borrow_mut(|s| {
        s.marks = marks.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_array().cloned().unwrap_or_default())).collect()).unwrap_or_default();
        s.me = (me_id, me_name);
    });
}

/// Whether a graphic is being commented on here, or has comments waiting on it (a diagram is then shown still).
pub fn active(key: &str) -> bool {
    STATE.with_borrow(|s| s.commenting.contains(key) || s.marks.get(key).is_some_and(|m| !m.is_empty()) || s.editing.as_ref().is_some_and(|e| e.key == key))
}

/// Just the Comment button, under a graphic shown some other way (a diagram's viewer): it turns on comment mode.
pub fn comment_bar(key: &str, p: &Palette) -> AnyElement {
    let toggle = key.to_owned();
    div()
        .w_full()
        .flex()
        .px_3()
        .py(px(5.))
        .text_size(sz(12.5))
        .child(
            div()
                .id(SharedString::from(format!("comment-mode-{key}")))
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .py(px(2.))
                .rounded(px(5.))
                .cursor_pointer()
                .text_color(p.muted)
                .hover(|s| s.bg(p.sunken).text_color(p.ink))
                .child(gpui_component::Icon::default().path("syncpi/message-square.svg").size(px(13.)))
                .child("Comment")
                .on_click(move |_, window, _| {
                    STATE.with_borrow_mut(|s| _ = s.commenting.insert(toggle.clone()));
                    window.refresh();
                }),
        )
        .into_any_element()
}

/// Messages for the thread (marks made and changed, comments sent), in order.
pub fn take_outbox() -> Vec<Value> {
    STATE.with_borrow_mut(|s| std::mem::take(&mut s.outbox))
}

fn mark_id() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos())
}

/// The marks shown on a graphic: the server's, and the one being written here if the server hasn't sent it back.
fn shown(s: &State, key: &str) -> Vec<Value> {
    let mut marks = s.marks.get(key).cloned().unwrap_or_default();
    if let Some(e) = s.editing.as_ref().filter(|e| e.key == key) {
        let id = &e.mark["id"];
        match marks.iter_mut().find(|m| m["id"] == *id) {
            Some(m) => m["text"] = e.mark["text"].clone(),
            None => {
                let mut mine = e.mark.clone();
                mine["name"] = json!(s.me.1);
                mine["memberId"] = json!(s.me.0);
                marks.push(mine);
            }
        }
    }
    marks
}

/// A graphic that can be commented on: `picture` drawn at `size`, its marks over it, and under it Comment and, when
/// comments wait on it, Send.
pub fn graphic(key: &str, title: &str, source: Source, picture: AnyElement, size: Size<Pixels>, p: &Palette) -> AnyElement {
    let key = key.to_owned();
    let (marks, commenting, drag, editing, me) = STATE.with_borrow_mut(|s| {
        s.graphics.insert(key.clone(), (title.to_owned(), source));
        (
            shown(s, &key),
            s.commenting.contains(&key),
            s.drag.clone().filter(|(k, _, _)| *k == key),
            s.editing.as_ref().filter(|e| e.key == key).map(|e| (e.mark.clone(), e.input.clone())),
            s.me.0.clone(),
        )
    });
    let at = |frac: Point<f32>| point(size.width * frac.x, size.height * frac.y);
    let mut surface = div().id(SharedString::from(format!("graphic-{key}"))).relative().w(size.width).h(size.height).child(picture);
    // Where the surface is, for the mouse's fractions.
    let measured = key.clone();
    surface = surface.child(canvas(move |bounds, _, _| STATE.with_borrow_mut(|s| _ = s.bounds.insert(measured.clone(), bounds)), |_, _, _, _| {}).absolute().inset_0());
    for (n, m) in marks.iter().enumerate() {
        let name = m["name"].as_str().unwrap_or("someone").to_owned();
        let color = person_color(&name, p.dark);
        let origin = at(point(m["x"].as_f64().unwrap_or(0.) as f32, m["y"].as_f64().unwrap_or(0.) as f32));
        if let (Some(w), Some(h)) = (m["w"].as_f64(), m["h"].as_f64()) {
            surface = surface.child(div().absolute().left(origin.x).top(origin.y).w(size.width * w as f32).h(size.height * h as f32).border_2().border_color(color).bg(color.opacity(0.12)));
        }
        let written = !m["text"].as_str().unwrap_or("").trim().is_empty();
        let tip = if written { format!("{name}: {}", m["text"].as_str().unwrap_or("")) } else { format!("{name} is writing a comment") };
        surface = surface.child(
            div()
                .id(SharedString::from(format!("mark-{key}-{n}")))
                .absolute()
                .left(origin.x - px(11.))
                .top(origin.y - px(11.))
                .size(px(22.))
                .rounded_full()
                .border_2()
                .border_color(gpui::white())
                .bg(color)
                .when(!written, |d| d.opacity(0.6))
                .text_color(gpui::white())
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .flex()
                .items_center()
                .justify_center()
                .child((n + 1).to_string())
                .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(tip.clone()).build(window, cx)),
        );
    }
    if let Some((_, from, to)) = drag {
        let (a, b) = (at(from), at(to));
        surface = surface.child(div().absolute().left(a.x.min(b.x)).top(a.y.min(b.y)).w((a.x - b.x).abs()).h((a.y - b.y).abs()).border_2().border_color(p.accent).bg(p.accent.opacity(0.1)));
    }
    if let Some((mark, input)) = editing {
        let x = at(point(mark["x"].as_f64().unwrap_or(0.) as f32, 0.)).x;
        let bottom = mark["y"].as_f64().unwrap_or(0.) + mark["h"].as_f64().unwrap_or(0.);
        let y = size.height * bottom as f32 + px(14.);
        surface = surface.child(
            deferred(
                div()
                    .absolute()
                    .left(x.min(size.width - px(250.)).max(px(0.)))
                    .top(y)
                    .w(px(250.))
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(p.rule_strong)
                    .bg(p.raised)
                    .shadow_lg()
                    .occlude()
                    .child(div().text_size(sz(11.5)).text_color(p.muted).child("Enter adds it, ⌘↩ sends, Esc drops it"))
                    .child(Input::new(&input).appearance(false).text_size(sz(13.5))),
            )
            .with_priority(2),
        );
    }
    if commenting {
        let (down_key, move_key, up_key) = (key.clone(), key.clone(), key.clone());
        surface = surface
            .cursor_crosshair()
            .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                cx.stop_propagation();
                let Some(frac) = fraction(&down_key, event.position) else { return };
                STATE.with_borrow_mut(|s| s.drag = Some((down_key.clone(), frac, frac)));
                window.refresh();
            })
            .on_mouse_move(move |event, window, _| {
                let Some(frac) = fraction(&move_key, event.position) else { return };
                let moved = STATE.with_borrow_mut(|s| match &mut s.drag {
                    Some((k, _, now)) if *k == move_key && event.pressed_button == Some(MouseButton::Left) => {
                        *now = frac;
                        true
                    }
                    _ => false,
                });
                if moved {
                    window.refresh();
                }
            })
            .on_mouse_up(MouseButton::Left, move |event, window, cx| {
                let Some((_, from, _)) = STATE.with_borrow_mut(|s| s.drag.take()) else { return };
                let to = fraction(&up_key, event.position).unwrap_or(from);
                start_mark(&up_key, from, to, window, cx);
            });
    }
    let count = marks.iter().filter(|m| !m["text"].as_str().unwrap_or("").trim().is_empty()).count();
    let mine = marks.iter().filter(|m| m["memberId"].as_str() == Some(me.as_str())).count();
    let (toggle_key, send_key, clear_key) = (key.clone(), key.clone(), key.clone());
    let bar = div()
        .w_full()
        .flex()
        .items_center()
        .gap_2()
        .px_3()
        .py(px(6.))
        .border_t_1()
        .border_color(p.rule)
        .bg(p.raised)
        .text_size(sz(12.5))
        .child(
            div()
                .id(SharedString::from(format!("comment-mode-{key}")))
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .py(px(2.))
                .rounded(px(5.))
                .cursor_pointer()
                .when(commenting, |d| d.bg(p.accent_soft).text_color(p.accent))
                .when(!commenting, |d| d.text_color(p.muted).hover(|s| s.bg(p.sunken).text_color(p.ink)))
                .child(gpui_component::Icon::default().path("syncpi/message-square.svg").size(px(13.)))
                .child(if commenting { "Click a point or drag an area" } else { "Comment" })
                .on_click(move |_, window, _| {
                    STATE.with_borrow_mut(|s| {
                        if !s.commenting.remove(&toggle_key) {
                            s.commenting.insert(toggle_key.clone());
                        }
                    });
                    window.refresh();
                }),
        )
        .child(div().flex_1())
        .when(count > 0, |d| {
            let names: Vec<String> = marks.iter().filter_map(|m| m["name"].as_str().map(str::to_owned)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            d.child(div().flex().children(names.iter().take(3).map(|n| {
                let c = person_color(n, p.dark);
                div().size(px(18.)).ml(px(-4.)).rounded_full().border_1().border_color(p.raised).bg(c.opacity(0.2)).text_color(c).text_size(px(8.)).flex().items_center().justify_center().child(initials(n))
            })))
            .child(div().text_color(p.muted).child(format!("{count} comment{} waiting", if count == 1 { "" } else { "s" })))
            .when(mine > 0, |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("comments-clear-{key}")))
                        .px_2()
                        .rounded(px(5.))
                        .text_color(p.muted)
                        .cursor_pointer()
                        .hover(|s| s.bg(p.sunken))
                        .child("Clear mine")
                        .on_click(move |_, window, _| {
                            STATE.with_borrow_mut(|s| {
                                let me = s.me.0.clone();
                                let ids: Vec<String> = s.marks.get(&clear_key).into_iter().flatten().filter(|m| m["memberId"].as_str() == Some(me.as_str())).filter_map(|m| m["id"].as_str().map(str::to_owned)).collect();
                                for id in ids {
                                    s.outbox.push(json!({ "type": "mark", "key": clear_key, "remove": id }));
                                }
                            });
                            window.refresh();
                        }),
                )
            })
            .child(
                div()
                    .id(SharedString::from(format!("comments-send-{key}")))
                    .px_3()
                    .py(px(3.))
                    .rounded(px(6.))
                    .bg(p.accent)
                    .text_color(p.accent_ink)
                    .cursor_pointer()
                    .child("Send")
                    .on_click(move |_, window, _| {
                        send(&send_key);
                        window.refresh();
                    }),
            )
        });
    div().w_full().flex().flex_col().items_center().child(div().w_full().flex().justify_center().p_3().bg(gpui::white()).child(surface)).child(bar).into_any_element()
}

/// Where a point is on graphic `key`, in fractions of its box.
fn fraction(key: &str, position: Point<Pixels>) -> Option<Point<f32>> {
    let bounds = STATE.with_borrow(|s| s.bounds.get(key).copied())?;
    let f = |v: Pixels, start: Pixels, len: Pixels| ((v - start) / len).clamp(0., 1.);
    Some(point(f(position.x, bounds.origin.x, bounds.size.width), f(position.y, bounds.origin.y, bounds.size.height)))
}

/// A click or a drag made a mark: shared at once (others see it being written), with a box to write in.
fn start_mark(key: &str, from: Point<f32>, to: Point<f32>, window: &mut Window, cx: &mut App) {
    let area = (from.x - to.x).abs() > 0.02 && (from.y - to.y).abs() > 0.02;
    let mut mark = json!({ "id": mark_id(), "x": from.x.min(to.x), "y": from.y.min(to.y), "text": "" });
    if area {
        mark["w"] = json!((from.x - to.x).abs());
        mark["h"] = json!((from.y - to.y).abs());
    }
    // A box left open elsewhere: what's in it stays, an empty one goes.
    finish(false);
    let input = cx.new(|cx| InputState::new(window, cx).placeholder("Comment"));
    input.update(cx, |state, cx| state.focus(window, cx));
    let watched = key.to_owned();
    let subscription = cx.subscribe(&input, move |input, event: &InputEvent, cx| {
        let text = input.read(cx).value().to_string();
        match event {
            InputEvent::Change => STATE.with_borrow_mut(|s| {
                if let Some(e) = s.editing.as_mut().filter(|e| e.key == watched) {
                    e.mark["text"] = json!(text);
                    s.outbox.push(json!({ "type": "mark", "key": watched, "mark": e.mark }));
                }
            }),
            InputEvent::PressEnter { secondary } => {
                finish(false);
                if *secondary {
                    send(&watched);
                }
            }
            _ => {}
        }
    });
    let escape_key = key.to_owned();
    let _ = escape_key;
    STATE.with_borrow_mut(|s| {
        s.outbox.push(json!({ "type": "mark", "key": key, "mark": mark }));
        s.editing = Some(Editing { key: key.to_owned(), mark, input, _subscription: subscription });
    });
    window.refresh();
}

/// Closes the comment box: what's written is added; an empty one (or `drop`) takes its mark off.
pub fn finish(drop: bool) {
    STATE.with_borrow_mut(|s| {
        let Some(e) = s.editing.take() else { return };
        let empty = e.mark["text"].as_str().unwrap_or("").trim().is_empty();
        if drop || empty {
            s.outbox.push(json!({ "type": "mark", "key": e.key, "remove": e.mark["id"] }));
        } else {
            s.outbox.push(json!({ "type": "mark", "key": e.key, "mark": e.mark }));
        }
    });
}

/// Esc: closes a comment box if one is open (dropping its mark), else leaves comment mode; true when it did either.
pub fn escape() -> bool {
    let editing = STATE.with_borrow(|s| s.editing.is_some());
    if editing {
        finish(true);
        return true;
    }
    STATE.with_borrow_mut(|s| {
        let any = !s.commenting.is_empty();
        s.commenting.clear();
        any
    })
}

/// Send: the comments as one message, with a picture of the graphic marked with them; off the graphic for everyone.
fn send(key: &str) {
    STATE.with_borrow_mut(|s| {
        let marks: Vec<Value> = shown(s, key).into_iter().filter(|m| !m["text"].as_str().unwrap_or("").trim().is_empty()).collect();
        if marks.is_empty() {
            return;
        }
        let Some((title, source)) = s.graphics.get(key).cloned() else { return };
        let names: Vec<String> = marks.iter().map(|m| m["name"].as_str().unwrap_or("someone").to_owned()).collect();
        let picture = draw_marks(&source, &marks, &names);
        let mut message = json!({
            "type": "submit",
            "requestId": mark_id(),
            "text": comments_text(&title, &marks, &names, picture.is_some()),
            "mode": "interrupt",
        });
        if let Some(png) = picture {
            let name: String = title.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '-' }).collect::<String>().trim_matches('-').to_owned();
            message["attachments"] = json!([{ "name": format!("{}-comments.png", if name.is_empty() { "graphic".into() } else { name }), "mimeType": "image/png", "data": png }]);
        }
        s.outbox.push(message);
        s.outbox.push(json!({ "type": "mark", "key": key, "sent": marks.iter().map(|m| m["id"].clone()).collect::<Vec<_>>() }));
        s.editing = None;
        s.commenting.remove(key);
    });
}

/// The message (annotate.ts commentsText): each comment numbered as on the picture, by whom, and where.
fn comments_text(title: &str, marks: &[Value], names: &[String], pictured: bool) -> String {
    let percent = |v: f64| format!("{}%", (v * 100.).round());
    let lines: Vec<String> = marks
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let (x, y) = (m["x"].as_f64().unwrap_or(0.), m["y"].as_f64().unwrap_or(0.));
            let place = match (m["w"].as_f64(), m["h"].as_f64()) {
                (Some(w), Some(h)) => format!("on the area {}–{} across, {}–{} down", percent(x), percent(x + w), percent(y), percent(y + h)),
                _ => format!("at {} across, {} down", percent(x), percent(y)),
            };
            format!("{}. {}, {place}: {}", i + 1, names[i], m["text"].as_str().unwrap_or("").trim())
        })
        .collect();
    format!("Comments on {title}{}:\n{}", if pictured { ", numbered on the attached picture" } else { "" }, lines.join("\n"))
}

/// The graphic drawn with its marks (areas outlined, each comment's number in its author's color), as a PNG in
/// base64, at most 2000 pixels a side: an SVG made of the graphic and the marks, drawn by resvg.
fn draw_marks(source: &Source, marks: &[Value], names: &[String]) -> Option<String> {
    let (href, width, height) = match source {
        Source::Svg(svg) => {
            let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).ok()?;
            (format!("data:image/svg+xml;base64,{}", crate::thread::base64(svg.as_bytes())), tree.size().width(), tree.size().height())
        }
        Source::Raster(bytes, mime) => {
            let (w, h) = raster_size(bytes)?;
            (format!("data:{mime};base64,{}", crate::thread::base64(bytes)), w as f32, h as f32)
        }
    };
    let unit = (width.max(height) / 700.).max(1.);
    let mut overlay = String::new();
    for (i, m) in marks.iter().enumerate() {
        let c = person_color(&names[i], false).to_rgb();
        let color = format!("rgb({},{},{})", (c.r * 255.) as u8, (c.g * 255.) as u8, (c.b * 255.) as u8);
        let (x, y) = (m["x"].as_f64().unwrap_or(0.) as f32 * width, m["y"].as_f64().unwrap_or(0.) as f32 * height);
        if let (Some(w), Some(h)) = (m["w"].as_f64(), m["h"].as_f64()) {
            overlay += &format!(r#"<rect x="{x}" y="{y}" width="{}" height="{}" fill="{color}" fill-opacity="0.12" stroke="{color}" stroke-width="{}"/>"#, w as f32 * width, h as f32 * height, 2.5 * unit);
        }
        overlay += &format!(
            r#"<circle cx="{x}" cy="{y}" r="{}" fill="{color}" stroke="white" stroke-width="{}"/><text x="{x}" y="{}" font-size="{}" font-weight="600" font-family="Helvetica, Arial, sans-serif" fill="white" text-anchor="middle">{}</text>"#,
            11. * unit,
            2. * unit,
            y + 4.3 * unit,
            12. * unit,
            i + 1
        );
    }
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="{width}" height="{height}" fill="white"/><image x="0" y="0" width="{width}" height="{height}" xlink:href="{href}"/>{overlay}</svg>"#);
    let mut options = resvg::usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_str(&svg, &options).ok()?;
    let scale = (2000. / width.max(height)).min(2.);
    let mut pixmap = resvg::tiny_skia::Pixmap::new((width * scale).ceil() as u32, (height * scale).ceil() as u32)?;
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    Some(crate::thread::base64(&pixmap.encode_png().ok()?))
}

/// A PNG's or JPEG's size in pixels, from its header.
pub fn raster_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG") && bytes.len() >= 24 {
        let read = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
        return Some((read(16), read(20)));
    }
    // JPEG: the first start-of-frame segment has the height and width.
    let mut at = 2;
    while at + 9 < bytes.len() && bytes.starts_with(&[0xff, 0xd8]) {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if (0xc0..=0xc3).contains(&marker) {
            let h = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]) as u32;
            let w = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]) as u32;
            return Some((w, h));
        }
        at += 2 + len;
    }
    None
}

/// The displayed size of a graphic of `natural` size, at most `max_w` wide and `max_h` tall.
pub fn fit(natural: (f32, f32), max_w: f32, max_h: f32) -> Size<Pixels> {
    let shrink = (max_w / natural.0).min(max_h / natural.1).min(1.);
    size(px(natural.0 * shrink), px(natural.1 * shrink))
}

/// An image element of a graphic, filling its box.
pub fn picture(image: Arc<Image>) -> AnyElement {
    img(image).size_full().object_fit(ObjectFit::Fill).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{Source, comments_text, draw_marks, raster_size};
    use serde_json::json;

    #[test]
    fn comments_read_as_the_web_view_writes_them() {
        let marks = vec![json!({ "x": 0.1, "y": 0.2, "text": "This one " }), json!({ "x": 0.5, "y": 0.5, "w": 0.25, "h": 0.1, "text": "and this area" })];
        let names = vec!["Ada".to_owned(), "Bob".to_owned()];
        assert_eq!(
            comments_text("the SVG image logo.svg", &marks, &names, true),
            "Comments on the SVG image logo.svg, numbered on the attached picture:\n1. Ada, at 10% across, 20% down: This one\n2. Bob, on the area 50%–75% across, 50%–60% down: and this area"
        );
    }

    #[test]
    fn marks_drawn_on_a_graphic_make_a_png_twice_its_size() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#d44"/></svg>"##;
        let marks = vec![json!({ "x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2, "text": "here" })];
        let png = draw_marks(&Source::Svg(svg.into()), &marks, &["Ada".into()]).expect("a picture");
        // The PNG's header, decoded from base64: its width and height.
        let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bits: Vec<u8> = png.bytes().take(32).map(|c| table.iter().position(|t| *t == c).unwrap() as u8).collect();
        let bytes: Vec<u8> = bits.chunks(4).flat_map(|c| [c[0] << 2 | c[1] >> 4, c[1] << 4 | c[2] >> 2, c[2] << 6 | c[3]]).collect();
        assert_eq!(raster_size(&bytes), Some((320, 200)));
    }

    #[test]
    fn png_size_from_its_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(640u32.to_be_bytes());
        png.extend(480u32.to_be_bytes());
        assert_eq!(raster_size(&png), Some((640, 480)));
    }
}
