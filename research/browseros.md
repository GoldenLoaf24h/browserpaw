# BrowserOS 架构深度测绘与基线对标报告 (research/browseros.md)

> **测绘执行人**: Hubble (`01a0e83e-b2c8-7bb2-ade2-16d8cba54000`)  
> **执行角色**: 阶段二：Type A 深度测绘员 (Agent-BrowserOS)  
> **测绘对象**: `research/_external/BrowserOS` (基于 commit `7a5ae53600414cbb88bcd29cf5e972f16b199e92`, 全栈 Chromium Fork + Rust/Bun 双服务端 + browser-core + browser-mcp)  
> **对标基线**: `research/00-current-architecture.md` (BrowserPaw Monorepo: Fastify + Chrome MV3 Extension + Dual-Brain + 1-based WeakRef DOM)  
> **开源协议约束**: **AGPL-3.0** (严格声明：禁止直接复制代码，仅吸收架构机制与设计思想)  
> **验证准则**: §A 双重验证纪律（源码相对路径:行号定位 + 真实逻辑对齐与量化审计，严禁臆测）

---

## 目录

- [§A 双重验证纪律与核心验证坐标索引](#a-双重验证纪律与核心验证坐标索引)
- [1. 调研对象概述与核心设计哲学](#1-调研对象概述与核心设计哲学)
  - [1.1 项目背景与全景拓扑](#11-项目背景与全景拓扑)
  - [1.2 BrowserOS 全景架构与组件分工](#12-browseros-全景架构与组件分工)
- [2. 关键组件源码深度逆向](#2-关键组件源码深度逆向)
  - [2.1 apps/claw-server-rust (Rust MCP 端点 + JSON API)](#21-appsclaw-server-rust-rust-mcp-端点--json-api)
  - [2.2 apps/server (Bun MCP Server + AI Agent Loop)](#22-appsserver-bun-mcp-server--ai-agent-loop)
  - [2.3 packages/browser-core (浏览器控制原语与 AXTree 引擎)](#23-packagesbrowser-core-浏览器控制原语与-axtree-引擎)
  - [2.4 packages/browser-mcp (精简聚合 MCP 工具体系)](#24-packagesbrowser-mcp-精简聚合-mcp-工具体系)
  - [2.5 packages/cdp-protocol 与 crates/browseros-cdp (CDP 传输与协议绑定)](#25-packagescdp-protocol-与-cratesbrowseros-cdp-cdp-传输与协议绑定)
  - [2.6 packages/browseros (Chromium Fork、bos_build 与 378 个补丁集)](#26-packagesbrowseros-chromium-forkbos_build-与-378-个补丁集)
- [3. 三大核心专题深度评估与战略辨析](#3-三大核心专题深度评估与战略辨析)
  - [3.1 次级 Agentic 浏览器产品形态（用户日常主力 vs Agent Neo 浏览器）](#31-次级-agentic-浏览器产品形态用户日常主力-vs-agent-neo-浏览器)
  - [3.2 Chromium Fork 代价与收益全景测算](#32-chromium-fork-代价与收益全景测算)
  - [3.3 MCP 本地 Server 接入与安全架构设计](#33-mcp-本地-server-接入与安全架构设计)
- [4. 九大核心维度横向对标与量化审计](#4-九大核心维度横向对标与量化审计)
  - [4.1 维度 1：桥接与会话层 (Bridge & Session Architecture)](#41-维度-1桥接与会话层-bridge--session-architecture)
  - [4.2 维度 2：页面表示与 Token 效率 (DOM Representation & Token Efficiency)](#42-维度-2页面表示与-token-效率-dom-representation--token-efficiency)
  - [4.3 维度 3：工具抽象 (MCP/CLI) (Tool Abstraction & MCP Interface)](#43-维度-3工具抽象-mcpcli-tool-abstraction--mcp-interface)
  - [4.4 维度 4：跨页与多场景寻址 (Cross-Tab & Window Addressing)](#44-维度-4跨页与多场景寻址-cross-tab--window-addressing)
  - [4.5 维度 5：现场恢复与自愈机制 (Context Recovery & Element Self-Healing)](#45-维度-5现场恢复与自愈机制-context-recovery--element-self-healing)
  - [4.6 维度 6：会话管理与隔离 (Session Isolation & Tab Ownership)](#46-维度-6会话管理与隔离-session-isolation--tab-ownership)
  - [4.7 维度 7：安全边界与防御机制 (Security Boundaries & Anti-Rebinding)](#47-维度-7安全边界与防御机制-security-boundaries--anti-rebinding)
  - [4.8 维度 8：安装与接入体验 (Installation & Developer Experience)](#48-维度-8安装与接入体验-installation--developer-experience)
  - [4.9 维度 9：License 与合规风险 (License, Copyleft & Clean-Room Boundaries)](#49-维度-9license-与合规风险-license-copyleft--clean-room-boundaries)
- [5. 与 BrowserPaw 的全景横评对照矩阵](#5-与-browserpaw-的全景横评对照矩阵)
- [6. BrowserPaw 架构机制吸收建议（可落地演进清单）](#6-browserpaw-架构机制吸收建议可落地演进清单)
  - [6.1 吸收建议 1：动作后置增量 Diff 回读机制（减少 50% 交互轮次）](#61-吸收建议-1动作后置增量-diff-回读机制减少-50-交互轮次)
  - [6.2 吸收建议 2：Sec-Fetch-Site 协议级跨源防御中间件](#62-吸收建议-2sec-fetch-site-协议级跨源防御中间件)
  - [6.3 吸收建议 3：三元组 (role, name, nth) 两级节点探活自愈机制](#63-吸收建议-3三元组-role-name-nth-两级节点探活自愈机制)
  - [6.4 坚决规避的设计禁忌项 (Anti-Patterns & Defenses)](#64-坚决规避的设计禁忌项-anti-patterns--defenses)
- [7. 子代理测绘结论与后续交付物映射](#7-子代理测绘结论与后续交付物映射)

---

## §A 双重验证纪律与核心验证坐标索引

根据 §A 双重验证硬性纪律，本报告对 `BrowserOS` 外部仓库的关键实现、核心类、函数、常量与补丁均通过真实代码路径与精确行号进行标定，严禁凭模糊印象或概念化平铺断言。

### 核心验证坐标索引表

| 关键子系统 / 机制                    | BrowserOS 源码定位                                                                                                   | 关键类 / 函数 / 常量 / 变量                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Streamable HTTP MCP 端点挂载**     | `BrowserOS@packages/browseros-agent/apps/claw-server-rust/src/api/http/mod.rs:99-106`                                | `streamable_http_service`, `mcp_request_hygiene`                         |
| **Bun/Hono MCP 路由与租约解析**      | `BrowserOS@packages/browseros-agent/apps/server/src/api/routes/mcp.ts:44-78`                                         | `createMcpRoutes`, `BROWSEROS_TOOL_LEASE_HEADER`, `readScope`            |
| **Rust 原生 WebSocket CDP 客户端**   | `BrowserOS@packages/browseros-agent/crates/browseros-cdp/src/client.rs:47-95`                                        | `ConnectOptions`, `CdpClient`, `ReconnectPolicy`                         |
| **CDP 连接抽象契约**                 | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/connection.ts:11-23`                              | `CdpConnection`, `session(sessionId)`, `rawSendJson`                     |
| **AXTree 递归可访问性快照渲染**      | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/snapshot/render.ts:33-88`                         | `renderSnapshot`, `isDropped`, `IFRAME_ROLES`                            |
| **可交互角色与光标增强判定**         | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/snapshot/render.ts:120-138`                       | `INTERACTIVE_ROLES`, `cursorReasons`, `RefMap.mint()`                    |
| **Myers/LCS 快照差异对比与熔断**     | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/snapshot/diff.ts:41-85`                           | `diffSnapshots`, `exceedsLcsBudget`, `MAX_LCS_CELLS`                     |
| **动作执行后置自动回读增量 Diff**    | `BrowserOS@packages/browseros-agent/packages/browser-mcp/src/tools/act.ts:85-97`                                     | `act.handler`, `response.includeDiff`, `resolveDiffDetail`               |
| **聚合操作原语 Schema**              | `BrowserOS@packages/browseros-agent/packages/browser-mcp/src/tools/act.ts:15-80`                                     | `act`, `kind` (15种动作), `fields[]` (批量填充)                          |
| **精简浏览器工具清单 (17 工具)**     | `BrowserOS@packages/browseros-agent/packages/browser-mcp/src/tools/registry.ts:20-38`                                | `BROWSER_TOOLS`: `tabs`, `act`, `snapshot`, `diff` 等                    |
| **会话元工具与上下文注入**           | `BrowserOS@packages/browseros-agent/apps/claw-server-rust/src/api/mcp/service.rs:49-75`                              | `name_session`, `save_skill`, `mark_skill_run`, `SESSION_META_KEY`       |
| **页面管理与整数 pageId 映射**       | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/pages.ts:59-96`                                   | `PageManager.list`, `nextPageId++`, `Browser.getTabs`                    |
| **Chromium Blink DevTools 协议补丁** | `BrowserOS@packages/browseros/chromium_patches/third_party/blink/public/devtools_protocol/domains/Browser.pdl:35-58` | `WindowInfo`, `TabInfo`, `getTabs`, `getWindows`                         |
| **RefMap 同文档稳定引用维护**        | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/snapshot/refs.ts:15-68`                           | `RefMap`, `byStableNode`, `stableNodeKey`, `mint`                        |
| **三元组两级节点解析自愈机制**       | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/observer/resolve.ts:18-36`                        | `resolveRefEntry`, `isLive`, `findByRoleNameNth`                         |
| **DOM 节点探活后主动内存释放**       | `BrowserOS@packages/browseros-agent/packages/browser-core/src/core/observer/resolve.ts:38-51`                        | `isLive`, `DOM.resolveNode`, `Runtime.releaseObject`                     |
| **多 Agent 标签页归属权与分组**      | `BrowserOS@packages/browseros-agent/apps/claw-server-rust/src/services/sessions/tab_ownership.rs:55-71`              | `PageOwnership`, `ConvoTabs`, `TabGroup`, `claim_page`                   |
| **工具分发安全与越界访问警示**       | `BrowserOS@packages/browseros-agent/apps/claw-server-rust/src/api/mcp/dispatch.rs:68-74`                             | `ToolCall`, `foreign_pages`, `CancellationToken`                         |
| **Sec-Fetch-Site 跨源阻断中间件**    | `BrowserOS@packages/browseros-agent/apps/server/src/api/middleware/reject-browser-fetch.ts:13-29`                    | `rejectBrowserFetch`, 拦截浏览器发起的 DNS 劫持与 CSRF                   |
| **Chromium 构建发布系统 CLI**        | `BrowserOS@packages/browseros/bos_build/README.md:1-40`                                                              | `bos_build`, `uv run browseros build`, 378 个补丁集                      |
| **AGPL-3.0 传染性开源许可**          | `BrowserOS@LICENSE:1-30`, `packages/browseros-agent/apps/server/package.json:108`                                    | `GNU AFFERO GENERAL PUBLIC LICENSE v3`, `"license": "AGPL-3.0-or-later"` |

---

## 1. 调研对象概述与核心设计哲学

### 1.1 项目背景与全景拓扑

BrowserOS (此前曾在内部衍生出 `browserclaw` / `browseros-neo`) 是一个追求极度自主可控、全栈闭环的 Agentic 浏览器操作系统。与业界大部分基于 Puppeteer / Playwright 封装 Python/Node SDK 的项目不同，BrowserOS 认为**现有通用浏览器及其标准调试协议是 Agent 执行效率的最大瓶颈**。

因此，BrowserOS 确立了如下核心哲学：

1. **定制内核级协议**: 通过维护 378 个 C++ 补丁 Fork Chromium，直接在 Blink 引擎内部增加对多窗口、多标签页状态的原生感知（如注入 `Browser.getTabs`），抹除一切自动化特征与弹窗。
2. **极简语义操作原语**: 彻底抛弃传统的选择器与多命令调用，以无障碍树（Accessibility Tree）结合光标增强为核心，对外仅暴露 17 个高阶原子工具，将所有页面变动操作折叠进单一的 `act` 原语。
3. **动作后置 Diff 闭环**: 主张“操作即观测”，任何操作之后必须就地返回页面发生变更的 Diff 增量，使 LLM 在单个回合内同时完成执行与状态核验。
4. **工业级会话与宿主工程**: 放弃纯脚本化模型，提供 Rust 高性能服务端 (`claw-server-rust`) 与 Bun 运行时服务，集成 SQLite 审计、视频级执行回放、Tab 组级会话隔离与 Lease 租约鉴权。

### 1.2 BrowserOS 全景架构与组件分工

```
+-----------------------------------------------------------------------------------------+
|                                外部 AI Agent (System 2)                                 |
|                     (Claude Desktop / Codex / Cursor / Windsurf / CLI)                  |
+--------------------------------------------+--------------------------------------------+
                                             |
                          [MCP 协议: Stdio / Streamable HTTP (/mcp)]
                                             |
+--------------------------------------------v--------------------------------------------+
|                       BrowserOS Agent 宿主层 (双服务架构)                                |
|  +-------------------------------------------+  +------------------------------------+  |
|  | apps/claw-server-rust (Rust 高性能服务)    |  | apps/server (Bun 运行时服务)        |  |
|  | - Axum HTTP + rmcp Stdio / Streamable MCP |  | - Hono HTTP + @modelcontextprotocol|  |
|  | - SQLite (AuditLog, SessionTabLedger)     |  | - In-process ToolLoopAgent (AI SDK)|  |
|  | - PageOwnership 多会话 Tab Group 强归属   |  | - rejectBrowserFetch 跨源安全防护   |  |
|  | - Replay & Recording 视频级执行回放      |  | - x-browseros-tool-lease 租约鉴权   |  |
|  +---------------------+---------------------+  +-----------------+------------------+  |
+------------------------|------------------------------------------|---------------------+
                         |                                          |
                         +--------------------+---------------------+
                                              |
+---------------------------------------------v-------------------------------------------+
|                          packages/browser-core (浏览器控制原语)                          |
|  - PageManager: 基于整数 pageId 统一管理标签页                                          |
|  - Observer / Render: AXTree 渲染过滤 + [ref=eN] 分配 + Iframe 缝合                     |
|  - Diff: Myers/LCS 400 万单元格预算保护增量计算                                         |
|  - Resolve: (role, name, nth) 两级存活探针与自愈对齐                                    |
|  - Input / Navigation / Windows: 动作分发与多窗口感知                                   |
+---------------------------------------------+-------------------------------------------+
                                              |
                   [CDP over WebSocket (crates/browseros-cdp / cdp-protocol)]
                                              |
+---------------------------------------------v-------------------------------------------+
|                          packages/browseros (定制 Chromium Fork)                        |
|  - 378 个 C++ Patch (Blink / DevTools PDL / UI / Views / Bundled Extensions)            |
|  - 注入非标 CDP: Browser.getTabs, Browser.getWindows                                    |
|  - bos_build: 基于 Python CLI (uv run browseros) 的跨平台编译流水线                     |
+-----------------------------------------------------------------------------------------+
```

---

## 2. 关键组件源码深度逆向

### 2.1 apps/claw-server-rust (Rust MCP 端点 + JSON API)

- **源码根目录**: `packages/browseros-agent/apps/claw-server-rust`
- **代码行数与构成**: 约 1.2 万行 Rust 代码，由 18 个核心模块组成。
- **架构机制逆向**:
  1. **双协议统一暴露 (`src/main.rs:35-88`)**:
     服务支持 `--stdio` 命令行参数。当启用 `stdio` 模式时，调用 `rmcp::serve_server(stdio(), service)` 启动标准 I/O 管道；未启用时，默认绑定 `127.0.0.1:9200` 启动 Axum HTTP 服务，并将 `/mcp` 路径通过 `nest_service` 映射至 `streamable_http_service`。
  2. **全局状态机管理 (`src/app.rs:35-120`)**:
     `AppState` 采用 `Arc` 包裹并统摄了整套底层服务：`AuditLog`（操作合规审计）、`SessionTabLedger`（Tab 归属持久化）、`RecordingStore`（DOM 与视口视频帧录制）、`ReplayService`（执行回放生成）、`TabActivityService`（标签页活跃度监控）、`BrowserService`（CDP 桥接管理）。
  3. **工具分发安全拦截管线 (`src/api/mcp/dispatch.rs:45-110`)**:
     所有发往底层浏览器的工具调用都被封装为不可变的 `ToolCall`。在真正调用底层原语前，管线串联了：
     - `guards::browser_connected`: 确保底层 WebSocket 处于连接状态；
     - `guards::navigate_scheme`: 拦截高危协议；
     - 挂载 `CancellationToken`：支持用户从驾驶舱 UI、客户端中断或超时自动级联取消；
     - 记录 `foreign_pages`：若操作的页面不属于当前 Agent，记录告警并在响应元数据中注入侵入提示。

### 2.2 apps/server (Bun MCP Server + AI Agent Loop)

- **源码根目录**: `packages/browseros-agent/apps/server`
- **技术栈**: Bun, TypeScript 5.9, Hono, Vercel AI SDK (`ai` 4.x), Drizzle ORM。
- **架构机制逆向**:
  1. **现代 Web 标准 MCP 实现 (`src/api/routes/mcp.ts:44-90`)**:
     基于 `@modelcontextprotocol/server` 官方库的 `WebStandardStreamableHTTPServerTransport`，提供最新的 Streamable HTTP MCP 端点。支持客户端通过 URL Query (`?read_only=1`) 动态声明只读意图，通过 Header (`x-browseros-tool-lease`) 传入安全租约。
  2. **内置自主智能体循环 (`src/agent/ai-sdk-agent.ts:17-80`)**:
     内嵌了 Vercel AI SDK 的 `ToolLoopAgent`。该智能体将本地浏览器控制能力与本地工作区的文件系统工具（`bash`, `read`, `write`, `edit`, `find`, `grep`, `ls`）编排在一起，能够在不需要外部 Agent 的情况下自主跑通端到端的网页任务与本地文件处理。
  3. **上下文动态压缩步进器 (`src/agent/compaction.ts`)**:
     针对多步交互中可能导致的上下文爆炸，实现了基于 Token 计数的 `createCompactionPrepareStep`，在每个循环回合自动评估已用 Token，智能折叠早期的冗余 DOM 快照，保留最新的思考链与关键事实。

### 2.3 packages/browser-core (浏览器控制原语与 AXTree 引擎)

- **源码根目录**: `packages/browseros-agent/packages/browser-core`
- **架构机制逆向**:
  1. **AXTree 页面观测渲染器 (`src/core/snapshot/render.ts:33-145`)**:
     调用 CDP `Accessibility.getFullAXTree` 提取全量可访问性树。遍历过程中，`isDropped` 函数直接剔除无名称且无光标交互属性的 `generic` 和 `group` 容器；对命中的 `iframe`，在树文本中记录当前缩进深度的 `- iframe` 占位行，并将 `backendNodeId` 压入 `iframes` 数组，随后无缝缝合子 Frame 的 AXTree 节点，彻底打通跨跨域 Iframe 的统一感知。
  2. **精细化光标增强判定 (`src/core/observer/cursor-augment.ts`)**:
     针对很多现代网页（尤其是由 `div` 拼装而成的非语义化按钮）缺乏 ARIA 属性的问题，`browser-core` 在执行快照前，通过注入脚本对页面执行 `getComputedStyle(el).cursor === 'pointer'` 的快速采样，将命中的 `backendDOMNodeId` 汇总为 `cursorHits` 字典传入渲染器，确保每一个带手型光标的非标按钮都能被分配 `[ref=eN]`。
  3. **Myers/LCS 快照差异对比引擎 (`src/core/snapshot/diff.ts:41-110`)**:
     定义了 `MAX_LCS_CELLS = 4_000_000` 的硬性防爆阈值。通过 `findChangedWindow` 寻找首尾未变动的行窗口，仅对中间发生变动的区域计算 LCS（最长公共子序列）矩阵。若计算量超标，主动放弃行级 Diff，降级为输出变更行数摘要（`lineDiffSkipped = true`），防止大页面局部 Diff 计算卡死事件循环。
  4. **两级节点自愈解析器 (`src/core/observer/resolve.ts:18-60`)**:
     外部传入 `ref="e12"` 时，首先调用 `DOM.resolveNode` 探活缓存的 `backendNodeId`；若节点已因 DOM 局部重绘而失效，立即调用 `fetchAxTree` 获取当前页面的最新树，并在树中按 `entry.role`、`entry.name` 以及该三元组在原快照中的出现序号 `entry.nth` 进行精确比对。一旦寻路成功，直接就地刷新 `entry.backendNodeId`，实现“透明自愈”。

### 2.4 packages/browser-mcp (精简聚合 MCP 工具体系)

- **源码根目录**: `packages/browseros-agent/packages/browser-mcp`
- **架构机制逆向**:
  1. **工具收敛与注册 (`src/tools/registry.ts:20-38`)**:
     全量仅注册 17 个浏览器工具。每个工具通过 `defineTool` 声明 Zod 校验 Schema，并明确标注 `readOnlyHint` 与 `destructiveHint` 元数据。
  2. **高阶原语 `act` 的复合调度 (`src/tools/act.ts:15-120`)**:
     `act` 工具内部维护了 `ACT_HANDLERS` 字典，将 15 种动作（`click`, `click_at`, `type`, `type_at`, `fill`, `press`, `hover`, `hover_at`, `focus`, `check`, `uncheck`, `select`, `scroll`, `drag`, `drag_at`）统一分发。
     - 对表单场景，提供 `fields: [{ref, value}]` 参数，在单个工具调用中连续触发多次输入，极大降低网络与 LLM 交互往返；
     - 默认在动作执行完毕后触发 `response.includeDiff`，将变动增量内联嵌入当前调用结果。

### 2.5 packages/cdp-protocol 与 crates/browseros-cdp (CDP 传输与协议绑定)

- **源码根目录**:
  - `packages/browseros-agent/packages/cdp-protocol`
  - `packages/browseros-agent/crates/browseros-cdp`
- **架构机制逆向**:
  1. **代码生成脚手架**:
     通过 `sync-protocol.sh` 脚本，从 Chromium 编译产出的 `protocol.json` 自动生成强类型的 TypeScript API（`protocol-api.ts`）与 Rust 序列化/反序列化结构体（`generated.rs`）。
  2. **Rust 高并发 WebSocket 管道 (`crates/browseros-cdp/src/client.rs:65-150`)**:
     使用 `tokio-tungstenite` 建立与 Chromium 调试端口的单一持久长连接。基于 `split()` 将连接分离为 `WsSink`（写入）与 `WsReader`（读取）。读循环中，收到响应消息时按 `id` 匹配内部 `HashMap<u64, oneshot::Sender>` 唤醒等待的异步 Future；收到事件消息时，通过 `broadcast::Sender<CdpEvent>` 向多订阅者分发。

### 2.6 packages/browseros (Chromium Fork、bos_build 与 378 个补丁集)

- **源码根目录**: `packages/browseros`
- **架构机制逆向**:
  1. **Chromium 补丁组织架构**:
     378 个补丁文件按 Chromium 源码目录精确分布：
     - `third_party/blink/public/devtools_protocol/domains/Browser.pdl`: 在 Blink PDL 中增加 `getTabs`、`getWindows` 方法与 `TabInfo`、`WindowInfo` 数据类型；
     - `chrome/browser/devtools/protocol/browser_handler.cc`: 在 C++ 端实现 `BrowserHandler::GetTabs`，直接访问 `BrowserList` 与 `TabStripModel`，以毫秒级速度枚举当前所有打开的 WebContents，且不触发任何权限警告；
     - `chrome/browser/ui/views/side_panel/`: 定制嵌入式 Agent 侧边栏视图；
     - `components/policy/core/common/`: 固化禁用自动化受控横幅（Disable Automation Infobar）。
  2. **自动化构建系统 `bos_build` (`packages/browseros/bos_build`)`:
一套由 Python 编写的工业级发布套件。封装了拉取指定提交的 Ungoogled Chromium 源码、校验补丁哈希、通过 `bpatch`批量注入、调用`gn gen`配置参数并驱动`ninja` 编译的全流程。
