# BrowserPaw Skill 体系现状审计报告 (2026-09)

> **审计基准**：基于工作区当前代码状态（73 个未提交变更，HEAD 为 9a0486b），深入对照 packages/shared/src/tools.ts、app/chrome-extension/、app/native-server/ 以及三处镜像 Skill 目录（skill/、skills/browserpaw/、plugins/browserpaw/skills/browserpaw/）。

---

## 1. 主 SKILL.md 逐节结构清单与体量分析

- **体量口径**：未提交变动前非空行 153 行（约 18.7KB，总 204 行）；合入当前未提交变更后总行数为 **215 行**（非空行 158 行，文件大小 19,476 字节）。
- **逐节结构清单**（基于当前工作区 skill/SKILL.md 全文 215 行）：

| 章节编号与标题                                        | 行号区间 | 总行数 | 行数占比 | 核心内容要点                                                                                 |
| :---------------------------------------------------- | :------: | :----: | :------: | :------------------------------------------------------------------------------------------- |
| **Frontmatter & Intro**                               |   1–11   |   11   |   5.1%   | 元数据声明（name/description）及 BrowserPaw 原生会话特性简介。                               |
| **## 1. Activation Triggers & Tool Selection Matrix** |  12–34   |   23   |  10.7%   | 意图触发场景矩阵，包含导航、读取、微循环、媒体注入、弹窗清除等 14 类推荐工具。               |
| **## 2. Hierarchical Dual-Brain Mental Model**        |  35–64   |   30   |  14.0%   | 双脑分工心智模型：Caller LLM (System 2 宏观规划) 与 Local Server (System 1 Jev 微循环)。     |
| **## 3. Execution Hierarchy & 6-Tier Routing Ladder** |  65–77   |   13   |   6.0%   | 6 层路由优先级阶梯：Tier 1 微循环 (70%) 到 Tier 5 CDP 逃生门 (<0.1%)。                       |
| **## 4. Standard Dual-Brain Execution Loop**          |  78–119  |   42   |  19.5%   | 四步标准执行闭环：导航定向、委派微循环、升阶干预兜底、验证与恢复机制。                       |
| **## 5. Primary Tool Contracts & Delta Piggybacking** | 120–179  |   60   |  27.9%   | 9 个核心高频工具的输入/输出字典及 includeDelta: true 变更伴随传输机制。                      |
| **## 6. Hard Operational Constraints & Guardrails**   | 180–195  |   16   |   7.4%   | 6 大刚性运行红线：1-based 索引、参数不变性、后台无侵扰、原生 isTrusted、标签保护、Zero-RTT。 |
| **## 7. Specialized Capabilities & Diagnostics**      | 196–206  |   11   |   5.1%   | 专项能力指引：文件上传、原生弹窗响应、JS 即席执行、人工接管、动态工具暴露与诊断。            |
| **## 8. Progressive Disclosure References**           | 207–215  |   9    |   4.2%   | 4 篇下沉技术参考文档（双脑、批处理、多模态、排障）的渐进式披露链接。                         |

---

## 2. 对照真实工具集：过时、错误与幽灵内容清单

对照 packages/shared/src/tools.ts（当前活跃 49 工具）与底层实现，逐条排查 Skill 各文件中的不一致点：

1. **skill/SKILL.md:133-136**
   - **问题**：chrome_read_dom 输入参数清单遗漏了新增的核心提速参数 fast: boolean、format: "compact"|"html"|"fast" 与 legacyVisibility: boolean。
   - **正确事实**：[packages/shared/src/tools.ts:1593](/packages/shared/src/tools.ts:1593) 及 [read-dom.ts:18](/app/chrome-extension/entrypoints/background/tools/browser/read-dom.ts:18) 已正式引入 fast-snapshot.ts 极速原子快照分支（10–30ms、≤15KB），Skill 未能暴露该核心能力。
2. **skill/SKILL.md:139-143 与 skill/SKILL.md:30**
   - **问题**：chrome_dismiss_overlay 参数契约与默认值描述不精确。第 30 行推荐传参写为 { maxOverlays: 3 }，而第 140 行遗漏了 windowId 与 sessionContext。
   - **正确事实**：[packages/shared/src/tools.ts:3125](/packages/shared/src/tools.ts:3125) 与 [dismiss-overlay.ts:8](/app/chrome-extension/entrypoints/background/tools/browser/dismiss-overlay.ts:8) 中，默认 maxOverlays 为 5，支持参数包含 tabId, windowId, maxOverlays, waitForSettle, sessionId, sessionContext。
3. **skill/SKILL.md:164 与 skill/references/batch-pipeline.md:20, 23**
   - **问题**：在批处理中列出 fill_form 与 scroll 动作，易使 Agent 混淆并误以为存在已被删除的同名独立顶级工具。
   - **正确事实**：独立工具 chrome_fill_form、chrome_scroll、chrome_scroll_to_text 已被彻底删除（[packages/shared/src/tools.ts:33](/packages/shared/src/tools.ts:33) 及对应实现文件已被 git rm）。虽然 [batch-actions.ts:525](/app/chrome-extension/entrypoints/background/tools/browser/batch-actions.ts:525) 内部仍保留了这两类子动作分支，但文档必须明确注明其仅为批处理内部子动作，防止外部 Agent 误调用不存在的顶级工具。
4. **skill/SKILL.md:156-160 及 references/batch-pipeline.md**
   - **问题**：chrome_fill_index 与批处理填充未描述新增的底层防漂移与表单语义模糊恢复能力。
   - **正确事实**：当前填充逻辑已统一重构至 [fill-core.ts:1](/app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:1) 及 [form-semantic-matcher.ts:1](/app/chrome-extension/utils/form-semantic-matcher.ts:1)（由 fill-index.ts:101 与 batch-actions.ts:457 共同调用），具备 CDP 物理按键直推、失焦重试与模糊标签自愈特性，Skill 应指导 Agent 在填充时免去多余重试包裹。
5. **skill/recipes/README.md:47-49**
   - **问题**：网站踩坑应对中依然建议：“Gotcha: Has a full-screen cookie consent modal... Fix: Call chrome_read_dom and dismiss modal first”，方案过时繁琐。
   - **正确事实**：[packages/shared/src/tools.ts:3114](/packages/shared/src/tools.ts:3114) 已新增 chrome_dismiss_overlay 独立工具，且 [packages/shared/src/tools.ts:493](/packages/shared/src/tools.ts:493) 中 chrome_navigate 和 chrome_read_dom 均已原生集成 dismissOverlays: true，无需先耗费 1 轮全量 dump DOM。
6. **skill/config/mcp-config.json:36, 74-81**
   - **问题**：行 36 注释中声明全量工具为 full (48 tools) 口径陈旧；行 74–81 的 autoApprove 列表漏掉了新交互工具 chrome_dismiss_overlay。
   - **正确事实**：当前全量工具为 49 个（代码证据 [packages/shared/src/tools.ts:60](/packages/shared/src/tools.ts:60) 及 [docs/TOOLS.md:7](/docs/TOOLS.md:7)）；chrome_dismiss_overlay 作为安全无副作用的清理工具应列入客户端自动审批推荐表。
7. **skill/config/mcp-config.json:31**
   - **问题**：stdio 启动参数中硬编码了开发者本机的绝对路径 D:\workspace\mcp-chrome-master\mcp-chrome-master\...。
   - **正确事实**：作为通用的客户端集成配置模板，应使用占位符（如 <PATH_TO_BROWSERPAW>/app/native-server/dist/mcp/mcp-server-stdio.js），避免给外部使用者造成跨环境路径污染与启动失败。
8. **skill/references/dual-brain-jev.md:25, 39**
   - **问题**：使用了 LaTeX 数学公式语法 $\le$（$\le$250 lines 与 forced $\le 5$）。
   - **正确事实**：通用 Markdown 及多平台客户端对 LaTeX 定界符渲染支持脆弱，违背了无 LaTeX 要求，应规范统一为 Unicode 符号 ≤。
9. **skill/references/visual-fallback.md:83**
   - **问题**：多模态动作列表遗漏了部分支持的操作类型（仅列出 11 种）。
   - **正确事实**：根据 [packages/shared/src/tools.ts:2856](/packages/shared/src/tools.ts:2856)，chrome_computer 的 action 枚举共包含 16 种动作（补全了 scroll_to, fill_form, resize_page, zoom, screenshot）。
10. **skill/SKILL.md:82 (Step 1 示例)**
    - **问题**：导航调用示例仅包含 { url: "https://example.com" }，未提及原生历史后退/前进与弹窗清理。
    - **正确事实**：[packages/shared/src/tools.ts:438](/packages/shared/src/tools.ts:438) 中已原生支持 action: "back" | "forward" 与 dismissOverlays: true，应在示例中展示其组合价值。

---

## 3. 三个镜像目录差异检查与同步机制剖析

### 3.1 目录差异比对结果

审计覆盖的三个镜像目录包含完全相同的 12 个文件集合：

config/ (doctor.mjs, mcp-config.json, repair.bat, repair.ps1, TROUBLESHOOTING.md, TROUBLESHOOTING.zh-CN.md)
recipes/ (README.md, template.md)
references/ (batch-pipeline.md, dual-brain-jev.md, visual-fallback.md)
SKILL.md

- **skill/ 与 skills/browserpaw/**：**100% 完全一致**。12 个文件的 SHA-256 哈希值逐一吻合，两者完全同源镜像。
- **plugins/browserpaw/skills/browserpaw/ 与前两者**：
  - **差异现象**：所有 .md 和 .json 文件的哈希与前两者不同；而 doctor.mjs、repair.bat、repair.ps1、recipes/template.md 的哈希则保持 100% 完全相同。
  - **根本原因**：经对比还原，该差异纯粹由 [scripts/sync-skills.mjs:30](/scripts/sync-skills.mjs:30) 的自动化转换规则造成：同步脚本在写入包含 plugins 的目标路径时，针对 .md 与 .json 文件执行了字符串宏替换：
    1. \bchrome_ 替换为 browserpaw_；
    2. \bget_windows_and_tabs\b 替换为 browserpaw_get_windows_and_tabs。
  - **结论**：三份目录之间**不存在任何未同步的游离修改或代码漂移**，差异严格可逆且与构建流水线完全吻合。

### 3.2 sync-skills.mjs 同步逻辑与哈希机制运作原理

1. **权威源头与派发流水线** ([scripts/sync-skills.mjs:5](/scripts/sync-skills.mjs:5))：
   - 脚本将根目录 skill/ 设定为唯一绝对真相源（Canonical Source）。
   - 目标列表覆盖仓库内镜像（skills/browserpaw、plugins/browserpaw/skills/browserpaw）与外部环境路径（如 C:/Users/Lenovo/.gemini/config/skills/...）。遇到不存在的外层目录时自动安全跳过。
2. **插件化前缀隔离机制**：
   - 区分普通目录（保持原生 chrome_* 契约）与插件目录（注入 browserpaw_* 前缀），保证不同宿主插件体系命名空间隔离。
3. **哈希版本防篡改机制 (.browserpaw-managed.json)** ([scripts/sync-skills.mjs:53](/scripts/sync-skills.mjs:53))：
   - 对于标记了 managed: true 的目标，同步完成后基于最终生成的 SKILL.md 内容生成 SHA-256 哈希值。
   - 输出结构化管理清单（包含 contentHash、updatedAt、lastSync），用于后续在外部运行时快速检测文件是否被非预期篡改。

---

## 4. 通用 Agent Skill 最佳实践违规点清单

对照通用 Agent Skill 规范（精准路由、职责分层、信息下沉、中立客观、平台无关），梳理现有 SKILL.md 的 5 大违规点：

| 违规点类别                                   | 对应文件及行号                                                                                                       | 现状具体表现                                                                                                                                                     | 最佳实践整改建议                                                                                                                               |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 路由描述营销化，缺失精准场景约束**      | [skill/SKILL.md:3](/skill/SKILL.md:3)                                                                                | description 堆砌 "High-efficiency, zero-hallucination", "Hierarchical Dual-Brain", "Fast Semantic Micro-Loop" 等内部架构形容词，未陈述精确的触发条件与排除条件。 | description 是路由决策的唯一入口。应改为：“当用户需要通过 Chrome 浏览网页、自动化提交表单、抓取动态数据、执行复杂交互时使用”，剔除主观形容词。 |
| **2. 主体过载：工具参数字典大量侵占主文档**  | [skill/SKILL.md:120](/skill/SKILL.md:120)                                                                            | 第 5 节（工具契约）占用 60 行（占比高达 27.9%），巨细靡遗罗列 9 个工具的 Input/Output 字段，与 MCP 本身下发的 JSON Schema 产生大量冗余。                         | 主 SKILL.md 应仅传达“决策编排逻辑与核心约束”，所有工具字段、类型定义应彻底下沉至 references/，为 Agent 上下文节省约 30% Token 并消除漂移隐患。 |
| **3. 概念重复与多章节过度重叠**              | [skill/SKILL.md:35](/skill/SKILL.md:35)                                                                              | 第 2 节（双脑心智模型）、第 3 节（6-Tier 阶梯）、第 4 节（4 步执行闭环）反复用 ASCII 框图、表格、步骤条重复表述同一套“宏观调微观、失败则升阶”的逻辑。            | 合并精简核心交互模式，保留一张简洁决策流程图或阶梯表即可，去除 50+ 行重复阐述。                                                                |
| **4. 浮夸与绝对化用语残留 (Marketing Hype)** | [skill/SKILL.md:3](/skill/SKILL.md:3)<br>[visual-fallback.md:17](/skill/references/visual-fallback.md:17)            | 包含 zero-hallucination（零幻觉，非真）、slashing token consumption by 60–85%（推销语）、Zero Coordinate Drift、Industrial Full-Page Capture 等主观修饰。        | 严格去营销化，替换为中立工程技术术语（如“基于 1-based 索引的高保真定位”、“支持卡片聚合摘要”、“高 DPI 视口重采样”）。                           |
| **5. 宿主环境硬编码与厂商平台泄漏**          | [mcp-config.json:31](/skill/config/mcp-config.json:31)<br>[TROUBLESHOOTING.md:6](/skill/config/TROUBLESHOOTING.md:6) | 配置文件包含开发者本地绝对路径；排障手册显式点名 7 家外部商业平台。                                                                                              | 配置文件使用标准环境变量或占位符，保持 Skill 资产的跨平台中立与分发纯度。                                                                      |
