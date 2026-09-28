# 调研对象粗筛与优先级决策矩阵 (01-triage.md)

> **编制依据**: §B 粗筛门禁（防 token 平铺浪费）与 §2 调研对象清单
> **矩阵定义**: 行 = 10 个活跃开源项目，列 = 九大核心分析维度；每格评估为 **高 / 中 / 跳过**，且对所有「跳过」格提供明确的技术决策理由。
> **深挖范围准则**: 仅将深入算力与子代理资源投向：Type A/B 全格 + Type C/D 指定核心格 + Type E 长板格。

---

## 1. 九维分析矩阵总览

| 调研对象 (类型)                     | 1. 桥接/会话层 | 2. 页面表示与Token效率 | 3. 工具抽象(MCP/CLI) | 4. 跨页/多场景寻址 | 5. 现场恢复与自愈 | 6. 会话与隔离 | 7. 安全边界 | 8. 安装与接入体验 | 9. License与合规风险 | 综合建议                          |
| ----------------------------------- | -------------- | ---------------------- | -------------------- | ------------------ | ----------------- | ------------- | ----------- | ----------------- | -------------------- | --------------------------------- |
| **BrowserOS** (Type A)              | **高**         | **高**                 | **高**               | **高**             | **高**            | **高**        | **高**      | **高**            | **高**               | **全格深挖**（单独立项子代理）    |
| **browser-use** (Type B)            | **高**         | **高**                 | **高**               | **高**             | **高**            | **高**        | **高**      | **高**            | **高**               | **全格深挖**（单独子代理）        |
| **agent-browser** (Type B)          | **高**         | **高**                 | **高**               | **高**             | **高**            | **高**        | **高**      | **高**            | **高**               | **全格深挖**（单独子代理）        |
| **playwright-mcp** (Type C)         | 中             | **高**                 | **高**               | 中                 | **高**            | 跳过          | 中          | 中                | 中                   | **定向深挖 2, 3, 5**              |
| **chrome-devtools-mcp** (Type C)    | **高**         | 中                     | **高**               | 中                 | 中                | 跳过          | **高**      | 中                | 中                   | **定向深挖 1, 3, 7**              |
| **Agent360dk/browser-mcp** (Type D) | **高**         | 中                     | 中                   | 中                 | **高**            | **高**        | 中          | 中                | 中                   | **定向深挖 1, 5, 6**              |
| **nanobrowser** (Type D)            | 中             | 中                     | **高**               | 中                 | 中                | 中            | 中          | **高**            | 中                   | **定向深挖 3, 8**                 |
| **stagehand** (Type E)              | 跳过           | **高**                 | 中                   | 跳过               | **高**            | 跳过          | 跳过        | 跳过              | 中                   | **长板深挖 2, 5 (自愈/重放)**     |
| **skyvern** (Type E)                | 跳过           | **高**                 | **高**               | 跳过               | 中                | 跳过          | 跳过        | 跳过              | 中                   | **长板深挖 2, 3 (视觉/统一端点)** |
| **steel-browser** (Type E)          | 中             | 跳过                   | 中                   | 跳过               | 跳过              | **高**        | **高**      | 跳过              | 中                   | **长板深挖 6, 7 (云端隔离/安全)** |

---

## 2. 「跳过」格决策理由库 (Skip Rationales)

- **playwright-mcp [维6 会话与隔离 - 跳过]**: Playwright MCP 依赖原生 Playwright BrowserContext，对于用户宿主真实浏览器（保留日常登录态、多扩展共存）的会话隔离无直接参考价值，BrowserPaw 采用的 Tab Group 会话绑定更为原生。
- **chrome-devtools-mcp [维6 会话与隔离 - 跳过]**: 该项目为官方 DevTools 单目标调试协议映射，设计上即为单目标/当前页面一对一附着，不存在复杂的多 Agent 并发与标签页隔离架构。
- **stagehand [维1 桥接/会话层、维4 寻址、维6 隔离、维7 安全、维8 安装 - 跳过]**: Stagehand 本质是基于 Playwright/Puppeteer 之上的高阶 Agentic SDK，不具备底层原生桥接通信创新，其价值高度集中于 `observe/act/extract` 抽象层与选择器自愈。
- **skyvern [维1 桥接、维4 寻址、维6 隔离、维7 安全、维8 安装 - 跳过]**: Skyvern 重度依赖服务端 Python 环境与 Computer Vision 模型推理，其跨页与安装模型与基于轻量 Chrome 扩展 + Native Server 的 BrowserPaw 完全不同道，仅参读其长板（视觉引导与统一端点）。
- **steel-browser [维2 页面表示、维4 寻址、维5 恢复、维8 安装 - 跳过]**: Steel 为云端托管型浏览器基础设施（Headless/Remote Browser SaaS），其 DOM 提取与恢复策略为传统 Puppeteer 封装，仅参读其企业级会话沙箱与凭据安全边界。

---

## 3. 阶段二子代理分工与深挖计划

根据 §D 子代理调度纪律硬性要求：

1. **子代理 1 (Agent-BrowserOS)**: 独立负责 Type A **browseros-ai/BrowserOS** 全格深挖，重点测绘 `claw-server-rust`、`browser-core`、`browser-mcp` 与 Chromium fork 代价收益。产出 `research/browseros.md`。
2. **子代理 2 (Agent-BrowserUse)**: 负责 Type B **browser-use/browser-use** 全格深挖，重点测绘 `browser_use/` Python DOM 编号、动作压缩与 BU Bench。产出 `research/browser-use.md`。
3. **子代理 3 (Agent-AgentBrowser)**: 负责 Type B **vercel-labs/agent-browser** 全格深挖，重点测绘 Rust CLI 形态、`@eN` 短引用与 Tool Profile。产出 `research/agent-browser.md`。
4. **子代理 4 (Agent-StandardsAndExtensions)**: 负责 Type C & D 重点格深挖（playwright-mcp, chrome-devtools-mcp, browser-mcp, nanobrowser）。产出 `research/standards-and-extensions.md`。
5. **子代理 5 (Agent-InfraWorkflows)**: 负责 Type E 长板深挖（stagehand 自愈选择器, skyvern 混合端点, steel 会话隔离）。产出 `research/infra-workflows.md`。

---

## 4. 门禁检查点 (§B 门禁)

- [x] 行覆盖 10 个活跃开源项目，列覆盖 9 大分析维度；
- [x] 每个「跳过」格均具备充分的技术决策理由；
- [x] 本地优势保护明确（Dual-Brain、1-based WeakRef DOM、850KB UTF-8 Slicing 等绝不倒退）；
- [x] 子代理分工配额满足 §D 纪律，各子代理职责与产出边界清晰。
