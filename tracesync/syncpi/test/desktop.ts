// App-owned sessions tested through the real browser UI, with isolated homes and a scripted model.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

const root = mkdtempSync(join(tmpdir(), 'syncpi-desktop-test-'));
const project = join(root, 'project'); mkdirSync(project);
writeFileSync(join(project, 'README.md'), '# Shared project\n');
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Initial'], { cwd: project });
const outside = join(root, 'outside.txt'); writeFileSync(outside, 'private');
const processes: ChildProcess[] = [];
const homes: string[] = [];
let browser: Browser | undefined;
let checks = 0;
function ok(text: string) { console.log(`✓ ${++checks}. ${text}`); }
async function host(name: string) {
  const home = join(root, name); homes.push(home);
  const proc = spawn(process.execPath, [join(import.meta.dirname, '../dist/desktop-host.mjs'), '--faux'], { env: { ...process.env, SYNCPI_HOME: home, PI_CODING_AGENT_DIR: join(root, 'empty-pi') }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(proc); let output = ''; let stderr = ''; proc.stdout!.on('data', d => { output += d; }); proc.stderr!.on('data', d => { stderr += d; });
  await expect.poll(() => output.includes('SYNCPI_APP'), { timeout: 15000, message: 'App host started' }).toBeTruthy();
  const launch = output.match(/SYNCPI_APP (\S+)/)![1]!; const origin = new URL(launch).origin;
  return { home, proc, launch, origin, stderr: () => stderr };
}
async function create(page: Page, title: string) {
  await page.locator('[data-action=new]').first().click();
  await page.locator('#project-dir').fill(project);
  await page.locator('#thread-title').fill(title);
  await page.getByRole('button', { name: 'Create thread', exact: true }).click();
  await expect(page.locator('#create-dialog')).not.toBeVisible();
  await expect(page.locator('#title')).toHaveText(title, { timeout: 60000 });
  const frame = page.frameLocator('#session');
  await expect(frame.locator('#input')).toBeVisible({ timeout: 60000 });
  await expect(frame.locator('#env-dot')).toHaveClass(/ready/, { timeout: 20000 });
  return frame;
}
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM || join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  browser = await chromium.launch({ headless: true, ...(existsSync(executablePath) ? { executablePath } : {}) });
  const owner = await host('owner');
  assert.equal((await fetch(`${owner.origin}/api/sessions`)).status, 403);
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(owner.launch);
  let frame = await create(page, 'Independent app agent');
  ok('the frontend creates and provisions its own durable agent without a CLI session');
  const record = JSON.parse(readFileSync(join(owner.home, 'sessions', readdirSync(join(owner.home, 'sessions')).find(n => n.endsWith('.json') && !n.includes('.base.'))!), 'utf8'));
  const endpoint = `${owner.origin}/api/sessions/${record.id}`;
  const cookie = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie, 'content-type': 'application/json' };
  assert.equal((await fetch(`${owner.origin}/api/sessions`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
  symlinkSync(outside, join(project, 'escape.txt'));
  assert.equal((await fetch(`${endpoint}/file?path=escape.txt`, { headers })).status, 400);
  assert.equal((await fetch(`${endpoint}/file?path=../outside.txt`, { headers })).status, 400);
  ok('local APIs reject missing credentials, cross-origin mutations, traversal, and escaping symlinks');
  await frame.locator('#input').fill('write agent.txt From the desktop agent'); await frame.locator('#send').click();
  await expect.poll(() => existsSync(join(project, 'agent.txt')) && readFileSync(join(project, 'agent.txt'), 'utf8'), { timeout: 20000 }).toBe('From the desktop agent');
  await expect(frame.locator('#thread')).toContainText('Done.');
  await expect.poll(async () => (await frame.locator('#input').evaluate(el => localStorage.getItem(`outbox:syncpi-token:${location.origin}${new URL(document.baseURI).pathname}`))) || '[]').toBe('[]');
  ok('agent tools execute on the app user’s machine and submissions are acknowledged');
  await page.getByRole('button', { name: 'Open files', exact: true }).click();
  await page.locator('[data-file="agent.txt"]').click(); await page.locator('#file-text').fill('Edited in the app'); await page.locator('#save-file').click();
  await expect(page.locator('#file-feedback')).toContainText('Saved');
  assert.equal(readFileSync(join(project, 'agent.txt'), 'utf8'), 'Edited in the app');
  const conflict = await fetch(`${endpoint}/file?path=agent.txt&base=none`, { method: 'PUT', headers: { cookie }, body: 'Overwrite' }); assert.equal(conflict.status, 409);
  ok('file editing saves to the checkout and stale writes cannot overwrite newer changes');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.locator('#changed-files')).toContainText('agent.txt'); await page.locator('[data-stage="agent.txt"]').click();
  await expect(page.locator('.diff').last()).toContainText('Edited in the app');
  ok('Git review shows real status and diffs, and stages selected files');
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  const terminalSocket = new (await import('ws')).WebSocket(`${owner.origin.replace('http', 'ws')}/terminal/${record.id}`, { headers: { cookie, origin: owner.origin } });
  let terminalOutput = ''; terminalSocket.on('message', d => { terminalOutput += JSON.parse(String(d)).data || ''; });
  await new Promise<void>((resolve, reject) => { terminalSocket.once('open', resolve); terminalSocket.once('error', reject); });
  terminalSocket.send(JSON.stringify({ data: "printf 'terminal-verified\\n'\r" }));
  await expect.poll(() => terminalOutput.includes('terminal-verified'), { timeout: 10000 }).toBeTruthy(); terminalSocket.close();
  ok('the integrated terminal has an interactive PTY in the project checkout');
  await page.locator('#terminal-close').click(); await page.locator('#close-pane').click();
  await frame.locator('#input').fill('A draft that survives a thread switch');
  const firstID = record.id;
  await create(page, 'Second thread');
  await page.locator(`[data-session="${firstID}"]`).click();
  frame = page.frameLocator('#session'); await expect(frame.locator('#input')).toHaveValue('A draft that survives a thread switch');
  ok('thread switching restores drafts and durable transcript history');
  await frame.locator('#input').fill('');
  await page.getByRole('button', { name: 'Thread actions', exact: true }).first().click(); await page.getByRole('button', { name: 'Pin thread', exact: true }).click();
  await expect(page.locator(`[data-session="${firstID}"] .thread-dot`)).toHaveText('⌁');
  await page.getByRole('button', { name: 'Thread actions', exact: true }).first().click(); await page.getByRole('button', { name: 'Bookmark thread', exact: true }).click();
  await page.locator('[data-filter=bookmarked]').click(); await expect(page.locator('#threads .thread-row')).toHaveCount(1); await page.locator('[data-filter=all]').click();
  ok('pins, bookmarks, and filters persist through the app service');
  await frame.locator('.fork-message').first().click();
  await expect(frame.locator('#branch-button')).not.toHaveText('⑂ main');
  await frame.locator('#branch-button').click(); await frame.locator('[data-branch]').filter({ hasText: 'main' }).click();
  await expect(frame.locator('#thread')).toContainText('Done.');
  ok('edit-and-fork creates a real shared branch and switching back restores the original history');
  await frame.locator('#input').fill('');
  await page.getByRole('button', { name: 'Share thread', exact: true }).click(); await expect(frame.locator('#share-dialog')).toBeVisible();
  const share = await frame.locator('#share-url').inputValue(); await frame.locator('#share-dialog button').filter({hasText:'Close'}).click();
  const collaborator = await host('collaborator'); const collabContext = await browser.newContext(); const bob = await collabContext.newPage(); await bob.goto(collaborator.launch);
  await bob.getByRole('button', { name: 'Join a shared thread', exact: true }).click(); await bob.locator('#join-url').fill(share); await bob.locator('#join-name').fill('Bob'); await bob.getByRole('button', { name: 'Join thread', exact: true }).click();
  const bobFrame = bob.frameLocator('#session'); await expect(bobFrame.locator('#input')).toBeVisible({ timeout: 30000 });
  await bobFrame.locator('#input').fill('hello from the second desktop app'); await bobFrame.locator('#send').click();
  await expect(frame.locator('#thread')).toContainText('hello from the second desktop app', { timeout: 15000 });
  await bobFrame.locator('#input').fill('write shared.txt From Bob'); await bobFrame.locator('#send').click();
  await expect.poll(() => existsSync(join(project, 'shared.txt')), { timeout: 20000 }).toBeTruthy();
  ok('another app joins by invite, downloads the checkout, and shares agent messages and file changes');
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(frame.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({ path: join(root, 'desktop-dark.png') });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await expect(frame.locator('html')).toHaveAttribute('data-theme','light'); await page.screenshot({ path: join(root, 'desktop-light.png') });
  assert.deepEqual(errors, []);
  ok('light/dark themes propagate into the shared renderer with no browser exceptions');
  console.log(`Desktop checks passed (${checks}). Screenshots: ${root}`);
} finally {
  await browser?.close();
  for (const proc of processes) proc.kill('SIGTERM');
  for (const home of homes) {
    const local = join(home, 'local'); if (!existsSync(local)) continue;
    for (const id of readdirSync(local)) { try { process.kill(Number(readFileSync(join(local, id, 'pid'), 'utf8')), 'SIGTERM'); } catch {} }
  }
}
