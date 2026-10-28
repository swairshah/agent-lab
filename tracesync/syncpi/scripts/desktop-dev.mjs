// `npm run desktop`: runs the debug build from inside an app bundle (desktop/target/debug/SyncPi.app), so macOS shows
// SyncPi's icon in the Dock and the app switcher rather than a plain executable's. The host and pages still come from
// the repository's dist/ (see runtime() in desktop/src/main.rs), and the output stays in this terminal.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeBundle } from './mac-bundle.mjs';
const root = resolve(import.meta.dirname, '..');
const contents = writeBundle(join(root, 'desktop/target/debug/SyncPi.app'), join(root, 'desktop/target/debug/syncpi-desktop'));
const app = spawn(join(contents, 'MacOS/SyncPi'), process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.kill(signal));
app.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
