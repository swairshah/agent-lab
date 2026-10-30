// Artifacts in the native thread: files the agent wrote and HTML or SVG in its replies, found as the web view finds them
// (src/shared/artifacts.ts), and screenshots and recordings from its browser tools. Each shows inline as a card: SVG
// and images drawn natively, Markdown rendered, HTML as its first lines. Open shows one in the panel beside the thread
// (main.rs): HTML in a private webview, a recording in one that plays it, the rest natively.
use crate::theme::{MONO, Palette, sz};
use gpui::{prelude::FluentBuilder, *};
use std::{cell::RefCell, sync::Arc};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Html,
    Svg,
    Markdown,
    Image,
    Code,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Html => "HTML",
            Kind::Svg => "SVG",
            Kind::Markdown => "Markdown",
            Kind::Image => "Image",
            Kind::Code => "Code",
        }
    }
}

/// What a file is, from its extension (EXTENSION_KIND in src/shared/artifacts.ts).
pub fn kind_of_path(path: &str) -> Kind {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "html" | "htm" => Kind::Html,
        "svg" => Kind::Svg,
        "md" | "markdown" => Kind::Markdown,
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Kind::Image,
        _ => Kind::Code,
    }
}

/// What a fenced block in a reply is, when it's one shown as an artifact (```html, ```svg, a bare <svg>).
pub fn kind_of_fence(language: &str, content: &str) -> Option<Kind> {
    match language.to_lowercase().as_str() {
        "html" | "htm" => Some(Kind::Html),
        "svg" => Some(Kind::Svg),
        "" if content.trim_start().to_lowercase().starts_with("<svg") => Some(Kind::Svg),
        _ => None,
    }
}

pub fn image_format(path: &str) -> ImageFormat {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "gif" => ImageFormat::Gif,
        "webp" => ImageFormat::Webp,
        "svg" => ImageFormat::Svg,
        _ => ImageFormat::Png,
    }
}

/// What the panel beside the thread shows.
#[derive(Clone)]
pub enum Shown {
    /// HTML from the agent: in a private webview (its own data store: no cookies, no bridge to the app).
    Html { title: String, content: String },
    /// A page the app's host serves (a recording): in a webview that has the host's cookie.
    Page { title: String, url: String },
    Image { title: String, image: Arc<Image> },
    Markdown { title: String, content: String },
}

impl Shown {
    pub fn title(&self) -> &str {
        match self {
            Shown::Html { title, .. } | Shown::Page { title, .. } | Shown::Image { title, .. } | Shown::Markdown { title, .. } => title,
        }
    }
}

thread_local! {
    /// Asks the app to show something in the panel; cards drawn by free functions (message.rs) can't reach it.
    static OPEN: RefCell<Option<Shown>> = const { RefCell::new(None) };
}

pub fn open(shown: Shown) {
    OPEN.with_borrow_mut(|o| *o = Some(shown));
}

pub fn take_open() -> Option<Shown> {
    OPEN.with_borrow_mut(Option::take)
}

/// SVG source as an image GPUI draws natively: rendered here to a PNG at twice its size (sharp on a Retina screen),
/// since gpui 0.2.2 hands an SVG Image's pixels to the GPU without turning RGBA into BGRA (red and blue swap).
pub fn svg_image(content: &str) -> (Arc<Image>, Option<Size<f32>>) {
    let png = (|| {
        let tree = resvg::usvg::Tree::from_str(content, &resvg::usvg::Options::default()).ok()?;
        let natural = tree.size();
        let scale = 2.0_f32.min(4096. / natural.width().max(natural.height()).max(1.));
        let mut pixmap = resvg::tiny_skia::Pixmap::new((natural.width() * scale).ceil() as u32, (natural.height() * scale).ceil() as u32)?;
        resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
        Some((pixmap.encode_png().ok()?, size(natural.width(), natural.height())))
    })();
    match png {
        Some((png, natural)) => (Arc::new(Image::from_bytes(ImageFormat::Png, png)), Some(natural)),
        None => (Arc::new(Image::from_bytes(ImageFormat::Svg, content.as_bytes().to_vec())), None),
    }
}

thread_local! {
    static TEST_OPENED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A card: its kind and title, Open (the panel), and what it shows inline.
pub fn card(id: String, kind: Kind, title: String, body: AnyElement, opens: Option<Shown>, p: &Palette) -> AnyElement {
    // Tests open the first card of a kind (SYNCPI_GPUI_TEST_OPEN=html|svg|image|markdown), as a click on Open would.
    if let (Ok(wanted), Some(shown)) = (std::env::var("SYNCPI_GPUI_TEST_OPEN"), &opens)
        && wanted == kind.label().to_lowercase()
        && !TEST_OPENED.replace(true)
    {
        open(shown.clone());
    }
    let head = div()
        .h(px(32.))
        .flex()
        .items_center()
        .gap_2()
        .px(px(12.))
        .border_b_1()
        .border_color(p.rule)
        .child(div().font_family(MONO).text_size(sz(10.5)).text_color(p.accent).child(kind.label().to_uppercase()))
        .child(div().flex_1().min_w_0().truncate().text_size(sz(13.)).text_color(p.ink_2).child(title))
        .when_some(opens, |d, shown| {
            let (muted, ink, hover) = (p.muted, p.ink, p.sunken);
            d.child(
                div()
                    .id(SharedString::from(format!("open-{id}")))
                    .px_2()
                    .py(px(2.))
                    .rounded(px(5.))
                    .text_size(sz(12.5))
                    .text_color(muted)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover).text_color(ink))
                    .child("Open")
                    .on_click(move |_, window, _| {
                        open(shown.clone());
                        window.refresh();
                    }),
            )
        });
    div()
        .w_full()
        .flex_shrink_0()
        .rounded(px(8.))
        .border_1()
        .border_color(p.rule)
        .bg(p.raised)
        .overflow_hidden()
        .child(head)
        .child(body)
        .into_any_element()
}

/// An image inline in a card, on a light ground (SVGs are often transparent), at most `max` tall; at `natural` size
/// when it's known (an SVG drawn at twice its size for sharpness).
pub fn picture(image: Arc<Image>, max: f32, natural: Option<Size<f32>>) -> AnyElement {
    let mut picture = img(image).max_h(px(max)).max_w_full().object_fit(ObjectFit::Contain);
    if let Some(natural) = natural {
        let shrink = (max / natural.height).min(1.);
        picture = picture.w(px(natural.width * shrink)).h(px(natural.height * shrink));
    }
    div().w_full().flex().justify_center().p_3().bg(gpui::white()).child(picture).into_any_element()
}

/// The first lines of a source, quiet, for an HTML card.
pub fn excerpt(language: &str, content: &str, cx: &App) -> AnyElement {
    let lines: Vec<&str> = content.lines().collect();
    let shown = lines.iter().take(8).cloned().collect::<Vec<_>>().join("\n");
    let more = lines.len().saturating_sub(8);
    let p = crate::theme::palette(cx);
    div()
        .px(px(12.))
        .py(px(9.))
        .font_family(MONO)
        .text_size(sz(12.))
        .line_height(relative(1.5))
        .bg(p.code)
        .child(div().whitespace_nowrap().overflow_hidden().child(crate::message::highlighted(language, shown, cx)))
        .when(more > 0, |d| d.child(div().pt_1().text_color(p.faint).child(format!("{more} more lines"))))
        .into_any_element()
}

/// Something the thread produced, for the panel's Changes (src/shared/artifacts.ts threadArtifacts): an edit (a
/// patch), a file written, or an HTML or SVG block in a reply. `key` is the item's key with its place there.
#[derive(Clone, Debug, PartialEq)]
pub struct Art {
    pub key: String,
    /// "diff", "html", "svg", "markdown", "image" or "code".
    pub kind: &'static str,
    pub title: String,
    pub path: Option<String>,
    pub content: String,
    pub lang: String,
    /// "edit", "write" or "reply".
    pub source: &'static str,
}

fn kind_name(path: &str) -> &'static str {
    match kind_of_path(path) {
        Kind::Html => "html",
        Kind::Svg => "svg",
        Kind::Markdown => "markdown",
        Kind::Image => "image",
        Kind::Code => "code",
    }
}

/// Every artifact in a thread's items, oldest first.
pub fn thread_artifacts(items: &[serde_json::Value]) -> Vec<Art> {
    let s = |v: &serde_json::Value| v.as_str().map(str::to_owned);
    let mut out = vec![];
    for item in items {
        let key = s(&item["key"]).unwrap_or_default();
        if item["kind"] == "tool" && item["status"] == "done" {
            let Some(path) = s(&item["args"]["path"]).or_else(|| s(&item["args"]["file_path"])) else { continue };
            let lang = path.rsplit('.').next().unwrap_or("").to_lowercase();
            match item["name"].as_str() {
                Some("edit") => {
                    if let Some(patch) = s(&item["details"]["patch"]).filter(|p| !p.is_empty()) {
                        out.push(Art { key: format!("{key}:diff"), kind: "diff", title: path.clone(), path: Some(path), content: patch, lang, source: "edit" });
                    }
                }
                Some("write") => {
                    if let Some(content) = s(&item["args"]["content"]) {
                        out.push(Art { key: format!("{key}:file"), kind: kind_name(&path), title: path.clone(), path: Some(path), content, lang, source: "write" });
                    }
                }
                _ => {}
            }
        } else if item["kind"] == "assistant" && !item["streaming"].as_bool().unwrap_or(false) {
            let text = s(&item["text"]).unwrap_or_default();
            let mut n = 0;
            let mut lines = text.lines();
            while let Some(line) = lines.next() {
                let Some(fence) = line.strip_prefix("```") else { continue };
                let lang = fence.split_whitespace().next().unwrap_or("").to_lowercase();
                let mut body = vec![];
                for inner in lines.by_ref() {
                    if inner.trim_end() == "```" {
                        break;
                    }
                    body.push(inner);
                }
                let body = body.join("\n");
                let kind = match lang.as_str() {
                    "html" => "html",
                    "svg" => "svg",
                    "" if body.trim_start().to_lowercase().starts_with("<svg") => "svg",
                    _ => continue,
                };
                out.push(Art { key: format!("{key}:block{n}"), kind, title: if kind == "html" { "HTML snippet".into() } else { "SVG image".into() }, path: None, content: body, lang, source: "reply" });
                n += 1;
            }
        }
    }
    out
}

