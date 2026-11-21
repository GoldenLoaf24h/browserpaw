# BrowserPaw

[English](README.md)

BrowserPaw 让任意具备命令执行能力的 AI Agent 通过命令行高效、确定地操控你正在使用的桌面版 Chrome 或 Chromium——直接复用已登录状态、Cookie 与浏览器扩展，无需另起无头浏览器，也不会用几十个 MCP Schema 挤占 Agent 上下文。

Agent 阅读标准 Agent Skill 后即可通过认证的本地回环桥接（`com.browserpaw.nativehost`）运行精简的 `browserpaw` CLI 命令，并获得紧凑的 JSON/文本回执，或截图、Trace 与导出文件的本地路径。

> **从 v4.x 升级？** BrowserPaw v5.0.0 已由 MCP 服务、REPL 与 Jev 切换为统一的 `browserpaw` CLI、标准 Agent Skill 与 v5 客户端插件。请阅读 [v5.0.0 迁移指南](docs/MIGRATION.zh-CN.md)（[English](docs/MIGRATION.md)）完成迁移，或直接让你的 Agent 阅读 `docs/MIGRATION.zh-CN.md` 代为执行迁移配置。

## 快速开始（首推：全局 Skill + npm + Chrome 扩展）

需要 **Node.js 22.6+** 与 Windows、macOS 或 Linux 桌面版 Chrome 或 Chromium。先全局安装 CLI 并运行 `setup`（自动注册 Native Messaging 宿主并将基础技能全局安装到 `~/.agents/skills/browserpaw`，Windows 为 `%USERPROFILE%\.agents\skills\browserpaw`），再在 Chrome 或 Chromium 加载扩展：

```sh
npm install -g browserpaw@5.0.0
browserpaw setup
```

> **关于 npm 安装时机：** `npm install -g browserpaw@5.0.0` 与 `npx browserpaw@5.0.0` 适用于 `5.0.0` 正式发布到 npm 之后；安装本地发布候选包请使用 `npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup`。

随后在浏览器打开 `chrome://extensions`（Chromium 为 `chromium://extensions`），开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `setup` 输出的扩展目录（默认 `~/.browserpaw/extension`，Windows 为 `%USERPROFILE%\.browserpaw\extension`），完成后运行 `browserpaw status` 验证连接。

| 安装方式                            | 适用场景                                                      | 命令                                                  |
| :---------------------------------- | :------------------------------------------------------------ | :---------------------------------------------------- |
| **全局 Skill + npm CLI** _（首推）_ | Codex、Claude Code、Cursor、Windsurf、DSH 等日常主力使用      | `npm install -g browserpaw@5.0.0 && browserpaw setup` |
| **`npx` / 离线包 / 项目级 Skill**   | 不全局安装或按工作区安装技能（`./.agents/skills/browserpaw`） | `npx browserpaw@5.0.0 setup --skill-scope project`    |
| **官方客户端插件**                  | 通过宿主内置插件市场安装（只读基础技能 + npm CLI）            | 见下方 [客户端插件](#客户端插件持续同步支持)          |

- **常用安装参数：** `--skill-scope user`（默认）、`--skill-scope project`、`--skill-dir DIR`、`--no-skill` 以及 `--browser chromium`。
- 完整多路径安装说明与 Agent 协助安装指引见 [安装指南（INSTALL.md）](INSTALL.md)。
- **升级说明：** 每个新版 CLI 仅在 `stderr` 提醒一次。升级 CLI 并重新运行 `browserpaw setup` 即可更新 Native Host 与受管基础 Skill；Chrome MV3 扩展仍需在 `chrome://extensions` 手动更新或重载。[升级指南](INSTALL.md#upgrade-an-existing-v5-installation)

## 客户端插件（持续同步支持）

四个官方客户端插件均与规范技能源 `skills/browserpaw/` 和 v5 CLI 保持统一同步。基础技能以只读方式留在各客户端独立插件目录中，无需 Agent 修改；自学习、可演进的站点技能与配方统一保存在 `~/.browserpaw`，互不冲突。

| 客户端               | 插件目录                                                         | 集成能力                                                                                 | 安装方式                                                                                                                                                             |
| :------------------- | :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeepSeek Harness** | [plugins/browserpaw-dsh](plugins/browserpaw-dsh/README.md)       | 一键安装 `browserpaw` npm 包 + 只读基础技能 + 读取 `~/.browserpaw` 自学习工作流表        | `dsh plugin --profile web add dsh-browserpaw` 后运行 `dsh plugin --profile web exec browserpaw setup --no-skill`                                                     |
| **Hermes Agent**     | [plugins/browserpaw-hermes](plugins/browserpaw-hermes/README.md) | 只读 `browserpaw:browserpaw` 技能 + 统一 `browserpaw` CLI 工具 + `MEDIA:` 截图路径输出   | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes`                             |
| **Claude Code**      | [plugins/browserpaw-claude](plugins/browserpaw-claude/README.md) | 只读基础技能 + `SessionStart` 钩子（检测 CLI 并注入 `~/.browserpaw` 自学习工作流上下文） | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `claude plugin marketplace add GoldenLoaf24h/browserpaw && claude plugin install browserpaw@browserpaw` |
| **ChatGPT / Codex**  | [plugins/browserpaw](plugins/browserpaw/README.md)               | Portable Agent Plugins v1.0.0 只读基础技能与图标包（无钩子）                             | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `codex plugin marketplace add GoldenLoaf24h/browserpaw && codex plugin add browserpaw@browserpaw`       |

各宿主插件规范的能力边界与官方依据详见 [插件兼容性与规范边界](docs/development/PLUGIN_COMPATIBILITY.md)。

## 使用

通过 `browserpaw help data` 查看历史、书签、下载记录、存储和 Cookie 命令。通过 `browserpaw help debug` 查看网络抓包、控制台、性能、设备模拟、PDF 和 CDP 命令。

```text
browserpaw status
browserpaw help
browserpaw search "网络"
browserpaw task start research --json
browserpaw open https://example.com --task TASK_ID
browserpaw observe --task TASK_ID
browserpaw text --task TASK_ID
browserpaw screenshot --task TASK_ID --out page.png
browserpaw task finish --task TASK_ID
```

先运行 `browserpaw status` 确认连接，随后运行 `browserpaw help` 查看命令。多步工作用 `task start` 获取任务 ID，并在后续命令传入 `--task ID`。在现有页面工作时可通过 `tabs` 取得标签页 ID，然后传入 `--tab ID`。观察页面后再用 ref 操作，核实业务结果后运行 `task finish`。

自学习的站点技能与保存的 CLI 工作流统一保存在 `~/.browserpaw`（`skills/`、`recipes/` 与 `learned-index.json`）。可通过 `browserpaw recipe find <关键词>` 检索、`browserpaw recipe show ID` 查看参数、`browserpaw recipe save FILE` 创建候选、`browserpaw recipe patch ID --step INDEX -- ARGS...` 修补单个步骤，并用 `browserpaw recipe validate ID key=value` 校验只读候选后激活。`browserpaw recipe run ID key=value` 可直接执行工作流。候选不会进入自动路由，只有成功激活后才会刷新已安装 `SKILL.md` 的路由表。

## 故障排查与维护

- **核对桥接与构建版本**：运行 `browserpaw status`（或 `browserpaw status --json`）与 `browserpaw doctor`，并将 `data.extension.buildId` 与 Chrome 已加载扩展目录中的 `browserpaw-build.json` 对比。
- **修复宿主注册**：运行 `browserpaw doctor --fix` 重新注册 `com.browserpaw.nativehost`。若从 v4 升级，请确认 Chrome 没有继续连接到已退役的 v4 `com.chromemcp.nativehost`（端口 `12306`）或旧版扩展目录。
- **干净卸载**：`browserpaw uninstall` 会移除宿主注册与受管扩展目录，默认保留 `~/.browserpaw` 中的自学习工作流；传入 `--purge` 可一并清理 `~/.browserpaw` 内的数据。

## 安全、隐私与更多文档

- [安全策略（SECURITY.md）](SECURITY.md) — 支持版本、回环鉴权、SSRF 与敏感路径防护及漏洞上报方式
- [隐私政策（PRIVACY.md）](PRIVACY.md) — 本地优先边界、更新检查说明与 Chrome 权限说明
- [安装指南](INSTALL.md) · [v5 迁移指南](docs/MIGRATION.zh-CN.md) · [命令参考](docs/COMMANDS.md) · [架构文档](docs/ARCHITECTURE.md) · [故障排查](docs/TROUBLESHOOTING.zh-CN.md) · [插件兼容性](docs/development/PLUGIN_COMPATIBILITY.md) · [发布记录](docs/releases/README.md)
