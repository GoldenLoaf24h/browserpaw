"""Tests for MCP 2024-11-05 session handshake, session id management, and auto-recovery.

Run from the repo root:
    uv run --with pytest pytest -v plugins/browserpaw/tests/test_mcp_session.py
"""
from __future__ import annotations

import concurrent.futures
import importlib.util
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import pytest

PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'


class MockHTTPResponse:
    def __init__(self, payload: dict, headers: dict | None = None, status: int = 200):
        self._data = json.dumps(payload).encode('utf-8')
        self._stream = io.BytesIO(self._data)
        self.headers = headers or {}
        self.status = status

    def read(self, *args, **kwargs):
        return self._stream.read(*args, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


@pytest.fixture(scope='module')
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_mcp_session_test', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def clean_session_state(plugin, monkeypatch):
    plugin._reset_session(clear_invalid=True)
    monkeypatch.delenv('BROWSERPAW_MCP_TOKEN', raising=False)
    monkeypatch.delenv('CHROME_MCP_TOKEN', raising=False)
    monkeypatch.delenv('BROWSERPAW_MCP_SESSION_ID', raising=False)
    monkeypatch.delenv('CHROME_MCP_SESSION_ID', raising=False)
    yield
    plugin._reset_session(clear_invalid=True)


def test_handshake_sends_initialize_with_spec_version_and_client_info(plugin):
    """Verify handshake sends JSON-RPC 2.0 initialize with protocolVersion 2024-11-05 and client capabilities."""
    captured_requests = []

    def mock_urlopen(req, timeout=None):
        captured_requests.append(req)
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            return MockHTTPResponse(
                {
                    'jsonrpc': '2.0',
                    'id': body['id'],
                    'result': {
                        'protocolVersion': '2024-11-05',
                        'capabilities': {},
                        'serverInfo': {'name': 'browserpaw-native', 'version': '2.9.2'},
                    },
                },
                headers={'mcp-session-id': 'sess-uuid-1001'},
            )
        elif method == 'notifications/initialized':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'sess-uuid-1001'})
        elif method == 'tools/call':
            return MockHTTPResponse(
                {
                    'jsonrpc': '2.0',
                    'id': body['id'],
                    'result': {'content': [{'type': 'text', 'text': 'tabs-data'}]},
                },
                headers={'mcp-session-id': 'sess-uuid-1001'},
            )
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    assert 'tabs-data' in res
    assert len(captured_requests) == 3

    # Request 0: initialize
    init_body = json.loads(captured_requests[0].data.decode('utf-8'))
    assert init_body['method'] == 'initialize'
    assert init_body['params']['protocolVersion'] == '2024-11-05'
    assert init_body['params']['clientInfo']['name'] == 'browserpaw-python-plugin'
    assert 'capabilities' in init_body['params']
    assert captured_requests[0].get_header('Content-type') == 'application/json'
    assert 'text/event-stream' in captured_requests[0].get_header('Accept')
    assert captured_requests[0].get_header('Mcp-session-id') is None

    # Request 1: notifications/initialized
    notify_body = json.loads(captured_requests[1].data.decode('utf-8'))
    assert notify_body['method'] == 'notifications/initialized'
    assert 'id' not in notify_body  # notifications must not have an id
    assert captured_requests[1].get_header('Mcp-session-id') == 'sess-uuid-1001'
    assert captured_requests[1].get_header('Mcp-protocol-version') == '2024-11-05'

    # Request 2: tools/call
    call_body = json.loads(captured_requests[2].data.decode('utf-8'))
    assert call_body['method'] == 'tools/call'
    assert call_body['params']['name'] == 'get_windows_and_tabs'
    assert captured_requests[2].get_header('Mcp-session-id') == 'sess-uuid-1001'
    assert captured_requests[2].get_header('Mcp-protocol-version') == '2024-11-05'

    # Check that session id is actively stored
    assert plugin._get_active_session_id() == 'sess-uuid-1001'


def test_session_reuse_for_subsequent_tool_calls(plugin):
    """Verify that once a session is established, subsequent tool calls do not repeat initialize."""
    captured_requests = []

    def mock_urlopen(req, timeout=None):
        captured_requests.append(req)
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {}},
                headers={'mcp-session-id': 'sess-uuid-2002'},
            )
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {'status': 'ok'}},
                headers={'mcp-session-id': 'sess-uuid-2002'},
            )
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        # Call 1: triggers handshake
        plugin._call_browserpaw('browserpaw_navigate', {'url': 'https://example.com'})
        assert len(captured_requests) == 3

        # Call 2: reuses session
        captured_requests.clear()
        plugin._call_browserpaw('browserpaw_read_dom', {})
        assert len(captured_requests) == 1
        assert captured_requests[0].get_header('Mcp-session-id') == 'sess-uuid-2002'
        body2 = json.loads(captured_requests[0].data.decode('utf-8'))
        assert body2['method'] == 'tools/call'
        assert body2['params']['name'] == 'chrome_read_dom'

        # Call 3: reuses session again
        captured_requests.clear()
        plugin._call_browserpaw('browserpaw_smart_scroll', {'direction': 'down'})
        assert len(captured_requests) == 1
        assert captured_requests[0].get_header('Mcp-session-id') == 'sess-uuid-2002'


def test_automatic_recovery_on_http_400_invalid_session(plugin):
    """Verify automatic recovery when server returns HTTP 400 Invalid MCP request or session."""
    # Pre-populate an invalid/stale session
    plugin._set_active_session_id('stale-session-400', 'http://127.0.0.1:12306/mcp')

    call_count = 0
    captured_requests = []

    def mock_urlopen(req, timeout=None):
        nonlocal call_count
        call_count += 1
        captured_requests.append(req)
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')

        # First request is tools/call with stale session -> simulate Native Server 400
        if method == 'tools/call' and req.get_header('Mcp-session-id') == 'stale-session-400':
            raise urllib.error.HTTPError(
                req.full_url,
                400,
                'Bad Request',
                None,
                io.BytesIO(b'{"error": "Invalid MCP request or session"}'),
            )
        elif method == 'initialize':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {}},
                headers={'mcp-session-id': 'fresh-session-400'},
            )
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call' and req.get_header('Mcp-session-id') == 'fresh-session-400':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {'recovered': True}},
                headers={'mcp-session-id': 'fresh-session-400'},
            )
        raise ValueError(f'Unexpected state on call #{call_count}: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    parsed = json.loads(res)
    assert parsed.get('recovered') is True
    # Requests:
    # 1. tools/call with stale session -> 400
    # 2. initialize -> 200 with fresh session
    # 3. notifications/initialized
    # 4. tools/call with fresh session -> 200
    assert len(captured_requests) == 4
    assert captured_requests[0].get_header('Mcp-session-id') == 'stale-session-400'
    assert json.loads(captured_requests[1].data.decode('utf-8'))['method'] == 'initialize'
    assert captured_requests[2].get_header('Mcp-session-id') == 'fresh-session-400'
    assert captured_requests[3].get_header('Mcp-session-id') == 'fresh-session-400'
    assert plugin._get_active_session_id() == 'fresh-session-400'


def test_automatic_recovery_on_http_404_session_expired(plugin):
    """Verify automatic recovery when server returns HTTP 404 (e.g. server restarted or idle reap)."""
    plugin._set_active_session_id('expired-session-404', 'http://127.0.0.1:12306/mcp')
    captured_requests = []

    def mock_urlopen(req, timeout=None):
        captured_requests.append(req)
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')

        if method == 'tools/call' and req.get_header('Mcp-session-id') == 'expired-session-404':
            raise urllib.error.HTTPError(
                req.full_url,
                404,
                'Not Found',
                None,
                io.BytesIO(b'{"error": "Invalid or missing MCP session ID."}'),
            )
        elif method == 'initialize':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {}},
                headers={'mcp-session-id': 'reconnected-session-404'},
            )
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call' and req.get_header('Mcp-session-id') == 'reconnected-session-404':
            return MockHTTPResponse(
                {'jsonrpc': '2.0', 'id': body['id'], 'result': {'success': True}},
                headers={'mcp-session-id': 'reconnected-session-404'},
            )
        raise ValueError(f'Unexpected request: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_switch_tab', {'tabId': 10})

    assert json.loads(res).get('success') is True
    assert len(captured_requests) == 4
    assert plugin._get_active_session_id() == 'reconnected-session-404'


def test_token_auth_carried_across_handshake_and_tool_calls(plugin, monkeypatch):
    """Verify Authorization: Bearer <token> is sent on initialize, notifications, and tool calls."""
    monkeypatch.setenv('BROWSERPAW_MCP_TOKEN', 'token-abc-999')
    captured_auth_headers = []

    def mock_urlopen(req, timeout=None):
        captured_auth_headers.append(req.get_header('Authorization'))
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'auth-sess-1'})
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call':
            return MockHTTPResponse({'result': {'auth': 'ok'}})
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    assert len(captured_auth_headers) == 3
    assert all(h == 'Bearer token-abc-999' for h in captured_auth_headers)


def test_session_override_via_env_var(plugin, monkeypatch):
    """Verify that setting BROWSERPAW_MCP_SESSION_ID skips initialize handshake."""
    monkeypatch.setenv('BROWSERPAW_MCP_SESSION_ID', 'pre-pinned-session')
    captured_requests = []

    def mock_urlopen(req, timeout=None):
        captured_requests.append(req)
        return MockHTTPResponse({'result': {'pinned': True}})

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    assert json.loads(res).get('pinned') is True
    # Should only make 1 call directly with the pinned session
    assert len(captured_requests) == 1
    assert captured_requests[0].get_header('Mcp-session-id') == 'pre-pinned-session'
    assert json.loads(captured_requests[0].data.decode('utf-8'))['method'] == 'tools/call'


def test_thread_safe_concurrent_initialization(plugin):
    """Verify multiple concurrent tool calls execute handshake cleanly without duplicate initialize races."""
    init_counter = 0

    def mock_urlopen(req, timeout=None):
        nonlocal init_counter
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            init_counter += 1
            import time
            time.sleep(0.05)  # Simulate network latency to test concurrency race
            return MockHTTPResponse({}, headers={'mcp-session-id': 'concurrent-session-id'})
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call':
            return MockHTTPResponse({'result': {'done': True}})
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [
                executor.submit(plugin._call_browserpaw, 'browserpaw_get_windows_and_tabs', {})
                for _ in range(5)
            ]
            results = [f.result() for f in futures]

    for res in results:
        assert json.loads(res).get('done') is True

    # Handshake initialize MUST have been called exactly once despite 5 concurrent calls
    assert init_counter == 1
    assert plugin._get_active_session_id() == 'concurrent-session-id'


def test_auth_401_on_initialize_returns_actionable_error_immediately(plugin):
    """Verify HTTP 401 on initialize does not retry and returns actionable _AUTH_HELP."""
    def mock_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url,
            401,
            'Unauthorized',
            None,
            io.BytesIO(b'{"error": "Unauthorized"}'),
        )

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    parsed = json.loads(res)
    assert '401' in parsed['error']
    assert 'bridge token missing or invalid' in parsed['error']


def test_server_http_error_body_and_hint_returned_accurately(plugin):
    """Verify that HTTP error body and diagnostic hint from Native Server are returned to caller."""
    def mock_urlopen(req, timeout=None):
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'sess-err-hint'})
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call':
            # Server returns 400 Bad Request with actionable hint on tools/call
            raise urllib.error.HTTPError(
                req.full_url,
                400,
                'Bad Request',
                None,
                io.BytesIO(b'{"error": "Invalid tabId", "hint": "Provide a valid numeric tab ID."}'),
            )
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_switch_tab', {'tabId': -999})

    parsed = json.loads(res)
    assert 'error' in parsed
    # Must contain both the error message and the hint, NOT "server not reachable"
    assert 'Invalid tabId' in parsed['error']
    assert 'Provide a valid numeric tab ID' in parsed['error']
    assert 'not reachable' not in parsed['error']


def test_handshake_jsonrpc_error_surfaces_informative_error(plugin):
    """Verify that when initialize returns a JSON-RPC error payload, it is surfaced cleanly."""
    def mock_urlopen(req, timeout=None):
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        if method == 'initialize':
            return MockHTTPResponse({
                'jsonrpc': '2.0',
                'id': body['id'],
                'error': {'code': -32600, 'message': 'Unsupported protocol version: 2024-11-05'},
            })
        raise ValueError(f'Unexpected method: {method}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        res = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    parsed = json.loads(res)
    assert 'error' in parsed
    assert 'MCP initialize rejected' in parsed['error']
    assert 'Unsupported protocol version' in parsed['error']


def test_stale_configured_session_marked_invalid_and_recovered(plugin, monkeypatch):
    """Verify that a stale pre-configured session env var is invalidated and recovered transparently."""
    monkeypatch.setenv('BROWSERPAW_MCP_SESSION_ID', 'bad-configured-session')
    call_log = []

    def mock_urlopen(req, timeout=None):
        body = json.loads(req.data.decode('utf-8'))
        method = body.get('method')
        session_header = req.get_header('Mcp-session-id')
        call_log.append((method, session_header))

        if method == 'tools/call' and session_header == 'bad-configured-session':
            raise urllib.error.HTTPError(
                req.full_url,
                400,
                'Bad Request',
                None,
                io.BytesIO(b'{"error": "Invalid MCP request or session"}'),
            )
        elif method == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'new-recovered-session'})
        elif method == 'notifications/initialized':
            return MockHTTPResponse({})
        elif method == 'tools/call' and session_header == 'new-recovered-session':
            return MockHTTPResponse({'result': {'recovered': True}})
        raise ValueError(f'Unexpected request: {method} with {session_header}')

    with mock.patch.object(urllib.request, 'urlopen', mock_urlopen):
        # First call: encounters bad-configured-session, invalidates it, handshakes, and succeeds
        res1 = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})
        assert json.loads(res1).get('recovered') is True

        # Second call: must NOT use bad-configured-session again! Must use new-recovered-session
        call_log.clear()
        res2 = plugin._call_browserpaw('browserpaw_read_dom', {})
        assert json.loads(res2).get('recovered') is True

    # Call 2 should only make 1 request using new-recovered-session
    assert len(call_log) == 1
    assert call_log[0] == ('tools/call', 'new-recovered-session')


def test_align_response_tool_names(plugin):
    """Verify that legacy chrome_* and get_windows_and_tabs tool references in output are rewritten to browserpaw_*."""
    legacy_text = (
        'Delta truncated: showing 0/0 added, 25/143 modified, 1/1 removed. '
        'Call chrome_read_dom for full DOM tree. Prefer chrome_batch_actions '
        'or chrome_interact_index. Also check get_windows_and_tabs. '
        'Ignore chrome://extensions and https://chrome.google.com.'
    )
    aligned = plugin._align_response_tool_names(legacy_text)
    assert 'Call browserpaw_read_dom for full DOM tree.' in aligned
    assert 'Prefer browserpaw_batch_actions' in aligned
    assert 'or browserpaw_interact_index.' in aligned
    assert 'Also check browserpaw_get_windows_and_tabs.' in aligned
    # Ensure protocols and non-tool names are preserved
    assert 'chrome://extensions' in aligned
    assert 'https://chrome.google.com' in aligned

