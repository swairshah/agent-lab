// The GPUI desktop app (desktop-gpui/) as SyncPi GPUI.app, beside the Tauri app's SyncPi.app (package-macos.mjs,
// unchanged): the same icon, its own bundle id and name, and the same private runtime (the host, the server, node and
// its modules) in Contents/Resources/runtime, where host.rs looks for it.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeBundle } from './mac-bundle.mjs';

const root = resolve(import.meta.dirname, '..');
const profile = process.env.SYNCPI_PACKAGE_PROFILE || 'release';
const binary = join(root, 'desktop-gpui/target', profile, 'syncpi-gpui');
if (!existsSync(binary)) throw new Error(`Build the GPUI app first (cargo build --manifest-path desktop-gpui/Cargo.toml${profile === 'release' ? ' --release' : ''}).`);
const target = join(root, 'dist/SyncPi GPUI.app');
// writeBundle replaces only a bundle it recognizes as the Tauri app's; this one is recognized here.
const plist = join(target, 'Contents/Info.plist');
if (existsSync(target)) {
	if (!existsSync(plist) || !readFileSync(plist, 'utf8').includes('dev.syncpi.gpui')) throw new Error('Refusing to replace an unrecognized app.');
	rmSync(target, { recursive: true });
}
const contents = writeBundle(target, binary);
for (const [key, value] of [['CFBundleIdentifier', 'dev.syncpi.gpui'], ['CFBundleName', 'SyncPi GPUI'], ['CFBundleDisplayName', 'SyncPi GPUI']]) execFileSync('plutil', ['-replace', key, '-string', value, plist]);
const runtime = join(contents, 'Resources/runtime');
mkdirSync(runtime, { recursive: true });
for (const name of ['desktop-host.mjs', 'pi-context.mjs', 'server.mjs', 'relay.mjs', 'web']) cpSync(join(root, 'dist', name), join(runtime, name), { recursive: true });
cpSync(process.execPath, join(runtime, 'node'));
chmodSync(join(runtime, 'node'), 0o755);
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'syncpi-runtime', version: '0.1.0', type: 'module' }));
const excluded = new Set(['electron', '@playwright', 'playwright', 'playwright-core', '@types', '@esbuild', 'esbuild', 'typescript', '@typescript', '@xterm', '.bin']);
const modules = join(runtime, 'node_modules');
mkdirSync(modules);
for (const name of readdirSync(join(root, 'node_modules'))) if (!excluded.has(name) && !name.startsWith('.')) cpSync(join(root, 'node_modules', name), join(modules, name), { recursive: true, dereference: true });
// Dependency command shims are unnecessary in the runtime and may point outside the bundle.
function removeCommandShims(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = join(dir, entry.name);
		if (entry.name === '.bin') rmSync(child, { recursive: true, force: true });
		else if (entry.isDirectory()) removeCommandShims(child);
	}
}
removeCommandShims(modules);
for (const arch of ['darwin-arm64', 'darwin-x64']) {
	const helper = join(modules, 'node-pty/prebuilds', arch, 'spawn-helper');
	if (existsSync(helper)) chmodSync(helper, 0o755);
}
execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' });
console.log(target);
