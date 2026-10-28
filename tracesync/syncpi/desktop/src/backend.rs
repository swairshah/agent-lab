use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};
use tungstenite::{Message, client::IntoClientRequest};

#[derive(Debug)]
pub enum Event {
    Catalog(Value),
    Snapshot(String, Value),
    Reply {
        session: String,
        tag: String,
        value: Value,
    },
    Error(String),
    Terminal(usize, String),
    TerminalClosed(usize, String),
}
#[derive(Clone)]
pub struct Backend {
    pub origin: String,
    secret: String,
    http: Client,
    active: Arc<Mutex<String>>,
    pub events: Sender<Event>,
    alive: Arc<AtomicBool>,
    process: Arc<Mutex<Child>>,
}
impl Backend {
    pub fn launch() -> Result<(Self, Receiver<Event>)> {
        let executable = std::env::current_exe()?;
        let bundled = executable.parent().unwrap().join("../Resources/runtime");
        let runtime = std::env::var_os("SYNCPI_RUNTIME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if bundled.join("desktop-host.mjs").exists() {
                    bundled
                } else {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
                }
            });
        if !runtime.join("desktop-host.mjs").exists() {
            bail!("SyncPi runtime is missing. Run npm run build before launching the desktop app.");
        }
        let node = std::env::var_os("SYNCPI_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if runtime.join("node").exists() {
                    runtime.join("node")
                } else {
                    PathBuf::from("node")
                }
            });
        let mut command = Command::new(node);
        command
            .arg(runtime.join("desktop-host.mjs"))
            .env("SYNCPI_APP_PARENT", std::process::id().to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if std::env::var("SYNCPI_FAUX").as_deref() == Ok("1") {
            command.arg("--faux");
        }
        let mut process = command
            .spawn()
            .context("Starting the SyncPi agent service")?;
        let mut reader = BufReader::new(process.stdout.take().unwrap());
        let mut line = String::new();
        let launch = loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                bail!("The SyncPi service exited before startup");
            }
            if let Some(url) = line.strip_prefix("SYNCPI_APP ") {
                break url.trim().to_owned();
            }
        };
        let url = reqwest::Url::parse(&launch)?;
        let secret = url
            .query_pairs()
            .find(|(k, _)| k == "key")
            .context("Service did not return its launch key")?
            .1
            .to_string();
        thread::spawn(move || for _ in reader.lines() {});
        let (events, receiver) = mpsc::channel();
        let backend = Self {
            origin: url.origin().ascii_serialization(),
            secret,
            http: Client::builder()
                .timeout(Duration::from_secs(120))
                .build()?,
            active: Arc::new(Mutex::new(String::new())),
            events,
            alive: Arc::new(AtomicBool::new(true)),
            process: Arc::new(Mutex::new(process)),
        };
        let worker = backend.clone();
        thread::spawn(move || {
            let mut last_catalog = Value::Null;
            let mut last_snapshot = Value::Null;
            while worker.alive.load(Ordering::Relaxed) {
                match worker.get("/api/sessions") {
                    Ok(catalog) => {
                        if catalog != last_catalog {
                            let _ = worker.events.send(Event::Catalog(catalog.clone()));
                            last_catalog = catalog.clone();
                        }
                        let id = worker.active.lock().unwrap().clone();
                        let selected = catalog["sessions"]
                            .as_array()
                            .and_then(|a| a.iter().find(|s| s["id"].as_str() == Some(&id)));
                        if !id.is_empty()
                            && selected.is_some_and(|s| {
                                s["status"] != "provisioning" && s["status"] != "failed"
                            })
                        {
                            match worker.get(&format!("/api/sessions/{id}/native")) {
                                Ok(value) => {
                                    if json!({"id": &id, "value": &value}) != last_snapshot {
                                        last_snapshot = json!({"id": &id, "value": &value});
                                        let _ = worker.events.send(Event::Snapshot(id, value));
                                    }
                                }
                                Err(e) => {
                                    let _ = worker.events.send(Event::Error(e.to_string()));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = worker.events.send(Event::Error(e.to_string()));
                    }
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
        Ok((backend, receiver))
    }
    pub fn get(&self, path: &str) -> Result<Value> {
        self.call("GET", path, None)
    }
    pub fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let request = self
            .http
            .request(method.parse()?, format!("{}{path}", self.origin))
            .bearer_auth(&self.secret);
        let response = if let Some(body) = body {
            request.json(&body)
        } else {
            request
        }
        .send()?;
        let status = response.status();
        let data: Value = response.json()?;
        if !status.is_success() {
            bail!("{}", data["error"].as_str().unwrap_or("The request failed"));
        }
        Ok(data)
    }
    pub fn select(&self, id: &str) {
        *self.active.lock().unwrap() = id.to_owned();
    }
    pub fn request(&self, tag: &str, method: &str, path: &str, body: Option<Value>) {
        let this = self.clone();
        let (tag, method, path, session) = (
            tag.to_owned(),
            method.to_owned(),
            path.to_owned(),
            this.active.lock().unwrap().clone(),
        );
        thread::spawn(move || match this.call(&method, &path, body) {
            Ok(value) => {
                let _ = this.events.send(Event::Reply {
                    session,
                    tag,
                    value,
                });
            }
            Err(e) => {
                let _ = this.events.send(Event::Error(e.to_string()));
            }
        });
    }
    pub fn send(&self, id: &str, message: Value) {
        self.request(
            "command",
            "POST",
            &format!("/api/sessions/{id}/send"),
            Some(message),
        );
    }
    pub fn save_file(&self, id: &str, path: &str, base: &str, text: String) {
        let this = self.clone();
        let (id, path, base) = (id.to_owned(), path.to_owned(), base.to_owned());
        thread::spawn(move || {
            let result = (|| -> Result<Value> {
                let response = this
                    .http
                    .put(format!("{}/api/sessions/{id}/file", this.origin))
                    .query(&[("path", &path), ("base", &base)])
                    .bearer_auth(&this.secret)
                    .body(text)
                    .send()?;
                let status = response.status();
                let data: Value = response.json()?;
                if !status.is_success() {
                    bail!(
                        "{}",
                        data["error"].as_str().unwrap_or("Could not save the file")
                    );
                }
                Ok(data)
            })();
            match result {
                Ok(value) => {
                    let _ = this.events.send(Event::Reply {
                        session: id,
                        tag: format!("saved:{path}"),
                        value,
                    });
                }
                Err(e) => {
                    let _ = this.events.send(Event::Error(e.to_string()));
                }
            }
        });
    }
    pub fn terminal(&self, session: &str, id: usize) -> Sender<String> {
        let this = self.clone();
        let url = format!(
            "{}/terminal/{session}",
            this.origin.replacen("http", "ws", 1)
        );
        let (sender, receiver) = mpsc::channel::<String>();
        thread::spawn(move || {
            let result = (|| -> Result<()> {
                let mut request = url.into_client_request()?;
                request
                    .headers_mut()
                    .insert("Authorization", format!("Bearer {}", this.secret).parse()?);
                let (mut socket, _) = tungstenite::connect(request)?;
                if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_mut() {
                    stream.set_read_timeout(Some(Duration::from_millis(30)))?;
                }
                socket.send(Message::Text(
                    json!({"cols":100,"rows":16}).to_string().into(),
                ))?;
                loop {
                    for input in receiver.try_iter() {
                        if input == "__CLOSE__" {
                            socket.close(None)?;
                            return Ok(());
                        }
                        socket.send(Message::Text(json!({"data":input}).to_string().into()))?;
                    }
                    if !this.alive.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    match socket.read() {
                        Ok(Message::Text(raw)) => {
                            let data: Value = serde_json::from_str(&raw)?;
                            if let Some(text) = data["data"].as_str() {
                                let _ = this.events.send(Event::Terminal(id, text.into()));
                            }
                            if let Some(error) = data["error"].as_str() {
                                bail!("{error}");
                            }
                            if data.get("exitCode").is_some() {
                                return Ok(());
                            }
                        }
                        Ok(Message::Close(_)) => return Ok(()),
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(e) => return Err(e.into()),
                    }
                }
            })();
            let _ = this.events.send(Event::TerminalClosed(
                id,
                result
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "Process exited".into()),
            ));
        });
        sender
    }
    pub fn shutdown(&self) {
        self.alive.store(false, Ordering::Relaxed);
        let _ = self.process.lock().unwrap().kill();
    }
}
