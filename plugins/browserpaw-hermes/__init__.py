"""BrowserPaw native plugin for Hermes Agent (v5 CLI-first).

Registers the read-only canonical BrowserPaw Agent Skill via ``ctx.register_skill``
and exposes a single ``browserpaw`` tool that invokes the local ``browserpaw`` CLI
without shell expansion and includes ``MEDIA:<path>`` lines for local screenshot files.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parent
SKILL_FILE = PLUGIN_ROOT / "skills" / "browserpaw" / "SKILL.md"

DEFAULT_TIMEOUT_SECONDS = 120.0
MIN_TIMEOUT_SECONDS = 5.0
MAX_TIMEOUT_SECONDS = 600.0
MAX_ARGS = 128
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})

BROWSERPAW_TOOL_SCHEMA: dict[str, Any] = {
    "name": "browserpaw",
    "description": (
        "Run a BrowserPaw v5 CLI command against the user's connected Chrome/Chromium "
        "browser or ~/.browserpaw learned workflows. Pass arguments as an argv list, "
        "for example ['status'], ['help'], ['recipe', 'find', 'twitter'], "
        "['task', 'start', 'research', '--json'], ['observe', '--task', 'ID'], or "
        "['screenshot', '--task', 'ID', '--out', 'page.png']. Load skill_view('browserpaw:browserpaw') "
        "first when you need the full workflow contract. When screenshot output includes "
        "MEDIA:<path> lines, preserve those MEDIA: lines verbatim in your final reply so "
        "Hermes gateways deliver the images."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Command arguments passed directly to the browserpaw executable without a shell "
                    "(for example ['status'] or ['open', 'https://example.com', '--task', 't1'])."
                ),
            },
            "timeout": {
                "type": "number",
                "description": "Optional per-command timeout in seconds (5 to 600).",
            },
        },
        "required": ["args"],
    },
}


def _clamp_timeout(value: Any, fallback: float = DEFAULT_TIMEOUT_SECONDS) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if parsed != parsed:  # NaN
        return fallback
    return max(MIN_TIMEOUT_SECONDS, min(MAX_TIMEOUT_SECONDS, parsed))


def _read_config(ctx: Any) -> tuple[str, float]:
    cli_path = ""
    timeout = DEFAULT_TIMEOUT_SECONDS
    get_config = getattr(ctx, "get_config", None)
    if callable(get_config):
        try:
            raw_cli = get_config("cli_path", "")
            if isinstance(raw_cli, str):
                cli_path = raw_cli.strip()
            raw_timeout = get_config("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
            timeout = _clamp_timeout(raw_timeout, DEFAULT_TIMEOUT_SECONDS)
        except Exception:
            pass
    return cli_path, timeout


def _resolve_cli(configured_path: str = "") -> str | None:
    if configured_path:
        candidate = Path(configured_path).expanduser()
        if candidate.is_file():
            return str(candidate)
        return None
    return shutil.which("browserpaw")


def _extract_media_paths(stdout: str) -> list[str]:
    """Collect existing local image paths emitted by browserpaw screenshot receipts."""
    candidates: list[str] = []
    text = stdout.strip()
    if not text:
        return []

    def _walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key in {"path", "filePath", "outputPath", "artifactPath", "file"} and isinstance(
                    value, str
                ):
                    candidates.append(value)
                else:
                    _walk(value)
        elif isinstance(obj, list):
            for item in obj:
                _walk(item)

    try:
        _walk(json.loads(text))
    except ValueError:
        for line in text.splitlines():
            cleaned = line.strip().strip('"').strip("'")
            if cleaned and Path(cleaned).suffix.lower() in IMAGE_EXTENSIONS:
                candidates.append(cleaned)

    seen: set[str] = set()
    media: list[str] = []
    for raw in candidates:
        p = Path(raw)
        if p.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        try:
            resolved = str(p.resolve())
        except OSError:
            continue
        if resolved not in seen and os.path.isfile(resolved):
            seen.add(resolved)
            media.append(resolved)
    return media


def _validate_args(raw_args: Any) -> tuple[list[str] | None, str | None]:
    if not isinstance(raw_args, list) or not raw_args:
        return None, "Parameter 'args' must be a non-empty list of strings."
    if len(raw_args) > MAX_ARGS:
        return None, f"Too many CLI arguments (max {MAX_ARGS})."
    cleaned: list[str] = []
    for item in raw_args:
        if not isinstance(item, str) or "\x00" in item:
            return None, "Every CLI argument must be a string without NUL bytes."
        cleaned.append(item)
    return cleaned, None


def _make_handler(ctx: Any):
    def _handle(args: dict[str, Any], **kwargs: Any) -> str:
        del kwargs
        argv, err = _validate_args((args or {}).get("args"))
        if err or argv is None:
            return json.dumps({"ok": False, "error": err}, ensure_ascii=False)

        configured_cli, default_timeout = _read_config(ctx)
        exe = _resolve_cli(configured_cli)
        if not exe:
            detail = (
                f"Configured browserpaw cli_path not found: {configured_cli}"
                if configured_cli
                else (
                    "browserpaw CLI not found on PATH. Install with "
                    "`npm install -g browserpaw@5.0.0`, run `browserpaw setup --no-skill`, "
                    "and load the Chrome extension."
                )
            )
            return json.dumps({"ok": False, "error": detail}, ensure_ascii=False)

        timeout = (
            _clamp_timeout(args.get("timeout"), default_timeout)
            if isinstance(args, dict) and args.get("timeout") is not None
            else default_timeout
        )

        try:
            completed = subprocess.run(
                [exe, *argv],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                shell=False,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return json.dumps(
                {"ok": False, "error": f"browserpaw command timed out after {timeout:.0f}s."},
                ensure_ascii=False,
            )
        except OSError as exc:
            return json.dumps(
                {"ok": False, "error": f"Failed to execute browserpaw CLI: {exc}"},
                ensure_ascii=False,
            )

        payload: dict[str, Any] = {
            "ok": completed.returncode == 0,
            "exitCode": completed.returncode,
            "stdout": completed.stdout.strip(),
        }
        if completed.stderr.strip():
            payload["stderr"] = completed.stderr.strip()

        media_paths = _extract_media_paths(completed.stdout)
        if media_paths:
            payload["media"] = media_paths
        output = json.dumps(payload, ensure_ascii=False)
        if media_paths:
            output += "\n" + "\n".join(f"MEDIA:{item}" for item in media_paths)
        return output

    return _handle


def register(ctx: Any) -> None:
    """Register the read-only BrowserPaw Agent Skill and unified CLI tool."""
    register_skill = getattr(ctx, "register_skill", None)
    if callable(register_skill) and SKILL_FILE.is_file():
        register_skill("browserpaw", SKILL_FILE)

    ctx.register_tool(
        name="browserpaw",
        toolset="browserpaw",
        schema=BROWSERPAW_TOOL_SCHEMA,
        handler=_make_handler(ctx),
        emoji="🐾",
    )
