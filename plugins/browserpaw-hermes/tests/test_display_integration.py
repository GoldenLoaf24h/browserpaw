import sys
from pathlib import Path
import pytest
from unittest.mock import MagicMock

# Ensure repo root is on sys.path for direct pytest.exe invocations
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

try:
    from tools.registry import registry
    from agent.display import get_tool_emoji, get_tool_verb, prepare_tool_preview, build_tool_preview
    HAS_HERMES_HOST = True
except ImportError:
    HAS_HERMES_HOST = False

if not HAS_HERMES_HOST:
    pytest.skip("Hermes host environment (tools.registry, agent.display) not present in test environment", allow_module_level=True)

import importlib.util
PLUGIN_INIT = Path(__file__).resolve().parents[1] / '__init__.py'
spec = importlib.util.spec_from_file_location('browserpaw_display_test', PLUGIN_INIT)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
BROWSERPAW_SPECS = plugin.BROWSERPAW_SPECS


def test_public_api_registration_contract():
    """Verify tools register via public PluginContext API without monkey-patching host globals."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 1. Verify all canonical tools are registered via public ctx.register_tool
    registered_tools = {
        call.kwargs.get("name"): call.kwargs
        for call in ctx.register_tool.call_args_list
    }
    assert len(registered_tools) == len(plugin.TOOL_DEFINITIONS)
    assert "browserpaw_act_toward_goal" in registered_tools
    assert registered_tools["browserpaw_act_toward_goal"]["emoji"] == "💫"

    # 2. Host display functions are NOT monkey-patched (Rule 9 compliance)
    assert not getattr(get_tool_verb, "_is_browserpaw_wrapped", False)
    assert not getattr(build_tool_preview, "_is_browserpaw_wrapped", False)
    assert not getattr(get_tool_emoji, "_is_browserpaw_wrapped", False)


def test_real_plugin_context_cross_profile_and_modal_contract(monkeypatch):
    """Verify integration against real Hermes PluginContext across operator profiles."""
    import json
    import hermes_cli.plugins as plugins_mod
    from hermes_cli.plugins import PluginContext, PluginManifest
    import hermes_cli.config as config_mod
    from tools import mcp_tool_handlers

    profile_configs = {
        "default": {
            "plugins": {
                "entries": {
                    "browserpaw": {
                        "mcp_allowlist": ["browserpaw"],
                        "config": {"isolate_modal": False},
                        "settings": {"isolate_modal": False},
                    }
                }
            }
        },
        "researcher": {
            "plugins": {
                "entries": {
                    "browserpaw": {
                        "mcp_allowlist": ["browserpaw"],
                        "config": {"isolate_modal": True},
                        "settings": {"isolate_modal": True},
                    }
                }
            }
        }
    }
    active_profile = "default"

    monkeypatch.setattr(config_mod, "load_config", lambda *a, **k: profile_configs[active_profile])
    monkeypatch.setattr(config_mod, "load_config_readonly", lambda *a, **k: profile_configs[active_profile])
    monkeypatch.setattr(plugins_mod, "load_config_readonly", lambda *a, **k: profile_configs[active_profile])

    captured = {}
    def fake_make_handler(server_name, tool_name, tool_timeout):
        captured['server'] = server_name
        captured['tool'] = tool_name
        captured['timeout'] = tool_timeout
        def _h(args, **kwargs):
            captured['args'] = args
            return json.dumps({
                'result': 'tabs_ready',
                'structuredContent': {'count': 3}
            })
        return _h

    monkeypatch.setattr(mcp_tool_handlers, '_make_tool_handler', fake_make_handler)

    manifest = PluginManifest(name='browserpaw', key='browserpaw')
    mock_manager = MagicMock()
    mock_manager.get_config = lambda k, d=None: profile_configs[active_profile]["plugins"]["entries"]["browserpaw"].get(k, d)
    real_ctx = PluginContext(manifest, mock_manager)

    handler_tabs = plugin._make_handler(real_ctx, 'browserpaw_get_windows_and_tabs')
    output = handler_tabs({})

    assert captured['server'] == 'browserpaw'
    assert captured['tool'] == 'get_windows_and_tabs'
    assert captured['timeout'] == 120.0
    parsed = json.loads(output.splitlines()[0])
    assert parsed.get('ok') is True
    assert parsed.get('result') == 'tabs_ready'
    assert parsed.get('structuredContent') == {'count': 3}

    # Test profile switch: read_dom under default profile (isolate_modal=False)
    handler_dom = plugin._make_handler(real_ctx, 'browserpaw_read_dom')
    handler_dom({'tabId': 1})
    assert captured['args'].get('isolateModal') is None

    # Switch active profile to researcher (isolate_modal=True)
    active_profile = "researcher"
    handler_dom({'tabId': 1})
    assert captured['args'].get('isolateModal') is True

    # Test operator authorization: profile with empty allowlist fails closed without calling MCP
    profile_configs["unauthorized"] = {
        "plugins": {
            "entries": {
                "browserpaw": {
                    "mcp_allowlist": [],
                    "config": {"isolate_modal": False},
                }
            }
        }
    }
    active_profile = "unauthorized"
    captured.clear()
    unauth_output = handler_tabs({})
    unauth_envelope = json.loads(unauth_output.splitlines()[0])
    assert unauth_envelope.get('ok') is False
    assert "not allowed to call MCP server 'browserpaw'" in unauth_envelope.get('error', '')
    assert 'server' not in captured


def test_real_hermes_gateway_media_extraction():
    """Verify Hermes gateway extract_media extracts raw newline MEDIA tags while ignoring JSON body."""
    import json
    from gateway.platforms.base import BasePlatformAdapter, _mask_media_scan_text

    mock_ctx = MagicMock()
    mock_ctx.call_mcp.return_value = {
        'ok': True,
        'result': "Page captured:\nMEDIA:/cache/shot1.png\nMEDIA:/cache/shot2.jpg",
    }
    handler = plugin._make_handler(mock_ctx, 'browserpaw_screenshot')
    raw_output = handler({})

    # Verify mask retains raw lines
    masked = _mask_media_scan_text(raw_output)
    assert 'shot1.png' in masked
    assert 'shot2.jpg' in masked

    # Verify extract_media returns the 2 files without duplicates
    media_files, cleaned = BasePlatformAdapter.extract_media(raw_output)
    extracted_paths = [p for p, _ in media_files]
    assert len(media_files) == 2
    assert any('shot1.png' in p for p in extracted_paths)
    assert any('shot2.jpg' in p for p in extracted_paths)
