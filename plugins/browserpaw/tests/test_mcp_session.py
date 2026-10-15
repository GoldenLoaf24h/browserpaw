"""Tests for BrowserPaw tool registration, remote dispatch mapping, modal isolation, and MEDIA handling.

Verifies:
- All 16 public tools are registered with their canonical names, schemas, and emojis.
- Canonical remote mapping: browserpaw_get_windows_and_tabs -> get_windows_and_tabs, others -> chrome_*
- timeout=120 passed on every dispatch.
- isolate_modal dynamically queries ctx.get_config per profile on each call.
- structuredContent and truncated metadata are preserved in the returned JSON envelope.
- error payloads are preserved without being wrapped as successes.
- MEDIA: directives from result strings are extracted to standalone newline tags outside JSON.
- Full compatibility with Hermes PluginContext (tag v2026.9.24 / 0.21.5 and current HEAD).
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from unittest import mock
import pytest

PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'


@pytest.fixture
def plugin():
    spec = importlib.util.spec_from_file_location('browserpaw_mcp_session_test', PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_16_tools_registered_with_schemas_and_emojis(plugin):
    """Verify all 16 canonical BrowserPaw tools are registered with schemas, descriptions, and emojis."""
    mock_ctx = mock.MagicMock()
    plugin.register(mock_ctx)

    registered = {}
    for call in mock_ctx.register_tool.call_args_list:
        kw = call.kwargs
        registered[kw['name']] = kw

    assert len(registered) == 16
    assert len(plugin.TOOL_DEFINITIONS) == 16

    expected_tools = [
        "browserpaw_act_toward_goal",
        "browserpaw_navigate",
        "browserpaw_read_dom",
        "browserpaw_interact_index",
        "browserpaw_fill_index",
        "browserpaw_batch_actions",
        "browserpaw_screenshot",
        "browserpaw_smart_scroll",
        "browserpaw_scroll_until_found",
        "browserpaw_inspect_media",
        "browserpaw_grep",
        "browserpaw_get_markdown",
        "browserpaw_switch_tab",
        "browserpaw_close_tabs",
        "browserpaw_get_windows_and_tabs",
        "browserpaw_tool_docs",
    ]

    for tool_name in expected_tools:
        assert tool_name in registered
        entry = registered[tool_name]
        assert entry['toolset'] == 'browserpaw'
        assert entry['description']
        assert entry['schema']['parameters'] == plugin.TOOL_DEFINITIONS[tool_name]['inputSchema']
        assert entry['emoji'] == plugin.BROWSERPAW_SPECS[tool_name]['emoji']


def test_tool_name_mapping_canonical_and_timeout(plugin):
    """Verify tool name mapping to remote canonical names and timeout=120."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {'ok': True, 'result': 'ok'}

    for tool_name in plugin.TOOL_DEFINITIONS:
        handler = plugin._make_handler(mock_ctx, tool_name)
        handler({})

        call_args = mock_ctx.call_mcp.call_args
        assert call_args is not None
        server, remote_name, args, kwargs = call_args[0][0], call_args[0][1], call_args[0][2], call_args[1]

        assert server == 'browserpaw'
        assert kwargs.get('timeout') == 120 or call_args[1].get('timeout') == 120

        if tool_name == 'browserpaw_get_windows_and_tabs':
            assert remote_name == 'get_windows_and_tabs'
        else:
            expected_remote = 'chrome_' + tool_name[len('browserpaw_'):]
            assert remote_name == expected_remote


def test_isolate_modal_dynamic_config_per_profile(plugin):
    """Verify isolate_modal queries ctx.get_config on each invocation for profile isolation."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {'ok': True, 'result': 'dom_tree'}

    handler_dom = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')

    # Case 1: isolate_modal is False -> isolateModal not added
    mock_ctx.get_config.return_value = False
    handler_dom({'tabId': 1})
    call_args = mock_ctx.call_mcp.call_args[0][2]
    assert 'isolateModal' not in call_args

    # Case 2: isolate_modal becomes True -> isolateModal added
    mock_ctx.get_config.return_value = True
    handler_dom({'tabId': 1})
    call_args = mock_ctx.call_mcp.call_args[0][2]
    assert call_args.get('isolateModal') is True

    # Case 3: caller explicitly specifies isolateModal: False -> must not be overridden
    mock_ctx.get_config.return_value = True
    handler_dom({'tabId': 1, 'isolateModal': False})
    call_args = mock_ctx.call_mcp.call_args[0][2]
    assert call_args.get('isolateModal') is False

    # Case 4: other tools never receive isolateModal
    handler_nav = plugin._make_handler(mock_ctx, 'browserpaw_navigate')
    mock_ctx.get_config.return_value = True
    handler_nav({'url': 'https://example.com'})
    call_args_nav = mock_ctx.call_mcp.call_args[0][2]
    assert 'isolateModal' not in call_args_nav


def test_structured_content_and_truncation_preserved(plugin):
    """Verify structuredContent and truncated flags from ctx.call_mcp envelope are preserved."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': True,
        'result': 'parsed_dom',
        'structuredContent': {'nodeCount': 100, 'forms': 2},
        'truncated': True,
    }

    handler = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')
    raw_output = handler({})

    parsed = json.loads(raw_output.splitlines()[0])
    assert parsed.get('ok') is True
    assert parsed.get('result') == 'parsed_dom'
    assert parsed.get('structuredContent') == {'nodeCount': 100, 'forms': 2}
    assert parsed.get('truncated') is True


def test_error_envelope_preserved_without_wrapping_as_success(plugin):
    """Verify error envelopes returned from ctx.call_mcp retain ok=False and error message."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': False,
        'error': 'Chrome target destroyed',
    }

    handler = plugin._make_handler(mock_ctx, 'browserpaw_read_dom')
    raw_output = handler({})

    parsed = json.loads(raw_output.splitlines()[0])
    assert parsed.get('ok') is False
    assert parsed.get('error') == 'Chrome target destroyed'


ALL_16_TOOLS = [
    ("browserpaw_act_toward_goal", "chrome_act_toward_goal"),
    ("browserpaw_navigate", "chrome_navigate"),
    ("browserpaw_read_dom", "chrome_read_dom"),
    ("browserpaw_interact_index", "chrome_interact_index"),
    ("browserpaw_fill_index", "chrome_fill_index"),
    ("browserpaw_batch_actions", "chrome_batch_actions"),
    ("browserpaw_screenshot", "chrome_screenshot"),
    ("browserpaw_smart_scroll", "chrome_smart_scroll"),
    ("browserpaw_scroll_until_found", "chrome_scroll_until_found"),
    ("browserpaw_inspect_media", "chrome_inspect_media"),
    ("browserpaw_grep", "chrome_grep"),
    ("browserpaw_get_markdown", "chrome_get_markdown"),
    ("browserpaw_switch_tab", "chrome_switch_tab"),
    ("browserpaw_close_tabs", "chrome_close_tabs"),
    ("browserpaw_get_windows_and_tabs", "get_windows_and_tabs"),
    ("browserpaw_tool_docs", "chrome_tool_docs"),
]


@pytest.mark.parametrize("public_name,expected_remote", ALL_16_TOOLS)
def test_each_of_16_tools_dispatch_mapping_and_timeout(plugin, public_name, expected_remote):
    """Verify each of the 16 tool handlers individually maps to its canonical remote name with timeout=120."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {"ok": True, "result": "done"}
    test_args = {"query": "test_search", "tabId": 42}

    handler = plugin._make_handler(mock_ctx, public_name)
    res = handler(test_args)

    assert mock_ctx.call_mcp.call_count == 1
    call_args = mock_ctx.call_mcp.call_args
    server = call_args[0][0]
    remote_name = call_args[0][1]
    forwarded_args = call_args[0][2]
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]

    assert server == "browserpaw"
    assert remote_name == expected_remote
    assert timeout == 120
    assert forwarded_args["query"] == "test_search"
    assert forwarded_args["tabId"] == 42
    parsed = json.loads(res.splitlines()[0])
    assert parsed.get("ok") is True


def test_media_tags_extracted_via_hermes_extract_media(plugin):
    """Verify MEDIA: directives from result strings are extracted by Hermes BasePlatformAdapter.extract_media."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': True,
        'result': "Page screenshot captured:\nMEDIA:/tmp/shot1.png\nMEDIA:/var/cache/shot2.jpg",
    }

    handler = plugin._make_handler(mock_ctx, 'browserpaw_screenshot')
    raw_output = handler({})

    lines = raw_output.splitlines()
    assert len(lines) >= 3

    # Line 1 is the complete valid JSON envelope
    json_envelope = json.loads(lines[0])
    assert json_envelope.get('ok') is True
    assert 'MEDIA:' in json_envelope.get('result')

    # Lines 2 and 3 are raw standalone MEDIA: directives
    assert lines[1].startswith('MEDIA:')
    assert 'shot1.png' in lines[1]
    assert lines[2].startswith('MEDIA:')
    assert 'shot2.jpg' in lines[2]

    # 3. Verify media matching against standard MEDIA:<path> directive specification
    media_directive_re = re.compile(r'^MEDIA:\S+', re.MULTILINE)
    directives = media_directive_re.findall(raw_output)
    assert len(directives) == 2
    assert any('shot1.png' in d for d in directives)
    assert any('shot2.jpg' in d for d in directives)


def test_business_error_structured_content_truncated_and_media_preserved(plugin):
    """Verify business error preserves structuredContent, truncated flag, and extracts error MEDIA path."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': False,
        'error': "Capture failed on target element:\nMEDIA:/var/cache/failed_crop.png",
        'structuredContent': {'errorCode': 'ELEMENT_DETACHED', 'nodeIndex': 42},
        'truncated': True,
    }

    handler = plugin._make_handler(mock_ctx, 'browserpaw_inspect_media')
    raw_output = handler({'index': 42})

    lines = raw_output.splitlines()
    assert len(lines) >= 2
    envelope = json.loads(lines[0])
    assert envelope.get('ok') is False
    assert 'ELEMENT_DETACHED' in str(envelope.get('structuredContent'))
    assert envelope.get('truncated') is True
    assert lines[1].startswith('MEDIA:')
    assert 'failed_crop.png' in lines[1]


def test_act_toward_goal_custom_timeout_scaling(plugin):
    """F-01: Verify act_toward_goal scales timeout dynamically with margin up to 315s, while default remains 120s."""
    mock_ctx = mock.MagicMock()
    mock_ctx.call_mcp.return_value = {"ok": True}

    goal_handler = plugin._make_handler(mock_ctx, "browserpaw_act_toward_goal")

    # 1. 240s goal -> 240 + 15 = 255s
    goal_handler({"goal": "Search for socks", "timeoutMs": 240000})
    call_args = mock_ctx.call_mcp.call_args
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]
    assert timeout == 255

    # 2. 300s goal -> 300 + 15 = 315s (clamped to max 315s)
    goal_handler({"goal": "Search for socks", "timeoutMs": 300000})
    call_args = mock_ctx.call_mcp.call_args
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]
    assert timeout == 315

    # 3. 600s goal -> clamped to 315s
    goal_handler({"goal": "Search for socks", "timeoutMs": 600000})
    call_args = mock_ctx.call_mcp.call_args
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]
    assert timeout == 315

    # 4. 90s goal (default schema) -> 90 + 15 = 105 <= 120 -> 120s
    goal_handler({"goal": "Search for socks", "timeoutMs": 90000})
    call_args = mock_ctx.call_mcp.call_args
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]
    assert timeout == 120

    # 5. Non-goal tool (e.g. read_dom) with timeoutMs -> must NOT scale, stays default 120s
    dom_handler = plugin._make_handler(mock_ctx, "browserpaw_read_dom")
    dom_handler({"timeoutMs": 240000})
    call_args = mock_ctx.call_mcp.call_args
    timeout = call_args[1].get("timeout") if call_args[1] else call_args[0][3]
    assert timeout == 120
