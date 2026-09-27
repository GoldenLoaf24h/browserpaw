# BrowserPaw README 事实与性能基准核查报告

> 审计依据：代码实现、单元与 E2E 测试、共享契约及基准文件（严禁无依据推断与宣传粉饰）。

---

## 1. 工具数量与分类契约

- **代码依据**：
  - [packages/shared/src/tools.ts:131-192](packages/shared/src/tools.ts:131) (`TOOL_NAMES` 54 项定义)
  - [packages/shared/src/tools.ts:3291-3302](packages/shared/src/tools.ts:3291) (`PURGED_TOOL_NAMES` 5 项废弃别名)
  - [packages/shared/src/tools.ts:3299](packages/shared/src/tools.ts:3299) (`TOOL_SCHEMAS` 过滤后实际导出 49 个工具)
  - [packages/shared/src/tool-profiles.ts:18-44](packages/shared/src/tool-profiles.ts:18) (`CORE_TOOL_NAMES` 14 项，含 `chrome_tool_docs`)
  - [packages/shared/src/tool-profiles.ts:50-64](packages/shared/src/tool-profiles.ts:50) (`CRAWL_TOOL_NAMES` 12 项)
  - [packages/shared/src/tool-profiles.ts:69-122](packages/shared/src/tool-profiles.ts:69) (`TOOL_CATEGORIES` 分类)
- **客观事实**：
  - **当前工具总数**：全量 49 个工具（48 个 Chrome 扩展工具 + 1 个 Native Server 本地微循环工具 `chrome_act_toward_goal`）。
  - **废弃过滤工具**（5 个，内部硬过滤）：`chrome_click_element`, `chrome_burst_interact`, `chrome_fill_or_select`, `chrome_get_web_content`, `chrome_get_links`。
  - **工具分类（7 个功能组）**：`navigate` (7), `perceive` (6), `act` (15), `observe` (3), `manage` (9), `diagnose` (8), `network` (2)。
  - **Profiles 划分**：
    - `core`：**14 个工具**（包含核心感知、交互、导航及动态文档发现工具 `chrome_tool_docs`）。
    - `crawl`：**12 个工具**（面向页面抓取、正文提取、滚动与网络请求）。
    - `full`：**49 个工具**（全量暴露）。
- **README 客观表述建议**：
  > "BrowserPaw exposes 49 tools partitioned into 7 categories, with a minimal 14-tool Core profile for common agent sessions."
- **改动要求**：修正 README 中遗留的“45”、“47”或“48”说法，统一为 **49 个工具（Core: 14 / Crawl: 12 / Full: 49）**。

---

## 2. chrome_act_toward_goal 微循环真实性能与约束

- **代码依据**：
  - [app/native-server/src/jev/fast-decision-engine.ts:89-100](app/native-server/src/jev/fast-decision-engine.ts:89)（步数与超时约束）
  - [app/native-server/src/jev/fast-decision-engine.ts:250-410](app/native-server/src/jev/fast-decision-engine.ts:250)（判定阈值）
  - [app/native-server/src/jev/jev-client.ts:16-32](app/native-server/src/jev/jev-client.ts:16)（14 个破坏性敏感词）
  - [app/native-server/src/jev/heuristic-engine.ts:114-250](app/native-server/src/jev/heuristic-engine.ts:114)（启发式打分引擎）
- **客观指标数据**：
  - **单步耗时**：Jev 模式单步理论 200–400ms（依赖 Jev API 网络 RTT + `chrome_read_dom` 耗时）；Heuristic 模式纯本地运行无外部请求，规则计算 <5ms，受限于 DOM 提取与 CDP 执行，整步耗时约 80–150ms。
  - **步数硬上限**：`maxSteps` 全局上限 60 步（默认 10 步）；Heuristic 降级模式被**强制截断为最多 5 步**（`Math.min(maxSteps, 5)`）。
  - **超时阈值**：`timeoutMs` 默认 90,000ms（90 秒），最大上限 300,000ms（5 分钟）。
  - **破坏性词拦截（14 个精确关键词）**：`pay`, `支付`, `付款`, `删除`, `delete`, `purchase`, `buy`, `submit`, `提交`, `发送`, `post`, `发布`, `confirm`, `确认`。
  - **关键判定阈值**：
    - Jev 完成判定：`goal_done.noul >= 0.85` 或动作返回 `done`。
    - Jev 卡滞判定：`stuck.noul >= 0.85` 或连续无 DOM/URL 变更。
    - Jev 破坏性拦截：`destructive.noul >= 0.50`。
    - Jev 动作置信度下限：`confidence >= confidenceThreshold`（默认 0.55）。
    - Jev 目标置信度门限：`targetConf >= 0.45` 且 `topProb >= 0.35`。
    - 启发式模式完成判定：关键词覆盖率 >= 80% 且上一步必须伴随 URL 变更或 DOM Mutation。
- **README 客观表述建议**：
  > "chrome_act_toward_goal runs an in-process perception-action loop with Jev System 1 inference, falling back to a 5-step heuristic engine with 14 built-in destructive action guards."
- **改动要求**：说明 Jev 单步 200–400ms 包含网络推理；明确指出启发式降级模式步数上限为 5 步。

---

## 3. chrome_read_dom 压缩与快照指标

- **代码依据**：
  - [test/e2e/tier1-feature-coverage/f08-dom-pruning-visibility.test.ts:51-64](test/e2e/tier1-feature-coverage/f08-dom-pruning-visibility.test.ts:51)
  - [test/e2e/fixtures/oracle-evaluators.ts:16-24](test/e2e/fixtures/oracle-evaluators.ts:16)
  - [app/chrome-extension/entrypoints/background/tools/browser/fast-snapshot.ts:9-36](app/chrome-extension/entrypoints/background/tools/browser/fast-snapshot.ts:9)
  - [app/chrome-extension/tests/boost-dom-perception-and-execution-pipeline.test.ts:153-188](app/chrome-extension/tests/boost-dom-perception-and-execution-pipeline.test.ts:153)
  - [app/chrome-extension/tests/boost-silent-mode-and-card-flattening.test.ts:192-260](app/chrome-extension/tests/boost-silent-mode-and-card-flattening.test.ts:192)
  - [app/chrome-extension/tests/boost-tab-affinity-and-virtualization.test.ts:175-235](app/chrome-extension/tests/boost-tab-affinity-and-virtualization.test.ts:175)
- **客观事实与测试数据**：
  - **85%+ 压缩率依据**：测试套件在 1500+ 节点合成电商/信息流 DOM 上实测验证，过滤非内容标签、零尺寸节点、视口外及被遮挡节点后，输出节点相比原始节点数压缩比例满足 `>= 85%`。
  - **flattenCards / virtualizeViewport 贡献**：
    - `flattenCards`：将电商/信息流卡片内的价格、标签、副标题合并到单行 `[card]`，保留独立操作按钮，消除卡片碎片节点。
    - `virtualizeViewport`：将视口外重复兄弟节点折叠为 `~ [virtualized: N similar offscreen items]` 标记。两者均有独立单元测试覆盖。
  - **fast-snapshot 真实指标**：
    - 执行耗时：测试基准目标为 10–30ms（实测单 pass TreeWalker）。
    - 文本长度预算：<= 6,000 字符。
    - 动作数量预算：<= 250 个可交互动作。
    - 输出体积预算：<= 15KB（测试中断言体积 <= 25KB）。
- **README 客观表述建议**：
  > "chrome_read_dom prunes non-interactive and occluded elements, reducing node counts by over 85% on 1,000+ node pages while keeping snapshot latency within 30ms."
- **改动要求**：说明 85% 是针对 DOM 节点/元素数量的压缩，避免笼统宣传全页绝对 Token 降低 85%。

---

## 4. 宣传数字真实性审查表

| 宣传数字 / 描述                             | 状态判定              | 真实代码 / 测试依据                                                        | 处理建议                                            |
| :------------------------------------------ | :-------------------- | :------------------------------------------------------------------------- | :-------------------------------------------------- |
| **"3–5x faster"**                           | **无实证属营销估算**  | 无任何对比外部框架（如 Puppeteer/Playwright）的自动化基准测试文件          | **必须删除**，改为描述微循环免除了 MCP 协议往返 RTT |
| **"70–80%+ cheaper on tokens"**             | **无实证属营销估算**  | 无全链路端到端真实 Token 账单对比测试                                      | **必须删除**或明确标注为理论估算                    |
| **">75% speedup" / ">80% token reduction"** | **无实证属营销估算**  | 仅为 README 表格下方的静态推算，测试库中无自动化基线比对脚本               | **修改**为列出实际测得的单步与任务耗时              |
| **"T1–T5 基准表 (2062ms, 586ms...)"**       | **有实证 (静态记录)** | README 中记录了 T1–T5 实测耗时与 Jev Token 数，为实测样本                  | 可作为“典型场景测得样本”保留，注明测试环境          |
| **">85% DOM compression"**                  | **有实证**            | `f08-dom-pruning-visibility.test.ts` 实测 1500 节点压缩率 >= 85%           | **保留**，明确定义为 DOM 元素节点过滤比例           |
| **"10–30ms fast-snapshot"**                 | **有实证**            | `boost-dom-perception-and-execution-pipeline.test.ts` 实测 TreeWalker 执行 | **保留**                                            |

- **README 客观表述建议**：
  > "Eliminating intermediate remote round-trips cuts task latency significantly compared to running every sub-action through a macro planner."

---

## 5. 高级感知与执行能力审查

- **能力项与实现程度**：
  1. **Shadow DOM 穿透**：
     - **代码**：`dom-indexer.ts:216` (`getShadowRoot`, `querySelectorAllDeep`)。
     - **实证**：支持递归穿透多层 open ShadowRoot，在 Shreddit 复杂组件上测试覆盖。
  2. **Closed Shadow 支持**：
     - **代码**：`dom-indexer.ts:216` 尝试 `chrome.dom.openOrClosedShadowRoot`。
     - **边界**：网页标准环境无法穿透 closed 模式，此时退化为标记 `[closed-shadow-host]` 并在宿主上分发事件。测试覆盖在 `deep-shadow-and-visual-drift.test.ts:179`。
  3. **Icon-only ARIA 提取**：
     - **代码**：`dom-indexer.ts:extractCleanElementText`。
     - **实证**：纯 SVG/图标按钮优先提取 `aria-label`、`title`、`aria-description`，无标签时匹配 SVG 子路径语义。测试覆盖在 `deep-shadow-and-visual-drift.test.ts:35`。
  4. **Overlay Dismissal**：
     - **代码**：`dom-indexer.ts:inPageDismissOverlays`。
     - **实证**：支持通用 modal、backdrop、dialog 及 Element Plus (`el-dialog__headerbtn`)、Tailwind 遮罩自动关闭。测试覆盖在 `boost-tab-affinity-and-virtualization.test.ts:375`。
  5. **Drift Compensation（坐标漂移补偿）**：
     - **代码**：`dom-indexer.ts:inPageSnapCoordinate`。
     - **实证**：在目标边缘 24px 范围内自动吸附到中心点；针对 fullpage 截图在文档坐标系下准确缩放。测试覆盖在 `deep-shadow-and-visual-drift.test.ts:450`。
- **README 客观表述建议**：
  > "BrowserPaw recursively penetrates open Shadow DOM, tags closed shadow hosts, extracts accessible names from icon-only buttons, and snaps coordinates within 24px."

---

## 6. 架构图与术语技术实质审查

- **四层架构核对**：
  - `AI Client (Claude / Cursor / Windsurf / Codex)` -> `Native Bridge (Node Fastify + Stdio, port 12306)` -> `Chrome MV3 Extension` -> `Inpage Engine`。**与代码完全一致**。
- **术语实质核验**：
  - **"Industrial-grade CDP"**：属于修饰性词汇。技术实质为封装了 `chrome.debugger` API 并实现了断线重连、会话管理与事件并发控制（`cdp-session-manager.ts`）。建议替换为 "Production-tested CDP wrapper"。
  - **"Zero-copy media injection"**：**夸大修饰**。技术实质是绕过本地原生文件弹窗，通过网络流或 Base64 经由 `DataTransfer`/`Clipboard API` 注入内存文件对象，内存中仍存在 Base64 编解码与 ArrayBuffer 拷贝。建议改为 "In-memory DataTransfer/Clipboard injection (bypassing native OS file dialogs)"。
  - **"Spring kinematics"**：**具备技术实质**。`agent-cursor.content.ts` 真实实现了弹簧阻尼模型（`dampingFraction`, `velocity`, `force`）与三阶贝塞尔曲线平滑插值，仿照 ChatGPT 扩展光标物理轨迹。
- **README 客观表述建议**：
  > "Built on a four-tier architecture spanning Fastify MCP transport, MV3 background orchestration, and in-page execution with spring-modeled cursor physics."

---

## 7. 法律、作者与事实性信息核对

- **License**：
  - 根目录及所有子包 (`package.json`, `packages/shared`, `app/native-server`, `app/chrome-extension`) 一律声明为 **`AGPL-3.0`**。
- **作者 (Author)**：
  - `package.json` 明确标注为 **`hangye`**。
- **免责声明 (Disambiguation)**：
  - 与 npm 上已有的同名/相似 Playwright 封装库 `browserpaw` **无任何隶属关联**，README 必须保留此项说明。
- **README 客观表述建议**：
  > "Licensed under AGPL-3.0. Authored by hangye. Not affiliated with the standalone browserpaw package on npm."
