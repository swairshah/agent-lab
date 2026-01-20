"""Tool provider for Modal sandbox operations."""

import os
from typing import Any

import modal

from claude_agent_sdk import tool, create_sdk_mcp_server
from utils import quote_shell, text_response, error_response


class ModalToolProvider:
    """Provides Claude tools that proxy to a Modal sandbox."""

    def __init__(self, sandbox: modal.Sandbox):
        self.sandbox = sandbox

    def _run_cmd(self, cmd: str, timeout: int = 120) -> tuple[str, int]:
        """Execute a command via sandbox.exec and return (output, returncode)."""
        try:
            p = self.sandbox.exec("bash", "-c", cmd, timeout=timeout)
            stdout = p.stdout.read()
            stderr = p.stderr.read()
            output = stdout + stderr
            p.wait()
            return output, p.returncode or 0
        except Exception as e:
            return str(e), 1

    def _run_cmd_stdin(self, cmd: str, stdin_data: str, timeout: int = 120) -> tuple[str, int]:
        """Execute a command with stdin via sandbox.exec."""
        try:
            full_cmd = f"cat <<'__EOF__' | {cmd}\n{stdin_data}\n__EOF__"
            p = self.sandbox.exec("bash", "-c", full_cmd, timeout=timeout)
            stdout = p.stdout.read()
            stderr = p.stderr.read()
            output = stdout + stderr
            p.wait()
            return output, p.returncode or 0
        except Exception as e:
            return str(e), 1

    def create_mcp_server(self):
        """Create an MCP server with all tools proxied to the Modal sandbox."""
        return create_sdk_mcp_server(
            name="modal",
            version="1.0.0",
            tools=[
                self._create_read_tool(),
                self._create_write_tool(),
                self._create_edit_tool(),
                self._create_glob_tool(),
                self._create_grep_tool(),
                self._create_bash_tool(),
                self._create_notebook_edit_tool(),
                self._create_ls_tool(),
            ],
        )

    def _create_read_tool(self):
        @tool(
            "Read",
            "Read file contents from the workspace. Supports text files.",
            {"file_path": str, "offset": int, "limit": int},
        )
        async def read_file(args: dict[str, Any]) -> dict[str, Any]:
            file_path = args["file_path"]
            offset = args.get("offset", 0)
            limit = args.get("limit", 2000)

            try:
                if offset > 0 or limit < 2000:
                    cmd = f"sed -n '{offset + 1},{offset + limit}p' {quote_shell(file_path)} | cat -n"
                else:
                    cmd = f"cat -n {quote_shell(file_path)}"

                output, rc = self._run_cmd(cmd)

                if rc != 0:
                    return error_response(f"Failed to read file: {output}")

                return text_response(output)
            except Exception as e:
                return error_response(f"Read error: {e}")

        return read_file

    def _create_write_tool(self):
        @tool(
            "Write",
            "Write content to a file. Creates the file if it doesn't exist.",
            {"file_path": str, "content": str},
        )
        async def write_file(args: dict[str, Any]) -> dict[str, Any]:
            file_path = args["file_path"]
            content = args["content"]

            try:
                parent_dir = os.path.dirname(file_path)
                if parent_dir:
                    self._run_cmd(f"mkdir -p {quote_shell(parent_dir)}")

                output, rc = self._run_cmd_stdin(f"cat > {quote_shell(file_path)}", content)

                if rc != 0:
                    return error_response(f"Failed to write file: {output}")

                return text_response(f"Successfully wrote to {file_path}")
            except Exception as e:
                return error_response(f"Write error: {e}")

        return write_file

    def _create_edit_tool(self):
        @tool(
            "Edit",
            "Perform search-and-replace edits in a file.",
            {"file_path": str, "old_string": str, "new_string": str, "replace_all": bool},
        )
        async def edit_file(args: dict[str, Any]) -> dict[str, Any]:
            file_path = args["file_path"]
            old_string = args["old_string"]
            new_string = args["new_string"]
            replace_all = args.get("replace_all", False)

            try:
                content, rc = self._run_cmd(f"cat {quote_shell(file_path)}")
                if rc != 0:
                    return error_response(f"Failed to read file: {content}")

                if old_string not in content:
                    return error_response(f"old_string not found in {file_path}")

                if replace_all:
                    new_content = content.replace(old_string, new_string)
                    count = content.count(old_string)
                else:
                    new_content = content.replace(old_string, new_string, 1)
                    count = 1

                output, rc = self._run_cmd_stdin(f"cat > {quote_shell(file_path)}", new_content)

                if rc != 0:
                    return error_response(f"Failed to write file: {output}")

                return text_response(f"Replaced {count} occurrence(s) in {file_path}")
            except Exception as e:
                return error_response(f"Edit error: {e}")

        return edit_file

    def _create_glob_tool(self):
        @tool(
            "Glob",
            "Find files matching a glob pattern.",
            {"pattern": str, "path": str},
        )
        async def glob_files(args: dict[str, Any]) -> dict[str, Any]:
            pattern = args["pattern"]
            path = args.get("path", ".")

            try:
                cmd = f"cd {quote_shell(path)} && find . -type f -name {quote_shell(pattern)} 2>/dev/null | head -100"
                output, rc = self._run_cmd(cmd)

                files = output.strip().split("\n")
                files = [f for f in files if f]

                return text_response(f"Found {len(files)} files:\n" + "\n".join(files))
            except Exception as e:
                return error_response(f"Glob error: {e}")

        return glob_files

    def _create_grep_tool(self):
        @tool(
            "Grep",
            "Search file contents using regex patterns.",
            {"pattern": str, "path": str, "include": str},
        )
        async def grep_files(args: dict[str, Any]) -> dict[str, Any]:
            pattern = args["pattern"]
            path = args.get("path", ".")
            include = args.get("include", "")

            try:
                cmd = f"grep -rn {quote_shell(pattern)} {quote_shell(path)}"
                if include:
                    cmd = f"grep -rn --include={quote_shell(include)} {quote_shell(pattern)} {quote_shell(path)}"
                cmd += " 2>/dev/null | head -50"

                output, rc = self._run_cmd(cmd)

                if not output.strip():
                    return text_response(f"No matches found for pattern: {pattern}")

                return text_response(output)
            except Exception as e:
                return error_response(f"Grep error: {e}")

        return grep_files

    def _create_bash_tool(self):
        @tool(
            "Bash",
            "Execute a bash command in the workspace.",
            {"command": str, "timeout": int},
        )
        async def run_bash(args: dict[str, Any]) -> dict[str, Any]:
            command = args["command"]
            timeout = args.get("timeout", 120)

            try:
                output, rc = self._run_cmd(command, timeout=timeout)

                if rc != 0:
                    output += f"\n[exit code: {rc}]"

                return text_response(output or "(no output)")
            except Exception as e:
                return error_response(f"Bash error: {e}")

        return run_bash

    def _create_notebook_edit_tool(self):
        @tool(
            "NotebookEdit",
            "Edit Jupyter notebook cells.",
            {"notebook_path": str, "cell_id": str, "new_source": str, "cell_type": str, "edit_mode": str},
        )
        async def notebook_edit(args: dict[str, Any]) -> dict[str, Any]:
            return error_response("NotebookEdit not yet implemented for Modal sandboxes")

        return notebook_edit

    def _create_ls_tool(self):
        @tool(
            "LS",
            "List directory contents.",
            {"path": str, "all": bool},
        )
        async def list_dir(args: dict[str, Any]) -> dict[str, Any]:
            path = args.get("path", ".")
            show_all = args.get("all", False)

            try:
                cmd = f"ls -la {quote_shell(path)}" if show_all else f"ls -l {quote_shell(path)}"
                output, rc = self._run_cmd(cmd)

                if rc != 0:
                    return error_response(f"Failed to list directory: {output}")

                return text_response(output)
            except Exception as e:
                return error_response(f"LS error: {e}")

        return list_dir
