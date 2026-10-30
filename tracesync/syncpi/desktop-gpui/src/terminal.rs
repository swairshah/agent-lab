// A terminal, native (ctrl-`): a shell in the project's folder on this Mac, as the web view's (src/web/terminal.ts),
// drawn here as Zed and Delta draw theirs. The app's host runs the shell (a PTY, src/desktop/host.ts) and streams it
// over a WebSocket ({data}, {cols, rows} in; {data}, {exitCode}, {error} out); alacritty_terminal keeps the screen,
// and each row is drawn as text with its colors.
use crate::host::Host;
use crate::theme::{MONO, Palette, palette};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::{Config, Term, TermMode, cell::Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use gpui::{prelude::FluentBuilder, *};
use serde_json::{Value, json};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

const FONT_SIZE: f32 = 12.5;
const LINE: f32 = 18.;

/// What the terminal answers the shell with (replies to its queries) goes back over the socket.
#[derive(Clone)]
struct Listener(mpsc::Sender<String>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(text) = event {
            let _ = self.0.send(json!({ "data": text }).to_string());
        }
    }
}

struct Size {
    columns: usize,
    lines: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

pub struct TerminalView {
    pub title: String,
    term: Arc<Mutex<Term<Listener>>>,
    out: mpsc::Sender<String>,
    focus: FocusHandle,
    /// The shell's exit, or why it couldn't start.
    ended: Arc<Mutex<Option<String>>>,
    changed: Arc<AtomicBool>,
    /// The terminal's area, as last laid out, and the columns and lines it was sized to.
    area: Rc<Cell<Option<Bounds<Pixels>>>>,
    size: (usize, usize),
}

impl TerminalView {
    /// A new shell for thread `id`; `command`, when given, is typed into it once it starts (`!cmd`).
    pub fn new(host: Host, id: &str, command: Option<String>, cx: &mut Context<Self>) -> Self {
        let (out, outgoing) = mpsc::channel::<String>();
        let term = Arc::new(Mutex::new(Term::new(Config::default(), &Size { columns: 100, lines: 24 }, Listener(out.clone()))));
        let ended = Arc::new(Mutex::new(None));
        let changed = Arc::new(AtomicBool::new(true));
        if let Some(command) = &command {
            let _ = out.send(json!({ "data": format!("{command}\r") }).to_string());
        }
        // The socket, on a thread of its own: what arrives goes through the terminal's parser; what's typed goes out.
        let (screen, done, dirty, path) = (term.clone(), ended.clone(), changed.clone(), format!("/terminal/{id}/ws"));
        std::thread::spawn(move || {
            let mut socket = match host.socket(&path) {
                Ok(socket) => socket,
                Err(e) => {
                    *done.lock().unwrap() = Some(format!("Couldn't start a shell: {e}"));
                    dirty.store(true, Ordering::SeqCst);
                    return;
                }
            };
            let mut parser: Processor = Processor::new();
            loop {
                let mut idle = true;
                match socket.read() {
                    Ok(tungstenite::Message::Text(text)) => {
                        idle = false;
                        let message: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                        if let Some(data) = message["data"].as_str() {
                            parser.advance(&mut *screen.lock().unwrap(), data.as_bytes());
                        }
                        if let Some(code) = message["exitCode"].as_i64() {
                            *done.lock().unwrap() = Some(format!("The shell exited ({code})."));
                        }
                        if let Some(error) = message["error"].as_str() {
                            *done.lock().unwrap() = Some(error.to_owned());
                        }
                        dirty.store(true, Ordering::SeqCst);
                    }
                    Ok(tungstenite::Message::Close(_)) => break,
                    Ok(_) => idle = false,
                    Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => break,
                }
                // Typed text: sent, or gone when the view is (its sender with it).
                loop {
                    match outgoing.try_recv() {
                        Ok(frame) => {
                            idle = false;
                            if socket.send(tungstenite::Message::text(frame)).is_err() {
                                return;
                            }
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            let _ = socket.close(None);
                            return;
                        }
                    }
                }
                let _ = socket.flush();
                if idle {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            let mut ended = done.lock().unwrap();
            if ended.is_none() {
                *ended = Some("The shell's connection closed.".into());
            }
            dirty.store(true, Ordering::SeqCst);
        });
        // Redraw when the screen changed.
        let watching = changed.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(16)).await;
                if watching.swap(false, Ordering::SeqCst) && this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
                if this.update(cx, |_, _| ()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            title: command.unwrap_or_else(|| "Shell".into()),
            term,
            out,
            focus: cx.focus_handle(),
            ended,
            changed,
            area: Rc::new(Cell::new(None)),
            size: (100, 24),
        }
    }

    pub fn focus(&self, window: &mut Window) {
        window.focus(&self.focus);
    }

    fn send(&self, data: &str) {
        let _ = self.out.send(json!({ "data": data }).to_string());
        // Typing goes to the bottom of the screen.
        self.term.lock().unwrap().scroll_display(Scroll::Bottom);
    }

    /// A key, as the bytes a terminal sends for it.
    fn key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let k = &event.keystroke;
        let m = k.modifiers;
        if m.platform {
            match k.key.as_str() {
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        let bracketed = self.term.lock().unwrap().mode().contains(TermMode::BRACKETED_PASTE);
                        self.send(&if bracketed { format!("\x1b[200~{text}\x1b[201~") } else { text });
                    }
                }
                "k" => {
                    self.send("\x0c");
                }
                _ => return,
            }
            cx.stop_propagation();
            return;
        }
        let app_cursor = self.term.lock().unwrap().mode().contains(TermMode::APP_CURSOR);
        let arrow = |c: char| if app_cursor { format!("\x1bO{c}") } else { format!("\x1b[{c}") };
        let bytes: Option<String> = match k.key.as_str() {
            "enter" => Some("\r".into()),
            "backspace" => Some(if m.alt { "\x1b\x7f".into() } else { "\x7f".into() }),
            "tab" => Some(if m.shift { "\x1b[Z".into() } else { "\t".into() }),
            "escape" => Some("\x1b".into()),
            "up" => Some(arrow('A')),
            "down" => Some(arrow('B')),
            "right" => Some(if m.alt { "\x1bf".into() } else { arrow('C') }),
            "left" => Some(if m.alt { "\x1bb".into() } else { arrow('D') }),
            "home" => Some("\x1b[H".into()),
            "end" => Some("\x1b[F".into()),
            "delete" => Some("\x1b[3~".into()),
            "pageup" => {
                self.term.lock().unwrap().scroll_display(Scroll::PageUp);
                cx.notify();
                None
            }
            "pagedown" => {
                self.term.lock().unwrap().scroll_display(Scroll::PageDown);
                cx.notify();
                None
            }
            key if m.control && key.len() == 1 => {
                let c = key.chars().next().unwrap().to_ascii_lowercase();
                c.is_ascii_lowercase().then(|| ((c as u8 - b'a' + 1) as char).to_string())
            }
            _ => k.key_char.clone().map(|text| if m.alt { format!("\x1b{text}") } else { text }),
        };
        if let Some(bytes) = bytes {
            self.send(&bytes);
        }
        cx.stop_propagation();
    }

    /// Sizes the terminal to its area: columns and lines of the monospaced cell, sent to the shell when they change.
    fn fit(&mut self, window: &mut Window) {
        let Some(area) = self.area.get() else { return };
        let font = gpui::font(MONO);
        let id = window.text_system().resolve_font(&font);
        let width = window.text_system().advance(id, px(FONT_SIZE), 'm').map(|s| s.width).unwrap_or(px(7.5));
        let columns = ((area.size.width - px(16.)) / width).floor().max(20.) as usize;
        let lines = ((area.size.height - px(8.)) / px(LINE)).floor().max(4.) as usize;
        if (columns, lines) != self.size {
            self.size = (columns, lines);
            self.term.lock().unwrap().resize(Size { columns, lines });
            let _ = self.out.send(json!({ "cols": columns, "rows": lines }).to_string());
        }
    }
}

/// A terminal color, in this theme: the 16 named colors as in One Dark (dark) or One Light, the 256-color cube, grays.
fn color(c: Color, p: &Palette, fg: bool) -> Hsla {
    const DARK: [u32; 16] = [0x3f4451, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xd7dae0, 0x5c6370, 0xef7d87, 0xa5d68b, 0xf0cd8d, 0x74bdf8, 0xd38ce6, 0x6cc6d1, 0xffffff];
    const LIGHT: [u32; 16] = [0x383a42, 0xe45649, 0x50a14f, 0xc18401, 0x4078f2, 0xa626a4, 0x0184bc, 0xa0a1a7, 0x696c77, 0xca1243, 0x3e953a, 0x986801, 0x2f6af2, 0x8a1f8a, 0x0e7490, 0x202227];
    let table = if p.dark { DARK } else { LIGHT };
    match c {
        Color::Spec(Rgb { r, g, b }) => rgb(((r as u32) << 16) | ((g as u32) << 8) | b as u32).into(),
        Color::Indexed(n) if n < 16 => rgb(table[n as usize]).into(),
        Color::Indexed(n) if n < 232 => {
            let n = n - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v as u32 * 40 };
            rgb((level(n / 36) << 16) | (level((n / 6) % 6) << 8) | level(n % 6)).into()
        }
        Color::Indexed(n) => {
            let v = 8 + (n as u32 - 232) * 10;
            rgb((v << 16) | (v << 8) | v).into()
        }
        Color::Named(named) => {
            let n = named as usize;
            if n < 16 {
                rgb(table[n]).into()
            } else if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&n) {
                Hsla::from(rgb(table[n - NamedColor::DimBlack as usize])).opacity(0.7)
            } else if fg || named == NamedColor::Foreground {
                p.ink
            } else {
                p.raised
            }
        }
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.fit(window);
        let p = palette(cx);
        let focused = self.focus.is_focused(window);
        let font = gpui::font(MONO);
        let (rows, cursor) = {
            let term = self.term.lock().unwrap();
            let content = term.renderable_content();
            let offset = content.display_offset as i32;
            let cursor = content.cursor.point;
            let mut rows: Vec<Vec<(char, Hsla, Option<Hsla>, Flags)>> = vec![Vec::new(); self.size.1];
            for indexed in content.display_iter {
                let row = indexed.point.line.0 + offset;
                if row < 0 || row as usize >= rows.len() {
                    continue;
                }
                let cell = &indexed.cell;
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let (mut fg, mut bg) = (color(cell.fg, &p, true), match cell.bg {
                    Color::Named(NamedColor::Background) => None,
                    other => Some(color(other, &p, false)),
                });
                if cell.flags.contains(Flags::INVERSE) {
                    let back = bg.unwrap_or(p.raised);
                    bg = Some(fg);
                    fg = back;
                }
                if cell.flags.intersects(Flags::DIM) {
                    fg = fg.opacity(0.7);
                }
                rows[row as usize].push((cell.c, fg, bg, cell.flags));
            }
            let cursor = (cursor.line.0 + offset >= 0).then_some(((cursor.line.0 + offset) as usize, cursor.column.0));
            (rows, cursor)
        };
        let mut lines = div().flex().flex_col().px_2().py_1();
        for (n, row) in rows.into_iter().enumerate() {
            let mut text = String::new();
            let mut runs: Vec<TextRun> = vec![];
            for (column, (c, fg, bg, flags)) in row.into_iter().enumerate() {
                let at_cursor = focused && cursor == Some((n, column));
                let (fg, bg) = if at_cursor { (p.raised, Some(p.ink)) } else { (fg, bg) };
                let c = if c == '\0' { ' ' } else { c };
                let len = c.len_utf8();
                text.push(c);
                let run = TextRun {
                    len,
                    font: Font {
                        weight: if flags.contains(Flags::BOLD) { FontWeight::BOLD } else { FontWeight::NORMAL },
                        style: if flags.contains(Flags::ITALIC) { FontStyle::Italic } else { FontStyle::Normal },
                        ..font.clone()
                    },
                    color: fg,
                    background_color: bg,
                    underline: flags.contains(Flags::UNDERLINE).then(|| UnderlineStyle { thickness: px(1.), color: Some(fg), wavy: false }),
                    strikethrough: None,
                };
                match runs.last_mut() {
                    Some(last) if last.font == run.font && last.color == run.color && last.background_color == run.background_color && last.underline == run.underline => last.len += len,
                    _ => runs.push(run),
                }
            }
            if text.is_empty() {
                text.push(' ');
                runs.push(TextRun { len: 1, font: font.clone(), color: p.ink, background_color: None, underline: None, strikethrough: None });
            }
            lines = lines.child(div().h(px(LINE)).whitespace_nowrap().child(StyledText::new(text).with_runs(runs)));
        }
        let ended = self.ended.lock().unwrap().clone();
        let area = self.area.clone();
        div()
            .id("terminal")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(p.raised)
            .text_size(px(FONT_SIZE))
            .line_height(px(LINE))
            .font_family(MONO)
            .text_color(p.ink)
            .track_focus(&self.focus)
            .key_context("Terminal")
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, _| this.focus(window)))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                let lines = (event.delta.pixel_delta(px(LINE)).y / px(LINE)).round() as i32;
                if lines != 0 {
                    this.term.lock().unwrap().scroll_display(Scroll::Delta(lines));
                    cx.notify();
                }
            }))
            .child(canvas(move |bounds, _, _| area.set(Some(bounds)), |_, _, _, _| {}).absolute().inset_0())
            .child(lines)
            .when_some(ended, |d, note| {
                d.child(div().absolute().bottom_1().right_2().px_2().py(px(2.)).rounded(px(4.)).bg(p.sunken).text_color(p.muted).font_family(crate::theme::SANS).text_size(px(11.5)).child(note))
            })
    }
}

impl Drop for TerminalView {
    fn drop(&mut self) {
        self.changed.store(false, Ordering::SeqCst);
    }
}
