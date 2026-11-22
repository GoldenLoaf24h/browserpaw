"""BrowserPaw native plugin for Hermes Agent (v5 CLI-first).

Registers the read-only canonical BrowserPaw Agent Skill via ``ctx.register_skill``
and exposes a single ``browserpaw`` tool that invokes the local ``browserpaw`` CLI
without shell expansion, enforces Hermes file-safety rules and installer restrictions,
and includes ``MEDIA:<path>`` lines for local screenshot files.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parent
SKILL_FILE = PLUGIN_ROOT / "skills" / "browserpaw" / "SKILL.md"

DEFAULT_TIMEOUT_SECONDS = 120.0
MIN_TIMEOUT_SECONDS = 5.0
MAX_TIMEOUT_SECONDS = 600.0
MAX_ARGS = 128
MAX_JSON_INPUT_BYTES = 8 * 1024 * 1024
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})
RECIPE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
TEMPLATE_PLACEHOLDER_PATTERN = re.compile(r"\{\{([a-zA-Z0-9_-]{1,64})\}\}")

BROWSERPAW_TOOL_SCHEMA: dict[str, Any] = {
    "name": "browserpaw",
    "description": (
        "Run a BrowserPaw v5 CLI command against the user's connected Chrome/Chromium "
        "browser or ~/.browserpaw learned workflows. Pass arguments as an argv list, "
        "for example ['status'], ['help'], ['recipe', 'find', 'twitter'], "
        "['task', 'start', 'research', '--json'], ['observe', '--task', 'ID'], or "
        "['screenshot', '--task', 'ID']. Output paths (--out) are confined to "
        "~/.browserpaw/out (omit --out for default managed output), local file reads "
        "are checked against Hermes file-safety rules, and installer commands "
        "(setup, uninstall, doctor --fix) are user-only. Load skill_view('browserpaw:browserpaw') "
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

TWO_WORD_COMMANDS = frozenset(
    {
        "tab focus",
        "tab close",
        "tab move",
        "task start",
        "task list",
        "task status",
        "task resume",
        "task finish",
        "task cancel",
        "task borrow",
        "task release",
        "recipe list",
        "recipe find",
        "recipe show",
        "recipe run",
        "recipe save",
        "recipe patch",
        "recipe validate",
        "recipe rm",
        "window list",
        "window open",
        "window focus",
        "window close",
        "group list",
        "group create",
        "group update",
        "group ungroup",
        "group close",
        "history search",
        "history visits",
        "history top",
        "history rm",
        "bookmark tree",
        "bookmark search",
        "bookmark add",
        "bookmark mkdir",
        "bookmark mv",
        "bookmark rename",
        "bookmark rm",
        "bookmark dedupe",
        "bookmark export",
        "downloads list",
        "downloads reveal",
        "downloads rm",
        "storage get",
        "storage set",
        "storage rm",
        "storage clear",
        "cookies list",
        "cookies set",
        "cookies rm",
        "network start",
        "network stop",
        "network show",
        "network list",
        "network clear",
        "perf metrics",
        "perf trace",
        "emulate reset",
    }
)

REFUSED_INSTALLER_COMMANDS = frozenset({"setup", "uninstall"})

POSITIONAL_PATH_COMMAND_OPTIONS: dict[str, dict[str, bool]] = {
    "upload": {"task": True, "tab": True, "frame": True, "json": False, "help": False},
    "batch": {"task": True, "tab": True, "frame": True, "json": False, "help": False},
    "recipe save": {"task": True, "tab": True, "frame": True, "json": False, "help": False},
    "recipe patch": {"step": True, "task": True, "tab": True, "frame": True, "json": False, "help": False},
}

VALUE_OPTIONS = frozenset(
    {
        "body",
        "browser",
        "by",
        "capture",
        "color",
        "color-scheme",
        "cpu-rate",
        "domain",
        "download-kbps",
        "dpr",
        "duration",
        "expires",
        "file",
        "filter",
        "folder",
        "format",
        "frame",
        "goal",
        "grep",
        "group",
        "height",
        "id",
        "idle",
        "index",
        "input",
        "keep",
        "latency",
        "level",
        "limit",
        "locale",
        "margin",
        "max",
        "max-chars",
        "max-time",
        "method",
        "out",
        "paper",
        "path",
        "query",
        "same-site",
        "scale",
        "scope",
        "selector",
        "since",
        "skill-dir",
        "skill-scope",
        "state",
        "status",
        "step",
        "tab",
        "task",
        "text",
        "timeout",
        "timezone",
        "title",
        "type",
        "until",
        "upload-kbps",
        "url",
        "user-agent",
        "viewport",
        "width",
        "window",
    }
)

BOOLEAN_OPTIONS = frozenset(
    {
        "adopt",
        "all",
        "append",
        "apply",
        "auto-stop",
        "background",
        "bodies",
        "bottom",
        "clear",
        "collapsed",
        "content",
        "delta",
        "double",
        "down",
        "fix",
        "footer",
        "foreground",
        "full",
        "gone",
        "help",
        "http-only",
        "json",
        "keep-unknown",
        "landscape",
        "links",
        "list",
        "media",
        "mobile",
        "no-background",
        "no-exceptions",
        "no-skill",
        "offline",
        "purge",
        "recursive",
        "regex",
        "reload",
        "right",
        "scroll",
        "secure",
        "session",
        "static",
        "top",
        "up",
        "values",
        "windows",
        "yes",
    }
)

HOME_CREDENTIAL_FILES = (
    ".netrc",
    "_netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
)
HOME_CREDENTIAL_DIRS = (
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".azure",
    ".config/gh",
    ".config/gcloud",
)
BLOCKED_PROJECT_ENV_BASENAMES = frozenset(
    {
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        ".env.test",
        ".env.staging",
        ".envrc",
    }
)
HERMES_CREDENTIAL_FILES = (
    "auth.json",
    "auth.json.corrupt",
    "auth.lock",
    ".anthropic_oauth.json",
    ".env",
    ".op.env",
    "webhook_subscriptions.json",
    "auth/google_oauth.json",
    "google_token.json",
    "google_client_secret.json",
    "google_oauth_pending.json",
    "bws_cache.json",
    "bws_cache.enc.json",
    "op_cache.json",
    "photon-sidecar.json",
    "cache/bws_cache.json",
    "cache/bws_cache.enc.json",
    "cache/op_cache.json",
    "runtime/photon-sidecar.json",
)
HERMES_READ_DENIED_DIRS = (
    "skills/.hub",
    "mcp-tokens",
    "browser-profile",
    "vault",
    "webapp",
    "pairing",
    "platforms/pairing",
    "whatsapp/session",
    "platforms/whatsapp/session",
    "matrix/store",
    "platforms/matrix/store",
)
HERMES_WRITE_PROTECTED_SUBPATHS = (
    "state.db",
    "sessions",
    "plugins",
    "skills",
    *HERMES_READ_DENIED_DIRS,
)
BLOCKED_DEVICE_PATHS = frozenset(
    {
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/full",
        "/dev/stdin",
        "/dev/tty",
        "/dev/console",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/fd/0",
        "/dev/fd/1",
        "/dev/fd/2",
    }
)
BLOCKED_PROC_SUFFIXES = (
    "/fd/0",
    "/fd/1",
    "/fd/2",
    "/environ",
    "/cmdline",
    "/maps",
    "/smaps",
    "/smaps_rollup",
    "/numa_maps",
    "/mem",
    "/auxv",
    "/pagemap",
)


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


def _browserpaw_home() -> Path:
    return Path(os.environ.get("BROWSERPAW_HOME") or Path.home() / ".browserpaw")


def _managed_out_root() -> Path:
    return (_browserpaw_home() / "out").resolve()


def _deny_key(path: str | Path) -> str:
    text = os.fspath(path)
    return text.casefold() if sys.platform in ("darwin", "win32") else text


def _deny_path_under(resolved: str | Path, base: str | Path) -> bool:
    target, root = _deny_key(resolved), _deny_key(base)
    return target == root or target.startswith(root.rstrip(os.sep) + os.sep)


def _is_nt_or_unc_path(raw: str) -> bool:
    if any(char in raw for char in "\r\n\x00"):
        return True
    return raw.startswith(("\\\\?\\", "\\\\.\\", "\\??\\", "//?/", "//./", "\\\\", "//"))


def _expand_and_resolve(raw: str, label: str) -> tuple[Path | None, Path | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, None, f"Path for {label} must be a non-empty string."
    if _is_nt_or_unc_path(raw):
        return None, None, f"Access denied for {label}: NT/device-namespace and UNC paths are not allowed."
    if raw.startswith("~"):
        if raw != "~" and not raw.startswith(("~/", "~\\")):
            return None, None, f"Access denied for {label}: user-specific tilde paths are not allowed."
        expanded = os.path.expanduser(raw)
    else:
        expanded = raw
    try:
        candidate = Path(os.path.abspath(expanded))
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        return None, None, f"Invalid path for {label}: {exc}"
    return candidate, resolved, None


def _hermes_home_dirs() -> list[Path]:
    candidates: list[Path] = []
    env_home = os.environ.get("HERMES_HOME", "").strip()
    if env_home:
        candidates.append(Path(env_home).expanduser())
    default_root = Path.home() / ".hermes"
    candidates.append(default_root)
    profiles_dir = default_root / "profiles"
    try:
        if profiles_dir.is_dir():
            for child in profiles_dir.iterdir():
                if child.is_dir():
                    candidates.append(child)
    except OSError:
        pass
    resolved: list[Path] = []
    for item in candidates:
        try:
            resolved.append(item.resolve())
        except OSError:
            pass
    return list(dict.fromkeys(resolved))


def _hermes_write_denied_error(paths: tuple[str, ...]) -> str | None:
    try:
        from agent.file_safety import is_write_denied
    except ImportError:
        return None
    try:
        from agent.file_safety import get_write_denied_error
    except ImportError:
        get_write_denied_error = None
    for candidate in dict.fromkeys(paths):
        if is_write_denied(candidate):
            if callable(get_write_denied_error):
                detail = get_write_denied_error(candidate)
                if detail:
                    return detail
            return f"Write denied by Hermes file safety: '{candidate}'."
    return None


def _hermes_read_blocked_error(paths: tuple[str, ...]) -> str | None:
    try:
        from agent.file_safety import raise_if_read_blocked
    except ImportError:
        return None
    for candidate in dict.fromkeys(paths):
        try:
            raise_if_read_blocked(candidate)
        except ValueError as exc:
            return str(exc) or f"Read denied by Hermes file safety: '{candidate}'."
    return None


def _is_blocked_device_or_proc(path_text: str) -> bool:
    normalized = os.path.normpath(path_text)
    if normalized in BLOCKED_DEVICE_PATHS:
        return True
    return normalized.startswith("/proc/") and normalized.endswith(BLOCKED_PROC_SUFFIXES)


def _fallback_read_blocked_error(raw: str, candidate: Path, resolved: Path) -> str | None:
    if _is_blocked_device_or_proc(os.path.expanduser(raw)) or _is_blocked_device_or_proc(str(resolved)):
        return f"Access denied: '{raw}' is a blocked device or process file."
    if (
        candidate.name.casefold() in BLOCKED_PROJECT_ENV_BASENAMES
        or resolved.name.casefold() in BLOCKED_PROJECT_ENV_BASENAMES
    ):
        return f"Access denied: '{raw}' is a secret-bearing environment file."
    for hermes_dir in _hermes_home_dirs():
        for rel_file in HERMES_CREDENTIAL_FILES:
            if _deny_key(resolved) == _deny_key((hermes_dir / rel_file).resolve(strict=False)):
                return f"Access denied: '{raw}' is a protected Hermes credential file."
        for rel_dir in HERMES_READ_DENIED_DIRS:
            if _deny_path_under(resolved, (hermes_dir / rel_dir).resolve(strict=False)):
                return f"Access denied: '{raw}' is inside a protected Hermes directory."
    home = Path.home().resolve()
    for rel_file in HOME_CREDENTIAL_FILES:
        if _deny_key(resolved) == _deny_key((home / rel_file).resolve(strict=False)):
            return f"Access denied: '{raw}' is a protected credential file."
    for rel_dir in HOME_CREDENTIAL_DIRS:
        if _deny_path_under(resolved, (home / rel_dir).resolve(strict=False)):
            return f"Access denied: '{raw}' is inside a protected credential directory."
    bp_home = _browserpaw_home().resolve()
    for secret_name in ("token", "host.json"):
        if _deny_key(resolved) == _deny_key((bp_home / secret_name).resolve(strict=False)):
            return f"Access denied: '{raw}' is a BrowserPaw internal bridge file."
    return None


def _fallback_write_denied_error(resolved: Path) -> str | None:
    safe_roots_env = os.environ.get("HERMES_WRITE_SAFE_ROOT", "")
    if safe_roots_env:
        safe_roots: list[Path] = []
        for item in filter(None, safe_roots_env.split(os.pathsep)):
            try:
                safe_roots.append(Path(item).expanduser().resolve())
            except OSError:
                pass
        if safe_roots and not any(resolved.is_relative_to(root) for root in safe_roots):
            return f"Write denied: '{resolved}' is outside HERMES_WRITE_SAFE_ROOT."
    for hermes_dir in _hermes_home_dirs():
        for rel_file in HERMES_CREDENTIAL_FILES:
            if _deny_key(resolved) == _deny_key((hermes_dir / rel_file).resolve(strict=False)):
                return f"Write denied: '{resolved}' is a protected Hermes file."
        for rel_sub in HERMES_WRITE_PROTECTED_SUBPATHS:
            if _deny_path_under(resolved, (hermes_dir / rel_sub).resolve(strict=False)):
                return f"Write denied: '{resolved}' is inside a protected Hermes directory."
    home = Path.home().resolve()
    for rel_file in HOME_CREDENTIAL_FILES:
        if _deny_key(resolved) == _deny_key((home / rel_file).resolve(strict=False)):
            return f"Write denied: '{resolved}' is a protected credential file."
    for rel_dir in HOME_CREDENTIAL_DIRS:
        if _deny_path_under(resolved, (home / rel_dir).resolve(strict=False)):
            return f"Write denied: '{resolved}' is inside a protected credential directory."
    return None


def _validate_write_path(
    raw: str, *, option_name: str, allow_out_root_dir: bool = False
) -> tuple[str | None, str | None]:
    if "{{" in raw or "}}" in raw:
        return None, f"Write path for '{option_name}' cannot contain unresolved template placeholders."
    candidate, resolved, err = _expand_and_resolve(raw, option_name)
    if err or candidate is None or resolved is None:
        return None, err
    try:
        if candidate.is_symlink():
            return None, f"Write denied for '{option_name}': symbolic links are not allowed."
    except OSError as exc:
        return None, f"Invalid path for '{option_name}': {exc}"

    hermes_err = _hermes_write_denied_error((raw, str(candidate), str(resolved)))
    if hermes_err:
        return None, hermes_err
    fallback_err = _fallback_write_denied_error(resolved)
    if fallback_err:
        return None, fallback_err

    out_root = _managed_out_root()
    out_root_err = _hermes_write_denied_error((str(out_root),))
    if out_root_err:
        return None, out_root_err

    inside_out = resolved.is_relative_to(out_root) and (allow_out_root_dir or resolved != out_root)
    if not inside_out:
        return (
            None,
            f"Write path for '{option_name}' must stay within '{out_root}' "
            "(omit '--out' to use BrowserPaw's managed output directory).",
        )
    return str(resolved), None


def _validate_read_path(
    raw: str, *, label: str, allow_stdin_dash: bool = False
) -> tuple[str | None, str | None]:
    if allow_stdin_dash and raw == "-":
        return "-", None
    if "{{" in raw or "}}" in raw:
        return None, f"Read path for {label} cannot contain unresolved template placeholders."
    candidate, resolved, err = _expand_and_resolve(raw, label)
    if err or candidate is None or resolved is None:
        return None, err

    hermes_err = _hermes_read_blocked_error((raw, str(candidate), str(resolved)))
    if hermes_err:
        return None, hermes_err
    fallback_err = _fallback_read_blocked_error(raw, candidate, resolved)
    if fallback_err:
        return None, fallback_err
    return str(resolved), None


def _load_json_input_file(file_path: str, label: str) -> tuple[Any, str | None]:
    target = Path(file_path)
    try:
        if not target.is_file():
            return None, f"{label} not found or is not a regular file: {file_path}"
        size = target.stat().st_size
        if size > MAX_JSON_INPUT_BYTES:
            return None, f"{label} exceeds maximum allowed size (8 MiB): {file_path}"
        raw_text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"Failed to read {label}: {exc}"
    try:
        return json.loads(raw_text), None
    except json.JSONDecodeError:
        return None, f"{label} is not valid JSON: {file_path}"


def _validate_saved_recipe_steps(
    recipe_id: str, raw_kv_operands: list[str], *, candidate_only: bool
) -> str | None:
    if not RECIPE_ID_PATTERN.fullmatch(recipe_id):
        return None
    recipes_dir = _browserpaw_home() / "recipes"
    candidates = (
        (recipes_dir / f"{recipe_id}.candidate.json",)
        if candidate_only
        else (recipes_dir / f"{recipe_id}.json", recipes_dir / f"{recipe_id}.candidate.json")
    )
    recipe_file = next((path for path in candidates if path.exists() or path.is_symlink()), None)
    if recipe_file is None:
        return None
    try:
        if recipe_file.is_symlink() or not recipe_file.is_file():
            return f"Saved recipe '{recipe_id}' must be a regular non-symlink file."
        if recipe_file.stat().st_size > MAX_JSON_INPUT_BYTES:
            return f"Saved recipe '{recipe_id}' exceeds maximum allowed size."
        data = json.loads(recipe_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return f"Failed to validate saved recipe '{recipe_id}': {exc}"
    if not isinstance(data, dict) or not isinstance(data.get("steps"), list):
        return None

    values: dict[str, str] = {}
    raw_inputs = data.get("inputs")
    if isinstance(raw_inputs, dict):
        for key, spec in raw_inputs.items():
            if isinstance(key, str) and isinstance(spec, dict) and spec.get("default") is not None:
                values[key] = str(spec["default"])
    for token in raw_kv_operands:
        if "=" in token:
            key, _, val = token.partition("=")
            if key:
                values[key] = val

    for step in data["steps"]:
        if not isinstance(step, list) or not step or not all(isinstance(part, str) for part in step):
            return f"Saved recipe '{recipe_id}' contains an invalid step."
        expanded_step = [
            TEMPLATE_PLACEHOLDER_PATTERN.sub(
                lambda match: values.get(match.group(1), match.group(0)), part
            )
            for part in step
        ]
        _, _, err = _validate_and_sanitize_argv(expanded_step, allow_nested=False)
        if err:
            return f"Blocked step in recipe '{recipe_id}': {err}"
    return None


def _validate_and_sanitize_argv(
    argv: list[str], *, allow_nested: bool = True
) -> tuple[list[str] | None, str | None, str | None]:
    sanitized = list(argv)
    cmd_start = 1 if sanitized[0] == "--json" else 0
    if cmd_start >= len(sanitized):
        return None, None, "Missing BrowserPaw subcommand."

    first = sanitized[cmd_start]
    if first in ("--help", "-h", "--version", "-V"):
        return sanitized, first, None
    if first == "help":
        return sanitized, "help", None
    if first.startswith("-"):
        return None, None, f"Unknown command or misplaced flag '{first}'. Run browserpaw help."
    if not allow_nested and ("{{" in first or "}}" in first):
        return None, None, "Template placeholders are not allowed in subcommand names."

    qualified = f"{first} {sanitized[cmd_start + 1]}" if cmd_start + 1 < len(sanitized) else ""
    if qualified in TWO_WORD_COMMANDS:
        cmd = qualified
        rest_start = cmd_start + 2
    else:
        cmd = first
        rest_start = cmd_start + 1

    if cmd in REFUSED_INSTALLER_COMMANDS:
        return (
            None,
            None,
            f"Subcommand '{cmd}' is an installation command reserved for the user and cannot be called by the agent.",
        )
    if not allow_nested and cmd in ("batch", "recipe save", "recipe patch", "recipe run", "recipe validate"):
        return None, None, f"Subcommand '{cmd}' is not allowed inside a batch or recipe step."

    strict_options = POSITIONAL_PATH_COMMAND_OPTIONS.get(cmd)
    operands: list[tuple[int, str]] = []
    index = rest_start
    while index < len(sanitized):
        token = sanitized[index]
        if token == "--":
            for operand_idx in range(index + 1, len(sanitized)):
                operands.append((operand_idx, sanitized[operand_idx]))
            break
        if not token.startswith("--"):
            operands.append((index, token))
            index += 1
            continue

        key, sep, inline_val = token[2:].partition("=")
        has_inline = bool(sep)

        if cmd == "doctor" and key == "fix":
            return (
                None,
                None,
                "Subcommand 'doctor --fix' modifies host registration and cannot be called by the agent. "
                "Run read-only 'doctor' instead.",
            )
        if key == "skill-dir":
            return (
                None,
                None,
                "Option '--skill-dir' is restricted to user-run installation commands and cannot be called by the agent.",
            )

        if key in ("out", "input") or (key == "file" and (cmd != "downloads rm" or has_inline)):
            if has_inline:
                raw_val = inline_val
                val_index = index
            else:
                if index + 1 >= len(sanitized) or sanitized[index + 1].startswith("--"):
                    return None, None, f"Missing value for option '--{key}'."
                val_index = index + 1
                raw_val = sanitized[val_index]
                index += 1

            if key == "out":
                checked, err = _validate_write_path(
                    raw_val, option_name="--out", allow_out_root_dir=(cmd == "download")
                )
            elif key == "input":
                checked, err = _validate_read_path(
                    raw_val, label="--input", allow_stdin_dash=(cmd == "fill")
                )
            else:
                checked, err = _validate_read_path(
                    raw_val, label="--file", allow_stdin_dash=(cmd == "eval")
                )
            if err or checked is None:
                return None, None, err
            if has_inline:
                sanitized[val_index] = f"--{key}={checked}"
            else:
                sanitized[val_index] = checked
            index += 1
            continue

        if strict_options is not None:
            if key not in strict_options:
                return None, None, f"Unknown option '--{key}' for '{cmd}'."
            takes_value = strict_options[key]
        elif key == "file" and cmd == "downloads rm":
            takes_value = False
        elif key == "header":
            takes_value = cmd != "pdf"
        elif key in VALUE_OPTIONS:
            takes_value = True
        elif key in BOOLEAN_OPTIONS:
            takes_value = False
        else:
            takes_value = False

        if takes_value and not has_inline:
            if index + 1 >= len(sanitized) or sanitized[index + 1].startswith("--"):
                return None, None, f"Missing value for option '--{key}'."
            index += 1
        index += 1

    if cmd == "upload":
        for operand_idx, raw_file in operands[1:]:
            checked, err = _validate_read_path(
                raw_file, label="upload file", allow_stdin_dash=False
            )
            if err or checked is None:
                return None, None, err
            sanitized[operand_idx] = checked
    elif cmd in ("batch", "recipe save"):
        label = "batch file" if cmd == "batch" else "recipe save file"
        for operand_idx, raw_file in operands:
            checked, err = _validate_read_path(raw_file, label=label, allow_stdin_dash=True)
            if err or checked is None:
                return None, None, err
            sanitized[operand_idx] = checked
        if allow_nested and len(operands) == 1:
            target_file = sanitized[operands[0][0]]
            if target_file != "-":
                parsed_json, err = _load_json_input_file(target_file, label)
                if err:
                    return None, None, err
                steps = (
                    parsed_json
                    if cmd == "batch"
                    else parsed_json.get("steps") if isinstance(parsed_json, dict) else None
                )
                if cmd == "batch":
                    if not isinstance(steps, list) or not steps:
                        return None, None, "Batch file must be a non-empty JSON array of command arrays."
                    for step in steps:
                        if not isinstance(step, list) or not step or not all(isinstance(p, str) for p in step):
                            return None, None, "Each batch step must be a non-empty array of strings."
                        _, _, step_err = _validate_and_sanitize_argv(step, allow_nested=False)
                        if step_err:
                            return None, None, f"Blocked batch step: {step_err}"
                elif isinstance(steps, list):
                    for step in steps:
                        if isinstance(step, list) and step and all(isinstance(p, str) for p in step):
                            _, _, step_err = _validate_and_sanitize_argv(step, allow_nested=False)
                            if step_err:
                                return None, None, f"Blocked recipe step: {step_err}"
    elif cmd == "recipe patch" and allow_nested and len(operands) >= 2:
        step_tokens = [token for _, token in operands[1:]]
        sanitized_step, _, step_err = _validate_and_sanitize_argv(step_tokens, allow_nested=False)
        if step_err or sanitized_step is None:
            return None, None, f"Blocked recipe patch step: {step_err}"
        for (operand_idx, _), updated_token in zip(operands[1:], sanitized_step):
            sanitized[operand_idx] = updated_token
    elif cmd in ("recipe run", "recipe validate") and allow_nested and operands:
        recipe_id = operands[0][1]
        kv_args = [token for _, token in operands[1:]]
        step_err = _validate_saved_recipe_steps(
            recipe_id, kv_args, candidate_only=(cmd == "recipe validate")
        )
        if step_err:
            return None, None, step_err

    return sanitized, cmd, None


def _extract_media_paths(stdout: str) -> list[str]:
    """Read only CLI-created image artifacts from a successful screenshot receipt."""
    try:
        receipt = json.loads(stdout)
    except ValueError:
        return []
    if not isinstance(receipt, dict) or receipt.get("ok") is not True:
        return []
    if receipt.get("command") != "screenshot" or not isinstance(receipt.get("data"), dict):
        return []
    request_id = receipt.get("requestId")
    task_id = receipt.get("taskId", "misc")
    uuid = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
    if not isinstance(request_id, str) or not re.fullmatch(uuid, request_id):
        return []
    if not isinstance(task_id, str) or (task_id != "misc" and not re.fullmatch(uuid, task_id)):
        return []
    root = Path(os.environ.get("BROWSERPAW_HOME") or Path.home() / ".browserpaw")
    directory = (root / "out" / task_id / request_id).absolute()
    data = receipt["data"]
    blocks = data.get("content", data.get("artifacts", []))
    if not isinstance(blocks, list):
        return []
    media = []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "artifact_ref":
            continue
        if block.get("originalType") != "image" or not isinstance(block.get("path"), str):
            continue
        if any(char in block["path"] for char in "\r\n\x00"):
            continue
        image = Path(block["path"])
        if image.parent != directory or image.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if not re.fullmatch(r"item-[1-9]\d*", image.stem):
            continue
        try:
            if image.resolve(strict=True) == image and image.is_file():
                media.append(str(image))
        except OSError:
            pass
    return list(dict.fromkeys(media))


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
        argv, cmd, policy_err = _validate_and_sanitize_argv(argv)
        if policy_err or argv is None:
            return json.dumps({"ok": False, "error": policy_err}, ensure_ascii=False)

        screenshot = cmd == "screenshot"
        if screenshot and argv[0] != "--json" and "--json" not in argv[:argv.index("--") if "--" in argv else len(argv)]:
            argv.insert(0, "--json")

        configured_cli, default_timeout = _read_config(ctx)
        exe = _resolve_cli(configured_cli)
        if not exe:
            detail = (
                f"Configured browserpaw cli_path not found: {configured_cli}"
                if configured_cli
                else (
                    "browserpaw CLI not found on PATH. Install with "
                    "`npm install -g browserpaw@5.0.1`, run `browserpaw setup --no-skill`, "
                    "and load the Chrome extension."
                )
            )
            return json.dumps({"ok": False, "error": detail}, ensure_ascii=False)

        timeout = (
            _clamp_timeout(args.get("timeout"), default_timeout)
            if isinstance(args, dict) and args.get("timeout") is not None
            else default_timeout
        )

        env = dict(os.environ)
        env["BROWSERPAW_NO_AUTO_UPDATE"] = "1"
        env["BROWSERPAW_NO_UPDATE_CHECK"] = "1"
        try:
            completed = subprocess.run(
                [exe, *argv],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                shell=False,
                check=False,
                env=env,
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

        media_paths = (
            _extract_media_paths(completed.stdout) if screenshot and completed.returncode == 0 else []
        )
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
