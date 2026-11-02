<div align="center">
  <img src="./docs/images/logo.png" width="128" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>在你正在使用的 Chrome 会话中可靠执行浏览器自动化。</b></p>
  <p>
    <a href="./docs/MAP.md">项目地图</a> ·
    <a href="./docs/TOOLS.md">工具参考</a> ·
    <a href="./AGENT_CONFIG_GUIDE.zh-CN.md">客户端配置</a> ·
    <a href="./README.md">English</a> ·
    <a href="./LICENSE">AGPL-3.0 许可</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">版本发布</a>
  </p>
</div>

---

## 为什么是 BrowserPaw

BrowserPaw 由 Chrome MV3 扩展和本地 Native Messaging 桥接组成。它直接使用你
已有的浏览器配置，不复制用户资料，也不启动另一套自动化浏览器。MCP 客户端
可以观察页面、执行有边界的动作并核对结果，而不必把浏览器会话交给远端服务。

项目刻意分开三件事：

- **静态操作指南**，用于教会 Agent 正确使用 BrowserPaw。
- **持久任务与页面归属**，避免并行任务悄悄接管用户页面。
- **经过验证的站点技能**，只从成功任务中提炼，并在独立复测通过后复用。

---

## ⚡ BrowserPaw 是什么？

BrowserPaw 是一个 Chrome 扩展 + 本地 MCP 服务器。规范工具名以 `chrome_*`
开头，各客户端可以在外层添加自己的命名空间。默认 `core` 配置档只公布日常
所需工具；任务需要更完整的接口时，使用 `CHROME_MCP_TOOL_PROFILE=full` 或
`chrome_tool_docs`。

提供两条执行路径：

1. **确定性工具与流水线**：索引化动作、表单、键盘、上传下载、截图、网络和
   断言，由调用方控制每一步。
2. **`chrome_act_toward_goal`**：当单页目标更适合自然语言描述时，使用有界的
   本地感知-动作微循环。

持久 `browserpaw repl` 通过 task、page、locator、skill 和 help 这一小组接口
提供多步代码编排，并与 MCP 共用执行器。它是明确记录的 BrowserPaw 子集，
不宣称与 Playwright 完全兼容。

---

## 🎯 核心能力

- **复用现有会话** —— 直接使用 Chrome 已打开的配置；BrowserPaw 不复制浏览器
  资料，也不把凭据搬进第二套浏览器。
- **剪枝后的索引化 DOM** —— `chrome_read_dom` 分配文档级引用，并报告动作预算、
  框架覆盖、遗漏区域和截断信息。快速快照优先返回视口与交互目标。
- **严格且感知框架的动作** —— 显式 frame 目标只在该框架解析；歧义匹配直接
  拒绝；嵌套 OOPIF 坐标按真实渲染几何逐层投影。
- **卡片扁平化与视口虚拟化** —— `flattenCards` 将重复的信息流卡片折叠成单行摘要；`virtualizeViewport` 将屏幕外的列表项折叠为计数占位符。
- **Shadow DOM 遍历** —— 递归遍历开放的 shadow root；闭合的 shadow host 会被标记并在宿主层级交互。可从纯图标按钮中提取可访问名称（aria-label、title、SVG title）。
- **批量与表单流水线** —— 在一次调用中执行多步
  click/fill/wait/assert/extract，并明确区分部分完成与结果未知。
- **遮罩层关闭** —— `chrome_dismiss_overlay` 一步关闭营销弹窗、Cookie 横幅和模态框，无需倾倒 DOM。
- **增量观察** —— 动作可同时返回 DOM 变更，避免每一步都附加一次完整快照。
- **原生事件保真度** —— 点击和按键以可信 CDP 事件（`isTrusted: true`）派发，React/Vue/Angular 和 Shadow DOM 处理器都能正常触发。
- **动作结果语义** —— 明确区分派发前拒绝、已派发、未知、后置条件已验证或
  未验证；未知 mutation 不会被静默重放。
- **坐标兜底** —— 当 DOM 索引失效时（canvas、WebGL、未知自定义 UI），通过
  截图和 `chrome_computer` 使用有边界的视觉路径。
- **自适应视口与截图预算** —— 任务自有页面跟随真实 Chrome 窗口尺寸和设备像素比，
  不再强制 1440×900 或 DPR 1。模型内联截图默认按 1568px 长边、约 1.15MP 等比
  缩放，在文字识别与 token 之间取得平衡；`savePng` 保存物理分辨率的无损 PNG。
  截图输出只使用 PNG/JPEG，不再生成 WebP。
- **人工接管** —— `chrome_request_human_intervention` 会压暗页面、显示横幅并停放光标，让用户完成两步验证或验证码；之后自动化继续。
- **任务归属与技能学习** —— 持久任务记录借用页、新建页、交还页和临时页；
  验证通过的站点技能保存在 Native 技能库中，被所有已连接客户端共享。

---

## 🧠 交互式微循环

```text
┌─ 宏观规划器（调用方 Agent）────────────────────────────┐
│  任务拆解、跨页策略、故障恢复                          │
└───────────────────────────┬────────────────────────────┘
                            │ MCP（低频）
                            ▼
┌─ 语义微循环（原生服务器）──────────────────────────────┐
│  chrome_act_toward_goal:                               │
│  感知 → 决策（已启用模型）→ 执行 → 校验              │
│  每步不产生 MCP 往返                                   │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging
                            ▼
┌─ Chrome MV3 扩展 ──────────────────────────────────────┐
│  规范工具 · CDP 事件 · 页内引擎                        │
└────────────────────────────────────────────────────────┘
```

路由指引：

- 固定动作序列、已知索引 → 确定性工具（`chrome_batch_actions`、`chrome_form_pipeline`）。
- 用自然语言描述的单页目标 → `chrome_act_toward_goal`。
- 长周期、跨页面、新颖或需升级处理的场景 → 由调用方 Agent 驱动。

普通点击、填入和指定目标的工具优先执行确定性定位。模型启用时，受支持的非 exact 文本、label 和带名称 role 定位可在未命中时获得一次有界语义辅助；精确 selector、显式引用、坐标、框架边界和动作条件继续严格校验，填入值与目标描述分开。

可选微循环默认 10 步、最多 60 步，选择完整的“动作＋目标”候选；交付结果未知时立即停止，只有独立只读验证通过才报告完成。自动提交仅限明确要求、且已识别搜索控件的搜索任务；外部写入交回调用方 Agent。

**模型模式：**

- **Off**：不推理、不预加载模型，确定性工具仍可使用；微循环不参与工具发现，直接调用也会被拒绝。
- **Local**：使用单独安装的本地 decider；可用性、准确率和性能独立于远程 Jev 验收。
- **Remote**：使用配置的 TypeSafe 端点和模型，通过 `TYPESAFE_API_KEY` 或弹窗配置 Native 服务。候选描述与必要上下文会发往该端点，不要把秘密写进定位描述。
- **故障处理**：保留你选择的后端。网络、超时和限流故障会暂停推理 30 秒，下一次使用时可恢复同一后端，失败操作不会重放。认证或配置错误需要修复；保存有效配置后恢复此前选择的模式。主动选择 Off 后始终保持关闭，重启也不会自动开启。弹窗以 Native 状态为准。
- **现有远程视觉**：继续作为实验能力，在截图采集前核验端点返回的具体模型版本；别名本身不能证明图像能力，坐标时效和授权检查继续生效。

边界、验证、恢复及自学习技能说明见[语义交互与有界目标](./skills/browserpaw/references/dual-brain-jev.md)。

---

## 🚀 快速开始

### 1. 构建桥接并加载扩展

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw
pnpm install
pnpm build
node app/native-server/dist/scripts/register-dev.js
```

打开 `chrome://extensions`，启用开发者模式，加载
`app/chrome-extension/.output/chrome-mv3`。预构建扩展、发布包安装、Windows
细节、Jev 配置和故障排查见 [INSTALL.md](./INSTALL.md)。

### 2. 连接客户端

| 客户端           | 支持的集成方式                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| 通用 MCP 客户端  | Stdio `mcp-chrome-stdio`，或认证的本地回环 HTTP                                     |
| ChatGPT/Codex    | `plugins/browserpaw` 中的 portable 插件，经 `.agents/plugins/marketplace.json` 安装 |
| Hermes Agent     | `plugins/browserpaw-hermes` 中的原生插件                                            |
| Claude Code      | `.claude-plugin/marketplace.json` 中的插件市场                                      |
| DeepSeek Harness | `plugins/browserpaw-dsh` 中的 Cordis bundle                                         |

所有客户端最终连接同一个本地 BrowserPaw Native 服务，因此共享任务、页面归属
和经过验证的站点技能。

### 3. 安装操作技能

普通 Agent Skills 客户端安装随包发布、客户端中立的技能：

```bash
browserpaw skill install
```

默认目标是 `~/.agents/skills/browserpaw`。`--target` 接收技能根目录，最终目录
始终是 `<target>/browserpaw`。`--force` 只能替换带有 BrowserPaw 安装标记的
既有安装。

### 4. 验证

```bash
browserpaw doctor
node skills/browserpaw/scripts/doctor.mjs
```

### Claude Code 插件

BrowserPaw 还提供 Claude Code 插件，同时打包操作技能与 stdio MCP 服务器。
在 Chrome 与扩展已运行的前提下：

```text
/plugin marketplace add GoldenLoaf24h/browserpaw
/plugin install browserpaw@browserpaw
```

在 `/plugin` 面板中选择 user、project 或 local 安装范围。工具以
`mcp__plugin_browserpaw_browserpaw__chrome_*` 形式出现；`/browserpaw` 加载操作
指南。插件从 `PATH` 运行 `mcp-chrome-stdio`，若该 shim 缺失，请先全局安装桥接：

```bash
npm install -g ./app/native-server
```

shell 安装、本地仓库与故障排查见
[INSTALL.md](./INSTALL.md#35-claude-code-browserpaw-marketplace-plugin)。

---

## 🛠️ 工具范围

规范 `chrome_*` 工具覆盖任务与页面归属、导航、DOM 观察、严格索引动作、批量
与表单流水线、键盘、上传下载、对话框、截图、视觉兜底、网络、存储、历史、
书签、性能跟踪和桥接健康检查。运行时 `core` 配置档避免每次都向会话公布完整
工具面。

生成后的 schema 见 [docs/TOOLS.md](./docs/TOOLS.md)，当前 Native 版本的精确
合约可直接调用 `chrome_tool_docs`。客户端前缀不同：DSH 暴露
`mcp__browserpaw__chrome_*`，Claude Code 暴露
`mcp__plugin_browserpaw_browserpaw__chrome_*`，Hermes 则有意提供精简的
`browserpaw_*` wrapper 集合。

---

## 🧩 技能、Reference 与 Recipe

BrowserPaw 将可复用知识分成三层：

| 层                 | 位置                                                              | 用途                                                           |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| 规范 Agent Skill   | `skills/browserpaw/`                                              | 客户端中立的操作说明、`references/`、诊断脚本与随包站点 recipe |
| 已安装静态技能     | `<skills-root>/browserpaw/`（默认 `~/.agents/skills/browserpaw`） | 从 Native 发布包安装的只读副本                                 |
| 自学习 Native 技能 | `$BROWSERPAW_HOME/skills`（默认 `~/.browserpaw/skills`）          | 从成功任务提炼、独立复测后才启用的参数化站点技能               |

规范技能会原样分发到 ChatGPT/Codex、Claude Code 和 DSH 插件。Hermes 使用专用
技能模板，因为它的公开工具面是 `browserpaw_*` wrapper，而不是完整
`chrome_*`/MCP 命名空间。自学习技能不会复制到任何客户端插件目录；所有客户端
都通过共享 Native 服务读取它们。

`references/` 只保存长期有效的操作知识，例如工具选择、动作结果语义、视觉
兜底、任务与技能生命周期、故障排查。这里不得保存临时元素引用、tab、document
或 session ID、坐标、凭据、Cookie 或用户输入。`assets/recipes/` 中的随包
recipe 会复制到 Native 发布包，并作为只读站点指导使用。

---

## 🏗️ 架构

```text
AI 客户端（任意支持 MCP 的 Agent）
         │  MCP over Stdio（推荐的零配置方式）或 127.0.0.1:12306 上的 HTTP/SSE
         ▼
原生消息传递桥接（Fastify + Stdio Host）
         ├── 有界决策微循环（已启用模型）
         └── 规范工具透传与共享执行服务
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
- [工具参考](./docs/TOOLS.md) —— 当前规范工具的 schema。
- [安装与上手](./INSTALL.md) —— 逐步配置，含 Jev key。
- [Agent 集成](./AGENT_CONFIG_GUIDE.zh-CN.md) —— MCP 客户端配置。
- [插件兼容性](./docs/development/PLUGIN_COMPATIBILITY.md) —— 官方包格式与各客户端边界。
- [架构](./docs/ARCHITECTURE.md) —— 设计与决策。
- [故障排查](./docs/TROUBLESHOOTING.zh-CN.md) —— 连接与执行问题。

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

4.1.2 是最新已发布的可靠性版本，统一了观察范围、显式交互结果和表单步骤边界，使确定性工具、batch、REPL 与 Jev 对同一动作返回一致事实。完整门禁、真实浏览器验收、生产部署、Linux/Windows CI 及发布资产均已记录；本次发布还新增显式延迟页面恢复、fast 观察失败关闭语义、统一的可预期页面限制处理与错误页注入恢复。验收范围和迁移说明见[4.1.2 发布记录](./docs/releases/v4.1.2.md)，开发边界见[当前开发工作](./docs/development/DEVELOPMENT.md)。

4.1.0 中已复现的 Native 空闲协议故障完成了修复，并通过同一连接超过十一分钟的实测；这属于有界运行证据，不能推成所有长时间工作负载的保证。

320 条 M7 对标采样已停止，历史证据保留；规划中的 95% 任务成功率、20% 墙钟耗时、30% 输入 token 和 50%
技能复用门槛尚未证明。性能只根据同版本、同条件的配对运行报告。

新一轮 Jev 交互融合尚未完成运行验收。Jev 1.14.0 的独立中文样本中，两项明确目标因置信度不足被安全拒绝，未达到验收要求。确定性工具继续作为默认路径；不降低阈值凑通过，也不以单测代替真实准确率。详情见[开发记录](./docs/releases/unreleased.md)。
