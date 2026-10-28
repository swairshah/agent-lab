// End-to-end check using the same client and sidecar that the native GPUI window owns.
#[allow(dead_code)]
#[path = "../backend.rs"]
mod backend;
use backend::Backend;
use serde_json::json;
use std::{
    fs,
    time::{Duration, Instant},
};
fn wait<T>(mut f: impl FnMut() -> anyhow::Result<Option<T>>, seconds: u64) -> anyhow::Result<T> {
    let start = Instant::now();
    loop {
        if let Some(value) = f()? {
            return Ok(value);
        }
        if start.elapsed() > Duration::from_secs(seconds) {
            anyhow::bail!("Native integration check timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn main() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!("syncpi-native-probe-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root)?;
    let project = root.join("project");
    fs::create_dir(&project)?;
    fs::write(project.join("README.md"), "# Native probe\n")?;
    let (backend, events) = Backend::launch()?;
    let result = (|| -> anyhow::Result<()> {
        let created = backend.call(
            "POST",
            "/api/sessions",
            Some(json!({"dir":project,"compute":"local","title":"Native integration check"})),
        )?;
        let id = created["id"].as_str().unwrap();
        backend.select(id);
        wait(
            || {
                let catalog = backend.get("/api/sessions")?;
                let s = catalog["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"] == id)
                    .unwrap();
                if s["status"] == "failed" {
                    anyhow::bail!("{}", s["error"]);
                }
                Ok((s["status"] == "ready").then_some(()))
            },
            90,
        )?;
        let native_path = format!("/api/sessions/{id}/native");
        wait(
            || {
                let data = backend.get(&native_path)?;
                Ok(
                    (data["me"]["role"] == "admin" && data["env"]["status"] == "ready")
                        .then_some(()),
                )
            },
            120,
        )?;
        println!(
            "✓ The native app client provisions its own session and receives normalized agent, role, and setup state"
        );
        let live = std::env::var("SYNCPI_LIVE").as_deref() == Ok("1");
        let prompt = if live {
            "Use your tools to write native-proof.txt containing exactly NATIVE_AGENT_OK followed by a newline, read it back, then reply with just NATIVE_AGENT_OK. Change no other files."
        } else {
            "write native-proof.txt NATIVE_AGENT_OK"
        };
        backend.call("POST",&format!("/api/sessions/{id}/send"),Some(json!({"type":"submit","requestId":uuid::Uuid::new_v4().to_string(),"text":prompt,"where":"device"})))?;
        wait(
            || {
                Ok(fs::read_to_string(project.join("native-proof.txt"))
                    .ok()
                    .filter(|s| s.trim() == "NATIVE_AGENT_OK"))
            },
            120,
        )?;
        wait(
            || {
                let snapshot = backend.get(&native_path)?;
                let items = snapshot["main"]["items"].as_array().unwrap();
                Ok((snapshot["main"]["busy"] == false
                    && items
                        .iter()
                        .any(|i| i["kind"] == "assistant" && i["streaming"] == false))
                .then_some(()))
            },
            120,
        )?;
        println!(
            "✓ {} model executes tools in the native app user's checkout without a CLI session",
            if live { "Live Pi" } else { "Scripted" }
        );
        let terminal = backend.terminal(id, 1);
        terminal.send("printf 'NATIVE_PTY_OK\\n'\r".into())?;
        // The shared event channel is exactly what the native terminal view consumes.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut terminal_output = String::new();
        while Instant::now() < deadline {
            if let Ok(event) = events.recv_timeout(Duration::from_millis(100)) {
                if let backend::Event::Terminal(_, data) = event {
                    terminal_output.push_str(&data);
                    if terminal_output.contains("NATIVE_PTY_OK\r\n") {
                        break;
                    }
                }
            }
        }
        anyhow::ensure!(
            terminal_output.contains("NATIVE_PTY_OK"),
            "Native PTY produced no expected output"
        );
        let _ = terminal.send("__CLOSE__".into());
        println!("✓ Native terminal transport executes commands through the packaged PTY");
        let file = backend.get(&format!("/api/sessions/{id}/file?path=native-proof.txt"))?;
        anyhow::ensure!(file["text"].as_str().unwrap().trim() == "NATIVE_AGENT_OK");
        backend.call(
            "POST",
            &format!("/api/sessions/{id}/send"),
            Some(json!({"type":"invite","role":"viewer"})),
        )?;
        let invite = wait(
            || {
                let state = backend.get(&native_path)?;
                Ok(state["lastInvite"]["url"].as_str().map(String::from))
            },
            15,
        )?;
        anyhow::ensure!(invite.contains("/s/"));
        println!("✓ Native file reads and sharing commands return real session data");
        println!("Native evidence: {}", root.display());
        Ok(())
    })();
    backend.shutdown();
    result
}
