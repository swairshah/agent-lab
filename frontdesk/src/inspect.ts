import { dbPath, port } from "./config.ts";
import { context, openSession } from "./harness.ts";
import { startInspector } from "./inspector.ts";

const session = await openSession();
const server = await startInspector({ session, frontend: "none", port });
console.log(`session ${dbPath}`);
console.log(`inspector http://localhost:${port} (read-only: no frontend, unfinished work is not resumed)`);

process.on("SIGINT", async () => {
	server.close();
	await session.harness.close(context);
	process.exit(0);
});
