# BrowserPaw 故障排查与自愈手册 (Troubleshooting Guide)

[English Version](./TROUBLESHOOTING.md)

本文档汇总了 BrowserPaw 在接入各类 MCP Agent 客户端过程中可能遇到的典型问题、深层根因及标准修复方案。

---

## ⚡ 快速自愈：一键诊断与修复

遇到任何连接或操作异常，请优先在项目根目录运行自动化诊断脚本：

```bash
# 仅执行健康检查
node skill/config/doctor.mjs

# 执行诊断并自动修复（创建丢失的 Token、修复注册表、同步构建产物）
node skill/config/doctor.mjs --fix
```

Windows 用户亦可直接双击运行 [`skill/config/repair.bat`](./repair.bat) 或执行 [`skill/config/repair.ps1`](./repair.ps1)。

---

## 常见问题与解决方案 (FAQ)

### 1. 客户端报 `Connection Refused: 127.0.0.1:12306`

- **故障现象**：
  Agent 客户端在调用工具或初始化连接时报错：`fetch failed: ECONNREFUSED 127.0.0.1:12306`。
- **根本原因**：
  本地 Fastify Native Bridge 服务尚未启动。BrowserPaw 的架构是**按需自启**的：当 Chrome 浏览器启动且扩展激活时，扩展通过 Native Messaging Host 自动拉起 Native Bridge。
- **解决步骤**：
  1. 打开本地 Chrome 浏览器；
  2. 确认已在 `chrome://extensions/` 中启用 BrowserPaw；
  3. 点击浏览器右上角扩展图标，弹出 200px×80px 极简面板，观察状态指示点是否变为**绿色**；
  4. 若需独立后台运行，可在终端手动启动：
     ```bash
     node app/native-server/dist/index.js
     ```

---

### 2. 扩展图标弹窗显示灰色/黄色（“服务未启动”）

- **故障现象**：
  点击 Chrome 扩展图标，状态点为灰色或黄色，提示无法连接本地服务。
- **排查与修复**：
  1. **检查 Native Messaging Host 注册状态**：
     运行 `node skill/config/doctor.mjs`。如果提示注册表缺失，运行：
     ```bash
     node app/native-server/dist/scripts/register.js
     ```
  2. **检查端口占用**：
     在终端运行：
     ```powershell
     netstat -ano | findstr :12306
     ```
     如果存在孤儿进程占用了 12306 端口，使用任务管理器或 `taskkill /F /PID <pid>` 结束该进程，随后重新打开 Chrome。

---

### 3. MCP 响应报 `401 Unauthorized` 或 Token 验证失败

- **故障现象**：
  MCP 客户端发送请求，收到 HTTP 401 报错：`Unauthorized: Missing or invalid token`。
- **根本原因**：
  为防范本地恶意网页或未经授权的本地进程越权控制浏览器，Native Bridge 默认强制校验 Token。客户端配置中的 Token 与本地 `~/.chrome-mcp/bridge-token` 不一致。
- **解决步骤**：
  1. 查看本地当前正确 Token：
     ```powershell
     # Windows PowerShell
     Get-Content "$HOME\.chrome-mcp\bridge-token"
     ```
  2. 打开所用客户端的 MCP 配置文件，将请求头中的 `x-mcp-token` 或 `Authorization: Bearer <token>` 更新为上述实际值：
     ```json
     "headers": {
       "x-mcp-token": "粘贴上方读取到的Token",
       "Authorization": "Bearer 粘贴上方读取到的Token"
     }
     ```

---

### 4. 交互报错 `ACTION REQUIRED: Please call 'browserpaw_read_dom' to refresh`

- **故障现象**：
  执行 `browserpaw_interact_index` 或 `browserpaw_fill_index` 时返回：
  `ACTION REQUIRED: Element reference is stale. Please call 'browserpaw_read_dom' to refresh the index tree.`
- **根本原因**：
  目标页面发生了 SPA 单页路由跳转、动态加载或局部 DOM 树重渲染，导致上一轮提取的数字索引（`ref`）在当前 DOM 树中已失效。
- **规范解决行为**：
  **严禁盲目重试！**
  Agent 必须立即调用一次 `browserpaw_read_dom`，获取最新 1-based 索引树，基于新索引继续下发动作。

---

### 5. Windows 高分屏 (125%/150%/200%) 截图点击坐标偏移

- **故障现象**：
  在大模型视觉点击模式下，点击位置偏离目标。
- **底层保障**：
  BrowserPaw 已在 `screenshot.ts` 中实现全链路 **DPR 1:1 几何归一化**（通过 `OffscreenCanvas` 强制重采样为标准 CSS 视口尺寸 $W_{viewport} \times H_{viewport}$）。
- **注意事项**：
  Agent 在计算或下发坐标时，**切勿手动乘以设备像素比（DPR）**！直接使用截图上的物理像素位置下发即可（引擎与视口 CSS 像素 1:1 严格对齐）。

---

### 6. 原生系统弹窗（Alert / Confirm / Prompt）阻塞

- **故障现象**：
  页面弹出原生 `alert()` 或 `confirm()`，导致后续 CDP 指令挂起。
- **自愈机制**：
  BrowserPaw 内置了瞬态 Dialog 中断捕获。当弹窗出现时，动作会立刻返回带有 `requiresDialogAction: true` 的提示：
  ```json
  {
    "requiresDialogAction": true,
    "dialog": {
      "type": "alert",
      "message": "Are you sure?"
    }
  }
  ```
  Agent 只需调用 `browserpaw_handle_dialog({ action: 'accept' })` 即可平滑解除挂起。

---

### 7. 调用 `browserpaw_close_tabs` 报需显式确认 (`confirm: true`)

- **故障现象**：
  Agent 调用 `browserpaw_close_tabs({})` 报错：`No tabIds or url specified. To close the current active tab, pass confirm: true or specify tabIds explicitly...`。
- **根本原因与防误关保护**：
  为防止 AI Agent 在未绑定特定标签页或参数缺省时意外关闭人类用户正在查看的前台活跃工作标签页，系统强制开启活跃 Tab 确认保护。
- **规范解决行为**：
  - 若需关闭 Agent 创建的特定标签页，显式传递目标 `tabIds: [tabId]` 或 `url`；
  - 若已建立会话亲缘，传递 `sessionId` 即可安全释放绑定的 Agent Tab；
  - 若确需关闭当前用户前台活跃 Tab，显式传入 `confirm: true`。

---

### 8. CDP 调试器解挂与连接超时 (`timeout-guard detached`)

- **故障现象**：
  调用 CDP 相关工具报错：`Target closed / not attached / timeout-guard detached`。
- **底层机制**：
  当目标页面崩溃、极度卡死或 CDP 协议响应超过安全阈值时，底层的 `timeout-guard` 守护机制会直接触发物理级快速脱钩（`chrome.debugger.detach`）并清理会话映射与域引用计数，坚决阻止 Service Worker 产生未响应挂起或引用计数下溢死锁。
- **处理方案**：
  刷新目标页面或重新发起工具调用，系统将自动重新建立健康的 CDP 调试会话。

---

### 9. 后台 Tab 离屏截图与隐私隔离

- **底层机制**：
  对于非激活标签页（`active: false`），BrowserPaw 强制采用 CDP `Page.captureScreenshot`（`fromSurface: true`），严禁使用 Chrome 扩展默认的 `chrome.tabs.captureVisibleTab`。
- **核心收益**：
  1. 彻底消除前台屏幕泄露隐患（避免后台 Agent 获取到用户当前前台私密屏幕）；
  2. 消除后台非激活标签页因 `requestAnimationFrame` 睡眠冻结导致的死锁。

---

### 10. Stdio 与 HTTP/SSE 模式下的动态 Profile 激活

- **应用场景**：
  在 `core` 或 `crawl` 模式下，若任务需要额外调用高级工具（如管理、诊断或网络工具），无需重启 MCP 进程或更改启动环境变量。
- **操作方法**：
  直接调用：
  ```json
  browserpaw_tool_docs({ "category": "manage", "activateForSession": true })
  ```
  支持类别：`navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, `crawl`。Stdio 与 HTTP/SSE 均原生支持在后续调用中立即使用新开放的工具。

---

### 11. `browserpaw_javascript` 即席表达式执行

- **使用技巧**：
  执行 JavaScript 时，Agent 无需手动编写 `(function(){ return ... })()`。无论是单表达式如 `document.title`、`window.location.href`，还是包含注释的单个求值表达式，执行器均会自动探测并包装 `return (...)`。对于多行复合逻辑，保持标准 `return` 关键字即可。

---

## 技术支持与目录对照

| 组件                   | 源码路径                       | 独立免编译目录                                          |
| :--------------------- | :----------------------------- | :------------------------------------------------------ |
| **Chrome MV3 扩展**    | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`               |
| **Native Bridge 服务** | `app/native-server/`           | `127.0.0.1:12306` (Token: `~/.chrome-mcp/bridge-token`) |
| **MCP 工具与契约声明** | `packages/shared/src/tools.ts` | 导出 48 个规范工具供客户端自动内省与校验                |
| **诊断与配置**         | `skill/config/`                | `doctor.mjs`, `mcp-config.json`, `repair.bat`           |
