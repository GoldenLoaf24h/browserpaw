"""Tests for BrowserPaw security, isolation, and forwarding contract.

Verifies:
- No secret-scope or environment token lookups.
- Environment variables (tokens, session IDs) are ignored.
- Input arguments dictionary is never mutated.
- PermissionError and other errors are cleanly surfaced without leaking tokens.
- .mcp.json and plugin.json contract alignment.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from unittest import mock
import pytest

PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'


@pytest.fixture
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_sec_test', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_no_secret_scope_or_env_token_access(plugin, monkeypatch):
    """Verify tool calls make NO secret-scope requests and ignore token/session env vars."""
    fake_secret_mod = mock.MagicMock()
    fake_secret_mod.get_secret = mock.MagicMock(side_effect=AssertionError("Must not access secret scope"))
    monkeypatch.setitem(sys.modules, 'agent.secret_scope', fake_secret_mod)

    monkeypatch.setenv('BROWSERPAW_MCP_TOKEN', 'leaked_token_123')
    monkeypatch.setenv('CHROME_MCP_TOKEN', 'leaked_token_456')
    monkeypatch.setenv('BROWSERPAW_MCP_SESSION_ID', 'leaked_sess_789')
    monkeypatch.setenv('CHROME_MCP_SESSION_ID', 'leaked_sess_000')

    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {'ok': True, 'result': 'tabs_ok'}

    handler = plugin._make_handler(mock_ctx, 'browserpaw_get_windows_and_tabs')
    res = handler({})

    assert fake_secret_mod.get_secret.call_count == 0
    parsed = json.loads(res.splitlines()[0])
    assert parsed.get('ok') is True
    assert parsed.get('result') == 'tabs_ok'
    assert 'leaked_token' not in res
    assert 'leaked_sess' not in res


def test_input_arguments_not_mutated(plugin):
    """Verify handler creates a clean arguments copy and never mutates caller input."""
    original_args = {'tabId': 1, 'url': 'https://example.com'}
    original_copy = dict(original_args)

    mock_ctx = mock.MagicMock()
    mock_ctx.get_config.return_value = True
    mock_ctx.call_mcp.return_value = {'ok': True, 'result': 'read_done'}

    # Test with read_dom which adds isolateModal
    read_dom_args = {'tabId': 1}
    read_dom_copy = dict(read_dom_args)

    handler = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')
    handler(read_dom_args)

    assert read_dom_args == read_dom_copy, 'Caller args dictionary was mutated'
    assert 'isolateModal' not in read_dom_args, 'isolateModal leaked into caller input dict'

    # Test with navigate
    handler_nav = plugin._make_handler(mock_ctx, 'browserpaw_navigate')
    handler_nav(original_args)

    assert original_args == original_copy, 'Caller args dictionary was mutated'


def test_permission_error_on_missing_allowlist(plugin):
    """Verify PermissionError from ctx.call_mcp is captured into error envelope."""
    mock_ctx = mock.MagicMock()
    perm_err = PermissionError(
        "Plugin 'browserpaw' is not allowed to call MCP server 'browserpaw'. "
        "Add it to plugins.entries.browserpaw.mcp_allowlist in config.yaml to grant access."
    )
    mock_ctx.call_mcp.side_effect = perm_err

    handler = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')
    res = handler({'tabId': 1})
    parsed = json.loads(res.splitlines()[0])

    assert parsed.get('ok') is False
    assert 'plugins.entries.browserpaw.mcp_allowlist' in parsed.get('error', '')


def test_generic_exception_surfaced_in_error_envelope(plugin):
    """Verify unexpected exceptions return a structured error envelope rather than crashing."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.side_effect = RuntimeError("Transport died")

    handler = plugin._make_handler(mock_ctx, 'browserpaw_switch_tab')
    res = handler({'tabId': 2})
    parsed = json.loads(res.splitlines()[0])

    assert parsed.get('ok') is False
    assert 'Transport died' in parsed.get('error', '')


def test_codex_mcp_config_contract():
    """Validates .mcp.json and .codex-plugin/plugin.json align with official Codex Plugin specs."""
    mcp_path = Path(__file__).resolve().parents[1] / '.mcp.json'
    assert mcp_path.exists(), '.mcp.json must exist at plugin root'
    mcp_data = json.loads(mcp_path.read_text(encoding='utf-8'))
    assert 'mcpServers' in mcp_data
    assert 'browserpaw' in mcp_data['mcpServers']
    server = mcp_data['mcpServers']['browserpaw']
    assert server.get('type') == 'stdio'
    assert server.get('command') == 'mcp-chrome-stdio'
    assert 'bearer_token_env_var' not in server

    plugin_json_path = Path(__file__).resolve().parents[1] / '.codex-plugin' / 'plugin.json'
    assert plugin_json_path.exists(), 'plugin.json must exist in .codex-plugin'
    plugin_data = json.loads(plugin_json_path.read_text(encoding='utf-8'))
    assert plugin_data.get('version') == '4.0.0'
    assert plugin_data.get('mcpServers') == './.mcp.json'
    assert plugin_data.get('skills') == './mcp-skills/'
    standard_skill = Path(__file__).resolve().parents[1] / 'mcp-skills' / 'browserpaw' / 'SKILL.md'
    assert 'chrome_read_dom' in standard_skill.read_text(encoding='utf-8')
