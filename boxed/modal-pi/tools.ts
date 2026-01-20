/**
 * Modal sandbox tools for pi-agent.
 * Provides tools that proxy to a Modal sandbox for isolated execution.
 *
 * NOTE: These tools execute commands in a REMOTE Modal sandbox (cloud container),
 * not on the local machine. This provides secure, isolated execution.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Sandbox } from "modal";

// Helper to quote shell arguments safely
function quoteShell(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// Helper to create text response
function textResponse(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
	};
}

// Helper to create error response
function errorResponse(message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { error: true },
	};
}

/**
 * Execute a command in the REMOTE Modal sandbox and return output + return code.
 * This runs in an isolated cloud container, NOT on the local machine.
 */
async function runCmd(sandbox: Sandbox, cmd: string, timeout = 120000): Promise<{ output: string; returncode: number }> {
	try {
		const process = await sandbox.exec(["bash", "-c", cmd], { timeoutMs: timeout });
		let stdout = "";
		let stderr = "";

		// Read stdout
		for await (const chunk of process.stdout) {
			stdout += chunk;
		}

		// Read stderr
		for await (const chunk of process.stderr) {
			stderr += chunk;
		}

		const exitCode = await process.wait();
		return { output: stdout + stderr, returncode: exitCode };
	} catch (e) {
		return { output: String(e), returncode: 1 };
	}
}

/**
 * Execute a command with stdin data in the REMOTE Modal sandbox.
 */
async function runCmdStdin(
	sandbox: Sandbox,
	cmd: string,
	stdinData: string,
	timeout = 120000,
): Promise<{ output: string; returncode: number }> {
	// Use heredoc to pass stdin data
	const fullCmd = `cat <<'__EOF__' | ${cmd}\n${stdinData}\n__EOF__`;
	return runCmd(sandbox, fullCmd, timeout);
}

// Tool schemas
const readSchema = Type.Object({
	file_path: Type.String({ description: "Absolute path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (0-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Number of lines to read (default 2000)" })),
});

const writeSchema = Type.Object({
	file_path: Type.String({ description: "Absolute path to the file to write" }),
	content: Type.String({ description: "Content to write to the file" }),
});

const editSchema = Type.Object({
	file_path: Type.String({ description: "Absolute path to the file to edit" }),
	old_string: Type.String({ description: "Text to find and replace" }),
	new_string: Type.String({ description: "Text to replace with" }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default false)" })),
});

const globSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (default '.')" })),
});

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	path: Type.Optional(Type.String({ description: "File or directory to search in (default '.')" })),
	include: Type.Optional(Type.String({ description: "File pattern to include (e.g., '*.ts')" })),
});

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 120000)" })),
});

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory path to list (default '.')" })),
	all: Type.Optional(Type.Boolean({ description: "Show hidden files (default false)" })),
});

/**
 * Create all Modal sandbox tools for the agent.
 */
export function createModalTools(sandbox: Sandbox): AgentTool<any>[] {
	const readTool: AgentTool<typeof readSchema> = {
		name: "Read",
		label: "Read File",
		description: "Read file contents from the Modal sandbox",
		parameters: readSchema,
		execute: async (_toolCallId, { file_path, offset = 0, limit = 2000 }) => {
			try {
				let cmd: string;
				if (offset > 0 || limit < 2000) {
					cmd = `sed -n '${offset + 1},${offset + limit}p' ${quoteShell(file_path)} | cat -n`;
				} else {
					cmd = `cat -n ${quoteShell(file_path)}`;
				}

				const { output, returncode } = await runCmd(sandbox, cmd);

				if (returncode !== 0) {
					return errorResponse(`Failed to read file: ${output}`);
				}

				return textResponse(output);
			} catch (e) {
				return errorResponse(`Read error: ${e}`);
			}
		},
	};

	const writeTool: AgentTool<typeof writeSchema> = {
		name: "Write",
		label: "Write File",
		description: "Write content to a file in the Modal sandbox",
		parameters: writeSchema,
		execute: async (_toolCallId, { file_path, content }) => {
			try {
				// Create parent directory if needed
				const parentDir = file_path.substring(0, file_path.lastIndexOf("/"));
				if (parentDir) {
					await runCmd(sandbox, `mkdir -p ${quoteShell(parentDir)}`);
				}

				const { output, returncode } = await runCmdStdin(sandbox, `cat > ${quoteShell(file_path)}`, content);

				if (returncode !== 0) {
					return errorResponse(`Failed to write file: ${output}`);
				}

				return textResponse(`Successfully wrote to ${file_path}`);
			} catch (e) {
				return errorResponse(`Write error: ${e}`);
			}
		},
	};

	const editTool: AgentTool<typeof editSchema> = {
		name: "Edit",
		label: "Edit File",
		description: "Perform search-and-replace edits in a file",
		parameters: editSchema,
		execute: async (_toolCallId, { file_path, old_string, new_string, replace_all = false }) => {
			try {
				// Read the file
				const { output: content, returncode: rc } = await runCmd(sandbox, `cat ${quoteShell(file_path)}`);
				if (rc !== 0) {
					return errorResponse(`Failed to read file: ${content}`);
				}

				if (!content.includes(old_string)) {
					return errorResponse(`old_string not found in ${file_path}`);
				}

				let newContent: string;
				let count: number;

				if (replace_all) {
					newContent = content.split(old_string).join(new_string);
					count = content.split(old_string).length - 1;
				} else {
					newContent = content.replace(old_string, new_string);
					count = 1;
				}

				const { output, returncode } = await runCmdStdin(sandbox, `cat > ${quoteShell(file_path)}`, newContent);

				if (returncode !== 0) {
					return errorResponse(`Failed to write file: ${output}`);
				}

				return textResponse(`Replaced ${count} occurrence(s) in ${file_path}`);
			} catch (e) {
				return errorResponse(`Edit error: ${e}`);
			}
		},
	};

	const globTool: AgentTool<typeof globSchema> = {
		name: "Glob",
		label: "Find Files",
		description: "Find files matching a glob pattern",
		parameters: globSchema,
		execute: async (_toolCallId, { pattern, path = "." }) => {
			try {
				const cmd = `cd ${quoteShell(path)} && find . -type f -name ${quoteShell(pattern)} 2>/dev/null | head -100`;
				const { output } = await runCmd(sandbox, cmd);

				const files = output
					.trim()
					.split("\n")
					.filter((f) => f);

				return textResponse(`Found ${files.length} files:\n${files.join("\n")}`);
			} catch (e) {
				return errorResponse(`Glob error: ${e}`);
			}
		},
	};

	const grepTool: AgentTool<typeof grepSchema> = {
		name: "Grep",
		label: "Search Files",
		description: "Search file contents using regex patterns",
		parameters: grepSchema,
		execute: async (_toolCallId, { pattern, path = ".", include }) => {
			try {
				let cmd = `grep -rn ${quoteShell(pattern)} ${quoteShell(path)}`;
				if (include) {
					cmd = `grep -rn --include=${quoteShell(include)} ${quoteShell(pattern)} ${quoteShell(path)}`;
				}
				cmd += " 2>/dev/null | head -50";

				const { output } = await runCmd(sandbox, cmd);

				if (!output.trim()) {
					return textResponse(`No matches found for pattern: ${pattern}`);
				}

				return textResponse(output);
			} catch (e) {
				return errorResponse(`Grep error: ${e}`);
			}
		},
	};

	const bashTool: AgentTool<typeof bashSchema> = {
		name: "Bash",
		label: "Run Command",
		description: "Execute a bash command in the Modal sandbox",
		parameters: bashSchema,
		execute: async (_toolCallId, { command, timeout = 120000 }) => {
			try {
				const { output, returncode } = await runCmd(sandbox, command, timeout);

				let result = output || "(no output)";
				if (returncode !== 0) {
					result += `\n[exit code: ${returncode}]`;
				}

				return textResponse(result);
			} catch (e) {
				return errorResponse(`Bash error: ${e}`);
			}
		},
	};

	const lsTool: AgentTool<typeof lsSchema> = {
		name: "LS",
		label: "List Directory",
		description: "List directory contents",
		parameters: lsSchema,
		execute: async (_toolCallId, { path = ".", all = false }) => {
			try {
				const cmd = all ? `ls -la ${quoteShell(path)}` : `ls -l ${quoteShell(path)}`;
				const { output, returncode } = await runCmd(sandbox, cmd);

				if (returncode !== 0) {
					return errorResponse(`Failed to list directory: ${output}`);
				}

				return textResponse(output);
			} catch (e) {
				return errorResponse(`LS error: ${e}`);
			}
		},
	};

	return [readTool, writeTool, editTool, globTool, grepTool, bashTool, lsTool];
}
