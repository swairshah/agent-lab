// Builds three bundles into dist/: the CLI, the session server (copied to each VM, so it carries all its
// dependencies), and the web view.
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
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
await Promise.all([
	build({ ...node, entryPoints: ["src/server/main.ts"], outfile: "dist/server.mjs" }),
	build({ ...node, entryPoints: ["src/server/relay.ts"], outfile: "dist/relay.mjs" }),
	// pi-env stays a package import in the CLI: it finds its daemon binaries relative to itself.
	build({
		...node,
		entryPoints: ["src/cli/main.ts"],
		outfile: "dist/cli.mjs",
		external: [...node.external, "@earendil-works/pi-env"],
		banner: { js: `#!/usr/bin/env node\n${node.banner.js}` },
	}),
	build({ entryPoints: ["src/web/app.ts"], outfile: "dist/web/app.js", bundle: true, format: "esm", target: "es2022", minify: true, logLevel: "warning" }),
]);
copyFileSync("src/web/index.html", "dist/web/index.html");
copyFileSync("src/web/style.css", "dist/web/style.css");
chmodSync("dist/cli.mjs", 0o755);
console.log("built dist/cli.mjs, dist/server.mjs, dist/relay.mjs, dist/web/");
