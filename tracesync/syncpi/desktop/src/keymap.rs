// The commands and shortcuts shared with the web view (src/shared/keymap.json). Every shortcut dispatches one
// action, RunCommand, carrying the command's id; Desktop::run_command says what each id does here.
use gpui::{Action, App, KeyBinding, SharedString};
use serde::Deserialize;

#[derive(Clone, PartialEq, Debug, Action)]
#[action(namespace = syncpi, no_json)]
pub struct RunCommand {
    pub id: SharedString,
}

#[derive(Deserialize, Clone)]
pub struct Command {
    pub id: String,
    pub title: String,
    pub group: String,
    pub keys: Option<String>,
    apps: Vec<String>,
    #[serde(default)]
    pub quick: bool,
}

/// The desktop app's commands, in the order the keymap lists them.
pub fn commands() -> Vec<Command> {
    let all: Vec<Command> = serde_json::from_str(include_str!("../../src/shared/keymap.json"))
        .expect("src/shared/keymap.json parses");
    all.into_iter()
        .filter(|c| c.apps.iter().any(|a| a == "desktop"))
        .collect()
}

pub fn command(id: &str) -> Option<Command> {
    commands().into_iter().find(|c| c.id == id)
}

/// Binds every shortcut. Esc only applies outside text fields, which use it themselves.
pub fn bind(cx: &mut App) {
    let bindings: Vec<KeyBinding> = commands()
        .into_iter()
        .filter_map(|c| {
            let keys = c.keys?;
            let context = (keys == "escape").then_some("SyncPi");
            Some(KeyBinding::new(
                &keys,
                RunCommand { id: c.id.into() },
                context,
            ))
        })
        .collect();
    cx.bind_keys(bindings);
}

/// "cmd-shift-p" as ⇧⌘P, in the Mac's modifier order.
pub fn format(keys: &str) -> String {
    let mut tokens: Vec<&str> = keys.split('-').collect();
    let key = match tokens.pop() {
        Some("") | None => "-",
        Some(key) => key,
    };
    let mut out = String::new();
    for (name, symbol) in [("ctrl", "⌃"), ("alt", "⌥"), ("shift", "⇧"), ("cmd", "⌘")] {
        if tokens.contains(&name) {
            out.push_str(symbol);
        }
    }
    out.push_str(&match key {
        "escape" => "Esc".to_owned(),
        "enter" => "↩".to_owned(),
        k if k.chars().count() == 1 => k.to_uppercase(),
        k => {
            let mut chars = k.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    });
    out
}
