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

import plugins.browserpaw as plugin
from plugins.browserpaw import BROWSERPAW_SPECS


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
