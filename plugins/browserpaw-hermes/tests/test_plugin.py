import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_INIT = PLUGIN_ROOT / "__init__.py"

spec = importlib.util.spec_from_file_location("browserpaw_hermes_v5", PLUGIN_INIT)
assert spec and spec.loader
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def test_manifest_and_version_parity():
    root_version = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    yaml_text = (PLUGIN_ROOT / "plugin.yaml").read_text(encoding="utf-8")
    assert f"version: '{root_version}'" in yaml_text
    assert "provides_tools:\n  - browserpaw" in yaml_text
    assert (PLUGIN_ROOT / "skills" / "browserpaw" / "SKILL.md").is_file()


def test_register_binds_skill_and_single_cli_tool():
    ctx = MagicMock()
    plugin.register(ctx)

    ctx.register_skill.assert_called_once_with(
        "browserpaw",
        PLUGIN_ROOT / "skills" / "browserpaw" / "SKILL.md",
    )
    ctx.register_tool.assert_called_once()
    kwargs = ctx.register_tool.call_args.kwargs
    assert kwargs["name"] == "browserpaw"
    assert kwargs["toolset"] == "browserpaw"
    assert kwargs["schema"] == plugin.BROWSERPAW_TOOL_SCHEMA


def test_handler_validates_args_and_reports_missing_cli(monkeypatch):
    ctx = MagicMock()
    ctx.get_config.return_value = ""
    handler = plugin._make_handler(ctx)

    bad = json.loads(handler({"args": []}))
    assert bad["ok"] is False
    assert "non-empty list" in bad["error"]

    monkeypatch.setattr(plugin.shutil, "which", lambda _name: None)
    missing = json.loads(handler({"args": ["status"]}))
    assert missing["ok"] is False
    assert "npm install -g browserpaw" in missing["error"]


def test_handler_invokes_cli_without_shell_and_appends_media(monkeypatch, tmp_path):
    request_id = "61fd9a5a-9e6b-4643-aaed-41fdc9d99afb"
    monkeypatch.setenv("BROWSERPAW_HOME", str(tmp_path))
    shot = tmp_path.resolve() / "out" / "misc" / request_id / "item-1.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"\x89PNG\r\n\x1a\n")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({
                "ok": True,
                "command": cmd[cmd.index("--json") + 1] if cmd[1] == "--json" else cmd[1],
                "requestId": request_id,
                "data": {"content": [{
                    "type": "artifact_ref", "originalType": "image", "path": str(shot)
                }]},
            }),
            stderr="",
        )

    monkeypatch.setattr(plugin.shutil, "which", lambda _name: "/usr/local/bin/browserpaw")
    monkeypatch.setattr(plugin.subprocess, "run", fake_run)

    ctx = MagicMock()
    ctx.get_config.side_effect = lambda key, default=None: default
    handler = plugin._make_handler(ctx)

    raw = handler({"args": ["screenshot", "--out", str(shot), "--json"]})
    lines = raw.splitlines()
    body = json.loads(lines[0])

    assert body["ok"] is True
    assert body["exitCode"] == 0
    assert body["media"] == [str(shot.resolve())]
    assert captured["cmd"] == ["/usr/local/bin/browserpaw", "screenshot", "--out", str(shot), "--json"]
    assert captured["kwargs"]["shell"] is False
    assert any(line == f"MEDIA:{shot.resolve()}" for line in lines[1:])
    assert "MEDIA:" not in handler({"args": ["eval", "fixture", "--json"]})
    assert "MEDIA:" in handler({"args": ["screenshot"]})


def test_ignores_arbitrary_and_outside_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("BROWSERPAW_HOME", str(tmp_path / "managed"))
    image = tmp_path / "item-1.png"
    image.write_bytes(b"fixture")
    assert plugin._extract_media_paths(str(image)) == []
    assert plugin._extract_media_paths(json.dumps({
        "ok": True, "command": "screenshot", "requestId": "61fd9a5a-9e6b-4643-aaed-41fdc9d99afb",
        "data": {"content": [{"type": "artifact_ref", "originalType": "image", "path": str(image)}]},
    })) == []
