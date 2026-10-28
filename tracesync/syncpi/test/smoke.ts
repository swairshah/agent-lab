// End-to-end check on this machine, no VM and no model keys: a local session server with the scripted model, an owner
// and a collaborator as headless clients, each with their own ~/.syncpi.
//   1. the owner starts a session for a small git project; it opens at once and is created in the background
//   2. /session-share gives a link; the collaborator joins with --url and gets the project in ~/.syncpi/projects
//   3. both see each other's messages; a file the agent writes reaches both local copies
//   4. a file the collaborator edits locally reaches the owner's folder
//   5. each request runs on its sender's machine, or the server with /vm
//   6. the owner leaves and comes back: the same session, the same thread
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "dist", "cli.mjs");
const root = mkdtempSync(join(tmpdir(), "syncpi-smoke-"));
const project = join(root, "demo");
execFileSync("mkdir", ["-p", project]);
writeFileSync(join(project, "README.md"), "# demo\n");
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["add", "."], { cwd: project });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: project });

type Client = { proc: ChildProcessWithoutNullStreams; lines: string[]; name: string };
/** Every client started, so the cleanup stops them all and the test can exit. */
const clients: Client[] = [];

function client(name: string, home: string, cwd: string, args: string[]): Client {
	const proc = spawn(process.execPath, [cli, "--headless", "--name", name, ...args], { cwd, env: { ...process.env, SYNCPI_HOME: home } });
	const c: Client = { proc, lines: [], name };
	clients.push(c);
	let buf = "";
	proc.stdout.on("data", (d) => {
		buf += d;
		const parts = buf.split("\n");
		buf = parts.pop()!;
		for (const line of parts) {
			c.lines.push(line);
			if (process.env.VERBOSE) console.log(`  ${name}> ${line}`);
		}
	});
	proc.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`  ${name}! ${d}`));
	return c;
}

async function waitFor(what: string, check: () => boolean | string | undefined, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const saw = (c: Client, text: string) => () => c.lines.some((l) => l.includes(text));
const say = (c: Client, text: string) => c.proc.stdin.write(`${text}\n`);
let step = 0;
const ok = (text: string) => console.log(`✓ ${++step}. ${text}`);

const ownerHome = join(root, "home-owner");
const bobHome = join(root, "home-bob");
let owner = client("ada", ownerHome, project, ["--faux"]);
let bob: Client | undefined;
try {
	// Typed before the server exists: the UI is up at once and the message waits for the connection.
	say(owner, "typed while the session was being created");
	await waitFor("setup progress", saw(owner, "setup "), 30_000);
	await waitFor("owner connected", saw(owner, "connection open"), 60_000);
	await waitFor("setup agent", saw(owner, "env ready"));
	await waitFor("early message answered", saw(owner, "agent: (faux) typed while the session was being created"));
	ok("the session opened at once, was created in the background, and the early message was delivered");

	say(owner, "/session-share");
	await waitFor("share link", saw(owner, "share "));
	const url = owner.lines.find((l) => l.startsWith("share "))!.split(" ")[1]!;
	bob = client("bob", bobHome, root, ["--url", url]);
	await waitFor("bob connected", saw(bob, "connection open"), 30_000);
	const bobDir = join(bobHome, "projects", "demo");
	if (!existsSync(join(bobDir, "README.md")) || !existsSync(join(bobDir, ".git"))) throw new Error("bob's checkout is missing files");
	await waitFor("join notice", saw(owner, "-- bob joined the session"));
	ok(`bob joined from ${url} and got a checkout in ~/.syncpi/projects/demo`);

	say(bob, "hello from bob");
	await waitFor("owner sees bob", saw(owner, "[bob] hello from bob"));
	await waitFor("bob sees the answer", saw(bob, "agent: (faux) hello from bob"));
	ok("messages are attributed and both sides see the agent's answer");

	say(owner, "write src/hello.txt written by the agent");
	await waitFor("agent wrote", saw(owner, "tool write src/hello.txt -> done"));
	await waitFor("owner pulled", () => existsSync(join(project, "src/hello.txt")));
	await waitFor("bob pulled", () => existsSync(join(bobDir, "src/hello.txt")));
	if (readFileSync(join(bobDir, "src/hello.txt"), "utf8") !== "written by the agent") throw new Error("wrong content");
	ok("a file the agent wrote on the server reached both local folders");

	writeFileSync(join(bobDir, "NOTES.md"), "bob's notes\n");
	await waitFor("owner got bob's file", () => existsSync(join(project, "NOTES.md")) && readFileSync(join(project, "NOTES.md"), "utf8") === "bob's notes\n");
	writeFileSync(join(project, "README.md"), "# demo\n\nedited by ada\n");
	await waitFor("bob got ada's edit", () => readFileSync(join(bobDir, "README.md"), "utf8").includes("edited by ada"));
	ok("local edits on either side reach the other side");

	say(owner, "run cat NOTES.md");
	await waitFor("agent read bob's file", saw(bob, "tool bash cat NOTES.md -> done"));
	ok("the agent sees files a collaborator edited locally");

	// Each person's request runs on their own machine; "/vm" sends one to the session's server instead.
	say(owner, "run pwd > where-ada.txt");
	say(bob, "run pwd > where-bob.txt");
	say(bob, "/vm run pwd > where-vm.txt");
	const read = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim() : "");
	await waitFor("all three ran and synced to ada", () => ["where-ada.txt", "where-bob.txt", "where-vm.txt"].every((f) => read(project, f) !== ""), 30_000);
	await waitFor("and to bob", () => ["where-ada.txt", "where-bob.txt", "where-vm.txt"].every((f) => read(bobDir, f) !== ""), 10_000);
	const where = { ada: read(project, "where-ada.txt"), bob: read(project, "where-bob.txt"), vm: read(project, "where-vm.txt") };
	if (where.ada !== realpathSync(project)) throw new Error(`ada's request ran in ${where.ada}`);
	if (where.bob !== realpathSync(bobDir)) throw new Error(`bob's request ran in ${where.bob}`);
	if (!where.vm.includes(join("local", "")) || where.vm === where.ada) throw new Error(`the /vm request ran in ${where.vm}`);
	ok("requests run on the sender's own machine (or the server with /vm), and the results reach everyone");

	// Roles and people: a viewer reads only; an admin promotes, renames, revokes and removes.
	const shareLines = () => owner.lines.filter((l) => l.startsWith("share ")).length;
	let before = shareLines();
	say(owner, "/invite viewer 1d");
	await waitFor("viewer link", () => shareLines() > before);
	const viewerUrl = owner.lines.filter((l) => l.startsWith("share "))[before]!.split(" ")[1]!;
	const carolHome = join(root, "home-carol");
	const carol = client("carol", carolHome, root, ["--url", viewerUrl]);
	await waitFor("carol joined", saw(carol, "welcome carol viewer"), 30_000);
	say(carol, "can I talk?");
	await waitFor("viewer refused", saw(carol, "error viewers can't talk to the agent"));
	writeFileSync(join(carolHome, "projects", "demo", "CAROL.md"), "from a viewer\n");
	say(bob, "/invite");
	await waitFor("editor can't invite", saw(bob, "error only admins can invite people"));
	say(owner, "/role carol editor");
	await waitFor("carol promoted", saw(carol, "carol:editor"));
	await waitFor("viewer edit never synced, promoted edits do", () => existsSync(join(project, "CAROL.md")), 15_000);
	say(carol, "hello as an editor");
	await waitFor("carol talks now", saw(owner, "[carol] hello as an editor"));
	say(owner, "/name Ada L");
	await waitFor("rename seen", saw(bob, "Ada L:admin"));
	say(owner, "/remove carol");
	await waitFor("carol removed", saw(carol, "removed"));
	await waitFor("carol gone from members", () => owner.lines.some((l) => l.startsWith("members ") && !l.includes("carol")));
	say(owner, "/links");
	await waitFor("invite list", saw(owner, "invites "));
	const code = viewerUrl.split("/s/")[1]!;
	say(owner, `/revoke ${code}`);
	await waitFor("revoked", () => owner.lines.filter((l) => l.startsWith("invites ")).some((l) => !l.includes(code)));
	const sessionUrl = viewerUrl.split("/s/")[0]!;
	const revoked = await fetch(`${sessionUrl}/api/join`, { method: "POST", body: JSON.stringify({ invite: code, name: "mallory" }) });
	if (revoked.status !== 403) throw new Error(`revoked link still works: ${revoked.status}`);
	ok("viewers read only; admins promote, rename, remove and revoke; editors can't invite");

	// Email invites, with exe.dev's sign-in simulated by the header its proxy adds.
	before = shareLines();
	say(owner, "/invite dave@example.com");
	await waitFor("email invite", () => shareLines() > before);
	const emailCode = owner.lines.filter((l) => l.startsWith("share "))[before]!.split(" ")[1]!.split("/s/")[1]!;
	const post = (path: string, body: unknown, email?: string, extra: Record<string, string> = {}) =>
		fetch(`${sessionUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(email ? { "x-exedev-email": email } : {}), ...extra }, body: JSON.stringify(body) });
	const anonymous = await post("/api/join", { invite: emailCode, name: "dave" });
	if (anonymous.status !== 401) throw new Error(`email invite without sign-in: ${anonymous.status}`);
	const wrong = await post("/api/join", { invite: emailCode, name: "dave" }, "eve@example.com");
	if (wrong.status !== 403) throw new Error(`email invite with the wrong account: ${wrong.status}`);
	// The terminal flow: the CLI asks for a code, the browser (signed in as dave) approves it, the CLI collects a token.
	const start = (await (await post("/api/cli-login", { invite: emailCode, name: "dave" })).json()) as { code: string; check: string };
	const page = await fetch(`${sessionUrl}/cli-login/${start.code}`, { headers: { "x-exedev-email": "dave@example.com" } });
	if (!(await page.text()).includes(start.check)) throw new Error("approval page doesn't show the check code");
	const crossSite = await fetch(`${sessionUrl}/cli-login/${start.code}`, { method: "POST", headers: { "x-exedev-email": "dave@example.com", origin: "https://evil.example" } });
	if (crossSite.status !== 403) throw new Error("a cross-site form approved a sign-in");
	await fetch(`${sessionUrl}/cli-login/${start.code}`, { method: "POST", headers: { "x-exedev-email": "dave@example.com", origin: new URL(sessionUrl).origin } });
	const poll = (await (await fetch(`${sessionUrl}/api/cli-login/${start.code}`)).json()) as { status: string; token?: string };
	if (poll.status !== "approved" || !poll.token) throw new Error(`terminal sign-in not approved: ${poll.status}`);
	// The same person signing in from a browser later is the same member, with a token of its own.
	const browser = (await (await post("/api/exe-login", {}, "dave@example.com")).json()) as { token?: string };
	const infoA = (await (await fetch(`${sessionUrl}/api/info`, { headers: { authorization: `Bearer ${poll.token}` } })).json()) as { me: { id: string } };
	const infoB = (await (await fetch(`${sessionUrl}/api/info`, { headers: { authorization: `Bearer ${browser.token}` } })).json()) as { me: { id: string } };
	if (infoA.me.id !== infoB.me.id) throw new Error("terminal and browser sign-ins became different members");
	const stranger = await post("/api/exe-login", {}, "eve@example.com");
	if (stranger.status !== 403) throw new Error("a non-member signed in");
	// Removed, dave can't use his invite again or sign back in.
	say(owner, "/remove dave");
	await waitFor("dave removed", () => owner.lines.some((l) => l.startsWith("members ") && !l.includes("dave")));
	const rejoin = await post("/api/join", { invite: emailCode, name: "dave" }, "dave@example.com");
	const relogin = await post("/api/exe-login", {}, "dave@example.com");
	if (rejoin.status !== 403 || relogin.status !== 403) throw new Error(`a removed member got back in: ${rejoin.status} ${relogin.status}`);
	const oldToken = await fetch(`${sessionUrl}/api/info`, { headers: { authorization: `Bearer ${poll.token}` } });
	if (oldToken.status !== 401) throw new Error("a removed member's token still works");
	ok("email invites need the matching exe.dev sign-in, in a browser or a terminal (approved with a code)");

	// Context: /compact summarizes, /tree branches and switches back, /new starts over; branch and new are for admins.
	say(owner, "/compact");
	await waitFor("summary", saw(owner, "-- older messages were summarized"), 30_000);
	say(bob, "/new");
	await waitFor("editor can't /new", saw(bob, "error only admins can start a new context"));
	say(owner, "/tree 1");
	await waitFor("branched", saw(bob, "branches current=1 main,branch 1"));
	say(owner, "said on the branch");
	await waitFor("branch answer", saw(bob, "agent: (faux) said on the branch"));
	say(owner, "/tree b0");
	await waitFor("back on main", () => bob.lines.filter((l) => l.startsWith("branches current=0")).length >= 2);
	say(owner, "/new");
	await waitFor("new context", saw(bob, "-- new context: the agent no longer sees the messages above"));
	ok("/compact summarizes, /tree branches and switches back for everyone, /new starts a new context");

	say(owner, "/quit");
	await waitFor("owner left", saw(owner, "done demo"));
	await waitFor("owner exited", () => owner.proc.exitCode !== null);
	owner = client("ada", ownerHome, project, []);
	await waitFor("owner back", saw(owner, "[bob] hello from bob"), 30_000);
	ok("rerunning syncpi in the folder rejoins the same session and thread");
} finally {
	for (const c of clients) if (c.proc.exitCode === null) c.proc.stdin.end("/quit\n");
	await new Promise((r) => setTimeout(r, 2_500));
	for (const c of clients) c.proc.kill();
	try {
		execFileSync(process.execPath, [cli, "rm"], { cwd: project, env: { ...process.env, SYNCPI_HOME: ownerHome }, stdio: "ignore" });
	} catch {}
}
console.log(`smoke passed (${root})`);
