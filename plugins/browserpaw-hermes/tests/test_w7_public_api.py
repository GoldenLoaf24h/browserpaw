from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from unittest import mock
import pytest

PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'


@pytest.fixture(scope='module')
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_plugin_test_w7', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_bug12_no_monkey_patching_host_callables_and_modules(plugin, monkeypatch):
    """BUG-12: Registering plugin must NOT monkey-patch host internals or rebind callables in sys.modules."""
    fake_display = ModuleType('agent.display')
    orig_get_tool_verb = lambda name: 'orig_verb'
    orig_build_tool_preview = lambda name, args=None, max_len=None: 'orig_preview'
    orig_get_tool_emoji = lambda name, default='⚡': 'orig_emoji'
    orig_prepare_tool_preview = lambda name, args, **kwargs: 'orig_prepared'

    fake_display.get_tool_verb = orig_get_tool_verb
    fake_display.build_tool_preview = orig_build_tool_preview
    fake_display.get_tool_emoji = orig_get_tool_emoji
    fake_display.prepare_tool_preview = orig_prepare_tool_preview

    fake_agent = ModuleType('agent')
    fake_agent.display = fake_display

    fake_consumer = ModuleType('some_consumer_module')
    fake_consumer.get_tool_verb = orig_get_tool_verb
    fake_consumer.build_tool_preview = orig_build_tool_preview

    monkeypatch.setitem(sys.modules, 'agent', fake_agent)
    monkeypatch.setitem(sys.modules, 'agent.display', fake_display)
    monkeypatch.setitem(sys.modules, 'some_consumer_module', fake_consumer)

    ctx = mock.MagicMock()
    plugin.register(ctx)

    assert fake_display.get_tool_verb is orig_get_tool_verb, 'display.get_tool_verb was monkey-patched'
    assert fake_display.build_tool_preview is orig_build_tool_preview, 'display.build_tool_preview was monkey-patched'
    assert fake_display.get_tool_emoji is orig_get_tool_emoji, 'display.get_tool_emoji was monkey-patched'
    assert fake_display.prepare_tool_preview is orig_prepare_tool_preview, 'display.prepare_tool_preview was monkey-patched'
    assert fake_consumer.get_tool_verb is orig_get_tool_verb, 'consumer module get_tool_verb was rebound via sys.modules'
    assert fake_consumer.build_tool_preview is orig_build_tool_preview, 'consumer module build_tool_preview was rebound via sys.modules'


def test_tool03_response_body_fidelity(plugin):
    """TOOL-03: Response text containing chrome_* or get_windows_and_tabs must NOT be regex rewritten."""
    raw_response = json.dumps({
        "code": "const chrome_example = 1;",
        "url": "https://chrome.google.com/webstore/detail/chrome_app",
        "protocol": "chrome://extensions",
        "legacy_tool": "get_windows_and_tabs",
        "error": "chrome_runtime_not_found"
    })

    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': True,
        'result': raw_response,
    }

    handler = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')
    result = handler({})

    assert 'const chrome_example = 1' in result, f"chrome_example was mutated: {result}"
    assert 'chrome_app' in result, f"chrome_app was mutated: {result}"
    assert 'chrome://extensions' in result, f"chrome://extensions was mutated: {result}"
    assert 'get_windows_and_tabs' in result, f"get_windows_and_tabs was mutated: {result}"
    assert 'chrome_runtime_not_found' in result, f"chrome_runtime_not_found was mutated: {result}"
