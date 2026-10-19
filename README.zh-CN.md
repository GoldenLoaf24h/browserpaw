<div align="center">
  <img src="./docs/images/logo.png" width="128" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>让 AI Agent 操控你日常使用的 Chrome，不丢失登录态，不抢占焦点。</b></p>
  <p>
    <a href="./docs/MAP.md">项目地图</a> ·
    <a href="./docs/TOOLS.md">工具参考（50 个）</a> ·
    <a href="./AGENT_CONFIG_GUIDE.md">客户端配置</a> ·
    <a href="./README.md">English</a> ·
    <a href="./LICENSE">AGPL-3.0 许可</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">版本发布</a>
  </p>
</div>

---

<details>
<summary><b>缘起：我为什么开发 BrowserPaw</b></summary>

<br/>

传统浏览器自动化框架和基于 LLM 的 browser-use Agent 是为隔离的沙箱测试而设计的，而非真实的日常桌面工作流。每次我尝试让 AI Agent 在我真实的浏览器里协助我时，总会撞上同样六个令人沮丧的障碍：

1. **登录态、Cookie 与会话全部丢失**：独立浏览器从空配置启动，不会继承你已登录的 Google、GitHub 或企业 SSO 账户、Cookie 和扩展。从头登录会不断触发两步验证和反机器人校验。
2. **Windows 文件共享锁（`[WinError 32]`）**：在 Windows 上尝试复用正在运行的 Chrome User Data 目录会立刻崩溃，因为 Chromium 对已打开的配置数据库持有独占文件共享锁。
3. **强制的人工鼠标点击授权**：无论 Agent 通过原始 CDP 还是远程调试端口控制本地浏览器，Chromium 都会频繁弹出侵入式确认框和安全提示。你必须停下手头的工作、找到浏览器窗口、用鼠标亲手点击授权——完全违背了无人值守自动化的初衷。
4. **执行缓慢与惊人的 Token 消耗**：传统 AI 浏览器 Agent 每执行一个微小动作，都要把整页 Retina 截图或庞大的原始 DOM 树回传给远端前沿 LLM。每一步都伴随 6–12 秒往返延迟并烧掉数万 Token，让多步自动化既慢得难以忍受又贵得离谱。
5. **侵入式调试横幅与视口抖动**：标准远程调试会注入原生顶部通知栏（_“BrowserPaw 正在调试此浏览器”_），把视口向下推移约 36px，造成布局抖动和坐标点击错位。
6. **抢占前台焦点**：典型自动化工具会把浏览器窗口强行推到前台，在你处理其他任务时劫持键盘和鼠标焦点。

受够了这些障碍，我开发了 BrowserPaw，从根源上解决全部问题。通过让 Chrome MV3 扩展与本地原生消息传递（Native Messaging）桥接直接配对，BrowserPaw 在你每天都在用的 Chrome 内无缝运行——在后台标签页里安静地完成自动化，不丢失登录态、不抢夺焦点、不要求反复人工授权。

</details>

---

## ⚡ BrowserPaw 是什么？

BrowserPaw 是一个 Chrome 扩展 + 本地 MCP 服务器，让 AI Agent 操控你真实的浏览器。它按 8 个类别（自主执行、导航与标签页、感知与提取、动作与流水线、观测与诊断、管理、网络、性能与健康）暴露 50 个工具，日常会话默认使用最小化的 14 工具 core 配置档，以避免 Token 膨胀和选择困难。通过 `CHROME_MCP_TOOL_PROFILE=full` 或经 `chrome_tool_docs` 动态激活可启用完整工具集。

提供两条执行路径：

1. **确定性工具** —— 索引化点击、填写、批量流水线、表单向导、截图、网络抓包等。由调用方 Agent 规划每一步。
2. **`chrome_act_toward_goal`** —— 本地感知-动作微循环，无需逐步 MCP 往返。原生服务器负责感知页面、决定下一步动作并执行，每一步都不产生 MCP 往返。它支持本地决策模型（含 GPU 加速）和 TypeSafe Jev System One 云端推理。

---

## 🎯 核心能力

- **会话延续性** —— 运行在你现有的 Chrome 内。Google、GitHub 和 SSO 登录态已经就绪；无需复制配置，无需重新认证。
- **剪枝后的索引化 DOM** —— `chrome_read_dom` 剔除不可交互和被遮挡的节点，并分配从 1 开始的索引。在 1000+ 节点的页面上，节点数减少超过 85%（测试验证），使快照保持精简。快速快照模式在 10–30 ms、≤15 KB 的优化预算目标内返回视口摘要。
- **卡片扁平化与视口虚拟化** —— `flattenCards` 将重复的信息流卡片折叠成单行摘要；`virtualizeViewport` 将屏幕外的列表项折叠为计数占位符。
- **Shadow DOM 遍历** —— 递归遍历开放的 shadow root；闭合的 shadow host 会被标记并在宿主层级交互。可从纯图标按钮中提取可访问名称（aria-label、title、SVG title）。
- **批量流水线** —— `chrome_batch_actions` 在一次 MCP 往返中执行多步 click/fill/wait/assert/extract 序列。`chrome_form_pipeline` 在本地推进多步表单。
- **遮罩层关闭** —— `chrome_dismiss_overlay` 一步关闭营销弹窗、Cookie 横幅和模态框，无需倾倒 DOM。
- **增量搭车返回** —— `includeDelta: true` 在同一响应中随动作返回 DOM 变更，省去后续的 DOM 读取。
- **原生事件保真度** —— 点击和按键以可信 CDP 事件（`isTrusted: true`）派发，React/Vue/Angular 和 Shadow DOM 处理器都能正常触发。
- **坐标兜底** —— 当 DOM 索引失效时（canvas、WebGL、纯图标 UI），截图网格加上 `chrome_computer` 提供基于坐标的控制，并带 24 px 磁吸自动对齐。
- **人工接管** —— `chrome_request_human_intervention` 会压暗页面、显示横幅并停放光标，让用户完成两步验证或验证码；之后自动化继续。
- **标签页与窗口管理** —— 创建、分组、移动和关闭标签页，查询历史与书签，采集性能跟踪，全部在用户现有凭据下进行。

---

## 🧠 双脑执行

```text
┌─ 宏观规划器（你的推理 LLM）────────────────────────────┐
│  任务拆解、跨页策略、故障恢复                          │
└───────────────────────────┬────────────────────────────┘
                            │ MCP（低频）
                            ▼
┌─ 语义微循环（原生服务器）──────────────────────────────┐
│  chrome_act_toward_goal:                               │
│  感知 → 决策（Jev 或启发式）→ 执行 → 校验              │
│  每步不产生 MCP 往返                                   │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging
                            ▼
┌─ Chrome MV3 扩展 ──────────────────────────────────────┐
│  49 个浏览器工具 · CDP 事件 · 页内引擎                 │
└────────────────────────────────────────────────────────┘
```

路由指引：

- 固定动作序列、已知索引 → 确定性工具（`chrome_batch_actions`、`chrome_form_pipeline`）。
- 用自然语言描述的单页目标 → `chrome_act_toward_goal`。
- 长周期、跨页面、新颖或需升级处理的场景 → 由调用方 Agent 驱动。

微循环是有界的：Jev 模式最多 60 步（默认 10），启发式回退时截断为 5 步。它会拦截 14 个破坏性动作关键词（pay、delete、submit 等），并把含糊或低置信度的决策连同候选元素升级回调用方 Agent。

**自主 Jev 模式与智能门控：**

- **Off**：用户在扩展弹窗中禁用。`chrome_act_toward_goal` 会自动从 `tools/list` 中隐藏；若被直接调用则拒绝并提示用户授权。
- **Local**：在 8009 端口本地运行离线、隐私优先的决策模型（`decider-2b`），支持 NVIDIA GPU 加速（CUDA RTX）或 CPU 回退。权重通过弹窗或安装脚本下载后，桥接服务自动管理进程生命周期并热加载。
- **Remote**：使用 TypeSafe Jev System One 云端推理。设置 `TYPESAFE_API_KEY`（或通过弹窗配置），可选自定义 `Base URL` 和自定义微调 `modelId`。配置失败时返回可操作的诊断日志，而不是静默回退到启发式。
- **实验性远程视觉**：无开关、无固定视觉模型。把弹窗的 `Model` 字段指向任意 id 并点击 Apply；在采集任何内容之前，BrowserPaw 会向上游询问该端点响应哪个版本，只有能回答 Jev 1.14 `box` 问题时才发送视口截图（目前 `jev-preview` 和 `jev-1.14.0` 符合条件，而 `jev-latest` 仍解析为 Jev 1.13，会被拒绝且不发送图像）。文本与 DOM 定位仍是常规路径，本地/关闭模式下视觉不可用。Images 和 Box 是实验性 TypeSafe API，因此不确定或过期的目标会升级回调用方 Agent。

---

## 🚀 快速开始

### 方式一：用 AI Agent 安装（推荐）

把下面这段粘贴给你的 Agent：

> “帮我安装 BrowserPaw：https://github.com/GoldenLoaf24h/browserpaw。阅读 INSTALL.md 并按其步骤操作。”

Agent 会自动编译项目并注册操作系统原生宿主。然后打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**，选择 `app/chrome-extension/.output/chrome-mv3`（或你配置的本地暂存目录）。

### 方式二：预构建扩展（无需构建扩展）

1. 从 [Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest) 下载最新的 `browserpaw-extension-v*.zip` 和 `browserpaw-skill-v*.zip`。
2. 将扩展解压到本地持久目录，打开 `chrome://extensions`，启用开发者模式，点击**加载已解压的扩展程序**。
3. 扩展 ZIP 不含原生消息传递服务器。克隆仓库并按 [INSTALL.md](./INSTALL.md) 构建并注册本地桥接。
4. 把完整的 `skill/` 目录（含其 `references/` 子目录）复制到你的 Agent 技能目录（Codex：`~/.codex/skills/browserpaw/`）。

### 方式三：从源码构建

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw && pnpm install && pnpm build
node app/native-server/dist/scripts/register-dev.js
```

然后通过 `chrome://extensions` 加载 `app/chrome-extension/.output/chrome-mv3`（或你配置的暂存目录）。

### 验证

用内置诊断套件验证所有组件工作正常：

```bash
node skill/config/doctor.mjs
```

**Claude Code 用户**可安装随仓库附带的插件：先运行 `/plugin marketplace add GoldenLoaf24h/browserpaw`，再运行 `/plugin install browserpaw@browserpaw`，之后 `/browserpaw` 会加载操作指南。

完整上手说明（Codex Stdio 配置、Cursor、Claude Desktop、Claude Code、Hermes、Jev API key）见 **[INSTALL.md](./INSTALL.md)**。

---

## 🛠️ 工具目录

全部 50 个工具分列如下。机器可读的 schema 与参数细节见 [docs/TOOLS.md](./docs/TOOLS.md)。

### 自主执行（1）

- **`chrome_act_toward_goal`** —— 面向自然语言目标的本地感知-动作循环。Jev 推理加启发式回退；遇到含糊或破坏性动作时升级处理。

### 导航与标签页（7）

- **`chrome_navigate`** —— 打开 URL、刷新、历史前进/后退、后台标签页。
- **`chrome_switch_tab`** —— 切换活动标签页或绑定会话亲和（自动交接严格限制在已验证的 openerTabId 或 webNavigation 谱系内）。
- **`chrome_close_tabs`** —— 按 id、URL 或会话关闭标签页（关闭活动标签页需 confirm）。
- **`chrome_move_tab`** —— 调整标签页位置或跨窗口移动。
- **`get_windows_and_tabs`** —— 列出窗口与标签页及其状态。
- **`chrome_attach_tab` / `chrome_detach_tab`** —— 附加或分离 CDP 调试器。

### 感知与提取（7）

- **`chrome_read_dom`** —— 索引化、剪枝后的 DOM 树，支持 Shadow DOM 遍历与快速快照模式。
- **`chrome_scroll_until_found`** —— 客户端自动滚动查找目标文本/元素，等待虚拟 DOM 稳定、居中元素并返回实时索引。
- **`chrome_grep`** —— 正则或文本搜索，返回元素索引而无需倾倒完整 DOM。
- **`chrome_get_markdown`** —— 为阅读任务提取干净的 Markdown。
- **`chrome_inspect_media`** —— 提取图像或 canvas 数据；对小尺寸验证码做超分辨率处理。
- **`chrome_get_dropdown_options`** —— 列出 select/combobox 选项。
- **`chrome_console`** —— 捕获控制台日志与错误。

### 动作与流水线（15）

- **`chrome_interact_index`** —— 按 1 起始索引执行可信点击、悬停、双击、拖拽。
- **`chrome_fill_index`** —— 可信文本输入，支持清空、提交和多行。
- **`chrome_batch_actions`** —— 单次往返内执行多步流水线（click/fill/wait/assert/extract）。
- **`chrome_form_pipeline`** —— 自主多步表单填写。
- **`chrome_smart_scroll`** —— 滚动页面或内部容器并报告进度。
- **`chrome_keyboard`** —— 原始按键与快捷键。
- **`chrome_upload_file`** —— 原生文件输入上传。
- **`chrome_insert_media`** —— 向富文本编辑器粘贴/拖入真实 File。
- **`chrome_handle_dialog`** —— 接受或取消原生 alert/confirm/prompt。
- **`chrome_handle_download`** —— 等待并定位下载文件。
- **`chrome_computer`** —— 坐标级鼠标/键盘控制（视觉兜底）。
- **`chrome_request_human_intervention`** —— 让出控制权给用户处理验证码/两步验证。
- **`chrome_undo_last_action`** —— 回滚最近一次变更。
- **`chrome_dismiss_overlay`** —— 关闭弹窗、模态框和 Cookie 横幅。
- **`chrome_javascript`** —— 在页面上下文中求值 JavaScript。

### 观测与诊断（3）

- **`chrome_screenshot`** —— 视口、元素或整页截图，可选坐标网格。
- **`chrome_cdp_execute`** —— 原始 CDP 逃生通道。
- **`chrome_tool_docs`** —— 查询工具 schema 并激活隐藏配置档。

### 管理（10）

- **`chrome_tab_group_create`** / **`chrome_tab_group_update`** / **`chrome_tab_group_list`** / **`chrome_tab_group_ungroup`** / **`chrome_tab_group_close`** —— 标签页分组生命周期。
- **`chrome_history`** —— 搜索浏览历史。
- **`chrome_bookmark_search`** / **`chrome_bookmark_add`** / **`chrome_bookmark_delete`** —— 书签操作。
- **`chrome_storage`** —— 读写 Cookie、localStorage 和 sessionStorage。

### 网络（3）

- **`chrome_intercept_api`** —— 捕获匹配 URL 模式的后端 JSON 响应。
- **`chrome_network_capture`** —— 录制网络流量。
- **`chrome_network_request`** —— 通过浏览器会话发起带认证的 HTTP 请求。

### 性能与健康（4）

- **`performance_start_trace`** / **`performance_stop_trace`** / **`performance_analyze_insight`** —— 录制并分析性能跟踪。
- **`chrome_doctor`** —— 检查端口、扩展连接、Token 和原生宿主健康状况。

---

## 🏗️ 架构

```text
AI 客户端（任意支持 MCP 的 Agent）
         │  MCP over Stdio（推荐的零配置方式）或 127.0.0.1:12306 上的 HTTP/SSE
         ▼
原生消息传递桥接（Fastify + Stdio Host）
         ├── 快速决策引擎（Jev 微循环）
         └── 49 个确定性工具的透传（共 50 个工具）
         │  Chrome Native Messaging
         ▼
Chrome MV3 扩展（Service Worker）
         ├── 页内引擎（1 起始的 DOM 索引）
         ├── CDP 会话管理器
         └── Agent 光标覆盖层
```

细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

---

## 📚 文档

- [项目地图](./docs/MAP.md) —— 导航枢纽与阅读路径。
- [工具参考](./docs/TOOLS.md) —— 全部 50 个工具的 schema。
- [安装与上手](./INSTALL.md) —— 逐步配置，含 Jev key。
- [Agent 集成](./AGENT_CONFIG_GUIDE.md) —— MCP 客户端配置。
- [架构](./docs/ARCHITECTURE.md) —— 设计与决策。
- [故障排查](./docs/TROUBLESHOOTING.md) —— 连接与执行问题。

---

## 💡 致谢

- [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) —— MV3 扩展与原生消息传递桥接基础。
- [browser-use/browser-use](https://github.com/browser-use/browser-use) —— DOM 优先索引原则。
- [BrowserOS](https://github.com/browseros-ai/BrowserOS) —— DOM diff 与元素 grep 模式。
- [TypeSafe](https://docs.typesafe.ai) —— Jev System One 快速决策模型。

---

## 📄 法律与许可

本项目采用 **[AGPL-3.0 许可](./LICENSE)**（GNU Affero General Public License v3.0 或更高版本）。

### ⚖️ 开源与 SaaS 传染性（第 13 条）

依据 AGPLv3 条款，任何修改、分支或衍生作品——包括以网络服务、云网关或 SaaS 平台形式远程托管并与用户通过网络交互的版本——**都必须以相同的 AGPL-3.0 许可公开其完整的对应源代码**。

### 🛡️ 免责声明与责任限制

本软件按_“原样”_提供，不附带任何明示或暗示的担保，包括但不限于适销性、特定用途适用性和非侵权担保。作者或版权持有人在任何情况下均不对因本软件或本软件的使用或其他交易而产生的任何索赔、损害、账户封禁、数据丢失或其他责任负责。

### 🌐 遵守第三方条款

用户须自行确保其自动化浏览器工作流遵守所有适用的当地法律、法规，以及所访问的任何第三方网站或服务的服务条款（ToS）或 `robots.txt` 政策。

### 🏷️ 商标与非关联声明

_Google Chrome_ 是 Google LLC 的商标。_Microsoft Edge_ 是 Microsoft Corporation 的商标。_OpenAI_ 和 _ChatGPT_ 是 OpenAI, Inc. 的商标。_TypeSafe_ 是 TypeSafe, Inc. 的商标。BrowserPaw 是一个独立的开源项目，未获得上述任何实体的赞助、认可或关联。第三方软件归属与许可记录在 [NOTICE](./NOTICE) 中。

## 🛡️ 验证与质量

开发验收门、构建/部署验证和运行时身份标准定义于 [**`docs/QUALITY.md`**](./docs/QUALITY.md)。
运行 `pnpm verify` 执行完整的静态质量与构建审计。
