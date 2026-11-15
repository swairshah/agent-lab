// Builds the lab's page into dist/: its script (Preact, bundled by esbuild), and one stylesheet made of the base (the
// app's tokens and building blocks), each element's own view.css, and the lab's layout, in that order.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/lab/web/main.tsx"], bundle: true, format: "esm", target: "es2022", outfile: "dist/main.js", sourcemap: true, jsx: "automatic", jsxImportSource: "preact", loader: { ".svg": "text" }, logLevel: "warning" });
const elements = readdirSync("src/elements", { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(`src/elements/${d.name}/view.css`)).map((d) => `src/elements/${d.name}/view.css`);
writeFileSync("dist/style.css", ["src/ui/base.css", "src/ui/chat.css", ...elements, "src/lab/web/lab.css"].map((file) => `/* ${file} */\n${readFileSync(file, "utf8")}`).join("\n"));
cpSync("src/lab/web/index.html", "dist/index.html");
