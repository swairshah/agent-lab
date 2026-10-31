// Terminals in a browser: a shell on the session's VM, in the project's folder. The thread page's terminal panel (src/web/terminal.ts) speaks the same messages as the app's local
// terminals: { data } and { cols, rows } in, { data }, { exitCode } and { error } out.
//
// The server has no PTY library of its own (it's one bundled file), so a few lines of Python give the shell its
// terminal: the shell's input on stdin, its output on stdout, and window sizes ("cols rows") on fd 3.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";
import type { WebSocket } from "ws";

const RELAY = `
import fcntl, os, pty, select, signal, struct, sys, termios
cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
def size(f, c, r):
    fcntl.ioctl(f, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, r), max(10, c), 0, 0))
pid, fd = pty.fork()
if pid == 0:
    # The size is set before the program starts, which may read it only once.
    size(0, cols, rows)
    os.execvp(argv[0], argv)
watch, pending, out = [fd, 0, 3], b"", sys.stdout.buffer
while True:
    ready = select.select(watch, [], [])[0]
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(fd, data)
        else:
            watch.remove(0)
            os.kill(pid, signal.SIGHUP)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            watch.remove(3)
        pending += data
        while b"\\n" in pending:
            line, pending = pending.split(b"\\n", 1)
            try:
                c, r = map(int, line.split())
                size(fd, c, r)
            except ValueError:
                pass
status = os.waitpid(pid, 0)[1]
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** Runs `argv` in a terminal for this WebSocket until either ends. */
export function terminal(ws: WebSocket, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; onInput?: () => void }): void {
	const relay = spawn("python3", ["-c", RELAY, "100", "24", ...argv], { cwd: options.cwd, env: { ...options.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
	const sizes = relay.stdio[3] as Writable;
	const decoder = new StringDecoder("utf8");
	const send = (message: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
	relay.stdout!.on("data", (chunk: Buffer) => send({ data: decoder.write(chunk) }));
	relay.stderr!.on("data", (chunk: Buffer) => send({ data: decoder.write(chunk) }));
	for (const stream of [relay.stdin!, sizes]) stream.on("error", () => {});
	relay.on("error", (error) => {
		send({ error: `the terminal couldn't start: ${error.message}` });
		ws.close();
	});
	relay.on("close", (code) => {
		send({ exitCode: code ?? 0 });
		ws.close();
	});
	ws.on("message", (raw) => {
		try {
			const m = JSON.parse(String(raw)) as { data?: unknown; cols?: unknown; rows?: unknown };
			if (typeof m.data === "string") {
				relay.stdin!.write(m.data);
				options.onInput?.();
			}
			if (typeof m.cols === "number" && typeof m.rows === "number") sizes.write(`${Math.min(500, Math.round(m.cols))} ${Math.min(200, Math.round(m.rows))}\n`);
		} catch {}
	});
	ws.on("close", () => {
		relay.stdin!.end();
		if (relay.exitCode === null) relay.kill("SIGTERM");
	});
}
