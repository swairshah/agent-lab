// SyncPi for the desktop: a native window around the web app. The app's local host (dist/desktop-host.mjs, from
// src/desktop/host.ts) runs as a child process: it keeps the threads' connections, syncs project files, runs the
// agent's tools on this machine and serves the pages. This program starts it, opens its launch link in a window,
// and gives the window a real menu bar, whose items run the same commands as the pages' shortcuts
// (src/shared/keymap.json).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, Wry};

/// The host process, stopped when the app quits.
struct Host(Mutex<Option<Child>>);

/// Where the host and its Node runtime are: inside the app bundle, or the repository's dist/ when developing.
fn runtime() -> (PathBuf, PathBuf) {
    if let Ok(dir) = std::env::var("SYNCPI_RUNTIME") {
        let dir = PathBuf::from(dir);
        return (PathBuf::from("node"), dir);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let bundled = exe.parent().map(|d| d.join("../Resources/runtime")).unwrap_or_default();
    if bundled.join("desktop-host.mjs").exists() {
        return (bundled.join("node"), bundled);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    (PathBuf::from("node"), dev)
}

/// Starts the host and waits for its launch link (`SYNCPI_APP http://127.0.0.1:<port>/?key=<secret>`).
fn start_host() -> Result<(Child, String), String> {
    let (node, dir) = runtime();
    let mut child = Command::new(&node)
        .arg(dir.join("desktop-host.mjs"))
        .current_dir(&dir)
        .env("SYNCPI_APP_PARENT", std::process::id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Couldn't start the SyncPi host ({}): {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("The host has no output")?;
    let mut lines = BufReader::new(stdout).lines();
    let url = loop {
        match lines.next() {
            Some(Ok(line)) => {
                if let Some(url) = line.strip_prefix("SYNCPI_APP ") {
                    break url.trim().to_owned();
                }
            }
            _ => return Err("The SyncPi host stopped before it was ready".into()),
        }
    };
    // Keep reading so the host never blocks on a full pipe.
    std::thread::spawn(move || for _ in lines {});
    Ok((child, url))
}

/// One command from the shared keymap.
struct Command_ {
    id: String,
    title: String,
    group: String,
    keys: Option<String>,
}

fn commands() -> Vec<Command_> {
    let keymap: serde_json::Value = serde_json::from_str(include_str!("../../src/shared/keymap.json")).unwrap_or_default();
    keymap
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["apps"].as_array().is_some_and(|a| a.iter().any(|v| v == "desktop")))
        .map(|c| Command_ {
            id: c["id"].as_str().unwrap_or_default().to_owned(),
            title: c["title"].as_str().unwrap_or_default().to_owned(),
            group: c["group"].as_str().unwrap_or_default().to_owned(),
            keys: c["keys"].as_str().map(str::to_owned),
        })
        .collect()
}

/// "cmd-shift-p" as a menu accelerator ("CmdOrCtrl+Shift+P"). Keys a menu shouldn't own (Esc, which stops the agent
/// in the page) have none.
fn accelerator(keys: &str) -> Option<String> {
    if keys == "escape" {
        return None;
    }
    let mut parts: Vec<&str> = keys.split('-').collect();
    let mut key = parts.pop()?.to_owned();
    if key.is_empty() {
        key = "-".into(); // "cmd--"
        parts.pop();
    }
    let mut out: Vec<String> = parts
        .iter()
        .map(|m| match *m {
            "cmd" => "CmdOrCtrl".to_owned(),
            "ctrl" => "Ctrl".to_owned(),
            "alt" => "Alt".to_owned(),
            "shift" => "Shift".to_owned(),
            other => other.to_owned(),
        })
        .collect();
    // Shifted punctuation is the key plus Shift.
    let key = match key.as_str() {
        "}" => {
            out.push("Shift".into());
            "]".to_owned()
        }
        "{" => {
            out.push("Shift".into());
            "[".to_owned()
        }
        "`" => "Backquote".to_owned(),
        "=" => "Equal".to_owned(),
        "-" => "Minus".to_owned(),
        "/" => "Slash".to_owned(),
        "," => "Comma".to_owned(),
        k if k.len() == 1 => k.to_uppercase(),
        k => k.to_uppercase(),
    };
    out.push(key);
    Some(out.join("+"))
}

fn item(app: &AppHandle, c: &Command_) -> tauri::Result<MenuItem<Wry>> {
    let accel = c.keys.as_deref().and_then(accelerator);
    MenuItem::with_id(app, c.id.as_str(), c.title.as_str(), true, accel.as_deref())
}

/// The menu bar: the app, File (threads and projects), Edit, View, Agent, Window. Each item is a keymap command.
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let all = commands();
    let pick = |ids: &[&str]| -> tauri::Result<Vec<MenuItem<Wry>>> {
        ids.iter().filter_map(|id| all.iter().find(|c| c.id == *id)).map(|c| item(app, c)).collect()
    };
    let group = |group: &str, skip: &[&str]| -> tauri::Result<Vec<MenuItem<Wry>>> {
        all.iter().filter(|c| c.group == group && !skip.contains(&c.id.as_str())).map(|c| item(app, c)).collect()
    };
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::new(app, "SyncPi", true)?;
    app_menu.append(&PredefinedMenuItem::about(app, Some("About SyncPi"), None)?)?;
    app_menu.append(&sep()?)?;
    for i in pick(&["app.settings", "app.keymap"])? {
        app_menu.append(&i)?;
    }
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::services(app, None)?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
    app_menu.append(&sep()?)?;
    for i in pick(&["app.quit"])? {
        app_menu.append(&i)?;
    }

    let file = Submenu::new(app, "File", true)?;
    for i in group("Threads", &[])? {
        file.append(&i)?;
    }
    file.append(&sep()?)?;
    for i in group("Project", &[])? {
        file.append(&i)?;
    }

    let edit = Submenu::new(app, "Edit", true)?;
    edit.append(&PredefinedMenuItem::undo(app, None)?)?;
    edit.append(&PredefinedMenuItem::redo(app, None)?)?;
    edit.append(&sep()?)?;
    edit.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit.append(&PredefinedMenuItem::select_all(app, None)?)?;
    edit.append(&sep()?)?;
    for i in pick(&["find.open", "find.next", "find.previous"])? {
        edit.append(&i)?;
    }
    edit.append(&sep()?)?;
    for i in pick(&["file.comment"])? {
        edit.append(&i)?;
    }

    let view = Submenu::new(app, "View", true)?;
    for i in pick(&["palette.all", "palette.commands", "palette.threads", "palette.files"])? {
        view.append(&i)?;
    }
    view.append(&sep()?)?;
    for i in group("View", &["file.comment"])? {
        view.append(&i)?;
    }
    view.append(&sep()?)?;
    for i in pick(&["app.theme"])? {
        view.append(&i)?;
    }

    let agent = Submenu::new(app, "Agent", true)?;
    for i in group("Agent", &[])? {
        agent.append(&i)?;
    }

    let window = Submenu::new(app, "Window", true)?;
    window.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window.append(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)?;
    window.append(&sep()?)?;
    window.append(&PredefinedMenuItem::close_window(app, None)?)?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &agent, &window])
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// macOS knows a program as an app (its name and icon in the Dock and the app switcher) only when it runs from inside
/// an app bundle. A build run straight from target/ (`cargo run`, `npm run desktop`) puts itself in a SyncPi.app next
/// to it, the same as the packaged one (scripts/mac-bundle.mjs), and runs from there instead.
#[cfg(target_os = "macos")]
fn in_bundle() {
    use std::os::unix::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else { return };
    if exe.to_string_lossy().contains(".app/Contents/MacOS/") || std::env::var_os("SYNCPI_NO_BUNDLE").is_some() {
        return;
    }
    let Some(dir) = exe.parent() else { return };
    let contents = dir.join("SyncPi.app/Contents");
    let program = contents.join("MacOS/SyncPi");
    let made = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(contents.join("MacOS"))?;
        std::fs::create_dir_all(contents.join("Resources"))?;
        let _ = std::fs::remove_file(&program);
        std::fs::copy(&exe, &program)?;
        std::fs::write(contents.join("Info.plist"), include_str!("../Info.plist"))?;
        std::fs::write(contents.join("Resources/Assets.car"), include_bytes!("../icons/Assets.car"))?;
        std::fs::write(contents.join("Resources/icon.icns"), include_bytes!("../icons/icon.icns"))?;
        Ok(())
    })();
    if made.is_ok() {
        // exec only returns if it failed; then carry on as a plain program.
        let _ = std::process::Command::new(&program).args(std::env::args_os().skip(1)).env("SYNCPI_NO_BUNDLE", "1").exec();
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    in_bundle();
    let (child, url) = match start_host() {
        Ok(started) => started,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    let url: tauri::Url = url.parse().expect("the host's launch link");
    let origin = url.origin();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Host(Mutex::new(Some(child))))
        .invoke_handler(tauri::generate_handler![quit])
        .menu(menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(format!("window.syncpiCommand && window.syncpiCommand({})", serde_json::Value::from(id)));
            }
        })
        .setup(move |app| {
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("SyncPi")
                .inner_size(1380., 900.)
                .min_inner_size(720., 480.)
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                // Links out of the app open in the browser; the window stays on the app.
                .on_navigation(move |to| {
                    if to.origin() == origin {
                        return true;
                    }
                    if matches!(to.scheme(), "http" | "https" | "mailto") {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = opener.opener().open_url(to.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("SyncPi")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Host>().0.lock().ok().and_then(|mut c| c.take()) {
                    let _ = child.kill();
                }
            }
            if let RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } = event {
                app.exit(0);
            }
        });
}
