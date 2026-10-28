import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

declare global { interface Window { syncpi?: { pickFolder(): Promise<string | undefined>; onAction(fn: (action: string) => void): void } } }
type Session = { id: string; name: string; title?: string; dir: string; url: string; compute: string; status?: string; step?: string; error?: string; connection?: string; pinned?: boolean; bookmarked?: boolean; archived?: boolean; tags?: string[]; createdAt: number; lastOpened?: number; sync?: { pushed: number; pulled: number; conflicts: string[]; error: string } };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
let sessions: Session[] = [];
let active: Session | undefined;
let selectedProject = '';
let filter = 'all';
let archived = false;
let panel = '';
let generation = 0;
let paneGeneration = 0;
let theme = localStorage.getItem('syncpi-theme') || 'light';
let searchIndex = 0;
let editKind = 'title';
let previewURL = '';
const iframe = $<HTMLIFrameElement>('session');
async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const res = await fetch(path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`); return data;
}
const sessionAPI = (verb: string) => `/api/sessions/${active!.id}/${verb}`;
function toast(text: string) { $('toast').textContent = text; $('toast').hidden = false; window.setTimeout(() => { $('toast').hidden = true; }, 5000); }
function modal(id: string) { $<HTMLDialogElement>(id).showModal(); }
function frameAction(action: string, data?: unknown) { iframe.contentWindow?.postMessage({ type: 'syncpi-action', action, data }, location.origin); }
function applyTheme() { document.documentElement.dataset.theme = theme; localStorage.setItem('syncpi-theme', theme); frameAction('theme', theme); for (const t of terminals.values()) t.term.options.theme = terminalTheme(); }
function terminalTheme() { return theme === 'dark' ? { background: '#202020', foreground: '#e4e4e4' } : { background: '#fafafa', foreground: '#323232' }; }
document.documentElement.dataset.theme = theme;
async function refresh() {
  const data = await api('/api/sessions'); sessions = data.sessions;
  $('identity-name').textContent = data.identity.name;
  $('identity-avatar').textContent = data.identity.name[0]?.toUpperCase() || 'S';
  if (!$<HTMLInputElement>('join-name').value) $<HTMLInputElement>('join-name').value = data.identity.name;
  if (!$<HTMLInputElement>('model').value && data.defaults.model) $<HTMLInputElement>('model').placeholder = data.defaults.model;
  if (active) {
    active = sessions.find(s => s.id === active!.id) || active;
    $('title').textContent = active.title || active.name;
    $('project-status').textContent = `${active.name} / ${active.dir}`;
    $('compute-status').textContent = active.compute === 'local' ? '◉ This Mac' : '◉ exe.dev';
    const sync = active.sync;
    $('sync-status').textContent = sync ? sync.error ? `Sync: ${sync.error}` : sync.conflicts.length ? `${sync.conflicts.length} conflicts · both copies saved` : `↑${sync.pushed} ↓${sync.pulled} Synced` : '';
    $('sync-status').title = sync?.conflicts.join('\n') || '';
    $('activity').textContent = active.status === 'provisioning' ? 'Preparing…' : active.connection === 'closed' ? 'Reconnecting…' : '';
    if (active.status === 'provisioning') $('loading-message').textContent = active.step || 'Starting…';
  }
  if (data.login && $<HTMLDialogElement>('join-dialog').open) {
    const box = $('join-progress'); box.replaceChildren();
    box.append(document.createTextNode(`Compare code ${data.login.check}, then approve sign-in in your browser. `));
    const link = document.createElement('a'); link.href = data.login.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open sign-in'; box.append(link);
  }
  renderSidebar();
}
function renderSidebar() {
  const dirs = [...new Set(sessions.map(s => s.dir))];
  $('projects').innerHTML = dirs.map(dir => {
    const project = sessions.find(s => s.dir === dir)!;
    return `<button class="project-row ${dir === selectedProject ? 'current' : ''}" data-project="${esc(dir)}" title="${esc(dir)}"><span>▱</span><span>${esc(project.name)}</span><span class="project-count">${sessions.filter(s => s.dir === dir && !s.archived).length}</span></button>`;
  }).join('') || '<div class="sidebar-empty">Open a folder to get started.</div>';
  const shown = sessions.filter(s => !!s.archived === archived && (!selectedProject || s.dir === selectedProject) && (filter !== 'bookmarked' || s.bookmarked)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (filter === 'recent' ? (b.lastOpened || b.createdAt) - (a.lastOpened || a.createdAt) : b.createdAt - a.createdAt));
  $('threads').innerHTML = `<button class="new-thread" data-action="new"><span>＋</span> New thread <kbd>⌘N</kbd></button>${archived ? '<div class="archive-caption">Archived threads</div>' : ''}${shown.map(s => `<button class="thread-row ${s.id === active?.id ? 'current' : ''}" data-session="${s.id}" title="${esc(s.title || s.name)}"><span class="thread-dot ${s.status === 'provisioning' ? 'working' : s.status === 'failed' ? 'failed' : ''}">${s.pinned ? '⌁' : s.bookmarked ? '◇' : '·'}</span><span class="thread-label">${esc(s.title || s.name)}${s.tags?.length ? `<small>${s.tags.map(esc).join(' · ')}</small>` : ''}</span><span class="thread-more" data-menu="${s.id}" aria-label="Thread actions">···</span></button>`).join('')}${!shown.length ? '<div class="sidebar-empty">No threads here yet.</div>' : ''}`;
}
async function openSession(id: string) {
  const next = sessions.find(s => s.id === id); if (!next) return;
  if (active?.id === id && !iframe.hidden) return;
  saveDrafts(); active = next; const mine = ++generation; panel = ''; $('inspector').hidden = true; $('splitter').hidden = true;
  iframe.hidden = true; iframe.removeAttribute('src'); $('welcome').hidden = true; $('loading').hidden = false; $('loading-title').textContent = 'Preparing your workspace'; $('loading-message').textContent = next.step || 'Connecting to the session…'; $('retry').hidden = true;
  $('terminal-panel').hidden = true; renderSidebar();
  try {
    await api(`/api/sessions/${id}/open`, {});
    if (generation !== mine) return;
    iframe.src = `/session/${id}/#token=desktop`;
    iframe.onload = () => { if (generation !== mine) return; applyTheme(); };
    iframe.hidden = false; $('loading').hidden = true;
    localStorage.setItem('syncpi-active', id); await refresh();
  } catch (e) {
    if (generation !== mine) return;
    $('loading-title').textContent = 'Could not open this thread'; $('loading-message').textContent = (e as Error).message; $('retry').hidden = false;
  }
}
function saveDrafts() { /* The shared renderer saves drafts per session before it unloads. */ }
async function createDialog(dir = selectedProject || active?.dir || '') { $<HTMLInputElement>('project-dir').value = dir; $<HTMLInputElement>('thread-title').value = ''; $('create-error').textContent = ''; modal('create-dialog'); if (!dir) $<HTMLInputElement>('project-dir').focus(); else $<HTMLInputElement>('thread-title').focus(); }
async function decorate(patch: Record<string, unknown>) { if (!active) return; await api(sessionAPI('decorate'), patch); await refresh(); }
async function action(name: string) {
  switch (name) {
    case 'project': { const dir = await window.syncpi?.pickFolder(); return createDialog(dir || ''); }
    case 'new': return createDialog();
    case 'join': modal('join-dialog'); return;
    case 'search': modal('search-dialog'); $<HTMLInputElement>('search-input').value = ''; renderSearch(); $<HTMLInputElement>('search-input').focus(); return;
    case 'theme': theme = theme === 'light' ? 'dark' : 'light'; applyTheme(); return;
    case 'sidebar': document.body.classList.toggle('sidebar-hidden'); return;
    case 'archive-view': archived = !archived; renderSidebar(); return;
  }
  if (!active) return toast('Open a thread first.');
  switch (name) {
    case 'more': showMenu(); return;
    case 'files': case 'changes': case 'preview': return togglePane(name);
    case 'terminal': return toggleTerminal();
    case 'share': case 'setup': case 'people': frameAction(name); return;
    case 'pin': return decorate({ pinned: !active.pinned });
    case 'bookmark': return decorate({ bookmarked: !active.bookmarked });
    case 'archive': return decorate({ archived: !active.archived });
    case 'rename': case 'tags': editKind = name === 'tags' ? 'tags' : 'title'; $('edit-heading').textContent = name === 'tags' ? 'Thread tags (comma separated)' : 'Rename thread'; $<HTMLInputElement>('edit-value').value = name === 'tags' ? active.tags?.join(', ') || '' : active.title || ''; modal('edit-dialog'); $<HTMLInputElement>('edit-value').focus(); return;
    case 'sync': await api(sessionAPI('sync'), {}); toast('Project sync completed.'); return;
    case 'reveal': case 'zed': await api(sessionAPI('reveal'), { editor: name === 'zed' }); return;
    case 'update': toast('Updating the session server…'); await api(sessionAPI('update'), {}); toast('Server updated.'); return;
    case 'retry': await api(sessionAPI('retry'), {}); return openSession(active.id);
    case 'compact': case 'new-context': case 'branches': case 'model': frameAction(name); return;
    case 'split': return togglePane('split');
    case 'regenerate-title': toast('Generating a title…'); await api(sessionAPI('title'), {}); await refresh(); toast('Thread title updated.'); return;
  }
}
function showMenu(id = active?.id) {
  if (!id) return;
  const s = sessions.find(s => s.id === id)!;
  if (active?.id !== id) { void openSession(id); }
  const groups = [
    [['rename', 'Rename thread'], ['regenerate-title', 'Regenerate title'], ['tags', 'Edit tags…']],
    [['pin', s.pinned ? 'Unpin thread' : 'Pin thread'], ['bookmark', s.bookmarked ? 'Remove bookmark' : 'Bookmark thread'], ['archive', s.archived ? 'Reopen thread' : 'Archive thread']],
    [['branches', 'Thread branches'], ['compact', 'Summarize context'], ['new-context', 'Start new context'], ['model', 'Model and thinking…']],
    [['split', 'Split thread view'], ['preview', 'Open preview'], ['sync', 'Sync project now'], ['reveal', 'Show project in Finder'], ['zed', 'Open in Zed'], ['update', 'Update session server']],
  ];
  $('thread-menu').innerHTML = groups.map(g => g.map(([a, title]) => `<button data-action="${a}">${title}</button>`).join('')).join('<hr>');
  $('thread-menu').hidden = false;
}
function renderSearch() {
  const q = $<HTMLInputElement>('search-input').value.toLowerCase();
  const shown = sessions.filter(s => `${s.title} ${s.name} ${s.dir} ${s.tags?.join(' ')}`.toLowerCase().includes(q));
  searchIndex = Math.max(0, Math.min(searchIndex, shown.length - 1));
  $('search-results').innerHTML = shown.map((s, n) => `<button data-session="${s.id}" class="search-result ${n === searchIndex ? 'current' : ''}"><span>${esc(s.title || s.name)}</span><small>${esc(s.name)}${s.archived ? ' · archived' : ''}</small></button>`).join('') || '<p class="subtle">No matching threads.</p>';
}
async function togglePane(name: string) {
  if (panel === name) { panel = ''; $('inspector').hidden = true; $('splitter').hidden = true; return; }
  panel = name; $('inspector').hidden = false; $('splitter').hidden = false;
  await renderPane();
}
async function renderPane() {
  if (!active || !panel) return;
  const ticket = ++paneGeneration; const id = active.id; const kind = panel;
  $('inspector-title').textContent = ({ files: 'Project files', changes: 'Review changes', preview: 'Preview', split: 'Thread · split view' } as Record<string, string>)[panel] || panel;
  const box = $('pane-content'); box.innerHTML = '<div class="pane-loading">Loading…</div>';
  try {
    if (kind === 'files') {
      const data = await api(sessionAPI('files')); if (ticket !== paneGeneration || active.id !== id) return;
      box.innerHTML = '<div class="file-toolbar"><input id="file-search" placeholder="Find a file…" aria-label="Find a file"><button id="new-file">＋</button></div><div id="file-list"></div><div id="editor" hidden></div>';
      const render = () => { const q = $<HTMLInputElement>('file-search').value.toLowerCase(); $('file-list').innerHTML = data.files.filter((f: string) => f.toLowerCase().includes(q)).map((f: string) => `<button class="file-row" data-file="${esc(f)}"><span>▤</span><span>${esc(f)}</span></button>`).join('') || '<p class="subtle pane-note">No files found.</p>'; };
      render(); $('file-search').oninput = render;
      $('new-file').onclick = () => { $('file-list').hidden = true; $('editor').hidden = false; $('editor').innerHTML = '<form id="new-file-form" class="new-file-form"><label>New file path<input id="new-file-path" required placeholder="src/example.ts"></label><button class="primary">Create file</button></form>'; $('new-file-form').onsubmit = e => { e.preventDefault(); void editFile($<HTMLInputElement>('new-file-path').value, true).catch(e => toast(e.message)); }; };
      $('file-list').onclick = e => { const path = (e.target as HTMLElement).closest<HTMLElement>('[data-file]')?.dataset.file; if (path) void editFile(path).catch(e => toast(e.message)); };
    } else if (kind === 'changes') {
      const data = await api(sessionAPI('git')); if (ticket !== paneGeneration || active.id !== id) return;
      box.innerHTML = `<div class="git-head">⑂ ${esc(data.branch || 'Detached HEAD')} <span>${data.files.length} changed</span></div><div id="changed-files">${data.files.map((f: { status: string; path: string }) => `<div class="changed-row"><code>${esc(f.status)}</code><button data-file="${esc(f.path)}">${esc(f.path)}</button><button data-stage="${esc(f.path)}" title="Stage file">＋</button></div>`).join('')}</div>${!data.files.length ? '<div class="clean-state">✓<h3>Working tree is clean</h3><p>Changes appear here as you and the agent work.</p></div>' : ''}<form id="commit-form"><input id="commit-message" required placeholder="Commit message" aria-label="Commit message"><button class="primary">Commit staged</button></form><div class="diff-label">Unstaged changes</div><pre class="diff">${highlightDiff(data.diff || 'No tracked changes. Open untracked files above to review them.')}</pre><div class="diff-label">Staged changes</div><pre class="diff">${highlightDiff(data.staged || 'No staged changes.')}</pre>`;
      $('changed-files').onclick = e => { const target = (e.target as HTMLElement).closest<HTMLElement>('button'); if (target?.dataset.stage) void api(sessionAPI('git'), { action: 'stage', path: target.dataset.stage }).then(renderPane).catch(e => toast(e.message)); if (target?.dataset.file) { const path = target.dataset.file; panel = 'files'; void renderPane().then(() => editFile(path)).catch(e => toast(e.message)); } };
      $('commit-form').onsubmit = e => { e.preventDefault(); void api(sessionAPI('git'), { action: 'commit', message: $<HTMLInputElement>('commit-message').value }).then(() => { toast('Commit created in this checkout.'); return renderPane(); }).catch(e => toast(e.message)); };
    } else if (kind === 'preview') {
      box.innerHTML = '<form id="preview-form"><label>Local development server<input id="preview-url" type="url" placeholder="http://localhost:3000" required></label><button class="primary">Open preview</button></form><p class="pane-note subtle">Open your development server in a separate browser tab. Use the terminal to start it.</p>';
      $<HTMLInputElement>('preview-url').value = previewURL;
      $('preview-form').onsubmit = e => { e.preventDefault(); const u = new URL($<HTMLInputElement>('preview-url').value); if (!['http:', 'https:'].includes(u.protocol)) return toast('Use an HTTP or HTTPS address.'); previewURL = u.href; window.open(u.href, '_blank', 'noopener,noreferrer'); };
    } else if (kind === 'split') { box.innerHTML = `<iframe title="Split thread view" class="split-frame" src="/session/${active.id}/#token=desktop"></iframe>`; }
  } catch (e) { if (ticket === paneGeneration) { box.replaceChildren(); const p = document.createElement('p'); p.className = 'pane-note error'; p.textContent = (e as Error).message; box.append(p); } }
}
function highlightDiff(text: string) { return text.split('\n').map(line => `<span class="${line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''}">${esc(line)}</span>`).join('\n'); }
async function editFile(path: string, isNew = false) {
  const id = active!.id;
  const result = isNew ? { text: '', hash: 'none' } : await api(`${sessionAPI('file')}?path=${encodeURIComponent(path)}`);
  if (active?.id !== id || panel !== 'files') return;
  $('file-list').hidden = true; const editor = $('editor'); editor.hidden = false;
  const draftKey = `syncpi-file-draft:${id}:${path}`;
  let draft: { text: string; base: string } | undefined;
  try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') || undefined; } catch {}
  editor.innerHTML = `<header class="editor-head"><button id="back-files">‹ Files</button><strong title="${esc(path)}">${esc(path)}</strong><button id="reload-file" title="Discard draft and reload">Reload</button><button id="mention-file" title="Mention this file to the agent">@</button><button id="save-file" class="primary">Save</button></header><textarea id="file-text" spellcheck="false" aria-label="Edit ${esc(path)}"></textarea><div id="file-feedback" role="status"></div>`;
  const text = $<HTMLTextAreaElement>('file-text'); text.value = draft?.text ?? result.text; let base = draft?.base ?? result.hash; let dirty = !!draft; if (draft) $('file-feedback').textContent = 'Restored unsaved draft';
  text.oninput = () => { dirty = true; localStorage.setItem(draftKey, JSON.stringify({ text: text.value, base })); $('file-feedback').textContent = 'Unsaved draft saved locally'; };
  const save = async () => { const res = await fetch(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}&base=${base}`, { method: 'PUT', body: text.value }); const data = await res.json(); if (!res.ok) throw new Error(data.error); base = data.hash; dirty = false; localStorage.removeItem(draftKey); $('file-feedback').textContent = 'Saved · changes sync to collaborators'; };
  $('reload-file').onclick = () => { localStorage.removeItem(draftKey); void editFile(path).catch(e => toast(e.message)); };
  $('save-file').onclick = () => void save().catch(e => { $('file-feedback').textContent = e.message; });
  text.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save().catch(e => toast(e.message)); } if (e.key === 'Tab') { e.preventDefault(); text.setRangeText('  ', text.selectionStart, text.selectionEnd, 'end'); text.dispatchEvent(new Event('input'));  } };
  $('back-files').onclick = () => { if (dirty) { toast('Save your changes before leaving this file.'); return; } editor.hidden = true; $('file-list').hidden = false; };
  $('mention-file').onclick = () => frameAction('mention', path);
}

type TerminalTab = { id: number; session: string; term: Terminal; fit: FitAddon; socket: WebSocket; el: HTMLElement; exited: boolean };
const terminals = new Map<number, TerminalTab>();
let terminalCounter = 0;
let currentTerminal = 0;
function terminalTabs() {
  const visible = [...terminals.values()].filter(t => t.session === active?.id);
  $('terminal-tabs').innerHTML = visible.map(t => `<button data-terminal="${t.id}" class="${currentTerminal === t.id ? 'current' : ''}">zsh ${t.id}${t.exited ? ' · exited' : ''}<span data-close-terminal="${t.id}">×</span></button>`).join('');
  for (const t of terminals.values()) t.el.hidden = t.id !== currentTerminal;
}
async function toggleTerminal() {
  const box = $('terminal-panel'); box.hidden = !box.hidden;
  if (box.hidden) return;
  const existing = [...terminals.values()].find(t => t.session === active?.id && !t.exited);
  if (existing) { currentTerminal = existing.id; terminalTabs(); existing.fit.fit(); existing.term.focus(); } else newTerminal();
}
function newTerminal() {
  if (!active) return;
  $('terminal-panel').hidden = false; $('terminal-dir').textContent = active.dir;
  const el = document.createElement('div'); el.className = 'terminal-instance'; $('terminal-view').append(el);
  const term = new Terminal({ theme: terminalTheme(), fontFamily: '"SF Mono", Menlo, monospace', fontSize: 12, cursorBlink: true, scrollback: 5000 });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
  const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/terminal/${active.id}`);
  const tab: TerminalTab = { id: ++terminalCounter, session: active.id, term, fit, socket, el, exited: false };
  terminals.set(tab.id, tab); currentTerminal = tab.id; terminalTabs(); fit.fit(); term.focus();
  socket.onopen = () => socket.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
  term.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ data })); });
  term.onResize(({ cols, rows }) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cols, rows })); });
  socket.onmessage = e => { const m = JSON.parse(e.data); if (m.data) term.write(m.data); if (m.error) term.writeln(m.error); if (m.exitCode !== undefined) term.writeln(`\r\nProcess exited (${m.exitCode})`); };
  socket.onclose = () => { tab.exited = true; term.writeln('\r\n[Terminal disconnected]'); terminalTabs(); };
}
$('terminal-new').onclick = newTerminal;
$('terminal-close').onclick = () => { $('terminal-panel').hidden = true; };
$('terminal-tabs').onclick = e => { const close = (e.target as HTMLElement).closest<HTMLElement>('[data-close-terminal]')?.dataset.closeTerminal; if (close) { const t = terminals.get(Number(close)); t?.socket.close(); t?.term.dispose(); t?.el.remove(); terminals.delete(Number(close)); currentTerminal = [...terminals.values()].find(t => t.session === active?.id)?.id || 0; terminalTabs(); return; } const id = (e.target as HTMLElement).closest<HTMLElement>('[data-terminal]')?.dataset.terminal; if (id) { currentTerminal = Number(id); terminalTabs(); terminals.get(currentTerminal)?.fit.fit(); terminals.get(currentTerminal)?.term.focus(); } };
new ResizeObserver(() => { for (const t of terminals.values()) if (t.id === currentTerminal && !$('terminal-panel').hidden) t.fit.fit(); }).observe($('terminal-view'));
$('splitter').onpointerdown = e => { const target = e.currentTarget as HTMLElement; target.setPointerCapture(e.pointerId); target.onpointermove = e => { document.documentElement.style.setProperty('--inspector-width', `${Math.max(300, Math.min(innerWidth * .7, innerWidth - e.clientX))}px`); }; target.onpointerup = () => { target.onpointermove = null; }; };
$('splitter').onkeydown = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const width = $('inspector').getBoundingClientRect().width; document.documentElement.style.setProperty('--inspector-width', `${Math.max(300, width + (e.key === 'ArrowLeft' ? 24 : -24))}px`); } };
$('close-pane').onclick = () => { panel = ''; paneGeneration++; $('inspector').hidden = true; $('splitter').hidden = true; };
$('refresh-pane').onclick = () => void renderPane();
$('browse').onclick = async () => { const dir = await window.syncpi?.pickFolder(); if (dir) $<HTMLInputElement>('project-dir').value = dir; else if (!window.syncpi) toast('Enter the project folder path above.'); };
$('create-form').onsubmit = e => {
  e.preventDefault(); const button = (e.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>('[type=submit]')!; button.disabled = true;
  void api('/api/sessions', { dir: $<HTMLInputElement>('project-dir').value, title: $<HTMLInputElement>('thread-title').value, compute: $<HTMLSelectElement>('compute').value, thinkingLevel: $<HTMLSelectElement>('thinking').value, model: $<HTMLInputElement>('model').value, setupModel: $<HTMLInputElement>('setup-model').value, vm: $<HTMLInputElement>('vm').value }).then(async data => { $<HTMLDialogElement>('create-dialog').close(); await refresh(); void openSession(data.id); }).catch(e => { $('create-error').textContent = e.message; }).finally(() => { button.disabled = false; });
};
$('join-form').onsubmit = e => { e.preventDefault(); const button = (e.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>('[type=submit]')!; button.disabled = true; $('join-progress').textContent = 'Joining and downloading the project…'; void api('/api/join', { url: $<HTMLInputElement>('join-url').value, name: $<HTMLInputElement>('join-name').value }).then(async data => { $<HTMLDialogElement>('join-dialog').close(); await refresh(); void openSession(data.id); }).catch(e => { $('join-error').textContent = e.message; }).finally(() => { button.disabled = false; }); };
$('edit-form').onsubmit = e => { e.preventDefault(); const value = $<HTMLInputElement>('edit-value').value; void decorate(editKind === 'tags' ? { tags: value.split(',').map(s => s.trim()).filter(Boolean) } : { title: value }).then(() => $<HTMLDialogElement>('edit-dialog').close()).catch(e => toast(e.message)); };
$('search-input').oninput = () => { searchIndex = 0; renderSearch(); };
$('search-input').onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchIndex += e.key === 'ArrowDown' ? 1 : -1; renderSearch(); } if (e.key === 'Enter') { const id = $('search-results').querySelector<HTMLElement>('.current')?.dataset.session; if (id) { $<HTMLDialogElement>('search-dialog').close(); void openSession(id); } } };
document.addEventListener('click', e => {
  const el = e.target as HTMLElement;
  const close = el.closest<HTMLElement>('[data-close]')?.dataset.close; if (close) $<HTMLDialogElement>(close).close();
  const menu = el.closest<HTMLElement>('[data-menu]')?.dataset.menu; if (menu) { showMenu(menu); return; }
  const session = el.closest<HTMLElement>('[data-session]')?.dataset.session; if (session) { if ($<HTMLDialogElement>('search-dialog').open) $<HTMLDialogElement>('search-dialog').close(); void openSession(session); }
  const project = el.closest<HTMLElement>('[data-project]')?.dataset.project; if (project) { selectedProject = selectedProject === project ? '' : project; renderSidebar(); }
  const f = el.closest<HTMLElement>('[data-filter]')?.dataset.filter; if (f) { filter = f; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', (b as HTMLElement).dataset.filter === f)); renderSidebar(); }
  const a = el.closest<HTMLElement>('[data-action]')?.dataset.action; if (a) void action(a).catch(e => toast(e.message));
  if (!$('thread-menu').contains(el) && a !== 'more' || $('thread-menu').contains(el) && a) $('thread-menu').hidden = true;
});
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && ['k', 'p', 'n', 'o'].includes(e.key.toLowerCase())) { e.preventDefault(); void action(({ k: 'search', p: 'files', n: 'new', o: 'project' } as Record<string, string>)[e.key.toLowerCase()]!).catch(e => toast(e.message)); }
  if (e.key === 'Escape') $('thread-menu').hidden = true;
});
window.syncpi?.onAction(name => void action(name).catch(e => toast(e.message)));
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== iframe.contentWindow || !active) return;
  if (e.data?.type === 'syncpi-title' && typeof e.data.title === 'string' && (e.data.force || !active.title || active.title === 'New thread')) void decorate({ title: e.data.title.slice(0, 160) });
  if (e.data?.type === 'syncpi-activity') $('activity').textContent = e.data.busy ? 'Working…' : '';
  if (e.data?.type === 'syncpi-shortcut') { if (e.data.action === 'terminal' && typeof e.data.command === 'string' && e.data.command) { if ($('terminal-panel').hidden) void toggleTerminal(); const tab = terminals.get(currentTerminal); const send = () => tab?.socket.send(JSON.stringify({ data: e.data.command + '\r' })); if (tab?.socket.readyState === WebSocket.OPEN) send(); else tab?.socket.addEventListener('open', send, { once: true }); } else void action(e.data.action).catch(e => toast(e.message)); }
});
await refresh();
const previous = localStorage.getItem('syncpi-active');
if (previous && sessions.some(s => s.id === previous)) void openSession(previous);
setInterval(() => void refresh().catch(() => {}), 2000);
