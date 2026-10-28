// `npm run icon`: rebuilds the app icon from its source, desktop/icons/AppIcon.icon (an Icon Composer file: a
// background fill and the arrows in Assets/arrows.svg; open it in Icon Composer to edit it). Xcode's actool compiles
// it to Assets.car (macOS 26 and later draw the icon from this, with their own shape, depth and dark mode) and
// icon.icns (earlier versions). The PNGs, for the window and other platforms, are the icon as macOS draws it.
// Needs Xcode; the results are committed so packaging doesn't.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeBundle } from './mac-bundle.mjs';
const icons = resolve(import.meta.dirname, '../desktop/icons');
const work = mkdtempSync(join(tmpdir(), 'syncpi-icon-'));
try {
 execFileSync('xcrun', ['actool', join(icons, 'AppIcon.icon'), '--compile', work, '--platform', 'macosx', '--minimum-deployment-target', '13.0',
  '--app-icon', 'AppIcon', '--output-partial-info-plist', join(work, 'partial.plist')], { stdio: ['ignore', 'ignore', 'inherit'] });
 cpSync(join(work, 'Assets.car'), join(icons, 'Assets.car'));
 cpSync(join(work, 'AppIcon.icns'), join(icons, 'icon.icns'));
 // Draw the PNGs from a throwaway bundle with the new icon, with a fresh identifier so macOS doesn't use a cached one.
 const app = join(work, 'Icon.app');
 writeBundle(app, '/usr/bin/true');
 execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `dev.syncpi.desktop.icon${Date.now()}`, join(app, 'Contents/Info.plist')]);
 writeFileSync(join(work, 'draw.swift'), `import AppKit
let icon = NSWorkspace.shared.icon(forFile: CommandLine.arguments[1])
for (name, size) in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)] {
 let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 NSGraphicsContext.saveGraphicsState()
 NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
 icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
 NSGraphicsContext.restoreGraphicsState()
 try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2] + "/" + name))
}
`);
 execFileSync('swift', [join(work, 'draw.swift'), app, icons], { stdio: 'inherit' });
} finally {
 rmSync(work, { recursive: true, force: true });
}
console.log(icons);
