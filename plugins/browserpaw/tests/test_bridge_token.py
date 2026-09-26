"""Tests for native-bridge token resolution in the Hermes plugin.

Run from the repo root:
    python -m pytest -q plugins/browserpaw/tests
"""
from __future__ import annotations

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


@pytest.fixture(scope='module')
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_plugin_under_test', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: tmp_path))
    monkeypatch.delenv('BROWSERPAW_MCP_TOKEN', raising=False)
    monkeypatch.delenv('CHROME_MCP_TOKEN', raising=False)
    monkeypatch.setattr(urllib.request, 'urlopen', lambda *args, **kwargs: (_ for _ in ()).throw(urllib.error.URLError('offline in unit test')))
    return tmp_path


def _write_token_file(home: Path, text: str) -> None:
    (home / '.chrome-mcp').mkdir()
    (home / '.chrome-mcp' / 'bridge-token').write_text(text, encoding='utf-8')


def test_none_when_nothing_configured(plugin, home):
    assert plugin._bridge_token() is None


def test_file_fallback_is_stripped(plugin, home):
    _write_token_file(home, '  filetoken\n')
    assert plugin._bridge_token() == 'filetoken'


def test_empty_file_yields_none(plugin, home):
    _write_token_file(home, '\n')
    assert plugin._bridge_token() is None


def test_chrome_env_beats_file(plugin, home, monkeypatch):
    _write_token_file(home, 'filetoken')
    monkeypatch.setenv('CHROME_MCP_TOKEN', 'chrometoken')
    assert plugin._bridge_token() == 'chrometoken'


def test_browserpaw_env_beats_chrome_env(plugin, home, monkeypatch):
    monkeypatch.setenv('CHROME_MCP_TOKEN', 'chrometoken')
    monkeypatch.setenv('BROWSERPAW_MCP_TOKEN', ' pawtoken ')
    assert plugin._bridge_token() == 'pawtoken'


@pytest.fixture(autouse=True)
def reset_plugin_session(plugin):
    plugin._reset_session(clear_invalid=True)
    yield
    plugin._reset_session(clear_invalid=True)


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


def test_call_sends_bearer_header(plugin, home, monkeypatch):
    monkeypatch.setenv('BROWSERPAW_MCP_TOKEN', 'secret123')
    captured = []

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return _fake_response({'jsonrpc': '2.0', 'id': 1, 'result': {}})

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
    with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
        out2 = plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {})
    assert json.loads(out2) == {}
    assert len(captured) == 1
    assert captured[0].get_header('Authorization') == 'Bearer secret123'


def test_call_without_token_sends_no_auth_header(plugin, home):
    captured = []

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return _fake_response({'result': {}})

    with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
        plugin._call_browserpaw('browserpaw_navigate', {'url': 'https://example.com'})

    assert len(captured) >= 1
    for req in captured:
        assert req.get_header('Authorization') is None


def test_401_returns_actionable_error_without_leaking_token(plugin, home, monkeypatch):
    monkeypatch.setenv('BROWSERPAW_MCP_TOKEN', 'supersecret')

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', None, io.BytesIO(b''))

    with mock.patch.object(urllib.request, 'urlopen', fake_urlopen):
        out = json.loads(plugin._call_browserpaw('browserpaw_get_windows_and_tabs', {}))

    assert '401' in out['error']
    assert 'BROWSERPAW_MCP_TOKEN' in out['error']
    assert 'supersecret' not in out['error']
