# AI Agent 配置与高效交互指南

[English](./AGENT_CONFIG_GUIDE.md)

本指南专为 **AI Agent（Claude Code、Cursor、Windsurf、Hermes、Roo Code、Goose、Codex、Antigravity）** 及 Agent 开发者编写。它详细说明如何以最高性能、最低 Token 开销和物理事件保真度配置、连接并驱动本地 Google Chrome 浏览器。

---

## 1. 系统架构与工作机制

`BrowserPaw` 是一个基于**模型上下文协议（MCP）**运行的工业级浏览器控制平台：

- **Chrome MV3 扩展**：直接运行在你日常使用的 Google Chrome 内。它通过 Chrome DevTools Protocol（CDP）注入原生硬件级事件（`isTrusted: true`），并维护一棵隔离的、纯内存的 WeakRef DOM 索引树。
- **原生桥接服务器**：本地运行于 `127.0.0.1:12306`（或自定义端口），通过 Streamable HTTP、Server-Sent Events（SSE）和标准输入输出（stdio）提供标准 MCP JSON-RPC 端点。
- **原生消息传递宿主**：通过标准 I/O 流在 Chrome 与 Node.js 之间建立双向通信，内置 1000KB 缓冲区截断防御和会话隔离。

---

## 2. 一次性安装与部署

在把 Agent 客户端连接到 MCP 服务器之前，先完成以下初始设置：

### 第 1 步：注册 Chrome 原生消息传递宿主

执行一次注册脚本，把原生消息传递清单绑定到你的浏览器：

- **通过仓库 CLI（跨平台）**：
  ```bash
  node app/native-server/dist/scripts/register-dev.js
  # 或在原生服务器目录内执行：
  cd app/native-server && node dist/scripts/register-dev.js
  ```
- **若通过 npm / npx 全局安装**：
  ```bash
  node app/native-server/dist/cli.js register
  ```

_注册脚本会创建指向宿主运行器的清单，并在操作系统注册表（Windows 上为 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost`）或 macOS/Linux 的 Chrome Application Support / NativeMessagingHosts 目录中注册它。_

### 第 2 步：在 Google Chrome 中加载扩展

1. 打开 Google Chrome，访问 `chrome://extensions`。
2. 启用右上角的**开发者模式**开关。
3. 点击左上角的**加载已解压的扩展程序**。
4. 选择扩展构建输出目录：
   ```
   <repo-root>/app/chrome-extension/.output/chrome-mv3
   ```
5. BrowserPaw 图标将出现在 Chrome 的扩展工具栏中。

### 第 3 步：验证就绪状态

- **绿色状态**：表示扩展已成功连接到原生消息传递宿主，本地桥接正常工作。
- **自动自愈**：若启动时指示灯短暂显示黄色，内置看门狗会通过 HTTP 探测，并在 2 秒内恢复。

---

## 3. 客户端 MCP 配置模板

把与你的 Agent 平台匹配的配置片段复制到 MCP 配置文件中。

### 3.1 认证 Token 与环境变量

BrowserPaw 强制执行本地 Token 认证，防止未授权的回环访问：

- **默认 Stdio 传输**：Stdio 传输（`node <ABSOLUTE_PATH>/mcp-server-stdio.js`）是所有客户端推荐的零配置默认方式，无需 Token 或环境凭据。
- **Token 文件位置**：`~/.chrome-mcp/bridge-token`（Windows 上为 `C:\Users\<username>\.chrome-mcp\bridge-token`）。原生服务器是唯一的生产者（以独占 `wx` 锁保留有效的 48/64 位十六进制 Token；客户端和 doctor 脚本从不写 Token；`CHROME_MCP_TOKEN` 或 `BROWSERPAW_MCP_TOKEN` 等环境变量覆盖会被忽略）。
- **环境变量**：
  - `CHROME_MCP_PORT` / `MCP_HTTP_PORT`：原生桥接的端口覆盖（优先级：`CHROME_MCP_PORT` > `MCP_HTTP_PORT` > `12306`，校验为 1–65535 的整数范围）。
  - `CHROME_MCP_TOOL_PROFILE`：工具暴露配置档。取值：`core`（14 个工具，默认，约 9.2k 提示字符/4）、`crawl`（12 个工具，约 6.1k）或 `full`（全部 50 个工具，约 20.3k）。数量为 Core 14 / Crawl 12 / Full 50（49 个扩展执行工具 + 1 个原生服务器工具）；体积是基于字符的估算，而非实测 BPE Token。
  - `BROWSERPAW_TOOL_PREFIX`：工具名称的命名空间前缀（`browserpaw_` 或 `chrome_`）。
  - `BROWSERPAW_EXTENSION_SYNC_DIR`：`sync-extension-dist.mjs` 的可选目标目录（严格防护仓库根、祖先目录、驱动器根和用户主目录）。

> **注意**：通过可选的高级 HTTP/SSE 传输连接时，客户端必须提供与 `~/.chrome-mcp/bridge-token` 匹配的 `Authorization: Bearer <token>`。回环、Host 和 Origin 安全守卫仍然强制执行。

---

### 3.2 Claude Desktop / Claude Code

配置文件：`~/.claude/claude_desktop_config.json` 或项目级 `mcpServers`：

#### 方式 A：Streamable HTTP / SSE 模式（推荐用于并发）

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/sse",
      "headers": {
        "Authorization": "Bearer <TOKEN_FROM_BRIDGE_TOKEN_FILE>"
      }
    }
  }
}
```

#### 方式 B：Stdio 传输模式（由 Agent 管理生命周期）

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

#### 方式 C：Claude Code 插件（`/browserpaw`）

Claude Code 从本仓库自带的插件市场安装 BrowserPaw，一步即可打包操作技能与 stdio MCP 服务器：

```text
/plugin marketplace add GoldenLoaf24h/browserpaw
/plugin install browserpaw@browserpaw
```

然后输入 `/browserpaw` 加载技能；工具以 `mcp__plugin_browserpaw_browserpaw__chrome_*` 形式出现。随附的服务器从 `PATH` 运行 `mcp-chrome-stdio`，因此仍需要原生宿主和已加载扩展的运行中 Chrome。

---

### 3.3 Cursor 配置

在 `.cursor/mcp.json` 中，或通过 Settings -> Features -> MCP Servers -> Add New MCP Server：

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

---

### 3.4 Windsurf / Cascade 配置

配置文件：`~/.codeium/windsurf/mcp_config.json`：

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

---

## 4. Agent 交互规则与最佳实践

为最小化提示 Token 消耗、最大化响应速度并防止点击失败，Agent **必须遵守以下 6 条核心交互规则**：

### 规则 1：DOM 优先 + 1 起始数字索引

- **主路径（90% 的交互）**：
  1. 调用 `chrome_read_dom`。输出是一棵剪枝后的可访问性树，剔除不可见节点和装饰性包装，每个可交互元素都有一个干净的 1 起始数字索引（例如 `[1]`、`[2]`、`[5]`）。
  2. 直接使用数字索引派发动作：
     - 点击：`chrome_interact_index({ index: 5 })`
     - 输入：`chrome_fill_index({ index: 2, text: "my-query" })`
- **应避免的反模式**：
  - 绝不猜测冗长脆弱的 CSS 选择器（例如 `div.app-container > section:nth-child(3)...`）或脆弱的绝对 XPath。
  - 绝不假设宿主 DOM 节点带有 `data-mcp-idx` 属性。

### 规则 2：单轮动作流水线（零往返提交）

- **用于查询、表单提交、登录和顺序流程**：
  - **避免三回合乒乓**：不要把简单工作流拆成第 1 回合 `read_dom` -> 第 2 回合 `fill_index` -> 第 3 回合 `interact_index`。这会引入 2 次冗余模型往返和 10 秒以上的不必要延迟。
  - **单回合快路径模式**：
    1. **搜索框 / 单字段查询**：调用 `chrome_fill_index({ index: 15, text: "query", pressEnter: true })`，在一次往返内完成输入、回车和变更稳定。
    2. **带提交按钮的输入框**：从 `chrome_read_dom` 识别两个元素，然后在一次往返内派发 `chrome_batch_actions`：
       ```json
       {
         "actions": [
           { "type": "fill", "index": 15, "text": "my-query", "clear": true },
           { "type": "click", "index": 18 }
         ],
         "waitForSettle": true
       }
       ```
    3. **多字段表单**：在 `chrome_batch_actions` 中串联填写与提交，或使用 `chrome_form_pipeline`：
       ```json
       {
         "actions": [
           { "type": "fill", "index": 1, "text": "username@example.com", "clear": true },
           { "type": "fill", "index": 2, "text": "SuperSecretPassword123!", "clear": true },
           { "type": "click", "index": 3 },
           { "type": "wait", "durationMs": 500 }
         ],
         "waitForSettle": true
       }
       ```

### 规则 3：视觉兜底与坐标网格标尺

- **何时启用视觉兜底（10% 的交互）**：
  1. 纯 HTML5 Canvas、WebGL、动态图表，或经机器人混淆的 DOM 树。
  2. 缺少 ARIA 标签或可读文本节点的纯图标按钮。
- **视觉定位最佳实践**：
  1. 调用 `chrome_screenshot({ grid: true })`：
     - 在视口上渲染半透明高对比度坐标网格标尺（带 X/Y 轴标签）。
     - Agent 直接从标尺读取物理 CSS 像素坐标，消除模型坐标漂移幻觉。
  2. 用实测坐标调用 `chrome_interact_index`：
     ```json
     {
       "coordinate": { "x": 640, "y": 380 }
     }
     ```

### 规则 4：自主增量搭车（节省 50% 往返）

- 调用 `chrome_interact_index`、`chrome_fill_index` 或 `chrome_batch_actions` 时，始终指定 `includeDelta: true`。
- 扩展会在动作的稳定窗口内捕获 DOM 变化，并在动作响应中直接返回 `delta: { added, modified, removed }`。你无需为了确认下拉框已展开或横幅已出现而再次调用 `chrome_read_dom`。

### 规则 5：定向轻量 Grep（`chrome_grep`）

- 对于节点数超过 500 的大型或无限滚动页面，避免倾倒整棵 DOM 树。调用 `chrome_grep({ query: "Login" })` 即可在亚毫秒内定位元素索引，同时削减 90%+ 的 Token 消耗。
- 支持多 frame iframe 穿透（分层重映射子 frame 索引），并可搜索元素文本、角色、`placeholder`、`aria-label` 和 `value`。

### 规则 6：自适应动作稳定与过期索引自愈

- **自适应稳定（`waitForSettle: true`）**：
  - 内部看门狗监控 DOM MutationObserver 和在途网络请求。对空闲页面，动作在 50ms 内返回；对正在进行网络请求的页面，看门狗会平滑等待其完成。
- **过期索引自愈**：
  - 当 SPA 导航或异步重渲染使索引失效时，工具会返回清晰的诊断指令：
    `ACTION REQUIRED: Please call 'chrome_read_dom' to refresh the index tree before re-attempting interaction`
  - 绝不要盲目重试同一个过期索引。重新调用 `chrome_read_dom` 刷新索引，然后继续。

---

## 5. 规范工具速查表

| 工具名称                            | 关键参数                                     | 功能与描述                                               | 推荐场景                       |
| :---------------------------------- | :------------------------------------------- | :------------------------------------------------------- | :----------------------------- |
| `chrome_read_dom`                   | `viewportOnly: true`                         | 剪枝后的 1 起始编号可访问性树；复杂页面上剪枝 ≥85%       | **任何新页面的第一步**         |
| `chrome_interact_index`             | `index` 或 `coordinate: {x,y}`               | 硬件级点击、悬停、双击或拖拽                             | 按钮点击、链接导航             |
| `chrome_fill_index`                 | `index`、`text`、`clear: true`、`pressEnter` | 原生物理输入、值清空和回车提交                           | 单字段查询与提交               |
| `chrome_keyboard`                   | `keys`（例如 `["Enter"]`、`["Ctrl+,"]`）     | 按键、独立修饰键（Control、Shift）、符号组合键（Ctrl+,） | 快捷键、表单导航、组合键       |
| `chrome_batch_actions`              | `actions: [...]`、`waitForSettle: true`      | 顺序执行多步点击、填写、等待和断言                       | **多字段表单与复杂流程**       |
| `chrome_screenshot`                 | `grid: true`、`targetIndex`、`format`        | 内存中 base64 截图，可选坐标网格标尺                     | Canvas、复杂验证码、非 DOM UI  |
| `chrome_upload_file`                | `index` 或 `clickTargetIndex`、`filePath`    | 通过操作系统路径注入向文件输入框上传本地文件             | 文件上传、头像                 |
| `chrome_get_markdown`               | `includeLinks: true`                         | 干净、排版美观的 Markdown 提取                           | 文章阅读、页面摘要             |
| `chrome_grep`                       | `query`、`searchType`                        | 跨 frame 和属性的亚毫秒正则/文本扫描                     | 在大型文档中查找元素           |
| `chrome_inspect_media`              | `index` 或 `selector`                        | 提取原始高分辨率图像 Data URL 或裁剪图                   | 验证码、图表、原始商品图       |
| `chrome_request_human_intervention` | `reason`、`timeoutMs`                        | 挂载毛玻璃接管横幅，把控制权让给用户                     | 两步验证、滑块验证码、敏感支付 |
| `chrome_undo_last_action`           | 无                                           | 回滚最近一次导航或表单填写步骤                           | 快速错误恢复                   |
| `chrome_close_tabs`                 | `tabIds`、`url`、`confirm`                   | 关闭标签页；关闭活动前台标签页需 `confirm: true`         | 标签页清理、关闭任务页面       |
| `chrome_javascript`                 | `code`、`tabId`                              | 求值 JavaScript，支持顶层 await 和自动返回表达式         | 临时计算、DOM 检查             |
| `chrome_tool_docs`                  | `category`、`activateForSession`             | 工具类别的动态发现与会话内按需激活                       | 配置档模式下的工具扩展         |

---

## 6. 诊断清单

1. **连接被拒（`ECONNREFUSED 127.0.0.1:12306`）**：
   - 确保 Google Chrome 正在运行且 BrowserPaw 扩展已启用。
   - 在终端运行 `curl http://127.0.0.1:12306/ping`。返回 `{"status":"ok","message":"pong"}` 即确认服务正在监听。
2. **401 Unauthorized**：
   - 验证客户端配置包含与 `~/.chrome-mcp/bridge-token` 匹配的 `Authorization: Bearer <token>`。
3. **扩展显示黄色警告**：
   - 检查 `run_host.bat`（Windows）或 `run_host.sh` 是否已注册清单。在弹窗中点击 “Reconnect”。
4. **大文件上传**：
   - 始终提供本地绝对文件路径（例如 `D:/docs/sample.pdf`）。不要将文件转换为数兆字节的 base64 字符串穿越原生消息传递管道。
