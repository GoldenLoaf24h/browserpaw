<div align="center">
  <img src="./docs/images/logo.png" width="128" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>在已登录的活跃 Chrome 会话中，以确定性安全与 Token 纪律执行浏览器自动化。</b></p>
  <p>
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases"><img src="https://img.shields.io/badge/release-v4.1.2-blue.svg" alt="Release v4.1.2" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-green.svg" alt="License AGPL-3.0" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.6.0-brightgreen.svg" alt="Node >= 22.6.0" />
    <img src="https://img.shields.io/badge/chrome-MV3-orange.svg" alt="Chrome MV3" />
    <img src="https://img.shields.io/badge/mcp-2024--11--05-blueviolet.svg" alt="MCP 2024-11-05" />
  </p>
  <p>
    <b><a href="./README.md">English</a></b> | <b><a href="./README.zh-CN.md">简体中文</a></b>
  </p>
  <p>
    <a href="#-快速开始">快速开始</a> ·
    <a href="#%EF%B8%8F-系统架构与执行流水线">系统架构</a> ·
    <a href="#%EF%B8%8F-mcp-工具矩阵与配置档">工具目录</a> ·
    <a href="./INSTALL.md">安装指南</a> ·
    <a href="./docs/TOOLS.md">Schema 字典</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">版本发布</a>
  </p>
</div>

---

**BrowserPaw** 是一款专为生产环境设计的 Chrome MV3 扩展、原生消息传递 (Native Messaging) IPC 桥接器与本地模型上下文协议 (MCP) 服务器，旨在让 AI 编程智能体能够直接操控用户**当前正在使用的、已完成认证的 Google Chrome 浏览器**。

与启动全新空白 Profile、易被反爬检测拦截并丢失登录态的传统无头框架（Puppeteer、Playwright）不同，BrowserPaw 在用户现有会话中原地运作。它将包含 **52 项规范工具的确定性 CDP/DOM 引擎**与可选的**双脑感知微循环**（TypeSafe Jev System One 或本地零成本启发式引擎）、严格的多标签页会话亲和性账本以及 Token 纪律化的观察流水线紧密结合。

---

## 🎯 为什么选择 BrowserPaw

BrowserPaw 从底层工程设计出发，系统性攻克了浏览器 AI 智能体在真实场景下的各类失控与失效陷阱：

- **现有认证会话就地复用（零 Profile 复制）**：通过 Manifest V3 扩展与 Native Messaging IPC 直接运行于用户活跃的 Chrome 进程中。无缝继承现有登录态、HttpOnly 会话 Cookie、企业 SSO/MFA 令牌以及硬件安全密钥，无需复制用户数据目录、克隆磁盘或触发反爬风控。
- **会话亲和性与多标签页隔离**：通过显式的归属状态机严格区分**任务后台专属标签页** (`chrome_task`, `background: true`)、**用户借用标签页** (`chrome_request_human_intervention`) 与**用户主活动标签页**。支持智能体在后台并行执行任务，绝不抢夺窗口焦点、打断用户正在进行的输入或误关闭用户页面。
- **Token 纪律化观察与上下文外计算**：将原始庞大的 DOM 树修剪为基于 1 起始的紧凑交互索引（`chrome_read_dom`），支持增量变更通知（`includeDelta`）、重复卡片信息流扁平化（`flattenCards`）与视口外元素虚拟化（`virtualizeViewport`）。针对复杂的多步编排，提供沙箱化本地 Node.js REPL（`browserpaw repl`），通过受租约保护的本地文件句柄就地过滤海量 DOM 节点与网络追踪，避免原始数据涌入大模型上下文。
- **失败关闭与不可重放的派发安全**：具有副作用的输入动作（`Input.insertText`、鼠标点击派发、表单提交）具备严格的执行确认边界。一旦动作跨越执行边界但未收到确定性确认，立即返回 `status: 'unknown'` 并置 `retry: false`，坚决拒绝盲目重试，杜绝重复扣费、表单重复提交或 `contenteditable` 编辑器富文本损坏。
- **人机协同与安全升级机制**：内置确认陷阱监测、对话框看门狗与 `chrome_request_human_intervention` 工具。遇验证码 (CAPTCHA)、二次身份验证或高危扣款操作时，自动压暗页面、显示醒目横幅并安全停靠光标，平滑将控制权移交人类用户，用户处理完毕后自动无缝恢复。

---

## 🏗️ 系统架构与执行流水线

BrowserPaw 遵循严格解耦的 4 层分层架构，将浏览器凭据严格保留在 Chrome 内部，在本地 Node.js 进程中维护隔离的状态机，并通过标准 MCP 协议与上层 AI 客户端通信：

```text
┌────────────────────────────────────────────────────────────────────────┐
│  第 1 层：AI 客户端与适配器插件 (AI Clients & Adapter Plugins)         │
│  Codex Desktop · Claude Code · Hermes Agent · DeepSeek Harness · Cursor│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ JSON-RPC (Stdio / HTTP 127.0.0.1:12306)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  第 2 层：本地原生服务 (Local Native Server · app/native-server)       │
│  ├── MCP 协议路由器与租约文件产物存储 (Lease-Backed Artifacts)          │
│  ├── 持久 REPL 运行时 (Node.js VM 沙箱 · browser.* 门面)               │
│  ├── 持久任务与页面归属账本 (chrome_task 状态机)                       │
│  ├── 已验证站点技能库 (chrome_skill 引擎)                              │
│  ├── 双脑决策引擎 (TypeSafe Jev System One / 本地零成本启发式)         │
│  └── 原生消息传递宿主 (Native Messaging 32 位长度前缀帧)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Chrome Native Messaging IPC (<= 1MB)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  第 3 层：Chrome MV3 扩展 (Blink / V8 · app/chrome-extension)          │
│  ├── Service Worker 事件路由与用户暂停守卫                             │
│  ├── 会话亲和性账本 (任务后台标签页 / 借用页 / 用户活动页隔离)         │
│  ├── CDP 会话管理器 (chrome.debugger · 域引用计数与防挂死保护)         │
│  └── 动作看门狗与弹窗拦截器 (对话框 / 下载 / 确认陷阱监测)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ chrome.scripting / chrome.debugger (CDP)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  第 4 层：页内执行与目标上下文 (In-Page Execution & Target Contexts)   │
│  ├── 隔离世界 DOM 索引器 (1 起始交互元素标号与边界框计算)              │
│  ├── 逐帧 DOM 聚合器 (allFrames 容错 · 开放式 Shadow DOM 深度遍历)     │
│  ├── 同步 Agent 视觉光标反馈覆盖层 (agent-cursor.content.ts)           │
│  └── 可信 CDP 输入派发流水线 (Input.dispatchMouseEvent / KeyEvent)     │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. 多框架观察与高韧性 DOM 索引

`chrome_read_dom` 在隔离世界 (Isolated World) 中遍历页面渲染树，为所有交互元素分配单调递增的 1 起始数字索引（`[1]`, `[2]`）及精确视口边界框。

- **Shadow DOM 穿透遍历**：递归遍历所有开放式 Shadow Root（`mode: 'open'`），完整穿透 Web Components 与自定义组件。闭合式 Shadow Root 会在宿主层级明确标记并降级交互。针对纯图标按钮，通过 `aria-label`、`title` 及子级 SVG `<title>` 智能提取可访问名称。
- **框架隔离执行容错**：跨域 iframe (OOPIF) 与嵌套框架由 `allFrames` 独立并发查询。若某个子框架由于同源策略或进程崩溃而失败，系统保留主框架 (`frame 0`) 观察结果并标记 `coverage.status: 'incomplete'`，绝不会导致全页快照雪崩。
- **布局变更看门狗**：在执行视口截图与元素交互时，基于 `MutationObserver` 的 `domRevision` 计数器实时监控 DOM 突变，校验视觉布局稳定性，防止像素撕裂或竞态定位。

### 2. 混合输入派发与视觉光标协同

BrowserPaw 遵循严密的定位决议阶梯：1 起始元素索引 `index`（或 CSS `selector` / 视口坐标 `coordinates`）→ 几何边界校验 → 视觉光标同步 → 可信 CDP 原生事件派发。

- **视觉光标轨迹同步**：扩展向页面注入 `agent-cursor.content.ts`，以平滑的贝塞尔曲线与点击波纹动画向真实坐标移动虚拟光标，使人类操作者清晰可见智能体的操作意图。
- **原生可信事件注入**：所有点击与键盘输入均通过 `chrome.debugger` 以真正的 CDP 原生事件（`Input.dispatchMouseEvent`、`Input.insertText`、`Input.dispatchKeyEvent`）派发，带有底层的 `isTrusted: true` 标记，确保 React 18 合成事件系统、Vue 及 Angular 事件监听器稳定响应。
- **不可重放的安全性**：一旦具有持久化副作用的动作跨越派发边界，若遭遇网络超时或未决状态，统一返回 `status: 'unknown'` 与 `retry: false`，杜绝盲目重发。
- **单步有界表单流水线**：`chrome_form_pipeline` 负责填充当前活动表单步骤中已暴露的字段（支持在已验证步骤间配置有界 `autoAdvance`），未暴露的后续步骤或最终提交动作均须显式声明。

### 3. 双脑决策引擎 (`Jev System One` + `本地启发式兜底`)

在面对自然语言驱动的单页自主交互任务（`chrome_act_toward_goal`）时，系统启动双脑引擎：

1. **确定性定位优先**：显式 CSS 选择器、数字索引、完全匹配标签与文本搜索率先执行，零模型开销。
2. **TypeSafe Jev System One**：当配置了 `TYPESAFE_API_KEY`（或 `JEV_API_KEY`）时，模糊歧义目标交由 TypeSafe Jev（`jev-1.14` / `jev-1.13`）决策。利用 `Noul` 概率类型输出严密判断（`target_exists >= 0.85`、`target_ambiguous < 0.5`、`destructive < 0.5` 高危拦截、`stuck >= 0.85` 停滞检测），并通过多模态 `Box` 精准定位视口坐标。视口边界框受到严格的 Frame TTL、DPR 缩放比、URL 与滚动偏移校验，坐标漂移时立即失败关闭。
3. **零成本本地启发式引擎**：当未配置 API Key 或遭遇云端瞬时网络抖动时，系统自动无缝切换至本地启发式引擎 (`heuristic-engine.ts`)，基于 HTML Tag、Role、ARIA 语义与中文关键词完成零成本推断，且不丢失配置模式。
4. **感知边界声明**：页面感知签名涵盖 URL 变更、标题、进度指示器与弹窗警告。但对于 `<canvas>` / WebGL 像素级游戏画面以及闭合 Shadow DOM，需显式使用坐标或视觉工具。

### 4. 本地持久 REPL (`browserpaw repl`) 与租约产物交付

持久 Node.js 运行环境（`browserpaw repl`）在隔离的 VM 沙箱中暴露简洁的 `browser.*` 门面（`task`、`page`、`locator`、`skill`、`help`）。智能体可在本地链式调用多步逻辑，海量 DOM 节点、大型网络响应体与全分辨率截图直接落地到本地租约文件（`~/.browserpaw/leases/`），仅向 MCP 返回轻量引用句柄，彻底根除 stdio 管道溢出与上下文暴涨。

---

## 🚀 快速开始

根据你的角色与工作流选择最合适的接入路径：

### 选项 A：预构建扩展发布包 + 本地原生宿主

1. 前往 [GitHub Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest) 下载 `browserpaw-extension.zip`（及可选的 `browserpaw-skill.zip`），将 `browserpaw-extension.zip` 解压至固定目录（加载后请勿移动或删除该目录）。
2. 打开 Google Chrome，访问 `chrome://extensions`，开启右上角**开发者模式**，点击**加载已解压的扩展程序**，选择解压后的目录。
3. 在本地仓库目录中构建原生消息桥接服务并注册扩展 ID：
   ```bash
   pnpm install && pnpm build
   CHROME_EXTENSION_ID=<你的32位扩展ID> node app/native-server/dist/scripts/register-dev.js
   ```

### 选项 B：全量从源码构建（面向开发者）

从单仓完整编译 Chrome MV3 扩展（`app/chrome-extension/.output/chrome-mv3`）与本地 Native Server：

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw
pnpm install
pnpm build
```

在 `chrome://extensions` 中加载 `app/chrome-extension/.output/chrome-mv3`，复制生成的 32 位扩展 ID 并注入 `CHROME_EXTENSION_ID` 后运行 `node app/native-server/dist/scripts/register-dev.js`。

### 连接你的 AI 客户端

| 客户端平台            | 支持的集成通道                                         | 配置与快速跳转                                                                        |
| :-------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Codex Desktop**     | 纯净 Stdio 或便携插件包                                | [INSTALL.md §3.1](./INSTALL.md#31-codex-desktop--chatgpt-stdio-vs-marketplace-plugin) |
| **Claude Code**       | 官方插件市场 (`/plugin install browserpaw@browserpaw`) | [INSTALL.md §3.5](./INSTALL.md#35-claude-code-browserpaw-marketplace-plugin)          |
| **Hermes Agent**      | 原生定制插件 (`plugins/browserpaw-hermes`)             | [INSTALL.md §3.2](./INSTALL.md#32-hermes-agent)                                       |
| **DeepSeek Harness**  | Cordis 插件包 (`plugins/browserpaw-dsh`)               | [INSTALL.md §3.8](./INSTALL.md#38-deepseek-harness-plugin-package-not-an-mcp-entry)   |
| **Cursor / Windsurf** | Stdio MCP (`mcp-chrome-stdio`)                         | [INSTALL.md §3.3](./INSTALL.md#33-cursor-cursormcpjson-or-cursor-settings--mcp)       |
| **通用 MCP 宿主**     | 本地回环 HTTP SSE (`http://127.0.0.1:12306`)           | [INSTALL.md §3.7](./INSTALL.md#37-generic-streamable-http-mcp)                        |

### 系统健康自检

```bash
browserpaw doctor
```

_全套操作系统注册细节、静音调试模式（防黄条闪烁）及疑难排查请参阅 **[INSTALL.md](./INSTALL.md)**。_

---

## 🛠️ MCP 工具矩阵与配置档

BrowserPaw 提供 **52 项规范工具**（49 项 Extension 执行工具 + 3 项 Native 宿主工具：`chrome_task`、`chrome_skill`、`chrome_act_toward_goal`）。为压减 Token 消耗并杜绝模型决策犹豫，工具划分为三大配置档：

| 配置档                | 工具数量 |           Schema 体积占用           | 适用场景                                                               |
| :-------------------- | :------: | :---------------------------------: | :--------------------------------------------------------------------- |
| **`core`** _(默认档)_ |  **9**   |      UTF-8 JSON 不超过 26 KiB       | 任务、技能、导航、标签页清单与切换、DOM 观察、索引交互与输入、工具发现 |
| **`crawl`**           |  **12**  |           提取与抓取子集            | 高吞吐网页提取、Markdown 转换、媒体检查、存储读取与网络请求            |
| **`full`**            |  **52**  | 参见生成的[工具参考](docs/TOOLS.md) | 完整规范工具集合；Jev 可用性仍由实际配置决定                           |

先用 `chrome_tool_docs({category:"manage"})` 查询名称，再用 `{names:["chrome_close_tabs"],activateForSession:true}` 替换临时扩展；`{names:[],activateForSession:true}` 恢复基础列表。直接调用已知隐藏工具不会扩大列表。不支持工具列表刷新的客户端可显式配置 `full`。

### 按功能类别划分的工具目录总览

| 功能类别               | 工具数 | 包含的工具列表                                                                                                                                                                                                                                                                                                         |
| :--------------------- | :----: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **会话与诊断**         |   4    | `chrome_doctor`, `chrome_tool_docs`, `chrome_undo_last_action`, `chrome_javascript`                                                                                                                                                                                                                                    |
| **任务与页面生命周期** |   10   | `chrome_task`, `chrome_skill`, `chrome_act_toward_goal`, `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `chrome_move_tab`, `chrome_attach_tab`, `chrome_detach_tab`, `get_windows_and_tabs`                                                                                                              |
| **观察与内容提取**     |   8    | `chrome_read_dom`, `chrome_get_markdown`, `chrome_grep`, `chrome_inspect_media`, `chrome_get_dropdown_options`, `chrome_screenshot`, `chrome_smart_scroll`, `chrome_scroll_until_found`                                                                                                                                |
| **交互与执行流水线**   |   13   | `chrome_interact_index`, `chrome_fill_index`, `chrome_keyboard`, `chrome_upload_file`, `chrome_insert_media`, `chrome_batch_actions`, `chrome_form_pipeline`, `chrome_dismiss_overlay`, `chrome_handle_dialog`, `chrome_handle_download`, `chrome_computer`, `chrome_cdp_execute`, `chrome_request_human_intervention` |
| **标签页分组与书签**   |   9    | `chrome_tab_group_create`, `chrome_tab_group_update`, `chrome_tab_group_list`, `chrome_tab_group_ungroup`, `chrome_tab_group_close`, `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_delete`                                                                                       |
| **网络监听与性能分析** |   8    | `chrome_network_request`, `chrome_network_capture`, `chrome_intercept_api`, `chrome_console`, `chrome_storage`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`                                                                                                                     |

_各工具的参数定义、输入 Schema 与返回值规范详见 **[docs/TOOLS.md](./docs/TOOLS.md)**。_

---

## 📚 核心文档矩阵

| 文档名称                                                       | 核心作用与受众                                     |
| :------------------------------------------------------------- | :------------------------------------------------- |
| **[INSTALL.md](./INSTALL.md)**                                 | 全操作系统平台、全客户端配置指南与静音调试标志配置 |
| **[PROJECT.md](./PROJECT.md)**                                 | 系统职责边界、子模块分工及开发维护守则             |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**             | 拓扑设计、通信协议细节与架构决策记录 (ADR)         |
| **[docs/TOOLS.md](./docs/TOOLS.md)**                           | 52 个规范工具的最新完整 Schema 参数字典与调用范例  |
| **[docs/QUALITY.md](./docs/QUALITY.md)**                       | 工程质量门禁、测试层级规范与可靠性基准             |
| **[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)**             | 协同开发流程、Conventional Commits 规范与 PR 指南  |
| **[docs/DOCUMENTATION.md](./docs/DOCUMENTATION.md)**           | 文档治理标准、超链接验证流程与多语言对齐原则       |
| **[docs/releases/RELEASING.md](./docs/releases/RELEASING.md)** | 版本发布工程指南、Tag 打标规范与交付物自检清单     |

---

## 🛡️ 验证与发布状态

在本地运行以下质量与自检命令验证项目状态：

```bash
# 运行完整的静态质量门禁与文档合规验证
pnpm verify

# 检查版本发布日志与 Git Tag 对齐情况
pnpm release:check

# 诊断 Chrome 扩展与本地 Native 宿主双向连接状态
browserpaw doctor
```

**发布版本说明 (v4.1.2)**：BrowserPaw 4.1.2 是最新发布的可靠性基准版本。该版本完成了不同观察路径下的交互范围收敛、显式延迟页面恢复、快速观察失败关闭语义、统一的可预期页面限制处理以及错误页注入恢复。此前在 4.1.0 中复现的原生空闲协议故障已彻底修复，并在同一连接上完成了超过 11 分钟的实测验证。本项目严格基于实测证据提供事实记录，不包含未经证明的商业化性能营销数据。在独立的中文样本测评中，Jev 1.14 遇到低置信度目标时会安全拒绝；确定性工具链路始终作为推荐的生产基准。详见 [docs/releases/v4.1.2.md](./docs/releases/v4.1.2.md) 与 [docs/development/DEVELOPMENT.md](./docs/development/DEVELOPMENT.md)。

---

## 📄 法律与许可

BrowserPaw 遵循 **[AGPL-3.0 许可](./LICENSE)**（GNU Affero General Public License v3.0 或更高版本）。

### ⚖️ 开源与 SaaS 传染性（第 13 条）

依据 AGPLv3 第 13 条，任何基于本项目的修改、分支或衍生作品——包括以网络服务、云网关或 SaaS 平台形式远程托管并通过网络向用户提供交互服务的场景——**都必须在相同的 AGPL-3.0 许可下公开其完整的对应源代码**。

### 🛡️ 免责声明与责任限制

本软件按*“原样”*提供，不附带任何明示或暗示的担保。作者或版权持有人在任何情况下均不对因使用本软件或其自动化工作流而产生的任何索赔、损害、账号风控封禁、数据丢失或其他责任负责。

### 🌐 遵守第三方条款

用户须自行确保其自动化工作流符合所访问网站或服务的服务条款 (ToS)、`robots.txt` 爬虫协议及当地法律法规。

### 🏷️ 商标与非关联声明

_Google Chrome_ 是 Google LLC 的商标。_Microsoft Edge_ 是 Microsoft Corporation 的商标。_OpenAI_ 和 _ChatGPT_ 是 OpenAI, Inc. 的商标。_TypeSafe_ 是 TypeSafe, Inc. 的商标。BrowserPaw 作为一个独立的开源软件项目，未受上述任何实体的赞助、背书或关联。第三方软件归属与许可说明参见 [NOTICE](./NOTICE)。
