// The parts of SyncPi.app that make macOS treat the program as an app: Info.plist, the icon, and the program itself
// in Contents/MacOS. Used by the packaged app (package-macos.mjs) and build-icon.mjs. (A build run outside a bundle
// makes the same bundle for itself: see in_bundle() in desktop/src/main.rs.)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktop = resolve(import.meta.dirname, '../desktop');
const icons = join(desktop, 'icons');

export function writeBundle(target, binary) {
 if (existsSync(target)) {
  const plist = join(target, 'Contents/Info.plist');
  if (!existsSync(plist) || !readFileSync(plist,'utf8').includes('dev.syncpi.desktop')) throw new Error('Refusing to replace an unrecognized app.');
  rmSync(target, { recursive: true });
 }
 const contents = join(target,'Contents');
 mkdirSync(join(contents,'MacOS'), { recursive: true });
 mkdirSync(join(contents,'Resources'), { recursive: true });
 cpSync(binary, join(contents,'MacOS/SyncPi')); chmodSync(join(contents,'MacOS/SyncPi'),0o755);
 // Assets.car holds the icon for macOS 26 and later (compiled from icons/AppIcon.icon, see build-icon.mjs); icon.icns
 // is the same icon for earlier versions.
 cpSync(join(icons,'Assets.car'), join(contents,'Resources/Assets.car'));
 cpSync(join(icons,'icon.icns'), join(contents,'Resources/icon.icns'));
 cpSync(join(desktop,'Info.plist'), join(contents,'Info.plist'));
 return contents;
}
