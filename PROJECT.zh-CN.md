# BrowserPaw 项目工程规范说明

[English Version](./PROJECT.md)

## 定位与核心设计哲学

BrowserPaw 是一个面向 AI Agent 的 Chrome 浏览器自动化 MCP 服务器。与传统的无头浏览器（Playwright、Puppeteer、Selenium）不同，它直接运行在用户日常使用的 Google Chrome 中，原生复用既有的登录态、Cookie、扩展插件及配置环境。通过 Native Messaging 与 Chrome DevTools Protocol (CDP)，将真实的浏览器控制能力暴露为 50 个严格校验 Schema 的规范 MCP 工具（49 个浏览器端工具 + 1 个本地自主微循环工具）。

## Monorepo 模块架构 (pnpm)

1. **`packages/shared`** (`chrome-mcp-shared`)：
   - **唯一事实源**：集中维护全量 50 个规范 MCP 工具的 Schema（`TOOL_SCHEMAS`）、Profile 分层（`core`: 14, `crawl`: 12, `full`: 50）、`UnifiedLocatorOptions` 统一多态坐标契约以及标准化错误格式化模块。
2. **`app/native-server`** (`mcp-chrome-bridge`)：
   - **Fastify 原生宿主服务**：提供 Stdio 与 HTTP/SSE（默认 `127.0.0.1:12306`）双协议传输、`McpSessionManager` 会话隔离机制（每会话独立 Server 实例，10 分钟空闲自动回收）、`bridge-token` 鉴权、本地自主语义微闭环执行（`chrome_act_toward_goal`）与 Chromium 性能追踪分析。
3. **`app/chrome-extension`** (`chrome-mcp-server`)：
   - **WXT + Vue 3 Manifest V3 扩展**：后台 Service Worker 承载 49 个工具底层执行器与 CDP 会话管理器。内嵌 1:1 物理虚拟光标、标签组自动归整与清理、微光 Favicon；`inpage-engine` 负责在隔离世界中进行 DOM 剪枝与 1-based 动态编号索引。

## 关键架构与工程特性

- **工具面与 Schema 绝对对齐**：运行时 `toolsMap` 完全由 `TOOL_SCHEMAS` 声明推导生成，严禁调用未声明的内部执行器（通过 tool-surface-parity 测试严格锁定）。
- **Profile 分层与动态发现**：内置三大核心 Profile（`core`: 14, `crawl`: 12, `full`: 50）及 8 大工具类别。隐藏工具支持通过 `chrome_tool_docs` 按需动态激活（`activateForSession: true`），在 HTTP/SSE 与 Stdio 下均无需重启服务即可即时生效。
- **自驱 DOM Diff 回传**：交互类工具（`chrome_interact_index`、`chrome_fill_index`、`chrome_batch_actions`）支持 `includeDelta: true`，在动作返回中直接附带局部变动，降低 50% 往返网络消耗。
- **定向秒搜与多 Frame 穿透**：`chrome_grep` 支持多层 iframe 结构穿透与只读检索，匹配文本、`placeholder`、`aria-label` 与 `value`，杜绝大页面全量倾倒 DOM 带来的 Token 浪费。
- **闭环批处理流水线**：`chrome_batch_actions` 在单次网络往返中按序执行点击、输入、等待、断言（`assert`）与字段提取（`extract`），支持跨域 iframe 坐标自动重映射。
- **人机协同与安全撤销**：提供原生 CDP 穿透通道（`chrome_cdp_execute`）、纯 DOM 挂载的毛玻璃接管条（`chrome_request_human_intervention`，彻底免疫 DOM XSS）与 5 步环形栈撤销机制（`chrome_undo_last_action`）。
- **MV3 状态全持久化**：`SessionTabAffinityManager`、`TabGroupManager` 与 `TabFaviconManager` 全面接入 `chrome.storage.session`，抵抗 Service Worker 30 秒休眠回收。
- **CDP 域引用计数与防卡死**：`CDPSessionManager` 精细化管理域级生命周期，核心域常驻，异常与超时由底层 `timeout-guard` 快速触发物理脱钩（`chrome.debugger.detach`）防止死锁。
- **IPC 权限安全边界**：`chrome.runtime.onMessage` 严格拒绝来自 content script（`_sender.tab`）或外部扩展的请求，杜绝网页恶意脚本提权调用工具。
- **视觉离屏零泄露**：截图全链路内存处理零落盘，非激活后台标签页强制走 CDP `Page.captureScreenshot(fromSurface: true)`，彻底杜绝窃取用户前台隐私与 rAF 挂起假死。
- **真人体感与平台兼容**：CDP 原生物理级可信事件（`isTrusted: true`）、`dwellMs` 物理按压时长、macOS Cmd 键位掩码（`mod = 4`）与 `chrome_close_tabs` 活跃 Tab 防误关安全保护。

- **W3C 语义感知与卡片拍平**：`chrome_read_dom` 原生支持 W3C 复合卡片聚合拍平（`flattenCards: true`），将复杂的 `article`、`[role="article"]`、`[role="listitem"]` 等容器折叠为高信噪比实体，并自动剥离 Unicode PUA 伪私有区字体乱码（`[\uE000-\uF8FF]`），彻底解决 Windows GBK 控制台编码崩溃。
- **词元边界表单语义匹配器**：采用两阶段精确与词元边界语义分析，彻底根治如 `phone` 误匹配 `no`、`male` 误匹配 `female` 的子串穿透 Bug。
- **通用零漂移标签组归整**：利用环视断言正则在剥离 CJK 分隔符的同时保护英文连字符专有名词（如 `COVID-19`、`Wi-Fi`），彻底移除特化域名硬编码字典。

- **原子化极速 DOM 快照与感知管线**：`chrome_read_dom` 原生支持极速快照（`fast: true`），单次 `TreeWalker` 遍历结合原生 `checkVisibility` 与 `window.__pawFast` WeakMap 弱引用缓存。严格限制动作 ≤ 250、文本 ≤ 6000 字符，抓取耗时压低至 10~30ms，输出体积 ≤ 15KB。
- **受控组件原生值设置穿透**：通过原型链直接获取原生描述符（`nativeSetter.call(el, val)`）并严格派发 `input` 与 `change` 合成事件序列，彻底穿透 React 16–19 与 Vue 3 受控组件拦截。
- **执行前 1ms 防遮挡绝杀断路器**：在 CDP 物理事件派发前注入页内微任务进行靶心命中校验，支持递归穿透最多 3 层 `pointer-events: none` 浮层，遇遮挡立即熔断返回 `{ "error": "target_occluded", "retry": true }`。
- **基于 rAF 与 ARIA 的智能微等待**：废除粗暴 `sleep`，默认 2 个 `requestAnimationFrame`（≈ 32ms）结合突变监听快速收敛，并为 `role="combobox"` 搜索候选框提供 ≤ 200ms 的选项可见性监听。
- **无特权 HTML5 DataTransfer 文件上传降级**：当 CDP `DOM.setFileInputFiles` 失败或未授权时，自动通过标准 `DataTransfer` 与 `File` 合成对象在前端注入文件，支持穿透深层 Shadow DOM。

- **三层 Jev 自主架构与智能门控**：
  - **Tier 1 (Off 关闭)**：用户在扩展弹窗中关闭 Jev。所有连接的 MCP 会话中 `tools/list` 动态隐藏 `chrome_act_toward_goal`；若 Agent 尝试强制调用，拦截并返回需用户明确授权的结构化提示。
  - **Tier 2 (Local 本地)**：零云端延迟、隐私优先的本地微决策服务（端口 8009，支持 NVIDIA CUDA RTX GPU 硬件加速与 CPU 自动降级）。支持模型热加载、后台服务常驻自愈与多权重管理（`~/.browserpaw/models`）。
  - **Tier 3 (Remote 云端)**：云端 TypeSafe Jev System One 大脑，原生支持自定义 `Base URL` 与 `modelId`，具备磁盘持久化（`~/.browserpaw/jev-remote.json`）与智能排查诊断（遇未配置或失效即刻返回诊断日志与修复指引，杜绝静默假降级）。
  - **即时 MCP 响应通知**：弹窗中的任何模式与模型切换均在 2ms 内触发 `mcpSessionManager.broadcastToolListChanged()`，向所有活跃 MCP 客户端广播工具列表变动。

## 质量门与验证指标

- **扩展 Vitest**：547 项测试在 57 个套件中 100% 通过（含 F1–M3 管线、多层 Deep Shadow DOM 穿透、视觉回退漂移实时补偿、复合卡片拍平与语义词元边界断言）。
- **Native Server Jest**：127 项单元与集成测试 100% 通过（含 Jev 极速决策引擎、启发式打分、更新检查通知器、客户端弹性重试与 Session 管理）。
- **E2E 规范套件**：153 项四层端到端测试 100% 通过。
- **Hermes 插件测试**：8 项 Pytest 100% 通过。
- **TypeScript 类型检查**：全仓库 0 错误（`pnpm typecheck`）。
- **自动化测试总数**：835 / 835 项测试全绿通过。
