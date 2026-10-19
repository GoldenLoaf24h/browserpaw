# BrowserPaw 故障排查与自愈指南

[English](./TROUBLESHOOTING.md)

BrowserPaw 由三个本地协同层级组成：

1. **Chrome 扩展（MV3）**：运行在你日常使用的 Google Chrome 内，执行 CDP 命令和 DOM 索引。
2. **原生消息传递宿主（Node.js）**：由 Chrome 通过 Native Messaging 自动启动，桥接协议调用。
3. **MCP 端点（127.0.0.1:12306 / Stdio）**：高速 Fastify MCP 服务器，与你的 AI Agent（Cursor、Claude Code、Windsurf、Cline、Codex、Antigravity）通信。

本指南为所有已知的运行时和构建问题提供确定的诊断方法、根因解释和经过验证的修复方案。

---

## ⚡ 快速自愈：一键诊断

在手动排查之前，先从仓库根目录运行自动诊断脚本：

```bash
# 通过 doctor 脚本或 CLI 运行只读健康检查
node skill/config/doctor.mjs
# 或通过 CLI 入口：
node bin/browserpaw.cjs doctor
# （若已全局安装：npx browserpaw doctor）

# 运行自动诊断与自愈（重建 Token、修复注册表、同步构建产物）
node skill/config/doctor.mjs --fix
```

Windows 用户还可以双击 [`skill/config/repair.bat`](../skill/config/repair.bat) 或执行 [`skill/config/repair.ps1`](../skill/config/repair.ps1)。

---

## 1. 连接被拒：`127.0.0.1:12306`

### 症状

Agent 客户端报告：`fetch failed: ECONNREFUSED 127.0.0.1:12306` 或 `connect ECONNREFUSED 127.0.0.1:12306`。

### 根因

本地原生桥接服务当前未运行。BrowserPaw 采用**按需生命周期**：Chrome 启动且 BrowserPaw 扩展处于活动状态时，Chrome 会自动启动原生消息传递宿主。如果 Chrome 未打开，桥接就不会运行。

### 解决步骤

1. **启动 Google Chrome**：确保 Chrome 正在你的桌面上运行。
2. **验证扩展状态**：访问 `chrome://extensions/`，确认 BrowserPaw 已启用（或从 `app/chrome-extension/.output/chrome-mv3` 加载已解压的扩展）。
3. **检查弹窗状态**：点击 Chrome 工具栏中的 BrowserPaw 扩展图标。200px×80px 面板中的状态点应变为**绿色**（“Connected”）。
4. **检查端口监听**：
   ```powershell
   netstat -ano | findstr :12306
   ```
5. **独立后台运行（可选）**：如果需要不等待 Chrome 原生消息传递而独立运行桥接：
   ```bash
   node app/native-server/dist/index.js
   ```
6. **Windows 僵尸进程清理**：
   在旧版本中，Chrome 突然终止偶尔会留下占用 12306 端口的孤儿 Node 进程。BrowserPaw v2.3.8+ 包含 `closeAllConnections()` 和 1000ms 无引用看门狗。如果仍有旧的僵尸进程占用端口：
   ```powershell
   taskkill /F /IM node.exe
   ```

---

## 2. 扩展弹窗显示灰色或黄色（“Service Not Started”）

### 症状

点击 BrowserPaw 扩展图标显示灰色或黄色指示灯，提示原生桥接不可达。

### 根因与修复

1. **未注册的原生消息传递宿主**：
   Chrome 无法在操作系统注册表中找到原生消息传递清单。运行：
   ```bash
   node skill/config/doctor.mjs --fix
   # 或手动注册：
   node app/native-server/dist/scripts/register.js
   ```
2. **12306 端口冲突**：
   另一个进程占用了 12306 端口。找出冲突的 PID：
   ```powershell
   netstat -ano | findstr :12306
   ```
   终止肇事进程，或通过环境变量 `CHROME_MCP_PORT=12307` 配置自定义端口。
3. **弹窗中禁用了 Agent 控制**：
   弹窗开关把 `agentControlEnabled` 存储在 `chrome.storage.session` 中。若被关闭，所有 MCP 工具执行都会被有意拦截。打开弹窗并确认开关处于**活动**状态。
4. **扩展重载后需要重连宿主**：
   在 `chrome://extensions` 中重载扩展后，原生消息传递管道会断开。点击一次扩展弹窗或重启 Chrome 以重新建立管道。

---

## 3. HTTP `401 Unauthorized` 或 Token 校验失败

### 症状

MCP 客户端请求失败，报 `HTTP 401 Unauthorized: Missing or invalid token` 或 `Unauthorized: Invalid bridge token`。

### 根因

为了保护你活跃的浏览器会话免受不可信的本地网站或进程影响，BrowserPaw 严格强制 Token 认证。客户端配置必须与 `~/.chrome-mcp/bridge-token` 中存储的 Token 一致。

### 解决步骤

1. **读取当前有效 Token**：
   ```powershell
   # Windows PowerShell
   Get-Content "$HOME\.chrome-mcp\bridge-token"
   ```
   ```bash
   # macOS / Linux
   cat ~/.chrome-mcp/bridge-token
   ```
2. **更新 Agent 客户端配置**：
   确保 MCP 客户端请求头包含准确的 Token。同时支持 `x-mcp-token` 和标准 `Authorization: Bearer <token>`：
   ```json
   {
     "mcpServers": {
       "browserpaw": {
         "url": "http://127.0.0.1:12306/mcp",
         "headers": {
           "x-mcp-token": "<TOKEN_FROM_BRIDGE_TOKEN_FILE>",
           "Authorization": "Bearer <TOKEN_FROM_BRIDGE_TOKEN_FILE>"
         }
       }
     }
   }
   ```
3. **自动生成缺失的 Token**：
   如果文件不存在，运行 `node skill/config/doctor.mjs --fix` 生成新的加密 Token。

---

## 4. 过期元素索引：`ACTION REQUIRED: Element reference is stale`

### 症状

调用 `chrome_interact_index`、`chrome_fill_index` 或 `chrome_interact_index (action: 'hover')` 返回：
`ACTION REQUIRED: Element reference is stale. Please call 'chrome_read_dom' to refresh the index tree.`

### 根因

现代单页应用（React、Vue、Next.js）在路由切换、模态动画或 API 更新后会动态重渲染 DOM 树。此前捕获的 1 起始索引（例如 `[14]`）不再指向活跃的 DOM 节点。

### 标准 Agent 协议

**绝不要盲目重试同一个索引！**
Agent 必须立即调用 `chrome_read_dom` 获取新的 1 起始元素索引，然后用新索引继续操作。或者使用 `chrome_batch_actions`，它会在多步派发前校验元素是否存在。

---

## 5. 高 DPI 显示器（125%/150%/200%）与点击坐标漂移

### 症状

使用视觉点击工具（`chrome_interact_index`）时，在高分辨率或缩放显示的 Windows 上，鼠标点击落点偏离可见目标。

### 架构与保证

BrowserPaw 在 `screenshot.ts` 中实现了 **1:1 视口 CSS 几何归一化**。截图通过 `OffscreenCanvas` 重采样到精确的标准 CSS 视口尺寸（W_viewport × H_viewport）。

### 重要 Agent 指引

**绝不要手动把坐标乘以设备像素比（DPR）！**
始终按相对于截图图像测量的结果直接派发坐标。BrowserPaw 内部的运动学引擎会把 1:1 CSS 坐标直接映射到 CDP 硬件事件。

---

## 6. 原生对话框拦截（Alert / Confirm / Prompt）

### 症状

网页触发同步的浏览器 `window.alert()`、`window.confirm()` 或 `window.prompt()`，导致 CDP 命令或脚本挂起。

### 自愈流程

BrowserPaw 通过 `Page.javascriptDialogOpening` 自动拦截模态对话框。当某个动作触发对话框时，它会立即返回：

```json
{
  "requiresDialogAction": true,
  "dialog": {
    "type": "alert",
    "message": "Are you sure you want to proceed?"
  }
}
```

**解决**：调用 `chrome_handle_dialog({ action: "accept" })`（或 `"dismiss"`，可带 `promptText`）关闭模态框并解锁后续动作。

---

## 7. 误关标签页保护（`confirm: true`）

### 症状

调用 `chrome_close_tabs({})` 失败并报：
`No tabIds or url specified. To close the current active tab, pass confirm: true or specify tabIds explicitly...`

### 安全理由

为防止自主 Agent 因遗漏参数而误关用户正在使用的前台标签页，关闭活动标签页需要显式确认。

### 解决

- 要关闭 Agent 创建的标签页，提供显式 `tabIds: [tabId]` 或目标 `url`。
- 若在已绑定的会话内工作，提供 `sessionId` 以释放关联标签页。
- 若你确实要关闭用户当前的前台标签页，显式传入 `confirm: true`。

---

## 8. CDP 分离与超时守卫（`timeout-guard detached`）

### 症状

CDP 工具执行返回：`Target closed / not attached / timeout-guard detached`。

### 底层机制

如果目标页面崩溃、突然导航，或 CDP 命令超过安全延迟阈值，底层 `timeout-guard` 会触发立即物理分离（`chrome.debugger.detach`）并清除域引用计数器。这能防止 Chrome 的 Service Worker 死锁或内存泄漏。

### 解决

刷新页面或重新调用工具。BrowserPaw 会自动重新附加一个全新、干净的 CDP 调试会话。

---

## 9. 后台标签页离屏截图与隐私隔离

### 架构

对于后台标签页（`active: false`），BrowserPaw 严格派发 CDP `Page.captureScreenshot`（`fromSurface: true`）。它**严格禁止**使用 `chrome.tabs.captureVisibleTab`。

### 收益

1. **零隐私泄漏**：防止在 Agent 后台操作时捕获用户当前活跃的个人屏幕。
2. **消除死锁**：被 Chrome 的 `requestAnimationFrame` 节能机制挂起的后台标签页也能干净截图而不会挂起。

---

## 10. Stdio 与 HTTP/SSE 下的动态配置档激活

### 使用场景

在受限配置档（`core` 14 个工具或 `crawl` 12 个工具）下运行时，Agent 可以在不重启服务器进程的情况下动态请求高级工具（例如 `manage`、`diagnose`、`network`）。

### 方法

调用：

```json
chrome_tool_docs({ "category": "manage", "activateForSession": true })
```

所请求的工具会立即在当前会话内变为可调用，Stdio 与 HTTP/SSE 两种传输均适用。

---

## 11. `chrome_javascript` 表达式执行

### 便利特性

通过 `chrome_javascript` 求值 JavaScript 表达式时，无需把代码包裹在 `(function(){ return ... })()` 中。诸如 `document.title`、`window.location.href` 之类的单表达式或简洁求值会自动包裹为 `return (...)`。多行语句请包含标准 `return` 语句。

---

## Hermes Agent 与插件故障排查

### 1. `PermissionError: Plugin 'browserpaw' is not allowed to call MCP server 'browserpaw'`

- **症状**：
  在 Hermes Agent 下调用任意 `browserpaw_*` 工具失败并报：
  `PermissionError: Plugin 'browserpaw' is not allowed to call MCP server 'browserpaw'. Add it to plugins.entries.browserpaw.mcp_allowlist in config.yaml to grant access (default is no MCP access).`
- **根因**：
  Hermes `>=0.21.5` 对经由 `ctx.call_mcp` 的插件发起 MCP 调用强制执行能力门控、默认拒绝的安全策略。
- **解决**：
  在 `~/.hermes/config.yaml` 中通过添加 `mcp_allowlist` 授予插件权限：
  ```yaml
  plugins:
    enabled:
      - browserpaw
    entries:
      browserpaw:
        mcp_allowlist:
          - browserpaw
        settings:
          isolate_modal: false
  ```

### 2. 工具可用性：50+ 标准工具 vs 16 个插件包装器

- **症状**：
  Agent 在 Hermes 插件模式下请求高级工具（如 `chrome_click_coordinate`、`chrome_debugger` 或 `chrome_performance_start`），收到工具不存在的错误。
- **根因**：
  可选的 Hermes 插件提供 16 个精选高频自动化工具（`browserpaw_*`）。这 16 个之外的任何工具都**在 Hermes 插件中不可用；请使用标准 MCP**。
- **解决**：
  在 Hermes 中把 BrowserPaw 配置为标准 MCP 服务器（`mcp_servers.browserpaw`），使用默认 stdio。标准 stdio 默认使用 `core` 配置档，可通过 `chrome_tool_docs({ activateForSession: true })` 动态解锁；要在启动时就静态暴露完整 50 工具集，配置 `env: { CHROME_MCP_TOOL_PROFILE: "full" }`。

### 3. 插件零 Token / 零凭据要求

- **澄清**：
  Hermes 可选插件直接通过 Hermes 的原生 MCP 客户端委托。插件本身**不需要任何 Token**（`BROWSERPAW_MCP_TOKEN`），也**不需要任何会话环境变量**（`BROWSERPAW_MCP_SESSION_ID`）。本地 HTTP 端口和 Bearer Token 配置严格属于外部 HTTP MCP 服务器定义，与插件无关。

### 4. 模态对话框隔离（`isolate_modal`）

- **配置（可选）**：
  默认为 `false`。如果你希望在 `browserpaw_read_dom` 中自动隔离活跃的模态对话框，请在你的 Hermes 配置文件的 `plugins.entries.browserpaw` 下设置 `settings.isolate_modal: true`。

---

## 12. 错误代码与诊断参考表

| 错误特征                                                   | 根因                                                | 验证过的处理动作                                                           |
| :--------------------------------------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------- |
| `Cannot access a chrome:// URL`                            | Chrome 安全策略限制扩展调试内部系统页面。           | 导航到标准的 `http://`、`https://` 或 `file://` URL。                      |
| `executeScript timeout ... renderer not acking`            | 渲染进程无响应或被原生模态对话框阻塞。              | 调用 `chrome_handle_dialog` 或刷新目标标签页。                             |
| `CDP_DISPATCH_TIMEOUT`                                     | 后台标签页执行在系统重度节流下超时。                | 重试动作或短暂把标签页切到前台。                                           |
| `Security check failed: Domain changed`                    | 截图捕获与坐标动作之间发生了导航。                  | 调用 `chrome_read_dom` 或 `chrome_take_screenshot` 重新对齐状态。          |
| `Tool X is not exposed under the ... profile`              | 工具在当前配置档（`core`/`crawl`）下被隐藏。        | 调用 `chrome_tool_docs({ category: "<cat>", activateForSession: true })`。 |
| `Tool X is not a BrowserPaw tool`                          | 请求了不存在的工具名。                              | 查阅 `tools/list`（50 个规范工具可用）。                                   |
| `captureScreenshot returned empty data for background tab` | 后台标签页被关闭或被 Chrome 内存节省器丢弃。        | 重新打开或导航到目标 URL。                                                 |
| `Failed to ... index [X] in cross-origin frame`            | 子 iframe 已卸载或被 sandbox 权限限制。             | 用 `chrome_read_dom({ filter: "interactive" })` 检查 frame 状态。          |
| `Message sender rejected / unauthenticated content script` | 安全守卫拦截了未授权的消息发送方（`_sender.tab`）。 | 确保请求来自真实的原生桥接通道。                                           |

---

## 13. Monorepo 构建故障排查

### 干净构建顺序

如果从源码构建时遇到 TypeScript 错误（`TS7016`、缺少声明）：

```bash
# 1. 安装依赖
pnpm install

# 2. 共享类型必须最先构建
pnpm --filter chrome-mcp-shared build

# 3. 构建完整 monorepo
pnpm build
```

### 组件构建快捷方式

- **仅扩展**：`pnpm --filter @browserpaw/extension build`（输出：`app/chrome-extension/.output/chrome-mv3`）
- **仅原生桥接**：`pnpm --filter @browserpaw/native-server build`

---

## 14. 日志位置与诊断

- **Chrome 扩展 Service Worker**：
  打开 `chrome://extensions/` → 在 BrowserPaw 下点击 **Service Worker** 检查链接 → 检查带 `[NativeHost]` 或 `[Screenshot Tool]` 前缀的控制台消息。
- **原生服务器日志**：
  直接输出到进程的 `stdout`/`stderr` 或你的终端控制台。
- **跟踪文件**：
  通过 `chrome_performance_start` 录制的性能跟踪默认写入操作系统临时目录（`os.tmpdir()`），除非显式请求 `saveToDownloads: true`。

---

## 15. 组件与文件目录图

| 组件                | 源码路径                       | 生产产物 / 端点                                          |
| :------------------ | :----------------------------- | :------------------------------------------------------- |
| **Chrome MV3 扩展** | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`                |
| **原生桥接服务器**  | `app/native-server/`           | `127.0.0.1:12306`（Token：`~/.chrome-mcp/bridge-token`） |
| **共享工具 Schema** | `packages/shared/src/tools.ts` | 50 个规范 MCP 工具定义                                   |
| **诊断与修复**      | `skill/config/`                | `doctor.mjs`、`mcp-config.json`、`repair.bat`            |
