// Mermaid diagrams in replies (```mermaid blocks), drawn natively: merman (0.6, the last that builds on our Rust)
// lays them out as SVG, recolored to the app's palette, and GPUI shows the SVG as an image. Each diagram is rendered once per theme and kept, since a frame may draw it
// many times. The web view does the same with mermaid.js (src/web/diagrams.ts).
use crate::theme::{self, MONO, Palette};
use gpui::*;
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
    format!("#{:02x}{:02x}{:02x}", (c.r * 255.) as u8, (c.g * 255.) as u8, (c.b * 255.) as u8)
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
        out = out.replace(from, &hex(to)).replace(&from.to_lowercase(), &hex(to));
    }
    out
}

/// Width and height from the SVG's viewBox.
fn view_box(svg: &str) -> Option<(f32, f32)> {
    let start = svg.find("viewBox=\"")? + 9;
    let numbers: Vec<f32> = svg[start..].split('"').next()?.split([' ', ',']).filter_map(|n| n.parse().ok()).collect();
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
    Ok((Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes())), width, height))
}

/// The diagram for `source`, at its natural size up to `max_width`; its source and the error when it doesn't parse.
pub fn view(source: &str, max_width: f32, cx: &App) -> AnyElement {
    let p = theme::palette(cx);
    let mut hasher = DefaultHasher::new();
    (source, hex(p.paper)).hash(&mut hasher);
    let key = hasher.finish();
    let rendered = cache().lock().unwrap().entry(key).or_insert_with(|| render(source, &p)).clone();
    let frame = div().w_full().flex().justify_center().p_4().rounded(px(10.)).border_1().border_color(p.rule).bg(p.raised);
    match rendered {
        Ok((image, width, height)) => {
            let scale = (max_width - 34.).min(width) / width;
            frame.child(img(ImageSource::Image(image)).w(px(width * scale)).h(px(height * scale))).into_any_element()
        }
        Err(reason) => div()
            .flex()
            .flex_col()
            .gap_1()
            .child(div().text_size(px(12.5)).text_color(p.muted).child(format!("Couldn't draw this diagram: {reason}")))
            .child(div().p_3().rounded(px(8.)).bg(p.sunken).font_family(MONO).text_size(px(12.)).child(source.to_owned()))
            .into_any_element(),
    }
}

