#!/usr/bin/env python3
"""
Modal Claude CLI - A REPL that runs Claude with tools proxied to a Modal sandbox.

Usage:
    export MODAL_TOKEN_ID="your-token-id"
    export MODAL_TOKEN_SECRET="your-token-secret"
    export ANTHROPIC_API_KEY="your-key"
    python main.py [sandbox-name]

Sandbox will be created if it doesn't exist.
"""

import os
import sys
import asyncio

from dotenv import load_dotenv

load_dotenv()

import modal

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
    ResultMessage,
)

from tools import ModalToolProvider
from utils import truncate

# Tools that Claude is allowed to use (proxied through Modal)
ALLOWED_TOOLS = [
    "mcp__modal__Read",
    "mcp__modal__Write",
    "mcp__modal__Edit",
    "mcp__modal__Glob",
    "mcp__modal__Grep",
    "mcp__modal__Bash",
    "mcp__modal__NotebookEdit",
    "mcp__modal__LS",
    "WebFetch",
    "WebSearch",
    "Task", # TODO: not sure if this inherits the tools of the agent
    "TodoWrite",
]

# Built-in tools to disable (we use Modal-proxied versions instead)
DISALLOWED_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "NotebookEdit",
]


class Agent:
    """REPL for Claude with tools proxied to a Modal sandbox."""

    def __init__(self, sandbox_name: str, timeout: int = 3600):
        self.sandbox_name = sandbox_name
        self.timeout = timeout
        self.app = None
        self.sandbox = None
        self.claude_client = None
        self.tool_provider = None

    async def setup(self):
        """Initialize the Modal sandbox and Claude client."""
        print(f"Setting up Modal sandbox: {self.sandbox_name}")

        self.app = modal.App.lookup("claude-sandbox", create_if_missing=True)
        print(f"  Using Modal app: claude-sandbox")

        self.sandbox = self._get_or_create_sandbox()
        self._test_connection()

        self.tool_provider = ModalToolProvider(self.sandbox)
        mcp_server = self.tool_provider.create_mcp_server()

        options = ClaudeAgentOptions(
            mcp_servers={"modal": mcp_server},
            allowed_tools=ALLOWED_TOOLS,
            disallowed_tools=DISALLOWED_TOOLS,
            permission_mode="acceptEdits",
        )

        self.claude_client = ClaudeSDKClient(options=options)
        await self.claude_client.connect()
        print("  Claude connected with Modal-proxied tools\n")

    def _get_or_create_sandbox(self) -> modal.Sandbox:
        """Connect to existing sandbox or create a new one."""
        try:
            sandbox = modal.Sandbox.from_name("claude-sandbox", self.sandbox_name)
            if sandbox.poll() is not None:
                raise Exception("Sandbox terminated")
            print(f"  Connected to existing sandbox: {self.sandbox_name}")
            return sandbox
        except Exception:
            return self._create_sandbox()

    def _create_sandbox(self) -> modal.Sandbox:
        """Create a new Modal sandbox with dev-friendly tools."""
        image = (
            modal.Image.debian_slim(python_version="3.11")
            .apt_install("git", "curl", "vim", "ripgrep", "jq")
            .pip_install("ipython", "requests", "numpy", "pandas")
        )

        sandbox = modal.Sandbox.create(
            app=self.app,
            image=image,
            timeout=self.timeout,
            name=self.sandbox_name,
            workdir="/root",
        )
        print(f"  Created new sandbox: {self.sandbox_name}")
        return sandbox

    def _test_connection(self):
        """Verify sandbox connection works."""
        p = self.sandbox.exec("echo", "Modal sandbox connected!")
        output = p.stdout.read().strip()
        print(f"  {output}")

    async def chat(self, message: str) -> str:
        """Send a message and get response."""
        await self.claude_client.query(message)

        response_text = ""
        async for msg in self.claude_client.receive_response():
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        response_text += block.text
                    elif isinstance(block, ToolUseBlock):
                        print(f"  > {block.name}: {truncate(str(block.input), 80)}")
                    elif isinstance(block, ToolResultBlock):
                        status = "x" if block.is_error else "|"
                        print(f"  {status} {truncate(str(block.content), 80)}")
            elif isinstance(msg, ResultMessage):
                if msg.is_error:
                    response_text += f"\n[Error: {msg.result}]"

        return response_text

    async def repl(self):
        """Run the interactive REPL."""
        print("=" * 60)
        print("Modal Claude REPL")
        print("Type your messages, 'exit' to quit, 'clear' for new session")
        print("=" * 60)
        print()

        while True:
            try:
                user_input = input("\033[1;32mYou:\033[0m ").strip()

                if not user_input:
                    continue

                if user_input.lower() == "exit":
                    print("\nGoodbye.")
                    break

                if user_input.lower() == "clear":
                    await self.claude_client.disconnect()
                    await self.setup()
                    print("Session cleared.\n")
                    continue

                print()
                response = await self.chat(user_input)
                print(f"\n{response}\n")

            except KeyboardInterrupt:
                print("\n\nInterrupted. Goodbye.")
                break
            except EOFError:
                print("\n\nGoodbye.")
                break
            except Exception as e:
                print(f"\nError: {e}\n")

    async def cleanup(self):
        """Clean up resources."""
        if self.claude_client:
            await self.claude_client.disconnect()


async def main():
    sandbox_name = sys.argv[1] if len(sys.argv) > 1 else f"claude-{os.getenv('USER', 'default')}"

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable required")
        sys.exit(1)

    agent = Agent(sandbox_name)

    try:
        await agent.setup()
        await agent.repl()
    finally:
        await agent.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
