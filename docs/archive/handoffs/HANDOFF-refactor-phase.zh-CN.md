# MCP-Chrome 项目交接文档 (Project Handoff)

## 1. 项目核心背景与技术演进

本项目基于开源的 `mcp-chrome` 项目展开深度现代化改造与工业级架构重构。原项目主要通过简单的 Chrome Extension 注入脚本实现基础的浏览器点击与输入，面对现代复杂的单页应用（SPA）、跨域 Iframe、Shadow DOM、反爬虫机制以及 AI Agent 高频调用场景时，存在诸多稳定性崩溃、通信竞争、Token 消耗过大及操作精度不足的问题。

本阶段重构全面融合了 **`browser-use`**（高压缩比 DOM 树剪枝与 1-based 单调数字索引）与 **`Midscene.js`**（视觉坐标网格标尺、微小元素 ROI 视口扩充、CDP 动态文件选择弹窗拦截）的核心优势，移除了过度设计的端侧本地 ONNX 向量引擎与死代码，并完成了深度的安全与系统级加固：

```
                    ┌────────────────────────────────────────────────────────┐
                    │                      AI Agent                          │
                    │         (Claude Code / Cursor / Windsurf / etc.)        │
                    └──────────────────────────┬─────────────────────────────┘
                                               │ JSON-RPC (HTTP / SSE / stdio)
                                               ▼
                    ┌────────────────────────────────────────────────────────┐
                    │              Fastify Native Bridge (12306)             │
                    │  - Per-Session 工厂隔离 (消除连接互杀)                  │
                    │  - Bearer Token 强认证 (阻断伪造 Origin 越权)           │
                    │  - TOCTOU DNS Rebinding 异步防护 (阻断私网与 IPv6 封装) │
                    └──────────────────────────┬─────────────────────────────┘
                                               │ Chrome Native Messaging
                                               │ (双向 1000KB 硬限截断防护)
                                               ▼
                    ┌────────────────────────────────────────────────────────┐
                    │               Chrome MV3 扩展 (Background)             │
                    │  - SessionTabAffinityManager (会话-标签页亲和性池)     │
                    │  - cdpSessionManager (自动重连、安全附加与 Detach 容错) │
                    └──────────────┬──────────────────────────┬──────────────┘
                                   │                          │
                   【主路径: DOM 优先 (90%)】     【兜底路径: 视觉标尺 (10%)】
                                   │                          │
                                   ▼                          ▼
                    ┌─────────────────────────┐┌─────────────────────────────┐
                    │  DOM 剪枝与 1-based 索引 ││   chrome_screenshot 视觉流  │
                    │  - 纯内存 WeakRef 映射  ││   - 半透明动态坐标网格标尺  │
                    │  - 零 DOM 属性污染防反爬││   - ROI 局部高精度扩充截图  │
                    │  - 多 Frame / Shadow DOM││   - 像素坐标精准映射        │
                    │  - Token 压缩率 > 85%   ││   - 消除像素幻觉与漂移      │
                    └──────────────┬──────────┘└──────────────┬──────────────┘
                                   │                          │
                                   └────────────┬─────────────┘
                                                ▼
                    ┌────────────────────────────────────────────────────────┐
                    │                   CDP 原生物理级执行原语                │
                    │  - Input.dispatchMouseEvent (isTrusted: true 点击/悬停)│
                    │  - Input.dispatchKeyEvent (OS 级按键与全选清空)        │
                    │  - Input.insertText (真实文本插入，完美适配受控组件)    │
                    │  - Page.setInterceptFileChooserDialog (动态文件上传)   │
                    │  - Action Settle Watchdog (网络请求监听 + 50ms 自适应) │
                    └────────────────────────────────────────────────────────┘
```

---

## 2. 关键架构与核心技术特性

### 2.1 双引擎协同控制机制（DOM 优先 + 视觉保底）

1. **DOM 优先路径（`chrome_read_dom` + `chrome_interact_index` / `chrome_fill_index` / `chrome_batch_actions`）**：
   - 解析活跃标签页与所有跨域/同域 Iframe、Shadow DOM 树。
   - 过滤不可见节点（`display: none`、`visibility: hidden`、透明度为 0、尺寸为 0、视口外裁剪）。
   - 为所有可交互节点分配全局单调递增的 1-based 数字索引（如 `[1]`, `[2]`, `[3]`）。
   - **零 DOM 属性污染**：彻底废止往宿主 DOM 写入 `data-mcp-idx` 的特征污染行为，改用纯内存弱引用（`WeakRef`）与全局唯一 Symbol 映射，既防止反爬虫指纹探测，又杜绝了 Blink C++ Detached DOM 内存泄漏。
   - 输出极致紧凑的交互树（包含 tag、type、text、aria-label 等核心语义），相比原始 HTML 压缩率超过 **85% ~ 92%**。
2. **视觉保底路径（`chrome_screenshot` 附带网格标尺与微小元素 ROI）**：
   - 针对纯 Canvas、复杂图表（ECharts/D3）、微小图形按钮或防爬干扰严重的页面，大模型容易在无参照物的大图上产生绝对像素坐标预测幻觉。
   - 自动在截图上叠加自适应高对比度半透明像素网格标尺（`enableGrid: true`），大模型可通过网格刻度直观推断准确的物理像素坐标。
   - 提供微小元素智能 ROI 视口扩充（`expandSearchArea`）：自动将微小元素居中并向四周扩充至 400×400 像素高清截图，保证小图标的极高可读性。

### 2.2 工业级 CDP 原生执行原语（100% `isTrusted: true`）

- 彻底摒弃向页面派发虚拟事件（如 `element.dispatchEvent(new MouseEvent(...))` 或 `element.value = ...`）的弱交互方式。
- `click` 与 `hover` 升级为 CDP 物理级 `Input.dispatchMouseEvent`（支持平滑贝塞尔移动轨迹与多击）。
- `fill` 与 `batch-actions` 升级为 CDP 鼠标点击聚焦 + KeyDown 全选清空 + `Input.insertText`，确保无论面对 React/Vue 受控输入框还是金融级输入校验均能完美触发内部响应。
- 采用 `Page.setInterceptFileChooserDialog` 动态接管原生文件选择弹窗，配合 `DOM.setFileInputFiles` 实现无感本地文件上传。

### 2.3 深度安全加固与系统级崩溃防御（P0/P1 已清零）

1. **本地端口 Bearer Token 强鉴权**：
   - 本地 `127.0.0.1:12306` Fastify 服务在启动时生成或读取 `~/.chrome-mcp/bridge-token`（权限 0600，高熵随机十六进制）。
   - 彻底消除了“仅凭 Origin 头放行”的本地越权漏洞，除 `/ping` 外的所有 HTTP/SSE 路由强制校验 Bearer Token 或 Query Token。
   - 扩展端通过 `agent-api.ts` 集中管理鉴权，自动在所有内部通信中附加 Token。
2. **Chrome Native Messaging 1MB 物理上限拦截**：
   - Chrome C++ 底层对 Native Messaging Host 存在双向 1MB 硬限制，一旦突破直接终止进程。
   - 扩展端与 Native Host 发送端均设置 **1000KB 字节数预检拦截**，拦截超大 Trace 与超大 HTML。
   - `readBase64File` 设置 **700KB 转换上限**（Base64 膨胀后约 933KB），超出时返回清晰指引，引导大模型通过本地文件绝对路径直读。
3. **TOCTOU DNS 重新绑定 SSRF 异步防护**：
   - 针对任意远程下载链接，在底层 DNS 解析阶段引入 `safeLookup`，严格阻断回环地址（`127.0.0.0/8`）、私网地址（RFC1918）、CGNAT、Link-Local，以及各种隐蔽的 IPv4-Mapped IPv6 冒号十六进制（`::ffff:7f00:1`）与 6to4 封装（`2002::/16`）。
   - 文件下载实施 50MB 内存分配上限预检，杜绝 Buffer OOM，改为异步流式写盘。
4. **跨 Execution World 节点桥接**：
   - DOM 弱引用映射位于扩展的 **Isolated World**，通过 `chrome.scripting.executeScript` 配合毫秒级随机瞬态 marker（如 `data-cdp-upload-xxx`）在 DOM 树中建立临时桥梁，供 CDP `DOM.querySelector` 快速捕获真实 `nodeId` 后在 `finally` 块中立即彻底销毁标记，实现零污染跨 World 定位。
5. **Windows 跨平台进程稳健性**：
   - Node >= 20.12.2 / 22.0.0 触发 CVE-2024-27980 防护时，Windows 下 spawn `.cmd` 显式声明 `{ shell: true }`，彻底根除 `EINVAL` 异常。
   - 移除不兼容 CommonJS 的纯 ESM 模块 `is-admin`，改用系统原生命令（Windows `net session`，POSIX `process.getuid()`）检测管理员权限。

---

## 3. 代码库组织与目录结构

```
mcp-chrome-master/
├── app/
│   ├── native-server/                # Fastify 本地 Native 服务 (Port 12306)
│   │   ├── src/
│   │   │   ├── server/               # Fastify 路由、McpSessionManager、Token 鉴权
│   │   │   │   ├── index.ts          # 服务入口与全局 onRequest Token 校验
│   │   │   │   ├── token.ts          # ~/.chrome-mcp/bridge-token 生成与时间安全比对
│   │   │   │   ├── session-manager.ts # Per-Session McpServer 工厂管理
│   │   │   │   └── server.test.ts    # Fastify 与鉴权集成测试 (31/31 PASS)
│   │   │   ├── native-messaging-host.ts # Chrome Native Messaging 通信宿主 (1000KB 硬限)
│   │   │   ├── file-handler.ts       # 本地文件操作、50MB 流式下载与 safeLookup SSRF 防护
│   │   │   ├── codex.ts              # Windows Node 20+ spawn .cmd 兼容执行器
│   │   │   └── cli.ts                # 原生跨平台管理员权限检测与 CLI 服务启动
│   │   └── dist/                     # 编译产物与 run_host.bat / run_host.sh 注册脚本
│   │
│   └── chrome-extension/             # Chrome MV3 扩展 (WXT + Vue 3 + Tailwind)
│       ├── entrypoints/
│       │   ├── background/           # Service Worker 核心调度中心
│       │   │   ├── index.ts          # 背景脚本生命周期入口
│       │   │   ├── native-host.ts    # Native Port 长连接管理与自愈 Watchdog
│       │   │   ├── tools/browser/    # 核心浏览器交互工具集
│       │   │   │   ├── dom-indexer.ts      # browser-use 纯内存 WeakRef DOM 剪枝与 1-based 索引
│       │   │   │   ├── batch-actions.ts    # 批量动作流水线 (CDP 原生物理级派发)
│       │   │   │   ├── read-dom.ts         # chrome_read_dom 树快照与 Markdown 提取
│       │   │   │   ├── interact-index.ts   # chrome_interact_index 索引/坐标点击与悬停
│       │   │   │   ├── fill-index.ts       # chrome_fill_index CDP 原生高保真输入
│       │   │   │   ├── file-upload.ts      # 瞬态标记 CDP 动态文件上传
│       │   │   │   └── screenshot.ts       # 半透明坐标网格标尺与微小元素 ROI 局部截图
│       │   │   └── quick-panel/        # 页面内浮动交互面板调度
│       │   ├── sidepanel/            # 侧边栏 Agent 交互界面 (Vue 3)
│       │   │   ├── components/       # AgentChat、AttachmentCachePanel 等组件
│       │   │   └── composables/      # useAgentServer, useAgentChat 等状态机
│       │   └── popup/                # 扩展图标弹窗 (连接状态可视化与手动重连)
│       └── utils/
│           ├── agent-api.ts          # 扩展端统一鉴权客户端 (带缓存的 Bearer Token & agentFetch)
│           ├── cdp-session-manager.ts # CDP 会话单例管理器 (会话复用、自动重连与 Detach 防护)
│           ├── action-watchdog.ts    # 变动沉淀等待 (网络请求监听 + 50ms 快速沉淀)
│           └── safe-post-message.ts  # 1MB 消息截断与本地文件安全降级传输
│
├── packages/
│   └── shared/                       # 全局跨端共享协议与类型定义包
│       └── src/
│           ├── types.ts              # NativeMessageType, BatchActionItem 等统一接口
│           └── tools.ts              # MCP 工具元数据（含 readOnlyHint / destructiveHint 注解）
│
├── test/
│   ├── e2e/                          # 现代 Agent E2E 全自动化回归套件 (Tier 1 - Tier 4)
│   │   ├── runner.ts                 # 自动化测试编排器
│   │   └── harness/                  # 模拟 Chrome 运行环境与 CDP 桩
│   └── boost-features.test.ts        # 进阶架构升级与 P0-P3 缺陷治理回归测试套件 (70/70 PASS)
│
├── AGENT_CONFIG_GUIDE.md             # 针对大模型与 AI Agent 的配置与协同心法指南
├── HANDOFF.md                        # 本交接文档
└── skills/mcp-chrome/SKILL.md        # 通用 Agent Skill 格式定义规范
```

---

## 4. 构建、验证与工程基线

### 4.1 开发环境要求

- **操作系统**：Windows 10/11 (已实测兼容 pwsh 与 cmd)、macOS 或 Linux。
- **运行环境**：Node.js >= 18.0.0（开发基线为 Node.js LTS / v22）。
- **包管理器**：`pnpm` >= 9.0.0（采用 pnpm workspace 组织 Monorepo）。

### 4.2 常用命令集

```bash
# 1. 安装项目所有依赖
pnpm install

# 2. 全量静态类型检查 (必须 0 错误)
pnpm typecheck

# 3. 运行进阶架构与安全加固回归测试套件 (70 项测试全部通过)
node --test test/boost-features.test.ts

# 4. 运行 Fastify Native Server 单元与集成测试 (31 项测试全部通过)
pnpm --filter mcp-chrome-bridge test

# 5. 运行 E2E 四阶自动化测试套件 (153 项测试全部通过)
pnpm test

# 6. 全工程生产构建打包 (输出 Chrome MV3 产物与 Native Server)
pnpm build
```

### 4.3 自动化测试验证矩阵

| 测试套件             | 测试范围                                                 | 耗时  |        状态        |
| :------------------- | :------------------------------------------------------- | :---: | :----------------: |
| **E2E Tier 1**       | 核心功能全覆盖 (F01 - F13)                               | ~2.3s |  **65 / 65 PASS**  |
| **E2E Tier 2**       | 极端边界场景与容错测试 (F01 - F13)                       | ~5.6s |  **67 / 67 PASS**  |
| **E2E Tier 3**       | 跨特性多流程组合场景                                     | ~1.3s |  **16 / 16 PASS**  |
| **E2E Tier 4**       | 真实业务工作流模拟                                       | ~0.7s |   **5 / 5 PASS**   |
| **Boost Features**   | 15 大架构升级、P0-P3 漏洞修复回归测试                    | ~2.1s |  **70 / 70 PASS**  |
| **Native Server**    | Fastify 12306 端口、多客户端并发、Token 强鉴权与安全沙箱 | ~7.7s |  **31 / 31 PASS**  |
| **Chrome Extension** | Vitest 单元测试套件 (38 个测试文件)                      | ~14s  | **641 / 641 PASS** |
| **Typecheck**        | 全 Monorepo 严格 TypeScript 类型检查                     | ~5.8s |    **0 Errors**    |
| **Build Artifact**   | 全包打包产物生成 (Chrome MV3 扩展纯净无臃肿)             | ~4.2s |    **8.95 MB**     |

---

## 5. 核心维护陷阱与注意事项 (Gotchas)

1. **绝对禁止在宿主 DOM 上写入任何属性**：
   - 严禁通过 `element.setAttribute('data-mcp-idx', ...)` 存储数字索引，否则会触发反爬虫探测、破坏宿主样式，并引发 Detached DOM 内存滞留。所有临时标记（如文件上传）必须在 `finally` 块中立即移除。
2. **Native Messaging 消息大小严格防范**：
   - 无论扩展端还是 Node 端，发送前均需调用 `safePostMessage` 或通过字节缓冲区检查限制在 1000KB 以内。如果大模型请求超长网页源码或巨大全屏截图，必须走本地临时文件落盘并返回绝对路径，严禁直接塞进消息管道。
3. **Execution World 隔离规则**：
   - 提取 DOM 索引必须在扩展的 **Isolated World**（默认 `chrome.scripting.executeScript` 运行环境）中执行；如需使用 CDP 获取真实 DOM 的 `nodeId`，必须借助瞬态 marker 桥接，切勿在 Main World 中假设存在扩展专有的 Symbol。
4. **Windows 平台命令执行规则**：
   - Windows 下执行 `.cmd` 或 `.bat` 批处理文件时，Node.js `child_process.spawn` 必须显式传入 `{ shell: true }`，并严谨转义命令参数，避免触发 CVE-2024-27980 安全异常。
