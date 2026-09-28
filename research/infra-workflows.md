# 基础设施与工作流长板测绘报告 (Type E: Stagehand, Skyvern, Steel-browser)

> **调研背景与依据**: 本测绘由子代理 5 (Agent-InfraWorkflows) 执行，严格遵循 §A 双重验证纪律与 §B 粗筛门禁决策（`research/01-triage.md`）。本报告拒绝泛化平铺，专门针对 Type E 基础设施与工作流类项目的 3 大专属长板展开代码级深挖：
>
> 1. **Stagehand**: `act/observe/extract` 抽象层、observe 缓存键与确定性重放、self-healing selector 自愈选择器；
> 2. **Skyvern**: 视觉-DOM 混合推理、本地 stdio 与远程 OAuth MCP endpoint 统一暴露设计；
> 3. **Steel-browser**: 会话隔离沙箱、持久化 profile 导入、凭据防泄漏安全边界。
>
> 本文所有机制均经对标源码全路径精读验证，附带行号代码定位（`repo@路径:行号`），并与 BrowserPaw 既有架构进行优劣势对比与移植可行性论证。

---

## 一、Stagehand: 动作抽象、确定性重放与自愈选择器

### 1. act / observe / extract 三元抽象层设计

Stagehand 将智能体在 Web 页面上的交互抽象为正交且完备的三大核心动作原语：

```
       ┌────────────────────────────────────────────────────────┐
       │                 Stagehand Client SDK                   │
       └───────┬────────────────────┬───────────────────┬───────┘
               │ act()              │ observe()         │ extract()
               ▼                    ▼                   ▼
    ┌──────────────────────┐ ┌───────────────┐ ┌────────────────┐
    │ 确定性 / LLM 双模式  │ │ 全局动作空间  │ │ Zod Schema     │
    │ Action vs Prompt     │ │ 生成 Action[] │ │ 结构化抽取     │
    └──────────┬───────────┘ └───────┬───────┘ └────────┬───────┘
               │                     │                  │
               └──────────────┬──────┴──────────────────┘
                              ▼
               ┌─────────────────────────────┐
               │ Extension / Understudy Core │
               │   (CDP / AXTree / Overlay)  │
               └─────────────────────────────┘
```

#### (1) observe(): 候选动作空间观测

- **机制与实现**: 通过 `page.captureSnapshot()` 遍历全页面与所有 frame，提取 Chrome 无障碍树（Accessibility AXTree），并构建 `combinedTree` 与唯一逆向映射字典 `combinedXpathMap`。随后向模型提问页面上所有可交互元素，模型输出结构化列表后，通过 `combinedXpathMap` 还原出绝对稳定的 XPath，最终封装为一组高阶具名 `Action[]`。
- **返回结构**:
  ```typescript
  interface Action {
    selector: string; // 如 "xpath=/html/body/main/button[1]"
    description: string; // 如 "Click 'Log in' button"
    method?: string; // 如 "click", "type", "dragAndDrop"
    arguments?: string[]; // 如输入文本或拖拽目标
  }
  ```
- **代码定位**: `stagehand@packages/extension/services/observeService.ts:38-115`。

#### (2) act(): 自然语言推理与确定性执行双分流

- **机制与实现**: Stagehand 在 `act()` 中实现了两路分流：
  1. **确定性重放分支 (`typeof instruction !== "string"`)**: 若上层传入的是已经由 `observe()` 生成或从缓存恢复的结构体 `Action`，**直接跳过所有 LLM 推理、跳过页面快照、跳过 DOM-settle 等待**，直接调用 `takeDeterministicAction` 分发到底层 CDP 执行。这使得多步复合动作的后续执行具备零 Token 开销、毫秒级响应的工业级确定性。
  2. **自然语言规划分支 (`typeof instruction === "string"`)**: 若传入自然语言指令，则走两步推理流程（Step 1 动作元素定位与提取 -> Step 2 真实交互调用与上下文验证）。
- **代码定位**: `stagehand@packages/extension/services/actService.ts:60-145`。

#### (3) extract(): 模式化数据抽取

- **机制与实现**: 结合 Zod Schema 运行时校验。支持纯文本 AXTree 抽取与带截屏的多模态视觉抽取（`options.screenshot: true`），严格确保返回的数据完全符合开发者定义的 TypeScript 类型。
- **代码定位**: `stagehand@packages/extension/services/extractService.ts:35-90`。

---

### 2. observe 缓存键与确定性重放 (Deterministic Replay)

Stagehand 提出了「一次编写，永久复现 (Write once, run forever)」的高性能重放理念，其核心在于服务端的无状态缓存拦截服务。

```
[调用 page.act() / observe()]
           │
           ▼
    withCache() 拦截
           │
   collectCdpTree() 收集全 Frame 原生 AXTree 节点
           │
           ▼
 发送至 Cache API: { method, sessionId, url, cdpTree, data }
           │
     ┌─────┴──────────────┐
     ▼                    ▼
[Cache HIT]          [Cache MISS]
     │                    │
 normalizeCachedActions   │
     │                    │
 执行确定性重放 onHit()    │ 降级执行原始 LLM 推理
     │                    │
     ├─ 重放成功: 完工    │ 异步持久化到 Redis
     │                    ▼
     └─ 元素失效: 标记 "replay_failed" 降级执行
```

- **缓存键构建核心**:
  Stagehand 不以易变的完整 HTML 字符串为键，而是通过 `collectCdpTree` 收集 Chromium 原生 `Accessibility.getFullAXTree` 的完整节点树，并附带规范化 URL 及去除变量后的动作参数。这保证了即使页面内部时间戳、广告脚本或无关样式发生漂移，只要页面的核心交互无障碍骨架不变，缓存键即完全命中。
- **缓存重放与容错降级**:
  当缓存命中时，返回的 Action 数组经 `normalizeCachedActions` 清洗后直接重放。若页面结构发生实质性更新导致记录的 XPath 无法找到，Stagehand 绝不让程序崩溃，而是即刻捕获异常，将状态标记为 `missReason: "replay_failed"`，并无缝退化到标准的 LLM 页面分析与生成流程。
- **代码定位**:
  - 缓存拦截核心: `stagehand@packages/extension/services/cacheService.ts:205-310` (`withCache`)
  - AXTree 收集器: `stagehand@packages/extension/services/cacheService.ts:352-380` (`collectCdpTree`)
  - 动作结构清洗: `stagehand@packages/extension/services/cacheService.ts:115-140` (`normalizeCachedActions`)

---

### 3. 自愈选择器 (Self-Healing Selector)

在长期运行的自动化流水线中，Web 前端发版、A/B 测试或动态类名（如 Tailwind、CSS Modules）往往会导致之前保存的 XPath/CSS 选择器迅速失效。Stagehand 设计了完备的自愈机制：

```typescript
// 核心自愈触发逻辑 (actService.ts:347-369)
} catch (error) {
  if (error instanceof TimeoutError) throw error;
  const message = error instanceof Error ? error.message : String(error);

  if (!context.selfHeal) {
    return {
      success: false,
      message: `Failed to perform act: ${message}`,
      actionDescription: action.description || `action (${method})`,
      actions: [],
    };
  }

  context.logger.debug("Error performing action; reprocessing the page and trying again", {
    category: "action",
    error: message,
    action: JSON.stringify(action),
  });
  return await selfHealAction({
    action,
    method,
    resolvedArgs,
    placeholderArgs,
    context,
  });
}
```

- **自愈流水线 (`selfHealAction`)**:
  1. **语义复用**: 当底层 CDP 抛出 `Element detached`、`Node not found` 或定位超时时，提取原 Action 的语义描述 `action.description`（例如 _"Click submit button"_ 或 _"${method} ${action.description}"_）；
  2. **现场快照刷新**: 调用 `context.page.captureSnapshot({})`，在当前破损现场抓取一份最新的 DOM/AXTree 以及全新的 XPath 映射表；
  3. **定向微推理**: 将自然语言语义描述作为输入，向 LLM 请求重新定位。由于只需寻找这单个目标动作元素，推理 Token 极度压缩；
  4. **原生动作补偿重试**: 获取 LLM 修复后的全新 Selector，再次调用 `performUnderstudyMethod` 完成操作，并将新选择器更新至执行结果上下文。
- **代码定位**:
  - 自愈路由分发: `stagehand@packages/extension/services/actService.ts:347-369`
  - 自愈动作补丁: `stagehand@packages/extension/services/actService.ts:371-420` (`selfHealAction`)
  - 单元测试验证: `stagehand@packages/extension/tests/act.test.ts:75-120`

---

### 4. Stagehand 与 BrowserPaw 的架构深度对比

| 评估维度         | Stagehand 表现                                                     | BrowserPaw 现状                                                             | 差距分析与吸收建议                                                                                                                      |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **页面抽象形态** | 宏观三元原语 (`act`, `observe`, `extract`)，强调高阶业务可读性     | 原生 50+ 个细粒度 Canonical 工具组合 (`chrome_read_dom`, `chrome_click` 等) | BrowserPaw 工具集对 LLM 来说自由度极高但容易产生冗余轮次。**可参考引入高阶复合宏工具**（如 `chrome_act_toward_goal` 结合确定性输出）。  |
| **执行重放能力** | 强。支持将 `Action` 作为一级入参传递，零 Token 确定性重放          | 弱。每步操作依赖实时返回的弱引用 DOM 编号，无法直接 cross-turn 重放         | **极高吸收价值**。BrowserPaw 可以在扩展层为成功执行的元素持久化生成语义路径选择器，供下一次相同任务毫秒级重放。                         |
| **选择器自愈**   | 原生内建。当元素变更时基于 Action 的语义描述进行单步补丁刷新并自愈 | 无原生自愈。依赖外层 LLM 在接收到报错后重新规划、重新抓取整页 DOM           | **核心长板**。在 BrowserPaw 的 Native 侧实现 `self_heal` 开关，当点选目标失活时自动基于元信息在后台局部修复，避免整个智能体流程被打断。 |

---

## 二、Skyvern: 视觉-DOM 混合推理与统一端点设计

### 1. 视觉-DOM 混合表示管道 (Vision-DOM Hybrid Pipeline)

不同于纯文本无障碍树或纯视觉截图，Skyvern 构建了高度工业化的「DOM 拓扑标注 + 视口切片渲染」双流感知系统。

```
          ┌───────────────────────────────────────────────┐
          │               目标 Web 页面                    │
          └───────────────────────┬───────────────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
       [domUtils.js DOM 注入流]         [SkyvernFrame 视觉流]
                  │                               │
       - 元素遍历与过滤                   - 计算 Viewport 视口
       - 注入唯一 skyvern_id 属性         - 滚动拼接 / Split Screenshots
       - 测量精确 Bounding Box (Rect)     - 视觉边界框渲染 (可选 draw_boxes)
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │      ScrapedPage 对象     │
                    │  (DOM Tree + 切片视觉组)  │
                    └─────────────┬─────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │ 多模态混合提示词 (VLM)     │
                    │ "ID + 文本 + 视觉视口坐标"│
                    └───────────────────────────┘
```

- **DOM 工具注入与位置测量 (`domUtils.js`)**:
  - Skyvern 在目标页面主环境中注入 `domUtils.js`（全长超过 130KB），核心函数 `buildElementTree` 递归遍历所有元素；
  - 为每个可见候选元素打上自增的 `skyvern-id` 属性；
  - 调用 `Rect.create()` 结合 `getBoundingClientRect()` 与视口偏移，精确计算元素在当前视口中的绝对几何位置（`top`, `bottom`, `left`, `right`, `width`, `height`）；
  - 过滤掉尺寸过小（< 5px）、被完全遮挡或隐藏的不可见死元素。
- **页面级智能切片与滚动捕获 (`scraper.py`)**:
  - 核心入口 `scrape_web_unsafe` 负责抓取页面内容与截图；
  - `SkyvernFrame.take_split_screenshots`：当网页长度超过屏幕可视区域时，并不盲目抓取极长的全页截图（长截图会严重稀释视觉模型分辨率），而是按屏幕高度进行等比分片捕获，生成有序的切片图像序列；
  - 截图完成后通过 `safe_scroll_to_x_y` 将页面视口精确还原回初始坐标，杜绝滚动对后续交互定位产生意外漂移。
- **代码定位**:
  - DOM 树遍历与几何构建: `skyvern@skyvern/webeye/scraper/domUtils.js:2592-2650` (`buildElementTree`)
  - 页面抓取与切片截图: `skyvern@skyvern/webeye/scraper/scraper.py:539-710` (`scrape_web_unsafe`)
  - 元素属性字典与哈希构建: `skyvern@skyvern/webeye/scraper/scraper.py:905-950` (`build_element_dict`)

---

### 2. 本地 Stdio 与远程 OAuth MCP Endpoint 统一暴露架构

Skyvern 在工具暴露设计上的最大长板在于其优雅的**双模一致性 (Dual-Mode Parity)**：无论是本地开发者通过标准输入输出（stdio）启动的 CLI 工具，还是云端部署的基于 HTTP/SSE 并在生产环境受 OAuth 保护的服务，底层的工具注册与派发完全共享同一套 FastMCP 骨架。

```
                      ┌────────────────────────────┐
                      │    FastMCP Unified Core    │
                      │  (统一工具定义与参数校验)  │
                      └─────────────┬──────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
┌───────────────────────┐                       ┌───────────────────────┐
│     本地模式 (stdio)   │                       │   远程/云端模式 (HTTP) │
├───────────────────────┤                       ├───────────────────────┤
│ - CLI 驱动 (mcp.py)   │                       │ - Starlette / FastAPI │
│ - 本地自建 Organization│                       │ - Bearer Token / OAuth│
│ - 无头直连            │                       │ - x-api-key 组织隔离  │
└───────────────────────┘                       └───────────────────────┘
```

- **统一认证中间件与多租户映射 (`mcp_http_auth.py`)**:
  - 在 HTTP 服务模式下，支持 `x-api-key`（API Key）与 `authorization: Bearer <token>`（OAuth 2.0 / JWT）双重校验；
  - 提取 Token 中的 Claims，并通过 `_OAuthResolution` 将 OAuth 用户映射为数据库中的组织（Organization）实体与 API 密钥；
  - 内建带有 TTL 的验证缓存（`_api_key_validation_cache`），默认 30 秒过期，并带有 5 秒的否定缓存（Negative Cache），在极高并发调用下保证认证不成为系统瓶颈。
- **动态上下文注入与会话作用域 (`session_manager.py`)**:
  - 工具在被触发时，通过 `request_session_scope` 上下文管理器将解析出的组织 ID、用户身份及会话配额透明注入当前执行线程，使得所有 MCP 工具均无需显式传递鉴权参数即可自动继承租户上下文。
- **代码定位**:
  - HTTP 鉴权中间件与 OAuth 换取: `skyvern@skyvern/cli/core/mcp_http_auth.py:40-140`
  - MCP 命令行切换与客户端适配: `skyvern@skyvern/cli/mcp_commands.py:65-150`
  - 本地 MCP 组织自动启动: `skyvern@skyvern/cli/mcp.py:45-95`

---

### 3. Skyvern 与 BrowserPaw 的架构深度对比

| 评估维度                | Skyvern 表现                                                                                      | BrowserPaw 现状                                                              | 差距分析与吸收建议                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **页面视觉与 DOM 结合** | 重。将 130KB JS 注入目标页面主环境，计算每个元素的精确 Bounding Box，结合多张物理切片截图输入 VLM | 轻。采用 1-based 编号的纯净无障碍与可见 DOM 映射，视觉感知作为 PCIE 降级分支 | **谨慎吸收**。Skyvern 的主环境重度 JS 注入存在破坏页面原本脚本或被反爬盾拦截的高风险。BrowserPaw 的扩展隔离环境更加安全。但其**长页面分片切片截图**避免长图缩放失真的思路非常值得借鉴。 |
| **MCP 端点统一暴露**    | 强。本地 stdio 与远程 HTTP/SSE 共享工具清单，原生支持 OAuth 2.0 与 API Key 多租户访问             | 目前高度聚焦于本地 stdio 通信（Native Messaging 驱动本地 Chrome 扩展）       | **战略参考**。当 BrowserPaw 未来向云端托管或远程代理演进时，应采用 Skyvern 的端点鉴权抽象层（FastMCP + OAuth 中间件），做到本地与远程无缝复用同一份工具清单。                           |

---

## 三、Steel-browser: 云端多租户沙箱与安全隔离边界

### 1. 会话隔离沙箱 (Session Sandbox Lifecycle)

Steel 是专为 AI Agent 设计的浏览器云端基础设施。其核心长板在于将每个用户的每个交互任务抽象为完全隔离的沙箱会话（Session）。

```
Client API (Fastify) ───► POST /v1/sessions
                               │
                               ▼
                    SessionService.createSession()
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
[专用临时数据目录]      [独占本地代理服务]      [独立运行时与存储]
userDataDir =          ProxyServer(proxyUrl)   DuckDB / Memory
/tmp/steel-chrome/UUID  本地动态端口监听        Log & Trace 强隔离
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               ▼
                   Chromium 实例 (隔离子进程)
```

- **会话与进程强隔离**:
  - 每一个会话在创建时分配唯一的 UUIDv4（`sessionId`）；
  - 默认情况下，系统为该会话在临时目录中生成专属的 `userDataDir`（如 `path.join(os.tmpdir(), "steel-chrome", sessionId)`），不同会话之间的 Cookie、LocalStorage、Cache、IndexedDB 从操作系统文件系统层面实现物理隔离；
  - 会话销毁时，系统通过 `fileService` 异步收集归档产物（如调试录屏、HAR 包、日志），随后彻底抹除临时数据目录，杜绝任何历史会话脏数据残留。
- **独占局部代理隧道 (Per-Session ProxyServer)**:
  - 每个会话支持单独配置上游代理，并由 `this.proxyFactory(proxyUrl, normalizedOptimize)` 启动一个会话独占的中间代理服务；
  - 该本地代理不仅负责向外转发网络流量，还负责动态应用带宽优化策略（如拦截图片、拦截媒体资源、拦截样式表），实现云端渲染资源开销的最大化节约。
- **代码定位**:
  - 会话创建与生命周期编排: `steel-browser@api/src/services/session.service.ts:160-250`
  - 插件装配与 Chromium 挂载: `steel-browser@api/src/plugins/browser.ts:25-85`
  - 会话路由与请求参数规范: `steel-browser@api/src/modules/sessions/sessions.controller.ts:40-110`

---

### 2. 持久化 Profile 导入与状态快照恢复

对于需要长效登录态（如企业内网、社交网络、电商后台）的场景，纯粹的临时沙箱无法满足需求。Steel-browser 实现了基于 LevelDB 物理文件解析的高性能 Profile 导出与导入引擎。

- **Chrome 本地 LevelDB 逆向解析**:
  - Steel-browser 构建了 `ChromeLocalStorageReader` 与 `ChromeSessionStorageReader`，直接在文件系统层读取 Chrome Profile 目录下的 LevelDB 数据文件；
  - 绕过运行中浏览器的 CDP 限制，高并发、低延迟地抽取目标 Profile 的全部状态（`localStorage`, `sessionStorage`, `cookies`, `indexedDB`）。
- **快照读写与上下文缓存**:
  - `ChromeContextService` 提供了 `getSessionData(userDataDir)`，将磁盘上的 Profile 数据提取为标准的 `SessionData` 结构；
  - 针对同一 `userDataDir` 的频繁提取，设计了基于 TTL 的内存缓存机制（默认 1000ms），并通过 `inFlight` Promise 共享解决并发读踩踏问题；
  - 在创建新会话时，开发者可以传入已导出的 Profile 快照，系统将状态重放至新沙箱中，实现「保持登录态的同时享受沙箱隔离」。
- **代码定位**:
  - Chrome 上下文抽取服务: `steel-browser@api/src/services/context/chrome-context.service.ts:30-100`
  - 存储数据模型定义: `steel-browser@api/src/services/context/types.ts`

---

### 3. 凭据防泄漏安全边界 (Credential Shielding)

由于云端浏览器运行在多租户环境，且所有请求与控制指令往往需要被记录到日志库（如 DuckDB）中供审计与回放，防止开发者与用户的敏感凭据（Passwords, Session Tokens, Proxy Credentials）泄露是重中之重。

- **动态敏感字段脱敏与审计开关**:
  - 默认情况下严格关闭 `dangerouslyLogRequestDetails` 开关，所有 HTTP 请求的 Body 内容、敏感 Header（如 Authorization、Cookie）在写入日志存储时自动打码或剥离；
  - 支持会话级别的独立日志存储引擎（通过 DuckDB Parquet 文件持久化或 InMemory 模式），各个会话的控制台日志、网络追踪完全隔离存储，禁止跨租户查询。
- **凭据与启动参数解耦**:
  - 代理密码与自动化凭据不作为命令行参数（Command-Line Flags）传递给 Chromium 进程（因为在 Linux 环境下，通过 `ps -ef` 或 `/proc` 文件系统可以被其它系统进程轻易嗅探）；
  - 而是作为内部结构体在内存中流转，通过独立的认证中间件或 CDP 专用调用在建立连接后注入，杜绝了系统级凭据泄漏。
- **代码定位**:
  - 安全配置开关: `steel-browser@api/src/config.ts:30-60`
  - 凭据装配与日志过滤: `steel-browser@api/src/services/session.service.ts:180-240`

---

### 4. Steel-browser 与 BrowserPaw 的架构深度对比

| 评估维度             | Steel-browser 表现                                                                | BrowserPaw 现状                                                                        | 差距分析与吸收建议                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **会话沙箱形态**     | 强云端多租户沙箱。通过系统级临时 `userDataDir` + 独立代理端口实现硬隔离           | 强本地宿主集成。直接复用用户宿主 Chrome 的日常 Profile 与 Tab Group 机制               | **定位不同**。BrowserPaw 的核心优势就在于能够「零配置使用用户当前已登录的真实浏览器状态」。**严禁盲目照搬 Steel 的全量物理临时目录隔离**，否则将彻底丧失本地已登录态优势。 |
| **Profile 导入导出** | 强。能够解析本地 LevelDB 直接导出/导入 Cookie、LocalStorage 与 SessionStorage     | 目前仅支持在当前 Tab 内实时读取 Cookie，缺乏对 Profile 快照的导出/导入归档能力         | **高吸收价值**。BrowserPaw 可参考其 `SessionData` 结构，提供一键快照保存/恢复特定网站登录凭据的能力，让用户在不同机器间迁移 Agent 登录态。                                 |
| **日志与凭据防护**   | 完善。具备 `dangerouslyLogRequestDetails` 门禁与命令行凭据隔离，网络追踪入 DuckDB | 本地日志输出直接打印在终端控制台或 Native 日志中，存在偶发将请求 Header 全量打印的风险 | **安全防御吸收**。BrowserPaw 需在日志和 MCP Tool 输出中引入严格的白名单/脱敏机制，确保敏感 Cookie、Authorization 不会被回显到 Agent 对话上下文。                           |

---

## 四、三大项目长板对 BrowserPaw 的吸收建议与融合路线图

### 1. 架构取舍与本地优势防倒退准则

在规划吸收方案前，必须再次重申 **BrowserPaw 的五大本地固有优势绝不能妥协退化**：

1. **Dual-Brain 双脑架构 (System 1 Jev + System 2 Planner)** 必须保持，不能退化为纯单步 SDK 封装；
2. **WeakRef 1-based 动态数值编号系统** 必须保持，坚决拒绝向宿主 DOM 注入 130KB 的重型脚本（Skyvern 反模式）；
3. **850KB UTF-8 Slicing 截断与防爆机制** 必须保持，确保在任何复杂页面下不撑爆 LLM 上下文；
4. **宿主用户真实浏览器态 (Native Context)** 必须保持，绝不退化为每次冷启动隔离无状态无头浏览器（Steel 反模式）；
5. **纯 CDP 原生事件分发 (`isTrusted: true`)** 必须保持，确保 React/Vue 复杂事件合成与反爬防护不失效。

---

### 2. 核心长板吸收矩阵与落地计划

基于上述防倒退准则，我们对三大项目的核心长板进行严格的**价值-代价评估**，并制定三期落地演进路线：

| 吸收目标与技术点                                 | 借鉴源项目                                      | 引入价值                                                                          | 预期代价与风险                                        | 推荐落地优先级    |
| ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| **自愈选择器机制 (Self-Healing Action)**         | **Stagehand** (`actService.ts`)                 | 极高。当重试先前交互发生 DOM 节点失活时，利用语义描述后台自动局部补救，流程零中断 | 中。需在 Native 扩展层维护最近交互节点的语义哈希映射  | **P0 (近期必做)** |
| **确定性动作重放 (Deterministic Action Replay)** | **Stagehand** (`cacheService.ts`)               | 极高。对已验证的交互步骤生成结构化 Action，二次执行跳过感知与推理，Token 降至 0   | 低。只需在 MCP 协议层新增确定性执行入口与缓存拦截     | **P0 (近期必做)** |
| **长页面分片切片截图 (Split Viewport Capture)**  | **Skyvern** (`scraper.py`)                      | 高。解决超长 Web 页面长截屏缩放后文字模糊、视觉多模态失真的致命问题               | 低。仅需改造截屏工具，增加按屏高分片输出的选项        | **P1 (中期增强)** |
| **敏感凭据脱敏安全门禁 (Credential Shielding)**  | **Steel-browser** (`session.service.ts`)        | 高。防止用户的 Authorization、Cookie、私有 Token 被无意识回显到 LLM 对话中        | 低。在 Native 消息通道出口增加正则与敏感键过滤中间件  | **P1 (中期增强)** |
| **Profile 凭据快照导入/导出**                    | **Steel-browser** (`chrome-context.service.ts`) | 中。支持特定网站会话态的一键备份与跨机器迁移                                      | 高。解析 Chrome 本地 LevelDB 存在格式漂移与锁冲突风险 | **P2 (远期储备)** |
| **本地/远程统一 MCP 端点暴露**                   | **Skyvern** (`mcp_http_auth.py`)                | 中。支持通过 HTTP/SSE 远程托管控制宿主浏览器，支持 OAuth 鉴权                     | 中。需要引入轻量 HTTP 桥接服务器                      | **P2 (远期储备)** |

---

### 3. 具体实施蓝图 (P0 核心落地方案)

#### 方案一：在 BrowserPaw 中实现透明自愈机制 (借鉴 Stagehand)

- **现状缺陷**: 当调用 `chrome_click({ index: 5 })` 时，若页面发生微小重绘（如动态加载广告或提示条），index 5 对应的 DOM 节点失效（`Element detached from document`），工具直接报错退出，智能体必须发起一轮昂贵且耗时的全局 `chrome_read_dom` 重新编号。
- **改造方案**:
  1. 扩展 `chrome_click`, `chrome_fill` 等原子动作工具，在内部不仅记录弱引用，同时在元数据中绑定其文本摘要与 CSS 锚点（`{ text: "登录", role: "button" }`）；
  2. 当底层 CDP 派发事件抛出找不到节点或节点已脱落时，若 `self_heal=true`，则在扩展内部自动发起一次小范围局部查询，寻找具有相同 `text` 与 `role` 的新节点；
  3. 命中后自动替换句柄并补救重试，对外部 LLM 仅返回 `{ success: true, healed: true, previous_index: 5, current_index: 6 }`，避免整个宏观任务中断。

#### 方案二：结构化 Action 与缓存重放引擎 (借鉴 Stagehand)

- **现状缺陷**: 智能体每次执行相同流程（如每天登录某系统打卡），都必须完整走一遍「读 DOM -> 算编号 -> 下发点击 -> 读 DOM -> 算编号」，不仅耗费数百秒，且消耗大量 Token。
- **改造方案**:
  1. 引入 `chrome_record_action` 与 `chrome_replay_action` 工具；
  2. 在一次成功的流程后，导出形如 `{ step: 1, action: "click", selector: "button#submit", semantic: "Submit Login" }` 的轻量动作序列；
  3. 下次执行该流程时，直接走确定性重放管道，遇到选择器失效时自动联动上述自愈方案进行微调，实现「冷启动探索，热启动秒级重放」。
