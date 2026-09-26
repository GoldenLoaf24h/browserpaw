# BrowserPaw 决策层 (Jev & Heuristic) 专项审查报告

- **审查对象**：
  - `app/native-server/src/jev/types.ts`
  - `app/native-server/src/jev/jev-client.ts`
  - `app/native-server/src/jev/fast-decision-engine.ts`
  - `app/native-server/src/jev/heuristic-engine.ts`
  - `app/native-server/src/jev/index.ts`
  - 对应的 `*.test.ts` 测试套件 (`fast-decision-engine.test.ts`, `heuristic-engine.test.ts`, `jev-client.test.ts`)
  - `app/native-server/src/mcp/register-tools.ts` (`chrome_act_toward_goal` 集成及相关工具)
- **审查日期**：2026-09-20
- **审查基线**：BrowserPaw v2.9.2 / Native Server Jev System One
- **报告落盘**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\docs\review-2026-09\by-module\jev.md`

---

## 1. 模块架构与流程概述

BrowserPaw 的 **分层双脑协同架构 (Hierarchical Dual-Brain Architecture)** 在 Native Server 本地实现了一个自主语义微循环 (`chrome_act_toward_goal`)，旨在以 200~400ms/步的高帧率执行网页交互（感知 → 决策 → 执行），免去外层通用大模型 (System 2 / Macro Planner) 频繁的 MCP 协议往返。

### 核心组件职责

1. **JevClientWrapper (`jev-client.ts`)**：封装 `@typesafe-ai/sdk`，负责与 TypeSafe Jev System One 极速推理 API 交互。构造 7 个并行结构化问题 (`action`, `click_target`, `type_target`, `select_target`, `goal_done`, `stuck`, `destructive`)，并处理错误分类与鉴权熔断 (Latch)。
2. **HeuristicEngine (`heuristic-engine.ts`)**：零依赖确定性回退打分引擎。基于目标分词 (Tokenization)、子串包含、角色加权 (Role Bonus) 评估页面候选项，并提供规则式卡死判定与目标达成近似检测。
3. **FastDecisionEngine (`fast-decision-engine.ts`)**：微循环控制器与状态机。负责串联 `chrome_read_dom` 页面感知、调用 Jev 或 Heuristic 做出动作决策、安全敏感词拦截 (Safety Breakpoint Guard)、通过内部调度执行动作 (`chrome_interact_index`, `chrome_fill_index`, `chrome_smart_scroll` 等)，并记录历史步。
4. **Tool Registration (`register-tools.ts`)**：在 Native Server 端注册 `chrome_act_toward_goal`，拦截该工具调用使其不经过 Chrome 扩展直接在 Node 本地闭环，仅通过内部方法与扩展交互。

---

## 2. 核心问题清单 (按严重度排列)

### 【P0 级别：确定性 Bug / 破坏性操作 / 状态损坏】

#### 1. `HeuristicEngine.evaluate` 意图词覆盖元素原生角色，导致对按钮错误触发输入 (Type) 动作

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:130-136, 236-248`
- **严重度**：P0（确定性逻辑缺陷 / 导致基本操作失败）
- **问题描述**：
  在启发式引擎决定动作类型时，若目标描述包含搜索或输入类意图关键词（如 `"搜索"` 或 `"search"`），`wantsType` 为 `true`。当页面打分最高的候选项明确为按钮（`role === 'button'`）时，逻辑分支中的 `else if (top1.role === 'textbox' || top1.role === 'searchbox' || wantsType)` 因 `wantsType` 成立而将动作强制判定为 `type`，从而对按钮发起填表操作。
- **证据与推演路径**：
  ```typescript
  // heuristic-engine.ts:130
  const wantsType = /(?:输入|填|type|input|search|搜索|write)/i.test(goalLower);
  const wantsClick = /(?:点击|点|click|button|按钮|press|打开|open)/i.test(goalLower);

  // heuristic-engine.ts:236-248
  let action: JevActionType = 'click';
  if (
    top1.role === 'combobox' ||
    top1.role === 'select' ||
    (wantsSelect && !wantsType && !wantsClick)
  ) {
    action = 'select';
  } else if (top1.role === 'textbox' || top1.role === 'searchbox' || wantsType) {
    action = 'type'; // [BUG]: 只要 wantsType 为 true，哪怕 top1 是 button/link，也会变成 type！
  } else if (wantsScroll) {
    action = 'scroll_down';
  }
  ```
  **触发推演**：
  用户目标为 `"点击搜索按钮"`。`wantsType` 匹配到 `"搜索"` 判定为 `true`；候选项命中 `[12] button "搜索"`，其 `top1.role` 为 `'button'`。
  由于 `wantsType` 为 `true`，`action` 变为 `'type'`。
  进入 `fast-decision-engine.ts:678` 执行分支，引擎尝试从目标中提取输入文本：`extractTextPayload("点击搜索按钮")`，匹配后提取出 `"按钮"`。
  随后调用 `chrome_fill_index({ index: 12, text: "按钮", pressEnter: true })`。对原生或自定义 `<button>` 执行文本输入必然触发 CDP 报错或直接无响应，导致微循环在此中断或异常升级。
- **一句话净收益**：修复后将严格依据元素实际语义类型约束动作，彻底避免对可点击元素执行非法输入。

---

#### 2. `isDestructiveTarget` 全局子串匹配无词边界，导致常规字段 (如 postal_code) 产生破坏性误判阻断

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:25-41, 256-260`
- **严重度**：P0（功能阻断 / 高误报阻断正常填表）
- **问题描述**：
  `isDestructiveTarget` 使用简单的 `lower.includes(kw.toLowerCase())` 匹配 14 个敏感词。对于 `'post'`, `'pay'`, `'buy'`, `'confirm'` 等英文词汇，它会在没有词边界（Word Boundary）的情况下误匹配包含这些子串的常见表单字段与常规词汇（如 `postal_code`, `poster`, `prepaid`, `confirmation` 等），导致正常交互被直接阻断并强行抛出 `escalate`。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:25-41
  export const DESTRUCTIVE_KEYWORDS: readonly string[] = [
    'pay',
    '支付',
    '付款',
    '删除',
    'delete',
    'purchase',
    'buy',
    'submit',
    '提交',
    '发送',
    'post',
    '发布',
    'confirm',
    '确认',
  ];

  // jev-client.ts:256-260
  export function isDestructiveTarget(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return DESTRUCTIVE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }
  ```
  反观 `fast-decision-engine.ts:44-55` 中对 `pauseBeforeKeywords` 的处理，显式编写了正则词边界防护：
  ```typescript
  // fast-decision-engine.ts:43-52
  // If keyword consists of alphanumeric/dash words (Latin/standard token), match on word boundaries
  // to prevent false positives like "postal_code" matching "post" or "deposit" matching "post"
  if (/^[a-zA-Z0-9_-]+$/.test(cleanKw)) {
    const regex = new RegExp(
      `(^|[^a-zA-Z0-9_])${cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-zA-Z0-9_]|$)`,
      'i',
    );
    if (regex.test(targetText)) return cleanKw;
  }
  ```
  **触发推演**：
  在电商或地址填写场景中，页面元素为 `[5] textbox "postal_code" placeholder="Enter postal code"`。
  当启发式引擎或 Jev 选中该元素准备输入邮编时，`isDestructiveTarget('[5] textbox "postal_code"')` 检查到包含 `'post'`，返回 `true`。
  在 `fast-decision-engine.ts:482` 或 `heuristic-engine.ts:214` 中直接返回：
  `status: 'escalate', reason: 'Target element matched destructive keyword; requires confirmation'`。
  填表流程直接瘫痪，无法自动化推进。
- **一句话净收益**：对齐词边界正则规则，消除无害英文单词（如 postal_code）触发破坏性拦截的误报，保证表单全自动化流畅执行。

---

### 【P1 级别：高概率异常路径 / 架构硬伤 / 显著性能瓶颈】

#### 3. `isKeyInvalidLatched` 为进程级全局单例且生产代码中无任何复位机制 (永不解开的锁)

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:31-45`
- **严重度**：P1（架构硬伤 / 状态无法自愈）
- **问题描述**：
  注释声明其为 `Session-level latch for 401 Unauthorized (§4.2)`，但在实现中 `isKeyInvalidLatched` 是模块顶级的私有全局布尔值，作用域跨越整个 Node 进程。一旦任意会话遇到一次 401 鉴权失败，该标志位即被置为 `true`。生产代码中**不存在任何调用 `resetInvalidKeyLatch()` 的入口**，导致整个 Native Server 进程在重启前彻底失去使用 Jev 的能力。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:31-45
  let isKeyInvalidLatched = false;

  export function isSessionKeyInvalid(): boolean {
    return isKeyInvalidLatched;
  }
  export function latchInvalidKey(): void {
    isKeyInvalidLatched = true;
  }
  export function resetInvalidKeyLatch(): void {
    isKeyInvalidLatched = false;
  }
  ```
  全局代码检索表明，`resetInvalidKeyLatch()` 仅在单元测试 (`*.test.ts`) 的 `beforeEach` 中被引用，生产环境零引用。
  **触发推演**：
  1. 用户启动 Native Server 时未配置或配置了临时失效的 API Key，或者因上游服务暂时 401 抖动；
  2. 触发一次 `latchInvalidKey()`；
  3. 用户在环境变量中补齐或修复了有效 Key，甚至重新发送请求；
  4. `isSessionKeyInvalid()` 永久返回 `true`，后续所有 `chrome_act_toward_goal` 调用全部被强制降级为启发式引擎。
  5. 此外，多 Session 并发时，Session A 的 Key 失效会直接连带搞垮 Session B 的 Jev 决策。
- **一句话净收益**：改造为基于 SessionId 的会话级隔离或引入健康探测与动态复位机制，避免进程级永久死亡。

---

#### 4. `JevClientWrapper` 单例静态初始化，运行时后补或更新 `TYPESAFE_API_KEY` 无法生效

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\mcp\register-tools.ts:98`, `app/native-server/src/jev/jev-client.ts:285-298`
- **严重度**：P1（配置迟钝 / 状态不一致）
- **问题描述**：
  在 `register-tools.ts` 中，`const fastDecisionEngine = new FastDecisionEngine();` 在模块加载时即被实例化。如果 Native Server 进程启动时尚未加载或注入 `TYPESAFE_API_KEY`，`this.client` 即被初始化为 `null`。即使后续进程环境变量被注入，`run()` 检查 `hasKey` 虽然为 `true`，但内部底层客户端因从不重新初始化，永远返回 `no_api_key`。
- **证据与推演路径**：
  ```typescript
  // register-tools.ts:98
  const fastDecisionEngine = new FastDecisionEngine();

  // jev-client.ts:285-295
  constructor(apiKey?: string) {
    const key = apiKey || process.env.TYPESAFE_API_KEY;
    if (key && key.trim()) {
      try { this.client = new TypeSafeClient({ apiKey: key.trim() }); }
      catch (e) { this.client = null; }
    }
  }

  // fast-decision-engine.ts:139-143
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim());
  let engine: DecisionEngineType = hasKey && !isSessionKeyInvalid() ? 'jev' : 'heuristic';
  ```
  在 `fast-decision-engine.ts` 中，`engine` 被动态算作 `'jev'`，但在 `this.jevClient.query()` 内部：
  ```typescript
  if (!this.client || isSessionKeyInvalid()) {
    return {
      result: null,
      errorReason: isSessionKeyInvalid() ? 'invalid_key' : 'no_api_key',
    };
  }
  ```
  由于 `this.client` 依然是最初构造时的 `null`，调用直接返回 `no_api_key` 并强制切换降级，导致动态环境变量完全无效。
- **一句话净收益**：支持懒加载或在环境变量变更时动态重建 SDK 实例，确保免重启生效。

---

#### 5. `tokenizeGoal` 中英文混排处理缺陷，无空格的字母数字直接丢失且产生错误拼接 bigram

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:89-106`
- **严重度**：P1（分词损坏 / 候选元素打分失真）
- **问题描述**：
  分词逻辑首先按空格切分出 `rawWords`，随后检查单词内是否包含 2 个及以上 CJK 字符。如果包含，则仅对 CJK 字符生成两两相连的 2-gram (Bigram)，并**完全丢弃**该词中夹杂的英文字母与数字。同时，由于直接对提取出的 CJK 字符数组循环，原本被英文隔开的两个汉字会被错误拼接成一个无意义的 bigram。
- **证据与推演路径**：
  ```typescript
  // heuristic-engine.ts:89-106
  for (const word of rawWords) {
    if (STOPWORDS.has(word)) continue;
    // Check if word has CJK characters
    const cjkChars = word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    if (cjkChars && cjkChars.length >= 2) {
      for (let i = 0; i < cjkChars.length - 1; i++) {
        tokens.push(cjkChars[i] + cjkChars[i + 1]);
      }
    } else {
      tokens.push(word);
    }
  }
  ```
  **实测数据验证**：
  输入目标：`"搜索iPhone15购买"`。
  1. `rawWords` 为 `["搜索iphone15购买"]`；
  2. `cjkChars` 匹配得到 `["搜", "索", "购", "买"]`（长度为 4 >= 2）；
  3. 生成 token 为：`["搜索", "索购", "购买"]`。
     **致命后果**：
  - 关键实体词 `"iphone15"` 在 token 列表中**彻底蒸发**，页面上含有 `"iPhone 15"` 的商品卡片无法获得任何 token 重合得分；
  - 虚构了荒谬的跨词连接词 `"索购"`。
- **一句话净收益**：先对 CJK 与 Latin 字符按边界拆分再分词，保证混合关键词 100% 被捕获，提升启发式打分命中率。

---

#### 6. `HeuristicEngine.isGoalDone` 基于静态页面文本简单包含，极易在第 2 步产生假阳性导致任务早退

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:261-274`, `fast-decision-engine.ts:282-299`
- **严重度**：P1（任务假死 / 提前早退未完成目标）
- **问题描述**：
  启发式引擎中评估目标是否达成的函数 `isGoalDone`，仅仅统计 `goalTokens` 在全页所有元素拼接文本中的命中比例（>= 0.8 即判为完成）。在多步操作中，用户的目标词（如 `"登录"`, `"提交"`, `"搜索"`）往往正是当前页面上原生固有的标题、按钮或说明文案。因此在第 2 步，引擎尚未完成操作就会判定 `isGoalDone === true` 并返回 `status: 'done'`。
- **证据与推演路径**：
  ```typescript
  // heuristic-engine.ts:261-274
  public isGoalDone(goal: string, elements: string[]): boolean {
    const goalTokens = tokenizeGoal(goal);
    if (goalTokens.length === 0) return false;

    const allPageText = elements.join(' ').toLowerCase();
    let hitCount = 0;
    for (const token of goalTokens) {
      if (allPageText.includes(token)) {
        hitCount++;
      }
    }
    return hitCount / goalTokens.length >= 0.8;
  }
  ```
  ```typescript
  // fast-decision-engine.ts:282-290
  // In Heuristic mode, check goal_done approximation before action (§4.3)
  if (engine === 'heuristic' && step > 1) {
    if (this.heuristicEngine.isGoalDone(params.goal, currentElements)) {
      return this.formatResult(
        'done',
        engine,
        engineSwitched,
        fallbackReason,
        'Goal accomplished (keyword coverage >= 80%)',
        ...
  ```
  **触发推演**：
  用户指令：`"点击用户登录"`。
  `goalTokens` 为 `["用户", "户登", "登录"]`。
  当前处于登录页面，页面上原本就存在 `"用户登录"` 标题以及 `"用户协议"`。
  在 Step 1 执行了一次聚焦或滚动后，进入 Step 2。
  `isGoalDone` 发现 `allPageText` 中包含了全部 3 个 token，`hitCount / 3 = 1.0 >= 0.8`。
  系统立即宣布 `status: 'done', reason: 'Goal accomplished (keyword coverage >= 80%)'`。
  用户实际上根本没有登录成功，任务被强行虚假终结。
- **一句话净收益**：引入完成态动词过滤或要求结合页面 URL 变化/突变特征，消除静态文案引发的假阳性早退。

---

#### 7. `isSensitiveElement` 粗暴过滤 `"password"` 子串，导致正常找回密码/辅助操作对 Jev 隐形

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:47-59`
- **严重度**：P1（感知缺失 / 误杀无害元素）
- **问题描述**：
  出于安全考虑过滤密码输入框是必要的，但实现中使用了宽泛的 `lower.includes('password')`，导致带有密码关键词的非敏感交互元素（如 `"Forgot password?"` 链接、`"Show password"` 切换眼图标、`"Password strength: Good"` 提示文本）全被作为敏感元素剔除，Jev 在感知树中完全看不到这些元素。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:47-59
  export function isSensitiveElement(line: string): boolean {
    const lower = line.toLowerCase();
    return (
      lower.includes('password') ||
      lower.includes('type="password"') ||
      lower.includes('type="file"') ||
      lower.includes('role="file"') ||
      /^\[\d+\]\s*(password|file)\b/.test(lower)
    );
  }
  ```
  甚至在 `jev-client.test.ts:38` 中还将此作为合规特性测试：
  `expect(isSensitiveElement('[8] link "Forgot password?"')).toBe(true);`
  **触发推演**：
  用户目标：`"点击找回密码链接"` 或 `"Click Forgot password"`。
  `buildState()` 将 `[8] link "Forgot password?"` 从 `elements` 中剔除。
  Jev 接收到的候选列表里完全没有第 8 项，只能猜测其它不相关链接或返回 `choice: 'none'`，最终触发 `escalate`。
- **一句话净收益**：仅针对 `role="textbox"` / `<input>` 且其类型明确为 password 的输入框进行脱敏，放行普通链接与提示文本。

---

#### 8. `extractTextPayload` 尾随词提取在未加引号时遇首个空格即截断，丢失多词输入

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:241-248`
- **严重度**：P1（输入截断 / 意图偏离）
- **问题描述**：
  当用户未在指令中使用引号强调输入文本且未提供 `textHint` 时，引擎依赖正则 `/(?:输入|搜索|type|enter|for)\s*[:：]?\s*([^\s,，。;；\n]+)/i` 提取尾随词。其中的 `[^\s...]+` 会在遇到第一个空格时立即终止，导致多词英文关键词（如 `mechanical keyboard`）或带空格的复合词被严重截断。此外，将常见英文介词 `for` 纳入触发前缀，极易误伤其它语法结构。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:241-245
  const trailingMatch = goal.match(/(?:输入|搜索|type|enter|for)\s*[:：]?\s*([^\s,，。;；\n]+)/i);
  if (trailingMatch && trailingMatch[1].trim()) {
    return trailingMatch[1].trim();
  }
  ```
  **实测数据验证**：
  1. `extractTextPayload("type mechanical keyboard into searchbox")` → 提取结果为 `"mechanical"`，`"keyboard"` 被丢弃；
  2. `extractTextPayload("Click button for next page")` → 匹配到 `for next`，提取出文本 `"next"`，并可能将其错误输入到页面；
  3. 用户执行搜索或表单输入时产生残缺词，导致搜索结果大相径庭。
- **一句话净收益**：放宽空格限制直至遇到终止标点或介词（如 into/in/on），并剔除单纯的 `for` 触发词，保证输入内容完整。

---

#### 9. 语义误用：在下拉选项选择中滥用 TypeSafe SDK 的 `score` 标尺，强行引入有序评分与截断

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:365-420`
- **严重度**：P1（SDK 语义违背 / 人工截断）
- **问题描述**：
  TypeSafe AI SDK 中的 `score` 算子设计初衷是**有序标尺量表 (Ordered Rubric)**（例如评定 0~5 分：极差到极好），代表连续的单调标尺。而在 `scoreOptions` 中，开发者将互斥且无序的下拉菜单候选项（例如国家列表：中国、美国、英国）作为标尺级传入。由于 `score` 原生容量仅支持约 10 个等级，代码被迫加入了一段粗糙的人工启发式过滤（超过 10 项就自制模糊匹配截断前 10 项），既歪曲了模型概率分布，又造成了漏选项风险。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:365-373
  // When options exceed 10 (Score primitive capacity), shortlist candidates based on relevance to goal
  let candidateOptions = options;
  if (options.length > 10) {
    // 粗糙的字符串包含打分过滤到 10 项
    ...
  }

  const scoreQuestion = score(
    `Rate how closely each option satisfies the selection goal: "${goal}"`,
    criteria,
  );
  ```
  在 TypeSafe AI 中，从一组命名的备选项中选择单个最佳项的本职算子是 **`choice`**，它天生支持多分类与离散概率输出。滥用 `score` 不仅使模型被迫以有序级别做判断，还导致超过 10 个选项的下拉框无法直接送入大模型全局判断。
- **一句话净收益**：将下拉选择全面改用 `choice` 算子，消除人工硬编码的 10 项截断，还原纯正的离散语义概率。

---

#### 10. `validateChoice` 浮点公差过严与硬性键数量检查，导致偶发合法响应被判为失败并直接升级中断

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:182-220`, `fast-decision-engine.ts:348-356, 386-394`
- **严重度**：P1（脆弱的校验防御 / 错误升级）
- **问题描述**：
  `validateChoice` 强制要求概率总和必须在 `1.0 ± 0.02` 之内，且返回的 `probabilities` 键集合必须与传入的 `expectedKeys` 数量与名称 100% 绝对一致。当选项多达几十上百时，API 返回的浮点数累加极易因为精度损失产生 0.021 的偏差，或者 API 进行稀疏化剪枝。一旦校验失败，引擎不是优雅切换为启发式，而是直接将微循环抛出 `status: 'escalate'` 彻底停止执行。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:186-191
  const probKeys = Object.keys(answer.probabilities);
  if (probKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (!(key in answer.probabilities)) return false;
  }
  ...
  // jev-client.ts:213-215
  if (Math.abs(sum - 1.0) > 0.02) {
    return false;
  }
  ```
  而在 `fast-decision-engine.ts:348-356`：
  ```typescript
  const validActionChoice = validateChoice(answers.action, [...]);
  if (!validActionChoice) {
    return this.formatResult(
      'escalate',
      engine,
      engineSwitched,
      fallbackReason,
      'Jev response invalid: action choice validation failed',
      ...
    ); // 直接返回中断，根本不降级到 heuristic！
  }
  ```
  网络接口的细微格式异常本应通过降级至启发式处理，此处却成了不可恢复的致命退出点。
- **一句话净收益**：放宽概率和容差（如 0.05），支持稀疏概率，且在数据校验失败时回退至启发式而非暴力抛弃任务。

---

#### 11. 单步 Prompt 结构膨胀：3 份全量备选元素副本（单步 300+ 选项）推高 Token 成本与网络延迟

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:133-166`
- **严重度**：P1（性能瓶颈 / 成本浪费）
- **问题描述**：
  在 `buildQuestions()` 中，为了在单个单步请求中同时推测动作与目标，构造了 `click_target`, `type_target`, `select_target` 三个问题。然而，这三个问题共用了同一个全量元素映射表 `targetCriteria`。如果当前视口有 100 个元素，每个问题都包含 101 个 criteria。即使明显是不可点击的文本或不可输入的按钮，也被复制了 3 次随请求发送。
- **证据与推演路径**：
  ```typescript
  // jev-client.ts:133-140
  const targetCriteria: Record<string, string | null> = {};
  for (const idx of indices) {
    targetCriteria[idx] = elementSummaryMap.get(idx) || null;
  }
  targetCriteria['none'] = 'No suitable matching element found on current viewport';

  // 分别赋给 click_target, type_target, select_target
  click_target: choice('...', targetCriteria),
  type_target: choice('...', targetCriteria),
  select_target: choice('...', targetCriteria),
  ```
  每次 Jev 请求除了发送 `state.elements`（最多 24KB 文本）外，在问题部分又完整发送了 `101 * 3 = 303` 个带描述的选项分支。使得单步请求体积成倍膨胀，不仅极大增加 API 推理耗时，也让小模型在面对上百个杂乱无章的选项时注意力分散。
- **一句话净收益**：按语义角色裁剪 criteria（`type_target` 仅传 input/textarea，`select_target` 仅传 select），将选项体积压降 60% 以上。

---

#### 12. 零 DOM 缓存与感知增量复用，每步微循环均进行全量 `chrome_read_dom` 跨进程往返

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\fast-decision-engine.ts:241-268`
- **严重度**：P1（性能瓶颈 / 违背 200~400ms 设计指标）
- **问题描述**：
  在微循环的每一次迭代中，无论上一步动作执行了什么，系统都会盲目调用一次全量 `chrome_read_dom`。尽管底层的 `chrome_interact_index` 与 `chrome_fill_index` 已经传入了 `includeDelta: true` 并精准返回了 DOM 增量与视口变动 (`perceptiveDelta`)，FastDecisionEngine 却仅将其解析为 `mutated: true` 字符串，随后把增量数据完全丢弃，强行重新全树扫描。
- **证据与推演路径**：
  每次 `chrome_read_dom` 的链路：
  `Native Server` → (Stdio / Native Messaging JSON IPC) → `Extension Background` → (Chrome Debugger / CDP / Content Script 注入) → `DOM 递归生成树` → 逆向序列化返回。
  实测一个具有 250 个节点的典型现代网页，单次全量 `chrome_read_dom` 耗时在 80ms ~ 250ms 不等。
  若 10 步微循环全量重读，累计在 DOM 跨进程传输与解析上就要浪费 1.5 ~ 2.5 秒，导致宣称的 200~400ms/步成为空谈。
- **一句话净收益**：充分利用 `perceptiveDelta` 与本地缓存，在未发生 URL 跳转和非全量重排时实施局部更新，节省 50% 以上 IPC 耗时。

---

### 【P2 级别：中低概率缺陷 / 可维护性 / 代码质量】

#### 13. `HeuristicEngine` 置信度公式缺陷：单一候选时恒为 1.0，低分劣质项被盲目采纳

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:210-212`
- **严重度**：P2
- **问题描述**：
  `confidence = top1.score > 0 ? (top1.score - (top2?.score || 0)) / top1.score : 0;`
  当全页仅有 1 个元素产生大于 0 的微弱得分（例如仅 0.1 分的边缘文本匹配），`top2` 不存在，计算公式得出 `confidence = (0.1 - 0) / 0.1 = 1.0`。引擎因此认为置信度为 100%，毫不犹豫地对该错误元素发起操作。
- **一句话净收益**：置信度综合绝对得分与边际差值，防止极低绝对得分的孤立项伪装为满分决策。

---

#### 14. `HeuristicEngine` 内部写死置信度阈值 0.30，忽视外部参数 `confidenceThreshold`

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:227`, `fast-decision-engine.ts:153`
- **严重度**：P2
- **问题描述**：
  `ActTowardGoalParams` 提供了 `confidenceThreshold` 参数（默认 0.55），在 Jev 模式下生效。但一旦降级到 `HeuristicEngine`，其内部写死了 `if (confidence < 0.3)` 阈值，完全不接收外部参数，导致调用方配置的置信度门禁在降级路径上彻底失效。
- **一句话净收益**：将外部 `confidenceThreshold` 透传至启发式引擎，确保全局风控标准一致。

---

#### 15. 循环内重复计算 `cleanGoal` 与重复分词，O(N) 冗余正则开销

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\heuristic-engine.ts:151, 183`
- **严重度**：P2
- **问题描述**：
  在 `HeuristicEngine.evaluate` 遍历页面所有元素时：
  `const cleanGoal = goalLower.replace(/[^\p{L}\p{N}]/gu, '');` 被放置在 `for (const line of elements)` 循环内部，每扫描一个元素就用 Unicode 正则清洗一次目标文本。
  同时，循环内对每个元素的属性值频繁执行 `tokenizeGoal`，在 250 行元素下单步重复分词上百次。
- **一句话净收益**：将目标文本预处理提至循环外，并缓存行分词，降低 CPU 无谓损耗。

---

#### 16. 循环硬编码 `wait` 休眠 1000ms，缺乏自适应 settle 机制

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\fast-decision-engine.ts:634-637`
- **严重度**：P2
- **问题描述**：
  当 Jev 决策输出 `actionToTake === 'wait'` 时，代码直接执行 `await new Promise((r) => setTimeout(r, 1000));`。如果连续出现 3 次 wait，将无条件阻塞 Node 事件循环 3 秒，既不能感知页面是否提前稳定，也无法在超时严重时主动提速。
- **一句话净收益**：对接 CDP 网络与 DOM 突变监听，变硬编码 sleep 为就绪即返回。

---

### 【P3 级别：轻微瑕疵 / 统计口径】

#### 17. `estCostUsd` 仅统计 `input_tokens` 并写死 0.042/1M，未包含 `output_tokens` 且费率硬编码

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\fast-decision-engine.ts:896`
- **严重度**：P3
- **问题描述**：
  `const estCostUsd = (inputTokens / 1_000_000) * 0.042;` 写死了旧版模型单价，且完全遗漏了输出 Token 计费。
- **一句话净收益**：规范用量统计模型，提供动态单价配置。

#### 18. `fast-decision-engine.test.ts` 存在未关闭的定时器资源泄露

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\fast-decision-engine.test.ts:1`
- **严重度**：P3
- **问题描述**：
  Jest 运行 `src/jev` 测试套件时，末尾弹出告警：`A worker process has failed to exit gracefully... Active timers can also cause this`。由于 mock 测试或真实 wait 中使用的 timer 未显式 unref 或清理，导致测试进程未能优雅退出。
- **一句话净收益**：规范测试套件中的假定时器 (jest.useFakeTimers) 清理，避免 CI 流程偶发挂起。

---

## 3. 死代码 / 重复实现 / 过度设计

### 3.1 绝对死代码：第 3 处 Safety Breakpoint Guard 完全多余

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\fast-decision-engine.ts:579-610`
- **代码片段**：
  ```typescript
  // fast-decision-engine.ts:579-610
  // Safety Breakpoint Guard (§Issue 2): pauseBeforeKeywords
  if (
    params.pauseBeforeKeywords &&
    Array.isArray(params.pauseBeforeKeywords) &&
    params.pauseBeforeKeywords.length > 0
  ) {
    const checkTarget = targetLine
      ? `${targetLine}${actionToTake === 'submit' ? ' submit' : ''}`
      : targetIndex !== undefined
        ? `[${targetIndex}]`
        : actionToTake;
    const matchedKw = findMatchingPauseKeyword(checkTarget, params.pauseBeforeKeywords);
    if (matchedKw) {
      return this.formatResult('paused', ...);
    }
  }
  ```
- **死代码推导**：
  在进入该块之前，系统必须走过 `if (engine === 'jev')` 或 `if (engine === 'heuristic')`。
  - 在 Jev 分支内（第 445-479 行），已经对 `pauseBeforeKeywords` 做了完全一样的检查，若匹配则已直接 `return formatResult('paused')`；
  - 在 Heuristic 分支内（第 520-573 行），也对 `pauseBeforeKeywords` 做了完全一样的检查，若匹配同样已直接 `return formatResult('paused')`；
    因此，当代码流转至第 579 行时，如果存在匹配关键词，早就在上述两个分支中返回了；若不匹配，第 580 行使用完全相同的参数与目标再次调用 `findMatchingPauseKeyword`，结果必定为 `null`。此段代码 100% 无法被命中，属于典型的补丁复制粘贴遗留死代码（共 32 行）。

### 3.2 冗余的状态字符预算裁剪 O(N * M) 循环

- **文件绝对路径:行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\jev\jev-client.ts:94-96`
- **代码片段**：
  ```typescript
  // Enforce overall state character budget <= 24,000 chars
  while (JSON.stringify(state).length > 24000 && state.elements.length > 0) {
    state.elements.pop();
  }
  ```
- **分析**：
  在 `elements` 最多为 250 个元素的数组中，如果单行较长超出 24,000 字符限制，每 pop 一个元素，代码就执行一次全量的 `JSON.stringify(state)`。最坏情况下会导致几十次大对象 JSON 完整序列化。可维护性与效率极差，应直接估算字符串长度减法。

---

## 4. 性能观察 (量化分析)

### 4.1 每步调用往返次数 (IPC 与网络 RTT)

以执行一次普通的输入或点击微操作为例：

| 调用层级                    | 阶段 | 操作                                          | 耗时估计          |
| :-------------------------- | :--- | :-------------------------------------------- | :---------------- |
| **Native ↔ Chrome IPC**     | 感知 | `chrome_read_dom` (全量树重建 + 序列化)       | **80 ~ 250 ms**   |
| **Native ↔ TypeSafe API**   | 决策 | Jev `systemOne` (HTTPS RTT + 推理)            | **120 ~ 300 ms**  |
| **Native ↔ Chrome IPC**     | 执行 | `chrome_interact_index` / `chrome_fill_index` | **50 ~ 120 ms**   |
| **单步总延迟 (Click/Type)** | -    | **2 次 Native IPC + 1 次公网 HTTPS**          | **250 ~ 670 ms**  |
| **若为 Select 下拉操作**    | -    | **3 次 Native IPC + 2 次公网 HTTPS**          | **450 ~ 1100 ms** |

> **关键观察**：
> 宣称的 `200~400ms/step` 仅在公网网络延迟极低且页面元素较少时才能勉强触达。其主要瓶颈不是 Jev 推理，而是**每步强制全量重新运行 `chrome_read_dom`**。

### 4.2 Jev Prompt 体积膨胀与网络传输

- **输入状态**：最多 250 个元素，上限 24,000 字符 (~6,000 tokens)。
- **问题分支膨胀**：
  - `action`：9 个选项
  - `click_target`：最多 251 个选项
  - `type_target`：最多 251 个选项
  - `select_target`：最多 251 个选项
  - 3 个 `noul` 问题
- 单步发送给 Jev API 的选择项定义多达 **762 项**。这些选项定义随着每个 HTTP 请求传输，造成高达 ~~8,000~~12,000 tokens 的输入体积，单次请求吞吐负担沉重。

---

## 5. LLM / 决策点清单 (供主控专项参考)

以下为当前 BrowserPaw 中全部基于 Jev / 规则引擎的决策点及其位置：

| 决策点编号 | 文件绝对路径与行号                                        | 决策性质         | 决策输入与算子类型          | 说明                                                        |
| :--------- | :-------------------------------------------------------- | :--------------- | :-------------------------- | :---------------------------------------------------------- |
| **DEC-01** | `app/native-server/src/jev/jev-client.ts:143-154`         | 动作类型决策     | `choice` (9 选 1)           | 决策下一步动作是 click, type, select, scroll, wait, done 等 |
| **DEC-02** | `app/native-server/src/jev/jev-client.ts:155-158`         | 点击目标元素决策 | `choice` (N+1 选 1)         | 从页面所有元素索引中推选最贴合的点击目标                    |
| **DEC-03** | `app/native-server/src/jev/jev-client.ts:159-162`         | 文本输入目标决策 | `choice` (N+1 选 1)         | 从页面所有元素索引中推选输入框目标                          |
| **DEC-04** | `app/native-server/src/jev/jev-client.ts:163-166`         | 下拉选择目标决策 | `choice` (N+1 选 1)         | 从页面所有元素索引中推选下拉菜单目标                        |
| **DEC-05** | `app/native-server/src/jev/jev-client.ts:167-169`         | 目标达成判定     | `noul` (二值概率)           | 判定任务是否在当前页面状态下已彻底完成                      |
| **DEC-06** | `app/native-server/src/jev/jev-client.ts:170`             | 卡顿死循环判定   | `noul` (二值概率)           | 判定连续执行是否陷入零进展死循环                            |
| **DEC-07** | `app/native-server/src/jev/jev-client.ts:171-173`         | 破坏性风险判定   | `noul` (二值概率)           | 判定动作是否涉及支付、删除、提交等不可逆风险                |
| **DEC-08** | `app/native-server/src/jev/jev-client.ts:370`             | 下拉菜单选项判定 | `score` (误用，应为 choice) | 为 `<select>` 的 options 挑选最佳匹配项                     |
| **DEC-09** | `app/native-server/src/jev/heuristic-engine.ts:124-211`   | 规则候选元素优选 | 启发式综合打分              | 子串加权(+2.0)、Token重合比例、Role加权(+0.5)               |
| **DEC-10** | `app/native-server/src/jev/heuristic-engine.ts:236-248`   | 规则动作映射     | 启发式规则判定              | 映射为 click, type, select, scroll_down                     |
| **DEC-11** | `app/native-server/src/jev/heuristic-engine.ts:261-274`   | 规则目标达成推断 | 词汇覆盖率 (>=0.8)          | 粗糙的页面静态文案重合判定                                  |
| **DEC-12** | `app/native-server/src/jev/heuristic-engine.ts:279-305`   | 规则卡滞推断     | 3 次连续结果比对            | 比对 urlChanged, mutated, visualDiff 判定卡顿               |
| **DEC-13** | `app/native-server/src/jev/fast-decision-engine.ts:35-64` | 安全中断词识别   | 词边界正则提取              | 检查目标是否匹配用户自定义暂停词                            |
| **DEC-14** | `app/native-server/src/mcp/register-tools.ts:189`         | 架构路由分流点   | 工具名称分发                | 拦截 `chrome_act_toward_goal` 本地闭环                      |

---

## 6. 潜在可用 Jev 但尚未利用的工具/场景评估 (Jev 潜能专项)

当前 BrowserPaw 中大量工具仍在等待外部通用大模型 (System 2) 逐回合慢速决策，或在 Chrome 扩展内部采用极为简陋的固定子串对比。以下工具具有极高的 Jev 改造潜能：

1. **`chrome_form_pipeline` (强烈推荐引入 Jev)**
   - **现状**：位于 `app/chrome-extension/entrypoints/background/tools/browser/form-pipeline.ts:256-296`，当前完全靠 `preSig?.question.toLowerCase().includes(f.query.toLowerCase())` 子串硬匹配。
   - **痛点**：若网页表单上的标签是 `"组织机构全称"`，而用户配置的 query 是 `"公司名"`，硬匹配直接落空，向导流程中断。
   - **Jev 改造方案**：引入 Jev `choice` 算子，在 100ms 内对当前视口的输入字段与用户待填字段进行语义相关度打分，实现高容错、免外部大模型的纯本地表单自动化推进。

2. **`chrome_smart_scroll` (智能定位滚动)**
   - **现状**：当前盲目向下滚动固定比例或寻找可滚动容器，无法得知目标内容在上方还是下方。
   - **Jev 改造方案**：Jev 传入当前页面首尾元素，用 `choice('Target content is likely located: [above, below, already_visible]')` 指导滚动方向与停止时机。

3. **`chrome_handle_dialog` (弹窗智能决断)**
   - **现状**：要么由外部大模型下发指令，要么脚本盲点确定。
   - **Jev 改造方案**：利用 Jev `noul('Is this dialog a harmless cookie/privacy consent banner that can be accepted?')` 实现 Cookie 弹窗与确认框的毫秒级自愈与放行。

4. **`chrome_grep` (语义级元素嗅探)**
   - **现状**：仅支持普通字面量与正则表达式查找。
   - **Jev 改造方案**：当字面匹配为空时，由 Jev 给出语义最贴近的候选元素索引。

---

## 7. 模块依赖与被依赖关系清单

### 7.1 内部文件依赖树

```
register-tools.ts
  └── import { FastDecisionEngine } from '../jev' (index.ts)
        ├── types.ts (纯接口定义，无外部依赖)
        ├── jev-client.ts
        │     ├── @typesafe-ai/sdk (TypeSafeClient, choice, noul, score 等)
        │     └── types.ts
        ├── heuristic-engine.ts
        │     ├── types.ts
        │     └── jev-client.ts (isDestructiveTarget)
        └── fast-decision-engine.ts
              ├── @modelcontextprotocol/sdk/server/index.js (Server)
              ├── types.ts
              ├── jev-client.ts (全量工具函数与客户端)
              └── heuristic-engine.ts (HeuristicEngine)
```

### 7.2 被依赖关系 (Consumers)

1. **`app/native-server/src/mcp/register-tools.ts`**：
   - 唯一直接消费者。在启动时单例实例化 `FastDecisionEngine`，在 `handleToolCall` 中将 `chrome_act_toward_goal` 重定向至其 `run()` 方法。
2. **外部宏规划模型 (Macro Planners / Skills / Plugins)**：
   - `packages/shared/src/tools.ts` 与 `packages/shared/src/tool-profiles.ts`：声明工具元数据并将其归入默认激活 Profile；
   - `plugins/browserpaw/skills/browserpaw/SKILL.md`：将 `chrome_act_toward_goal` 设定为页面动作目标默认选择 (Tier 1 Default，承载 70% 网页交互)。
