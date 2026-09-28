# 归档项目清单（Type F: Deprecated / Withdrawn）

## 1. hangwin/mcp-chrome

- **仓库地址**: https://github.com/hangwin/mcp-chrome
- **归档时间**: 2026-09-28
- **撤档下架原因**:
  - 项目已实质性停更（最后提交时间为 2026-01-06）。
  - 存在 223+ 未解决的 Open Issues 与长期挂起的 PR，维护者处于停滞状态。
  - 核心架构停留在早期非结构化原生 CDP 阶段，缺乏 Dual-Brain、Jev 微循环与现代 DOM 序列化机制。
- **此前判断的标准**:
  - 曾作为早期 Chromium 扩展与 MCP 桥接的探索原型。
  - 缺乏对 MV3 Service Worker 真实保活、UTF-8 字节切片、多 tab 隔离、无死锁原生消息宿主的深度工程打磨。
- **重新评估触发条件**:
  - 若原作者或活跃团队全面恢复维护并发布大版本更新（包含对 MV3 异步通信、CDP 管道防抖与上下文优化的重构）。
  - 若其解决了 100+ 核心稳定性和协议握手 issue，且 star/活跃度恢复正向增长。
- **执行约束**: 本次调研与深挖严禁再次将 hangwin/mcp-chrome 纳入深挖序列。
