# BrowserPaw 核心链路能力报告 (2026-09)

> 基于工作区当前源码与最新未提交变更实时审计。全面覆盖操控链路数据流、新增关键机制设计、性能稳定性边界与使用最佳实践。

---

## 1. 浏览器操控链路当前真实数据流

BrowserPaw 的操控链路贯通了客户端 Agent、Node Native Server、Chrome MV3 Background、CDP 协议以及 Content Script / 页面注入上下文。

```
[Agent] (Claude/Codex)
   │ MCP stdio / Streamable HTTP SSE (/mcp)
   ▼
[native-server] (app/native-server)
   │ 协议校验 (1MB 限制、15s/20s 超时)、Jev 微决策辅助、分发至本地 Chrome 扩展
   │ Chrome Native Messaging (stdin/stdout + 4字节小端序长度头)
   ▼
[Extension Background] (app/chrome-extension/entrypoints/background/native-host.ts)
   │ 工具分发 (BaseBrowserToolExecutor)
   │ ┌────────────────────────────────────────────────────────┐
   │ │ Session Tab Affinity (utils/session-tab-affinity.ts)    │
   │ │ - 基于 sessionId 绑定 tab，防止多 agent 互抢焦点         │
   │ │ - runSerialized(tabId) 保证同标签页单任务严格串行化       │
   │ │ - 监听 tab 衍生 (target="_blank", window.open) 自动顺延 │
   │ └────────────────────────────────────────────────────────┘
   ├── Fast Path (原生 CDP 物理调度: raceCdp / cdpSessionManager)
   │    │ 10-30ms 原生级 Input.dispatchMouseEvent / dispatchKeyEvent / insertText
   │    │ 真实事件 (isTrusted: true)，带虚拟贝塞尔曲线轨迹与点击动画
   │    └─► Chromium 渲染管线
   └── Slow Path (页面注入脚本引擎: in-page-engine.ts)
        │ 首次注入 100KB inpage-engine.js (缓存于 injectedTabs Set，免重复注入)
        │ 单轮同步直出 (1 RTT) / 异步轮询槽位 (__MCP_CALL_*)
        │ 负责 DOM 剪枝遍历、输入回退、样式判定与复杂校验
        └─► DOM / Shadow DOM 树
   │
   ▼ Action Watchdog (utils/action-watchdog.ts)
   ├── waitForNetworkQuiescence (基于 CDP Network 在飞请求，滑动窗口静默)
   ├── inPageWaitForDOMSettle (2-rAF 微等待 ≈32ms + Combobox 候选监听 + MutationObserver)
   ▼ 返回结构化 ToolResult (含 URL、变化 Delta、快照及异常自愈引导)
```

### 架构要点深度解析

1. **Fast Path 与 Slow Path 双轨调度**：
   - **感知链路**：Fast Path 走 [fast-snapshot.ts:133](/app/chrome-extension/entrypoints/background/tools/browser/fast-snapshot.ts:133)（单 pass TreeWalker，WeakMap 缓存计算样式与包围盒，10-30ms 直出 <=15KB 精简快照）；Slow Path 走 [read-dom.ts:121](/app/chrome-extension/entrypoints/background/tools/browser/read-dom.ts:121) 全量 `inPageDOMPruner`（支持多 frame 穿透 `allFrames: true`、卡片语义压缩 `flattenCards`、长列表虚拟化折叠 `virtualizeViewport` 与弹窗隔离 `isolateModal`）。
   - **交互链路**：Fast Path 优先走 CDP 原生指令，生成 `isTrusted: true` 真实物理事件，穿透现代前端框架的合成事件拦截；Slow Path 在 CDP 坐标异常或非视口元素时回退到 [in-page-engine.ts:80](/app/chrome-extension/entrypoints/background/tools/browser/in-page-engine.ts:80) 派发合成事件。
2. **DOM-First + Visual-Fallback 双引擎**：
   - 首先通过 DOM 1-based 索引定位元素及其由 9 点网格遮挡检测确认的 `safeClickPoint` ([dom-indexer.ts:49](/app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts:49))。
   - 当 DOM 发生重绘、遮挡或索引漂移时，通过 [unified-locator.ts](/app/chrome-extension/entrypoints/background/tools/browser/unified-locator.ts) 回退到选择器重定位（`selector_drift_recovery`）或通过像素坐标直接点击。
3. **Tab 亲和与生命周期隔离 (Session Tab Affinity)**：
   - [session-tab-affinity.ts:35](/app/chrome-extension/utils/session-tab-affinity.ts:35) 将客户端 `sessionId` 与目标 `tabId` 双向绑定，持久化存储于 `chrome.storage.session`。
   - `runSerialized(tabId)` 提供标签页级操作锁，杜绝并发指令交错破坏页面状态。
   - 自动子标签页顺延：当点击触发新标签页创建时，[startHandoverTracking:198](/app/chrome-extension/utils/session-tab-affinity.ts:198) 挂起追踪并在新标签页激活后自动平滑转移 `sessionId` 绑定，避免 Agent 停留在父标签页打转。
4. **Action Watchdog 智能看门狗**：
   - [action-watchdog.ts:24](/app/chrome-extension/utils/action-watchdog.ts:24) 实现页面自适应静默。通过 CDP Network 域捕获真实在飞网络请求（`hasInFlightRequests`），在飞请求归零并维持滑动窗口（默认 120ms）后才触发 DOM 稳定，避免在接口尚未返回前过早返回错误 DOM。

---

## 2. 本轮新增机制的职责与设计意图

| 机制模块                                                                                                                              | 核心职责与解决的痛点                                                                                                                                                                                                                                              | 输入参数 / 触发场景                                                                                                   | 输出内容 / 结果形态                                                                                                        |
| :------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **`fast-snapshot.ts`**<br>[fast-snapshot.ts:133](/app/chrome-extension/entrypoints/background/tools/browser/fast-snapshot.ts:133)     | **极速原子级 DOM 感知**。<br>传统 read-dom 耗时高 (200-800ms) 且 payload 巨大 (30-100KB) 严重消耗上下文。<br>单 pass TreeWalker + WeakMap 缓存，将感知压缩至 10-30ms、<=15KB，提取核心交互节点并自动挂载 `window.__pawFast`。                                     | `legacyVisibility?: boolean`<br>由 `chrome_read_dom(fast: true)` 触发。                                               | `FastSnapshotResult`：视口宽高、滚动高度、最多 6000 字符文本、<=250 个操作点 (`e1..eN`)、操作语义 (`guards`, `page_key`)。 |
| **`fill-core.ts`**<br>[fill-core.ts:74](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:74)                   | **统一工业级物理键入核心**。<br>收敛 `fill-index`、`batch-actions`、`form-pipeline` 的键入逻辑，解决 React/Vue/Draft.js 受控组件吃字、换行丢失、异步提交无响应。<br>集成 Deep Reset、Active Element 焦点校验、True Input Commitment、逐键按压回退及单轮自动提交。 | `PhysicalFillOptions`：`tabId`, `target` (index/ref/selector), `text`, `clear`, `pressEnter`, `submit`, `sessionId`。 | `PhysicalFillResult`：`success`, `committed`, `method` (`cdp_native`                                                       | `cdp_key_by_key` | `synthetic_inpage`), `isTrusted`, `tabHandover`, `submitResult`。                    |
| **`form-pipeline.ts`**<br>[form-pipeline.ts:68](/app/chrome-extension/entrypoints/background/tools/browser/form-pipeline.ts:68)       | **多步/向导式表单本地流水线**。<br>解决复杂表单填写往返 MCP RTT 过多的网络开销。<br>在扩展端本地执行多步循环（最多 20 步），结合 CAPTCHA 检测、校验错误阻断、连续未推进保护及自动推进下一步。                                                                     | `FormPipelineParams`：`fields: [{query, value, type}]`, `maxSteps`, `autoAdvance`, `sessionId`。                      | 结构化进度：`status` (`completed`                                                                                          | `partial`        | `interrupted`), `reason`, `completedFields`, `remainingFields`, `interruptDetails`。 |
| **`form-semantic-matcher.ts`**<br>[form-semantic-matcher.ts:175](/app/chrome-extension/utils/form-semantic-matcher.ts:175)            | **三级梯次表单字段与选项匹配器**。<br>解决表单题目与输入控件语义不对齐、中英文同义词混淆、选项模糊匹配问题。<br>三级降级：Tier 1 字面/全词精确匹配 → Tier 2 Jev System One 神经决策 → Tier 3 启发式分词与双字 CJK Bigram Jaccard 重叠度计算。                     | `matchSemantically(type, query, candidates, value)`。                                                                 | `MatchResult`：`matchedId`, `confidence`, `engine` (`literal`                                                              | `jev`            | `heuristic`) 或 `null`。                                                             |
| **`dismiss-overlay.ts`**<br>[dismiss-overlay.ts:25](/app/chrome-extension/entrypoints/background/tools/browser/dismiss-overlay.ts:25) | **全屏营销弹窗与蒙层一键闭合**。<br>解决电商/内容站点弹窗遮挡元素导致点击被吞或报错 target_occluded。<br>候选选择器与高 z-index (>=1000) 深度遍历（支持 Shadow DOM），严格排除密码登录框，多维打分寻找关闭按钮，经 CDP 物理派发点击闭合。                         | `tabId`, `maxOverlays` (默认 5), `waitForSettle`, `settleTimeoutMs` (默认 800ms)。                                    | `{ success, dismissedCount, overlays: [{ action, x, y, isTrusted }], message }`。                                          |
| **`version-checker.ts`**<br>[version.ts:430](/packages/shared/src/version.ts:430)                                                     | **无感知非阻塞版本检测与通知**。<br>解决用户长期运行旧版本导致协议脱节的问题。<br>GitHub Releases API + ETag / 304 缓存 + 1h 滑动 TTL + 24h 最大窗口；严格限流兜底；**严格限制仅在 Agent 会话首次调用 MCP 工具时通知**，绝不重复刷屏。                            | Native Server 启动及 Agent 首次 MCP 请求激活。                                                                        | 首次请求成功注入 `[System Notice: A new version of BrowserPaw is available (...)]`；无更新或后续调用输出 `null`。          |

---

## 3. 性能与稳定性设计 (关键数值与文件行号)

### 3.1 CDP 会话管理与竞态防护

- **10 分钟会话空闲保持 (防止 Infobar 闪烁与视口跳变)**：[cdp-session-manager.ts:25](/app/chrome-extension/utils/cdp-session-manager.ts:25) 定义 `CDP_IDLE_DETACH_TIMEOUT_MS = 600000` (10 分钟)。引用计数归零后保持连接，避免连续工具调用频繁 attach/detach 导致浏览器顶部横幅闪烁。
- **CDP 会话防死锁队列**：[cdp-session-manager.ts:208](/app/chrome-extension/utils/cdp-session-manager.ts:208) `serializeTabOp` 引入 4000ms 超时打断前置挂死 promise，保证新操作不被前序异常永久阻塞。
- **CDP 单指令硬超时**：[cdp-session-manager.ts:147](/app/chrome-extension/utils/cdp-session-manager.ts:147) `sendDebuggerCommand` 设置默认 `timeoutMs = 20000` (20 秒)，超时附带当前挂起对话框信息。
- **核心域保护与常驻**：[cdp-session-manager.ts:337](/app/chrome-extension/utils/cdp-session-manager.ts:337) `Page` 与 `Network` 域为基础设施，会话存活期间即使业务域 `disable` 也绝不物理断开，保证请求监听不中断。
- **CDP 竞态与对话框瞬断防护**：[race-cdp.ts:44](/app/chrome-extension/utils/race-cdp.ts:44) `raceCdp` 默认 3000ms 竞态超时；同时注册 `Page.javascriptDialogOpening` 监听器，一旦原生弹窗弹出立即中断并抛出 `DialogOpenedError`，杜绝渲染器无响应死锁。

### 3.2 页面静默与请求看门狗 (Watchdog)

- **DOM 稳定观察超时**：[action-watchdog.ts:204-206](/app/chrome-extension/utils/action-watchdog.ts:204) `timeoutMs` 默认 1500ms（区间 200ms-10000ms），`quietPeriodMs` 默认 100ms（区间 35ms-2000ms），自适应静默 `adaptiveMs` 为 30ms。
- **Combobox 下拉候选微等待**：[action-watchdog.ts:108,144](/app/chrome-extension/utils/action-watchdog.ts:108) 候选选项出现时上限截断为 200ms；常规点击则等待 2 帧 rAF (约 32ms) 触发微渲染周期。
- **在飞网络请求全量静默**：[action-watchdog.ts:257-260](/app/chrome-extension/utils/action-watchdog.ts:257) `waitForNetworkQuiescence` 最大等待 2000ms，轮询间隔 25ms，滑动无请求窗口需维持 120ms，初始宽限 60ms。在飞请求超时阈值为 5000ms 自动淘汰 ([cdp-session-manager.ts:124](/app/chrome-extension/utils/cdp-session-manager.ts:124))。

### 3.3 页面注入脚本引擎 (In-Page Engine)

- **注入超时拦截**：[in-page-engine.ts:21,62](/app/chrome-extension/entrypoints/background/tools/browser/in-page-engine.ts:21) `EXECUTE_TIMEOUT_MS = 4000` (4 秒)，防止页面假死导致注入挂起。
- **异步轮询步长与上限**：[in-page-engine.ts:204-209](/app/chrome-extension/entrypoints/background/tools/browser/in-page-engine.ts:204) 异步结果槽位轮询间隔 25ms，最大轮询时间 15000ms。
- **单轮同步直出 (0-RTT 优化)**：[in-page-engine.ts:133](/app/chrome-extension/entrypoints/background/tools/browser/in-page-engine.ts:133) 同步脚本直接在 `func` 返回时回传结果，无需走第二轮轮询拉取。

### 3.4 物理输入与提交防护 (Fill-Core)

- **输入聚焦严格断言**：[fill-core.ts:536](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:536) 真实点击后必须通过 `inPageVerifyActiveElement` 检验 `document.activeElement`，校验失败抛出 `FocusVerificationError`，防止输入污染非预期组件。
- **输入落盘校验与逐键重试**：[fill-core.ts:614,640](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:614) `insertText` 后等待 40ms 微任务响应并校验；若 React/Vue 受控状态未提交，等待 60ms 后自动触发 `cdp_key_by_key`（字符间隔 8ms，[line 666](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:666)），彻底击穿框架拦截。
- **单轮自动提交超时兜底**：[fill-core.ts:996](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:996) 自动提交点击超时设定为 4000ms 竞态兜底，避免提交按钮触发的同步跳转挂死工具调用。

### 3.5 版本更新检查缓存

- **滑动缓存窗口**：[version.ts:16-17](/packages/shared/src/version.ts:16) 缓存滑动 TTL 1 小时 (`DEFAULT_CACHE_TTL_MS = 3600000`)，最大绝对滑动窗口 24 小时；网络检查超时 3000ms ([line 279](/packages/shared/src/version.ts:279))；遇到 403/429 限流时退避缓存 5 分钟 ([line 360](/packages/shared/src/version.ts:360))。

---

## 4. Skill 文档使用者"最佳实践与禁区"

### 4.1 核心最佳实践 (Best Practices)

1. **感知优先走 `fast: true`**：
   - 进行常规状态检查、寻找可操作元素、点击前探测时，优先调用 `chrome_read_dom(fast: true)`。仅在需要分析富文本布局、提取页面卡片集合或处理多层 iframe 嵌合时，才使用常规 `read_dom`。
2. **表单填写优先使用 `chrome_fill_index` / `chrome_form_pipeline`**：
   - 严禁使用过时的已删除工具 `chrome_fill_form`。普通单字段输入直接用 `chrome_fill_index`（自带受控组件 Deep Reset 和 True Input Commitment）；多步骤表单、问卷向导优先使用 `chrome_form_pipeline`，由扩展端本地循环消化每一步，极大节约上下文与网络开销。
3. **复合动作合并走 `chrome_batch_actions`**：
   - 对于连续的“点击输入框 → 输入内容 → 按回车”或多字段录入，使用 `chrome_batch_actions` 合并下发，享受标签页串行锁保护并减少 MCP 轮询 RTT。
4. **遇弹窗阻断主动使用 `chrome_dismiss_overlay`**：
   - 进入电商、论坛等高频弹窗站点，在遇到 `target_occluded` 报错或页面无法交互时，第一时间调用 `chrome_dismiss_overlay` 清理营销层，再重刷 DOM。
5. **全程显式携带 `sessionId`**：
   - 每一个需要与浏览器打交道的工具调用都应当传递 `sessionId`，以此激活会话亲和（Tab Affinity）并保证在点击打开新标签页时，会话焦点能够自动且精准地平滑顺延。

### 4.2 致命操作禁区 (Red Lines & Pitfalls)

1. **禁区 1：无视 `requiresDialogAction: true` 强行继续执行**：
   - 当工具返回 `requiresDialogAction: true` 时，说明浏览器已弹出原生模态框（`alert` / `confirm` / `prompt` / `beforeunload`），渲染管线处于冻结状态。此时**严禁**再调用任何 CDP 或 DOM 脚本，**必须立即调用 `chrome_handle_dialog(action: 'accept'|'dismiss')`** 解除冻结，否则后续调用必死锁超时。
2. **禁区 2：跨动作复用陈旧的 DOM Index**：
   - 任何触发页面导航、弹窗关闭、异步数据加载、或 DOM 结构变更的操作之后，之前的 1-based 元素索引立即失效。**严禁臆测索引不变**，必须重新调用 `chrome_read_dom` 获取最新的权威索引。
3. **禁区 3：在网络活跃状态下抢跑断言或截图**：
   - 异步提交表单或点击搜索后，不要立即触发截图或宣称完成。应开启 `waitForSettle: true` 或 `waitForNetworkQuiescence: true`，让看门狗确认在飞网络请求归零后再拉取结果。
4. **禁区 4：强行自动化不可逾越的人机安全防御**：
   - 遇到滑动拼图、极验验证码、短信两步验证、人脸识别或支付密码输入时，**严禁使用无限循环点击或盲目重试对抗**。必须主动调用 `chrome_request_human_intervention` 唤起半透明毛玻璃悬浮提示并挂起等待真实用户处理，超时或完成后再行推进。
