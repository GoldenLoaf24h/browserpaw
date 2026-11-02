# 持久 Node REPL

本地构建后，在仓库运行：

```sh
node bin/browserpaw.cjs repl
```

发布的 native CLI 入口是 `mcp-chrome-bridge repl`。bridge 必须已经运行；入口读取已有凭据，缺少凭据时直接报错。

同一 REPL 内变量和 MCP 连接持续存在，支持 top-level await：

多步任务使用同一连接的 `browser === mcp` 接口。`browser.help()` 仅列出方法和 JS 签名，不加载整份 schema；`await browser.help('locator.fill')` 才返回该方法的实参说明。一个对象实参直接描述对象，多实参按位置描述；例如 `skills.propose(definition)` 不再包成 `{definition: ...}`。帮助不请求浏览器，也不会解锁或执行工具。显式完成任务：

```js
await browser.help('locator.fill');
const task = await browser.task.start({ name: 'Read MDN' });
try {
  const page = await task.open('https://developer.mozilla.org/en-US/search?q=AbortController');
  const snapshot = await page.observe({ selector: 'main', format: 'compact' });
  console.log(snapshot.data);
} finally {
  await task.finish();
}
```

`page.frame(frameId)` 限定框架；`locator`、`getByText`、`getByRole`、`getByLabel` 使用共同的严格定位与动作执行器。`locator.fill(value)` 默认替换，保留输入中的空格，空字符串用于清空；显式 `{clear:false}` 才追加。支持 `click/fill/press/waitFor`，未知方法和参数拒绝执行，不宣称完整 Playwright 兼容。`task.cancel()` 阻止后续动作，不回滚已派发动作；新连接必须显式 `browser.task.takeOver(id,{confirm:true})` 后恢复。

`mcp.call(name, args, {signal})` 的 AbortSignal 只取消当前请求，不把持久任务改成已取消。已经确认创建或交还的页面仍写回账本，后续动作停止；新连接核对身份并显式接管后可继续。显式 `task.cancel()` 才改变任务生命周期。技能内部的临时任务仍会在 finally 中尝试安全清理，清理错误保留原来的未知结果和回执。

接管确认会等待该任务当前调用及账本写回完成；它不撤销已派发动作。点击或按键触发整页导航后，先查看任务的 pending 身份，再独立读取 `mcp.call('get_windows_and_tabs',{})`，核对 browserInstanceId、tabId、documentId 和 URL；与已记录的变化一致才用 `await browser.task.resume(task.id,{adopt:true})` 确认。任务列表是账本，不能替代新浏览器库存。该方法返回任务句柄。未确认的文档不能继续操作或成功结束清理；`finish` 会报错并保留归属，不能把未释放页面当作已交还。已取消任务不会被恢复；身份不明的页面保留，确认并关闭页面后可再次清理。

标准与 fast 观察在同一文档、相同参数且状态可核对时复用采集结果；动作后的增量反馈保持开启。DOM、表单属性、Shadow DOM、CSSOM、焦点、视口和布局变化会失效；动画、不可读取样式或超出探针预算时完整采集。`page.observe({includeDetails:true})` 的 `observations` 按 frame/document 标明是否复用；默认简洁输出不增加这一诊断块。它省去的是重复剪枝，并非零成本检查或业务完成证明。

建页成功但身份读取失败时，任务保留 `pendingCreations` 回执；对应页仍存在就拒绝继续建页或报告清理完成。回执不授予关闭未知文档的权限。原始 `chrome_cdp_execute` 也不接受任务作用域：协议中的 target 可绕过页面边界，需要原始 CDP 的明确诊断直接调用原子工具，并自行限定目标。

未知建页结果必须保留待处理回执，重连或 Native 重启后不可静默丢弃。已有 `tabId` 的迟到页面，只有在浏览器报告同一实例、仍为 Agent 管理且取得具体 `documentId` 后，才可显式 `resume({adopt:true})` 接管；URL 相同不算身份。没有 `tabId` 的回执继续阻止新建页面。默认 `finish` 在回执仍对应页面时返回未验证，不会假称清理完成。只有用户明确决定保留所有待处理页面，才可调用 `await task.finish({keepUnknownPages:true,confirm:true})`；保留返回的警告与交还回执。这不关闭这些页面，也不证明页面已被清理，技能的自动收尾不会启用该选项。

派发前拒绝带有 `status:'blocked'`、`dispatched:false`；等待响应超时带有 `status:'unknown'`、`retry:false`。`requestDispatched` 只表示请求是否进入传输，不证明物理页面动作发生或业务完成。任务、技能和原子 MCP 路径保留原回执和 content，错误的原始结果可通过 `error.result` 检查；不要从一段堆栈或超时反推“没有执行”，也不要重放未知写操作。

`help('page.observe')` 等已知方法直接返回随构建提供的 schema；只有缺少静态 schema 时才按需读取工具文档，因此首次探索不会为了帮助说明额外消耗 MCP 往返。

`skills.find(url,intent)` 只返回已验证正式技能；`skills.propose(definition)` 保存候选，`skills.validate(id)` 以至少两组不同输入创建新任务复测后自动启用，失败不替换旧正式版本。`skills.run(id,inputs)` 每次检查业务输出契约；结果未知时停止且不重放。X 需要可用登录环境，候选的存在不代表搜索或帖子串已验收。

自动技能的 JavaScript 使用本地发布包中经过审查的程序体。新站点的 DOM 提取可声明 `{tool:'chrome_javascript',args:{program:'dom-extract',config:{fields:[{name:'title',selector:'h1',value:'text'}]}},resultPath:'/result'}`；返回值包含 `success`、`fields`、`sources.page`。配置与可执行程序分开校验，任意代码和写盘等副作用选项在创建任务前拒绝。字段和限制见 canonical 技能的 [recipe 契约](../../skills/browserpaw/references/recipe-contract.md)。

X 搜索候选为 `x-search-thread`，帖子串候选为 `x-visible-thread`，后者输入 `{author, postId, limit?}`。它只返回精确 focal 和已加载、可核对父帖关系的同作者回复；不把前文、推荐帖或未知关系当回复，也不承诺完整导出。搜索加载超时与真实认证失败分别报告。

以下 `mcp.call()` 用于直接访问原子工具，其原始结果与图像内容保持兼容。

> **创建自有标签页**：`chrome_navigate` 默认 `newWindow: false` 可能复用已打开同 URL 的标签页。示例显式指定 `newWindow: true, background: true`，请求创建 `focused: false` 的独立窗口。它能避免复用用户标签，完整的后台焦点行为仍需浏览器运行时验证。新窗口的标签 ID 位于 `opened.data.tabs[0].tabId`，单标签返回则位于 `opened.data.tabId`。

```js
const help = await browser.help('page.goto');
help.schema;
const opened = await mcp.call('chrome_navigate', {
  url: 'https://developer.mozilla.org/en-US/',
  newWindow: true,
  background: true,
});
opened.data ?? opened.text;
```

以实际返回的 tabId 继续操作。不要猜测 tabId，不要假设返回字段来自完整 Playwright：

```js
const tabId = opened.data?.tabs?.[0]?.tabId ?? opened.data?.tabId;
const snapshot = await mcp.call('chrome_read_dom', { tabId, format: 'compact' });
snapshot.data ?? snapshot.text;
```

`mcp.call()` 保留 MCP 的 content、structuredContent 等字段，并附加合并后的 `text`；`data` 优先使用结构化结果，否则解析去掉工具类别提示后的 JSON。提示、图像和资源仍在原始 `content` 内。工具业务错误与协议错误均抛出，代码应先观察页面判断结果，不能盲目重试点击/提交。

工具可能受当前 profile 影响，以 `mcp.tools()` 返回的 schema 为准。长序列优先复用现有 `chrome_batch_actions`；页面内提取可使用 `chrome_javascript` 的 `mcp.run`。Node 变量能跨页面导航保留，页面自己的 JS 变量则不能。

`await mcp.notes('https://developer.mozilla.org/')` 优先读取正式技能摘要，否则按精确域名读取随包经验，最多 4 KiB。结果说明来源、是否截断，以及验证日期是否缺失或超过 90 天。它只返回参考数据；技能执行使用 `skills.run`。个人技能位于 `~/.browserpaw/skills`（遵循 `BROWSERPAW_HOME`），随包经验源位于 `skills/browserpaw/assets/recipes/`，构建复制到 Native 的 `dist/recipes/`。

`.exit` 只关闭 MCP 连接。清理时显式指定自己创建的标签：

```js
await mcp.call('chrome_close_tabs', { tabIds: [tabId] });
```

REPL 运行在普通 Node 进程中，具有该进程的本地权限。连接仅允许 loopback HTTP，不会把 bridge 凭据发送到远程 URL；也不会为缺少凭据的环境创建新 token。

下载使用 `await browser.help('page.download')` 查看合同。`await page.download({clickTargetIndex: ref})` 先准备页面来源监听，再通过共同执行器点击一次；ref 必须来自本次观察。框架内触发可使用 `page.frame(frameId).download(...)`。不要并发调用等待和另一次点击：同一任务串行执行，会互相阻塞。

返回的 `download.guid` 可用于 `await page.download({guid})`；查询不会重做点击。默认等待 `completed`，显式 `waitForComplete:false` 仅确认开始。`suggestedFilename` 只是建议名，`verifiedPath:false` 明确没有证明磁盘路径。它与 Chrome 数字下载 ID 是不同身份，不能靠 URL、文件名或时间猜测关联。新页面来源模式遇到旧扩展时直接拒绝，未限定页面的原子调用才保留全浏览器观察语义。

等待取消、超时或结果未知都不能重放触发。取消等待不取消浏览器正在下载的文件。任务账本记录最近核对的下载状态及时间；清理会重新读取来源，进行中或未知状态阻止默认关闭自建页面。需要交还用户时显式 `handOff` 或 `finish({keep:[tabId]})`；借用页始终保留。交还不证明下载完成，正常收尾也不删除用户下载文件。来源窗口或会话失联、worker 恢复但无法核实时返回未知；不改浏览器的全局下载行为。
