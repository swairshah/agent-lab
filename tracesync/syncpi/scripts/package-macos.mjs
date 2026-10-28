// A native Rust/GPUI application with the existing SyncPi agent service as a private sidecar.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const profile = process.env.SYNCPI_PACKAGE_PROFILE || 'release';
const binary = join(root, 'desktop/target', profile, 'syncpi-desktop');
if (!existsSync(binary)) throw new Error(`Build the native desktop app first (cargo build --manifest-path desktop/Cargo.toml${profile === 'release' ? ' --release' : ''}).`);
const target = join(root, 'dist/SyncPi.app');
if (existsSync(target)) {
 const plist = join(target, 'Contents/Info.plist');
 if (!existsSync(plist) || !readFileSync(plist,'utf8').includes('dev.syncpi.desktop')) throw new Error('Refusing to replace an unrecognized app.');
 rmSync(target, { recursive: true });
}
const contents = join(target,'Contents');
mkdirSync(join(contents,'MacOS'), { recursive: true });
const runtime = join(contents,'Resources/runtime'); mkdirSync(runtime, { recursive: true });
cpSync(binary, join(contents,'MacOS/SyncPi')); chmodSync(join(contents,'MacOS/SyncPi'),0o755);
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
writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.syncpi.desktop</string>
<key>CFBundleExecutable</key><string>SyncPi</string>
<key>CFBundleName</key><string>SyncPi</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>dev.syncpi.desktop.open</string><key>CFBundleURLSchemes</key><array><string>syncpi</string></array></dict></array>
<key>CFBundleDisplayName</key><string>SyncPi</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`);
execFileSync('codesign',['--force','--deep','--sign','-',target],{stdio:'inherit'});
console.log(target);
