<div align="center">
  <img src="./docs/images/logo.png" width="100" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>控制你自己的浏览器的一切。</b></p>
  <p>
    <a href="./docs/MAP.md">🗺️ 项目地图</a> ·
    <a href="./docs/TOOLS.md">工具参考 (50)</a> ·
    <a href="./AGENT_CONFIG_GUIDE.zh-CN.md">客户端配置</a> ·
    <a href="./README.md">📖 English</a> ·
    <a href="./LICENSE">AGPL-3.0 开源协议</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">Releases</a>
  </p>
</div>

---

<details>
<summary><b>💡 背景故事：为什么我要做 BrowserPaw？</b></summary>

<br/>

现有的绝大多数浏览器自动化框架与大模型网页控制 Agent（Playwright、Puppeteer、browser-use 等）主要是为孤立的沙盒测试而设计，并非面向日常真实桌面的工作流协作。每次当我试图让 AI Agent 帮我操作我真正的日常浏览器时，都会反复撞上六大痛点：

1. **丢失日常登录态、Cookie 与扩展**：独立无头浏览器必须从空白用户数据目录启动，完全无法继承日常的 Google、GitHub、企业 SSO 登录态。从零登录不仅频繁触发二次验证（2FA），还极易被反爬风控拦截。
2. **Windows 文件排他共享锁（`[WinError 32]` 崩溃）**：在 Windows 平台上，试图直接复用或复制正在运行的 Chrome 个人资料目录时，操作系统会因文件共享排他锁直接抛出异常崩溃。
3. **必须手动用鼠标点击确认的自动化死锁**：每当 Agent 试图通过原生 CDP 或远程调试端口接管本地浏览器时，Chromium 往往强制弹出安全确认横幅或调试提示，强迫用户必须中断手头工作、切回浏览器并用鼠标手动点击“同意”。这种繁琐的人工介入彻底破坏了无人值守自动化的初衷。
4. **操控极为缓慢且 Token 消耗巨大**：传统的 AI 浏览器 Agent 往往对每一步微小动作都向远端大模型回传高分辨率视网膜截图或数万字符的完整 DOM 树，单步往返延迟高达 6~12 秒，且单步消耗数万 Token。执行一个稍长的多步骤流程不仅耗时数分钟令人抓狂，还会产生极其高昂的 API 账单。
5. **强制调试横幅与页面视口抖动**：开启远程调试后，Chrome 顶部会出现强制性的黄色警告条（“BrowserPaw 正在调试此浏览器”），导致网页视口高度被挤压下移约 36px，造成页面布局抖动和坐标点击偏差。
6. **强占前台焦点与打扰正常工作**：传统自动化工具频繁将浏览器窗口强行置顶，在执行任务时疯狂抢占键盘输入和鼠标焦点，严重干扰用户的日常电脑使用。

正是受够了这些痛点，我才决定亲手做出 **BrowserPaw**，从根源上将所有问题一次性彻底解决。通过将 Chrome MV3 扩展与本地原生通信（Native Messaging）网桥相结合，BrowserPaw 能够直接常驻于你早已登录的主力浏览器中，在后台标签页内静默完成任务 —— 零登录态丢失、零文件锁冲突、零抢占前台焦点，也绝不再需要人工频繁点击鼠标确认。

</details>

---

## ⚡ 什么是 BrowserPaw？

- 🧠 **分层双脑协同架构 (`chrome_act_toward_goal`)**：本地语义微循环以 200~400ms/步极速自主完成“感知 → 决策 → 交互”，**零中间 MCP 网络往返**。内置 TypeSafe Jev System One 并支持平滑降级至启发式规则打分与结构化交接。
- 🔑 **日常会话与登录态无缝复用**：直接运行在日常 Chrome 浏览器中，完整继承 Google、GitHub、企业 SSO 登录凭证，杜绝文件锁冲突与登录丢失。
- 🌲 **1-based 剪枝 DOM 与紧凑 AX 树**：剔除装饰性 DOM 噪点与多余闭合标签，输出高结构化紧凑可交互节点树。支持电商/信息流复合卡片扁平化 (`flattenCards`) 与长列表视口虚拟化 (`virtualizeViewport`)，相较原生 HTML 缩减 85%+ Token 消耗。
- ⚡ **代码驱动流水线与原子批处理**：通过 `chrome_batch_actions` 或页内 `mcp.*` 脚本，在单次往返中串联表单填写、点击、断言与数据提取闭环。
- 🛡️ **Deep Shadow DOM 深度穿透**：Composed 树多层穿透 Web Components（如 Reddit Shreddit 架构），语义提取纯图标按钮的 `aria-label`/`title`/内嵌 SVG 标题，并支持闭合 Shadow Host 的 Composed 事件捕获与冒泡。
- 🎯 **视觉回退漂移实时补偿**：整页截图真实文档空间坐标映射（`isDocumentSpace`），动态计算滚动位移差（`alignVisualCoordinate`），自动平滑居中并于点击派发期间锁定滚动，消除视口竞态漂移。
- 🔄 **自驱增量 Diff 与定向 Grep 检索**：`includeDelta: true` 在操作完成后直接携带页面局部变动；`chrome_grep` 实现多层 Shadow 树下毫秒级低 Token 正则检索。
- 🚫 **一键浮层与营销弹窗关闭 (`chrome_dismiss_overlay`)**：极速清理淘宝/京东消费券弹窗、广告模态框与 Cookie 授权条，无需往返倾倒数百个 DOM 节点。
- 🖱️ **真人级防打扰交互共存**：具备 1:1 弹簧动力学虚拟光标悬浮层、专属智能意图命名标签组生命周期管理、可选独立窗口隔离，以及在 2FA/滑块验证时柔和礼让用户的毛玻璃介入横幅。
- 🧭 **本地浏览器全维能力治理**：超越常规网页爬取，通过 50 项规范 MCP 工具全面管理标签页、窗口、Cookie、存储、浏览历史及书签。

---

## 🧠 分层双脑如何协同工作？

```text
┌─ Tier 2 · 宏观规划大脑 (您的推理大模型) ────────────────┐
│  复杂任务分解、长程推理思考、自由文案生成、异常安全接管 │
└───────────────────────────┬────────────────────────────┘
                            │ MCP 协议 (低频下发宏观微目标)
                            ▼
┌─ Tier 1 · 本地语义微循环 (Native Server) ──────────────┐
│  chrome_act_toward_goal 内部闭环：                     │
│  read_dom → Jev / Heuristic 决策 → 执行动作 → 状态核验 │
│  ~200–400ms/步 · 零额外 MCP 往返                       │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging 内部管道
                            ▼
┌─ Tier 0 · 确定性原子工具群 (49 个确定性原子工具 + 1 个自主微循环 = 50 项) ─┐
│  batch_actions / form_pipeline / interact_index / ...    │
│  Chrome MV3 扩展底层驱动 · 硬件级 CDP 物理事件           │
└──────────────────────────────────────────────────────────┘
```

**调度最佳实践天梯：**

- 目标元素索引明确、操作步骤固定 → **Tier 0** 零模型直达 (`chrome_batch_actions` / `chrome_form_pipeline`)
- 自然语言微目标、元素位于当前页面但位置动态未知 → **Tier 1** 语义微循环 (`chrome_act_toward_goal`)
- 长程复杂任务、页面陌生探索、内容生成或微循环遇到歧义/破坏性动作反抛 → **Tier 2** 宏规划大模型直接介入

**Jev 自主决策运行模式与智能门控：**

- **Off (关闭)**：用户在扩展弹窗中关闭 Jev。`tools/list` 自动隐藏 `chrome_act_toward_goal`；若 Agent 尝试强制调用，拦截并返回需用户明确授权的提示。
- **Local (本地)**：端口 8009 运行零云端依赖的离线小模型（`decider-2b`），支持 NVIDIA CUDA RTX GPU 硬件加速与 CPU 自动降级，首次调用自动热加载并常驻后台。
- **Remote (云端)**：采用 TypeSafe Jev System One 云端大模型，支持配置自定义 `Base URL` 与 `modelId`，具备磁盘持久化（`~/.browserpaw/jev-remote.json`）。遇配置缺失或失效返回具体诊断日志与修复指引，杜绝静默假降级。

### 真实环境基准实测 (基于真实 Jev API, T1~T5)

| 测试场景                        | 端到端耗时 | Jev 调用次数 | 累计 Token (输入/输出) | 引擎类型 |
| ------------------------------- | ---------- | ------------ | ---------------------- | -------- |
| T1 导航检索 (Google 搜索并打开) | 2,062ms    | 2            | 1,737 / 52             | jev      |
| T2 表单提交 (输入并登录)        | 586ms      | 2            | 1,666 / 48             | jev      |
| T3 下拉选择 (选择目标项)        | 249ms      | 1            | 781 / 24               | jev      |
| T4 弹窗阻断 (关闭协议并继续)    | 518ms      | 2            | 1,654 / 50             | jev      |
| T5 多步微任务 (搜索并查看详情)  | 574ms      | 2            | 1,654 / 51             | jev      |

单步中位数耗时仅 **~260–350ms**；相比传统大模型全链路循环，端到端耗时降低 **>75%**，Token 消耗节省 **>80%**。

---

## 🚀 极速上手

### 方案一：交给 AI Agent 自动安装 (推荐)

直接复制以下一句话发送给你的 AI 编程助手（Claude Code、Cursor、Windsurf、Codex）：

> _“帮我配置 BrowserPaw：https://github.com/GoldenLoaf24h/browserpaw ，阅读仓库中的 `INSTALL.md` 并按步骤自动安装。”_

AI 将自动完成本仓库的编译与本地原生消息宿主的注册。随后你只需打开 `chrome://extensions` 开启“开发者模式”，点击“加载已解压的扩展程序”，选择本仓库已生成的 `app/chrome-extension/.output/chrome-mv3` 目录即可。

### 方案二：免编译预构建包安装 (无需本地编译)

1. 从 [Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest) 下载最新的 `browserpaw-extension-v*.zip` 与 `browserpaw-skill-v*.zip`。
2. 将扩展解压到本地持久目录，打开 `chrome://extensions` 开启开发者模式，点击**加载已解压的扩展程序**。
3. 一次性注册原生消息宿主：在服务端目录运行 `node dist/scripts/register-dev.js`。
4. 将完整的 `skill/` 目录（含 `references/` 文件夹）复制到 Agent 的 skills 目录（如 Codex: `~/.codex/skills/browserpaw/`）。

### 方案三：本地从源码编译安装

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw && pnpm install && pnpm build
cd app/native-server && node dist/scripts/register-dev.js
```

随后在 `chrome://extensions` 中加载 `app/chrome-extension/.output/chrome-mv3`。

### 一键验证安装状态

在终端运行全链路内置体检脚本，验证所有组件是否正常运作：

```bash
node skill/config/doctor.mjs
```

完整接入指引（Codex Stdio、Cursor、Claude Desktop、Hermes 插件、Jev API Key 配置等）请参阅 **[INSTALL.md](./INSTALL.md)**。

---

## 🛠️ 全量工具分类全览 (50 个核心规范 MCP 工具)

全量 50 个核心规范 Schema 校验的工具（49 个确定性浏览器原子工具 + 1 个目标自驱微闭环）归纳为以下 8 个大类别。**点击对应分类即可展开查看工具清单。**
完整 JSON Schema 与入参定义请参阅 **[docs/TOOLS.md](./docs/TOOLS.md)**。

<details>
<summary><b>🧠 0. 目标自驱微闭环 (1 个工具)</b></summary>

<br/>

- **`chrome_act_toward_goal`**：自主语义微闭环执行器，在 Native Server 本地以 200~400ms/步 极速闭环感知、决策与执行。由 TypeSafe Jev System One 驱动，无 Key 或遇额度网络降级时无缝切换内置启发式引擎；遭遇歧义、破坏性动作（14 个敏感词拦截）或卡滞时结构化反抛交回宏规划大模型。

</details>

<details>
<summary><b>🌐 1. 导航与标签页管理 (7 个工具)</b></summary>

<br/>

- **`chrome_navigate`**：URL 网页跳转、前进、后退或整页刷新。原生支持 `background: true`，后台静默打开绝不抢占前台焦点。
- **`chrome_switch_tab`**：平滑切换活跃标签页，或绑定 Agent 会话与特定标签页的上下文亲和度。
- **`chrome_close_tabs`**：按 ID 数组、URL 通配规则批量关闭标签页，安全关闭前台页面需显式 `confirm: true` 保护。
- **`chrome_move_tab`**：精确调整标签页在窗口中的索引位置，或在不同浏览器窗口之间迁移/分离标签页。
- **`get_windows_and_tabs`**：枚举当前打开的所有 Chrome 窗口与标签页的元数据（ID、标题、URL 与激活状态）。
- **`chrome_attach_tab`**：显式挂载特定标签页的底层 Chrome DevTools Protocol 调试器连接。
- **`chrome_detach_tab`**：显式解除特定标签页的调试器挂载。

</details>

<details>
<summary><b>📄 2. 内容感知、检索与数据提取 (7 个工具)</b></summary>

<br/>

- **`chrome_read_dom`**：极简剪枝 DOM 交互树，带 1-based 纯数字索引，Token 消耗压缩 85%+。深度穿透多层 open/closed Shadow DOM，提取纯图标按钮的 accessible 名称。
- **`chrome_scroll_until_found`**：客户端高性能 RAF 平滑流式滚屏查找，自动沉降虚拟列表与 DOM 回收节点，找到目标元素后居中高亮并返回活跃索引。
- **`chrome_grep`**：毫秒级正则/文本定向检索，穿透 Shadow DOM 边界提取文本，超大页面免除 Dump 全量 DOM。
- **`chrome_get_markdown`**：提取页面排版优美、纯净结构化的 Markdown 文本（支持 `includeLinks: true` 提取链接图谱），阅读长文与资料总结首选。
- **`chrome_inspect_media`**：内存无损提取 `<img>` 与 `<canvas>` 原始图像 Data URL，支持 200%+ 超采样局部特写裁切。
- **`chrome_get_dropdown_options`**：直接读取原生或自定义 `<select>` 下拉选择器的全部可用候选项。
- **`chrome_console`**：捕获、实时监听并过滤页面中的 JavaScript Console 日志与未捕获异常。

</details>

<details>
<summary><b>🖱️ 3. 页面交互、输入与流水线 (15 个工具)</b></summary>

<br/>

- **`chrome_interact_index`**：核心物理级点击/悬停/双击/连击序列（`points` 数组），原生支持 `includeDelta: true` 自动回传局部变动，并具备视觉回退动态滚动补偿（`alignVisualCoordinate`）。
- **`chrome_fill_index`**：纯原生物理输入，支持清空重填、Enter 提交与 `includeDelta: true` 变动核验。
- **`chrome_batch_actions`**：闭环批处理流水线，单次网络调用按序执行点击、填充、等待，内置 `assert` 断言与 `extract` 提取。
- **`chrome_form_pipeline`**：确定性复杂表单/向导流水线，零模型调用，标准复杂表单填表最稳最快。
- **`chrome_smart_scroll`**：智能自适应滚屏，具备视口溢出检测、像素精确滚动与剩余滚动页数（`pages_down`）感知反馈。
- **`chrome_keyboard`**：派发单键（Enter/Tab/Esc）、组合快捷键（Ctrl+C/V）或指定元素文本聚焦输入。
- **`chrome_upload_file`**：动态拦截本地文件选择对话框，或直接向 `<input type="file">` 注入绝对路径。
- **`chrome_insert_media`**：针对现代 Web 富文本与聊天编辑器（如 ChatGPT、Claude、Twitter/X、Discord）的直接零拷贝媒体拖放注入，绕过原生文件选择框。
- **`chrome_handle_dialog`**：响应或预设针对 JavaScript 原生弹窗（Alert / Confirm / Prompt）的自动处理策略。
- **`chrome_handle_download`**：追踪、监听并管理浏览器底层正在进行的原生文件下载。
- **`chrome_computer`**：兼容 Anthropic Computer Use 协议的统一光标与键盘物理控制接口。（_遗留兼容通道，新自主闭环优先推荐 `chrome_act_toward_goal`_）。
- **`chrome_request_human_intervention`**：页面毛玻璃暗化并挂起，让渡控制权供人类完成滑块/2FA，完成后一键无缝恢复。
- **`chrome_undo_last_action`**：5 步环形栈撤销引擎，单步回滚最近一次页面跳转或表单输入。
- **`chrome_dismiss_overlay`**：一键精准清理各类营销弹窗、浮层、广告模态框与 Cookie 授权条。
- **`chrome_javascript`**：在页面隔离环境中执行任意自定义 JavaScript 脚本（支持单行表达式自动 return）。

</details>

<details>
<summary><b>👁️ 4. 视觉感知与底层诊断 (3 个工具)</b></summary>

<br/>

- **`chrome_screenshot`**：捕获视口或整页截图，可选叠加高对比度半透明像素标尺网格（Visual Fallback 必备）。
- **`chrome_cdp_execute`**：工业级底层 CDP 逃生通道，支持 Target 多态路由与超时防死锁自动脱离。
- **`chrome_tool_docs`**：动态查询工具文档，支持在会话级按需解锁全量工具分类（`activateForSession: true`）。

</details>

<details>
<summary><b>🗂️ 5. 浏览器管理与存储 (10 个工具)</b></summary>

<br/>

- **`chrome_tab_group_create`**：创建带专属色彩与任务标题的 Chrome 标签分组（默认名称：“Agent”）。
- **`chrome_tab_group_update`**：动态修改标签组标题、主题颜色或切换折叠状态。
- **`chrome_tab_group_list`**：枚举当前窗口内的所有活跃标签分组及其关联标签。
- **`chrome_tab_group_ungroup`**：将指定标签页从分组中解散移出。
- **`chrome_tab_group_close`**：一键关闭组内所有标签并彻底销毁空分组（零孤儿残留）。
- **`chrome_history`**：按关键词或自定义时间跨度检索浏览器历史访问记录。
- **`chrome_bookmark_search`** / **`chrome_bookmark_add`** / **`chrome_bookmark_delete`**：检索、新增或删除 Chrome 收藏夹书签。
- **`chrome_storage`**：读取、写入或清理当前站点的 `localStorage`、`sessionStorage` 与 Cookie 数据。

</details>

<details>
<summary><b>📡 6. 网络拦截与请求 (3 个工具)</b></summary>

<br/>

- **`chrome_intercept_api`**：静默嗅探并解码匹配 URL 模式的后端接口返回，直接提取结构化 JSON 数据。
- **`chrome_network_capture`**：开启或停止全链路网络请求录制（涵盖状态码、响应头与传输载荷）。
- **`chrome_network_request`**：通过当前浏览器会话代理发送原生 HTTP 请求，继承当前站点的 Cookie 与会话头。

</details>

<details>
<summary><b>🩺 7. 性能分析与健康检查 (4 个工具)</b></summary>

<br/>

- **`performance_start_trace`** / **`performance_stop_trace`** / **`performance_analyze_insight`**：录制并深入分析 Chromium 底层性能 Trace 指标。
- **`chrome_doctor`**：诊断运行环境健康状况、检查端口 12306、Native Messaging Host 与插件通信链路。

</details>

---

## 🏗️ 架构拓扑

```text
AI 智能体 (Cursor / Claude / Codex)
         │  MCP 协议 (HTTP / SSE / Stdio) @ 127.0.0.1:12306
         ▼
本地原生网桥 (Fastify + Stdio 宿主)
         ├── 极速决策引擎 (Jev 客户端 + 零依赖启发式降级 + 语义微循环)
         ├── 49 个确定性原子工具 + 1 个自主微循环（共 50 项工具穿透直通）
         │  Chrome Native Messaging 本地双向管道 (1MB 物理截断保护)
         ▼
Chrome MV3 扩展 (Service Worker + WXT + Vue 3)
         ├── 页内 DOM 引擎 (隔离世界注入，1-based 动态索引)
         ├── CDP 会话管理器 (10分钟长闲置常驻，Domain 引用计数)
         └── Agent 虚拟光标 (Closed Shadow DOM 弹簧物理悬浮层)
```

系统详细设计与交互时序见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（含 ADR-023 双脑分层架构决策记录）。

---

## 📚 项目全景文档库

- **[项目地图导览](./docs/MAP.md)**：🗺️ 快速按角色导航、全工程 Monorepo 代码拓扑树与文档矩阵。
- **[全量工具字典](./docs/TOOLS.md)**：自动化生成的 50 个工具完整参数输入输出参考手册。
- **[Agent 交互实操心法](./AGENT_CONFIG_GUIDE.zh-CN.md)**：面向大模型的六大高能交互准则与主流客户端配置样例。
- **[深度系统架构](./docs/ARCHITECTURE.md)**：多进程拓扑、IPC 安全边界与设计决策记录 (ADR)。
- **[故障排查指南](./docs/TROUBLESHOOTING.zh-CN.md)**：常见报错代码与连接异常秒级诊断排查。

---

## 💡 站在巨人的肩膀上（参考开源项目）

BrowserPaw 在设计与实现中汲取了开源社区的卓越智慧：

- **[hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)**：奠定坚实的 MV3 扩展 + Native Messaging 双向 IPC 底座。
- **[browser-use/browser-use](https://github.com/browser-use/browser-use)**：启发极致省 Token 的 1-based DOM 索引理念。
- **[browseros-ai/BrowserOS](https://github.com/browseros-ai/BrowserOS)**：引入操作自驱 Diff 回传（`includeDelta`）与定向快速检索（`chrome_grep`）。
- **[ChatGPT 官方 Chrome 扩展](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg)**：1:1 复刻弹簧动力学虚拟鼠标悬浮层与专属标签组生命周期管理。
- **[TypeSafe Jev](https://docs.typesafe.ai)** 以及开源参考项目 [jev-browser](https://github.com/jkudish/jev-browser)、[jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser) 与 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)：启发 System One 极速判定模式、投机式问题扇出 (Speculative Fan-out) 以及语义化准则设计。

---

## 📄 开源许可协议

本项目采用 [AGPL-3.0 license](./LICENSE) 协议开源。任何修改、衍生打包或提供网络 SaaS API 服务均须强制同等开源。
