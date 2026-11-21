# Ego、Aside 与 BrowserPaw：当前能力矩阵

## 4.1.0 收口说明（2026-10-31）

按用户决定停止 320 条 M7 采样，已有记录、失败和成本原样保留。此次发布收口包含已实现的可靠执行、观察复用、任务资源、持久代码会话与多客户端插件；不再以完成三方性能排名作为发布前提。两条有效历史样本不足以证明 95% 成功率或 20%/30%/50% 效率门槛，也不支持“全面超越”的结论。

当前版本说明见 [v4.1.0](../releases/v4.1.0.md)。以下内容均按其原 buildId 和时间理解；最终门禁与生产运行验收另行核对，不把旧构建回执改名成新版本通过记录。

最后更新：2026-10-30。持续实施和最新验收状态见[蓝图实施账本](./browserpaw-blueprint-implementation.zh-CN.md)。下文的起始构建记录保留为历史证据，不代表后续构建仍有相同故障。

下载来源与回执本轮继续补齐：BrowserPaw 使用 Page 域真实事件中的 tab/frame/GUID，不能将 Chrome 的全局文件名搜索当作任务归属证明。查询已观察 GUID 不重复动作，等待取消不结束其他消费者，来源失联明确保留未知状态。该设计吸收事件回执和资源随消费者存活的原则；实现与回归不代表真实运行已验收，也不据此推定 Ego／Aside 的下载细节或三方效率排名。F 批因该缺口停止，不能宣布完整蓝图或 320 条正式测评已完成。

最近已验收运行时为 `paw-mvuc839k-2ac9fcb7`，包括 closed Shadow DOM 的命名填入、可信输入和按键，以及观察预算、样式表身份和客户端退出。正式前瞻基线仍是 `paw-mvrdj36i-ab338361`。各历史候选的故障、机制复验和预检按原构建保留，不构成新构建的效率排名。

本轮补充的共同执行器修复采用原生选择后整段插入：不借 Enter 生成换行，不在可信输入后追加合成事件；CSS 参数不再误作引用，严格定位失败时拒绝变更。HTTP/stdio 仅对工具自身帮助映射命名空间，网页原文、URL、技能字段和失败回执保持原值。新源码的专项回归与正式门禁、重载后实测分别记录；这些机制修复不能代替 M7 的成功率和效率门槛。

Native 新一轮修复贯通原子 MCP、task/page 与技能服务的派发状态及回执：派发前拒绝为 blocked，等待响应超时为 unknown/retry:false，不把请求已发送写成物理动作已发生；诊断文本、图片和原回执保留。缺少 tabId 的未知创建持久阻止再次建页和默认清理，明确保留并确认才可交还潜在页面。页面预算、无效建页响应以及结束／交还过程也有失败回归；五组专项共 119 项通过。完整发布门禁及新运行时证据须跟随新指纹另行记录，不能复用旧候选的通过记录。

X 预检曾发现观察层丢失长正文：221 字符的目标帖正文可直接读取且包含原验证短语，但 compact DOM 删除了正文，关闭卡片合并或虚拟化也未恢复。根因是标准剪枝把超过 80 字符的非交互文本叶节点整体排除。已改为通过已有 `maxTextLength` 截断正文，保留节点；四项失败回归转绿，连同卡片、表格和引用专项共 60 项通过。原 X 独立验证断言未改，候选运行验收与后续阻断分别记录。

后续 `paw-mvrdj36i-ab338361` 已通过真实 MDN 搜索、代码接口、iframe 键盘和 32 项 OOPIF 事件／断言，修复了下文记录的 OOPIF 与 MDN 搜索断点。用户已确认它为正式前瞻效率基线，142 个冻结文件均有哈希校验；它不能替代未保存完整产物的原始构建。

`paw-mvrnqvih-a7d4f3d4` 已留下代码接口、iframe 键盘、OOPIF、接管和观察／截图保护的独立真实回执。文件超过一小时的存活、释放及 Native 重启恢复另有历史构建回执，不能改写成该构建的新测试。本轮源码还修复了 dialog 派发状态、任务建页记录和自动技能程序的信任边界，须重新通过完整门禁、部署与真实验收。

M7 的正式多步路径使用 BrowserPaw 持久 REPL、Ego CLI 和 Aside 官方持久 MCP。现有三方试次包含启动或中途视口条件失配，作为管道诊断保留，不进入效率配对。正式样本量不足，20% 耗时、30% Codex 累计 input token 和 50% 技能复用门槛均未判定，不能据此宣称整体效率领先。

本轮实测起始构建为 `paw-mvqnee9f-053857e9`。任务生命周期、唯一元素预算和 npm 技能闭环已有真实通过记录；OOPIF 观察及 MDN 技能暴露了追加修复。REPL 客户端重新构建后已跑通多步代码流程及 npm 新输入复用，不能据此推定扩展也已重载。M7 Agent 端到端评测没有达标数据，不能宣称 20%/30%/50% 效率门槛或全面超越。各构建的运行身份以外层实测回执和 doctor 为准。

## 2026-10-30 开发追加

本轮补齐请求取消与持久任务生命周期的分离、实际 JS 方法帮助，以及按文档复用标准／fast／动作后采集的生产入口。缓存同时检查 DOM、控件属性、CSSOM／媒体条件、Shadow DOM、焦点、布局、视口和引用身份；状态不确定时完整采集，不关闭 delta。其检查本身有成本，不能从“命中缓存”推定端到端更快。

2026-10-30 开发追加：预算现在以焦点、错误、动态提示和相关表单／结果区域的优先级选取唯一元素，同级继续跨框架轮转，标准分页和 fast 两层预算共用判断。fast 补充深层 Shadow DOM 采集；观察与定位的 ARIA 名称使用各自所属树的 ID 引用。真实 MDN 上的受控双框架已复现旧版漏掉 closed-shadow 焦点，须用新构建按原断言复测。另补构造样式表身份失效和自建 REPL 客户端会话释放；取消后的自然进程退出也须单独验收。以上是可核对的产品实现，不能据此推定 Ego 原生快照算法、Aside Blink 行为或 M7 效率目标已经等价或超越。

本地相同 cl100k 文本估算下，帮助索引从 18,788 降为 1,475 tokens，`locator.click` 帮助从 1,654 降为 139；这是具体 JSON 的上下文开销，不是模型实测用量或 M7 的 30% 门槛。新源码仍须完整门禁、部署和独立运行验收；E 批次已有样本保留，新版本不得混入旧冻结候选的效率配对。

## 证据层级

| 标记      | 含义                                                                     |
| --------- | ------------------------------------------------------------------------ |
| 源码/回归 | 当前仓库已有实现及测试、专项回归或完整门禁；不等于 Chrome 已加载该代码   |
| 真实实测  | 明确 buildId 的 Chrome、Native 和真实网页回执；只写回执能证明的行为      |
| 历史证据  | 旧 build 或旧产品版本的有效观察，已被当前 build 取代，不作为当前通过依据 |
| 闭源未知  | Ego 原生算法、Aside Blink/C++ 等无法由 JavaScript bundle 或公开说明推定  |

本轮实测前的完整门禁指纹为 `76f184180dc15bc4c3b93b2568d8e6ef15f7153ab1899ee21bc4890b6095885c`，14/14 步通过，扩展测试 1357/1357、Native 测试 418/418、plugin pytest 37 通过/1 个 Hermes 环境跳过、模拟 E2E 153/153。该记录在 2026-10-27 20:15 左右结束；之后的修复不在该指纹内。最新门禁始终读取 `.artifacts/verification/latest.json`，并核对它与当前源码一致，不能用旧记录背书。

## 历史机制矩阵与起始构建验收记录

| 能力                               | BrowserPaw 源码/回归                                                                                                                                                                             | BrowserPaw 真实实测                                                                                                | Ego/Aside 可确认                                                                                | 当前结论                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 任务生命周期、所有权与预算         | `task.start/open/observe/finish`、8 页默认预算、owned/borrowed 页面、身份核对和释放均有实现与回归                                                                                                | 起始构建 91 项检查覆盖并行隔离、预算、borrow、交还、取消、跨连接接管和身份保护，原用户页不变                       | Ego 有 PageLedger、预算和用户页保护；Aside 有私有 agent tab 协议。完整等价性未证明              | 上述生命周期通过；worker/Native 重启仍需实机                 |
| 引用身份与失效                     | 文档 namespace、`WeakMap` 元素身份、失效拒绝和禁止旧引用重绑已实现；相关门禁通过                                                                                                                 | 当前 19 次 review 回执覆盖索引动作，但没有把完整 stale-ref 矩阵当成当前已全测                                      | Ego 使用 frame/backend-node/document 身份；Aside 使用紧凑 `eN` 引用；其内部边界不能只看文档推定 | 源码方向明确；跨导航和替换节点的完整 live 复测仍缺           |
| 严格定位与歧义                     | CSS/XPath/文本/role 唯一解析、跨 frame 歧义拒绝、失败不静默降级到主 frame；有生产函数回归                                                                                                        | 当前 review 回执中 CSS、XPath、indexed focus、batch 和可信点击通过；没有宣称所有 locator/所有 frame 场景通过       | Ego 和 Aside 都提供严格定位或 locator 语义；实现不等价                                          | 关键路径通过，完整 cross-frame strictness 仍另测             |
| OOPIF/逐文档观察与 coverage        | 当前源码按 `documentIds` 独立注入 read-only 观察，使用 `injectImmediately`，每个框架失败原因进入 coverage；有专项回归                                                                            | `paw-mvqnee9f-053857e9` 的 OOPIF 脚本失败：`read_dom` 初始全帧注入 4000ms 超时；见下方问题 1                       | Ego 有 frame/document 机制；Aside 的引擎级隔离未知                                              | **live 未通过**；修复待重载验证，不能写成本轮已交付          |
| partial 基线与资产路由             | 完整 baseline 与最新 partial 观察分离；partial 不替换完整 baseline、不推断删除；partial 资产路由单独缓存；代码与专项回归已落盘                                                                   | 当前 live 仍是上述 OOPIF 失败；不能把待重载代码归入当前实机结果                                                    | Ego 的 PageLedger/快照算法原生部分未公开；Aside 闭源 Blink 行为不可推定                         | 设计正确，待真实重载和资产截图闭环                           |
| 动作前检查与回执                   | disabled、inert、aria-disabled、readonly、遮挡、两帧几何稳定；popup/dialog/chooser 收据；未知写操作不自动补点或重放                                                                              | `review-fixes` 19 次调用通过，batch/click 回执出现可信事件；不是全部输入、文件 chooser、长任务和异常恢复的证明     | Ego 提供多种 actionability 模式；Aside 有 locator 和动作前解析；本地源码不能证明其 Blink 级实现 | 基础交付可信；完整动作矩阵仍待实机                           |
| 快照、上下文与 delta               | compact/fast、250 个唯一元素预算、跨框架轮转、delta、结构去重和输出预算均有实现                                                                                                                  | 受控 Chrome 页面保留 150 输入的 150 引用；五框架各获 50，准确遗漏 50；fast/standard 引用一致，替换节点后旧引用拒绝 | Ego 的原生 snapshot 算法未知；Aside 的裁剪和 token 策略不可见                                   | 预算机制通过；cl100k 估算不能替代 Agent token 效率排名       |
| 技能 propose/validate/run/rollback | 候选/正式版本隔离，两组新任务独立验证，版本、停用与回滚；失败保留结构化业务原因                                                                                                                  | npm 和 X 有界帖子串均经两组独立复测启用及第三输入复用；MDN、GitHub、X 搜索待新扩展复测                             | Ego 与 Aside 有站点技能；已读 Aside X 技能确有 API 型搜索及可见同作者帖子串接口                 | X 帖子串核对实际父帖关系，仅承诺已加载部分；其他技能逐项验收 |
| REPL 与代码编排                    | 持久 Node REPL，task/page/frame/locator/skills/help，默认 fill 替换且允许清空；原始 MCP 内容保留                                                                                                 | 重新构建的 Native 客户端已在真实 Chrome 执行 label 填入、键盘、role 等待、一次可信点击、任务清理及技能复用         | Ego 有 CLI/页面模型，Aside 有代码会话；API 形状不同                                             | 当前支持子集有实机调用；不是完整 Playwright 兼容             |
| 页面归属、后台与视口               | 显式 owned 页面申请并读回 1440×900；释放后清理；截图身份、滚动/DPR/DOM 变化校验和跨 frame 资产路由有回归                                                                                         | 当前任务在 MDN 页面成功读回 `viewport.status=applied, 1440x900` 并在 finish 后释放；后台焦点、弹窗和截图未覆盖     | Ego/Aside 的固定视口和私有 tab 机制可能更强，但本机无法证明完整等价                             | 视口基本路径通过；后台等价性未知                             |
| 文件、剪贴板与上传                 | 文件消费者租约、重连恢复、失败不重放；重连先恢复后核对，状态读失败不发空权威清单；填入不写系统剪贴板                                                                                             | W3Schools 原生输入已选入并读回 22 字节，Native retained 与 document 消费者确认；真实一小时长测进行中               | Ego 的剪贴板事务、Aside 的文件 API 有可读证据；原生生命周期不能完全推定                         | 即时字节通过；长延迟、重连及释放仍需验收，未碰用户剪贴板     |
| 安全、凭据与受限页                 | bridge token、loopback、受限 URL 拒绝、owned 页面释放、RPC 错误不重放                                                                                                                            | 当前 doctor 为 healthy；这不能替代安全审计，也没有新的跨用户数据实验                                               | Ego/Aside 的原生权限和隔离实现未知                                                              | 基础边界存在；高风险场景仍缺独立审计                         |
| M7 评测                            | 评测器要求每 family 至少 20 个不同输入、至少 3 批和三批轮换；正式 token 门槛使用同条件成功配对的 Codex-reported cumulative input token（含缓存），cl100k 只在 summary 诊断，图片输入不得称纯文本 | **没有**当前 Agent 端到端数据                                                                                      | Ego/Aside 的同条件数据也不足                                                                    | 只能报告机制测试，不能报告效率门槛或排名                     |

## 起始构建 live 已发现问题（历史）

### 1. OOPIF 全帧 `read_dom` 注入超时

回执 `.ego-research/oopif-upgrade-live-paw-mvqnee9f-053857e9.json` 的 `passed` 为 `false`，首个事件即：

```text
executeScript timeout (injection, 4000ms): renderer not acking
```

这不是普通选择器失败，也不是已经完成的修复。Chrome 官方文档说明：`runAt` 的首选和默认值是 `document_idle`，`injectImmediately` 默认关闭；未完成加载的子文档可能拖住 `allFrames` 的整体注入。官方参考：<https://developer.chrome.com/docs/extensions/reference/api/scripting>。

当前源码已经把 read-only 观察拆分到独立 `documentIds`，并设置 `injectImmediately`；每个框架的失败应转成 coverage 中的独立原因。相关实现和 `frame-observation-isolation` 回归已落盘，但当前 Chrome 尚未加载并验证这批改动。**在这份 live 回执被新构建的通过回执替代前，OOPIF 仍记失败。**

### 2. MDN skill validation 失败

回执 `.ego-research/task-skill-upgrade-paw-mvqnee9f-053857e9.json` 中，任务开始、打开、观察和结束均成功；`skill.get('mdn-search')` 成功；随后 validation 失败：

```text
output: data/sources/api must match pattern
"^https://developer\.mozilla\.org/api/v1/search"
```

根因是输出脱敏把含多个普通查询参数的完整来源 URL 当成裸查询字符串整体删除。源码修复后保留公开 URL，同时继续脱敏敏感参数；MDN 的 locale 和来源校验保持。npm 比较技能已用两组不同输入通过并启用；GitHub 执行预算修复待新扩展复测。X 实际已登录，先前将无文章且含登录文案的页面误判为认证失败；候选现有界等待并区分加载超时。新 x-visible-thread 用真实父帖 ID 核对回复链，两组不同输入独立复测启用后，第三输入复用读取焦点帖及其同作者回复成功；不承诺未加载内容。

### 3. 当前 build 的通过范围有限

- `review-fixes` 共 19 次调用全部返回非错误，`status=passed`，覆盖 CSS、XPath、indexed focus、batch 和可信点击。
- `task-lifecycle` 在该构建通过 91 项检查：并行隔离、八页预算、borrow/handOff、取消、跨连接明确接管、身份变化拒绝关闭。1440×900 和模拟 DPR/页面缩放通过；未操作真实 OS 窗口缩放，也未完成 worker/Native 重启验收。
- 真实 Chrome 的受控 fixture 验证 150 个输入保留 150 个唯一引用，五框架共享 250 个引用且各获 50 个，准确遗漏 50 个；fast/standard 引用一致，替换节点后旧引用被拒绝。这是机制测试，不是日常任务性能排名。
- 重新构建的 Native REPL 客户端在同一连接执行 label 填入、键盘、role 等待与一次可信点击，并从新连接复用 npm 技能的新输入。原始 MCP 类别提示曾破坏 JSON 解析，已通过失败回归修复；原始提示和图像仍保留。
- 22 字节真实文件已选入 W3Schools 原生输入且读回一致，长测消费者保持活跃。超过一小时和重连后的读取及释放仍需实际计时验证，不能用单测时间推进代替。
- 当前没有 M7 Agent 端到端记录；不能把模拟 E2E、机制测试或单页任务回执换算成 20%/30%/50% 收益。

## 历史证据与已替代状态

以下内容保留为历史观察，不进入当前 build 的通过清单：

- 旧基线 `paw-mvkhkrwm-64b02892` 的 review 19 calls 和 OOPIF 27 个断言事件已由当前 build 取代；旧 build 的通过不能覆盖当前 OOPIF 超时。
- 旧 build 的真实文件字节、MDN 点击、W3Schools dialog、截图和跨框架资产回执仍有证据价值，但不代表 `paw-mvqnee9f-053857e9` 已重测同一场景。
- 旧版曾把“没有页面预算”“没有 skill 执行”列为缺口；这是历史状态。当前源码已有 8 页预算和 skill API，但 mdn skill validation 仍失败，不能改写成“技能已交付”。
- 旧 5 站单次对照和三站各三轮对照只说明当时的混合结果：部分过程成功、部分 partial/blocked，等待、视口、登录态和观察策略不同，不能合成 5/5 或统一性能排名。
- 同一回执内把 18,159 UTF-8 字节结构去重到 2,529 字节，是字段去重，不是 tokenizer 测量，也不是三方 token 压缩排名。
- Ego 的 JavaScript 协议、Aside 的本地 CLI/daemon bundle 可作机制证据；Ego 原生快照、Aside Blink/C++ 行为仍是闭源未知。不能由可读 JS 推定其原生实现相同。

外部边界资料仍包括 [Ego 官方源码](https://github.com/citrolabs/ego-lite)、[Aside 技术说明](https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable) 和 [Aside 帮助文档](https://docs.aside.com/)。

## 起始构建验收清单（历史）

| 验收项        | 通过条件                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 观察隔离修复  | 重载包含逐 `documentId` + `injectImmediately` 的构建；`oopif-upgrade` 通过；可读框架保留，失败框架带原因 coverage；不再出现无信息的全帧 4 秒超时                                                                                                                                                               |
| partial 安全  | 新构建真实页面同时验证：完整 baseline 不被 partial 替换、partial 资产路由可截图、delta 不推断删除、导航后 baseline 正常失效                                                                                                                                                                                    |
| 技能闭环      | mdn skill 的来源/API 契约修好；validate、run 和独立 DOM/GET 断言均通过；其他内置 recipe 分别有成功或明确 blocked 回执；X 不伪造登录态                                                                                                                                                                          |
| 任务压力      | 两任务并行、预算超限、用户页借用/交还、worker/Native 重启、取消和 finish 竞态均有真实回执                                                                                                                                                                                                                      |
| 后台与视口    | 前台持续操作时后台任务不抢焦点；popup、窗口缩放、DPR、截图后 DOM 变化和 Canvas/纯 CSS 动画边界均记录                                                                                                                                                                                                           |
| 文件与剪贴板  | >1 小时延迟读取、动态 file chooser、已选择文件保护和不覆盖用户新剪贴板内容均有实测                                                                                                                                                                                                                             |
| M7 Agent 评测 | 每个主要 family 至少 20 个不同输入、至少 3 批轮换；正式 token 门槛使用实际 Codex 累计 input token，要求覆盖全部墙钟成功配对；cl100k 估算只作诊断；后台图片计数不能证明 Agent 输入无图片，累计输入不冒称纯文本；报告成功/partial/blocked/failure、P50/P95 和不确定性，达到机制与 Agent 两层门槛后才谈效率或排名 |
| 完整门禁      | 当前工作区最新源码重新运行完整 `pnpm verify`，记录新源码指纹；本文对应的旧 14/14 gate 不覆盖之后的 OOPIF/partial 改动                                                                                                                                                                                          |

上述清单记录起始构建当时的缺口；后续通过与新增故障以本文开头和实施账本的具名构建回执为准。全蓝图和效率门槛尚未完成验收，不能宣布完全交付。

补充实测证据位于外层 `.ego-research/task-lifecycle-paw-mvqnee9f-053857e9.json`、`observation-budget-paw-mvqnee9f-053857e9.json`、`code-api-live-paw-mvqnee9f-053857e9.json` 和 `skill-candidates-paw-mvqnee9f-053857e9-1793105072363.json`。长测状态单独记录在 `lease-longevity-state.json`。矩阵中的“当前实测”按这些具体范围理解，不覆盖之后尚未重载的源码修复。
