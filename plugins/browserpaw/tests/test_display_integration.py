import sys
from pathlib import Path
import pytest
from unittest.mock import MagicMock

# Ensure repo root is on sys.path for direct pytest.exe invocations
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.registry import registry
from agent.display import get_tool_emoji, get_tool_verb, prepare_tool_preview, build_tool_preview
import plugins.browserpaw as plugin
from plugins.browserpaw import _clip_display_text, BROWSERPAW_SPECS


def test_tool_emojis_and_display_integration():
    """Core acceptance test as specified in browserpaw-display-enhancement-spec.md."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 1. 验证微循环 Emoji 严格为 💫
    assert registry.get_emoji("browserpaw_act_toward_goal") == "💫"
    assert registry.get_emoji("browserpaw_interact_index") == "🎯"
    assert registry.get_emoji("browserpaw_fill_index") == "✍️"

    # 2. 验证富文本预览提取
    p1 = prepare_tool_preview("browserpaw_interact_index", {"action": "click", "index": 67}, fallback="", max_len=40)
    assert p1.text == "element [#67] (click)"

    p2 = prepare_tool_preview("browserpaw_fill_index", {"index": 5, "text": "HelloWorld"}, fallback="", max_len=40)
    assert p2.text == 'element [#5]: "HelloWorld"'

    p3 = prepare_tool_preview("browserpaw_act_toward_goal", {"goal": "Submit form"}, fallback="", max_len=40)
    assert p3.text == "Submit form"

    # 3. 边界鲁棒性 (空字典/非法参数不崩溃)
    p_empty = prepare_tool_preview("browserpaw_interact_index", {}, fallback="fallback", max_len=40)
    assert p_empty is not None


def test_all_49_tools_emoji_and_verbs():
    """Verify all 49 canonical tools have expected emojis and natural language verbs."""
    ctx = MagicMock()
    plugin.register(ctx)

    expected_specs = {
        # 1. 核心导航与感知 (15 tools)
        "browserpaw_act_toward_goal": ("💫", "Autonomous micro-looping"),
        "browserpaw_navigate": ("🌐", "Navigating to"),
        "browserpaw_read_dom": ("🔍", "Reading DOM structure"),
        "browserpaw_interact_index": ("🎯", "Interacting with"),
        "browserpaw_fill_index": ("✍️", "Typing into"),
        "browserpaw_batch_actions": ("⚡", "Executing batch pipeline"),
        "browserpaw_screenshot": ("📸", "Capturing screenshot"),
        "browserpaw_smart_scroll": ("📜", "Scrolling view"),
        "browserpaw_inspect_media": ("🖼️", "Inspecting media"),
        "browserpaw_grep": ("🔎", "Searching DOM"),
        "browserpaw_get_markdown": ("📄", "Extracting clean markdown"),
        "browserpaw_switch_tab": ("🔀", "Switching tab"),
        "browserpaw_close_tabs": ("❌", "Closing tabs"),
        "browserpaw_get_windows_and_tabs": ("🪟", "Listing open tabs"),
        "browserpaw_tool_docs": ("📚", "Reading tool docs"),

        # 2. 开发者与底层逃生门 (5 tools)
        "browserpaw_javascript": ("💻", "Executing script"),
        "browserpaw_cdp_execute": ("⚡", "Executing CDP command"),
        "browserpaw_console": ("🖥️", "Reading console"),
        "browserpaw_doctor": ("🩺", "Running doctor check"),
        "browserpaw_undo_last_action": ("↩️", "Undoing action"),

        # 3. 文件、媒体与弹窗/人工干预 (5 tools)
        "browserpaw_upload_file": ("📤", "Uploading file"),
        "browserpaw_insert_media": ("📋", "Pasting media"),
        "browserpaw_handle_download": ("📥", "Managing download"),
        "browserpaw_handle_dialog": ("💬", "Handling dialog"),
        "browserpaw_request_human_intervention": ("🙋", "Requesting human help"),

        # 4. 遮罩、按键与系统视觉兜底 (3 tools)
        "browserpaw_dismiss_overlay": ("🛡️", "Dismissing overlay"),
        "browserpaw_keyboard": ("⌨️", "Pressing key"),
        "browserpaw_computer": ("🖱️", "Controlling cursor"),

        # 5. 高级表单与网络捕获 (5 tools)
        "browserpaw_form_pipeline": ("📝", "Filling form pipeline"),
        "browserpaw_get_dropdown_options": ("🔽", "Reading options"),
        "browserpaw_intercept_api": ("📡", "Intercepting API"),
        "browserpaw_network_request": ("🌐", "Sending HTTP request"),
        "browserpaw_network_capture": ("🛰️", "Capturing traffic"),

        # 6. 标签组与标签移动 (8 tools)
        "browserpaw_tab_group_create": ("🏷️", "Creating tab group"),
        "browserpaw_tab_group_update": ("🏷️", "Updating tab group"),
        "browserpaw_tab_group_list": ("📋", "Listing tab groups"),
        "browserpaw_tab_group_close": ("❌", "Closing tab group"),
        "browserpaw_tab_group_ungroup": ("🔓", "Ungrouping tabs"),
        "browserpaw_move_tab": ("📦", "Moving tab"),
        "browserpaw_attach_tab": ("🔗", "Attaching tab"),
        "browserpaw_detach_tab": ("⛓️", "Detaching tab"),

        # 7. 存储、历史与书签 (5 tools)
        "browserpaw_storage": ("💾", "Accessing storage"),
        "browserpaw_history": ("🕒", "Searching history"),
        "browserpaw_bookmark_search": ("🔖", "Searching bookmarks"),
        "browserpaw_bookmark_add": ("⭐", "Adding bookmark"),
        "browserpaw_bookmark_delete": ("🗑️", "Deleting bookmark"),

        # 8. 性能分析 (3 tools)
        "browserpaw_performance_start_trace": ("⏱️", "Starting trace"),
        "browserpaw_performance_stop_trace": ("⏹️", "Stopping trace"),
        "browserpaw_performance_analyze_insight": ("📊", "Analyzing performance"),
    }

    assert len(expected_specs) == 49
    assert len(BROWSERPAW_SPECS) == 49

    for tool_name, (expected_emoji, expected_verb) in expected_specs.items():
        assert registry.get_emoji(tool_name) == expected_emoji, f"Mismatch emoji for {tool_name}"
        assert get_tool_emoji(tool_name) == expected_emoji, f"Mismatch get_tool_emoji for {tool_name}"
        assert get_tool_verb(tool_name) == expected_verb, f"Mismatch verb for {tool_name}"

        # Dual naming compatibility: chrome_* and get_windows_and_tabs
        chrome_name = "chrome_" + tool_name[len("browserpaw_"):]
        if tool_name == "browserpaw_get_windows_and_tabs":
            chrome_name = "get_windows_and_tabs"
        assert registry.get_emoji(chrome_name) == expected_emoji, f"Mismatch emoji for {chrome_name}"
        assert get_tool_emoji(chrome_name) == expected_emoji, f"Mismatch get_tool_emoji for {chrome_name}"
        assert get_tool_verb(chrome_name) == expected_verb, f"Mismatch verb for {chrome_name}"


def test_all_15_tools_preview_formatting():
    """Verify preview formatting logic for all 15 canonical tools."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 1. browserpaw_act_toward_goal
    p = prepare_tool_preview("browserpaw_act_toward_goal", {"goal": "点击登录并提交"}, fallback="", max_len=60)
    assert p.text == "点击登录并提交"

    # 2. browserpaw_navigate
    p_url = prepare_tool_preview("browserpaw_navigate", {"url": "https://github.com/"}, fallback="", max_len=60)
    assert p_url.text == "https://github.com/"
    p_refresh = prepare_tool_preview("browserpaw_navigate", {"refresh": True}, fallback="", max_len=60)
    assert p_refresh.text == "refresh"

    # 3. browserpaw_interact_index
    p_click = prepare_tool_preview("browserpaw_interact_index", {"action": "click", "index": 67}, fallback="", max_len=60)
    assert p_click.text == "element [#67] (click)"
    p_hover = prepare_tool_preview("browserpaw_interact_index", {"action": "hover", "index": 12}, fallback="", max_len=60)
    assert p_hover.text == "element [#12] (hover)"

    # 4. browserpaw_fill_index
    p_fill = prepare_tool_preview("browserpaw_fill_index", {"index": 5, "text": "搜索关键字"}, fallback="", max_len=60)
    assert p_fill.text == 'element [#5]: "搜索关键字"'

    # 5. browserpaw_smart_scroll
    p_down = prepare_tool_preview("browserpaw_smart_scroll", {"direction": "down", "amount": "page"}, fallback="", max_len=60)
    assert p_down.text == "down (page)"
    p_up = prepare_tool_preview("browserpaw_smart_scroll", {"direction": "up", "amount": "half_page"}, fallback="", max_len=60)
    assert p_up.text == "up (half_page)"

    # 6. browserpaw_batch_actions
    p_batch = prepare_tool_preview("browserpaw_batch_actions", {"actions": [{"type": "click"}, {"type": "scroll"}, {"type": "read"}, {"type": "fill"}]}, fallback="", max_len=60)
    assert p_batch.text == "4 actions"

    # 7. browserpaw_read_dom
    p_scoped = prepare_tool_preview("browserpaw_read_dom", {"selector": "form"}, fallback="", max_len=60)
    assert p_scoped.text == "scoped to 'form'"
    p_viewport = prepare_tool_preview("browserpaw_read_dom", {}, fallback="", max_len=60)
    assert p_viewport.text == "viewport"

    # 8. browserpaw_grep
    p_grep = prepare_tool_preview("browserpaw_grep", {"query": "Submit"}, fallback="", max_len=60)
    assert p_grep.text == 'query: "Submit"'

    # 9. browserpaw_get_markdown
    p_fit = prepare_tool_preview("browserpaw_get_markdown", {"fit": True}, fallback="", max_len=60)
    assert p_fit.text == "fitted article"
    p_full = prepare_tool_preview("browserpaw_get_markdown", {}, fallback="", max_len=60)
    assert p_full.text == "full page"

    p_full_explicit = prepare_tool_preview("browserpaw_get_markdown", {"tabId": 1}, fallback="", max_len=60)
    assert p_full_explicit.text == "full page"

    # 10. browserpaw_screenshot
    p_shot_full = prepare_tool_preview("browserpaw_screenshot", {"fullPage": True}, fallback="", max_len=60)
    assert p_shot_full.text == "full page"
    p_shot_view = prepare_tool_preview("browserpaw_screenshot", {}, fallback="", max_len=60)
    assert p_shot_view.text == "viewport"

    # 11. browserpaw_close_tabs
    p_close_multiple = prepare_tool_preview("browserpaw_close_tabs", {"tabIds": [101, 102]}, fallback="", max_len=60)
    assert p_close_multiple.text == "2 tabs"
    p_close_curr = prepare_tool_preview("browserpaw_close_tabs", {}, fallback="", max_len=60)
    assert p_close_curr.text == "current"

    # 12. browserpaw_switch_tab
    p_switch = prepare_tool_preview("browserpaw_switch_tab", {"tabId": 1581}, fallback="", max_len=60)
    assert p_switch.text == "tab [#1581]"

    # 13. browserpaw_get_windows_and_tabs
    p_win = prepare_tool_preview("browserpaw_get_windows_and_tabs", {}, fallback="", max_len=60)
    assert p_win.text == "active windows"

    # 14. browserpaw_inspect_media
    p_media = prepare_tool_preview("browserpaw_inspect_media", {"index": 3}, fallback="", max_len=60)
    assert p_media.text == "element [#3]"

    # 15. browserpaw_tool_docs
    p_docs = prepare_tool_preview("browserpaw_tool_docs", {"category": "network"}, fallback="", max_len=60)
    assert p_docs.text == "category: network"
    p_docs_all = prepare_tool_preview("browserpaw_tool_docs", {}, fallback="", max_len=60)
    assert p_docs_all.text == "category: all"


def test_zero_and_none_arguments_preview():
    """Verify tools with default/no args correctly render without dummy arguments."""
    ctx = MagicMock()
    plugin.register(ctx)

    # Empty dict args
    assert build_tool_preview("browserpaw_get_windows_and_tabs", {}) == "active windows"
    assert build_tool_preview("browserpaw_get_markdown", {}) == "full page"
    assert build_tool_preview("browserpaw_screenshot", {}) == "viewport"
    assert build_tool_preview("browserpaw_close_tabs", {}) == "current"
    assert build_tool_preview("browserpaw_read_dom", {}) == "viewport"
    assert build_tool_preview("browserpaw_tool_docs", {}) == "category: all"

    # None args
    assert build_tool_preview("browserpaw_get_windows_and_tabs", None) == "active windows"
    assert build_tool_preview("browserpaw_get_markdown", None) == "full page"
    assert build_tool_preview("browserpaw_screenshot", None) == "viewport"
    assert build_tool_preview("browserpaw_close_tabs", None) == "current"
    assert build_tool_preview("browserpaw_read_dom", None) == "viewport"
    assert build_tool_preview("browserpaw_tool_docs", None) == "category: all"

    # prepare_tool_preview with None args
    assert prepare_tool_preview("browserpaw_get_windows_and_tabs", None, fallback="", max_len=40).text == "active windows"
    assert prepare_tool_preview("browserpaw_get_markdown", None, fallback="", max_len=40).text == "full page"
    assert prepare_tool_preview("browserpaw_screenshot", None, fallback="", max_len=40).text == "viewport"


def test_edge_cases_and_robustness():
    """Verify edge case handling: empty inputs, None values, whitespace normalization, clipping."""
    # _clip_display_text checks
    assert _clip_display_text(None, 10) == ""
    assert _clip_display_text("", 10) == ""
    assert _clip_display_text(0, 10) == "0"
    assert _clip_display_text(False, 10) == "False"
    assert _clip_display_text("  hello   world  \n  test  ", 20) == "hello world test"
    assert _clip_display_text("1234567890extra", 10) == "1234567890..."

    # None and empty args for interact_index
    b_interact = BROWSERPAW_SPECS["browserpaw_interact_index"]["builder"]
    assert b_interact({"action": None, "index": None}, 40) == "element [#] (click)"
    assert b_interact({"action": "hover", "index": 0}, 40) == "element [#0] (hover)"

    # None and value fallback for fill_index
    b_fill = BROWSERPAW_SPECS["browserpaw_fill_index"]["builder"]
    assert b_fill({"index": 1, "value": "my_val"}, 40) == 'element [#1]: "my_val"'
    assert b_fill({"index": None, "text": None}, 40) == 'element [#]: ""'
    assert b_fill({"index": 0, "text": "zero_index"}, 40) == 'element [#0]: "zero_index"'
    assert b_fill({"index": 1, "text": 0}, 40) == 'element [#1]: "0"'

    # Batch actions with non-list
    b_batch = BROWSERPAW_SPECS["browserpaw_batch_actions"]["builder"]
    assert b_batch({"actions": "not_a_list"}, 40) is None
    assert b_batch({}, 40) is None
    assert b_batch({"actions": []}, 40) == "0 actions"

    # Close tabs with various args
    b_close = BROWSERPAW_SPECS["browserpaw_close_tabs"]["builder"]
    assert b_close({}, 40) == "current"
    assert b_close({"tabIds": []}, 40) == "0 tabs"
    assert b_close({"tabId": 101}, 40) == "tab [#101]"
    assert b_close({"tabId": 0}, 40) == "tab [#0]"
    assert b_close({"url": "https://example.com"}, 40) == "url: https://example.com"

    # Read DOM with scope alias
    b_dom = BROWSERPAW_SPECS["browserpaw_read_dom"]["builder"]
    assert b_dom({"scope": "#cart"}, 40) == "scoped to '#cart'"
    assert b_dom({"selector": "#cart"}, 40) == "scoped to '#cart'"
    assert b_dom({}, 40) == "viewport"

    # Computer tool with and without coordinates
    b_comp = BROWSERPAW_SPECS["browserpaw_computer"]["builder"]
    assert b_comp({"action": "screenshot"}, 40) == "action: screenshot"
    assert b_comp({"action": "click"}, 40) == "action: click"
    assert b_comp({"action": "click", "x": 10, "y": 20}, 40) == "action: click at (10, 20)"
    assert b_comp({"action": "click", "coordinate": [10, 20]}, 40) == "action: click at (10, 20)"

    # Upload file with clickTargetIndex alias
    b_upload = BROWSERPAW_SPECS["browserpaw_upload_file"]["builder"]
    assert b_upload({"filePath": "/tmp/a.png", "clickTargetIndex": 7}, 40) == '"/tmp/a.png" -> element [#7]'

    # Tab group update without title
    b_tg_update = BROWSERPAW_SPECS["browserpaw_tab_group_update"]["builder"]
    assert b_tg_update({"groupId": 2, "color": "blue"}, 40) == 'group [#2]: color="blue"'

    # Switch tab with 0 and None
    b_switch = BROWSERPAW_SPECS["browserpaw_switch_tab"]["builder"]
    assert b_switch({"tabId": 0}, 40) == "tab [#0]"
    assert b_switch({"tabId": None}, 40) == "tab [#]"

    # Inspect media with 0 and None
    b_media = BROWSERPAW_SPECS["browserpaw_inspect_media"]["builder"]
    assert b_media({"index": 0}, 40) == "element [#0]"
    assert b_media({"index": None}, 40) == "element [#]"

    # Smart scroll with None
    b_scroll = BROWSERPAW_SPECS["browserpaw_smart_scroll"]["builder"]
    assert b_scroll({"direction": None, "amount": None}, 40) == "down (page)"



def test_status_phrase_and_quiet_mode_integration():
    """Verify status phrase, tool label, and quiet mode CLI rendering."""
    from agent.display import build_status_phrase, build_tool_label, get_cute_tool_message
    ctx = MagicMock()
    plugin.register(ctx)

    label1 = build_tool_label("browserpaw_interact_index", {"action": "click", "index": 67})
    assert label1 == "Interacting with element [#67] (click)"

    label2 = build_tool_label("browserpaw_get_windows_and_tabs", {})
    assert label2 == "Listing open tabs"

    status1 = build_status_phrase("browserpaw_interact_index", {"action": "click", "index": 67})
    assert status1 is not None
    assert "interacting with" in status1.lower()
    assert "element [#67] (click)" in status1

    cute1 = get_cute_tool_message("browserpaw_interact_index", {"action": "click", "index": 67}, 0.25)
    assert "🎯" in cute1
    assert "element [#67] (click)" in cute1

    cute2 = get_cute_tool_message("browserpaw_get_windows_and_tabs", {}, 0.1)
    assert "🪟" in cute2
    assert "active windows" in cute2


def test_builtin_tools_isolation_no_regression():
    """Verify wrapping does not regress standard built-in tools."""
    ctx = MagicMock()
    plugin.register(ctx)

    assert build_tool_preview("terminal", {"command": "echo hello"}) == "echo hello"
    assert build_tool_preview("terminal", {}) is None
    assert build_tool_preview("terminal", None) is None


def test_gateway_platform_and_turn_runner_rendering():
    """Verify live rendering simulation in gateway platforms (Telegram/Discord/Slack) and CLI runner."""
    from gateway.stream_events import ToolCallChunk
    from gateway.platforms.base import BasePlatformAdapter
    from agent.display import tool_verb_connector, verb_drops_preview

    ctx = MagicMock()
    plugin.register(ctx)

    class TestAdapter(BasePlatformAdapter):
        async def connect(self): pass
        async def disconnect(self): pass
        async def get_chat_info(self, chat_id): pass
        async def send(self, *args, **kwargs): pass

    adapter = TestAdapter(config={}, platform="telegram")

    # 1. Telegram / Gateway platform format: 🎯 browserpaw_interact_index: "element [#67] (click)"
    p_interact = prepare_tool_preview("browserpaw_interact_index", {"action": "click", "index": 67}, fallback="", max_len=40)
    chunk1 = ToolCallChunk(tool_name="browserpaw_interact_index", args={"action": "click", "index": 67}, preview=p_interact.text)
    line1 = adapter.format_tool_event(chunk1, mode="all", preview_max_len=40)
    assert line1 == '🎯 browserpaw_interact_index: "element [#67] (click)"'

    # Zero-arg platform format: 🪟 browserpaw_get_windows_and_tabs: "active windows"
    p_tabs = prepare_tool_preview("browserpaw_get_windows_and_tabs", {}, fallback="", max_len=40)
    chunk2 = ToolCallChunk(tool_name="browserpaw_get_windows_and_tabs", args={}, preview=p_tabs.text)
    line2 = adapter.format_tool_event(chunk2, mode="all", preview_max_len=40)
    assert line2 == '🪟 browserpaw_get_windows_and_tabs: "active windows"'

    # Zero-arg get_markdown platform format: 📄 browserpaw_get_markdown: "full page"
    p_md = prepare_tool_preview("browserpaw_get_markdown", {}, fallback="", max_len=40)
    chunk3 = ToolCallChunk(tool_name="browserpaw_get_markdown", args={}, preview=p_md.text)
    line3 = adapter.format_tool_event(chunk3, mode="all", preview_max_len=40)
    assert line3 == '📄 browserpaw_get_markdown: "full page"'

    # 2. CLI / Desktop runner status line: 🎯 Interacting with element [#67] (click)
    em1 = get_tool_emoji("browserpaw_interact_index")
    vb1 = get_tool_verb("browserpaw_interact_index")
    card1 = f"{em1} {vb1}" if verb_drops_preview("browserpaw_interact_index") else f"{em1} {vb1}{tool_verb_connector('browserpaw_interact_index')}{p_interact.text}"
    assert card1 == "🎯 Interacting with element [#67] (click)"

    # Zero-arg runner line (drops preview): 🪟 Listing open tabs
    em_tabs = get_tool_emoji("browserpaw_get_windows_and_tabs")
    vb_tabs = get_tool_verb("browserpaw_get_windows_and_tabs")
    card_tabs = f"{em_tabs} {vb_tabs}" if verb_drops_preview("browserpaw_get_windows_and_tabs") else f"{em_tabs} {vb_tabs}{tool_verb_connector('browserpaw_get_windows_and_tabs')}{p_tabs.text}"
    assert card_tabs == "🪟 Listing open tabs"

    # Autonomous micro-looping card
    p_goal = prepare_tool_preview("browserpaw_act_toward_goal", {"goal": "点击登录并提交"}, fallback="", max_len=40)
    em3 = get_tool_emoji("browserpaw_act_toward_goal")
    vb3 = get_tool_verb("browserpaw_act_toward_goal")
    card3 = f"{em3} {vb3}" if verb_drops_preview("browserpaw_act_toward_goal") else f"{em3} {vb3}{tool_verb_connector('browserpaw_act_toward_goal')}{p_goal.text}"
    assert card3 == "💫 Autonomous micro-looping 点击登录并提交"


def test_extended_previews_all_categories():
    """Verify preview formatting logic for developer, media, form, tab group, storage, and performance tools."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 2. 开发者与底层逃生门
    assert prepare_tool_preview("browserpaw_javascript", {"code": "document.title = 'test'"}, fallback="", max_len=60).text == 'script: "document.title = \'test\'"'
    assert prepare_tool_preview("browserpaw_cdp_execute", {"method": "Page.reload"}, fallback="", max_len=60).text == 'method: "Page.reload"'
    assert prepare_tool_preview("browserpaw_console", {}, fallback="", max_len=60).text == "browser console logs"
    assert prepare_tool_preview("browserpaw_doctor", {}, fallback="", max_len=60).text == "diagnostic probe"
    assert prepare_tool_preview("browserpaw_undo_last_action", {}, fallback="", max_len=60).text == "reverting last DOM mutation"

    # 3. 文件、媒体与弹窗/人工干预
    assert prepare_tool_preview("browserpaw_upload_file", {"filePath": "/path/to/file.png", "index": 4}, fallback="", max_len=60).text == '"/path/to/file.png" -> element [#4]'
    assert prepare_tool_preview("browserpaw_insert_media", {"filePath": "photo.jpg"}, fallback="", max_len=60).text == 'media: "photo.jpg"'
    assert prepare_tool_preview("browserpaw_insert_media", {"fileName": "photo2.jpg"}, fallback="", max_len=60).text == 'media: "photo2.jpg"'
    assert prepare_tool_preview("browserpaw_handle_download", {"filenameContains": "report.pdf"}, fallback="", max_len=60).text == 'filename: "report.pdf"'
    assert prepare_tool_preview("browserpaw_handle_download", {"action": "cancel"}, fallback="", max_len=60).text == 'filename: "cancel"'
    assert prepare_tool_preview("browserpaw_handle_dialog", {"action": "accept", "promptText": "confirm"}, fallback="", max_len=60).text == 'action: accept (prompt: "confirm")'
    assert prepare_tool_preview("browserpaw_handle_dialog", {"action": "dismiss"}, fallback="", max_len=60).text == "action: dismiss"
    assert prepare_tool_preview("browserpaw_request_human_intervention", {"reason": "2FA required"}, fallback="", max_len=60).text == 'reason: "2FA required"'

    # 4. 遮罩、按键与系统视觉兜底
    assert prepare_tool_preview("browserpaw_dismiss_overlay", {}, fallback="", max_len=60).text == "clearing modal backdrop"
    assert prepare_tool_preview("browserpaw_keyboard", {"keys": "Enter"}, fallback="", max_len=60).text == 'keys: "Enter"'
    assert prepare_tool_preview("browserpaw_keyboard", {"key": "Tab"}, fallback="", max_len=60).text == 'keys: "Tab"'
    assert prepare_tool_preview("browserpaw_computer", {"action": "click", "x": 100, "y": 200}, fallback="", max_len=60).text == "action: click at (100, 200)"
    assert prepare_tool_preview("browserpaw_computer", {"action": "move", "coordinate": [50, 60]}, fallback="", max_len=60).text == "action: move at (50, 60)"

    # 5. 高级表单与网络捕获
    assert prepare_tool_preview("browserpaw_form_pipeline", {"fields": [{"name": "a"}, {"name": "b"}]}, fallback="", max_len=60).text == "fields: 2 items"
    assert prepare_tool_preview("browserpaw_get_dropdown_options", {"index": 7}, fallback="", max_len=60).text == "element [#7]"
    assert prepare_tool_preview("browserpaw_intercept_api", {"urlPattern": "*/users/*"}, fallback="", max_len=60).text == 'urlPattern: "*/users/*"'
    assert prepare_tool_preview("browserpaw_network_request", {"method": "POST", "url": "https://api.test"}, fallback="", max_len=60).text == 'POST: "https://api.test"'
    assert prepare_tool_preview("browserpaw_network_capture", {"action": "start", "urlPattern": "*.json"}, fallback="", max_len=60).text == 'action: start (pattern: "*.json")'

    # 6. 标签组与标签移动
    assert prepare_tool_preview("browserpaw_tab_group_create", {"title": "Research", "tabIds": [10, 11]}, fallback="", max_len=60).text == 'title: "Research" (2 tabs)'
    assert prepare_tool_preview("browserpaw_tab_group_create", {"title": "Empty"}, fallback="", max_len=60).text == 'title: "Empty" (0 tabs)'
    assert prepare_tool_preview("browserpaw_tab_group_update", {"groupId": 3, "title": "Dev"}, fallback="", max_len=60).text == 'group [#3]: title="Dev"'
    assert prepare_tool_preview("browserpaw_tab_group_list", {}, fallback="", max_len=60).text == "active window groups"
    assert prepare_tool_preview("browserpaw_tab_group_close", {"groupId": 3}, fallback="", max_len=60).text == "group [#3]"
    assert prepare_tool_preview("browserpaw_tab_group_ungroup", {"tabId": 8}, fallback="", max_len=60).text == "tab [#8]"
    assert prepare_tool_preview("browserpaw_move_tab", {"tabId": 8, "windowId": 2}, fallback="", max_len=60).text == "tab [#8] -> window [#2]"
    assert prepare_tool_preview("browserpaw_attach_tab", {"tabId": 8}, fallback="", max_len=60).text == "tab [#8] to debugger"
    assert prepare_tool_preview("browserpaw_detach_tab", {"tabId": 8}, fallback="", max_len=60).text == "tab [#8] from debugger"

    # 7. 存储、历史与书签
    assert prepare_tool_preview("browserpaw_storage", {"types": ["local", "session"]}, fallback="", max_len=60).text == "types: local, session"
    assert prepare_tool_preview("browserpaw_storage", {}, fallback="", max_len=60).text == "types: local"
    assert prepare_tool_preview("browserpaw_history", {"text": "hermes"}, fallback="", max_len=60).text == 'query: "hermes"'
    assert prepare_tool_preview("browserpaw_bookmark_search", {"query": "news"}, fallback="", max_len=60).text == 'query: "news"'
    assert prepare_tool_preview("browserpaw_bookmark_add", {"title": "Docs"}, fallback="", max_len=60).text == 'title: "Docs"'
    assert prepare_tool_preview("browserpaw_bookmark_delete", {"bookmarkId": "b12"}, fallback="", max_len=60).text == 'id: "b12"'

    # 8. 性能分析
    assert prepare_tool_preview("browserpaw_performance_start_trace", {"categories": ["timeline"]}, fallback="", max_len=60).text == "categories: timeline"
    assert prepare_tool_preview("browserpaw_performance_start_trace", {}, fallback="", max_len=60).text == "categories: timeline"
    assert prepare_tool_preview("browserpaw_performance_stop_trace", {}, fallback="", max_len=60).text == "saving trace file"
    assert prepare_tool_preview("browserpaw_performance_analyze_insight", {"insightName": "LCP"}, fallback="", max_len=60).text == 'insight: "LCP"'


def test_alias_penetration():
    """Verify bidirectional alias penetration between chrome_* and browserpaw_*."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 1. upload_file penetration
    assert get_tool_emoji("chrome_upload_file") == get_tool_emoji("browserpaw_upload_file") == "📤"
    assert get_tool_verb("chrome_upload_file") == get_tool_verb("browserpaw_upload_file") == "Uploading file"
    p_chrome = build_tool_preview("chrome_upload_file", {"filePath": "/test.txt", "index": 5})
    p_paw = build_tool_preview("browserpaw_upload_file", {"filePath": "/test.txt", "index": 5})
    assert p_chrome == p_paw == '"/test.txt" -> element [#5]'

    # 2. get_windows_and_tabs penetration
    assert get_tool_emoji("get_windows_and_tabs") == get_tool_emoji("browserpaw_get_windows_and_tabs") == "🪟"
    assert get_tool_verb("get_windows_and_tabs") == get_tool_verb("browserpaw_get_windows_and_tabs") == "Listing open tabs"
    assert build_tool_preview("get_windows_and_tabs", {}) == build_tool_preview("browserpaw_get_windows_and_tabs", {}) == "active windows"

    # 3. navigate penetration
    assert get_tool_emoji("chrome_navigate") == get_tool_emoji("browserpaw_navigate") == "🌐"
    assert get_tool_verb("chrome_navigate") == get_tool_verb("browserpaw_navigate") == "Navigating to"
    assert build_tool_preview("chrome_navigate", {"url": "https://example.com"}) == "https://example.com"


def test_unknown_fallback_guard():
    """Verify unknown/unregistered browserpaw_* and chrome_* tools fall back safely."""
    ctx = MagicMock()
    plugin.register(ctx)

    # Emoji fallback must be 🌐, never 🔧 or ⚡
    assert get_tool_emoji("browserpaw_unknown_mock_tool") == "🌐"
    assert get_tool_emoji("browserpaw_unknown_mock_tool", default="🔧") == "🌐"
    assert get_tool_emoji("chrome_unknown_mock_tool") == "🌐"
    assert get_tool_emoji("chrome_unknown_mock_tool", default="🔧") == "🌐"
    assert registry.get_emoji("browserpaw_unknown_mock_tool") == "🌐"
    assert registry.get_emoji("chrome_unknown_mock_tool") == "🌐"

    # Verb dynamically generated from name
    assert get_tool_verb("browserpaw_unknown_mock_tool") == "Executing unknown mock tool"
    assert get_tool_verb("chrome_custom_probe") == "Executing custom probe"

    # Previews do not crash
    assert build_tool_preview("browserpaw_unknown_mock_tool", {}) is None
    assert build_tool_preview("browserpaw_unknown_mock_tool", None) is None
    p_fallback = prepare_tool_preview("browserpaw_unknown_mock_tool", {}, fallback="my_fallback", max_len=40)
    assert p_fallback.text == "my_fallback"


def test_no_preview_tools_set():
    """Verify tools in NO_PREVIEW set drop previews in status labels and verb_drops_preview."""
    from agent.display import build_tool_label, verb_drops_preview
    ctx = MagicMock()
    plugin.register(ctx)

    no_preview_names = [
        "browserpaw_get_windows_and_tabs",
        "get_windows_and_tabs",
        "browserpaw_tab_group_list",
        "chrome_tab_group_list",
        "browserpaw_doctor",
        "chrome_doctor",
    ]

    for name in no_preview_names:
        assert verb_drops_preview(name) is True, f"{name} should be in _TOOL_VERBS_NO_PREVIEW"

    assert build_tool_label("browserpaw_get_windows_and_tabs", {}) == "Listing open tabs"
    assert build_tool_label("get_windows_and_tabs", {}) == "Listing open tabs"
    assert build_tool_label("browserpaw_doctor", {}) == "Running doctor check"
    assert build_tool_label("chrome_doctor", {}) == "Running doctor check"
    assert build_tool_label("browserpaw_tab_group_list", {}) == "Listing tab groups"
    assert build_tool_label("chrome_tab_group_list", {}) == "Listing tab groups"


def test_none_type_and_malicious_input_guards():
    """Verify that None tool_names or malicious inputs do not trigger unhandled exceptions."""
    ctx = MagicMock()
    plugin.register(ctx)

    # 1. None tool_name guards across all display hooks
    assert get_tool_emoji(None) == "⚡"
    assert get_tool_emoji(None, default="🔧") == "🔧"
    assert get_tool_verb(None) is None
    assert registry.get_emoji(None) == "⚡"
    assert registry.get_emoji(None, default="🔧") == "🔧"
    assert build_tool_preview(None, {}) is None
    assert build_tool_preview(None, None) is None

    # Empty string tool_name guards
    assert get_tool_emoji("") == "⚡"
    assert get_tool_verb("") is None
    assert registry.get_emoji("") == "⚡"


def test_deferred_tool_call_unwrap_rendering():
    """Verify deferred bridge tool_call calls unwrap to their underlying tool preview, verb, and emoji."""
    from gateway.stream_events import ToolCallChunk
    from gateway.platforms.base import BasePlatformAdapter
    from gateway.run_turn_runner import TurnRunner
    from unittest.mock import Mock

    ctx = MagicMock()
    plugin.register(ctx)

    args = {"calls": [{"name": "browserpaw_navigate", "arguments": {"url": "https://x.com/i/bookmarks"}}]}

    # 1. Test unwrap in prepare_tool_preview / build_tool_preview
    p = prepare_tool_preview("tool_call", args, fallback="", max_len=60)
    assert p.text == "https://x.com/i/bookmarks"
    assert build_tool_preview("tool_call", args) == "https://x.com/i/bookmarks"

    # 2. Test unwrap in platform format_tool_event
    class TestAdapter(BasePlatformAdapter):
        async def connect(self): pass
        async def disconnect(self): pass
        async def get_chat_info(self, chat_id): pass
        async def send(self, *args, **kwargs): pass

    adapter = TestAdapter(config={}, platform="telegram")
    chunk = ToolCallChunk(tool_name="tool_call", args=args, preview="")
    line = adapter.format_tool_event(chunk, mode="all", preview_max_len=60)
    assert line == '🌐 browserpaw_navigate: "https://x.com/i/bookmarks"'

    # 3. Test unwrap in TurnRunner._progress_build_message (CLI & live status line)
    mock_ctx = Mock()
    mock_ctx.progress_mode = "all"
    mock_ctx.source = Mock()
    mock_ctx.source.platform = "telegram"
    mock_ctx.last_was_terminal_block = [False]
    mock_runner = Mock()
    mock_runner._delivery_adapter_for.return_value = None

    runner = TurnRunner(mock_runner, mock_ctx)
    msg = runner._progress_build_message("tool_call", "", args)
    assert msg == "🌐 Navigating to https://x.com/i/bookmarks"

    assert build_tool_preview("", {}) is None

    # 2. Malicious inputs: unescaped quotes, control chars, newlines, HTML/script injections
    p_goal_quotes = prepare_tool_preview(
        "browserpaw_act_toward_goal",
        {"goal": 'Find "cheapest" <laptop> & \n checkout now!'},
        fallback="",
        max_len=60,
    )
    assert '"' not in p_goal_quotes.text
    assert "\n" not in p_goal_quotes.text
    assert p_goal_quotes.text == "Find cheapest <laptop> & checkout now!"

    p_js_newlines = prepare_tool_preview(
        "browserpaw_javascript",
        {"code": 'const el = document.querySelector("#id");\nreturn el.textContent;'},
        fallback="",
        max_len=60,
    )
    assert "\n" not in p_js_newlines.text
    assert p_js_newlines.text == 'script: "const el = document.querySelector("#id")..."'

