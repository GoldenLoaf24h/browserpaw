# AI Agent 浏览器插件配置与高效交互指南

[English Version](./AGENT_CONFIG_GUIDE.md)

本文档专为 **AI Agent（包括 Claude Code、Cursor、Windsurf、Hermes、Roo Code、Goose、Codex、Antigravity 等）** 及其开发者编写，旨在指导 Agent 如何正确配置、接入并以最高能效操控本地 Chrome 浏览器。

---

## 1. 架构速览与工作机制

`BrowserPaw` 是一套基于 **模型上下文协议 (Model Context Protocol, MCP)** 的现代化工业级本地浏览器控制系统：

- **浏览器扩展 (Chrome Extension)**：运行在本地 Chrome 中，通过 Chrome DevTools Protocol (CDP) 注入原生物理级事件（`isTrusted: true`），维护纯内存弱引用 DOM 索引树。
- **本地网桥服务 (Native Server)**：运行在本地 `127.0.0.1:12306`（或自定义端口），提供标准的 MCP JSON-RPC 接口（支持 Streamable HTTP、SSE 与 stdio 传输）。
- **进程通信宿主 (Native Messaging Host)**：通过标准输入输出（stdio）与 Chrome 建立安全双向管道，具备 1000KB 截断保护与会话隔离机制。

---

## 2. 环境部署与一次性配置 (One-Time Setup)

在 Agent 连接 MCP 服务前，需要完成以下三步基础环境部署：

### 步骤 1：注册 Chrome Native Messaging Host

执行注册脚本将 Native Messaging 宿主配置绑定至你的本地浏览器（仅需执行一次）：

- **通过仓库 CLI 执行（跨平台通用）**：
  ```bash
  node bin/browserpaw.cjs register
  # 或直接在服务端目录执行：
  cd app/native-server && node dist/scripts/register-dev.js
  ```
- **若通过 npm 全局安装或使用 npx**：
  ```bash
  npx browserpaw register
  ```

_脚本会自动向操作系统注册表（Windows 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost`）或 macOS/Linux 系统对应目录写入宿主清单配置。_

### 步骤 2：在 Chrome 中加载扩展

1. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions` 并回车。
2. 打开页面右上角的 **“开发者模式” (Developer mode)** 开关。
3. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**。
4. 选择扩展的构建输出目录：
   ```
   <repo-root>\app\chrome-extension\.output\chrome-mv3
   ```
5. 加载完成后，浏览器工具栏会出现插件图标。

### 步骤 3：验证扩展就绪状态

- **绿色图标**：表示扩展已成功连接 Native Messaging Host，且本地服务就绪。
- **自动自愈**：如果扩展启动瞬间出现黄色提示，扩展内置的 Watchdog 会在 2 秒内通过 HTTP 探测自愈恢复绿色。

---

## 3. 各大 Agent 客户端 MCP 配置模板

根据你所使用的 Agent 平台，将以下配置片段复制到对应的 MCP 配置文件中。

### 3.1 获取认证 Token 与核心环境变量

本服务具备严格的安全防护，要求所有连接均携带本地高熵 Token，并支持通过环境变量控制暴露工具面与前缀：

- **Token 文件路径**：`~/.chrome-mcp/bridge-token`（Windows 下为 `C:\Users\<用户名>\.chrome-mcp\bridge-token`）
- **核心环境变量**：
  - `CHROME_MCP_TOKEN`：自定义鉴权 Token 字符串（覆盖自动生成的文件）。
  - `CHROME_MCP_TOOL_PROFILE`：工具暴露分层 Profile。可选值：`core`（默认 14 个核心高频工具，~11.5k tokens）、`crawl`（12 个高速抓取抽取工具，~5.8k tokens）、`full`（全量 50 个工具，~19.5k tokens）。
  - `BROWSERPAW_TOOL_PREFIX`：工具命名空间前缀（`browserpaw_` 或 `chrome_`）。

> **提示**：若使用 `stdio` 模式，Native Server 会自动读取或生成该 Token，并在内部完成与 Chrome 扩展的握手。

---

### 3.2 Claude Desktop / Claude Code 配置

配置文件路径：`~/.claude/claude_desktop_config.json` 或项目级 `mcpServers`：

#### 方案 A：Streamable HTTP / SSE 模式（推荐，支持多客户端高并发）

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/sse",
      "headers": {
        "Authorization": "Bearer <从 ~/.chrome-mcp/bridge-token 读取的内容>"
      }
    }
  }
}
```

#### 方案 B：stdio 管道模式（由 Agent 自动拉起与托管生命周期）

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

### 3.3 Cursor 配置

在 `.cursor/mcp.json` 或 Cursor 设置页面（Settings -> Features -> MCP Servers -> Add New MCP Server）中配置：

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

配置文件路径：`~/.codeium/windsurf/mcp_config.json`：

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

## 4. Agent 高效操控心法与交互范式

为了实现最低的 Token 消耗、最快的执行响应与最高的点击准确率，Agent 在规划浏览器操作时**务必严格遵循以下六条核心交互准则**：

### 准则一：DOM 优先与紧凑数字索引（DOM-First）

- **常规交互主路径（占 90% 场景）**：
  1. 调用 `chrome_read_dom`。输出为过滤掉所有不可见及无用节点后的紧凑树，每个可交互节点带有清晰的 1-based 数字索引（例如 `[1]`, `[2]`, `[5]`）。
  2. 直接依据索引调用操作工具：
     - 点击：`chrome_interact_index({ index: 5 })`
     - 输入：`chrome_fill_index({ index: 2, text: "my-query" })`
- **严禁行为**：
  - 严禁在大模型中盲猜长 CSS 选择器（如 `div.app-container > section:nth-child(3)...`）或脆弱的绝对 XPath。
  - 严禁假设宿主 DOM 含有 `data-mcp-idx` 属性。

### 准则二：强推批量操作流水线与极速 1 回合规范 (Zero-RTT Submission)

- **面对查询、表单、登录或多步连续任务时**：
  - **严禁 3 回合低效往返反模式**：严禁拆成 Turn 1 `read_dom` -> Turn 2 `fill_index` -> Turn 3 `interact_index`！这种拆分导致 2 次多余的模型往返与 10s+ 延迟。
  - **1 回合极速最佳范式**：
    1. **搜索框 / 单输入框查询 / 手机号查询**：直接调用 `chrome_fill_index({ index: 15, text: "13800138000", pressEnter: true })`，物理输入并一回合自动回车提交并自适应变动沉淀！
    2. **输入框 + 独立提交按钮**：在 `chrome_read_dom` 识别到输入框与按钮后，**直接使用 `chrome_batch_actions` 一回合打包提交**：
       ```json
       {
         "actions": [
           { "type": "fill", "index": 15, "text": "13800138000", "clear": true },
           { "type": "click", "index": 18 }
         ],
         "waitForSettle": true
       }
       ```
    3. **多字段复杂表单**：使用 `chrome_batch_actions` 按序编排填充与提交，或使用 `chrome_form_pipeline` 自动推进：
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
  - `chrome_batch_actions` 会在底层连续派发真实 CDP 物理级事件，并将执行进度和中间状态一次性结构化返回。

### 准则三：纯视觉保底与坐标网格标尺（Visual Fallback）

- **遇到以下特殊场景时启用视觉兜底（占 10% 场景）**：
  1. 页面为纯 Canvas 应用、WebGL、动态图表或防爬虫混淆 DOM。
  2. 微小图标按钮在 DOM 树中未暴露文字或 Accessibility 属性。
- **视觉定位最佳实践**：
  1. 调用 `chrome_screenshot({ grid: true })`：
     - 截图会自动在图像上叠加**高对比度半透明像素网格标尺**（包含 X/Y 轴坐标标签与辅助线）。
     - Agent 可直接从图像上的网格精确读出物理像素坐标，彻底消除传统视觉大模型“盲猜像素”产生的漂移幻觉。
  2. 调用 `chrome_interact_index` 并传入坐标：
     ```json
     {
       "coordinate": { "x": 640, "y": 380 }
     }
     ```
  3. 若元素极为微小，可指定 `targetIndex` 启用局部高清扩充（ROI 将微小元素居中扩充至 400×400 高清切片）。

### 准则四：自驱动 Diff 携带机制（省 50% 交互往返）

- 调用 `chrome_interact_index`、`chrome_fill_index` 或 `chrome_batch_actions` 时，**务必开启 `includeDelta: true`**。
- 系统在操作执行后会自动比对局部 DOM，在响应中直接回传 `delta: { added, modified, removed }`。Agent 无需再次发起 `chrome_read_dom` 即可确认界面是否弹出下拉菜单或弹窗。

### 准则五：海量页面定向轻量检索（`chrome_grep`）

- 面对节点数 > 500 的大型或长列表页面，避免盲目 dump 全量 DOM，优先调用 `chrome_grep({ query: "登录" })` 秒级定位元素索引，单次 Token 消耗降低 90%+。
- 系统全面支持跨多层嵌套 iframe 与跨域子 Frame 扫描（层次化重映射索引），并深度比对节点文本、角色、`placeholder`、`aria-label` 与 `value` 属性。

### 准则六：自适应变动沉淀与自愈引导

- **变动沉淀等待（Action Settle）**：
  - 工具参数自带 `waitForSettle: true`。操作执行后，系统内部的 Watchdog 会监听 DOM MutationObserver 与活跃网络请求。当页面静默无新增请求时，仅需 50ms 即可快速返回；遇长加载自动平滑等待，兼顾极速与稳定性。
- **索引过期自愈机制**：
  - 当页面发生刷新、单页路由跳转或弹窗遮挡导致某个元素索引失效时，工具不会静默挂死，而是返回明确的诊断自愈指令：
    `ACTION REQUIRED: Please call 'chrome_read_dom' to refresh the index tree before re-attempting interaction`
  - Agent 收到此类错误提示时，**切勿盲目重复重试**，应立即重新调用一次 `chrome_read_dom`，基于刷新后的最新索引继续任务。

---

## 5. 常用工具参数速查

| 工具名称                            | 核心参数                                     | 作用说明                                                                              | 推荐场景                                    |
| :---------------------------------- | :------------------------------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------ |
| `chrome_read_dom`                   | `viewportOnly: true`                         | 获取极简剪枝 DOM 交互树与数字索引，Token 压缩 85%+                                    | **每个网页分析的第一步必调**                |
| `chrome_interact_index`             | `index` 或 `coordinate: {x,y}`               | 派发物理级鼠标点击或悬停                                                              | 单个按钮点击、链接跳转                      |
| `chrome_fill_index`                 | `index`, `text`, `clear: true`, `pressEnter` | 派发 CDP 原生物理级输入，自动清除旧值并填充文本，支持 `pressEnter: true` 自动提交     | 单输入框极速 1 回合填入并提交               |
| `chrome_batch_actions`              | `actions: [...]`, `waitForSettle: true`      | 在单次调用中按序编排多个点击、填充、按键与等待（含跨域 iframe 坐标转换）              | **多表单填充、连续复合操作的首选 (1 回合)** |
| `chrome_screenshot`                 | `grid: true`, `targetIndex`, `format`        | 纯内存直通 base64 截取视口图像，绝不污染用户 Downloads 目录；可选叠加半透明坐标标尺   | Canvas 画布、复杂验证码或无 DOM 节点图形    |
| `chrome_upload_file`                | `index` 或 `clickTargetIndex`, `filePath`    | 动态拦截弹窗或直接向文件输入框注入本地绝对路径                                        | 网页文件上传、头像更换                      |
| `chrome_get_markdown`               | `includeLinks: true`                         | 提取页面的清晰结构化 Markdown 内容                                                    | 网页内容阅读、文献资料总结                  |
| `chrome_grep`                       | `query`, `searchType`                        | 毫秒级正则/文本定向检索，支持多 Frame 索引重映射与 placeholder/aria-label 检索        | 长列表或大页面极速定位目标元素              |
| `chrome_inspect_media`              | `index` 或 `selector`                        | 无损内存提取图片原始高画质 Data URL 或局部超采样截图                                  | 验证码、图表、商品原图精准识别              |
| `chrome_request_human_intervention` | `reason`, `timeoutMs`                        | 纯 DOM 安全构建（免疫 DOM XSS）唤起毛玻璃顶栏挂起流程并让渡控制权给用户               | 遭遇滑块验证、2FA 或安全支付时              |
| `chrome_undo_last_action`           | 无                                           | 单步回滚最近一次页面跳转或表单填充                                                    | 操作失误时的容错与快速撤销                  |
| `chrome_close_tabs`                 | `tabIds`, `url`, `confirm`                   | 安全关闭标签页，关闭当前活跃标签页需显式传入 `confirm: true` 或携带会话亲缘，防止误关 | 任务完成清理或定向关闭特定网页              |
| `chrome_javascript`                 | `code`, `tabId`                              | 执行页面 JavaScript，支持顶级 await 与单表达式自动包装 `return (...)`                 | 即席数据计算、高级 DOM 探测                 |
| `chrome_tool_docs`                  | `category`, `activateForSession`             | 查询并免重启会话级动态激活 8 大类工具（HTTP/SSE 与 Stdio 双通道支持）                 | Profile 裁剪模式下按需调用高级工具          |

---

## 6. 故障排查与诊断指南

1. **连接被拒绝 (ECONNREFUSED `127.0.0.1:12306`)**：
   - 检查本地 Chrome 扩展是否处于打开状态（Service Worker 是否存活）。
   - 可在终端运行 `curl http://127.0.0.1:12306/ping`，若返回 `{"status":"ok","message":"pong"}` 说明服务已就绪。
2. **401 Unauthorized**：
   - 检查请求头中是否遗漏了 `Authorization: Bearer <token>`，或者 Token 是否与 `~/.chrome-mcp/bridge-token` 中的高熵密钥一致。
3. **扩展卡黄色警告（“未连接或服务未启动”）**：
   - 检查第 2 步中 `run_host.bat` (Windows) 或 `run_host.sh` 是否已成功以当前用户权限执行并成功写入注册表。
   - 点击 Chrome 扩展图标，在弹出的 Popup 界面点击“重新连接”按钮触发强制握手。
4. **超大文件传输报错**：
   - Native Messaging 管道存在 1MB 物理上限限制。文件上传或读取请直接传递本地文件的**绝对路径**（例如 `D:/docs/sample.pdf`），系统将在本地文件系统中直接读取，严禁将大文件转换为巨量 Base64 字符串通过管道传递。
