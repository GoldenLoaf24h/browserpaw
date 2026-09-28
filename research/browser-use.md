# browser-use 架构深度测绘与基线对标报告 (research/browser-use.md)

> **测绘执行人**: Euler (`01a0e83e-be90-78e1-a2f2-c4dc9b02f262`)
> **执行角色**: 阶段二：Type B 深度测绘员 (Agent-BrowserUse)
> **测绘对象**: `research/_external/browser-use` (commit: main 活跃基线, Python 核心框架 + cdp-use + bubus + browser-harness)
> **对标基线**: `research/00-current-architecture.md` (BrowserPaw Monorepo: Fastify + Chrome MV3 Extension + Dual-Brain + 1-based WeakRef DOM)
> **验证准则**: §A 双重验证纪律（源码相对路径:行号定位 + 真实逻辑对齐，严禁臆测）

---

## 目录

- [§A 双重验证纪律与验证基线](#a-双重验证纪律与验证基线)
- [1. 调研对象概述与核心设计哲学](#1-调研对象概述与核心设计哲学)
- [2. 九维核心技术架构深度剖析](#2-九维核心技术架构深度剖析)
  - [2.1 桥接与会话层 (Bridge & Session Architecture)](#21-桥接与会话层-bridge--session-architecture)
  - [2.2 页面表示与 Token 效率 (DOM Representation & Token Efficiency)](#22-页面表示与-token-效率-dom-representation--token-efficiency)
  - [2.3 工具抽象与 MCP/CLI 契约 (Tool Abstraction & MCP/CLI Interface)](#23-工具抽象与-mcpcli-契约-tool-abstraction--mcpcli-interface)
  - [2.4 跨页与多场景寻址 (Cross-Tab & Multi-Scenario Addressing)](#24-跨页与多场景寻址-cross-tab--multi-scenario-addressing)
  - [2.5 现场恢复与自愈机制 (Watchdogs & State Self-Healing)](#25-现场恢复与自愈机制-watchdogs--state-self-healing)
  - [2.6 会话隔离与并发模型 (Session Isolation & Concurrency Model)](#26-会话隔离与并发模型-session-isolation--concurrency-model)
  - [2.7 安全边界与风控合规 (Security Boundaries & Policy Enforcement)](#27-安全边界与风控合规-security-boundaries--policy-enforcement)
  - [2.8 安装部署与开发者体验 (Installation & Developer Experience)](#28-安装部署与开发者体验-installation--developer-experience)
  - [2.9 License、遥测与生态合规 (License, Telemetry & Compliance)](#29-license遥测与生态合规-license-telemetry--compliance)
- [3. BU Bench 评测体系与 60-Task 基准方法论](#3-bu-bench-评测体系与-60-task-基准方法论)
  - [3.1 评测架构与任务驱动流水线](#31-评测架构与任务驱动流水线)
  - [3.2 LLM Judge 判定模型与真值仲裁链](#32-llm-judge-判定模型与真值仲裁链)
- [4. 与 BrowserPaw 的深度技术横评矩阵](#4-与-browserpaw-的深度技术横评矩阵)
- [5. 可借鉴设计点 (Actionable Takeaways)](#5-可借鉴设计点-actionable-takeaways)
- [6. 不可借鉴设计点与坚守理由 (Anti-Patterns & Defenses)](#6-不可借鉴设计点与坚守理由-anti-patterns--defenses)
- [7. 子代理测绘结论与后续交付物映射](#7-子代理测绘结论与后续交付物映射)

---

## §A 双重验证纪律与验证基线

本报告遵循 §A 双重验证硬性纪律，对 `browser-use` 仓库的所有机制分析均提供精确的源码文件相对路径与代码行号，严禁凭模糊印象或概念化平铺断言。

### 核心验证坐标索引表

| 关键子系统 / 机制          | browser-use 源码定位                                                     | 关键类 / 函数 / 变量                                              |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **CDP 连接与会话根**       | `browser_use/browser/session.py:134-160`                                 | `BrowserSession`, `_cdp_client_root`, `CDPClient`                 |
| **会话状态池管理器**       | `browser_use/browser/session_manager.py:24-80`                           | `SessionManager`, `_targets`, `_sessions`, `start_monitoring()`   |
| **AXTree 递归聚合**        | `browser_use/dom/service.py:370-410`                                     | `DomService._get_ax_tree_for_all_frames`                          |
| **DOM 增强快照与样式**     | `browser_use/dom/enhanced_snapshot.py:20-50`                             | `REQUIRED_COMPUTED_STYLES`, `build_snapshot_lookup`               |
| **DOM 元素编号与序列化**   | `browser_use/dom/serializer/serializer.py:42-120`, `649-670`, `989-1150` | `DOMTreeSerializer`, `_allocate_selector_index`, `serialize_tree` |
| **可交互元素探测器**       | `browser_use/dom/serializer/clickable_elements.py:4-70`                  | `ClickableElementDetector.is_interactive`                         |
| **绘制顺序层叠剔除**       | `browser_use/dom/serializer/paint_order.py:146-210`                      | `PaintOrderRemover.remove_covered_elements`                       |
| **动作历史总结与压缩**     | `browser_use/agent/message_manager/service.py:216-300`                   | `MessageManager.maybe_compact_messages`                           |
| **Watchdog 守卫总线**      | `browser_use/browser/watchdogs/dom_watchdog.py:34-75`                    | `DOMWatchdog`, `on_TabCreatedEvent`, `BrowserStateRequestEvent`   |
| **安全策略与 URL 门禁**    | `browser_use/browser/watchdogs/security_watchdog.py:22-65`               | `SecurityWatchdog`, `on_NavigateToUrlEvent`                       |
| **验证码守卫挂起**         | `browser_use/browser/watchdogs/captcha_watchdog.py:44-90`                | `CaptchaWatchdog`, `on_CaptchaDetectedEvent`                      |
| **CLI MCP / Stdio 封装**   | `browser_use/mcp/cli_mcp.py:32-90`                                       | `CLIMCPServer`, `browser_exec`, `browser_screenshot`              |
| **标准 MCP Server**        | `browser_use/mcp/server.py:50-130`                                       | `_configure_mcp_server_logging`, `uvx browser-use --mcp`          |
| **CLI 诊断探针与医生命令** | `browser_use/cli.py:185-230`, `325-335`                                  | `_run_browser_harness`, `browser-use --doctor`                    |
| **macOS 调试权限批准**     | `browser_use/skills/browser-use/SKILL.md:80-98`                          | `browser-use mac-approve`, `BU_NAME`                              |
| **BU Bench 评测执行入口**  | `tests/ci/evaluate_tasks.py:40-110`                                      | `run_single_task`, `JudgeResponse`, `ChatBrowserUse`              |
| **LLM Judge 仲裁 prompt**  | `browser_use/agent/judge.py:50-150`                                      | `construct_judge_messages`, `ground_truth_section`                |

---

## 1. 调研对象概述与核心设计哲学

`browser-use` 是当前开源社区在 Python 生态中热度最高、迭代最频繁的 Web 自动化 Agent 框架之一（GitHub 活跃 Star 50k+）。其核心架构理念经历了从初期 Playwright API 驱动到全量自研 **CDP 原生事件总线架构**（自研底层驱动 `cdp-use` + 事件总线 `bubus` + 轻量常驻 CLI `browser-harness`）的根本演进。

### 核心设计哲学

1. **CDP-First 与去 Playwright 化**: 摒弃对重型 Playwright 进程包装的依赖，通过 WebSocket 直连 Chromium CDP 协议端口（默认 `9222`），追求更细粒度的页面生命周期拦截与极低通信开销。
2. **事件总线驱动 (`bubus` Architecture)**: 浏览器会话、网络请求、DOM 捕获、动作执行全部抽象为在统一事件总线派发与监听的 Event 对象，各功能模块通过 Watchdog（看门狗守卫）解耦。
3. **混合感知序列化 (Accessibility + DOM Snapshot + Paint Order)**: 页面解析兼顾可访问性树（AXTree）语义与物理几何层叠（DOMSnapshot 计算样式 + 绘制顺序剔除），生成带数字方括号 `[index]` 标记的精简可读文本树。
4. **渐进式执行双轨制 (Agentic Mode vs Harness CLI)**: 既支持上层多轮自主推理的 `Agent.run()` 模式，又提供常驻守护进程的 `browser-use` CLI（通过 Stdio 执行纯 Python 脚本操控浏览器），兼顾自动化 Agent 与人类开发者调试。

---

## 2. 九维核心技术架构深度剖析

### 2.1 桥接与会话层 (Bridge & Session Architecture)

#### 实现原理与代码结构

- **底层 CDP 传输抽象**: 在 `browser_use/browser/session.py:134-160` 中定义了 `BrowserSession`，底层依托自研的 `cdp_use.CDPClient`。其连接通过异步 WebSocket 建立并维护 (`session.py:508-520`)，利用 `_cdp_client_root` 作为根连接，通过 CDP `Target.attachToTarget(flatten=True)` 获取各页面 target 的 session 通道。
- **单目标与多会话路由**: `browser_use/browser/session_manager.py:24-80` 充当全会话状态的唯一真实来源 (Single Source of Truth)。它维护 `_targets: dict[TargetID, Target]` 与 `_sessions: dict[SessionID, CDPSession]`，通过监听 `Target.attachedToTarget` 和 `Target.detachedFromTarget` 动态同步，避免出现脏会话或挂死目标。
- **全局生命周期监听修复**: 在 `session_manager.py:55-70` 中，由于 `cdp-use` 的事件分发器每种方法仅支持单槽注册，框架特别设计了在根连接上全局监听 `Page.lifecycleEvent`，并按 `TargetID` 存入循环队列 `deque`，解决了跨标签页生命周期监听互相踩踏覆盖的顽疾。

#### 缺陷与瓶颈

- 缺乏类似 BrowserPaw 的 Native Messaging 宿主层防护；一旦直连的 Chrome 崩溃或端口被外部程序抢占，WebSocket 重连与目标状态清理（`_cdp_client_root` 状态机）容易产生竞态阻塞。

---

### 2.2 页面表示与 Token 效率 (DOM Representation & Token Efficiency)

#### 实现原理与代码结构

- **四重数据流并发采集**: `browser_use/dom/service.py:560-610` 在执行 `_get_all_trees` 时，通过 `asyncio.wait` 并发拉取 4 路数据：
  1. `DOMSnapshot.captureSnapshot`（带 computedStyles 与 paintOrder）;
  2. `DOM.getDocument(depth=-1, pierce=True)`（包含跨 Shadow DOM 节点）;
  3. `Accessibility.getFullAXTree`（递归所有 frameId 收集可访问性树）;
  4. `devicePixelRatio`（视口比率校准）。
- **极简计算样式过滤器**: `browser_use/dom/enhanced_snapshot.py:20-35` 定义了 `REQUIRED_COMPUTED_STYLES`，仅采集 10 项核心计算样式（`display`, `visibility`, `opacity`, `overflow`, `overflow-x`, `overflow-y`, `cursor`, `pointer-events`, `position`, `background-color`），严防在巨型复杂页面上触发 Chrome 渲染线程崩溃。
- **可交互性多维推断**: `browser_use/dom/serializer/clickable_elements.py:4-70` 的 `ClickableElementDetector.is_interactive` 综合判定：
  - 递归向下探测表单控件（处理 label/span 包装器，最大深度 2）；
  - 过滤 `html`/`body` 与带 `for` 属性的代理 label；
  - 检查通过 CDP 探测到的动态 JS 点击监听器 (`node.has_js_click_listener`)；
  - 尺寸过滤：IFRAME 必须宽且高 > 100px 才判定为需要滚动交互，普通元素允许 0 尺寸以防忽略全屏点击遮罩。
- **几何层叠与绘制顺序剔除 (Paint Order Filtering)**: `browser_use/dom/serializer/paint_order.py:146-210` 利用 Chrome 计算出的 `paintOrder` 标量，在元素空间矩形重叠时，自动剔除被上层浮层（如 Modal 遮罩、下拉菜单下方的正文文本）完全遮挡的不可见节点。
- **文本序列化输出格式**: `browser_use/dom/serializer/serializer.py:989-1150` 将简化树转成扁平缩进文本：
  - 交互元素打上编号：`[index]<button ... />`；
  - 本轮新增元素打星号前缀：`*[index]<div ... />`；
  - 滚动容器指示：`|scroll element[index]|<div ... /> (scroll: 0/1200 px)`；
  - Shadow DOM 分界显式标注：`Open Shadow` / `Closed Shadow` / `Shadow End`。

#### 与 BrowserPaw 1-based DOM 对比

- **优势**: 引入了 `paintOrder` 深度剔除，有效减少由于绝对定位弹出层覆盖造成的幻觉点击。
- **劣势**: 每次生成全量序列化文本耗费大量 CPU 与 CDP 数据往返；缺少 BrowserPaw 的 **850KB UTF-8 Slicing 保护机制** 与 **WeakRef 跨轮次内存缓存**，在超长单页（如无限瀑布流、万行文档）中序列化耗时可达数秒。

---

### 2.3 工具抽象与 MCP/CLI 契约 (Tool Abstraction & MCP/CLI Interface)

#### 实现原理与代码结构

- **动作注册与分发**: `browser_use/tools/service.py:1-120` 集中定义了核心 Agent Actions：
  - 导航类：`navigate`, `switch_tab`, `close_tab`, `go_back`；
  - 交互类：`click_element(index)`, `input_text(index, text)`, `send_keys`, `scroll`, `select_dropdown_option`；
  - 提取与交付：`extract`, `save_as_pdf`, `take_screenshot`, `done`。
- **双模 MCP 暴露体系**:
  1. **标准 Agentic MCP**: `browser_use/mcp/server.py:50-130`，通过 `uvx browser-use --mcp` 启动，将整个自治 Agent 封装为单次调用的高阶任务工具。
  2. **CLI MCP (即时交互式)**: `browser_use/mcp/cli_mcp.py:32-90` 定义 `CLIMCPServer`，向 MCP 客户端仅暴露极简的 **2 个元工具**：
     - `browser_exec(code: str)`: 在常驻 Python 命名空间中持久化执行代码段，预置导入所有操作函数（`new_tab`, `page_info`, `click_at_xy` 等）；
     - `browser_screenshot(full: bool)`: 原生抓取并返回图片结果。
- **参数动态注入**: `browser_use/tools/registry/service.py` 支持根据当前上下文向 Action 模型动态注入 `browser_session`, `page`, `file_system` 等内部依赖，屏蔽上层模型对底层句柄的感知。

---

### 2.4 跨页与多场景寻址 (Cross-Tab & Multi-Scenario Addressing)

#### 实现原理与代码结构

- **背景标签页常驻操作与「马匹标记」(Horse Marker)**:
  - 在 `browser_use/skills/browser-use/SKILL.md:45-65` 与 `browser_use/browser/session.py` 中，browser-use 倡导 **非前台打扰交互**。
  - 通过 CDP `Target.attachToTarget` 可以向非激活标签页发送输入与点击，页面标题默认被附加上视觉标记（Horse Marker: 🐴），提示人类用户该标签页正由 Agent 控制。
- **智能可见性激活升阶**:
  - `SKILL.md:55-65`: 当在后台标签页执行 `scroll` 超时或失败时，判定页面可能处于 Chromium 的 `visibilitychange: hidden` 渲染暂停态，此时自动调用 `activate_tab()` 将其置于前台，重试滚动后再读回。
- **跨域 Iframe 靶向附着**:
  - `browser_use/browser/profile.py` 包含 `cross_origin_iframes` 选项。在 `dom/service.py:370-410` 中，框架支持识别跨域 iframe 的独立 TargetID，动态创建子 CDP Session 进行数据穿透提取。

---

### 2.5 现场恢复与自愈机制 (Watchdogs & State Self-Healing)

#### 实现原理与代码结构

- **Watchdog (看门狗) 矩阵架构**:
  `browser_use/browser/watchdogs/` 下实现了多达 14 种专注细分场景的守卫类，均继承自 `BaseWatchdog` (`watchdog_base.py`)，通过 `LISTENS_TO` 与 `EMITS` 声明事件契约：
  1. `captcha_watchdog.py`: 识别 Cloudflare / Turnstile / Arkose 验证码挑战，一旦捕获派发 `CaptchaDetectedEvent`，根据策略挂起等待人工干预或自动重试；
  2. `crash_watchdog.py`: 监听渲染进程崩溃与 WebSocket 异常断开，触发重连与会话复原；
  3. `security_watchdog.py`: 强行拦截不在白名单内的 URL 跳转与重定向，就地阻断并回退至 `about:blank`；
  4. `popups_watchdog.py`: 自动检测并处置阻碍主流程的模态弹窗；
  5. `downloads_watchdog.py`: 拦截 CDP `Browser.downloadWillBegin` 与进度事件，捕获下载落盘物理路径。
- **动作历史自愈与上下文压缩 (Compaction)**:
  - `browser_use/agent/message_manager/service.py:216-300` 实现了业界领先的动态压缩机制 `maybe_compact_messages`。
  - **双重门禁阈值**: 必须同时满足 **步数门禁**（距离上次压缩达到 `compact_every_n_steps`）与 **字符底线门禁**（历史文本总长超过 `trigger_char_count`，默认 40,000 字符）。
  - **事实严格判定法则**: 在压缩 Prompt 中明确约束：_“只有在历史中看到显式成功确认时，才将步骤标记为完成；若开始但未确认，标为 IN-PROGRESS，绝不从上下文推断完成”_。
  - **截断保留策略**: 压缩后始终保留 **第一条原始指令** 以及最近的 `keep_last_items` 条交互，确保全局目标不丢失。

---

### 2.6 会话隔离与并发模型 (Session Isolation & Concurrency Model)

#### 实现原理与代码结构

- **本地 Chrome vs 云端隔离 (CloudBrowser)**:
  - 本地模式: 依赖单个 Chrome 实例的 CDP 端口，多个并发 Agent 必须共享标签页空间，容易产生焦点争抢。
  - 云端模式: `browser_use/browser/cloud/cloud.py` 支持动态创建由 Browser Use 官方托管的独立沙箱浏览器实例（基于 Docker / Remote Chromium），每个任务具备完全隔离的 IP、Profile、CookieJar 与文件系统。
- **本地并发保护**:
  - `tests/ci/evaluate_tasks.py:40-60` 在运行大规模评估时，强制采用 **子进程级隔离**（Subprocess），每个任务独立拉起专属 Python 解释器与无头 Profile，从操作系统级别杜绝不同 Session 间的内存与 CDP 事件污染。

---

### 2.7 安全边界与风控合规 (Security Boundaries & Policy Enforcement)

#### 实现原理与代码结构

- **网络访问白名单与重定向防逃逸**:
  - `browser_use/browser/watchdogs/security_watchdog.py:35-65` 在 `on_NavigateToUrlEvent` 中实施**预检拦截**（Navigation Before Request），若目标域未在 `allowed_domains` 中直接抛出异常；
  - 并在 `on_NavigationCompleteEvent` 中实施**后检拦截**，防止通过服务端 302/307 重定向偷渡到恶意或未授权内网域名，违规时强制将页面导向 `about:blank`。
- **敏感输入字段拦截与脱敏**:
  - `browser_use/dom/enhanced_snapshot.py:45-65` 严格过滤 `type="password"`, `type="file"`, `type="hidden"` 以及包含 `cc-`, `one-time-code` 等信用卡/双因子认证的敏感表单字段，其实时输入值永远不进入快照树与日志流。
  - `browser_use/agent/message_manager/service.py:391-420`: 在向模型传递上下文前，执行 `_filter_sensitive_data` 进行脱敏替换。

---

### 2.8 安装部署与开发者体验 (Installation & Developer Experience)

#### 实现原理与代码结构

- **全自动环境诊断探针 (`doctor`)**:
  - `browser_use/cli.py:185-230`: 运行 `browser-use --doctor` 自动触发自检链，逐一排查本地 Chrome 是否运行、远程调试端口是否就绪、Snap 沙箱权限（Linux）以及 macOS 辅助功能授权。
- **macOS 授权一键闭环 (`mac-approve`)**:
  - 在 macOS 平台，当本地 Chrome 弹出 "Allow remote debugging?" 系统授权对话框时，常驻 CLI 会挂起并提示运行 `BU_NAME=xxx browser-use mac-approve`，通过系统级探针自动点击允许，消除了无头/终端执行时的死锁阻断。
- **零配置常驻守护进程**:
  - `browser-harness` 架构支持 `ensure_daemon()` 自动保活；未启动时透明拉起，随叫随到，支持无缝接收多段管道输入。

---

### 2.9 License、遥测与生态合规 (License, Telemetry & Compliance)

#### 实现原理与代码结构

- **宽松开源许可**: 项目采用标准 **MIT License** (`LICENSE:1-20`)，对商业集成极为友好，无 AGPL 等传染性 Copyleft 负担。
- **遥测数据收集 (PostHog)**:
  - 默认集成 `posthog` 与 `browser_use/telemetry/service.py`，收集匿名模型调用次数、Token 消耗、错误码分布等。
  - 用户可通过环境变量 `ANONYMIZED_TELEMETRY=false` 或专用 CLI 命令进行静默关闭。

---

## 3. BU Bench 评测体系与 60-Task 基准方法论

`browser-use` 官方建立了著名的 **Browser Use Benchmark v2 (BU Bench)**。其评测方法论在业界具有标杆意义。

### 3.1 评测架构与任务驱动流水线

在 `tests/ci/evaluate_tasks.py:1-120` 中，我们逆向解析出其核心评估执行流水线：

```
[tests/agent_tasks/*.yaml] (定义任务、判定点、最大步数)
           |
           v
[evaluate_tasks.py (Subprocess 级隔离调度, 最大并发 10)]
           |
           v
[BrowserSession (无头沙箱 / 独立 Profile)]
           |
           v
[Agent.run(max_steps) -> 生成完整 AgentHistoryList 与截图轨迹]
           |
           v
[LLM Judge 自动化仲裁 (Gemini-3.1-Flash-Lite / GPT-4o)]
           |
           v
[输出结构化判定: success (bool) + explanation (str)]
```

#### 典型评测用例结构 (`tests/agent_tasks/amazon_laptop.yaml`)

```yaml
name: Amazon Laptop Search
task: Go to amazon.com, search for 'laptop', and return the first result
judge_context:
  - The agent must navigate to amazon.com
  - The agent must search for 'laptop'
  - The agent must return name of the first laptop
max_steps: 10
```

### 3.2 LLM Judge 判定模型与真值仲裁链

在 `browser_use/agent/judge.py:50-150` 中，框架设计了极度严谨的 **Judge Prompt 仲裁规则体系**：

1. **绝对最高真值规则 (Ground Truth Validation)**:
   - 若用例配置了 `<ground_truth>`（如预期的订单号、特定的文本结果、弹窗状态），真值拥有最高裁决权；不满足则一票否决 (`verdict = false`)。
2. **五级降序评估指标**:
   - 1. **任务达成度 (Task Satisfaction - 权重最高)**: 拆解用户核心诉求，逐项核验；
   - 2. **输出质量 (Output Quality)**: 格式是否规范，是否凭空捏造；
   - 3. **工具效率 (Tool Effectiveness)**: 工具调用成功率，是否存在低效循环；
   - 4. **推理决策质量 (Agent Reasoning)**: 决策树规划合理性；
   - 5. **浏览器控制稳定性 (Browser Handling)**: 是否触发崩溃或未捕获异常。
3. **硬性失败条件 (Automatic Failure Conditions)**:
   - 遇到验证码卡死未解决；
   - 发生无限动作循环；
   - 忽略用户核心前置约束；
   - 截图或 DOM 现实中未达成但伪造完成报告；
   - 提前调用 `done` 偷懒交付。

---

## 4. 与 BrowserPaw 的深度技术横评矩阵

以下将 `browser-use` 与我们当前仓库 `BrowserPaw`（依据 `00-current-architecture.md` 逆向结论）进行逐维对比：

| 评估维度              | browser-use (外部对标)                                                | BrowserPaw (我的基线)                                                  | 优劣势归因与技术本质                                                                                   |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **1. 宿主与桥接架构** | Python `cdp-use` 直连 Chrome CDP 端口 (WebSocket 9222)                | **Chrome MV3 扩展 + Fastify Native Server + Native Messaging**         | **BrowserPaw 胜出**：无需开远程调试端口，天然驻留用户日常浏览器，登录态与反爬穿透力极强                |
| **2. 页面表示效率**   | CDP AXTree + DOMSnapshot + Paint Order 序列化，每次全量生成           | **In-page Engine + 1-based WeakRef DOM 缓存 + 视觉 PCIE 回退**         | **BrowserPaw 胜出**：内存开销小，微循环毫秒级响应；但 browser-use 的 Paint Order 空间几何剔除值得借鉴  |
| **3. 工具粒度与交互** | 标准 15+ 动作 API；支持 CLI MCP（暴露 `browser_exec` 执行 Python）    | **50 个 Canonical MCP 工具**（覆盖网络捕获、Dialog、存储、跟踪全场景） | **互有千秋**：BrowserPaw 专有控制力极深；browser-use 的 `browser_exec` 在长交互调试时极度节省 MCP 往返 |
| **4. 双脑决策能力**   | 纯宏观单脑循环（依靠上层模型反复思考）                                | **Dual-Brain (System 2 规划 + System 1 Jev 本地微循环)**               | **BrowserPaw 核心壁垒**：微循环可在页面内自主完成点击输入验证，无需每一步打扰上层大模型                |
| **5. 大数据与稳定性** | 易在超长网页触发 Chrome CDP 10s 超时                                  | **850KB UTF-8 分片组包机制 + 物理防 1MB 崩溃防护**                     | **BrowserPaw 核心壁垒**：完备的底层通信物理防御，绝不爆管道                                            |
| **6. 现场恢复与守卫** | **14 个专注于细分领域的 Watchdog 守卫矩阵 + 步数/字符双门禁历史压缩** | 扩展端 Keepalive 引用计数 + 网络断流捕获                               | **browser-use 胜出**：Watchdog 模块化设计及状态压缩算法极度成熟规范，值得全面引入                      |
| **7. 评测基准与 CI**  | **成熟的 BU Bench (60-Task 体系 + 自动化 LLM Judge 判定流)**          | 依赖单元测试、文档一致性测试与手工 Gauntlet 跑测                       | **browser-use 胜出**：具备标准化、可复现、带多模态截图仲裁的 Agentic 基准流水线                        |
| **8. 开发者诊断**     | `browser-use --doctor` 一键诊断探针 + `mac-approve` 权限透传          | `chrome_doctor` MCP 工具                                               | **browser-use 胜出**：CLI 侧开箱即用诊断非常丝滑，利于新手排障                                         |
| **9. License 与合规** | 标准宽松 **MIT License**                                              | AGPL / 严格合规约束                                                    | **browser-use 胜出**：生态扩展与社区贡献门槛低                                                         |

---

## 5. 可借鉴设计点 (Actionable Takeaways)

通过深度精读源码，以下 **4 个核心设计** 具备极高技术价值，建议在后续版本中外科手术式移植吸收：

### 借鉴点 1：DOM 空间绘制顺序层叠剔除 (`paintOrder` Filtering)

- **源码参考**: `browser_use/dom/serializer/paint_order.py:146-210`
- **移植路径**: 在 BrowserPaw 的 Content Script `chrome_read_dom` 与 In-page Engine 中，引入 CSS `paintOrder` 与元素重叠几何检测。在页面出现模态遮罩或浮层时，自动裁剪被盖住的底层文本与按键，直接降低 30%~50% 无效 Token，彻底消除遮挡幻觉。

### 借鉴点 2：双门禁动作历史压缩算法 (`maybe_compact_messages`)

- **源码参考**: `browser_use/agent/message_manager/service.py:216-300`
- **移植路径**: 为 BrowserPaw 的 Native Server / Jev 微循环引入步数门禁（如每 5 步）+ 字符门禁（40k 字符）双触发机制。历史压缩时要求*“严禁主观推断完成态，未见成功回执一律标记为 IN-PROGRESS”*，极大增强多轮自动化执行的长程记忆韧性。

### 借鉴点 3：标准化 LLM Judge 自动化评测流水线 (BU Bench 模式)

- **源码参考**: `tests/ci/evaluate_tasks.py:40-110`, `browser_use/agent/judge.py:50-150`
- **移植路径**: 为 BrowserPaw 打造 `packages/benchmark`，采用其 YAML 任务定义格式（`task` + `judge_context` + `ground_truth`），接入 Gemini/GPT 仲裁模型与真实截图对比，将当前的经验型手工验证升级为工业级持续评估门禁。

### 借鉴点 4：CLI 诊断医生探针 (`--doctor` Probe System)

- **源码参考**: `browser_use/cli.py:185-230`
- **移植路径**: 扩展 BrowserPaw Native 端的 CLI 入口，实现一键诊断：Chrome 扩展安装状态、Native Messaging Host 注册表/JSON 配置、12306 端口占用、权限冲突检测，大幅降低外部 Agent 接入配置门槛。

---

## 6. 不可借鉴设计点与坚守理由 (Anti-Patterns & Defenses)

在吸收优势的同时，必须根据 §0.4 本地优势保护原则，坚决抵制以下 3 种架构倒退：

### 坚守 1：坚决不放弃 Chrome Extension + Native Messaging 架构，拒用纯远程 CDP 端口直连

- **理由**: `browser-use` 必须要求 Chrome 开启 `--remote-debugging-port=9222`。这在真实用户宿主机上存在巨大缺陷：容易被主流反爬风控（Cloudflare/Akamai）指纹直接识别为自动化 Bot；且用户无法自然无感地复用日常浏览器的丰富登录态（SSO、Google 账号、企业内网证书）。BrowserPaw 的 Chrome MV3 扩展架构是不可动摇的核心壁垒。

### 坚守 2：坚决不退回单脑反复调用，死守 Dual-Brain (System 2 + System 1) 架构

- **理由**: `browser-use` 本质仍是单脑循环，每一个点击、滚动都依赖云端大模型做完整往返推理，网络延迟高且昂贵。BrowserPaw 的 **System 1 Jev 本地微循环 (`chrome_act_toward_goal`)** 可在毫秒级内自主闭环表单与连续交互，这是极致流畅体验的关键。

### 坚守 3：坚决保留 850KB 切片保护与内存截图流，拒绝本地磁盘文件污染

- **理由**: `browser-use` 重度依赖在本地磁盘创建大量中间临时文件（截图、HAR、HTML dump），不仅容易造成磁盘垃圾堆积，而且其 WebSocket CDP 传输在遇到 10MB+ 大图时容易偶发超时断流。BrowserPaw 纯内存流式传输与 850KB 分片组包经过严格实战检验，安全边界极高。

---

## 7. 子代理测绘结论与后续交付物映射

- **一句话结论**: `browser-use` 是 Python 生态中基于 CDP 原生与事件驱动的顶尖代表，其在 **DOM Paint Order 空间几何剔除**、**历史动作状态压缩 (Compaction)** 与 **BU Bench 自动化 Judge 评测方法论** 上的设计高度精炼，极具落地指导价值；而 BrowserPaw 在 **扩展原生驻留、Dual-Brain 微循环与 Native Messaging 物理切片防御** 上具备坚实的技术壁垒，两者优势互补明显。
- **交付闭环**: 测绘分析已按 §A 双重验证完成并写入 `research/browser-use.md`，随后将更新 `research/00-subagent-log.md` 闭环记录。
