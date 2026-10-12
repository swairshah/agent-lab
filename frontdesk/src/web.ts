import { spawn } from "node:child_process";
import { dbPath, host, port, token, voiceModel } from "./config.ts";
import { setReportSink } from "./delegation.ts";
import { context, openSession } from "./harness.ts";
import { openSse, readBody, type Route, sendJson, startInspector } from "./inspector.ts";
import { VoiceBridge } from "./voice.ts";

const session = await openSession();
const bridge = new VoiceBridge(session);
setReportSink({ kind: "voice", deliver: (report) => bridge.deliver(report) });

const voiceRoutes: Route = async (req, res, url) => {
	if (url.pathname === "/api/voice/session" && req.method === "POST") {
		if (!process.env.OPENAI_API_KEY) {
			sendJson(res, 400, { error: "OPENAI_API_KEY is not set" });
			return true;
		}
		try {
			const answer = await bridge.start(await readBody(req));
			res.writeHead(200, { "content-type": "application/sdp" });
			res.end(answer);
		} catch (error) {
			sendJson(res, 502, { error: String((error as Error).message ?? error) });
		}
		return true;
	}
	if (url.pathname === "/api/voice/hangup" && req.method === "POST") {
		await bridge.hangup();
		sendJson(res, 200, { ok: true });
		return true;
	}
	if (url.pathname === "/api/voice/events") {
		let unsubscribe = () => {};
		const send = openSse(req, res, () => unsubscribe());
		unsubscribe = bridge.subscribe((event) => send("voice", event));
		return true;
	}
	return false;
};

const server = await startInspector({ session, frontend: "voice", port, routes: [voiceRoutes] });
session.harness.resume();

const url = `http://localhost:${port}/${token === "" ? "" : `?token=${encodeURIComponent(token)}`}`;
console.log(`frontdesk · voice · ${voiceModel}`);
console.log(`session ${dbPath}`);
console.log(`open ${url}`);
if (host !== "127.0.0.1") console.log(`listening on ${host}:${port} for the iOS app (bearer token required)`);
if (process.env.FRONTDESK_NO_OPEN !== "1") {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const shutdown = async () => {
	await bridge.hangup();
	server.close();
	await session.harness.close(context);
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
