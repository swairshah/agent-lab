// Builds the lab's page into dist/: its script (Preact, bundled by esbuild) and its static files.
import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/lab/web/main.tsx"], bundle: true, format: "esm", target: "es2022", outfile: "dist/main.js", sourcemap: true, jsx: "automatic", jsxImportSource: "preact", logLevel: "warning" });
for (const file of ["index.html", "style.css"]) cpSync(`src/lab/web/${file}`, `dist/${file}`);
