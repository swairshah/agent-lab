"""Utility functions for Modal Claude."""

from typing import Any


def quote_shell(s: str) -> str:
    """Shell-quote a string safely."""
    return "'" + s.replace("'", "'\"'\"'") + "'"


def text_response(text: str) -> dict[str, Any]:
    """Return a successful text response for MCP tools."""
    return {"content": [{"type": "text", "text": text}]}


def error_response(message: str) -> dict[str, Any]:
    """Return an error response for MCP tools."""
    return {"content": [{"type": "text", "text": f"Error: {message}"}], "is_error": True}


def truncate(s: str, max_len: int) -> str:
    """Truncate string with ellipsis, replacing newlines with spaces."""
    s = s.replace("\n", " ")
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s
