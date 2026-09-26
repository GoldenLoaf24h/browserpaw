# Jev 双层决策系统与 MCP 桥接架构审查报告

> 审查基准：当前工作区未提交改动（基于 HEAD `9a0486b`，73 文件变更，含 fast-snapshot、fill-core、form-semantic-matcher 等最新机制）。

---

## 1. Jev 双层架构与决策点全景分析

### 1.1 Jev 的定义与定位

Jev 在 BrowserPaw 中定位为 **System 1（快思考 / 语义微循环）**，基于 `@typesafe-ai/sdk` 的 TypeSafe Jev System One 概率推理引擎。它将浏览器轻量级感知（压缩 AX 树）、动作决策与单步执行移入本地 Native Server，单步延时压至 200~400ms，大幅减少远程 Macro Planner（主 LLM / System 2）的往返 RTT 与 Token 开销。

### 1.2 实际调用决策点清单（文件与精确行号）

Jev 在当前代码库中存在 **三大实际调用分支**：

1. **`chrome_act_toward_goal` 本地微循环主流程**
   - **分发挂载点**：[register-tools.ts:191](app/native-server/src/mcp/register-tools.ts:191)。Native Server 接收到 `chrome_act_toward_goal` 后直接交由 `FastDecisionEngine.run()` 在本地驱动，不将循环状态交由远程往返。
   - **感知输入组装与预算控制**：[fast-decision-engine.ts:231](app/native-server/src/jev/fast-decision-engine.ts:231) 调用 [jev-client.ts:80-120](app/native-server/src/jev/jev-client.ts:80) `buildState()`，将 DOM 严格限制在 <= 250 行、每行 <= 120 字符、总字符 <= 24,000，并自动剔除密码及文件输入等敏感控件（[jev-client.ts:60-70](app/native-server/src/jev/jev-client.ts:60) `isSensitiveElement()`）。
   - **完成状态判断（Goal Done）**：[fast-decision-engine.ts:262-273](app/native-server/src/jev/fast-decision-engine.ts:262)。评估 `answers.goal_done.noul >= 0.85`，达成直接返回 `status: "done"`。
   - **死循环与停滞判定（Stuck Detection）**：[fast-decision-engine.ts:276-288](app/native-server/src/jev/fast-decision-engine.ts:276)。评估 `answers.stuck.noul >= 0.85` 或规则层连续无 DOM/URL 变更，返回 `status: "stuck"`。
   - **不可逆/破坏性拦截（Destructive Guard）**：[fast-decision-engine.ts:291-304](app/native-server/src/jev/fast-decision-engine.ts:291)。评估 `answers.destructive.noul >= 0.50` 或目标元素命中 14 个高危动作词（[jev-client.ts:17-32](app/native-server/src/jev/jev-client.ts:17) `DESTRUCTIVE_KEYWORDS`），立即熔断并升级 `status: "escalate"`。
   - **下一步动作路由（Action Choice）**：[fast-decision-engine.ts:307-353](app/native-server/src/jev/fast-decision-engine.ts:307)。由 `answers.action` 在 `click | type | select | scroll_down | scroll_up | back | wait | done | escalate` 中做选择，并经 `validateChoice()` 校验；置信度低于 `confidenceThreshold`（默认 0.55）直接 escalate。
   - **目标元素匹配（Target Choice）**：[fast-decision-engine.ts:380-445](app/native-server/src/jev/fast-decision-engine.ts:380)。按 action 分流由 `click_target`、`type_target` 或 `select_target` 决出元素序号，且必须满足 `targetConf >= 0.45 && topProb >= 0.35` 且非 `none`，否则判定歧义并升级。
   - **安全断点拦截（Pause Before Keywords）**：[fast-decision-engine.ts:448-477](app/native-server/src/jev/fast-decision-engine.ts:448)。若匹配入参 `pauseBeforeKeywords`，提前挂起返回 `status: "paused"`。
   - **文本抽取（Payload Extraction）**：[fast-decision-engine.ts:655-667](app/native-server/src/jev/fast-decision-engine.ts:655) 及 [jev-client.ts:200-240](app/native-server/src/jev/jev-client.ts:200)。无需额外 Mini-LLM，通过正则/引号/提示词纯确定性提取。
   - **下拉框选项两阶段裁决（Two-stage Select）**：[fast-decision-engine.ts:722-738](app/native-server/src/jev/fast-decision-engine.ts:722)。调用 `this.jevClient.scoreOptions()` 使用 Jev `score()` 打分，置信度 < 0.40 则 escalate。

2. **表单流水线语义匹配（Form Pipeline Semantic Matcher）**
   - **扩展端发起点**：[form-pipeline.ts:154-198](app/chrome-extension/entrypoints/background/tools/browser/form-pipeline.ts:154) 借助 `matchSemantically()` 解决复杂表单中问题文本与字段标签、输入框占位符的跨语言模糊映射。
   - **混合匹配器分层**：[form-semantic-matcher.ts:172-235](app/chrome-extension/utils/form-semantic-matcher.ts:172)。Tier 1 字符全字匹配 -> Tier 2 Native Jev 匹配 -> Tier 3 同义词与 CJK Bigram 规则。
   - **原生消息通道桥接**：[native-host.ts:392-430](app/chrome-extension/entrypoints/background/native-host.ts:392) `sendJevMatchToNative()` 发送 `jev_semantic_match` 请求；[native-messaging-host.ts:158, 226-298](app/native-server/src/native-messaging-host.ts:158) 由 NativeHost 实例化 `JevClientWrapper` 执行单次 `matched_target` 选择。

### 1.3 FastDecisionEngine 与 HeuristicEngine 的分工与降级阶梯

- **分工矩阵**：
  - `FastDecisionEngine`（[fast-decision-engine.ts:66](app/native-server/src/jev/fast-decision-engine.ts:66)）为**调度总控**，管理多步循环、步数预算、超时控制、真实 CDP 动作调用及进展广播。
  - `HeuristicEngine`（[heuristic-engine.ts:118](app/native-server/src/jev/heuristic-engine.ts:118)）为**纯确定性规则引擎**（约 330 行，零外部依赖）。通过 `tokenizeGoal()`（支持 CJK 字符双元分词与停用词过滤）、意图识别权重（`wantsType/wantsClick/wantsSelect` 等加权）、角色评分算法输出候选与打分。
- **置信度阈值**：
  - Jev 模式：Action >= 0.55，Target Confidence >= 0.45，Top Probability >= 0.35，Goal Done >= 0.85，Destructive 熔断阈值 >= 0.50。
  - Heuristic 模式：综合匹配分 >= 0.30；Goal Done 要求目标关键词覆盖率 >= 80%。
- **三级降级机制（Fallback）**：
  1. **无密钥 / 401 鉴权失效**：未配置 `JEV_API_KEY` 或 API 报 401，立即触发锁存器 `latchInvalidKey()`（5 分钟内静默屏蔽 Jev 请求，[jev-client.ts:35-50](app/native-server/src/jev/jev-client.ts:35)），无缝降级为 Heuristic 模式。
  2. **限流 429 / 网络超时断开**：`query()` 捕获并返回 `quota_exhausted` / `network_error`（[jev-client.ts:380-410](app/native-server/src/jev/jev-client.ts:380)），当前循环无缝切入 Heuristic，同时将最大步数强制收缩为 <= 5 步（防失控）。
  3. **规则引擎无法决策 / 产生歧义**：Heuristic 结果置信度不达标、目标为 `none` 或检测到卡顿时，直接产出 `status: "escalate"` 携带当前快照交还主 LLM。

### 1.4 双层架构真实形态

当前 BrowserPaw 并非“由单一模型接管浏览器”，而是**分层共治**：

- **System 2（主 Agent）**：掌控业务理解、跨标签页调度、多任务规划、复杂验证码决断、文件落盘与最终交付。
- **System 1（Jev 微循环）**：在单页面内承接原子目标（如“在搜索框输入关键词并回车”或“展开并选择国家为中国”），在毫秒级闭环中感知并执行；遇到分支破坏性操作或不确定性，立即上抛给 System 2。

---

## 2. MCP 桥协议接入契约（Agent 集成者核心须知）

### 2.1 入口双模：Stdio 与 HTTP

- **Stdio 入口**：
  - 入口文件：`app/native-server/dist/mcp/mcp-server-stdio.js`（源码 [mcp-server-stdio.ts:1](app/native-server/src/mcp/mcp-server-stdio.ts:1)）。
  - 工作原理：作为前端代理进程，通过标准 IO 与外部 Agent（如 Claude Desktop / Codex CLI）通信；内部启动 `StreamableHTTPClientTransport` 通过 HTTP 反向代理连接本地 12306 服务（[mcp-server-stdio.ts:80-92](app/native-server/src/mcp/mcp-server-stdio.ts:80)）。
- **HTTP / SSE 入口**：
  - 监听配置：默认 `127.0.0.1:12306`（[constant/index.ts:18](app/native-server/src/constant/index.ts:18)），可通过环境变量 `CHROME_MCP_PORT` 调整。
  - 标准 MCP 传输点：`POST /mcp`、`GET /mcp`（流式 SSE）、`DELETE /mcp`（[server/index.ts:394-475](app/native-server/src/server/index.ts:394)）及遗留 `/sse`、`/messages` 端点。

### 2.2 会话握手与保持契约（`mcp-session-id`）

1. **Initialize 握手**：
   - 首次连接调用 `POST /mcp`，Payload 必须为 MCP `initialize` 结构，请求头无需带 `mcp-session-id`。
   - 服务端分配 `randomUUID()`，初始化 `StreamableHTTPServerTransport`，并在响应头与传输体中确立 Session（[server/index.ts:405-412](app/native-server/src/server/index.ts:405)）。
2. **会话保持规则**：
   - 后续所有 `tools/call`、`tools/list` 必须在 HTTP Headers 中附带 `mcp-session-id: <session-uuid>`。
   - 若缺失 header 或会话过期，服务拦截并以 400/404 拒绝，提示重新握手（[server/index.ts:413-424](app/native-server/src/server/index.ts:413)）。
   - 客户端退出时应调用 `DELETE /mcp` 显式销毁会话资源（[server/index.ts:457](app/native-server/src/server/index.ts:457)）。

### 2.3 Token 鉴权机制（Timing-Safe）

- **鉴权范围**：Fastify 全局 `preHandler` 拦截除 `OPTIONS`、`/ping`、`/media-asset/*` 以外的所有请求（[server/index.ts:133-157](app/native-server/src/server/index.ts:133)）。
- **凭证传递**：支持 `Authorization: Bearer <token>`、`X-MCP-Token: <token>` 或 Query 参数 `?token=<token>`。
- **Token 产生与持久化**（[token.ts:21-50](app/native-server/src/server/token.ts:21)）：
  - 优先级：环境变量 `CHROME_MCP_TOKEN` > 文件 `~/.chrome-mcp/bridge-token` > 自动生成 32 字节高熵十六进制数并以 `0600` 权限落盘。
- **校验安全性**：使用 `crypto.timingSafeEqual` 进行恒定时间比对，防止时序侧信道攻击（[token.ts:68-76](app/native-server/src/server/token.ts:68)）。

### 2.4 流式媒体大文件透传（`/media-asset/:assetId`）

- **设计原因**：Chrome Native Messaging 单条消息协议硬限制为 1MB，大图片/PDF 会直接冲垮管道。
- **阈值分流**（[register-tools.ts:65-90](app/native-server/src/mcp/register-tools.ts:65) 与 [file-handler.ts:670-700](app/native-server/src/file-handler.ts:670)）：
  - <= 650 KB：直接转为 Base64 内联传输。
  - 650 KB ~ 50 MB：文件存入内存 `MediaAssetStore`（带 10 分钟 TTL 过期自洁），生成临时 URL：`http://127.0.0.1:12306/media-asset/<uuid>`，由扩展背景页直接通过 HTTP 流式拉取后注入 DOM。
  - > 50 MB：直接抛错拒绝，防止内存耗尽。

### 2.5 扩展与原生桥连接状态机

- **Native Host 机制**：Chrome 扩展通过 `chrome.runtime.connectNative("com.browserpaw.chrome_mcp")` 与 Node 进程管道互联。
- **Popup 与扩展通信**：[App.vue:44-53](app/chrome-extension/entrypoints/popup/App.vue:44) 通过轮询 `GET http://127.0.0.1:12306/ping` 探测状态；[native-host.ts:430-520](app/chrome-extension/entrypoints/background/native-host.ts:430) 监听 `SERVER_STARTED`、`SERVER_STOPPED` 事件广播并在断开时执行指数退避重连（最大 60s 后转 5min 冷静期）。

---

## 3. 人工介入与原生对话框机制现状

### 3.1 人工介入（`chrome_request_human_intervention`）

- **应用场景**：面对滑块/点选验证码（Captcha）、短信 2FA、银行密码控件、生物识别等 Agent 绝对不可或无法通过的代码路径。
- **触发与提示**：[interact-index.ts:660, 1043](app/chrome-extension/entrypoints/background/tools/browser/interact-index.ts:660) 拦截点击或检测到 Anti-bot 页面时，主动向主 Agent 返回明确的 Hint。
- **执行流程与 UI 呈现**：
  1. [human-intervention.ts:48-75](app/chrome-extension/entrypoints/background/tools/browser/human-intervention.ts:48)：调用后向当前 Tab 的 `agent-cursor` 发送 `HUMAN_INTERVENTION_REQUEST` 并进入 Promise 等待（默认超时 60s）。
  2. [agent-cursor.content.ts:740-830](app/chrome-extension/entrypoints/agent-cursor.content.ts:740)：页面顶层 Shadow DOM 弹出高质感毛玻璃横幅（`#codex-human-intervention-banner`），虚拟光标避让至屏幕右上角待机。
  3. 用户在网页上手动完成验证后，点击横幅上的 `Complete & Resume (Enter)` 或直接按下回车，内容脚本捕获并回传 `resumed_by_user`，自动化平滑恢复。

### 3.2 原生对话框处理（`chrome_handle_dialog`）

- **核心铁律**：BrowserPaw 严禁对 `Page.javascriptDialogOpening` 进行无脑静默自动确认（Auto-accept），防止恶意网页利用 `confirm()/alert()` 诱导误操作。
- **死锁防护机制**：
  - 当原生弹窗弹出时，Chrome 渲染引擎的主线程将被完全阻塞，导致后续所有的 `chrome.debugger.sendCommand` 或 `executeScript` 无法收到 ACK。
  - [cdp-session-manager.ts:140-170](app/chrome-extension/utils/cdp-session-manager.ts:140) 与 [race-cdp.ts:70-80](app/chrome-extension/utils/race-cdp.ts:70) 部署了防御性挂起超时，捕获到超时且存在挂起弹窗时抛出清晰报错：`"...renderer not acking (modal dialog is open), call chrome_handle_dialog first"`。
- **解决动作**：
  - 主 Agent 必须发起独立的 `chrome_handle_dialog` 工具调用（[dialog.ts:25-70](app/chrome-extension/entrypoints/background/tools/browser/dialog.ts:25)），显式传入 `action: "accept" | "dismiss"` 及可选 `promptText`，底层调用 CDP `Page.handleJavaScriptDialog` 消除挂起弹窗并清理 session manager 中的 pending 记录。

---

## 4. Skill 指南：何时代由 Jev、何时主 Agent 自主规划

基于源码实现与真实行为证据，在针对 Agent 的使用规范（`SKILL.md`）中应提供如下明确分工指导：

### 4.1 优先交由 Jev 决策（`chrome_act_toward_goal`）的场景

1. **单一页面内常规 UI 推进**：
   - 目标明确且操作在当前视口内（如“点击右上角登录按钮”、“在搜索框搜索 MacBook Pro 并回车”）。
   - 包含简单交互链：例如点击展开筛选菜单 -> 勾选特定属性 -> 点击确认。
2. **多字段表单录入**：
   - 表单字段较多，依赖 `form-pipeline` 和 Jev 进行字段语义模糊匹配，单步处理仅需 200ms。
3. **批量滚动翻页与列表定位**：
   - 纯粹的 `scroll_down`、定位下一页按钮，交由 Jev 闭环自决，避免外部 LLM 消耗高额轮次开销。

### 4.2 严禁依赖 Jev，必须由主 Agent 显式规划的场景

1. **跨页面 / 跨 Tab 战略导航**：
   - Jev 只具备单 Tab 单视口局部视野，无法进行宏观 URL 规划、Tab 切换（`chrome_tabs`）或网络级追踪（`chrome_network_capture`）。
2. **不可逆与高风险操作（Jev 会主动熔断拦截）**：
   - 涉及支付、下单、删除项目、提交敏感申请等，Jev 内置破坏性守护（confidence >= 0.50 即强制 escalate），主 Agent 必须自己读取 DOM、向最终用户核验并直接调用原子工具（如 `chrome_interact_index`）。
3. **需要丰富上下文创作的内容输入**：
   - 编写邮件长文、撰写文章摘要、回复工单等；Jev 仅具备确定性正则文本提取，不负责长文本生成。主 Agent 构思好内容后直接调用 `chrome_fill_index`。
4. **弹窗解挂与人机验证**：
   - 遇到原生 JavaScript 弹窗必须由主 Agent 显式下发 `chrome_handle_dialog`；遇到验证码时直接下发 `chrome_request_human_intervention`，不可陷入微循环盲目尝试。
