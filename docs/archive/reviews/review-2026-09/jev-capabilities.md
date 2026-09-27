# jev 能力清单（阶段1产出）

## jev 是什么

TypeSafe System One 的旗舰快速决策模型：输入自然语言+结构化 state，输出带概率的类型化判断（choice/noul/score），不生成文本。本仓库经 @typesafe-ai/sdk 0.6.0 接入，承载 act_toward_goal 语义微循环。

## 当前能做什么（代码事实）

1. chrome_act_toward_goal / fast_decision 工具（register-tools.ts 调用 FastDecisionEngine.run）：每步 感知(read_dom 紧凑视口树)→7 并行 System One 问题(action/click_target/type_target/select_target/goal_done/stuck/destructive)→执行(click/type/select/scroll/back/wait)→记录。jev 每步一次 query；select 动作二次调用 scoreOptions（score 原语，>10 选项先启发式 shortlist）。
2. 双引擎分层：jev（有 TYPESAFE_API_KEY 时）→ 运行期 fallback（401 latch / 429 / 网络错误）切 HeuristicEngine（零依赖打分，maxSteps 压到 5，confidence<0.3 或 destructive 关键字 escalate）。
3. 护栏：14 个 destructive 关键字（中英文）；pauseBeforeKeywords 词边界匹配（拉丁词防 postal_code 误匹配 post）；goal 引号/textHint/关键词尾巴三段式文本载荷提取；invalid_key 会话级 latch。
4. 参数边界：maxSteps 1..60（heuristic 模式强制 <=5）；timeoutMs 1..300s；confidenceThreshold 默认 0.55；state 预算 250 行/120 字符/24k 字符，敏感元素（password/file）剔除，history 近 5 条。
5. 输出：status(done/escalate/stuck/blocked/max_steps/timeout/paused)、steps 轨迹、finalPage、jevUsage（calls/inputTokens/estCostUsd=输入tokens*0.042/1M）、MCP progress 通知（progressToken）。

## 接入方式

- native-server/src/jev/ 五文件：types.ts(契约)、jev-client.ts(TypeSafeClient 封装+buildState/buildQuestions/validateChoice/scoreOptions)、fast-decision-engine.ts(主循环 882 行)、heuristic-engine.ts(回退 275 行)。
- LLM 调用点总览（rg 实证）：仅 jev-client.ts 的 systemOne 与 scoreOptions 两处发起远程推理；heuristic-engine 纯本地。其余 48 工具均无 LLM 调用——LLM 决策全部集中于 act_toward_goal 一族。

## 主控初步观察（供阶段2/3 深挖，非结论）

a) N 步循环每步全量 chrome_read_dom（activeViewportOnly+limit250），虽有 snapshotCacheManager 但 engine 未用 deltaOnly——N 步 = N 次全链路 DOM 剪枝，是微循环主要延迟来源。
b) invalid_key latch 为模块级全局变量， latch 后同进程任何后续 jev 调用永久失效直至进程重启——没有 reset 入口（resetInvalidKeyLatch 存在但无调用方，需阶段2证实）。
c) scoreOptions 中 options.indexOf(bestOption) 依赖对象引用相等，candidateOptions 是 map/slice 后的新数组但元素引用保留，短期安全；shortlist 截断后 originalIndex 回查逻辑需核实。
d) validateChoice 校验 sum=1±0.02，winning 必须 max prob——与 SDK 实际返回结构是否吻合需对照 SDK 类型验证。
e) estCostUsd 硬编码 0.042/1M input tokens。
