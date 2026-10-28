// The parts of SyncPi.app that make macOS treat the program as an app: Info.plist, the icon, and the program itself
// in Contents/MacOS. Used by the packaged app (package-macos.mjs) and by `npm run desktop` (desktop-dev.mjs), so the
// app has its icon in the Dock and the app switcher either way.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const icons = resolve(import.meta.dirname, '../desktop/icons');

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
 writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.syncpi.desktop</string>
<key>CFBundleExecutable</key><string>SyncPi</string>
<key>CFBundleName</key><string>SyncPi</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundleIconName</key><string>AppIcon</string>
<key>CFBundleDisplayName</key><string>SyncPi</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`);
 return contents;
}
