// Mermaid diagrams in replies (```mermaid blocks), drawn natively: merman (0.6, the last that builds on our Rust)
// lays them out as SVG, recolored to the app's palette, and GPUI shows the SVG as an image. Each diagram is rendered once per theme and kept, since a frame may draw it
// many times. The web view does the same with mermaid.js (src/web/diagrams.ts).
use crate::theme::{self, MONO, Palette};
use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::{
    Icon, IconName, Sizable,
    button::{Button, ButtonVariants},
};
use merman::render::HeadlessRenderer;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};

/// A rendered diagram, or why it couldn't be.
type Rendered = Result<(Arc<Image>, f32, f32), String>;

fn cache() -> &'static Mutex<HashMap<u64, Rendered>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, Rendered>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn hex(color: Hsla) -> String {
    let c = color.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (c.r * 255.) as u8,
        (c.g * 255.) as u8,
        (c.b * 255.) as u8
    )
}

/// merman draws Mermaid's default theme; swap its colors for the app's, and drop the white background.
fn recolor(svg: &str, p: &Palette) -> String {
    let pairs = [
        ("#ECECFF", p.surface),
        ("#9370DB", p.rule_strong),
        ("#333333", p.ink_2),
        ("#333", p.ink),
        ("#ffffde", p.sunken),
        ("#aaaa33", p.rule),
    ];
    let mut out = svg.replace("background-color:white", "background-color:transparent");
    for (from, to) in pairs {
        out = out
            .replace(from, &hex(to))
            .replace(&from.to_lowercase(), &hex(to));
    }
    out
}

/// Width and height from the SVG's viewBox.
fn view_box(svg: &str) -> Option<(f32, f32)> {
    let start = svg.find("viewBox=\"")? + 9;
    let numbers: Vec<f32> = svg[start..]
        .split('"')
        .next()?
        .split([' ', ','])
        .filter_map(|n| n.parse().ok())
        .collect();
    (numbers.len() == 4 && numbers[2] > 0. && numbers[3] > 0.).then(|| (numbers[2], numbers[3]))
}

fn render(source: &str, p: &Palette) -> Rendered {
    // GPUI draws SVG with resvg, which can't show Mermaid's HTML labels; the resvg-safe output uses SVG text.
    let svg = HeadlessRenderer::new()
        .with_vendored_text_measurer()
        .render_svg_resvg_safe_sync(source)
        .map_err(|e| e.to_string().lines().next().unwrap_or("").to_owned())?
        .ok_or("not a Mermaid diagram")?;
    let svg = recolor(&svg, p);
    let (width, height) = view_box(&svg).ok_or("the diagram has no size")?;
    Ok((
        Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes())),
        width,
        height,
    ))
}

/// How one diagram is being looked at: which tab, the zoom and the pan, and a drag in progress.
#[derive(Clone, Copy, Default)]
struct ViewState {
    source: bool,
    fitted: bool,
    zoom: f32,
    x: f32,
    y: f32,
    drag: Option<(f32, f32)>,
}

/// View state per diagram (by the message block it's in); blocks are drawn by free functions, not an entity.
fn views() -> &'static Mutex<HashMap<String, ViewState>> {
    static VIEWS: OnceLock<Mutex<HashMap<String, ViewState>>> = OnceLock::new();
    VIEWS.get_or_init(Default::default)
}

fn update(id: &str, window: &mut Window, change: impl FnOnce(&mut ViewState)) {
    change(views().lock().unwrap().entry(id.to_owned()).or_default());
    window.refresh();
}

/// Zooms by `factor` around a point of the frame, within 0.2× to 4×.
fn zoom_at(v: &mut ViewState, factor: f32, at: (f32, f32)) {
    let zoom = (v.zoom * factor).clamp(0.2, 4.);
    v.x = at.0 - (at.0 - v.x) * zoom / v.zoom;
    v.y = at.1 - (at.1 - v.y) * zoom / v.zoom;
    v.zoom = zoom;
}

const MAX_HEIGHT: f32 = 520.;

/// A viewer for `source`, as in Delta: Preview and Source tabs, drag to pan, ⌘-scroll or pinch to zoom (plain
/// scrolling still scrolls the thread), and buttons to recenter, zoom and copy the source. `width` is the room the
/// thread gives it; a diagram that doesn't parse opens on its source with the reason.
pub fn view(id: &str, source: &str, width: f32, cx: &App) -> AnyElement {
    let p = theme::palette(cx);
    let mut hasher = DefaultHasher::new();
    (source, hex(p.paper)).hash(&mut hasher);
    let key = hasher.finish();
    let rendered = cache()
        .lock()
        .unwrap()
        .entry(key)
        .or_insert_with(|| render(source, &p))
        .clone();
    let stage_height = rendered
        .as_ref()
        .map_or(0., |(_, _, h)| (h + 48.).min(MAX_HEIGHT));
    let fit = |v: &mut ViewState, w: f32, h: f32| {
        v.zoom = 1f32.min((width - 32.) / w).min((stage_height - 32.) / h);
        v.x = (width - w * v.zoom) / 2.;
        v.y = (stage_height - h * v.zoom) / 2.;
        v.fitted = true;
    };
    let state = {
        let mut views = views().lock().unwrap();
        let v = views.entry(id.to_owned()).or_default();
        if let Ok((_, w, h)) = &rendered {
            if !v.fitted {
                fit(v, *w, *h);
            }
        } else {
            v.source = true;
        }
        *v
    };
    let id = SharedString::from(id.to_owned());
    let tab = |label: &'static str, selected: bool, source: bool| {
        let id = id.clone();
        div()
            .id(SharedString::from(format!("{id}-{label}")))
            .px_2()
            .py(px(2.))
            .rounded(px(4.))
            .cursor_pointer()
            .text_size(theme::sz(12.))
            .when(selected, |d| d.bg(p.raised).text_color(p.ink).shadow_xs())
            .when(!selected, |d| d.text_color(p.muted))
            .child(label)
            .on_click(move |_, window, _| update(&id, window, |v| v.source = source))
    };
    let tool = |name: &'static str,
                icon: Icon,
                tip: &'static str,
                run: fn(&mut ViewState, f32, f32, (f32, f32))| {
        let id = id.clone();
        let size = rendered
            .as_ref()
            .map(|(_, w, h)| (*w, *h))
            .unwrap_or((1., 1.));
        let frame = (width, stage_height);
        Button::new(SharedString::from(format!("{id}-{name}")))
            .ghost()
            .xsmall()
            .icon(icon)
            .tooltip(tip)
            .on_click(move |_, window, _| update(&id, window, |v| run(v, size.0, size.1, frame)))
    };
    let mut head = div()
        .flex()
        .items_center()
        .gap_1()
        .px_2()
        .py(px(6.))
        .border_b_1()
        .border_color(p.rule)
        .bg(p.surface)
        .child(
            div()
                .flex()
                .gap(px(2.))
                .p(px(2.))
                .rounded(px(6.))
                .bg(p.sunken)
                .when(rendered.is_ok(), |d| {
                    d.child(tab("Preview", !state.source, false))
                })
                .child(tab("Source", state.source, true)),
        )
        .child(div().flex_1());
    if rendered.is_ok() && !state.source {
        head = head
            .child(tool(
                "center",
                crate::icons::icon("crosshair"),
                "Recenter",
                |v, w, h, (fw, fh)| {
                    v.zoom = 1f32.min((fw - 32.) / w).min((fh - 32.) / h);
                    v.x = (fw - w * v.zoom) / 2.;
                    v.y = (fh - h * v.zoom) / 2.;
                },
            ))
            .child(tool(
                "in",
                Icon::new(IconName::Plus),
                "Zoom in",
                |v, _, _, (fw, fh)| zoom_at(v, 1.25, (fw / 2., fh / 2.)),
            ))
            .child(tool(
                "out",
                Icon::new(IconName::Minus),
                "Zoom out",
                |v, _, _, (fw, fh)| zoom_at(v, 0.8, (fw / 2., fh / 2.)),
            ));
    }
    let copy = source.to_owned();
    head = head.child(
        Button::new(SharedString::from(format!("{id}-copy")))
            .ghost()
            .xsmall()
            .icon(Icon::new(IconName::Copy))
            .tooltip("Copy source")
            .on_click(move |_, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))
            }),
    );
    let body = match (&rendered, state.source) {
        (Ok((image, w, h)), false) => {
            let (down, moved, up, wheel) = (id.clone(), id.clone(), id.clone(), id.clone());
            div()
                .id(SharedString::from(format!("{id}-stage")))
                .relative()
                .w_full()
                .h(px(stage_height))
                .overflow_hidden()
                .bg(p.raised)
                .cursor_grab()
                .child(
                    // A sized box that the image fills: GPUI keeps an absolutely positioned image at its own size.
                    div()
                        .absolute()
                        .left(px(state.x))
                        .top(px(state.y))
                        .w(px(w * state.zoom))
                        .h(px(h * state.zoom))
                        .child(img(ImageSource::Image(image.clone())).size_full()),
                )
                .on_mouse_down(MouseButton::Left, move |e, window, _| {
                    let at = (f32::from(e.position.x), f32::from(e.position.y));
                    update(&down, window, |v| v.drag = Some((at.0 - v.x, at.1 - v.y)));
                })
                .on_mouse_move(move |e, window, _| {
                    let dragging = views()
                        .lock()
                        .unwrap()
                        .get(moved.as_ref())
                        .and_then(|v| v.drag);
                    if let (Some((dx, dy)), Some(MouseButton::Left)) = (dragging, e.pressed_button)
                    {
                        update(&moved, window, |v| {
                            v.x = f32::from(e.position.x) - dx;
                            v.y = f32::from(e.position.y) - dy;
                        });
                    }
                })
                .on_mouse_up(MouseButton::Left, move |_, window, _| {
                    update(&up, window, |v| v.drag = None)
                })
                // ⌘-scroll and pinch (which arrives with ⌃) zoom; plain scrolling is the thread's.
                .on_scroll_wheel(move |e, window, cx| {
                    if !(e.modifiers.platform || e.modifiers.control) {
                        return;
                    }
                    cx.stop_propagation();
                    let delta = f32::from(e.delta.pixel_delta(px(16.)).y);
                    update(&wheel, window, |v| {
                        zoom_at(v, (delta * 0.01).exp(), (width / 2., stage_height / 2.))
                    });
                })
                .into_any_element()
        }
        (Err(reason), _) => div()
            .flex()
            .flex_col()
            .child(
                div()
                    .px_3()
                    .pt_2()
                    .text_size(theme::sz(12.5))
                    .text_color(p.muted)
                    .child(format!("Couldn't draw this diagram: {reason}")),
            )
            .child(
                div()
                    .p_3()
                    .font_family(MONO)
                    .text_size(theme::sz(12.))
                    .child(source.to_owned()),
            )
            .into_any_element(),
        (Ok(_), true) => div()
            .p_3()
            .font_family(MONO)
            .text_size(theme::sz(12.))
            .text_color(p.ink)
            .child(source.to_owned())
            .into_any_element(),
    };
    div()
        .w_full()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .rounded(px(10.))
        .border_1()
        .border_color(p.rule)
        .bg(p.raised)
        .overflow_hidden()
        .child(head)
        .child(body)
        .into_any_element()
}
