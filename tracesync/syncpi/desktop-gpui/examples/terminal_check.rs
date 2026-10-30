// Checks the native terminal's plumbing without a window: starts the app's host (SYNCPI_HOME), opens a shell for the
// thread named on the command line over the host's socket, types `echo`, and prints the screen as alacritty_terminal
// keeps it. `cargo run --example terminal_check -- <thread id>`
#[path = "../src/host.rs"]
mod host;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use std::time::{Duration, Instant};

struct Size(usize, usize);
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.1
    }
    fn screen_lines(&self) -> usize {
        self.1
    }
    fn columns(&self) -> usize {
        self.0
    }
}

fn main() -> anyhow::Result<()> {
    let id = std::env::args().nth(1).expect("a thread id");
    let host = host::Host::start()?;
    // The host opens the thread on the first request for it.
    let _ = host.post(&format!("/api/sessions/{id}/open"), &serde_json::json!({}));
    let mut socket = host.socket(&format!("/terminal/{id}/ws"))?;
    let mut term = Term::new(Config::default(), &Size(80, 12), VoidListener);
    let mut parser: Processor = Processor::new();
    socket.send(tungstenite::Message::text(r#"{"cols":80,"rows":12}"#))?;
    socket.send(tungstenite::Message::text(r#"{"data":"echo native-terminal-$((40+2))\r"}"#))?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(6) {
        let _ = socket.flush();
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                let message: serde_json::Value = serde_json::from_str(text.as_str())?;
                if let Some(data) = message["data"].as_str() {
                    parser.advance(&mut term, data.as_bytes());
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.into()),
        }
    }
    let content = term.renderable_content();
    let mut rows = vec![String::new(); 12];
    for cell in content.display_iter {
        rows[cell.point.line.0 as usize].push(cell.c);
    }
    for row in rows.iter().map(|r| r.trim_end()).filter(|r| !r.is_empty()) {
        println!("| {row}");
    }
    host.stop();
    Ok(())
}
