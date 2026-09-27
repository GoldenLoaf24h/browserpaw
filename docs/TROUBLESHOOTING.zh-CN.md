# BrowserPaw 故障排查与自愈手册 (Troubleshooting Guide)

[English Version](./TROUBLESHOOTING.md)

BrowserPaw 由本地协同运行的三部分组成：

1. **Chrome 扩展 (MV3)**：运行于日常使用的 Google Chrome 中，负责执行底层 CDP 指令与 DOM 树索引解析。
2. **原生宿主进程 (Native Messaging Host)**：由 Chrome 扩展通过 Native Messaging 协议按需拉起，桥接本地指令。
3. **MCP 协议服务 (127.0.0.1:12306 / Stdio)**：基于 Fastify 的高性能本地 MCP 服务端，与 AI Agent（Cursor、Claude Code、Windsurf、Cline、Codex、Antigravity 等）实时通信。

本文档汇总了运行时故障、连接异常、权限校验、构建报错的深层根因与标准修复方案。

---

## ⚡ 快速自愈：一键诊断与修复

遇到任何连接或操作异常，请优先在项目根目录运行自动化诊断脚本：

```bash
# 仅执行健康检查（通过 doctor 脚本或 CLI）
node skill/config/doctor.mjs
# 或通过 CLI 执行：
node bin/browserpaw.cjs doctor
# （若已安装全局或发布包，可直接执行：npx browserpaw doctor）

# 执行诊断并自动修复（创建丢失的 Token、修复注册表、同步构建产物）
node skill/config/doctor.mjs --fix
```

Windows 用户亦可直接双击运行 [`skill/config/repair.bat`](../skill/config/repair.bat) 或执行 [`skill/config/repair.ps1`](../skill/config/repair.ps1)。

---

## 1. 客户端报 `Connection Refused: 127.0.0.1:12306`

### 故障现象

Agent 客户端在调用工具或初始化连接时报错：`fetch failed: ECONNREFUSED 127.0.0.1:12306` 或 `connect ECONNREFUSED 127.0.0.1:12306`。

### 根本原因

本地 Native Bridge 服务尚未启动。BrowserPaw 的架构是**按需自启**的：当 Chrome 浏览器启动且扩展激活时，扩展通过 Native Messaging Host 自动拉起 Native Bridge。若 Chrome 未运行，则宿主服务不存在。

### 解决步骤

1. **打开 Chrome 浏览器**：确保日常 Chrome 处于运行状态；
2. **确认扩展已启用**：在 `chrome://extensions/` 中确认已启用 BrowserPaw（或加载了 `app/chrome-extension/.output/chrome-mv3`）；
3. **查看 Popup 面板状态**：点击浏览器右上角扩展图标，观察 200px×80px 极简面板中的状态指示点是否变为**绿色**；
4. **排查端口监听**：
   ```powershell
   netstat -ano | findstr :12306
   ```
5. **独立后台运行（可选）**：若需独立后台运行而不依赖扩展拉起，可在终端手动启动：
   ```bash
   node app/native-server/dist/index.js
   ```
6. **Windows 僵尸进程防死锁说明（v2.3.8+）**：
   旧版本在 Chrome 关闭时可能因 HTTP Keep-Alive 未断开导致 Node 进程残留占用端口；当前版本已内置 `closeAllConnections()` 与 1000ms unref 硬看门狗强制退出。若遇历史残留孤儿进程，可执行以下命令彻底清理：
   ```powershell
   taskkill /F /IM node.exe
   ```

---

## 2. 扩展图标弹窗显示灰色/黄色（“服务未启动”）

### 故障现象

点击 Chrome 扩展图标，状态点为灰色或黄色，提示无法连接本地服务。

### 排查与修复

1. **检查 Native Messaging Host 注册状态**：
   Chrome 无法在系统注册表中找到宿主配置清单。运行：
   ```bash
   node skill/config/doctor.mjs --fix
   # 或手动运行注册脚本：
   node app/native-server/dist/scripts/register.js
   ```
2. **检查端口占用冲突**：
   在终端运行：
   ```powershell
   netstat -ano | findstr :12306
   ```
   如果有其他进程占用了 12306 端口，使用任务管理器或 `taskkill /F /PID <pid>` 结束该进程，或在环境变量中指定 `CHROME_MCP_PORT=12307`。
3. **Popup 中误关了 Agent 权限**：
   Popup 开关将 `agentControlEnabled` 存储在 `chrome.storage.session` 中。如果被误关，所有工具调用均会被拦截。打开扩展弹窗确认控制开关处于**启用**状态。
4. **扩展重载需重连**：
   在 `chrome://extensions` 点击刷新重载扩展后，原有的 Native Messaging 管道会断开。点击一次扩展图标或重启浏览器即可自动重连。

---

## 3. MCP 响应报 `401 Unauthorized` 或 Token 验证失败

### 故障现象

MCP 客户端发送请求，收到 HTTP 401 报错：`Unauthorized: Missing or invalid token` 或 `Unauthorized: Invalid bridge token`。

### 根本原因

为防范本地恶意网页或未经授权的进程越权控制浏览器，Native Bridge 默认强制校验 Token。客户端配置中的 Token 必须与本地 `~/.chrome-mcp/bridge-token` 文件中的内容严格一致。

### 解决步骤

1. **查看本地当前正确 Token**：
   ```powershell
   # Windows PowerShell
   Get-Content "$HOME\.chrome-mcp\bridge-token"
   ```
   ```bash
   # macOS / Linux
   cat ~/.chrome-mcp/bridge-token
   ```
2. **更新 Agent 客户端配置**：
   将读取到的 Token 填入客户端的 HTTP headers。系统同时兼容 `x-mcp-token` 与标准的 `Authorization: Bearer <token>` 格式：
   ```json
   {
     "mcpServers": {
       "browserpaw": {
         "url": "http://127.0.0.1:12306/mcp",
         "headers": {
           "x-mcp-token": "粘贴上方读取到的Token",
           "Authorization": "Bearer 粘贴上方读取到的Token"
         }
       }
     }
   }
   ```
3. **自动生成缺失的 Token**：
   若该文件不存在，运行 `node skill/config/doctor.mjs --fix` 将自动生成新的加密 Token。

---

## 4. 交互报错 `ACTION REQUIRED: Please call 'chrome_read_dom' to refresh`

### 故障现象

执行 `chrome_interact_index`、`chrome_fill_index` 或 `chrome_interact_index (action: 'hover')` 时返回：
`ACTION REQUIRED: Element reference is stale. Please call 'chrome_read_dom' to refresh the index tree.`

### 根本原因

现代前端框架（React、Vue、Next.js）在单页路由切换、弹窗动画或异步渲染后重构了 DOM 树，导致上一轮提取的数字索引（如 `[14]`）在当前 DOM 树中已失效（Stale）。

### 规范解决行为

**严禁盲目重试同一失效索引！**
Agent 必须立即调用一次 `chrome_read_dom` 获取最新的 1-based 索引树，基于新索引继续下发动作；或者使用 `chrome_batch_actions` 复合流水线，在多步操作前自动校验元素活性。

---

## 5. Windows 高分屏 (125%/150%/200%) 截图点击坐标偏移

### 故障现象

在纯视觉大模型点击模式下，鼠标点击位置与预期视觉目标发生偏移。

### 底层机制与保障

BrowserPaw 已在 `screenshot.ts` 中实现全链路 **DPR 1:1 几何归一化**（通过 `OffscreenCanvas` 强制重采样为标准 CSS 视口尺寸 $W_{viewport} \times H_{viewport}$）。

### 注意事项

Agent 在计算或下发坐标时，**切勿手动乘以设备像素比（DPR）**！直接根据截图上的物理像素测量值下发坐标即可（底层引擎严格对齐 CSS 像素与 CDP 原生物理事件）。

---

## 6. 原生系统弹窗（Alert / Confirm / Prompt）阻塞

### 故障现象

页面弹出浏览器原生 `alert()`、`confirm()` 或 `prompt()`，导致后续 CDP 指令或脚本挂起。

### 自愈机制

BrowserPaw 内置了瞬态 Dialog 中断捕获。当弹窗出现时，动作会立刻返回带有 `requiresDialogAction: true` 的结构化提示：

```json
{
  "requiresDialogAction": true,
  "dialog": {
    "type": "alert",
    "message": "确定要提交吗？"
  }
}
```

**解决方案**：Agent 随后调用 `chrome_handle_dialog({ action: "accept" })`（或 `"dismiss"`，若为 prompt 可传入 `promptText`）即可平滑解除挂起。

---

## 7. 调用 `chrome_close_tabs` 报需显式确认 (`confirm: true`)

### 故障现象

Agent 调用 `chrome_close_tabs({})` 报错：
`No tabIds or url specified. To close the current active tab, pass confirm: true or specify tabIds explicitly...`

### 防误关保护设计

为防止 AI Agent 在参数缺省时意外关闭人类用户当前正在查看的前台活跃工作标签页，系统强制开启活跃 Tab 确认保护。

### 规范处理

- 若需关闭 Agent 创建的特定标签页，显式传递目标 `tabIds: [tabId]` 或 `url`；
- 若已建立会话亲缘，传递 `sessionId` 即可安全释放绑定的 Agent Tab；
- 若确需关闭当前用户前台活跃 Tab，显式传入 `confirm: true`。

---

## 8. CDP 调试器解挂与连接超时 (`timeout-guard detached`)

### 故障现象

调用 CDP 相关工具报错：`Target closed / not attached / timeout-guard detached`。

### 底层机制

当目标页面崩溃、极度卡死或 CDP 协议响应超过安全阈值时，底层的 `timeout-guard` 守护机制会直接触发物理级快速脱钩（`chrome.debugger.detach`）并清理会话映射与域引用计数，坚决阻止 Service Worker 产生未响应挂起或引用计数下溢死锁。

### 处理方案

刷新目标页面或重新发起工具调用，系统将自动重新建立健康的 CDP 调试会话。

---

## 9. 后台 Tab 离屏截图与隐私隔离

### 核心架构

对于非激活标签页（`active: false`），BrowserPaw 强制采用 CDP `Page.captureScreenshot`（`fromSurface: true`），**严禁使用** Chrome 扩展默认的 `chrome.tabs.captureVisibleTab`。

### 核心收益

1. **彻底消除前台屏幕泄露隐患**：避免后台 Agent 获取到用户当前前台私密屏幕；
2. **消除后台死锁**：彻底消除了非激活标签页因 `requestAnimationFrame` 睡眠冻结导致的死锁。

---

## 10. Stdio 与 HTTP/SSE 模式下的动态 Profile 激活

### 应用场景

在 `core`（14 个核心工具）或 `crawl`（12 个抓取工具）模式下，若任务需要临时调用高级工具（如管理、诊断或网络工具），无需重启 MCP 进程或更改启动环境变量。

### 操作方法

直接调用：

```json
chrome_tool_docs({ "category": "manage", "activateForSession": true })
```

支持类别：`navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, `crawl`。Stdio 与 HTTP/SSE 均原生支持在后续调用中立即使用新开放的工具。

---

## 11. `chrome_javascript` 即席表达式执行

### 使用技巧

执行 JavaScript 时，Agent 无需手动编写 `(function(){ return ... })()`。无论是单表达式如 `document.title`、`window.location.href`，还是包含注释的单个求值表达式，执行器均会自动探测并包装 `return (...)`。对于多行复合逻辑，保持标准 `return` 关键字即可。

---

## 12. 常见工具报错代码与速查表

| 错误特征                                                   | 根本原因                                                | 标准处理方案                                                                        |
| :--------------------------------------------------------- | :------------------------------------------------------ | :---------------------------------------------------------------------------------- |
| `Cannot access a chrome:// URL`                            | Chrome 安全沙箱禁止扩展调试内置系统特权页。             | 跳转至常规 `http://`、`https://` 或 `file://` 网页。                                |
| `executeScript timeout ... renderer not acking`            | Renderer 进程卡死或被原生对话框挂起。                   | 优先调用 `chrome_handle_dialog` 或刷新页面。                                        |
| `CDP_DISPATCH_TIMEOUT`                                     | 目标 Tab 处于后台深度节流状态。                         | 重试调用，或临时将 Tab 切换至前台执行。                                             |
| `Security check failed: Domain changed`                    | 截图后页面发生跨域跳转，坐标失效。                      | 重新调用 `chrome_read_dom` 或 `chrome_take_screenshot` 重新对齐。                   |
| `Tool X is not exposed under the ... profile`              | 当前 profile 隐藏了该工具。                             | 调用 `chrome_tool_docs({ category: "<cat>", activateForSession: true })` 动态激活。 |
| `Tool X is not a BrowserPaw tool`                          | 请求了不存在的工具名。                                  | 查阅 `tools/list`（全量包含 49 个规范工具）。                                       |
| `captureScreenshot returned empty data for background tab` | 后台 Tab 已被关闭或被系统内存冻结 (Discarded)。         | 重新打开或导航至目标页面。                                                          |
| `Failed to ... index [X] in cross-origin frame`            | 跨域子 iframe 已被卸载或受到严格沙箱 sandbox 属性限制。 | 使用 `chrome_read_dom({ filter: "interactive" })` 检查 frame 活性。                 |
| `Message sender rejected / unauthenticated content script` | 扩展安全加固：拦截了非受信渠道的未授权调用。            | 确保请求源自 Native Bridge 合法管道。                                               |

---

## 13. 源码构建故障排查

### 标准构建顺序

若在源码编译过程中遇到 TypeScript 报类型缺失或 `TS7016` 错误：

```bash
# 1. 安装依赖
pnpm install

# 2. shared 包必须最先构建（生成类型声明）
pnpm --filter chrome-mcp-shared build

# 3. 构建全量 monorepo
pnpm build
```

### 单组件构建命令

- **单独构建扩展**：`pnpm --filter @browserpaw/extension build`（产物位于 `app/chrome-extension/.output/chrome-mv3`）
- **单独构建 Native Server**：`pnpm --filter @browserpaw/native-server build`

---

## 14. 日志位置与调试

- **扩展 Service Worker 日志**：
  进入 `chrome://extensions/` → 点击 BrowserPaw 下方的“Service Worker”链接 → 观察带有 `[NativeHost]` 或 `[Screenshot Tool]` 前缀的日志。
- **Native 宿主日志**：
  直接输出至运行进程的控制台终端 stdout/stderr。
- **性能追踪 Trace 文件**：
  通过 `chrome_performance_start` 采集的 trace 文件默认存放于系统临时目录（`os.tmpdir()`），显式传入 `saveToDownloads: true` 时将保存至下载目录。

---

## 15. 组件与文件目录对照

| 组件                   | 源码路径                       | 独立免编译目录 / 运行时端点                             |
| :--------------------- | :----------------------------- | :------------------------------------------------------ |
| **Chrome MV3 扩展**    | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`               |
| **Native Bridge 服务** | `app/native-server/`           | `127.0.0.1:12306` (Token: `~/.chrome-mcp/bridge-token`) |
| **MCP 工具契约定义**   | `packages/shared/src/tools.ts` | 49 个规范 MCP 工具 Schema                               |
| **诊断与自愈配置**     | `skill/config/`                | `doctor.mjs`, `mcp-config.json`, `repair.bat`           |
