// The app's local host (dist/desktop-host.mjs, the same one the Tauri app runs): it keeps each thread's connection,
// syncs project files, runs the agent's tools on this Mac and serves the thread pages. This starts it, reads its
// launch link (`SYNCPI_APP http://127.0.0.1:<port>/?key=<secret>`), and calls its API with the secret.
use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

/// Someone else in a thread, and whether they're there now.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Person {
    pub name: String,
    #[serde(default)]
    pub online: bool,
}

/// A thread, as the host lists it (src/desktop/runtime.ts list()).
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Thread {
    pub id: String,
    pub name: String,
    pub dir: String,
    #[serde(default)]
    pub compute: String,
    #[serde(default)]
    pub vm: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub bookmarked: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, rename = "createdAt")]
    pub created_at: f64,
    #[serde(default, rename = "lastOpened")]
    pub last_opened: Option<f64>,
    #[serde(default)]
    pub people: Option<Vec<Person>>,
}

impl Thread {
    pub fn ready(&self) -> bool {
        self.status.as_deref().is_none_or(|s| s == "ready")
    }

    pub fn shown_title(&self) -> String {
        self.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "New thread".into())
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Defaults {
    pub model: Option<String>,
    #[serde(rename = "thinkingLevel")]
    pub thinking_level: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Identity {
    #[serde(default)]
    pub name: String,
}

/// Joining a thread whose server asks this person to sign in first: the page to open, and what it should show.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Login {
    pub url: String,
    pub check: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Catalog {
    pub sessions: Vec<Thread>,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub identity: Identity,
    #[serde(default)]
    pub login: Option<Login>,
}

#[derive(Clone)]
pub struct Host {
    /// http://127.0.0.1:<port>
    pub origin: String,
    /// The launch link, which sets the host's cookie in a webview.
    pub launch: String,
    secret: String,
    http: Client,
    /// For streams, which stay open: no timeout.
    streams: Client,
    process: Arc<Mutex<Child>>,
}

impl Host {
    /// Starts the host from the built app (dist/, or the bundle's Resources/runtime) and waits for its launch link.
    /// SYNCPI_FAUX=1 runs it with the scripted model (tests); SYNCPI_HOME is passed through as usual.
    pub fn start() -> Result<Self> {
        let executable = std::env::current_exe()?;
        let bundled = executable.parent().unwrap().join("../Resources/runtime");
        let runtime = std::env::var_os("SYNCPI_RUNTIME").map(PathBuf::from).unwrap_or_else(|| {
            if bundled.join("desktop-host.mjs").exists() {
                bundled
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
            }
        });
        if !runtime.join("desktop-host.mjs").exists() {
            bail!("The app's host is missing: run `npm run build` in syncpi first.");
        }
        let node = std::env::var_os("SYNCPI_NODE").map(PathBuf::from).unwrap_or_else(|| {
            if runtime.join("node").exists() { runtime.join("node") } else { PathBuf::from("node") }
        });
        let mut command = Command::new(node);
        command
            .arg(runtime.join("desktop-host.mjs"))
            // The host exits when this process does.
            .env("SYNCPI_APP_PARENT", std::process::id().to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if std::env::var("SYNCPI_FAUX").as_deref() == Ok("1") {
            command.arg("--faux");
        }
        let mut process = command.spawn().context("starting the app's host")?;
        let mut reader = BufReader::new(process.stdout.take().unwrap());
        let mut line = String::new();
        let launch = loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                bail!("the app's host exited before it started");
            }
            if let Some(url) = line.strip_prefix("SYNCPI_APP ") {
                break url.trim().to_owned();
            }
        };
        let url = reqwest::Url::parse(&launch)?;
        let secret = url.query_pairs().find(|(k, _)| k == "key").context("the host's launch link has no key")?.1.to_string();
        thread::spawn(move || for _ in reader.lines() {});
        Ok(Self {
            origin: url.origin().ascii_serialization(),
            launch,
            secret,
            http: Client::builder().timeout(Duration::from_secs(60)).build()?,
            streams: Client::builder().build()?,
            process: Arc::new(Mutex::new(process)),
        })
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        let response = self.http.get(format!("{}{path}", self.origin)).bearer_auth(&self.secret).send()?;
        let status = response.status();
        let value: Value = response.json().unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("{}", value["error"].as_str().unwrap_or(status.as_str()));
        }
        Ok(value)
    }

    /// A file the host serves (a project file, a recording), as bytes.
    pub fn bytes(&self, path: &str) -> Result<Vec<u8>> {
        let response = self.http.get(format!("{}{path}", self.origin)).bearer_auth(&self.secret).send()?;
        if !response.status().is_success() {
            bail!("{}", response.status());
        }
        Ok(response.bytes()?.to_vec())
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{}{path}", self.origin))
            .bearer_auth(&self.secret)
            .header("origin", &self.origin)
            .json(body)
            .send()?;
        let status = response.status();
        let value: Value = response.json().unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("{}", value["error"].as_str().unwrap_or(status.as_str()));
        }
        Ok(value)
    }

    /// Reads a server-sent event stream until it ends, or `each` returns false: each event's data, as JSON.
    pub fn events(&self, path: &str, mut each: impl FnMut(Value) -> bool) -> Result<()> {
        let response = self.streams.get(format!("{}{path}", self.origin)).bearer_auth(&self.secret).send()?;
        if !response.status().is_success() {
            bail!("{}", response.status());
        }
        let mut data = String::new();
        for line in BufReader::new(response).lines() {
            let line = line?;
            if let Some(rest) = line.strip_prefix("data: ") {
                data.push_str(rest);
            } else if line.is_empty() && !data.is_empty() {
                let event = serde_json::from_str(&std::mem::take(&mut data));
                if let Ok(event) = event
                    && !each(event)
                {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    pub fn catalog(&self) -> Result<Catalog> {
        Ok(serde_json::from_value(self.get("/api/sessions")?)?)
    }

    /// A thread's page, as the web view embedded in an app (`?embedded=1`: it reports activity and titles through
    /// the webview's IPC, src/web/bridge.ts).
    pub fn page(&self, id: &str) -> String {
        format!("{}/session/{id}/?embedded=1", self.origin)
    }

    pub fn stop(&self) {
        let _ = self.process.lock().unwrap().kill();
    }
}
