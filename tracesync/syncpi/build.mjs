// Builds three bundles into dist/: the CLI, the session server (copied to each VM, so it carries all its
// dependencies), and the web view.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

const node = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["bufferutil", "utf-8-validate"],
	// Bundled CommonJS dependencies (ws) still call require().
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	logLevel: "warning",
};

mkdirSync("dist/web", { recursive: true });
mkdirSync("dist/desktop", { recursive: true });
mkdirSync("dist/desktop-session", { recursive: true });
await Promise.all([
    build({ entryPoints: ["src/desktop/session/app.ts"], outfile: "dist/desktop-session/app.js", bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "warning" }),
    build({ ...node, entryPoints: ["src/desktop/host.ts"], outfile: "dist/desktop-host.mjs", external: [...node.external, "node-pty", "@earendil-works/pi-env", "@earendil-works/pi-coding-agent"] }),
    build({ ...node, entryPoints: ["src/desktop/context.ts"], outfile: "dist/pi-context.mjs", external: [...node.external, "@earendil-works/pi-coding-agent"] }),
    build({ entryPoints: ["src/desktop/app.ts"], outfile: "dist/desktop/app.js", bundle: true, format: "esm", target: "es2022", logLevel: "warning" }),
	build({ ...node, entryPoints: ["src/server/main.ts"], outfile: "dist/server.mjs" }),
	build({ ...node, entryPoints: ["src/server/relay.ts"], outfile: "dist/relay.mjs" }),
	// pi-env stays a package import in the CLI: it finds its daemon binaries relative to itself.
	build({
		...node,
		entryPoints: ["src/cli/main.ts"],
		outfile: "dist/cli.mjs",
		external: [...node.external, "@earendil-works/pi-env", "@earendil-works/pi-coding-agent"],
		banner: { js: `#!/usr/bin/env node\n${node.banner.js}` },
	}),
	// The web view. Split so the artifact renderers (Pierre, Shiki and its grammars) load only when an artifact is
	// shown; chunk names stay flat so the server's static route serves them.
	build({
		entryPoints: ["src/web/main.ts"],
		outdir: "dist/web",
		entryNames: "[name]",
		chunkNames: "[name]-[hash]",
		splitting: true,
		bundle: true,
		format: "esm",
		target: "es2022",
		minify: true,
		loader: { ".svg": "text" },
		logLevel: "warning",
	}),
]);
copyFileSync("src/web/index.html", "dist/web/index.html");
copyFileSync("src/web/style.css", "dist/web/style.css");
chmodSync("dist/cli.mjs", 0o755);
console.log("built dist/cli.mjs, dist/server.mjs, dist/relay.mjs, dist/web/");

copyFileSync("src/desktop/index.html", "dist/desktop/index.html");
copyFileSync("src/desktop/style.css", "dist/desktop/style.css");
copyFileSync("node_modules/@xterm/xterm/css/xterm.css", "dist/desktop/xterm.css");

for (const arch of ["darwin-arm64", "darwin-x64"]) {
 const helper = `node_modules/node-pty/prebuilds/${arch}/spawn-helper`;
 if (existsSync(helper)) chmodSync(helper, 0o755);
}

copyFileSync("src/desktop/session/index.html", "dist/desktop-session/index.html");
copyFileSync("src/desktop/session/style.css", "dist/desktop-session/style.css");
