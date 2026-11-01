# Blueprint M0/M1 当前验证记录

日期：2026-10-27

本文只记录当前工作区已经实际执行的专项验证，不代表新版安装包已经部署。

## M1：deadline 与动作安全

### 已实现

- `fill-core.ts` 接受可选 `deadlineAt`；无 deadline 时保持旧调用形态。
- `performPhysicalFill` 在关键 mutation 前检查剩余预算，并把剩余 timeout 传给 `executeInPage`、`raceCdp`、nested `interactIndexTool.execute` 和 `dispatchNativeSelectAll`。
- deadline 在已派发的 mutation 中过期时按 unknown 处理，不把取消视为回滚；deadline 在 mutation 前过期时不继续 submit。
- `handleAutoSubmit` 在按钮等待、点击、Enter fallback 和 synthetic fallback 前重新检查 deadline。
- `form-pipeline.ts` 在慢 fill 返回后再次检查 deadline；过期后不再 locate submit/next 按钮、不再点击、不进入下一字段。
- `BatchActionItem` 与 `FillFormField` 已补充 `frameId` 类型。

### 专项结果

- `tests/fill-deadline-and-form-stop.test.ts`：4/4 通过。包含真实 `form-pipeline -> performPhysicalFill -> handleAutoSubmit` 链、受控慢 fill、future deadline nested interact、unknown dispatch 场景。
- fill/batch/frame 相关 6 个测试文件：66/66 通过。
- keyboard/form/interact 相关 7 个测试文件：110/110 通过。
- `pnpm exec vue-tsc --noEmit`：通过。
- 目标文件 ESLint：通过。

## M0：多客户端技能与插件分发

### 已实现

- `skills/browserpaw/` 是唯一客户端中立的 Agent Skill，按需拆分为
  `references/`、`scripts/` 和 `assets/recipes/`。
- 五个发行位置保持独立：ChatGPT/Codex portable plugin、Hermes 原生插件、
  Claude Code plugin、DSH bundle，以及 Native npm 包内的 skill 副本。
- `scripts/sync-skills.mjs` 生成各客户端 skill 镜像，并检查漂移、孤儿、
  错误文件类型、symlink/junction、canonical 客户端词泄漏与损坏引用。
- `browserpaw skill install` 从 Native 包安装 canonical skill；默认写入
  `~/.agents/skills/browserpaw`，支持显式 `--target`，拒绝未带安装标记的
  同名目录、路径逃逸和 symlink/junction。
- ChatGPT/Codex 使用根 `plugin.json`、`mcp.json`、`skills/` 与
  `.agents/plugins/marketplace.json`；旧的 `.codex-plugin/` 和
  `mcp-skills/` 兼容副本已删除。
- Hermes 使用独立 `plugins/browserpaw-hermes/`；声明包装器继续通过
  `ctx.call_mcp('browserpaw', ...)` 委托，不读取凭据、不自行管理连接。
- Claude Code 使用 `.claude-plugin/plugin.json`、`.mcp.json` 和根
  `.claude-plugin/marketplace.json`。
- DSH 使用 `dsh.bundle.patch`、`cordis.patch.yml` 和隔离的 Cordis 运行时适配。
- 自学习技能仍由 Native 管理在 `$BROWSERPAW_HOME/skills`；静态 skill、随包
  recipe 和动态学习库互不复制。

### 专项结果

- `node scripts/sync-skills.mjs --check`：通过。
- portable/Claude/DSH/sync 合同测试：34/34 通过。
- Hermes `pytest plugins/browserpaw-hermes/tests -q`：40 passed。
- `hermes plugins validate plugins/browserpaw-hermes` 与宿主注册检查：通过。
- Claude Code `2.1.309` 插件和 marketplace 严格验证：通过。
- ChatGPT/Codex `0.166.0` 隔离 marketplace 安装：通过。
- DSH `0.2.1-rc.3` 打包、隔离安装和 `--dump-config`：通过。
- Native skill 安装器默认路径、自定义路径、`--force` 标记保护、junction
  拒绝和文件哈希检查：通过。

## 未验证/未执行

- 未把本文件中的专项结果当作新构建的完整发布门禁；最终状态以随后生成的全量验证记录和部署校验为准。
- 新构建尚需重载后核对 runtime buildId 并执行真实会话验收。
