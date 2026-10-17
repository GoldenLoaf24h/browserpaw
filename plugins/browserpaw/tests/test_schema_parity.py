"""Generic schema parity test verifying Python TOOL_DEFINITIONS against packages/shared/src/tools.ts SSOT."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def _load_plugin():
    init_path = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("browserpaw_parity_test", init_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_ssot_tool_schemas():
    """Load canonical tool schemas from packages/shared/src/tools.ts without relying on stale dist."""
    repo_root = Path(__file__).resolve().parents[3]
    shared_tools_path = repo_root / "packages" / "shared" / "src" / "tools.ts"
    assert shared_tools_path.is_file(), f"SSOT file not found at {shared_tools_path}"

    js_code = """
import("./packages/shared/src/tools.ts").then(m => {
  const result = {};
  for (const t of m.TOOL_SCHEMAS) {
    result[t.name] = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    };
  }
  console.log(JSON.stringify(result));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
"""
    proc = subprocess.run(
        ["node", "--no-warnings", "--experimental-strip-types", "-e", js_code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(repo_root),
        check=True,
    )
    return json.loads(proc.stdout)


def _load_declared_tools():
    """Read the curated tool list from plugin.yaml so the subset is not re-hardcoded here."""
    plugin_yaml = Path(__file__).resolve().parents[1] / "plugin.yaml"
    tools = []
    in_block = False
    for line in plugin_yaml.read_text(encoding="utf-8").splitlines():
        if line.startswith("provides_tools:"):
            in_block = True
            continue
        if in_block:
            if line.startswith("  - "):
                tools.append(line[4:].strip())
            elif line.strip():
                break
    assert tools, f"No provides_tools entries parsed from {plugin_yaml}"
    return tools


def _remote_name_for(py_name: str) -> str:
    if py_name == "browserpaw_get_windows_and_tabs":
        return "get_windows_and_tabs"
    return "chrome_" + py_name.removeprefix("browserpaw_")


def _compare_node(py_node, ssot_node, path, diffs):
    """Recursively compare one schema node: type, enum, required, properties and nested items.

    "description" and "default" are intentionally not compared: prose is tuned per host
    (Hermes vs Codex vs DSH) and defaults are applied by the host runtime, so neither is part
    of the callable parameter contract this test locks down.
    """
    if not isinstance(py_node, dict) or not isinstance(ssot_node, dict):
        return

    if py_node.get("type") != ssot_node.get("type"):
        diffs.append(
            f"{path}.type mismatch: py={py_node.get('type')} vs ssot={ssot_node.get('type')}"
        )

    py_enum = list(py_node.get("enum", []))
    ssot_enum = list(ssot_node.get("enum", []))
    if py_enum or ssot_enum:
        for value in ssot_enum:
            if value not in py_enum:
                diffs.append(f"{path}.enum missing value '{value}' in Python")
        for value in py_enum:
            if value not in ssot_enum:
                diffs.append(f"{path}.enum has value '{value}' not present in SSOT")

    py_props = py_node.get("properties", {})
    ssot_props = ssot_node.get("properties", {})
    for name in sorted(set(ssot_props) - set(py_props)):
        diffs.append(f"{path}.properties.{name} missing in Python")
    for name in sorted(set(py_props) - set(ssot_props)):
        diffs.append(f"{path}.properties.{name} not present in SSOT")

    py_required = sorted(py_node.get("required", []))
    ssot_required = sorted(ssot_node.get("required", []))
    if py_required != ssot_required:
        diffs.append(f"{path}.required mismatch: py={py_required} vs ssot={ssot_required}")

    for name in sorted(set(py_props) & set(ssot_props)):
        _compare_node(py_props[name], ssot_props[name], f"{path}.properties.{name}", diffs)

    if "items" in py_node or "items" in ssot_node:
        if "items" not in py_node:
            diffs.append(f"{path}.items missing in Python")
        elif "items" not in ssot_node:
            diffs.append(f"{path}.items not present in SSOT")
        else:
            _compare_node(py_node["items"], ssot_node["items"], f"{path}.items", diffs)


def test_curated_16_tool_subset_preserved():
    """Verify Hermes exposes exactly the tools declared in plugin.yaml (no additions, no deletions)."""
    plugin = _load_plugin()
    declared = set(_load_declared_tools())
    assert set(plugin.TOOL_DEFINITIONS.keys()) == declared


def test_schema_parity_against_shared_ssot():
    """F-03: bidirectional property/required/type/enum/items parity against the shared SSOT."""
    plugin = _load_plugin()
    ssot = _load_ssot_tool_schemas()
    diffs = []

    for py_name, py_tool in plugin.TOOL_DEFINITIONS.items():
        remote_name = _remote_name_for(py_name)
        assert remote_name in ssot, f"Remote tool {remote_name} not found in SSOT"
        _compare_node(
            py_tool.get("inputSchema", {}),
            ssot[remote_name].get("inputSchema", {}),
            py_name,
            diffs,
        )

    assert not diffs, "Schema drift detected vs SSOT:\n" + "\n".join(diffs)
