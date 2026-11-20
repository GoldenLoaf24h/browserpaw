# BrowserPaw

[English](README.md)

BrowserPaw 让任意具备命令执行能力的 AI Agent 通过命令行操控你正在使用的 Chrome 或 Chromium（直接复用登录态、Cookie 与扩展）。Agent 阅读标准技能并执行 `browserpaw` CLI 命令，浏览器扩展通过 Native Messaging 连接本机宿主，截图与大体积结果统一以本地文件回执交付。

> **从 v4.x 升级？** BrowserPaw v5.0.0 已由 MCP 服务、REPL 与 Jev 切换为统一的 `browserpaw` CLI、标准 Agent Skill 与 v5 客户端插件。请阅读 [v5.0.0 迁移指南](docs/MIGRATION.zh-CN.md)（[English](docs/MIGRATION.md)）完成迁移，或直接让你的 Agent 阅读 `docs/MIGRATION.zh-CN.md` 代为执行迁移配置。

## 快速开始（首推：全局 Skill + npm + Chrome 扩展）

需要 **Node.js 22.6+** 与桌面版 Chrome 或 Chromium。先全局安装 CLI 并运行 `setup`（自动注册 Native Messaging 宿主并将基础技能全局安装到 `~/.agents/skills/browserpaw`），再在 Chrome 加载扩展：

```sh
npm install -g browserpaw@5.0.0
browserpaw setup
```

随后在浏览器打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `setup` 输出的扩展目录（默认 `~/.browserpaw/extension`）。

- **其他安装方式：** 也可不全局安装直接运行 `npx browserpaw@5.0.0 setup`（后续命令加前缀 `npx --yes browserpaw@5.0.0`），或用本地候选包 `npx --yes --package ./browserpaw-5.0.0.tgz browserpaw setup`。
- **作用域与浏览器参数：** `--skill-scope user`（默认 `~/.agents/skills/browserpaw`）、`--skill-scope project`（`./.agents/skills/browserpaw`）、`--skill-dir DIR`、`--no-skill` 以及 `--browser chromium`。
- 完整多路径安装说明与 Agent 协助安装指引见 [安装指南（INSTALL.md）](INSTALL.md)。
- 每个新版 CLI 仅提醒一次。用新版 CLI 同步更新基础 Skill 和 Native Host，Chrome 扩展由用户手动更新。[升级指南](INSTALL.md#upgrade-an-existing-v5-installation)

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

先运行 `browserpaw status` 确认连接，随后运行 `browserpaw help` 查看命令。多步工作用 `task start` 获取任务 ID，并在后续命令传入 `--task ID`。在现有页面工作时可通过 `tabs` 取得标签页 ID，然后传入 `--tab ID`。观察页面后再用 ref 操作，核实业务结果后运行 `task finish`。

自学习的站点技能与保存的 CLI 工作流统一保存在 `~/.browserpaw`（`skills/`、`recipes/` 与 `learned-index.json`）。可通过 `browserpaw recipe find <关键词>` 检索、`browserpaw recipe show ID` 查看参数、`browserpaw recipe validate ID` 校验激活候选技能、`browserpaw recipe run ID key=value` 直接调用，并用 `browserpaw recipe save FILE` 持久化新学到的站点流程。保存、校验或安装技能时会自动刷新已安装 `SKILL.md` 的自动路由表，让 Agent 无需提醒即可直接路由调用。

使用 `browserpaw doctor` 排查安装，`browserpaw doctor --fix` 修复注册。使用 `browserpaw uninstall` 卸载宿主和扩展文件，任务与配方数据默认保留。

参见 [安装指南](INSTALL.md)、[命令参考](docs/COMMANDS.md)、[故障排查](docs/TROUBLESHOOTING.zh-CN.md)、[插件兼容性](docs/development/PLUGIN_COMPATIBILITY.md) 和 [发布记录](docs/releases/README.md)。
