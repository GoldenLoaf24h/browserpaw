"""BrowserPaw — Native Hermes Agent Plugin.

Ultra-fast dual-brain Chrome browser automation with 1-based DOM indexing,
Set-of-Mark 2.0 visual fallbacks, Jev System 1 micro-loop, and local MCP bridge.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
from typing import Any, Callable, Dict, List, Optional
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

_plugin_config: Dict[str, Any] = {
    'native_server_port': 12306,
    'auth_token': None,
    'isolate_modal': False,
    'secret_scope': None,
}

DEFAULT_URLS = [
    os.getenv('BROWSERPAW_MCP_URL', 'http://127.0.0.1:12306/mcp'),
    'http://127.0.0.1:12306/mcp',
]

BRIDGE_TOKEN_SECRET_NAME = 'BROWSERPAW_MCP_TOKEN'

# Optional pre-configured session ID env vars
SESSION_ID_ENV_VARS = ('BROWSERPAW_MCP_SESSION_ID', 'BROWSERCLAW_MCP_SESSION_ID', 'CHROME_MCP_SESSION_ID')

MCP_PROTOCOL_VERSION = '2024-11-05'
CLIENT_INFO = {
    'name': 'browserpaw-python-plugin',
    'version': '4.0.0',
}

_AUTH_HELP = (
    'BrowserPaw bridge rejected the request (HTTP 401): bridge token missing or invalid. '
    'Configure the BROWSERPAW_MCP_TOKEN secret in your Hermes plugin settings with the '
    'token the native server generated in ~/.chrome-mcp/bridge-token.'
)

# Session state management
_session_lock = threading.RLock()
_active_session_id: Optional[str] = None
_active_session_url: Optional[str] = None
_invalid_configured_sessions: set[str] = set()
_request_counter: int = 0


def _next_request_id() -> int:
    """Return incrementing request id for JSON-RPC 2.0 messages."""
    global _request_counter
    with _session_lock:
        _request_counter += 1
        return _request_counter


def _get_configured_session_id() -> Optional[str]:
    """Check if a session ID is pre-configured via environment variable and not known to be invalid."""
    for name in SESSION_ID_ENV_VARS:
        val = os.getenv(name, '').strip()
        if val and val not in _invalid_configured_sessions:
            return val
    return None


def _get_active_session_id() -> Optional[str]:
    """Retrieve active session id, if any."""
    with _session_lock:
        return _active_session_id or _get_configured_session_id()


def _set_active_session_id(session_id: Optional[str], url: Optional[str] = None) -> None:
    """Explicitly update active session id (used internally or by tests)."""
    global _active_session_id, _active_session_url
    with _session_lock:
        _active_session_id = session_id
        _active_session_url = url


def _reset_session(clear_invalid: bool = False) -> None:
    """Invalidate currently cached session to trigger re-initialization on next call."""
    global _active_session_id, _active_session_url
    with _session_lock:
        if clear_invalid:
            _invalid_configured_sessions.clear()
        else:
            if _active_session_id:
                _invalid_configured_sessions.add(_active_session_id)
            for name in SESSION_ID_ENV_VARS:
                val = os.getenv(name, '').strip()
                if val:
                    _invalid_configured_sessions.add(val)
        _active_session_id = None
        _active_session_url = None


def _get_target_urls() -> List[str]:
    """Return deduplicated list of target MCP endpoints."""
    urls: List[str] = []
    env_url = os.getenv('BROWSERPAW_MCP_URL', '').strip()
    if env_url:
        urls.append(env_url)
    port = _plugin_config.get('native_server_port') or 12306
    default_url = f'http://127.0.0.1:{port}/mcp'
    if default_url not in urls:
        urls.append(default_url)
    return urls


def _extract_result_or_error(raw: str) -> str:
    """Extract JSON-RPC result or error string from SSE stream or JSON response."""
    if 'data: ' in raw:
        for line in raw.splitlines():
            if line.startswith('data: '):
                try:
                    parsed = json.loads(line[6:].strip())
                    if 'result' in parsed:
                        return json.dumps(parsed['result'], ensure_ascii=False)
                    elif 'error' in parsed:
                        return json.dumps({'error': parsed['error']}, ensure_ascii=False)
                except Exception:
                    pass
    try:
        parsed = json.loads(raw)
        if 'result' in parsed:
            return json.dumps(parsed['result'], ensure_ascii=False)
        elif 'error' in parsed:
            return json.dumps({'error': parsed['error']}, ensure_ascii=False)
    except Exception:
        pass
    return raw


def _perform_handshake(url: str, token: Optional[str]) -> str:
    """Execute MCP 2024-11-05 initialize handshake and send notifications/initialized.

    Returns the session ID issued by the server.
    """
    req_id = _next_request_id()
    init_payload = json.dumps({
        'jsonrpc': '2.0',
        'id': req_id,
        'method': 'initialize',
        'params': {
            'protocolVersion': MCP_PROTOCOL_VERSION,
            'capabilities': {
                'roots': {'listChanged': False},
                'sampling': {},
            },
            'clientInfo': CLIENT_INFO,
        },
    }).encode('utf-8')

    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'

    init_req = urllib.request.Request(
        url,
        data=init_payload,
        headers=headers,
        method='POST',
    )

    session_id = None
    try:
        with urllib.request.urlopen(init_req, timeout=30) as resp:
            resp_headers = getattr(resp, 'headers', None)
            if resp_headers:
                session_id = (
                    resp_headers.get('mcp-session-id')
                    or resp_headers.get('Mcp-Session-Id')
                    or (getattr(resp, 'getheader', lambda k: None)('mcp-session-id'))
                    or (getattr(resp, 'getheader', lambda k: None)('Mcp-Session-Id'))
                )

            raw = resp.read().decode('utf-8', errors='replace')
            if raw:
                try:
                    if 'data: ' in raw:
                        for line in raw.splitlines():
                            if line.startswith('data: '):
                                line_data = line[6:].strip()
                                if not line_data:
                                    continue
                                parsed = json.loads(line_data)
                                if 'error' in parsed:
                                    err = parsed['error']
                                    err_msg = err.get('message', str(err)) if isinstance(err, dict) else str(err)
                                    raise RuntimeError(f'MCP initialize rejected: {err_msg}')
                                if not session_id:
                                    session_id = parsed.get('result', {}).get('sessionId')
                                if session_id:
                                    break
                    else:
                        parsed = json.loads(raw)
                        if 'error' in parsed:
                            err = parsed['error']
                            err_msg = err.get('message', str(err)) if isinstance(err, dict) else str(err)
                            raise RuntimeError(f'MCP initialize rejected: {err_msg}')
                        if not session_id:
                            session_id = parsed.get('result', {}).get('sessionId')
                except RuntimeError:
                    raise
                except Exception:
                    pass
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise
        err_body = ''
        try:
            err_body = exc.read().decode('utf-8', errors='replace').strip()
        except Exception:
            pass
        logger.warning('MCP initialize handshake HTTP %d: %s', exc.code, err_body or exc.reason)
        raise RuntimeError(f'MCP initialize handshake failed (HTTP {exc.code}): {err_body or exc.reason}') from exc

    session_id = (session_id or '').strip()

    # Step 2: Send notifications/initialized according to MCP lifecycle spec
    notify_payload = json.dumps({
        'jsonrpc': '2.0',
        'method': 'notifications/initialized',
    }).encode('utf-8')

    notify_headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    }
    if session_id:
        notify_headers['mcp-session-id'] = session_id
    if token:
        notify_headers['Authorization'] = f'Bearer {token}'

    notify_req = urllib.request.Request(
        url,
        data=notify_payload,
        headers=notify_headers,
        method='POST',
    )

    try:
        with urllib.request.urlopen(notify_req, timeout=10) as _:
            # Handshake notification acknowledged; do not read indefinitely on SSE keepalive
            pass
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise
        logger.debug('notifications/initialized HTTP error (ignored): %s', exc)
    except Exception as exc:
        logger.debug('notifications/initialized warning (ignored): %s', exc)

    return session_id


def _ensure_session(url: str, force_refresh: bool = False) -> Optional[str]:
    """Ensure an active MCP session exists for the target URL."""
    configured = _get_configured_session_id()
    if configured and not force_refresh:
        return configured

    global _active_session_id, _active_session_url
    with _session_lock:
        if not force_refresh and _active_session_id and _active_session_url == url:
            return _active_session_id

        token = _bridge_token()
        session_id = _perform_handshake(url, token)
        _active_session_id = session_id or None
        _active_session_url = url
        return _active_session_id


def _bridge_token() -> Optional[str]:
    """Resolve the native-bridge auth token from the Hermes secret scope.

    Catalog rule 11: credentials come only through Hermes. No environment
    sniffing, no token file read, no loopback /token fetch.
    """
    cfg_token = _plugin_config.get('auth_token')
    if cfg_token:
        return str(cfg_token).strip()

    secret = _plugin_config.get('secret_scope')
    if secret is None:
        return None
    try:
        value = secret.get_secret(BRIDGE_TOKEN_SECRET_NAME)
    except Exception as exc:
        logger.debug('Failed to read %s from Hermes secret scope: %s', BRIDGE_TOKEN_SECRET_NAME, exc)
        return None
    if value and isinstance(value, str):
        return value.strip()
    return None

    return None


def _call_browserpaw(tool_name: str, arguments: dict) -> str:
    if tool_name == 'browserpaw_read_dom' and isinstance(arguments, dict):
        if 'isolateModal' not in arguments and _plugin_config.get('isolate_modal'):
            arguments['isolateModal'] = True
    remote_name = tool_name
    if tool_name == 'browserpaw_get_windows_and_tabs':
        remote_name = 'get_windows_and_tabs'
    elif tool_name.startswith('browserpaw_'):
        remote_name = 'chrome_' + tool_name[len('browserpaw_'):]

    token = _bridge_token()
    last_error = None
    urls = _get_target_urls()

    for url in urls:
        for attempt in range(2):
            try:
                session_id = _ensure_session(url, force_refresh=(attempt > 0))

                req_id = _next_request_id()
                payload = json.dumps({
                    'jsonrpc': '2.0',
                    'id': req_id,
                    'method': 'tools/call',
                    'params': {
                        'name': remote_name,
                        'arguments': arguments or {},
                    },
                }).encode('utf-8')

                headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                }
                if token:
                    headers['Authorization'] = f'Bearer {token}'
                if session_id:
                    headers['mcp-session-id'] = session_id

                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers=headers,
                    method='POST',
                )

                with urllib.request.urlopen(req, timeout=45) as resp:
                    raw = resp.read().decode('utf-8', errors='replace')
                    res_str = _extract_result_or_error(raw)
                    try:
                        res_obj = json.loads(res_str)
                        if isinstance(res_obj, dict) and 'error' in res_obj:
                            err_msg = str(res_obj.get('error', '')).lower()
                            if ('session' in err_msg or 'not initialized' in err_msg) and attempt == 0:
                                logger.info(
                                    'BrowserPaw MCP session invalid in payload (%s). Re-initializing...',
                                    err_msg,
                                )
                                _reset_session()
                                continue
                    except Exception:
                        pass
                    return res_str

            except RuntimeError as e:
                if attempt == 0:
                    logger.info('BrowserPaw handshake error (%s). Retrying...', e)
                    _reset_session()
                    continue
                return json.dumps({'error': str(e)}, ensure_ascii=False)

            except urllib.error.HTTPError as e:
                if e.code == 401:
                    return json.dumps({'error': _AUTH_HELP})

                err_body = ''
                try:
                    err_body = e.read().decode('utf-8', errors='replace').strip()
                except Exception:
                    pass

                # Session expired or invalid session header (HTTP 400 or 404)
                if e.code in (400, 404) and attempt == 0:
                    logger.info(
                        'BrowserPaw MCP session invalid or expired (HTTP %d). Re-initializing session...',
                        e.code,
                    )
                    _reset_session()
                    continue

                if err_body:
                    try:
                        err_parsed = json.loads(err_body)
                        if isinstance(err_parsed, dict):
                            msg = err_parsed.get('error') or err_parsed.get('message')
                            hint = err_parsed.get('hint')
                            if hint and msg:
                                return json.dumps({'error': f'{msg} ({hint})'}, ensure_ascii=False)
                            return json.dumps(err_parsed, ensure_ascii=False)
                    except Exception:
                        pass
                    return json.dumps({'error': f'BrowserPaw HTTP {e.code}: {err_body}'}, ensure_ascii=False)

                last_error = f'HTTP {e.code}'
                break
            except urllib.error.URLError as e:
                last_error = str(e)
                break
            except Exception as e:
                last_error = str(e)
                break

    port = _plugin_config.get('native_server_port') or 12306
    return json.dumps({
        'error': f'BrowserPaw server not reachable ({last_error}). Ensure Chrome extension is loaded and native server is running on http://127.0.0.1:{port}/mcp.',
    })

def _register_bundled_skill(ctx: Any) -> None:
    skill_md = Path(__file__).resolve().parent / 'skills' / 'browserpaw' / 'SKILL.md'
    if not skill_md.is_file() or not hasattr(ctx, 'register_skill'):
        return
    try:
        ctx.register_skill(
            'browserpaw',
            skill_md,
            description='High-efficiency Chrome browser control and automation via BrowserPaw',
        )
    except Exception as exc:
        logger.debug('Failed to register bundled browserpaw skill: %s', exc)

TOOL_DEFINITIONS = {
    "browserpaw_get_windows_and_tabs": {
        "description": "Get all currently open browser windows and tabs",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    "browserpaw_navigate": {
        "description": "Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL to navigate to. Special values: \"back\" or \"forward\" to navigate browser history in the target tab."
                },
                "newWindow": {
                    "type": "boolean",
                    "description": "Create a new window to navigate to the URL or not. Defaults to false"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided)."
                },
                "background": {
                    "type": "boolean",
                    "description": "Perform the operation without stealing focus (do not activate the tab or focus the window). Default: true (set false only if user explicitly asks to bring tab to foreground)"
                },
                "width": {
                    "type": "number",
                    "description": "Window width in pixels (default: 1280). When width or height is provided, a new window will be created."
                },
                "height": {
                    "type": "number",
                    "description": "Window height in pixels (default: 720). When width or height is provided, a new window will be created."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false"
                },
                "groupTitle": {
                    "type": "string",
                    "description": "Task-aligned title for the Chrome tab group in user language (e.g. \"GitHub 搜索\", \"Flight Tracker\"). Fallback: \"Agent\""
                },
                "groupColor": {
                    "type": "string",
                    "enum": [
                        "grey",
                        "blue",
                        "red",
                        "yellow",
                        "green",
                        "pink",
                        "purple",
                        "cyan",
                        "orange"
                    ],
                    "description": "Color for the Chrome tab group. Fallback: \"blue\""
                },
                "autoGroup": {
                    "type": "boolean",
                    "description": "Automatically place newly opened tab into an Agent-managed tab group with dedicated title and color. Default: true"
                }
            },
            "required": []
        }
    },
    "browserpaw_screenshot": {
        "description": "[Prefer browserpaw_read_dom over taking a screenshot] Take a screenshot of the current page or a specific element. Returns base64 image directly in MCP image content block without writing to disk. By default, output is compressed JPEG with maxWidth <= 1280px. Debug disk save is available via savePng/saveToDisk into system temporary directory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name or label for the screenshot. Purely in-memory by default; only written to disk if savePng/saveToDisk is explicitly set to true."
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector for element to screenshot"
                },
                "assetIndex": {
                    "type": "number",
                    "description": "View one visual asset listed by browserpaw_read_dom ([asset N] lines): returns the real image resource; falls back to a viewport crop when bytes are unavailable"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID to capture from (default: active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID to pick active tab from when tabId is not provided."
                },
                "background": {
                    "type": "boolean",
                    "description": "Attempt capture without bringing tab/window to foreground. CDP-based capture is used for viewport captures. Default: true"
                },
                "width": {
                    "type": "number",
                    "description": "Width in pixels (default: 800)"
                },
                "height": {
                    "type": "number",
                    "description": "Height in pixels (default: 600)"
                },
                "maxWidth": {
                    "type": "number",
                    "description": "Maximum width in pixels for compression (default: 1280)"
                },
                "storeBase64": {
                    "type": "boolean",
                    "description": "Return screenshot in base64 format in text content (image content is always returned directly)"
                },
                "fullPage": {
                    "type": "boolean",
                    "description": "Capture a full-page scroll screenshot with GoFullPage-grade industrial stitching: automatic StyleStack fixed/sticky header de-duplication, page warmup for lazy-loading/skeletons, dynamic height change recovery, and captureVisibleTab quota backoff retry (default: false)."
                },
                "maxHeight": {
                    "type": "number",
                    "description": "Maximum height in pixels to capture for full-page screenshots (default: 50000, protects against infinite scroll runaway)."
                },
                "savePng": {
                    "type": "boolean",
                    "description": "Save screenshot to system temporary directory for debugging (default: false, zero disk write by default)"
                },
                "saveToDisk": {
                    "type": "boolean",
                    "description": "Deprecated alias for savePng (default: false, zero disk write by default; saves to system temp, not Downloads). Prefer savePng."
                },
                "som": {
                    "type": "boolean",
                    "description": "Overlay Set-of-Mark numbered badges on interactive elements before capturing the screenshot"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Deprecated alias for som; still accepted but hidden from the schema to keep it small. Prefer som."
                },
                "targetIndex": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of target element from browserpaw_read_dom to crop and capture only this specific region of interest"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for targetIndex: compact 1-based numeric index of target element from browserpaw_read_dom to crop and capture"
                },
                "padding": {
                    "type": "number",
                    "description": "Padding in pixels to expand around targetIndex crop area (default: 0)"
                },
                "region": {
                    "type": "object",
                    "description": "Lossless high-density ROI crop: capture only a specific sub-region { x0, y0, x1, y1 } in CSS pixels or polymorphic [ymin, xmin, ymax, xmax]. Completely avoids downscaling and preserves full pixel clarity for fine details like small text or dice dots.",
                    "properties": {
                        "x0": {
                            "type": "number"
                        },
                        "y0": {
                            "type": "number"
                        },
                        "x1": {
                            "type": "number"
                        },
                        "y1": {
                            "type": "number"
                        }
                    }
                },
                "crop": {
                    "type": "object",
                    "description": "Alias for region: { x, y, width, height } or { x0, y0, x1, y1 }."
                },
                "grid": {
                    "type": "boolean",
                    "description": "Overlay semi-transparent coordinate reference grid with perimeter tape measure rulers (20/50/100px ticks) and interior reticle crosshairs (+) to eliminate visual estimation hallucination (default: false)"
                },
                "enableGrid": {
                    "type": "boolean",
                    "description": "Alias for grid: overlay semi-transparent coordinate reference grid with perimeter tape measure rulers and crosshairs"
                },
                "expandSearchArea": {
                    "type": "boolean",
                    "description": "For small elements (< 100x100), adaptively expand the crop bounding box to preserve surrounding headers and text context (default: true)"
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "png",
                        "jpeg",
                        "webp"
                    ],
                    "description": "Image output format: webp (default, high compression for LLM), jpeg, or png"
                },
                "quality": {
                    "type": "number",
                    "description": "Image compression quality from 0 to 100 for webp/jpeg formats (default: 80)"
                },
                "highClarity": {
                    "type": "boolean",
                    "description": "Prioritize 100% full-resolution clarity without downsampling (disables dimension scaling, keeps 1:1 CSS pixel sharpness for reading fine details or dice dots)."
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserpaw_close_tabs": {
        "description": "Close one or more browser tabs",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Single tab ID to close (convenience alternative to tabIds array)."
                },
                "tabIds": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of tab IDs to close. If not provided, will close the active tab (requires confirm: true or session affinity)."
                },
                "url": {
                    "type": "string",
                    "description": "Close tabs matching this URL. Can be used instead of tabIds."
                },
                "confirm": {
                    "type": "boolean",
                    "description": "Explicit confirmation required to close the active tab when tabIds or url are not specified."
                },
                "allManagedGroups": {
                    "type": "boolean",
                    "description": "Close all Agent-managed tab groups and their tabs created during automation sessions. Default: false"
                }
            },
            "required": []
        }
    },
    "browserpaw_switch_tab": {
        "description": "Switch to a specific browser tab",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "The ID of the tab to switch to."
                },
                "windowId": {
                    "type": "number",
                    "description": "The ID of the window where the tab is located."
                },
                "background": {
                    "type": "boolean",
                    "description": "If true, binds session affinity only without activating the tab in the Chrome UI or stealing user focus. Default: false"
                }
            },
            "required": [
                "tabId"
            ]
        }
    },
    "browserpaw_read_dom": {
        "description": "Extract and prune interactive DOM tree with compact 1-based index assignment, viewport boundary filtering, and occlusion pruning. Supports scoped container targeting (selector) and noise exclusion (exclude) to eliminate full DOM dump overhead.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "scope": {
                    "type": "string",
                    "description": "Alias for selector. CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "isolateModal": {
                    "type": "boolean",
                    "description": "When true and an active modal dialog is detected, restricts indexing to the active modal while strictly protecting portals, dropdowns, and alert containers."
                },
                "exclude": {
                    "oneOf": [
                        {
                            "type": "string"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "string"
                            }
                        }
                    ],
                    "description": "CSS selector(s) to exclude from parsing (e.g. \"#footer, #recommendations, .ad-banner\"). Matching elements and their entire subtrees are pruned."
                },
                "viewportThreshold": {
                    "type": "number",
                    "description": "Vertical threshold in pixels for viewport boundary checking (default 1000)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Whether to visually highlight indexed elements"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "cursor": {
                    "type": "number",
                    "description": "Pagination cursor offset for traversing very large DOM pages incrementally (default: 0)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of indexed elements to return for current page cursor slice (default: unlimited)"
                },
                "maxTextLength": {
                    "type": "number",
                    "description": "Maximum text length before truncation for element text content (default: 120)"
                },
                "includeDetails": {
                    "type": "boolean",
                    "description": "Also return the bulky indexedElements/indexMap detail blocks (geometry, occlusion flags, safe click points). Off by default because the tree already carries index/tag/attributes/text; enable only when you need per-element rects or visibility flags."
                },
                "viewportOnly": {
                    "type": "boolean",
                    "description": "When true, only index elements inside or immediately near the visible viewport (default: false)"
                },
                "activeViewportOnly": {
                    "type": "boolean",
                    "description": "When true, strictly constrains indexing to elements currently visible within the active viewport (threshold = 0) with horizontal/vertical frustum clipping, eliminating ghost elements from SPA wizards, carousels, and multi-step forms."
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "compact",
                        "html"
                    ],
                    "description": "Output format for treeString. \"compact\" (default) produces a concise, accessibility-tree-inspired representation without closing tags, slashing token usage by 60%+. \"html\" returns legacy pseudo-HTML tags."
                },
                "deltaOnly": {
                    "type": "boolean",
                    "description": "When true, returns only changed/added/removed diffs compared to the previous snapshot, saving 90%+ tokens on repeated reads."
                }
            },
            "required": []
        }
    },
    "browserpaw_interact_index": {
        "description": "Click, hover, or interact with an element using its compact 1-based numeric index from browserpaw_read_dom. When performing predictable multi-step actions (e.g. form submission or chain navigation), prefer browserpaw_batch_actions to finish in a single round-trip.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of the target element"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Visual fallback coordinates in viewport/CSS pixels: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (supports 0~1.0 normalized, 0~1000 per-mille, or absolute viewport pixels across modern vision agents)."
                },
                "coordinateSpace": {
                    "type": "string",
                    "enum": [
                        "viewport",
                        "screenshot"
                    ],
                    "description": "Coordinate reference space. \"viewport\" (default) assumes standard CSS viewport pixels. \"screenshot\" scales coordinates based on the latest screenshot capture resolution."
                },
                "autoSnap": {
                    "type": "boolean",
                    "description": "When clicking via coordinates or visual fallback, magnetically snap to the closest interactive element if clicked within 24px of whitespace. Default: true."
                },
                "points": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Click sequence: dispatch a full CDP click at each viewport point with intervalMs pacing (rapid burst for moving canvas targets)"
                },
                "intervalMs": {
                    "type": "number",
                    "description": "Delay between points in the click sequence, 5-500ms (default 35)"
                },
                "action": {
                    "type": "string",
                    "enum": [
                        "click",
                        "hover",
                        "double_click",
                        "right_click",
                        "drag"
                    ],
                    "description": "Interaction action to perform (default: click). \"drag\" requires `end` and moves from the indexed element to that target."
                },
                "path": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Continuous drag path: an ordered array of { x, y } coordinates to smoothly drag the mouse through while pressed. Ideal for circular gestures, sliders, and drawing on canvas."
                },
                "end": {
                    "type": "object",
                    "properties": {
                        "index": {
                            "type": "number",
                            "description": "1-based index (from browserpaw_read_dom) of the drag destination element"
                        },
                        "coordinate": {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "Drag destination as viewport coordinates when no index is available"
                        }
                    },
                    "description": "Drag destination: { index } for an indexed element, or { coordinate: { x, y } } for a raw point. Required when action is \"drag\"."
                },
                "steps": {
                    "type": "number",
                    "description": "Number of intermediate mouse-move steps for drag (default 48; lower is faster, higher is smoother)"
                },
                "holdMs": {
                    "type": "number",
                    "description": "How long to hold the mouse button before dragging, in ms (default 80, range 0-3000)"
                },
                "dnd": {
                    "type": "boolean",
                    "description": "Use HTML5 drag-and-drop events (dragstart/dragover/drop) instead of raw mouse moves. Needed for React/HTML5 DnD lists."
                },
                "modifiers": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "Alt",
                            "Control",
                            "Meta",
                            "Shift"
                        ]
                    },
                    "description": "Keyboard modifiers to hold during interaction"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle (quiet for 150ms or timeout) after interaction before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "humanize": {
                    "type": "boolean",
                    "description": "Simulate realistic human-like cursor trajectory with micro-jitter before clicking (default: false)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by this interaction in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "pierceOverlay": {
                    "type": "boolean",
                    "description": "Automatically pierce non-opaque or transient backdrop masks/loading stubs when intercepted (default: true)"
                },
                "waitForNetworkQuiescence": {
                    "type": "boolean",
                    "description": "Wait for in-flight network requests to settle after this interaction before returning (default: false)"
                },
                "quiescenceTimeoutMs": {
                    "type": "number",
                    "description": "Network quiescence timeout in ms (default: 2000)"
                },
                "captureNetwork": {
                    "type": "object",
                    "properties": {
                        "urlPattern": {
                            "type": "string",
                            "description": "URL pattern or substring to match (e.g. \"*/api/order*\", \"/checkout\")"
                        },
                        "method": {
                            "type": "string",
                            "description": "Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time in milliseconds to wait for the matching network response (default: 5000ms)"
                        },
                        "statusCodes": {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Optional HTTP status codes to accept (e.g. [200, 201])"
                        }
                    },
                    "required": [
                        "urlPattern"
                    ],
                    "description": "Inline capture of network response triggered by this interaction in a single round-trip"
                }
            },
            "required": []
        }
    },
    "browserpaw_fill_index": {
        "description": "Fill text into an input or textarea element using its compact 1-based numeric index. For single search/form submission, pass pressEnter: true to fill and submit in 1 turn without needing a separate click. When filling multiple fields or clicking submit, use browserpaw_batch_actions to pipeline in 1 turn.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of the target element"
                },
                "text": {
                    "type": "string",
                    "description": "Text content to fill into the element"
                },
                "value": {
                    "type": "string",
                    "description": "Alias for text parameter"
                },
                "clear": {
                    "type": "boolean",
                    "description": "Whether to clear existing field content before typing (default: true)"
                },
                "pressEnter": {
                    "type": "boolean",
                    "description": "Whether to dispatch an Enter key event immediately after filling the text (default: false). Strongly recommended for search boxes and single-input queries to trigger immediate submission in 1 turn."
                },
                "submit": {
                    "type": "boolean",
                    "description": "Whether to automatically submit the form after filling (default: false). If true, clicks the detected submit button or presses Enter, completing fill + submit in 1 turn."
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle after filling text before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by filling in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": [
                "index"
            ]
        }
    },
    "browserpaw_batch_actions": {
        "description": "Execute a sequential multi-step pipeline of browser actions in a single round-trip without waiting for intermediate model turns.\n* CRITICAL EFFICIENCY RULE: When the next 2+ actions are predictable (e.g. form filling: [fill username, fill password, click submit]; or search flow: [fill query, press Enter, wait]), ALWAYS use browserpaw_batch_actions instead of individual tool calls. It completes the entire sequence in 1 turn (3~5x faster, 75%+ lower token cost).\n* Supported action types: click, double_click, right_click, fill, hover, scroll, press_key, wait, fill_form, assert, extract.\n* Set includeDelta: true to automatically inspect DOM changes after the pipeline completes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": [
                                    "click",
                                    "double_click",
                                    "right_click",
                                    "fill",
                                    "hover",
                                    "scroll",
                                    "press_key",
                                    "wait",
                                    "key",
                                    "fill_form",
                                    "assert",
                                    "extract"
                                ],
                                "description": "Action type to perform"
                            },
                            "index": {
                                "type": "number",
                                "description": "Element index (for click, fill, hover)"
                            },
                            "ref": {
                                "type": [
                                    "string",
                                    "number"
                                ],
                                "description": "Target element numeric index or ref from browserpaw_read_dom"
                            },
                            "selector": {
                                "type": "string",
                                "description": "CSS selector or XPath for target element"
                            },
                            "clear": {
                                "type": "boolean",
                                "description": "Clear field before typing (default: true)"
                            },
                            "pressEnter": {
                                "type": "boolean",
                                "description": "Whether to dispatch an Enter key event immediately after filling the text (for type: fill)"
                            },
                            "submit": {
                                "type": "boolean",
                                "description": "Whether to automatically submit the form after filling (clicks detected submit button or presses Enter) (for type: fill)"
                            },
                            "fields": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "ref": {
                                            "type": [
                                                "string",
                                                "number"
                                            ],
                                            "description": "Target element numeric index or ref from browserpaw_read_dom"
                                        },
                                        "index": {
                                            "type": "number",
                                            "description": "Alias for ref"
                                        },
                                        "selector": {
                                            "type": "string",
                                            "description": "CSS selector or XPath for target field"
                                        },
                                        "value": {
                                            "type": [
                                                "string",
                                                "number",
                                                "boolean"
                                            ],
                                            "description": "Value to fill or select"
                                        },
                                        "text": {
                                            "type": "string",
                                            "description": "Alias for value"
                                        },
                                        "clear": {
                                            "type": "boolean",
                                            "description": "Clear field before typing (default: true)"
                                        }
                                    },
                                    "required": []
                                },
                                "description": "Array of field descriptors to fill sequentially (for fill_form)"
                            },
                            "text": {
                                "type": "string",
                                "description": "Text to type/fill"
                            },
                            "value": {
                                "type": "string",
                                "description": "Alias for text"
                            },
                            "key": {
                                "type": "string",
                                "description": "Key name (for press_key)"
                            },
                            "coordinate": {
                                "oneOf": [
                                    {
                                        "type": "object",
                                        "properties": {
                                            "x": {
                                                "type": "number",
                                                "description": "X coordinate in viewport/CSS pixels"
                                            },
                                            "y": {
                                                "type": "number",
                                                "description": "Y coordinate in viewport/CSS pixels"
                                            }
                                        },
                                        "required": [
                                            "x",
                                            "y"
                                        ],
                                        "description": "{ x, y } coordinate object"
                                    },
                                    {
                                        "type": "array",
                                        "items": {
                                            "type": "number"
                                        },
                                        "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                                    }
                                ],
                                "description": "Unified coordinate object or array for click or scroll"
                            },
                            "x": {
                                "type": "number",
                                "description": "Coordinate X (for scroll/click, alias)"
                            },
                            "y": {
                                "type": "number",
                                "description": "Coordinate Y (for scroll/click, alias)"
                            },
                            "at": {
                                "type": "number",
                                "description": "Absolute epoch-ms deadline: sleep until this instant before executing this action (extension-side timer, no extra round-trip)"
                            },
                            "direction": {
                                "type": "string",
                                "enum": [
                                    "up",
                                    "down",
                                    "left",
                                    "right"
                                ],
                                "description": "Scroll direction (left/right dispatch horizontal wheel deltas)"
                            },
                            "amount": {
                                "type": "number",
                                "description": "Scroll pixel amount"
                            },
                            "durationMs": {
                                "type": "number",
                                "description": "Wait duration in ms"
                            },
                            "waitForSettle": {
                                "type": "boolean",
                                "description": "Wait for DOM mutations to settle after this specific action (default: false)"
                            },
                            "settleTimeoutMs": {
                                "type": "number",
                                "description": "Maximum settle timeout in milliseconds for this action (default: 1500)"
                            },
                            "waitForNetworkQuiescence": {
                                "type": "boolean",
                                "description": "Wait for in-flight network requests to settle before proceeding to next action (default: false)"
                            },
                            "quiescenceTimeoutMs": {
                                "type": "number",
                                "description": "Network quiescence timeout in ms (default: 2000)"
                            },
                            "pierceOverlay": {
                                "type": "boolean",
                                "description": "Automatically pierce non-opaque or transient backdrop masks for click actions (default: true)"
                            },
                            "preferComposer": {
                                "type": "boolean",
                                "description": "Prioritize rich composer/editor elements over generic search inputs when resolving textbox (default: false)"
                            },
                            "expectedText": {
                                "type": "string",
                                "description": "Expected text substring or exact match"
                            },
                            "condition": {
                                "type": "string",
                                "enum": [
                                    "contains",
                                    "not_contains",
                                    "equals",
                                    "matches",
                                    "visible",
                                    "not_visible",
                                    "enabled",
                                    "disabled",
                                    "valid",
                                    "invalid",
                                    "checked",
                                    "unchecked"
                                ],
                                "description": "Assertion condition: contains, not_contains, equals, matches (regex), visible, not_visible, enabled, disabled, valid, invalid, checked, unchecked (default: \"contains\")"
                            },
                            "timeoutMs": {
                                "type": "number",
                                "description": "Async polling timeout in milliseconds for assertion settling (default: 300ms)"
                            },
                            "abortOnFailure": {
                                "type": "boolean",
                                "description": "Abort batch if assertion fails (default: true)"
                            },
                            "property": {
                                "type": "string",
                                "enum": [
                                    "text",
                                    "value",
                                    "attribute"
                                ],
                                "description": "Property to extract (default: \"text\")"
                            },
                            "attributeName": {
                                "type": "string",
                                "description": "Attribute name when property is \"attribute\""
                            },
                            "variableName": {
                                "type": "string",
                                "description": "Key name under extractedData to store the result"
                            },
                            "captureNetwork": {
                                "type": "object",
                                "properties": {
                                    "urlPattern": {
                                        "type": "string",
                                        "description": "URL pattern or substring to match (e.g. \"*/api/order*\")"
                                    },
                                    "method": {
                                        "type": "string",
                                        "description": "Optional HTTP method to filter by (GET, POST, etc.)"
                                    },
                                    "timeoutMs": {
                                        "type": "number",
                                        "description": "Maximum time in milliseconds to wait for the network response (default: 5000ms)"
                                    },
                                    "statusCodes": {
                                        "type": "array",
                                        "items": {
                                            "type": "number"
                                        },
                                        "description": "Optional HTTP status codes to accept"
                                    }
                                },
                                "required": [
                                    "urlPattern"
                                ],
                                "description": "Inline capture of network response triggered by this action"
                            }
                        },
                        "required": [
                            "type"
                        ]
                    },
                    "description": "List of actions to execute sequentially"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle after all actions before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "waitForNetworkQuiescence": {
                    "type": "boolean",
                    "description": "Wait for in-flight network requests to settle after all actions before returning (default: false)"
                },
                "quiescenceTimeoutMs": {
                    "type": "number",
                    "description": "Network quiescence timeout in ms (default: 2000)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by the batch in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "captureNetwork": {
                    "type": "object",
                    "properties": {
                        "urlPattern": {
                            "type": "string",
                            "description": "URL pattern or substring to match (e.g. \"*/api/order*\", \"/checkout\")"
                        },
                        "method": {
                            "type": "string",
                            "description": "Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time in milliseconds to wait for the matching network response (default: 5000ms)"
                        },
                        "statusCodes": {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Optional HTTP status codes to accept (e.g. [200, 201])"
                        }
                    },
                    "required": [
                        "urlPattern"
                    ],
                    "description": "Inline capture of network response triggered during batch execution in a single round-trip"
                }
            },
            "required": [
                "actions"
            ]
        }
    },
    "browserpaw_get_markdown": {
        "description": "Extract clean, structured hierarchical markdown from the active tab DOM stripped of SPA state blobs, hidden text, and scripts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeLinks": {
                    "type": "boolean",
                    "description": "Whether to preserve hyperlinks in markdown (default: true)"
                },
                "fit": {
                    "type": "boolean",
                    "description": "Content-only extraction: restrict to the main content region and strip nav/header/footer/aside/form noise before conversion (default: false)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserpaw_smart_scroll": {
        "description": "Intelligently detects and scrolls the most prominent scrollable container on the page, or targets a specific container by selector, ref, or coordinate with automatic progress calculation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session ID for tab affinity (optional)"
                },
                "direction": {
                    "type": "string",
                    "enum": [
                        "down",
                        "up",
                        "left",
                        "right"
                    ],
                    "description": "Scroll direction (default: \"down\")"
                },
                "amount": {
                    "type": "string",
                    "description": "Scroll amount: number in pixels, \"page\" (viewport height), or \"half_page\" (default: \"page\")"
                },
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector of the scroll container to target"
                },
                "ref": {
                    "type": "number",
                    "description": "Optional 1-based numeric index of the scroll container to target"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for ref: 1-based numeric index of the scroll container to target"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Optional coordinate to locate the scrollable container under pointer: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box"
                },
                "smooth": {
                    "type": "boolean",
                    "description": "Whether to use smooth scrolling behavior (default: true)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM and network activity to settle after scroll completes (default: true)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle wait timeout in ms (default: 1500)"
                }
            },
            "required": []
        }
    },
    "browserpaw_tool_docs": {
        "description": "Return compact parameter documentation for a category of BrowserPaw tools (navigate | perceive | act | observe | manage | crawl | diagnose | network). Use when a workflow needs a tool that is not in the current profile view.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": [
                        "navigate",
                        "perceive",
                        "act",
                        "observe",
                        "manage",
                        "crawl",
                        "diagnose",
                        "network"
                    ],
                    "description": "Tool category to document"
                },
                "activateForSession": {
                    "type": "boolean",
                    "description": "When true, dynamically exposes all tools in this category for the current MCP session without server restart. Default: false"
                }
            },
            "required": [
                "category"
            ]
        }
    },
    "browserpaw_inspect_media": {
        "description": "Inspect and extract high-fidelity media assets (images, canvas, captchas, icons) directly by element index or selector. Uses in-memory lossless extraction for <img>/<canvas>, with super-sampled 200%+ crop fallback for complex DOM containers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "1-based element index from browserpaw_read_dom"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector fallback"
                },
                "zoom": {
                    "type": "number",
                    "description": "Super-sampling zoom factor (default: 2.0)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID"
                }
            }
        }
    },
    "browserpaw_grep": {
        "description": "Search the page without dumping full DOM tree. Supports searching interactive elements (returning indices for browserpaw_interact_index), all DOM nodes, or raw visible text lines.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term or regex pattern"
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Whether to evaluate query as a regular expression (default: false)"
                },
                "searchType": {
                    "type": "string",
                    "enum": [
                        "interactive_only",
                        "all_dom",
                        "page_text"
                    ],
                    "description": "Search target: \"interactive_only\" (default, matches clickable/fillable elements and returns indices), \"all_dom\" (matches all elements), \"page_text\" (scans visible text lines)."
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum matching results to return (default: 20, max: 50)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity (optional)"
                }
            },
            "required": [
                "query"
            ]
        }
    },
    "browserpaw_act_toward_goal": {
        "description": "Autonomous semantic micro-loop that perceives, decides, and acts toward a natural-language goal within a local Native Server loop (~200-400ms/step). Powered by TypeSafe Jev System One with seamless fallback to heuristic scoring when no API key is available or on quota/network degradation. Automatically escalates ambiguous, destructive, or complex actions back to the macro planner with pre-fetched page context.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "Natural language goal or objective to advance toward on the current page"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional, defaults to active tab)"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum decision steps before terminating (default: 10, max: 60; heuristic capped at <= 5)"
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Total execution timeout in milliseconds (default: 90000, max: 300000)"
                },
                "textHint": {
                    "type": "string",
                    "description": "Explicit text hint to enter when typing, if not clearly quoted in goal"
                },
                "confidenceThreshold": {
                    "type": "number",
                    "description": "Minimum confidence threshold to commit an action (default: 0.55)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "sessionContext": {
                    "type": "string",
                    "description": "Optional alias for sessionId"
                }
            },
            "required": [
                "goal"
            ]
        }
    },
    "browserpaw_scroll_until_found": {
        "description": "Performs client-side step-by-step scrolling until an element matching a text query, regex, or selector is found. Waits for virtual lists (DOM recycling) to settle at each step, searches light and shadow DOM, centers the target in the viewport, and returns its 1-based index and safe coordinates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text query or keyword to search for during scrolling"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector to search for during scrolling (supports >>> and /deep/ shadow piercing)"
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Treat query as a regular expression pattern (default: false)"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum number of scroll steps before giving up (default: 10, max: 50)"
                },
                "stepPx": {
                    "type": "number",
                    "description": "Scroll distance in pixels per step (default: 800)"
                },
                "direction": {
                    "type": "string",
                    "enum": ["down", "up"],
                    "description": "Scroll direction (default: \"down\")"
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Timeout in milliseconds for the overall scrolling operation (default: 15000)"
                },
                "containerSelector": {
                    "type": "string",
                    "description": "CSS selector for a custom scrollable container (defaults to window)"
                },
                "settleMs": {
                    "type": "number",
                    "description": "Delay in milliseconds to wait for virtual lists / DOM recycling after each scroll (default: 150)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional, defaults to active tab)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity binding"
                },
                "sessionContext": {
                    "type": "string",
                    "description": "Optional alias for sessionId"
                }
            },
            "required": []
        }
    }
}

def _make_handler(tool_name: str) -> Callable:
    def handler(args: dict, **kwargs: Any) -> str:
        try:
            return _call_browserpaw(tool_name, args)
        except Exception as e:
            return json.dumps({'error': str(e)}, ensure_ascii=False)
    return handler

# ── BROWSERPAW CANONICAL SPECS ───────────────────────────────────────

BROWSERPAW_SPECS: Dict[str, Dict[str, Any]] = {
    "browserpaw_act_toward_goal": {"emoji": "💫"},
    "browserpaw_navigate": {"emoji": "🌐"},
    "browserpaw_read_dom": {"emoji": "🔍"},
    "browserpaw_interact_index": {"emoji": "🎯"},
    "browserpaw_fill_index": {"emoji": "✍️"},
    "browserpaw_batch_actions": {"emoji": "⚡"},
    "browserpaw_screenshot": {"emoji": "📸"},
    "browserpaw_smart_scroll": {"emoji": "📜"},
    "browserpaw_inspect_media": {"emoji": "🖼️"},
    "browserpaw_grep": {"emoji": "🔎"},
    "browserpaw_scroll_until_found": {"emoji": "📜"},
    "browserpaw_get_markdown": {"emoji": "📄"},
    "browserpaw_switch_tab": {"emoji": "🔀"},
    "browserpaw_close_tabs": {"emoji": "❌"},
    "browserpaw_get_windows_and_tabs": {"emoji": "🪟"},
    "browserpaw_tool_docs": {"emoji": "📚"},
}


def register(ctx: Any) -> None:
    global _plugin_config
    if hasattr(ctx, 'get_config'):
        try:
            _plugin_config['native_server_port'] = int(ctx.get_config('native_server_port', 12306) or 12306)
            _plugin_config['isolate_modal'] = bool(ctx.get_config('isolate_modal', False))
        except Exception as exc:
            logger.debug('Failed to read plugin config: %s', exc)

    # Catalog rule 11: the bridge token is read from the Hermes secret scope only.
    if hasattr(ctx, 'secret_scope'):
        _plugin_config['secret_scope'] = ctx.secret_scope

    _register_bundled_skill(ctx)

    for tool_name, meta in TOOL_DEFINITIONS.items():
        spec = BROWSERPAW_SPECS.get(tool_name, {})
        emoji = spec.get("emoji", "🌐")
        schema = {
            'name': tool_name,
            'description': meta['description'],
            'parameters': meta['inputSchema'],
        }
        handler = _make_handler(tool_name)
        if hasattr(ctx, 'register_tool'):
            ctx.register_tool(
                name=tool_name,
                toolset='browserpaw',
                schema=schema,
                handler=handler,
                description=meta['description'],
                emoji=emoji,
            )


def browserpaw_scroll_until_found(
    query: Optional[str] = None,
    selector: Optional[str] = None,
    is_regex: bool = False,
    max_steps: int = 10,
    step_px: int = 800,
    direction: str = 'down',
    timeout_ms: int = 15000,
    container_selector: Optional[str] = None,
    settle_ms: int = 150,
    tab_id: Optional[int] = None,
    session_id: Optional[str] = None,
) -> str:
    """Scroll step-by-step in the active page until an element matching query or selector is found.

    Executes in-page client-side RAF/step scrolling, waiting for virtual lists to render at each step,
    probing open and shadow DOM trees. Upon finding, stops scrolling, centers the element in the viewport,
    and returns its 1-based index and safe coordinates.
    """
    args: Dict[str, Any] = {
        'isRegex': is_regex,
        'maxSteps': max_steps,
        'stepPx': step_px,
        'direction': direction,
        'timeoutMs': timeout_ms,
        'settleMs': settle_ms,
    }
    if query:
        args['query'] = query
    if selector:
        args['selector'] = selector
    if container_selector:
        args['containerSelector'] = container_selector
    if tab_id is not None:
        args['tabId'] = tab_id
    if session_id:
        args['sessionId'] = session_id

    return _call_browserpaw('browserpaw_scroll_until_found', args)
