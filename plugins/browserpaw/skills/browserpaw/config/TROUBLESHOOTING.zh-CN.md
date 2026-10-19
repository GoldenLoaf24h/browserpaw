> **工具可用性说明**：标准 BrowserPaw MCP 暴露完整 50 工具集（full 配置档下；stdio 默认 core）。可选的 Hermes 插件暴露 16 个精选包装工具（`browserpaw_*`）。其余工具在 Hermes 插件中不可用，请使用标准 MCP。

# BrowserPaw 故障排查与自愈手册

[English](./TROUBLESHOOTING.md)

本手册汇总了支持 MCP 的 Agent 连接 BrowserPaw 时遇到的典型连通性、状态和权限问题，详述根因与标准恢复流程。

---

## ⚡ 快速自愈：一键诊断

出现任何异常时，从项目根目录运行自动诊断脚本：

```bash
# 运行只读健康检查
node skill/config/doctor.mjs

# 执行诊断与自修复（创建缺失 Token、修复注册表、同步产物）
node skill/config/doctor.mjs --fix
```

Windows 用户还可以双击 [`skill/config/repair.bat`](./repair.bat) 或运行 [`skill/config/repair.ps1`](./repair.ps1)。

---

## 常见问题（FAQ）

### 1. 客户端报告 `Connection Refused: 127.0.0.1:12306`

- **症状**：
  Agent 在初始化连接或执行工具时报：`fetch failed: ECONNREFUSED 127.0.0.1:12306`。
- **根因**：
  本地 Fastify 原生桥接服务未运行。BrowserPaw 遵循**按需生命周期**：当 Chrome 正在运行且扩展处于活动状态时，Chrome 通过原生消息传递宿主自动拉起原生桥接。
- **解决**：
  1. 在桌面上打开 Google Chrome；
  2. 确认浏览器中 `chrome://extensions/` 里的 BrowserPaw 已启用（或从解压扩展目录加载）；
  3. 点击扩展工具栏图标，打开 200px×80px 弹窗，确认状态指示为**绿色**；
  4. 若需在终端独立运行，手动启动桥接：
     ```bash
     node app/native-server/dist/index.js
     ```

---

### 2. 扩展弹窗显示灰色或黄色（“Service Not Started”）

- **症状**：
  点击 Chrome 扩展图标显示灰色或黄色指示灯，无法连接本地服务器。
- **排查与修复**：
  1. **检查原生消息传递宿主注册**：
     运行 `node skill/config/doctor.mjs`。若注册表键缺失，执行：
     ```bash
     node app/native-server/dist/scripts/register.js
     ```
  2. **检查端口冲突**：
     ```powershell
     netstat -ano | findstr :12306
     ```
     通过任务管理器或 `taskkill /F /PID <pid>` 终止冲突进程，然后重新打开 Chrome。

---

### 3. MCP 请求失败并报 `401 Unauthorized` 或 Token 不匹配

- **症状**：
  MCP 客户端调用失败，报 `Unauthorized: Missing or invalid token` 或 `Unauthorized: Invalid bridge token`。
- **根因**：
  原生桥接要求 Token 认证，以阻止恶意的本地网页或脚本。客户端配置的 Token 与 `~/.chrome-mcp/bridge-token` 不一致。
- **解决**：
  1. 读取当前有效 Token：
     ```powershell
     # Windows PowerShell
     Get-Content "$HOME\.chrome-mcp\bridge-token"
     ```
  2. 更新 Agent 的 MCP 配置请求头。同时支持 `x-mcp-token` 和 `Authorization: Bearer <token>`：
     ```json
     "headers": {
       "x-mcp-token": "<TOKEN>",
       "Authorization": "Bearer <TOKEN>"
     }
     ```

---

### 4. `ACTION REQUIRED: Please call 'browserpaw_read_dom' to refresh`

- **症状**：
  调用 `browserpaw_interact_index` 或 `browserpaw_fill_index` 返回：
  `ACTION REQUIRED: Element reference is stale. Please call 'browserpaw_read_dom' to refresh the index tree.`
- **根因**：
  SPA 路由、模态动画或异步 DOM 变更重渲染了目标树。数字索引（`ref`）已过期。
- **协议**：
  **绝不要盲目重试！** Agent 必须调用 `browserpaw_read_dom` 获取新的 1 起始索引，然后继续。

---

### 5. 高 DPI 显示器（125%/150%/200%）坐标对齐

- **症状**：
  视觉模型点击在高分辨率屏幕上偏离目标。
- **保证**：
  BrowserPaw 在 `screenshot.ts` 中把所有截图归一化为 **1:1 视口 CSS 坐标**（$W_{viewport} \times H_{viewport}$）。
- **规则**：
  **绝不要手动把坐标乘以 DPR！** 直接从截图测量并传入原始 CSS 值。

---

### 6. 原生对话框（Alert / Confirm / Prompt）阻塞执行

- **症状**：
  原生 `alert()` 或 `confirm()` 使 CDP 命令挂起。
- **处理**：
  BrowserPaw 拦截对话框并返回 `requiresDialogAction: true`。调用 `browserpaw_handle_dialog({ action: "accept" })` 关闭并解冻执行。

---

### 7. `browserpaw_close_tabs` 需要显式确认（`confirm: true`）

- **症状**：
  `browserpaw_close_tabs({})` 失败并报 `No tabIds or url specified. To close the current active tab, pass confirm: true...`。
- **安全机制**：
  当 Agent 遗漏目标参数时保护用户免受意外标签页丢失。仅在有意关闭活动标签页时传入 `confirm: true`，或提供显式的 `tabIds` / `sessionId`。

---

### 8. CDP 调试器分离与超时守卫（`timeout-guard detached`）

- **症状**：
  `Target closed / not attached / timeout-guard detached`。
- **机制**：
  在缓慢或无响应的页面上，`timeout-guard` 会干净地分离（`chrome.debugger.detach`），保护 Service Worker 免于死锁。
- **动作**：
  刷新标签页或重新调用工具。会话会自动干净地重新附加。

---

### 9. 后台标签页离屏截图与隐私隔离

- **机制**：
  后台标签页严格使用带 `fromSurface: true` 的 CDP `Page.captureScreenshot`。绝不捕获用户的前台显示，并消除 `requestAnimationFrame` 冻结死锁。

---

### 10. Stdio 与 HTTP/SSE 下的动态配置档激活

- **方法**：
  在 `core` 或 `crawl` 配置档下调用：
  ```json
  browserpaw_tool_docs({ "category": "manage", "activateForSession": true })
  ```
  即可在当前活动会话内动态暴露高级工具，无需重启服务器。

---

### 11. `browserpaw_javascript` 表达式求值

- **特性**：
  `document.title` 或 `window.location.href` 之类的单表达式会自动包裹为 `return (...)`。

---

### 12. Hermes Agent 集成与插件诊断

- **默认 Stdio 连接**：在 Hermes Agent 中，使用默认 `stdio` 传输（`mcp-chrome-stdio`）把 BrowserPaw 连接为标准 MCP 服务器。标准 stdio 默认使用 `core` 配置档并支持动态解锁；配置 `env: { CHROME_MCP_TOOL_PROFILE: "full" }` 可在不依赖本地 HTTP 端口或 Bearer Token 的情况下暴露完整 50 工具集。
- **可选插件（16 个精选包装器）**：Hermes 可选插件（`browserpaw`）通过 `ctx.call_mcp` 委托给原生 MCP 客户端，暴露 16 个高频自动化工具（`browserpaw_*`）。这 16 个之外的任何工具都**在 Hermes 插件中不可用；请使用标准 MCP**。
- **调用工具时的 PermissionError**：Hermes `>=0.21.5` 强制执行默认拒绝安全策略。你必须在 `~/.hermes/config.yaml` 中设置 `mcp_allowlist` 来授权插件：
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
- **插件零凭据**：插件直接委托给 Hermes 的原生 MCP 客户端。插件运行不需要任何本地 Token（`BROWSERPAW_MCP_TOKEN`）或会话环境变量（`BROWSERPAW_MCP_SESSION_ID`）。

---

## 目录与组件图

| 组件                      | 源码路径                       | 产物 / 运行时端点                                       |
| :------------------------ | :----------------------------- | :------------------------------------------------------ |
| **Chrome MV3 扩展**       | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`               |
| **原生桥接服务器**        | `app/native-server/`           | `127.0.0.1:12306`（Token：`~/.chrome-mcp/bridge-token`） |
| **MCP 工具契约**          | `packages/shared/src/tools.ts` | 48 个规范 MCP 工具定义                                  |
| **诊断与修复**            | `skill/config/`                | `doctor.mjs`、`mcp-config.json`、`repair.bat`           |
