const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let info = null;
let selected = null;
let conversations = [];
let view = null;
let viewSource = null;

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content || []).filter((part) => part.type === "text").map((part) => part.text).join("");

function selectConversation(id) {
  if (selected === id) return;
  selected = id;
  location.hash = `c=${id}`;
  view = null;
  if (viewSource) viewSource.close();
  viewSource = new EventSource(`/api/conversations/${id}/events`);
  viewSource.addEventListener("view", (event) => {
    view = JSON.parse(event.data);
    renderView();
  });
  renderConversations();
}

function workerName(id) {
  return conversations.find((item) => item.id === id)?.label;
}

function renderConversations() {
  const list = $("conversations");
  list.replaceChildren();
  for (const item of conversations) {
    const li = el("li", item.id === selected ? "active" : "");
    li.append(el("span", `dot${item.busy ? " busy" : ""}`), document.createTextNode(item.label));
    if (item.model) li.append(el("span", "sub", item.model));
    li.onclick = () => selectConversation(item.id);
    list.append(li);
  }
}

function callBlock(call) {
  const box = el("div", "call");
  const args = call.arguments || {};
  box.textContent = `${call.name}(${JSON.stringify(args, null, 1)})`;
  return box;
}

function linkToWorker(container, name, conversationId) {
  const id = conversationId ?? conversations.find((item) => item.label === name)?.id;
  if (id === undefined) return;
  const link = el("a", "", ` open ${name} →`);
  link.onclick = () => selectConversation(id);
  container.append(link);
}

function renderEntry(entry, showSystem) {
  const messages = entry.model || [];
  const kind = entry.kind;
  if (kind === "pi.system" && !showSystem) return null;
  const li = el("li", "entry");
  const meta = el("div", "meta");
  meta.append(el("span", "", `#${entry.id}`), el("span", "", kind));
  li.append(meta);
  if (kind.startsWith("app.voice")) li.classList.add("voice");

  if (messages.length === 0) {
    li.classList.add("system");
    li.append(el("pre", "", JSON.stringify(entry.data ?? {}, null, 1)));
    return li;
  }
  for (const message of messages) {
    if (message.role === "system") {
      li.classList.add("system");
      li.append(el("pre", "", textOf(message.content) || "(prompt/tool change)"));
    } else if (message.role === "user") {
      const text = textOf(message.content);
      const report = /^\[worker (\S+) (finished|failed)\]/.exec(text);
      li.classList.add(report ? "report" : "user");
      meta.append(el("span", "", report ? `report from ${report[1]}` : "user"));
      li.append(el("div", "body", text));
      if (report) linkToWorker(li, report[1]);
    } else if (message.role === "assistant") {
      meta.append(el("span", "", `${message.provider}/${message.model}`), el("span", "", message.stopReason));
      for (const part of message.content || []) {
        if (part.type === "text" && part.text) li.append(el("div", "body", part.text));
        if (part.type === "thinking" && part.thinking) {
          const details = el("details");
          details.append(el("summary", "small muted", "thinking"), el("pre", "", part.thinking));
          li.append(details);
        }
        if (part.type === "toolCall") li.append(callBlock(part));
      }
      if (message.errorMessage) li.append(el("div", "error", message.errorMessage));
    } else if (message.role === "toolResult") {
      li.classList.add("tool");
      meta.append(el("span", "", `${message.toolName} result`), el("span", "", message.isError ? "error" : "ok"));
      const text = textOf(message.content);
      const details = el("details");
      details.open = text.length < 400;
      details.append(el("summary", "small muted", text.split("\n")[0].slice(0, 160)), el("pre", "", text));
      li.append(details);
      const ref = message.details;
      if (ref && ref.conversationId !== undefined) linkToWorker(li, ref.name, ref.conversationId);
      else if (message.toolName === "delegate") {
        const named = /worker (\S+?)[ .]|to (\S+?)\./.exec(text);
        if (named) linkToWorker(li, named[1] || named[2]);
      }
    }
  }
  return li;
}

function renderLive(live) {
  const box = $("live");
  box.replaceChildren();
  if (!live) return;
  const generation = live.generation;
  if (generation?.message) {
    box.append(el("div", "meta", `generating (attempt ${generation.attempt})`));
    for (const part of generation.message.content || []) {
      if (part.type === "text") box.append(el("div", "body", part.text));
      if (part.type === "toolCall") box.append(callBlock(part));
    }
  }
  if (generation?.retry) box.append(el("div", "error", `retrying: ${generation.retry.error}`));
  for (const slot of live.tools || []) {
    if (slot.status === "done") continue;
    const tool = el("div", "call", `${slot.name} · ${slot.status}`);
    if (slot.output) tool.append(el("pre", "", slot.output.slice(-4000)));
    box.append(tool);
  }
  if (!box.childElementCount && live.run) box.append(el("div", "meta", "working…"));
}

function renderView() {
  if (!view) return;
  const item = conversations.find((c) => c.id === selected);
  $("title").textContent = item ? item.label : `conversation ${selected}`;
  const agent = view.docs["pi.agent"] || {};
  const agentBox = $("agent");
  agentBox.replaceChildren();
  const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "host default";
  agentBox.append(el("div", "", `model ${model} · thinking ${agent.thinkingLevel ?? "default"} · cwd ${agent.cwd ?? "—"}`));
  if (item?.task) {
    const task = el("details");
    task.append(el("summary", "", "task brief"), el("pre", "", item.task));
    agentBox.append(task);
  }
  if (agent.instructions) {
    const instructions = el("details");
    instructions.append(el("summary", "", "instructions"), el("pre", "", agent.instructions));
    agentBox.append(instructions);
  }
  const showSystem = $("show-system").checked;
  const list = $("transcript");
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  list.replaceChildren(...view.entries.map((entry) => renderEntry(entry, showSystem)).filter(Boolean));
  renderLive(view.docs["pi.live"]);
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

function renderTasks(graph) {
  const list = $("tasks");
  list.replaceChildren();
  const nodes = Object.values(graph.tasks || {});
  if (nodes.length === 0) list.append(el("li", "muted", "none"));
  for (const node of nodes) {
    const owner = node.owner !== undefined ? `↳${node.owner}` : `c${node.conversationId}`;
    const flags = `${node.background ? " bg" : ""}${node.abortRequested ? " abort" : ""}`;
    list.append(el("li", "", `${node.id} ${node.kind.replace(/^pi\.|^app\./, "")} ${node.state.status} ${owner}${flags}`));
  }
}

async function refreshConversations() {
  try {
    conversations = await (await fetch("/api/conversations")).json();
    if (selected === null) {
      const fromHash = Number(new URLSearchParams(location.hash.slice(1)).get("c"));
      selectConversation(conversations.some((c) => c.id === fromHash) ? fromHash : conversations[0].id);
    }
    renderConversations();
  } catch {}
}

async function refreshUsage() {
  try {
    const usage = await (await fetch("/api/usage")).json();
    const box = $("usage");
    box.replaceChildren();
    for (const [model, value] of Object.entries(usage.models || {})) {
      box.append(el("div", "", `${model}: ${value.totalTokens} tok · $${(value.cost?.total ?? 0).toFixed(4)}`));
    }
    if (!box.childElementCount) box.textContent = "no model calls yet";
  } catch {}
}

const voice = { pc: null, stream: null };

async function startVoice() {
  const button = $("mic");
  button.disabled = true;
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection();
    voice.pc = pc;
    pc.ontrack = (event) => ($("remote").srcObject = event.streams[0]);
    for (const track of voice.stream.getTracks()) pc.addTrack(track, voice.stream);
    const channel = pc.createDataChannel("oai-events");
    channel.onmessage = (event) => onRealtimeEvent(JSON.parse(event.data));
    await pc.setLocalDescription(await pc.createOffer());
    const response = await fetch("/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!response.ok) throw new Error((await response.json()).error);
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
    button.textContent = "Hang up";
    button.classList.add("live");
    $("captions").hidden = false;
  } catch (error) {
    stopVoice(false);
    $("voice-status").textContent = `error: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function stopVoice(notify = true) {
  if (notify) fetch("/api/voice/hangup", { method: "POST" }).catch(() => {});
  voice.pc?.close();
  voice.stream?.getTracks().forEach((track) => track.stop());
  voice.pc = null;
  voice.stream = null;
  $("mic").textContent = "Start voice";
  $("mic").classList.remove("live");
}

const captions = { user: "", assistant: "" };
function onRealtimeEvent(event) {
  if (event.type === "conversation.item.input_audio_transcription.delta") captions.user += event.delta;
  if (event.type === "conversation.item.input_audio_transcription.completed") captions.user = event.transcript;
  if (event.type === "input_audio_buffer.speech_started") captions.user = "";
  if (event.type === "response.created") captions.assistant = "";
  if (event.type === "response.output_audio_transcript.delta") captions.assistant += event.delta;
  const box = $("captions");
  box.replaceChildren(
    el("div", "", captions.user ? `you: ${captions.user}` : ""),
    el("div", "", captions.assistant ? `frontdesk: ${captions.assistant}` : ""),
  );
}

async function boot() {
  info = await (await fetch("/api/info")).json();
  $("mode").textContent = info.frontend === "none" ? "inspect only" : `${info.frontend} frontend`;
  $("models").textContent =
    `${info.frontend === "voice" ? info.models.voice : info.models.text} → workers ${info.models.opus}, ${info.models.sol}`;
  if (info.frontend === "voice") {
    $("voice").hidden = false;
    $("mic").onclick = () => (voice.pc ? stopVoice() : startVoice());
    const events = new EventSource("/api/voice/events");
    events.addEventListener("voice", (message) => {
      const event = JSON.parse(message.data);
      if (event.type === "status") $("voice-status").textContent = event.state;
      if (event.type === "error") $("voice-status").textContent = `error: ${event.message}`;
      if (event.type === "status" && event.state === "idle" && voice.pc) stopVoice(false);
    });
  }
  $("show-system").onchange = renderView;
  const tasks = new EventSource("/api/tasks/events");
  tasks.addEventListener("tasks", (event) => renderTasks(JSON.parse(event.data)));
  await refreshConversations();
  refreshUsage();
  setInterval(refreshConversations, 2000);
  setInterval(refreshUsage, 5000);
}

boot();
