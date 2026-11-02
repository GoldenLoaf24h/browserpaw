# BrowserPaw 工程概览

[English](./PROJECT.md)

BrowserPaw 通过 Native Messaging 扩展和本地 MCP 桥接服务，让 Agent 操作现有 Chrome 会话。浏览器状态归 Chrome，任务和学习技能状态归 Native。JS 接口只支持明确的子集，不代表完整 Playwright 兼容。

## 开发从这里开始

先读[开发边界与当前发布工作](./docs/development/DEVELOPMENT.md)，再检查受影响的调用方。[QUALITY.md](./docs/QUALITY.md) 是验收规则来源，[DOCUMENTATION.md](./docs/DOCUMENTATION.md) 是文档治理来源，详细资料从[文档入口](./docs/README.md) 查找。

## 职责划分

| 模块                   | 负责内容                                                 | 边界                                                    |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `packages/shared`      | 工具 schema、profile、公共类型及产品版本                 | 唯一公共契约；客户端别名不改变语义                      |
| `app/chrome-extension` | 页面观察、定位、原生输入、CDP 会话与浏览器事件           | 限定页面、frame、document；先检查再派发；未知写入不重放 |
| `app/native-server`    | 认证 MCP 传输、任务、学习技能、文件租约、CLI 和持久 REPL | 连接不等于任务，持久账本不证明当前文档仍有效            |
| `skills/browserpaw`    | 客户端中立的静态说明、reference、脚本与 recipe           | 通用安装和插件镜像的来源                                |
| `plugins`              | Portable、Hermes、Claude Code、DSH 适配                  | 官方配置结构及客户端差异留在各自适配包                  |
| `scripts` 和 `test`    | 生成、门禁、打包与集成 fixture                           | 证据注明构建，区分模拟测试和真实执行                    |

## 主执行链

Agent → MCP 或持久 JS 接口 → Native 任务／技能编排 → 扩展执行器 → 共同定位与动作检查 → 浏览器派发 → 回执与业务验证。

新入口复用这条链。原始 CDP 是显式低层能力，不能用于绕过任务隔离。Jev 自主执行依赖用户配置，确定性工具不要求启用 Jev。

观察使用绑定文档的引用及有预算的 standard／fast 快照；缓存只在有效时复用，部分 frame 覆盖明确报告，视觉坐标绑定有效截图上下文。优先使用原生编辑，合成操作必须保留不同的结果语义。

## 技能存储

- 静态分发：`skills/browserpaw`，包含按需读取的 `references/`、诊断 `scripts/`、内置 `assets/recipes/`。
- Native 包：构建生成 `dist/skill/browserpaw` 和 `dist/recipes`。
- 自学习技能：`$BROWSERPAW_HOME/skills`，默认 `~/.browserpaw/skills`；连接同一 Native 的客户端共享，不复制到插件目录。
- 普通 Agent Skills 安装：`browserpaw skill install`，默认 `~/.agents/skills/browserpaw`。

详见[客户端兼容性](./docs/development/PLUGIN_COMPATIBILITY.md)及[任务／技能生命周期](./skills/browserpaw/references/task-skill-lifecycle.md)。

## 证据与发布状态

BrowserPaw 4.1.2 是最新已发布标签，在其交互合同上新增跨观察路径的交互范围一致性、显式延迟页面恢复、fast 观察失败关闭语义，以及统一的可预期页面限制处理与错误页注入恢复。完整本地门禁、部署校验、加载后运行态探针、Linux/Windows CI 及发布资产均记录在发布档案中。已复现的 Native 十分钟空闲重启通过移除 stdout 中的协议污染完成修复，并通过 665 秒同一连接实测；该有界证据不能证明所有长时间工作负载都会持续稳定，详见[开发边界](./docs/development/DEVELOPMENT.md)。

大型 M7 对标已停止，历史记录保留，整体成功率、耗时和 token 降低目标尚未证明。工具数量、测试总数、版本和参数从运行时帮助、生成的 [TOOLS.md](./docs/TOOLS.md)、manifest 和门禁报告读取，不手写性能保证。
