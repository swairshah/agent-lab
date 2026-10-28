// The program pi-env's Connection starts on the server instead of `ssh host pi-env`: `node relay.mjs <socket>
// <secret> <memberId> serve --token <hex>`. It hands its stdin and stdout to the session server over a local socket, and the
// server tunnels them to that member's terminal client, which runs the pi-env daemon on their machine. pi-env's
// protocol is end to end; this only moves bytes.
import { connect } from "node:net";

const [socketPath, secret, memberId, ...args] = process.argv.slice(2);
if (socketPath === undefined || secret === undefined || memberId === undefined) {
	process.stderr.write("usage: relay <socket> <secret> <memberId> serve --token <hex>\n");
	process.exit(2);
}

const socket = connect(socketPath, () => {
	socket.write(`${JSON.stringify({ secret, memberId, args })}\n`);
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
});
socket.on("error", (error) => {
	process.stderr.write(`relay: ${error.message}\n`);
	process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
