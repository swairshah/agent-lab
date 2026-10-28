// The desktop app: a native window (Tauri, desktop/) around the web app, with the SyncPi host as a private sidecar.
import { cpSync, existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeBundle } from './mac-bundle.mjs';
const root = resolve(import.meta.dirname, '..');
const profile = process.env.SYNCPI_PACKAGE_PROFILE || 'release';
const binary = join(root, 'desktop/target', profile, 'syncpi-desktop');
if (!existsSync(binary)) throw new Error(`Build the desktop app first (cargo build --manifest-path desktop/Cargo.toml${profile === 'release' ? ' --release' : ''}).`);
const target = join(root, 'dist/SyncPi.app');
const contents = writeBundle(target, binary);
const runtime = join(contents,'Resources/runtime'); mkdirSync(runtime, { recursive: true });
for (const name of ['desktop-host.mjs', 'pi-context.mjs', 'server.mjs', 'relay.mjs', 'web']) cpSync(join(root,'dist',name),join(runtime,name),{recursive:true});
cpSync(process.execPath,join(runtime,'node')); chmodSync(join(runtime,'node'),0o755);
writeFileSync(join(runtime,'package.json'), JSON.stringify({name:'syncpi-runtime',version:'0.1.0',type:'module'}));
const excluded = new Set(['electron','@playwright','playwright','playwright-core','@types','@esbuild','esbuild','typescript','@typescript','@xterm','.bin']);
const modules=join(runtime,'node_modules'); mkdirSync(modules);
for (const name of readdirSync(join(root,'node_modules'))) if (!excluded.has(name) && !name.startsWith('.')) cpSync(join(root,'node_modules',name),join(modules,name),{recursive:true,dereference:true});
// Dependency command shims are unnecessary in the sidecar and may point outside the bundle.
function removeCommandShims(dir) {
 for (const entry of readdirSync(dir, {withFileTypes:true})) {
  const child=join(dir,entry.name);
  if (entry.name === '.bin') rmSync(child,{recursive:true,force:true});
  else if (entry.isDirectory()) removeCommandShims(child);
 }
}
removeCommandShims(modules);
for (const arch of ['darwin-arm64','darwin-x64']) { const helper=join(modules,'node-pty/prebuilds',arch,'spawn-helper'); if(existsSync(helper))chmodSync(helper,0o755); }
execFileSync('codesign',['--force','--deep','--sign','-',target],{stdio:'inherit'});
console.log(target);
