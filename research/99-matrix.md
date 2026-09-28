# 技术全景横向对标决策总矩阵 (99-matrix.md)

> **编制依据**: §4 阶段三·技术矩阵；汇集子代理在 Type A/B/C/D/E 9 篇深度测绘成果中的第一手源码证据。  
> **验证基线**: §A 双重验证纪律（全部具备明确可回链的 `repo@path:line` 源码级坐标定位）。  
> **核心保护**: §0 与 00-current-architecture.md 标定的 5 大「本地优势，默认保护」模块。

---

## 一、九大技术维度全景横向矩阵

| 维度 / 项目                  | BrowserPaw (本项目)                                                               | BrowserOS (Type A)                                            | browser-use (Type B)                                                               | agent-browser (Type B)                                                 | Playwright MCP (Type C)                                                | Chrome DevTools MCP (Type C)                                             | browser-mcp (Type D)                                           | nanobrowser (Type D)                        | Stagehand (Type E)                                               | Skyvern (Type E)                                            | Steel-browser (Type E)                                   |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| **1. 桥接/会话层**           | Native Messaging 双向管道 + 850KB UTF-8 字节切片 (`native-messaging-host.ts:481`) | Rust 原生二进制 (`claw-server-rust`) + WebSocket / IPC 双通道 | Python CDP 异步直连 (`browser/session.py:134`)                                     | Rust CLI + 本地 Daemon / Unix Socket (`connection.rs:645`)             | Node.js 进程内 In-process Playwright 引擎                              | CDP 端口读取 (`DevToolsActivePort`) + 命名管道 (`BrowserManager.ts:306`) | WebSocket 端口池 (9876-9895) + HTTP 预探测 (`offscreen.js:75`) | 纯 Chrome 扩展内 Service Worker 运行时      | 依赖底层 Playwright/Puppeteer                                    | FastMCP 本地 stdio + 远程 HTTP API                          | 云端 API 容器代理 (`session.service.ts:160`)             |
| **2. 页面表示与 Token 效率** | 1-based 连续数字编号 + WeakRef 隔离 (`dom-indexer.ts:24`)，剪枝 85%+              | 无障碍树 + 双 DOM 快照合成，按需局部采样                      | 4路 CDP 并发 + `paintOrder` 绘制层叠遮挡剔除 (`paint_order.py:146`)                | a11y 树语义角色筛选 + `@eN` 短引用 (`snapshot.rs:480`)                 | ARIA 语义树 (`ariaSnapshot`) + 盒模型坐标 (`snapshot.ts:62544`)        | 完整 DOM 树 / 截图抓取，上下文负荷较高                                   | 结构化 DOM 过滤列表，按可见性粗筛                              | 紧凑文本树 `[index]<type>text</type>`       | AXTree 提取 + XPath / 语义描述三元组                             | 130KB 脚本注入 + 视口等比分片切片截图 (`scraper.py:539`)    | 传统 HTML 提取与整页截图，依赖多模态推理                 |
| **3. 工具抽象 (MCP/CLI)**    | 50 个 Canonical MCP 工具 (7 大类正交划分)                                         | 细粒度 CDP 映射工具包 (`browser-mcp`)                         | 极简 Agent 核心工具组 (`click`, `input`, `scroll`)                                 | 9 级 Tool Profile (`core`, `network`, `react` 等) (`mcp.rs:215`)       | 9 个核心完备动作 + `setIncludeSnapshot` 链式反馈 (`response.ts:63876`) | 调试分析工具集 (`trace`, `network`, `console`)                           | 40+ 细分交互工具，扁平暴露                                     | 双 Agent (Planner / Navigator) 内部流式协议 | `observe/act/extract` 高阶三元抽象 (`observeService.ts:38`)      | 本地与远程统一 FastMCP 工具暴露 (`mcp_commands.py:65`)      | REST API + Session 操作端点                              |
| **4. 跨页/多场景寻址**       | Tab Group 会话绑定 + 相同源/跨源 Iframe 坐标补偿 (`interact-index.ts:18`)         | Tab UUID + Agent-per-tab 独立路由                             | Tab ID 追踪 + 页面生命周期监听 (`session_manager.py:24`)                           | `f<seq>e<id>` 跨帧寻址 + Durable Refs 持久映射 (`element.rs:40`)       | `f<seq>e<id>` 分层命名 + 语义 Locator 动态归一化                       | 目标 TargetID 附着模式                                                   | Tab Group 端口着色会话隔离 + 孤儿接管 (`background.js:230`)    | 活跃标签页绑定                              | 遍历全 Frame 递归收集 AXTree                                     | 视口滚动重置 + 坐标换算                                     | 云端单 Session 单租户独立沙箱                            |
| **5. 现场恢复与自愈**        | PCIE 多态坐标推断 (8角度径向扫描) + 2-rAF MutationObserver 防抖                   | 状态快照重试                                                  | 14 种守卫看门狗 (`watchdogs/`) + 双门禁历史压缩 (`message_manager/service.py:216`) | 节点失效自动回退 `find_node_id_by_role_name`                           | Ref 失效抛出定向提示引导模型刷新                                       | 崩溃连接重试                                                             | 多感官 HITL (音频+角标+页面表单浮层) (`background.js:5040`)    | 任务中断交由人类手动处理                    | 自愈选择器 (`selfHealAction`) + 确定性重放 (`actService.ts:371`) | 失败后重新分片截图二次校验                                  | 会话故障自动重启容器                                     |
| **6. 会话与隔离**            | `chrome.storage.session` 亲和性隔离 + 0 幽灵组垃圾回收                            | 次级独立浏览器 (Neo) 与用户物理隔离                           | 单会话独立实例运行                                                                 | Windows Job Object 强杀进程树 + 虚拟桌面隔离 (`windows_process.rs:77`) | 依赖临时 BrowserContext 沙箱                                           | 依赖 Chrome 独立数据目录 (`userDataDir`)                                 | 20 端口池隔离并发会话 + Domain 权限白名单                      | 纯前端侧状态，无后端会话管理                | 无底层隔离，依赖调用宿主                                         | 请求作用域注入租户配额与 Token 缓存 (`mcp_http_auth.py:40`) | UUIDv4 操作系统级目录物理隔离 (`session.service.ts:160`) |
| **7. 安全边界**              | 原生零外部网络端口暴露 + 物理暂停紧急按键                                         | 独立浏览器安全域                                              | `security_watchdog.py` 预检/后检双重 URL 白名单                                    | 无网络监听，依赖本地 IPC 凭据隔离                                      | 仅访问脚本指定页面                                                     | 严格禁止捕获组的 `URLPattern` 正则防御 (`url.ts:143`)                    | 跨域访问强拦截 (`domain-not-in-session`)                       | 限制在扩展权限范围内                        | 无高级安全过滤                                                   | 敏感数据脱敏过滤器                                          | 敏感 Headers 剥离 + 凭据内存通道加密                     |
| **8. 安装与接入体验**        | 一键安装脚本 + Codex/Claude Desktop 插件无缝注册                                  | 独立安装应用包                                                | Python `pip install` + CLI `--doctor` 探针                                         | 单静态二进制文件，瞬态调用 2ms 冷启动                                  | `npx @playwright/mcp` 零配置启动                                       | `npx chrome-devtools-mcp` + `--autoConnect`                              | 需手动加载解压扩展并运行本地服务                               | Chrome 应用商店一键安装扩展即用             | npm 安装 SDK 引入项目代码                                        | 需部署服务端或使用官方云服务                                | 云端 Docker 部署或 SaaS 接入                             |
| **9. License 与合规风险**    | AGPL-3.0-or-later (SPDX 标准化 + NOTICE 归属)                                     | **AGPL-3.0** (严格禁止复制代码，仅学机制)                     | Apache-2.0 (宽松开源许可证)                                                        | MIT (宽松开源许可证)                                                   | Apache-2.0 (微软官方商业友善)                                          | Apache-2.0 (谷歌官方商业友善)                                            | MIT (宽松开源许可证)                                           | MIT (宽松开源许可证)                        | Apache-2.0 (商业友好)                                            | AGPL-3.0 (高危 copyleft，仅学架构)                          | Apache-2.0 (商业友好)                                    |

---

## 二、关键设计横向优劣对比与量化评定

### 1. 宿主集成形态：Chrome MV3 扩展 vs 纯外部 CDP 直连 vs Chromium Fork

- **BrowserOS (Chromium Fork 路线)**:
  - _优势_: 突破一切扩展 API 限制，可在 C++ 层插入专属 IPC，彻底掌控进程生命周期与多 Tab 硬件加速渲染。
  - _代价_: 维护成本天文数字（每次 Chromium 上游合并需解决数千个冲突），无法保留用户真实 Chrome 的扩展、密码钥匙串与日常免登录态。
  - _结论_: **BrowserPaw 坚决不走 Fork 路线**。继续深耕 MV3 扩展 + Native Messaging，以极小体积（<5MB）实现真实用户环境免登体验。
- **agent-browser / Playwright MCP (纯外部 CDP 直连路线)**:
  - _优势_: 架构极其干净，无扩展审批和 Service Worker 限制。
  - _劣势_: 极易被 Akamai / Cloudflare 等企业级 WAF 识别为自动化机器人（无真实用户 Profile、指纹高度机械化）。
  - _结论_: **BrowserPaw 的扩展代理路线是抵抗 Anti-bot 探测的天然护城河**。

### 2. 页面序列化与上下文消耗：DOM 树 vs AXTree vs 短引用

- **Playwright MCP / agent-browser 的 a11y 树与 `@eN` 短引用**:
  - 实测 Token 消耗相比全量 DOM 降低 70%~85%，对于大模型理解核心交互区域非常高效。
  - 但其短板在于：对复杂 Canvas、WebAssembly UI、CSS 伪元素以及纯视觉排版理解力匮乏。
- **BrowserPaw 独有优势**:
  - DOM-First (WeakRef 1-based) + PCIE 视觉回退（多模态坐标推断），兼备代码级交互确定性与视觉兜底能力。
  - **吸收点**: 引入 browser-use 的 `paintOrder` 绘制顺序剔除算法与 Playwright 的链式快照反馈。

---

## 三、终稿决策结论

通过技术矩阵的全面交叉印证，确立后续实施与方案编制原则：

1. **坚决捍卫 5 大本地优势壁垒**（Dual-Brain 本地微循环、WeakRef 1-based DOM 索引、850KB UTF-8 Slicing、内存环形截图、宿主真实会话隔离）；
2. **精准吸收 4 项顶级开源工程长板**（Stagehand 自愈选择器与重放、Playwright 链式快照增量、browser-use 几何绘制剔除、agent-browser Tool Profile 分级）；
3. **保持 AGPL-3.0 与宽松许可协议的绝对合规边界**，所有吸收内容 100% 采用符合本项目规范的纯自研原生 TypeScript 落地。
