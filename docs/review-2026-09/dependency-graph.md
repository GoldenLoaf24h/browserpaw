# BrowserPaw 依赖图谱（阶段1产出，主控校验）

版本：2.9.2（package.json ×3 一致）。仓库根：D:\workspace\mcp-chrome-master\mcp-chrome-master

## 分层拓扑

1. AI 客户端（Claude/Cursor/Codex）到 MCP 传输层（Streamable HTTP+SSE :12306 或 stdio）
2. app/native-server（Node20+，Fastify5 + @modelcontextprotocol/sdk 1.11 + @typesafe-ai/sdk 0.6）
3. Chrome Native Messaging（stdio，4字节LE长度前缀，上限1MB每条）到 MV3 Service Worker
4. 工具执行：background/tools/browser/*（48 工具）到 chrome.scripting 注入 inpage-engine 或 chrome.debugger(CDP)
5. packages/shared：工具 schema/名称/profile 的单一事实源（native-server 与 extension 双消费方）

## 模块 x 职责 x 依赖 x 被依赖

| 模块                                          | 职责                                                                                                                                | 依赖                                          | 被谁调用                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| packages/shared/src/tools.ts                  | 48 工具 JSON schema + 名称                                                                                                          | zod-to-json-schema                            | register-tools、extension tools/index、scripts/gen-tools-doc.mjs |
| packages/shared/src/tool-profiles.ts          | core14/crawl12/full48 动态 profile                                                                                                  | tools.ts                                      | register-tools                                                   |
| packages/shared/src/types.ts                  | 坐标/批量/diff 类型                                                                                                                 | -                                             | 双端                                                             |
| packages/shared/src/error-format.ts           | 统一错误格式                                                                                                                        | -                                             | register-tools                                                   |
| native-server/src/server/index.ts             | Fastify HTTP/SSE :12306 + token 校验                                                                                                | fastify/cors, token.ts, native-messaging-host | index.ts；MCP 客户端直连                                         |
| native-server/src/server/token.ts             | bridge-token 生成/常驻/时序安全校验                                                                                                 | node:crypto/fs                                | server/index、native-messaging-host                              |
| native-server/src/native-messaging-host.ts    | stdio 帧协议、请求路由到 SW、会话管理                                                                                               | chrome-mcp-shared                             | server/index、mcp-server-stdio                                   |
| native-server/src/mcp/register-tools.ts       | 注册 48 工具 handler；jev/fast-decision 接入；profile 过滤；session 动态解锁                                                        | FastDecisionEngine, native host, shared       | mcp-server*.ts                                                   |
| native-server/src/mcp/session-manager.ts      | MCP 会话生命周期                                                                                                                    | -                                             | server/index                                                     |
| native-server/src/jev/*                       | FastDecisionEngine(882行) 每步: read_dom到jev/heuristic到执行到记录；JevClient(@typesafe-ai/sdk)；HeuristicEngine(275行) 零依赖回退 | @typesafe-ai/sdk                              | register-tools                                                   |
| native-server/src/scripts/*                   | Windows 注册表注册 manifest、doctor、postinstall                                                                                    | winreg                                        | cli/postinstall                                                  |
| extension/background/native-host.ts           | onMessageExternal+native onMessage；token 校验                                                                                      | token 约定                                    | background/index.ts                                              |
| extension/background/tools/browser/* (60文件) | 工具执行体：dom-indexer(6411)、interact-index(1122)、screenshot(1421)、computer(1488)、batch-actions(1706) 等                       | shared, utils/*, inject-scripts               | register-tools 经 native 桥按 name 分发                          |
| extension/utils/cdp-session-manager.ts        | CDP domain 引用计数、防挂起、10min idle 释放                                                                                        | chrome.debugger                               | computer/interact/screenshot/scroll 等                           |
| extension/utils/snapshot-cache-manager.ts     | DOM 指纹快照 + delta diff                                                                                                           | -                                             | read-dom, interact 系                                            |
| extension/utils/session-tab-affinity.ts       | session到tab绑定，chrome.storage.session 持久化                                                                                     | -                                             | base-browser 及多数工具                                          |
| extension/inpage-engine.ts + inject-scripts/* | 页内 DOM 剪枝/索引/WeakRef、点击/填充 helper                                                                                        | -                                             | read-dom、interact、fill 等                                      |
| extension/entrypoints/popup                   | Vue3 开关 UI                                                                                                                        | vue                                           | 用户                                                             |
| plugins/browserpaw + skill/ + skills/         | Codex 插件/skill 三份同源拷贝                                                                                                       | -                                             | Codex app                                                        |

## 浏览器操控链路（性能审查基线）

chrome_read_dom 一步 = MCP客户端到native-server(HTTP/SSE 或 stdio)到native-messaging(1帧)到SW到executeInPage(allFrames)到inpage 剪枝+索引到回传合并(可能二次注入 reindex 子帧)到JSON 序列化到原路返回。jev 模式 act_toward_goal 每步重复全量 read_dom（无 delta 复用），N 步 = N 次全链路。
