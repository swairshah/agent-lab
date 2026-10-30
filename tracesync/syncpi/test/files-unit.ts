// The project file list for a folder that isn't a git repository: its .gitignore files apply, as git applies them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ignored, listFiles, parseIgnore } from "../src/shared/files.ts";

test("patterns match as in git", () => {
	const rules = parseIgnore("out/\n*.log\n# a comment\n/top.txt\ndocs/**/draft.md\n!keep.log\n", "");
	assert.equal(ignored("out", true, rules), true);
	assert.equal(ignored("out", false, rules), false, "a folder pattern doesn't match a file");
	assert.equal(ignored("a/b/out", true, rules), true, "a name matches at any depth");
	assert.equal(ignored("x/debug.log", false, rules), true);
	assert.equal(ignored("keep.log", false, rules), false, "a later ! rule un-ignores");
	assert.equal(ignored("top.txt", false, rules), true);
	assert.equal(ignored("sub/top.txt", false, rules), false, "a leading / anchors to the file's folder");
	assert.equal(ignored("docs/a/b/draft.md", false, rules), true);
	assert.equal(ignored("docs/draft.md", false, rules), true, "**/ can be no folders at all");
});

test("a nested .gitignore applies below its folder only", () => {
	const rules = parseIgnore("*.bin\n", "pkg/");
	assert.equal(ignored("pkg/model.bin", false, rules), true);
	assert.equal(ignored("model.bin", false, rules), false);
});

test("a plain folder's files leave out what its .gitignore files ignore", async () => {
	const root = mkdtempSync(join(tmpdir(), "syncpi-files-"));
	try {
		const write = (path: string, text = "x") => {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		};
		write(".gitignore", "out/\n*.log\n");
		write("README.md");
		write("out/smoke/model.safetensors");
		write("run.log");
		write("pkg/.gitignore", "cache/\n");
		write("pkg/index.ts");
		write("pkg/cache/blob");
		write("node_modules/x/index.js");
		assert.deepEqual(await listFiles(root), [".gitignore", "README.md", "pkg/.gitignore", "pkg/index.ts"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
