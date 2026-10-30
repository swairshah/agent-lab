// The look shared with the web view (src/web/style.css): warm paper and a red accent in light mode, Delta One Dark
// with a blue accent in dark mode, thin rules, IBM Plex. The
// palette is set onto gpui-component's theme so every stock component follows it, and kept as a global for the
// tokens the stock theme has no slot for.
use gpui::*;
use gpui_component::{Theme, ThemeMode};
use std::borrow::Cow;

#[derive(Clone, Copy)]
pub struct Palette {
    pub paper: Hsla,
    pub surface: Hsla,
    pub raised: Hsla,
    pub sunken: Hsla,
    /// Code blocks and tool output.
    pub code: Hsla,
    pub ink: Hsla,
    pub ink_2: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub rule: Hsla,
    pub rule_strong: Hsla,
    pub accent: Hsla,
    pub accent_ink: Hsla,
    pub accent_soft: Hsla,
    pub added: Hsla,
    pub removed: Hsla,
    pub warn: Hsla,
    pub ok: Hsla,
    pub dark: bool,
}
impl Global for Palette {}

fn hex(value: u32) -> Hsla {
    rgb(value).into()
}

impl Palette {
    pub fn light() -> Self {
        Self {
            paper: hex(0xf8f6f1),
            surface: hex(0xfbfaf6),
            raised: hex(0xffffff),
            sunken: hex(0xf1eee7),
            code: hex(0xf1eee7),
            ink: hex(0x26241f),
            ink_2: hex(0x4d4940),
            muted: hex(0x8b8579),
            faint: hex(0xb3ada2),
            rule: hex(0xe6e1d7),
            rule_strong: hex(0xd7d0c3),
            accent: hex(0xc6432c),
            accent_ink: hex(0xffffff),
            accent_soft: hex(0xf6e4de),
            added: hex(0x2f7a46),
            removed: hex(0xb3402d),
            warn: hex(0xa8661a),
            ok: hex(0x2f7a46),
            dark: false,
        }
    }
    /// Delta's "Delta One Dark", as the web view's dark mode (src/web/style.css).
    pub fn dark() -> Self {
        Self {
            paper: hex(0x191c1f),
            surface: hex(0x1d2023),
            raised: hex(0x22252a),
            sunken: hex(0x202327),
            code: hex(0x16191b),
            ink: hex(0xdce0e5),
            ink_2: hex(0xc3c8d0),
            muted: hex(0xa9afbb),
            faint: hex(0x5d636e),
            rule: hex(0x292c32),
            rule_strong: hex(0x32363d),
            accent: hex(0x76ade4),
            accent_ink: hex(0x191c1f),
            accent_soft: hex(0x2b3946),
            added: hex(0xa2c186),
            removed: hex(0xd07277),
            warn: hex(0xdec184),
            ok: hex(0xa2c186),
            dark: true,
        }
    }
}

pub const SANS: &str = "IBM Plex Sans";
pub const MONO: &str = "IBM Plex Mono";

/// Registers the bundled IBM Plex faces (SIL Open Font License; see assets/fonts/OFL.txt).
pub fn load_fonts(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf")),
        Cow::Borrowed(include_bytes!(
            "../assets/fonts/IBMPlexSans-RegularItalic.ttf"
        )),
        Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexSans-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-Medium.ttf")),
    ];
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        eprintln!("syncpi: could not load bundled fonts: {error}");
    }
}

/// Switches light or dark, paints gpui-component's theme with the syncpi palette, and scales text by `zoom`: the
/// window's rem size scales every size given in rems (ours and gpui-component's).
pub fn apply(dark: bool, zoom: f32, mut window: Option<&mut Window>, cx: &mut App) {
    if let Some(window) = window.as_deref_mut() {
        window.set_rem_size(px(16. * zoom));
    }
    Theme::change(
        if dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        window,
        cx,
    );
    let p = if dark {
        Palette::dark()
    } else {
        Palette::light()
    };
    let hover = p.sunken;
    let theme = cx.global_mut::<Theme>();
    theme.font_family = SANS.into();
    theme.mono_font_family = MONO.into();
    theme.font_size = px(14. * zoom);
    theme.mono_font_size = px(12.5 * zoom);
    theme.radius = px(6.);
    theme.radius_lg = px(10.);
    let c = &mut theme.colors;
    c.background = p.paper;
    c.foreground = p.ink;
    c.muted = p.sunken;
    c.muted_foreground = p.muted;
    c.border = p.rule;
    c.input = p.rule_strong;
    c.ring = p.accent.opacity(0.5);
    c.caret = p.accent;
    c.selection = p.accent.opacity(0.18);
    c.primary = p.accent;
    c.primary_hover = p.accent.opacity(0.9);
    c.primary_active = p.accent.opacity(0.8);
    c.primary_foreground = p.accent_ink;
    c.secondary = p.raised;
    c.secondary_hover = hover;
    c.secondary_active = p.rule;
    c.secondary_foreground = p.ink;
    c.accent = hover;
    c.accent_foreground = p.ink;
    c.danger = p.removed;
    c.danger_hover = p.removed.opacity(0.9);
    c.danger_active = p.removed.opacity(0.8);
    c.success = p.ok;
    c.warning = p.warn;
    c.link = p.accent;
    c.link_hover = p.accent;
    c.link_active = p.accent;
    c.popover = p.raised;
    c.popover_foreground = p.ink;
    c.sidebar = p.surface;
    c.sidebar_foreground = p.ink_2;
    c.sidebar_border = p.rule;
    c.sidebar_accent = hover;
    c.sidebar_accent_foreground = p.ink;
    c.sidebar_primary = p.accent;
    c.sidebar_primary_foreground = p.accent_ink;
    c.list = p.paper;
    c.list_hover = hover;
    c.list_active = p.accent_soft;
    c.list_active_border = p.accent.opacity(0.4);
    c.title_bar = p.paper;
    c.title_bar_border = p.rule;
    c.tab_bar = p.surface;
    c.tab = p.surface;
    c.tab_active = p.paper;
    c.tab_active_foreground = p.ink;
    c.tab_foreground = p.muted;
    c.table = p.raised;
    c.table_head = p.surface;
    c.table_head_foreground = p.ink_2;
    c.table_row_border = p.rule;
    c.window_border = p.rule;
    c.overlay = if dark {
        hsla(0., 0., 0., 0.45)
    } else {
        hsla(40. / 360., 0.08, 0.1, 0.3)
    };
    c.scrollbar = transparent_black();
    c.scrollbar_thumb = p.rule_strong;
    c.scrollbar_thumb_hover = p.muted;
    DARK.store(dark, std::sync::atomic::Ordering::Relaxed);
    cx.set_global(p);
}

/// Whether the theme now is dark, for code that has no `App` at hand (people's colors in prose.rs).
static DARK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn dark_mode() -> bool {
    DARK.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn palette(cx: &App) -> Palette {
    *cx.global::<Palette>()
}

/// The same color for a person everywhere: matches personColor() in src/web/dom.ts (its hue from the name, lighter
/// in dark mode).
pub fn person_color(name: &str, dark: bool) -> Hsla {
    let mut h: u32 = 0;
    // JavaScript's charCodeAt(0) of each code point: its first UTF-16 unit.
    for ch in name.chars() {
        let mut units = [0u16; 2];
        h = h
            .wrapping_mul(31)
            .wrapping_add(ch.encode_utf16(&mut units)[0] as u32);
    }
    let (s, l) = if dark { (0.50, 0.72) } else { (0.42, 0.44) };
    hsla((h % 360) as f32 / 360., s, l, 1.)
}

/// One or two letters for an avatar: matches initials() in src/web/dom.ts.
pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    let first = parts.first().and_then(|p| p.chars().next()).unwrap_or('?');
    let last = if parts.len() > 1 {
        parts.last().and_then(|p| p.chars().next())
    } else {
        None
    };
    format!("{first}{}", last.map(String::from).unwrap_or_default()).to_uppercase()
}

/// A size in rems from a size in pixels at the default scale: text sizes follow the user's text size (⌘+ / ⌘−).
pub fn sz(pixels: f32) -> Rems {
    rems(pixels / 16.)
}
