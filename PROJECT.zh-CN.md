# BrowserPaw 项目规格与说明

[English](./PROJECT.md)

## 定位与核心理念

BrowserPaw 是一个高性能的模型上下文协议（MCP）服务器，专为 AI Agent 操控用户真实的 Chrome 浏览器而设计。与无头自动化运行时（Playwright、Puppeteer、Selenium）不同，BrowserPaw 直接运行在用户日常使用的 Google Chrome 实例内——保留现有登录会话、Cookie 和扩展生态。它通过 Chrome 原生消息传递（Native Messaging）和 Chrome DevTools Protocol（CDP）把浏览器能力暴露为 50 个经 schema 校验的规范 MCP 工具（49 个扩展/浏览器工具 + 1 个原生循环工具）。

## Monorepo 架构（pnpm）

1. **`packages/shared`**（`chrome-mcp-shared`）：
   - **唯一事实来源**：容纳全部 50 个规范 MCP 工具 schema（`TOOL_SCHEMAS`）、工具配置档（`core`：14，`crawl`：12，`full`：50）、`UnifiedLocatorOptions` 坐标契约和标准化错误格式化器。
2. **`app/native-server`**（`mcp-chrome-bridge`）：
   - **Fastify 原生宿主**：管理双 MCP 传输（Stdio 与 `127.0.0.1:12306` 上的 HTTP/SSE）、`McpSessionManager`（按会话隔离的服务器实例，空闲 10 分钟驱逐）、`bridge-token` 认证、自主语义微循环执行（`chrome_act_toward_goal`）以及 Chromium 性能跟踪分析器。
3. **`app/chrome-extension`**（`chrome-mcp-server`）：
   - **WXT + Vue 3 Manifest V3 扩展**：后台 Service Worker 承载 49 个浏览器工具执行器和 CDP 会话管理。具备 1:1 弹簧运动学虚拟光标覆盖层、零残留清理的自动彩色标签页分组和标签页 favicon 高亮。`inpage-engine` 在隔离世界执行 1 起始的 DOM 剪枝与索引。

## 关键架构原则

- **工具面严格对等**：运行时 `toolsMap` 严格派生自 `TOOL_SCHEMAS`。未经显式 schema 声明，内部辅助执行器不可被直接调用（由工具面对等性测试套件保证）。
- **配置档分层与动态发现**：提供 3 个主配置档（`core`：14，`crawl`：12，`full`：50），横跨 8 个工具类别（`navigate`、`perceive`、`act`、`observe`、`manage`、`diagnose`、`network`、`crawl`）。隐藏工具可通过 `chrome_tool_docs` 查看，并在 HTTP 与 Stdio 两种传输下按需动态激活（`activateForSession: true`），无需重启进程。
- **自主 DOM 差异搭车**：交互类工具（`chrome_interact_index`、`chrome_fill_index`、`chrome_batch_actions`）支持 `includeDelta: true`，在动作响应中直接返回局部元素变更，省去 50% 的往返检查开销。
- **定向 Grep 优化**：`chrome_grep` 支持多 frame 分层重映射，并可匹配文本、`placeholder`、`aria-label` 和 `value`。它提供三种不同的搜索模式（交互元素、完整 DOM、纯文本），杜绝动辄数千 Token 的完整 DOM 倾倒。
- **闭环动作流水线**：`chrome_batch_actions` 在单次网络往返内串联离散的点击、填写、等待、断言（`assert`）和字段提取（`extract`），支持跨源 iframe 坐标换算。
- **人机回环与撤销安全**：结合原始 CDP 穿透（`chrome_cdp_execute`）、安全的原生 DOM 毛玻璃接管横幅（`chrome_request_human_intervention`，完全免疫 DOM XSS）和 5 步循环栈撤销机制（`chrome_undo_last_action`）。
- **MV3 会话状态持久化**：`SessionTabAffinityManager`、`TabGroupManager` 和 `TabFaviconManager` 把状态持久化到 `chrome.storage.session`，以承受 Chrome Service Worker 30 秒空闲终止与重启。
- **CDP 域引用计数**：`CDPSessionManager` 跟踪域级引用（`enableDomain` / `disableDomain`），保持核心域活跃，同时由底层超时守卫触发物理分离（`chrome.debugger.detach`）以防止死锁。
- **安全与权限边界**：`chrome.runtime.onMessage` 严格拒绝来自网页内容脚本（`_sender.tab`）或外部扩展的消息，阻断未授权的工具派发。
- **无盘视觉流水线**：截图数据完全保留在内存中。非活动的后台标签页严格派发离屏 CDP `Page.captureScreenshot(fromSurface: true)`，避免前台屏幕泄漏和 `requestAnimationFrame` 冻结死锁。
- **人体运动学与平台对齐**：派发原生 CDP `Input` 事件（`isTrusted: true`）、可配置的 `dwellMs` 按压时长、macOS Command 键对齐（`mod = 4`），以及 `chrome_close_tabs` 的显式确认保护（`confirm: true`）。

- **W3C 语义感知与卡片扁平化**：`chrome_read_dom` 原生支持 W3C 复合卡片扁平化（`flattenCards: true`），把复杂的 `article`、`[role="article"]`、`[role="listitem"]` 容器折叠为原子实体，同时剔除 PUA Unicode 图标字形（`[\uE000-\uF8FF]`）以防终端编码崩溃。
- **Token 边界表单语义匹配器**：表单字段通过两阶段离散的精确与 token 边界语义分析来解析，消除子串误匹配（例如 `phone` 与 `no`、`male` 与 `female`）。
- **通用零漂移标签页分组**：与域名无关的标题清洗通过环视正则保留英文连字符词（`COVID-19`、`Wi-Fi`），无需域名词典即可正确组织标签页。

- **原子级快速 DOM 快照与感知流水线**：`chrome_read_dom` 原生支持超快原子快照（`fast: true`），单遍 `TreeWalker` 遍历，配合原生 `checkVisibility` 和 `window.__pawFast` WeakMap 缓存。载荷预算限制在 ≤ 250 个动作、≤ 6000 字符，把扫描延迟压缩到 10~30ms。
- **受控组件原生取值器**：直接调用原型描述符，随后触发标准合成 `input` 与 `change` 事件序列，绕过 React 16–19 和 Vue 3 的受控输入拦截。
- **CDP 前置 1ms 遮挡熔断**：通过页内微任务命中测试预校验点击目标，最多穿透 3 层 `pointer-events: none`，失败即快速返回 `{ "error": "target_occluded", "retry": true }`。
- **rAF 与 ARIA Combobox 智能微等待**：以 2 帧 `requestAnimationFrame`（约 32ms）收敛和自动补全 combobox 专用选项发现看门狗（≤ 200ms）消除盲目休眠。
- **HTML5 DataTransfer 上传兜底**：当 CDP 调试器无法附加时，优雅回退到跨 Shadow DOM 边界的浏览器原生 `DataTransfer` 文件合成。

- **三层 Jev 自主架构与智能门控**：
  - **第 1 层（Off）**：在扩展弹窗中禁用自主语义循环。`chrome_act_toward_goal` 从所有已连接的 MCP 会话的 `tools/list` 中动态隐藏。若 Agent 尝试直接调用，请求会被拦截并给出需要用户确认的显式授权提示。
  - **第 2 层（Local）**：零云端延迟、隐私优先的本地决策服务，运行在 8009 端口（支持 CUDA RTX GPU 加速和 CPU 回退）。具备自动热加载、常驻后台和权重管理（`~/.browserpaw/models`）。
  - **第 3 层（Remote）**：云端 TypeSafe Jev System One 模型，支持自定义 `Base URL` 和 `modelId`、磁盘持久化（`~/.browserpaw/jev-remote.json`）以及智能错误诊断（返回诊断与修复反馈，而非静默回退到启发式）。
  - **实时 MCP 反应性**：弹窗中的模式与配置切换会立即触发 `mcpSessionManager.broadcastToolListChanged()`，覆盖所有活跃的 SSE 与 stdio 会话。

## 质量门与验证矩阵

> **权威质量契约：**
> 所有工程验证、质量门和交付标准均由 [**`docs/QUALITY.md`**](docs/QUALITY.md) 统一治理。
> 官方静态验证套件为 `pnpm verify`。部署通过 `pnpm build:deploy` 执行，并通过 `pnpm verify:delivery` 校验。

- **Chrome 扩展 Vitest**：`app/chrome-extension/tests/` 下的全部测试，包括 DOM 快照、输入、截图、控制台捕获和撤销。
- **原生服务器 Jest**：`app/native-server` 中的全部单元与集成套件，包括 Jev 决策、客户端韧性、协议处理和会话管理器。
- **模拟端到端套件**：构建后执行的四层测试（`pnpm test:e2e`）。这些测试不构成真实 Chrome 验收。
- **插件集成**：`plugins/browserpaw/tests/` 中的 Pytest 用例；仅可选 Hermes 宿主集成在宿主不可用时可跳过。
- **TypeScript 检查**：全部 monorepo 包（`pnpm typecheck`）。

`.artifacts/verification/latest.json` 中最近一次 `pnpm verify` 报告记录了该源码指纹下实测的测试数量、跳过数和通过/失败状态。

### 关键技术不变量与运行语义

- **键盘组合键**：`chrome_keyboard` 支持复合组合键和规范化键名，包括 `plus`（`+`）、`comma`（`,`）以及顺序别名。
- **DOM 感知与变更边界**：`chrome_read_dom` 默认严格只读（`dismissOverlays: false`）。传入 `dismissOverlays: true` 会主动点击模态框，属于变更性副作用。
- **端口解析优先级**：原生守护进程、瘦 CLI（`bin/browserpaw.cjs`）、DSH 插件和仅 HTTP 客户端统一按 `CHROME_MCP_PORT` > `MCP_HTTP_PORT` > 默认 `12306`（1-65535）求值。对守护进程而言，扩展显式发送的 `START` 消息端口仍然优先。
- **扩展自动同步**：设置 `BROWSERPAW_EXTENSION_SYNC_DIR` 会在构建期间把解压扩展构建复制到目标浏览器配置目录。
- **浏览器兼容性**：生产目标是 Google Chrome 及兼容的 Chromium 浏览器。Edge 和 Brave 未独立测试。
