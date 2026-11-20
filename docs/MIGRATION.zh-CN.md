# BrowserPaw v5.0.0 迁移指南（面向用户与 AI Agent）

[English](MIGRATION.md)

BrowserPaw v5.0.0 已彻底退役 v4.x 的 MCP 服务器、持久化 REPL、Jev 服务以及旧版 MCP 包装器，全面转向 **CLI 优先 + 标准 Agent Skill + 统一 v5 客户端插件（DeepSeek Harness / Hermes Agent / Claude Code / ChatGPT·Codex）+ 无 Jev 的 Chrome MV3 扩展 + `~/.browserpaw` 自学习工作流**架构（使用独立 Native Host `com.browserpaw.nativehost` 与默认本地端口 `12307`）。

本文档同时面向**人类用户**与 **AI Agent**。你可以自己按步骤执行，也可以直接将以下指令发给你的 Agent 由它代为完成迁移：

```text
请阅读 docs/MIGRATION.zh-CN.md（或 docs/MIGRATION.md），帮我将本地 BrowserPaw 从 v4 迁移配置到 v5.0.0。
```

## 1. v4.x 到 v5.0.0 的核心变化

| 维度                   | BrowserPaw v4.x（旧版）                                                               | BrowserPaw v5.0.0（当前版本）                                                                                                                      |
| :--------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **核心入口**           | MCP HTTP（`http://127.0.0.1:12306/mcp`）、SSE、stdio 桥接或 `browserpaw session` REPL | Agent 或用户直接执行 `browserpaw` CLI 命令                                                                                                         |
| **Agent 接入方式**     | 客户端注册 MCP 工具 Schema（`chrome_*` / `mcp__browserpaw__*`）及 MCP 包装器插件      | 首推全局 Agent Skill（`~/.agents/skills/browserpaw`）+ npm CLI；同步支持 DSH、Hermes、Claude Code、ChatGPT/Codex 四端 v5 插件                      |
| **Native Host 与端口** | `com.chromemcp.nativehost`，端口 `12306`                                              | `com.browserpaw.nativehost`，默认本地回环端口 `12307`（安装于 `~/.browserpaw/host`）                                                               |
| **Chrome 扩展界面**    | 旧版 MCP 开关与 Jev 模型配置弹窗                                                      | v5 紧凑弹窗，显示连接状态、Agent Control 开关、光标及开页模式，右下角版本号带更新红点。安装于 `~/.browserpaw/extension`                            |
| **跨命令状态保持**     | MCP 会话状态或 `browserpaw session create/call/close`                                 | 通过 `browserpaw task start` 获取任务 ID，并在后续 CLI 命令传入 `--task TASK_ID`                                                                   |
| **自学习工作流**       | `chrome_skill` MCP 工具与旧站点笔记                                                   | 统一存储在 `~/.browserpaw`（`skills/`、`recipes/`、`learned-index.json`），通过 `browserpaw recipe ...` 管理并自动同步到已安装 `SKILL.md` 的路由表 |

## 2. 分步迁移清单（Agent 与用户均可直接执行）

### 第一步：清理旧版 v4 MCP 与客户端包装器配置

1. **移除各 Agent 客户端中的旧 MCP 配置项**（名称通常为 `browserpaw`、`chrome-mcp` 或 `mcp-chrome`，指向 `127.0.0.1:12306`、stdio 桥接脚本或旧版 `npx` MCP 启动器）：
   - **Codex：** 编辑 `~/.codex/config.toml`，删除 `[mcp_servers.browserpaw]` 或 `[mcp_servers.chrome-mcp]` 配置段。
   - **Claude Code / Claude Desktop：** 编辑 `~/.claude.json` 或 `claude_desktop_config.json`，删除 `mcpServers` 下的 `browserpaw` / `chrome-mcp`。
   - **Cursor / Windsurf / 其他 MCP 客户端：** 在客户端 `mcp.json` 或设置中删除 `browserpaw` / `chrome-mcp` 服务条目。
   - **Hermes Agent：** 删除 `~/.hermes/config.yaml` 中的 `mcp_servers.browserpaw` 以及 `plugins.entries.browserpaw.mcp_allowlist`，升级为 v5 CLI 插件（`plugins/browserpaw-hermes`）或改用全局 Skill。
   - **DeepSeek Harness（`dsh`）：** 将旧版 v4 `dsh-browserpaw`（MCP `browserpaw_session`）升级至 v5.0.0（直接捆绑 `browserpaw` npm CLI 与规范技能，不再依赖 `@deepseek-ai/dsh-mcp-client`），或改用全局 Skill。
2. **清理旧版自定义提示词或旧技能副本**：移除要求 Agent 调用 `mcp__browserpaw__*`、`chrome_read_dom`、`chrome_interact_index`、`chrome_tool_docs` 或 `browserpaw session ...` 的旧提示词与旧版技能文件。
3. **结束残留的 v4 进程**：若本地仍有监听 `12306` 端口的旧版进程，将其终止。
4. **卸载旧版全局 npm 包**（`npm uninstall -g mcp-chrome-bridge`），避免 `PATH` 上残留的旧版 `browserpaw` 包装命令遮挡 v5 CLI（完成第二步后执行 `browserpaw --version` 应输出 `5.0.0`）。

### 第二步：安装 BrowserPaw v5.0.0 CLI、Native Host 与 Agent Skill

需要 Node.js 22.6 或更高版本。首推全局安装 npm CLI + 全局 Skill：

```sh
# 方式 A（推荐 Quick Start）：全局安装 npm CLI + 全局 Agent Skill + 解压扩展
npm install -g browserpaw@5.0.0
browserpaw setup

# 方式 B：通过 npx 直接完成安装与注册（免全局安装）
npx browserpaw@5.0.0 setup

# 方式 C：使用本地打包的候选 .tgz 安装
npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup
```

**`setup` 的技能安装作用域选项：**

- **默认用户级全局安装（`--skill-scope user`）：** 安装到 `~/.agents/skills/browserpaw`，所有工作区与支持标准 Agent Skills 规范的 Agent 均可自动发现。
- **项目级安装（`--skill-scope project`）：** 安装到当前项目目录的 `./.agents/skills/browserpaw`。
- **自定义目录（`--skill-dir DIR`）：** 安装到 `DIR/browserpaw`。
- **跳过技能复制（`--no-skill`）：** 仅在 `~/.browserpaw` 下安装 Native Host 与扩展目录。
- **浏览器注册：** `--browser chromium` 仅注册 Chromium，`--browser all` 会同时注册 Chrome 与 Chromium。

#### 可选：安装或升级至 v5 客户端插件

如果你更希望使用各客户端原生插件管理器（只读基础技能放在插件目录，自学习工作流保留在 `~/.browserpaw`，互不冲突），运行 `browserpaw setup --no-skill` 后按客户端安装对应 v5 插件：

- **DeepSeek Harness（一键捆绑 npm CLI + 基础技能）：** `dsh plugin --profile web add dsh-browserpaw`，随后执行 `browserpaw setup --no-skill`
- **Hermes Agent（基础技能 + 统一 `browserpaw` CLI 工具 + 网关 `MEDIA:` 截图回传）：** `hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes && hermes plugins enable browserpaw`
- **Claude Code（基础技能 + `SessionStart` 钩子自动检测 CLI 并注入 `~/.browserpaw` 路由）：** `claude plugin marketplace add GoldenLoaf24h/browserpaw && claude plugin install browserpaw@browserpaw`
- **ChatGPT / Codex（Portable Agent Plugins v1 基础技能包）：** `codex plugin marketplace add GoldenLoaf24h/browserpaw && codex plugin add browserpaw@browserpaw`

完整多路径选择与规范边界见 [安装指南（INSTALL.md）](../INSTALL.md) 与 [插件兼容性说明](development/PLUGIN_COMPATIBILITY.md)。

### 第三步：在浏览器中加载或重载 v5 扩展（需用户在浏览器操作）

首次运行 `browserpaw setup` 会将 v5 扩展准备在 `~/.browserpaw/extension`（Windows 下为 `%USERPROFILE%\.browserpaw\extension`）。从 v4 迁移时，按以下步骤手动加载：

1. 在 Chrome 中打开 `chrome://extensions`（Chromium 打开 `chromium://extensions`）。
2. 开启右上角的**开发者模式（Developer mode）**。
3. 移除或停用此前从旧仓库目录或旧版本目录加载的 v4 扩展。
4. 点击**加载已解压的扩展程序（Load unpacked）**，选择 `browserpaw setup` 输出的 `~/.browserpaw/extension` 目录（若扩展卡片已指向该目录，点击卡片上的**重新加载 / Reload** 即可）。

后续 v5 升级时，用新版 CLI 运行 `browserpaw setup` 同步更新 Native Host 和已登记的基础 Skill。浏览器扩展需从对应的 GitHub Release 下载 ZIP、解压并手动加载。完整流程见 [v5 升级指南](../INSTALL.md#upgrade-an-existing-v5-installation)。

浏览器数据命令会使用扩展的 `history`、`bookmarks` 和 `cookies` 权限。安装或重载时如果 Chrome 提示，请核对这些权限。加载后执行 `browserpaw status --json`，核对返回的 build ID 与已选目录里的 `browserpaw-build.json`。

通过 `browserpaw help data` 查看历史、书签、下载记录、存储和 Cookie 命令。通过 `browserpaw help debug` 查看网络、控制台、性能、模拟、PDF 和 CDP 命令。

### 第四步：验证连接与自学习工作流路由

执行以下命令确认迁移完成：

```sh
browserpaw status
browserpaw doctor
```

- `browserpaw status` 应返回 `"connected": true` 且扩展版本为 `5.0.0`。
- 若宿主注册缺失或异常，运行 `browserpaw doctor --fix` 自动修复。
- 查看并检索 `~/.browserpaw` 下的自学习站点技能与工作流配方：

```sh
browserpaw recipe list --all
browserpaw recipe find 搜索
```

- 对于状态为 `candidate` 的内置或新提议站点技能，可在 Chrome 已连接时执行一次 `browserpaw recipe validate ID` 完成实时验证与激活。保存或验证通过后，CLI 会自动刷新已安装 `SKILL.md` 末尾的 `Learned Workflows` 路由表，后续 Agent 会话无需提醒即可自动匹配并调用。

## 3. 命令迁移对照表（v4 MCP / REPL → v5 CLI）

更新旧脚本、Agent 技能或操作习惯时，按以下对照表替换为 v5 CLI 命令：

| v4.x MCP 工具或 REPL 命令                           | v5.0.0 CLI 对应命令                                                                    | 迁移说明                                                                        |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| `chrome_task` / `browserpaw session create`         | `browserpaw task start NAME --json`                                                    | 返回 `taskId`；后续多步命令统一传入 `--task TASK_ID`                            |
| `browserpaw session close`                          | `browserpaw task finish --task TASK_ID`                                                | 结束任务并清理该任务独占的临时状态                                              |
| `chrome_navigate`                                   | `browserpaw open URL [--task TASK_ID]` / `browserpaw nav back\|forward\|reload`        | 打开网址时若命中已学习站点，返回结果会附带 `matchedRecipes` 提示                |
| `get_windows_and_tabs`                              | `browserpaw tabs`                                                                      | 列出当前浏览器标签页及对应 ID                                                   |
| `chrome_switch_tab` / `chrome_close_tabs`           | `browserpaw tab focus TAB_ID` / `browserpaw tab close TAB_ID...`                       | 如需在任务中接管现有标签页，使用 `browserpaw task borrow TAB_ID --task TASK_ID` |
| `chrome_read_dom` / `chrome_get_web_content`        | `browserpaw observe [--task TASK_ID]` / `browserpaw text` / `browserpaw find QUERY`    | `observe` 返回当前页面可交互元素引用（`r1`、`r2` 等）及 frame 覆盖情况          |
| `chrome_interact_index` / `chrome_click_element`    | `browserpaw click TARGET` / `browserpaw hover TARGET` / `browserpaw press KEY`         | `TARGET` 支持最新观察到的 ref、CSS 选择器、文本、role 或 label 定位             |
| `chrome_computer`（坐标 / 拖拽 / 滚动）             | `browserpaw click @X,Y --capture ID` / `browserpaw drag SRC DST` / `browserpaw scroll` | 坐标点击必须携带同一标签页最新 `screenshot` 返回的 `--capture ID`               |
| `chrome_fill_index` / `chrome_fill_or_select`       | `browserpaw fill TARGET -- VALUE` / `browserpaw select TARGET VALUE`                   | 多行文本或大段内容可使用 `--input FILE`                                         |
| `chrome_upload_file`                                | `browserpaw upload TARGET FILE...`                                                     | 向文件输入框上传一个或多个本地文件                                              |
| `chrome_screenshot`                                 | `browserpaw screenshot --out FILE.png [--task TASK_ID]`                                | 将截图保存为本地文件并返回供 `@X,Y` 使用的 capture ID                           |
| `chrome_network_capture` / `chrome_console`         | `browserpaw network ...` / `browserpaw console`                                        | 按范围捕获网络事件与读取控制台输出                                              |
| `chrome_javascript` / `chrome_fetch` / `chrome_cdp` | `browserpaw eval` / `browserpaw fetch` / `browserpaw cdp`                              | 页面上下文脚本执行、请求发送与受支持的 CDP 调用                                 |
| `chrome_handle_dialog` / `chrome_ask_human`         | `browserpaw dialog` / `browserpaw ask-human`                                           | 处理浏览器弹窗，或遇到登录/验证码时请求人工介入                                 |
| `chrome_download`                                   | `browserpaw download REF` / `browserpaw download --url URL --out DIR`                  | 获取经校验的本地下载文件回执与来源信息                                          |
| `chrome_skill`                                      | `browserpaw recipe list\|find\|show\|run\|save\|validate\|rm`                          | 在 `~/.browserpaw` 下管理自学习站点技能与 CLI 配方并自动同步路由                |
| `chrome_tool_docs`                                  | `browserpaw help` / `browserpaw help COMMAND`                                          | 内置离线命令帮助，无需联网或启动浏览器即可查询语法                              |

用 `browserpaw window list` 查看窗口 ID，用 `browserpaw select TARGET` 列出可选项。此前 v5 候选版的 `tabs --windows` 和 `select TARGET --list` 仍可供现有脚本使用。执行 `network show ID` 时，ID 取自 `network list` 返回的 `requests[].id`。

更多细节请参考 [命令参考](COMMANDS.md)、[Agent 技能说明](../skills/browserpaw/SKILL.md) 与 [故障排查](TROUBLESHOOTING.zh-CN.md)。
