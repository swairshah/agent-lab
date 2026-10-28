// Loopback-only app service. A per-launch cookie gates all local file and process access.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { DesktopRuntime } from './runtime.ts';
import { home, identity, loadSession } from '../cli/store.ts';
import { piDefaults } from '../cli/provision.ts';
import { hashBytes, listFiles, safePath, MAX_FILE_BYTES } from '../shared/files.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { mentionsOf } from '../shared/mentions.ts';

const run = promisify(execFile);
const appDir = dirname(fileURLToPath(import.meta.url));
// A fixed port by default, so the pages' origin, and with it what they keep in storage (theme, drafts, what you've
// read), is the same every launch; another free port when it's taken.
const STABLE_PORT = 47390;
const { values: args } = parseArgs({ options: { port: { type: 'string', default: String(STABLE_PORT) }, faux: { type: 'boolean', default: false } } });
const secret = randomBytes(32).toString('hex');
const runtime = new DesktopRuntime(join(appDir, 'pi-context.mjs'));
let origin = '';
let login: { url: string; check: string } | undefined;
runtime.onLogin = (url, check) => { login = { url, check }; };
const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_FILE_BYTES) throw new Error('Request too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function input(req: IncomingMessage) { return JSON.parse((await body(req)).toString() || '{}'); }
function authorized(req: IncomingMessage) { if (req.headers.authorization === `Bearer ${secret}`) return true; return (req.headers.cookie || '').split(';').some(c => c.trim() === `syncpi_app=${secret}`); }
function sameOrigin(req: IncomingMessage) { return req.headers.origin === undefined || req.headers.origin === origin; }
function failure(res: ServerResponse, error: unknown) { if (!res.headersSent) json(res, { error: (error as Error).message }, 400); else res.end(); }
// Resolve the real parent too: a project symlink must never escape its root.
function filePath(dir: string, path: string, creating = false): string {
  if (!safePath(path)) throw new Error('Invalid file path');
  const root = realpathSync(dir);
  const full = resolve(root, path);
  let ancestor = full;
  while (creating && !existsSync(ancestor)) ancestor = dirname(ancestor);
  const real = realpathSync(ancestor);
  if (relative(root, real).startsWith('..') || real === root && !creating) throw new Error('File is outside the project');
  return full;
}
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
async function staticFile(res: ServerResponse, path: string, type = MIME[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream') {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(await readFile(path));
}
// The web app's files (dist/web): the page, its script and the chunks it loads, the stylesheet, fonts.
const WEB_ASSET = /^(?:[A-Za-z0-9_-]+\.(?:js|css)|fonts\/[A-Za-z0-9_-]+\.(?:ttf|woff2))$/;
const webDir = join(appDir, 'web');
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', origin);
  if (req.headers.host !== new URL(origin).host) return json(res, { error: 'Invalid host' }, 403);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: ipc: http://ipc.localhost; frame-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (url.pathname === '/' && url.searchParams.get('key') === secret) {
    res.writeHead(303, { location: '/', 'set-cookie': `syncpi_app=${secret}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
    return void res.end();
  }
  if (!authorized(req) || !sameOrigin(req)) return json(res, { error: 'Open the app using its launch link' }, 403);
  // The app: the shell (sidebar, threads) around each session's web view (web/shell.html, web/index.html).
  if (url.pathname === '/') return staticFile(res, join(webDir, 'shell.html'));
  if (WEB_ASSET.test(url.pathname.slice(1))) return staticFile(res, join(webDir, url.pathname.slice(1)));
  if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, { sessions: runtime.list(), identity: identity(), defaults: piDefaults(), login });
  if (url.pathname === '/api/sessions' && req.method === 'POST') { const data = await input(req); return json(res, { id: await runtime.create({ ...data, faux: args.faux }) }); }
  // Messages that mention you in any thread (the inbox): shared threads are followed in the background for this.
  if (url.pathname === '/api/inbox' && req.method === 'GET') {
    const items = [];
    for (const s of runtime.list()) {
      const live = runtime.live.get(s.id) ?? runtime.watch(s.id);
      const me = live?.native.me;
      if (!live || !me) continue;
      for (const m of mentionsOf(live.native.main.state, me)) items.push({ ...m, thread: s.id, threadTitle: s.title || s.name, author: live.native.members.find(p => p.id === m.memberId)?.name ?? m.author });
    }
    return json(res, { items });
  }
  if (url.pathname === '/api/join' && req.method === 'POST') { const data = await input(req); const id = await runtime.join(data.url, data.name); login = undefined; return json(res, { id }); }
  const action = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/([a-z-]+)$/);
  if (action) {
    const [, id, verb] = action;
    if (verb === 'decorate' && req.method === 'POST') {
      const data = await input(req);
      const patch: Record<string, unknown> = {};
      for (const k of ['pinned', 'bookmarked', 'archived']) if (typeof data[k] === 'boolean') patch[k] = data[k];
      if (typeof data.title === 'string') patch.title = data.title.trim().slice(0, 160);
      if (Array.isArray(data.tags)) patch.tags = data.tags.filter((v: unknown) => typeof v === 'string').slice(0, 20).map((v: string) => v.slice(0, 40));
      runtime.decorate(id!, patch); return json(res, { ok: true });
    }
    if (verb === 'retry' && req.method === 'POST') { await runtime.retry(id!); return json(res, { ok: true }); }
    const live = await runtime.open(id!);
    if (verb === 'native' && req.method === 'GET') return json(res, live.snapshot());
    if (verb === 'send' && req.method === 'POST') {
      const message = await input(req);
      if (!['submit', 'abort', 'invite', 'invites', 'revoke', 'setRole', 'remove', 'rename', 'compact', 'new', 'branches', 'fork', 'switchBranch', 'configure'].includes(message.type)) throw new Error('Unknown session command');
      if (message.type === 'submit' && (typeof message.text !== 'string' || typeof message.requestId !== 'string')) throw new Error('A message and request ID are required');
      live.send(message as ClientMessage); return json(res, { ok: true });
    }
    if (verb === 'models') {
      const response = await fetch(`${live.record.url}/api/models`, { headers: { authorization: `Bearer ${live.record.token}` } });
      return json(res, await response.json(), response.status);
    }
    if (verb === 'open' && req.method === 'POST') return json(res, { ok: true });
    if (verb === 'title' && req.method === 'POST') {
      const response = await fetch(`${live.record.url}/api/title`, { method: 'POST', headers: { authorization: `Bearer ${live.record.token}` }, signal: AbortSignal.timeout(60_000) });
      const data = await response.json() as { title?: string; error?: string };
      if (!response.ok || !data.title) throw new Error(data.error || 'Could not generate a title');
      runtime.decorate(id!, { title: data.title }); return json(res, data);
    }
    // The session in a browser: its web address with this member's token.
    if (verb === 'weblink') return json(res, { url: `${live.record.url.replace(/\/$/, '')}/#token=${encodeURIComponent(live.record.token)}` });
    if (verb === 'context') return json(res, { skillCount: live.context.skillCount, agents: live.context.agents.map(a => a.path), prompts: live.context.prompts.map(p => ({ name: p.name, description: p.description })), sync: live.sync });
    if (verb === 'update' && req.method === 'POST') { await runtime.update(id!); return json(res, { ok: true }); }
    if (verb === 'sync' && req.method === 'POST') { await live.mirror.fence('flush', 0); return json(res, live.sync); }
    if (verb === 'files') return json(res, { files: await listFiles(live.record.dir) });
    if (verb === 'file') {
      const path = url.searchParams.get('path') || '';
      const full = filePath(live.record.dir, path, req.method === 'PUT');
      if (req.method === 'PUT') {
        await live.editable();
        const bytes = await body(req);
        const current = existsSync(full) ? hashBytes(await readFile(full)) : 'none';
        if (url.searchParams.get('base') !== current) return json(res, { error: 'This file changed since you opened it. Reload it before saving.' }, 409);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(`${full}.syncpi-tmp`, bytes); renameSync(`${full}.syncpi-tmp`, full);
        return json(res, { hash: hashBytes(bytes) });
      }
      const bytes = await readFile(full);
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('This file is binary or too large to edit');
      return json(res, { text: bytes.toString('utf8'), hash: hashBytes(bytes) });
    }
    if (verb === 'git') {
      if (req.method === 'POST') {
        await live.editable(); const data = await input(req);
        if (data.action === 'stage') {
          const path = safePath(data.path || ''); if (!path) throw new Error('Choose a valid file');
          await run('git', ['add', '--', path], { cwd: live.record.dir });
        } else if (data.action === 'commit') {
          if (typeof data.message !== 'string' || !data.message.trim()) throw new Error('A commit message is required');
          await run('git', ['commit', '-m', data.message.slice(0, 4000)], { cwd: live.record.dir });
        } else throw new Error('Unknown Git action');
      }
      const opts = { cwd: live.record.dir, maxBuffer: 4 * 1024 * 1024 };
      const [status, diff, staged, branch] = await Promise.all([
        run('git', ['status', '--porcelain=v1', '-z'], opts), run('git', ['diff', '--no-ext-diff', '--no-color'], opts),
        run('git', ['diff', '--cached', '--no-ext-diff', '--no-color'], opts), run('git', ['branch', '--show-current'], opts),
      ]);
      const entries = status.stdout.split('\0').filter(Boolean);
      const files: { status: string; path: string }[] = [];
      for (let n = 0; n < entries.length; n++) { const e = entries[n]!; files.push({ status: e.slice(0, 2), path: e.slice(3) }); if (/[RC]/.test(e.slice(0, 2))) n++; }
      return json(res, { files, diff: diff.stdout, staged: staged.stdout, branch: branch.stdout.trim() });
    }
    if (verb === 'reveal' && req.method === 'POST') {
      const data = await input(req);
      const command = data.editor ? 'zed' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [live.record.dir], { detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
      return json(res, { ok: true });
    }
  }
  // A session's web view: the same page browsers get from its server, through a proxy that adds this member's
  // credentials, so the page never holds the token.
  const sessionPath = url.pathname.match(/^\/session\/([a-zA-Z0-9_-]+)\/(.*)$/);
  if (sessionPath) {
    const [, id, rest] = sessionPath;
    if (!rest) {
      if (!loadSession(id!)) return json(res, { error: 'No such session' }, 404);
      let html = await readFile(join(webDir, 'index.html'), 'utf8');
      html = html.replace('__BASE__', `/session/${id}/`).replace('<html lang="en">', '<html lang="en" data-desktop="true">');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return void res.end(html);
    }
    if (WEB_ASSET.test(rest!)) return staticFile(res, join(webDir, rest!));
    if (!/^api\/(info|manifest|models|file|title)$/.test(rest!)) return json(res, { error: 'Unknown route' }, 404);
    const live = await runtime.open(id!);
    const upstream = await fetch(`${live.record.url}/${rest}${url.search}`, { method: req.method, headers: { authorization: `Bearer ${live.record.token}` }, body: ['PUT', 'POST'].includes(req.method || '') ? new Uint8Array(await body(req)) : undefined, signal: AbortSignal.timeout(60_000), redirect: 'error' });
    const headers: Record<string, string> = { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' };
    const hash = upstream.headers.get('x-hash'); if (hash) headers['x-hash'] = hash;
    res.writeHead(upstream.status, headers);
    res.end(Buffer.from(await upstream.arrayBuffer())); return;
  }
  json(res, { error: 'Not found' }, 404);
}
const server = createServer((req, res) => { void handle(req, res).catch(e => failure(res, e)); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const terminals = new Set<pty.IPty>();
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req) || !sameOrigin(req) || req.headers.host !== new URL(origin).host) return void socket.destroy();
  const path = new URL(req.url!, origin).pathname;
  const match = path.match(/^\/(session|terminal)\/([a-zA-Z0-9_-]+)(?:\/ws)?$/);
  if (!match) return void socket.destroy();
  void runtime.open(match[2]!).then(async live => {
    if (match[1] === 'terminal') await live.editable();
    wss.handleUpgrade(req, socket, head, ws => {
      if (match[1] === 'terminal') {
        let term: pty.IPty;
        try { term = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l'], { name: 'xterm-256color', cols: 100, rows: 24, cwd: live.record.dir, env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('SYNCPI_'))) }); }
        catch (e) { ws.send(JSON.stringify({ error: (e as Error).message })); ws.close(); return; }
        terminals.add(term);
        const data = term.onData(text => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ data: text })); });
        const permission = (m: ServerMessage) => { if (m.type === 'removed') ws.close(); else if (m.type === 'presence') void live.editable().catch(() => ws.close()); };
        live.onMessage.add(permission);
        const exited = term.onExit(({ exitCode }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ exitCode })); ws.close(); });
        ws.on('message', raw => { try { const m = JSON.parse(String(raw)); if (typeof m.data === 'string') term.write(m.data); if (m.cols && m.rows) term.resize(Math.max(10, Math.min(500, m.cols)), Math.max(2, Math.min(200, m.rows))); } catch {} });
        ws.on('close', () => { data.dispose(); exited.dispose(); live.onMessage.delete(permission); term.kill(); terminals.delete(term); });
        return;
      }
      const remote = new WebSocket(`${live.record.url.replace(/^http/, 'ws')}/ws?client=web&token=${encodeURIComponent(live.record.token)}`);
      remote.on('message', (raw, binary) => { if (!binary && ws.readyState === WebSocket.OPEN) ws.send(raw.toString()); });
      remote.on('close', code => { if (ws.readyState === WebSocket.OPEN) ws.close(code === 4001 ? 4001 : 1012); });
      remote.on('error', () => ws.close(1011));
      const listener = (m: ServerMessage) => { if ((m.type === 'error' || m.type === 'invite' || m.type === 'invites' || m.type === 'accepted') && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
      live.onMessage.add(listener);
      ws.on('message', raw => {
        try { const m = JSON.parse(String(raw)) as ClientMessage;
          if (['device', 'envClose', 'fenceDone'].includes(m.type)) return;
          live.send(m);
        } catch { ws.close(1003); }
      });
      ws.on('close', () => { remote.close(); live.onMessage.delete(listener); });
    });
  }).catch(() => socket.destroy());
});
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && Number(args.port) !== 0) { args.port = '0'; server.listen(0, '127.0.0.1'); }
  else throw error;
});
server.listen(Number(args.port), '127.0.0.1', () => {
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  console.log(`SYNCPI_APP ${origin}/?key=${secret}`);
});
function close() { for (const t of terminals) t.kill(); runtime.close(); server.close(); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);

// A force-closed native app must not leave its sync/terminal sidecar behind.
const parentPID = Number(process.env.SYNCPI_APP_PARENT);
if (parentPID > 1) setInterval(() => { try { process.kill(parentPID, 0); } catch { close(); } }, 2000).unref();
