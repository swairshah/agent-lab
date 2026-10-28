// The app owns these connections. No terminal UI or CLI process is involved.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Connection, join as joinRemote } from '../cli/client.ts';
import { LocalDevice } from '../cli/device.ts';
import { expandTemplate, loadPiContext, type LoadedPiContext } from '../cli/pi-context.ts';
import { DEFAULT_HOST, ensureLocalRunning, freePort, gatewayModel, piDefaults, provisionLocal, provisionOnHost, updateServerExe, ensureHost } from '../cli/provision.ts';
import { home, identity, loadSession, projectsDir, saveSession, sessions, type SessionRecord } from '../cli/store.ts';
import { extractSnapshot, safeName, safeVm } from '../cli/snapshot.ts';
import { Mirror } from '../cli/sync.ts';
import { Thread } from '../shared/thread.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';

export type Decoration = { title?: string; pinned?: boolean; bookmarked?: boolean; archived?: boolean; tags?: string[]; lastOpened?: number };
export class DesktopRuntime {
  readonly live = new Map<string, LiveSession>();
  readonly pending = new Map<string, Promise<void>>();
  readonly decorations: Record<string, Decoration>;
  readonly contextHelper: string;
  onLogin: (url: string, check: string) => void = () => {};
  constructor(contextHelper: string) {
    this.contextHelper = contextHelper;
    try { this.decorations = JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')); } catch { this.decorations = {}; }
  }
  list() {
    return sessions().map(({ token: _, setup: __, ...s }) => ({ ...s, ...this.decorations[s.id], connection: this.live.get(s.id)?.conn.state, sync: this.live.get(s.id)?.sync, login: this.live.get(s.id)?.login }));
  }
  decorate(id: string, patch: Decoration) {
    if (!loadSession(id)) throw new Error('No such session');
    this.decorations[id] = { ...this.decorations[id], ...patch };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, 'desktop.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(this.decorations), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  async create(input: { dir: string; compute?: string; model?: string; setupModel?: string; thinkingLevel?: string; vm?: string; faux?: boolean; title?: string }) {
    const dir = realpathSync(resolve(input.dir));
    const id = randomBytes(6).toString('hex');
    const local = input.compute === 'local' || input.faux === true;
    const defaults = piDefaults();
    const selected = input.model || defaults.model || 'anthropic/claude-opus-5-5';
    const model = local ? selected : gatewayModel(selected, 'anthropic/claude-opus-5-5').model;
    const vm = local ? undefined : safeVm(input.vm || DEFAULT_HOST);
    const port = local ? await freePort() : undefined;
    const record: SessionRecord = { id, name: basename(dir), dir, token: randomBytes(24).toString('base64url'), role: 'owner', compute: local ? 'local' : 'host', vm, port, localRoot: local ? join(home, 'local', id) : undefined, url: local ? `http://127.0.0.1:${port}` : `https://${vm}.exe.xyz/${id}`, createdAt: Date.now(), status: 'provisioning', step: 'Preparing project', setup: { owner: identity(), model, setupModel: input.setupModel || model, thinkingLevel: input.thinkingLevel || defaults.thinkingLevel, faux: input.faux } };
    await Mirror.adopt(id, dir);
    saveSession(record);
    this.decorate(id, { title: input.title || 'New thread' });
    this.provision(record);
    return id;
  }
  provision(record: SessionRecord) {
    const update = (patch: Partial<SessionRecord>) => saveSession({ ...(loadSession(record.id) || record), ...patch });
    const task = (async () => {
      try {
        const config = { id: record.id, name: record.name, ownerToken: record.token, ...record.setup! };
        const progress = (step: string) => update({ step });
        if (record.compute === 'local') await provisionLocal(record.dir, config, record.port!, progress, { faux: record.setup?.faux });
        else await provisionOnHost(record.dir, config, record.vm!, progress);
        update({ status: 'ready', step: undefined, error: undefined });
      } catch (e) { update({ status: 'failed', step: undefined, error: (e as Error).message }); }
    })();
    this.pending.set(record.id, task);
    void task.finally(() => this.pending.delete(record.id));
  }
  async retry(id: string) {
    const s = loadSession(id);
    if (!s?.setup || s.role !== 'owner') throw new Error('This session cannot be provisioned here');
    if (this.pending.has(id)) return;
    saveSession({ ...s, status: 'provisioning', error: undefined });
    this.provision(s);
  }
  async open(id: string): Promise<LiveSession> {
    const existing = this.live.get(id);
    if (existing) return existing;
    const s = loadSession(id);
    if (!s) throw new Error('No such session');
    const live = new LiveSession(s, this.contextHelper);
    this.live.set(id, live);
    try {
      await this.pending.get(id);
      const latest = loadSession(id)!;
      if (latest.status === 'failed' || latest.status === 'provisioning') throw new Error(latest.error || 'Session is still being prepared. Retry setup if it was interrupted.');
      if (s.compute === 'local') await ensureLocalRunning(s.localRoot!, s.url, () => {});
      live.start();
      this.decorate(id, { lastOpened: Date.now() });
      return live;
    } catch (e) { live.close(); this.live.delete(id); throw e; }
  }
  async join(url: string, name?: string) {
    const { parseShareUrl } = await import('../shared/protocol.ts');
    const link = parseShareUrl(url);
    if (!link) throw new Error('Use a SyncPi share link, including /s/<code>');
    const existing = sessions().find(s => s.url.replace(/\/$/, '') === link.origin);
    if (existing) return existing.id;
    const joined = await joinRemote(link.origin, link.invite, name || identity().name, (url, check) => this.onLogin(url, check));
    const response = await fetch(`${link.origin}/api/info`, { headers: { authorization: `Bearer ${joined.token}` } });
    if (!response.ok) throw new Error('Could not read the joined session');
    const info = await response.json() as { id: string; name: string; vm?: string };
    const nameSafe = safeName(info.name);
    let dir = join(projectsDir(), nameSafe);
    for (let n = 2; existsSync(dir); n++) dir = join(projectsDir(), `${nameSafe}-${n}`);
    mkdirSync(dir, { recursive: true });
    const conn = new Connection(link.origin, joined.token);
    const snapshot = await conn.snapshot();
    if (!snapshot.body) throw new Error('Empty project snapshot');
    await extractSnapshot(snapshot.body, dir);
    const id = randomBytes(6).toString('hex');
    saveSession({ id, name: nameSafe, dir, token: joined.token, url: link.origin, compute: 'remote', vm: safeVm(info.vm), role: 'editor', createdAt: Date.now() });
    await Mirror.adopt(id, dir);
    return id;
  }
  async update(id: string) {
    const s = loadSession(id);
    if (!s || s.role !== 'owner') throw new Error('Only the owner can update the server');
    if (s.compute === 'host') await ensureHost(s.vm!, () => {});
    else if (s.compute === 'exe') await updateServerExe(s.vm!);
    else if (s.compute !== 'local') throw new Error('This server is managed by its owner');
  }
  close() { for (const s of this.live.values()) s.close(); }
}

export class LiveSession {
  readonly conn: Connection;
  readonly mirror: Mirror;
  readonly device: LocalDevice;
  readonly record: SessionRecord;
  context: LoadedPiContext = { skills: '', skillCount: 0, agents: [], prompts: [] };
  sync = { pushed: 0, pulled: 0, conflicts: [] as string[], error: '' };
  login?: { url: string; check: string };
  role = 'viewer';
  native = { main: new Thread(), setup: new Thread(), me: undefined as import('../shared/protocol.ts').Member | undefined, members: [] as import('../shared/protocol.ts').Member[], online: [] as import('../shared/protocol.ts').Presence[], env: { status: 'pending' } as import('../shared/protocol.ts').EnvStatus, branches: [] as import('../shared/protocol.ts').BranchInfo[], currentBranch: 0, target: '', error: '', lastInvite: undefined as { url: string; invite: import('../shared/protocol.ts').InviteInfo } | undefined, invites: [] as import('../shared/protocol.ts').InviteInfo[] };
  snapshot() { return { main: this.native.main.state, setup: this.native.setup.state, me: this.native.me, members: this.native.members, online: this.native.online, env: this.native.env, branches: this.native.branches, currentBranch: this.native.currentBranch, target: this.native.target, error: this.native.error, lastInvite: this.native.lastInvite, invites: this.native.invites, sync: this.sync, connection: this.conn.state, context: { skillCount: this.context.skillCount, prompts: this.context.prompts.map(p => ({ name: p.name, description: p.description })) } }; }
  onMessage = new Set<(m: ServerMessage) => void>();
  constructor(record: SessionRecord, helper: string) {
    this.record = record;
    this.conn = new Connection(record.url, record.token);
    this.mirror = new Mirror(record.id, record.dir, this.conn);
    this.device = new LocalDevice(this.conn, this.mirror);
    this.conn.onOpen = () => this.device.register();
    this.conn.onBinary = d => this.device.binary(d);
    this.conn.onState = state => { if (state === 'closed') this.device.disconnected(); };
    this.conn.onMessage = m => {
      if (this.device.handle(m)) return;
      if (m.type === 'events') this.native[m.conv].apply(m.events);
      if (m.type === 'history') this.native[m.conv].prepend(m.entries);
      if (m.type === 'env') this.native.env = m.env;
      if (m.type === 'branches') { this.native.branches = m.branches; this.native.currentBranch = m.current; }
      if (m.type === 'target') this.native.target = m.label;
      if (m.type === 'error') this.native.error = m.message;
      if (m.type === 'invite') this.native.lastInvite = { url: m.url, invite: m.invite };
      if (m.type === 'invites') this.native.invites = m.invites;
      if (m.type === 'welcome') { this.native.me = m.me; this.native.members = m.members; this.role = m.me.role; this.mirror.readOnly = m.me.role === 'viewer'; }
      if (m.type === 'presence') {
        this.native.members = m.members; this.native.online = m.online;
        const me = m.members.find(person => person.id === this.native.me?.id);
        if (me) { this.native.me = me; this.role = me.role; this.mirror.readOnly = me.role === 'viewer'; }
      }
      if (m.type === 'removed') { this.close(); }
      if (m.type === 'files') this.mirror.remoteChanged(m.full === true, m.changed, m.version);
      for (const listener of this.onMessage) listener(m);
    };
    this.mirror.onEvent = e => {
      this.sync = { pushed: this.mirror.pushed, pulled: this.mirror.pulled, conflicts: this.mirror.conflicts, error: e.type === 'error' ? e.message : '' };
    };
    void loadPiContext(record.dir, helper).then(context => { this.context = context; this.device.setContext(context); });
  }
  start() { this.mirror.start(); this.conn.start(); }
  async info(): Promise<{ me: { role: string }; workdir: string }> {
    const res = await fetch(`${this.record.url}/api/info`, { headers: { authorization: `Bearer ${this.record.token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Session access refused (${res.status})`);
    return res.json() as Promise<{ me: { role: string }; workdir: string }>;
  }
  async editable() { if ((await this.info()).me.role === 'viewer') throw new Error('Viewers cannot edit files or run commands'); }
  send(m: ClientMessage) {
    if (m.type === 'submit') m = { ...m, text: expandTemplate(m.text, this.context.prompts) ?? m.text, where: m.where === 'vm' ? 'vm' : 'device' };
    this.conn.send(m);
  }
  close() { this.mirror.stop(); this.device.disconnected(); this.conn.close(); }
}
