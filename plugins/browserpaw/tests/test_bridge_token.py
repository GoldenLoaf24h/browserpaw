"""Tests for native-bridge token resolution in the Hermes plugin.

Run from the repo root:
    python -m pytest -q plugins/browserpaw/tests
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import urllib.request
from pathlib import Path
from unittest import mock

import pytest

PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'


@pytest.fixture(scope='module')
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_plugin_under_test', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

@pytest.fixture(autouse=True)
def reset_plugin_session(plugin):
    plugin._reset_session(clear_invalid=True)
    yield
    plugin._reset_session(clear_invalid=True)




def _mock_secret_scope(token):
    mod = mock.MagicMock()
    mod.get_secret = mock.MagicMock(return_value=token)
    return mod


def test_token_from_secret_scope(plugin):
    fake = _mock_secret_scope("secret123")
    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        assert plugin._bridge_token() == "secret123"
    fake.get_secret.assert_called_once_with("BROWSERPAW_MCP_TOKEN")


def test_token_stripped(plugin):
    fake = _mock_secret_scope("  pawtoken\n")
    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        assert plugin._bridge_token() == "pawtoken"


def test_none_when_secret_missing(plugin):
    fake = _mock_secret_scope(None)
    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        assert plugin._bridge_token() is None


def test_none_when_import_fails(plugin):
    with mock.patch.dict("sys.modules", {"agent.secret_scope": None}):
        assert plugin._bridge_token() is None


class _FakeResponse:
    def __init__(self, payload: dict, headers: Optional[dict] = None):
        self._data = json.dumps(payload).encode('utf-8')
        self._stream = io.BytesIO(self._data)
        self.headers = headers or {'mcp-session-id': 'sess-test-123'}

    def read(self, *args, **kwargs):
        return self._stream.read(*args, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


def _fake_response(payload: dict, headers: Optional[dict] = None) -> _FakeResponse:
    return _FakeResponse(payload, headers)


def test_call_sends_bearer_header(plugin):
    captured = []

    fake = _mock_secret_scope("secret123")

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return _fake_response({'jsonrpc': '2.0', 'id': 1, 'result': {}})

    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
            out = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})

    assert json.loads(out) == {}
    # All MCP lifecycle requests (initialize, notifications/initialized, tools/call) must carry Bearer token
    assert len(captured) >= 1
    for req in captured:
        assert req.get_header('Authorization') == 'Bearer secret123'

    # Verify tools/call request was dispatched with expected tool name
    tool_req = next(
        r for r in captured
        if json.loads(r.data.decode('utf-8') if isinstance(r.data, bytes) else r.data).get('method') == 'tools/call'
    )
    assert json.loads(tool_req.data)['params']['name'] == 'get_windows_and_tabs'

    # Verify subsequent call within active session makes exactly 1 tools/call request
    captured.clear()
    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
            out2 = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})
    assert json.loads(out2) == {}
    assert len(captured) == 1
    assert captured[0].get_header('Authorization') == 'Bearer secret123'


def test_call_without_token_sends_no_auth_header(plugin):
    captured = []

    fake = _mock_secret_scope(None)

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return _fake_response({'result': {}})

    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
            plugin._call_browserpaw('browserpaw_navigate', {'url': 'https://example.com'})

    assert len(captured) >= 1
    for req in captured:
        assert req.get_header('Authorization') is None


def test_401_returns_actionable_error_without_leaking_token(plugin):

    fake = _mock_secret_scope("supersecret")

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', None, io.BytesIO(b''))

    with mock.patch.dict("sys.modules", {"agent.secret_scope": fake}):
        with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
            out = json.loads(plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {}))

    assert '401' in out['error']
    assert 'BROWSERPAW_MCP_TOKEN' in out['error']
    assert 'supersecret' not in out['error']


def test_codex_mcp_config_contract():
    """Validates .mcp.json and .codex-plugin/plugin.json align with official Codex Plugin specs."""
    mcp_path = Path(__file__).resolve().parents[1] / '.mcp.json'
    assert mcp_path.exists(), '.mcp.json must exist at plugin root'
    mcp_data = json.loads(mcp_path.read_text(encoding='utf-8'))
    assert 'mcpServers' in mcp_data
    assert 'browserpaw' in mcp_data['mcpServers']
    server = mcp_data['mcpServers']['browserpaw']
    assert server.get('type') == 'http'
    assert server.get('url') == 'http://127.0.0.1:12306/mcp'
    assert server.get('bearer_token_env_var') == 'CHROME_MCP_TOKEN'

    plugin_json_path = Path(__file__).resolve().parents[1] / '.codex-plugin' / 'plugin.json'
    assert plugin_json_path.exists(), 'plugin.json must exist in .codex-plugin'
    plugin_data = json.loads(plugin_json_path.read_text(encoding='utf-8'))
    assert plugin_data.get('version') == '4.0.0'
    assert plugin_data.get('mcpServers') == './.mcp.json'
