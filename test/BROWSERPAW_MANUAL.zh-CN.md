# BrowserPaw 操控手册

> 适用对象:通过纯 HTTP/JSON-RPC 直连 BrowserPaw(原 mcp-chrome)的 MCP 客户端与自动化 Agent。
> 服务地址:127.0.0.1:12306(native host 常驻进程)。生成日期:2026-09-07。
> 所有调用方式与返回格式均经活体验证(curl + node fetch 实测)。

---

## 1. MCP 服务接入方式

### 1.1 架构链路

```
MCP Client ──POST http://127.0.0.1:12306/mcp (Streamable HTTP)──▶ Native Host(常驻)
    Native Host ──Native Messaging(4 字节 LE 长度前缀帧,1MB 缓冲区保护上限)──▶ Chrome 扩展 background
        扩展 ──content script / CDP──▶ 页面
```

关键源码:

- HTTP 服务与鉴权:`app/native-server/src/server/index.ts`、`app/native-server/src/server/token.ts`
- MCP 会话与工具注册:`app/native-server/src/mcp/{mcp-server.ts,register-tools.ts,session-manager.ts}`
- stdio 桥(供 Claude CLI 等):`app/native-server/src/mcp/mcp-server-stdio.ts`

### 1.2 端点与协议

| 方法                      | 路径            | 用途                             | 鉴权       |
| ------------------------- | --------------- | -------------------------------- | ---------- |
| POST                      | /mcp            | 主通道:JSON-RPC(Streamable HTTP) | 需要 token |
| GET                       | /mcp            | SSE 事件流(服务端推送)           | 需要 token |
| DELETE                    | /mcp            | 关闭会话                         | 需要 token |
| GET                       | /ping           | 健康检查                         | 免鉴权     |
| GET /sse + POST /messages | /sse、/messages | 遗留 SSE 传输(兼容旧客户端)      | 需要 token |

- 协议:MCP protocolVersion `2025-03-26`,SDK `@modelcontextprotocol/sdk ^1.11.0`,serverInfo `ChromeMcpServer 1.0.0`。
- 推荐 Streamable HTTP(`/mcp`);`/sse` 是旧传输,新客户端不必使用。

### 1.3 认证

HTTP 层必须带 token(`/ping` 与 CORS 预检 OPTIONS 除外)。三种等价方式:

1. `Authorization: Bearer <token>`(推荐)
2. `x-mcp-token: <token>`
3. `?token=<token>` 查询参数

token 来源:`C:\Users\<user>\.chrome-mcp\bridge-token`。优先级:环境变量 `CHROME_MCP_TOKEN` > 该文件 > 自动生成;比较使用 timing-safe。无需其他认证,`mcp-session-id` 不是密钥而是会话句柄。

### 1.4 会话握手流程

1. **initialize**:POST `/mcp`,**不带** `mcp-session-id` 头,发 `initialize` 请求(protocolVersion `2025-03-26`)。服务端创建 UUID 会话,并在**响应头**返回 `mcp-session-id`。
2. **initialized 通知**:发 `notifications/initialized`(无 `id` 字段)。
3. 后续所有请求(`tools/list`、`tools/call`)带 `Mcp-Session-Id` 头。
4. 会话空闲 10 分钟被回收;单次工具调用(native host → 扩展)超时 **120 秒**。

### 1.5 响应格式陷阱(重要)

即使请求头 `Accept: application/json, text/event-stream`,响应的 `content-type` 依然是 `text/event-stream`,body 是 SSE 帧:

```
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

客户端必须按 `data: ` 行拆分并取 JSON 解析,不能直接 `JSON.parse(body)`。

### 1.6 curl 示例(PowerShell 7)

```powershell
$tok = (Get-Content "$env:USERPROFILE\.chrome-mcp\bridge-token" -Raw).Trim()
# 1) initialize —— 从响应头拿 mcp-session-id(-i 显示响应头)
curl.exe -si -X POST http://127.0.0.1:12306/mcp `
  -H "Authorization: Bearer $tok" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"1.0\"}}}'
# 2) 用上一步响应头里的 mcp-session-id 继续
$sid = "<上一步的 mcp-session-id>"
# 3) initialized 通知(无 id)
curl.exe -s -X POST http://127.0.0.1:12306/mcp -H "Authorization: Bearer $tok" -H "Mcp-Session-Id: $sid" -H "Content-Type: application/json" -d '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}'
# 4) 调用工具(响应为 SSE 帧,解析 data: 行)
curl.exe -s -X POST http://127.0.0.1:12306/mcp -H "Authorization: Bearer $tok" -H "Mcp-Session-Id: $sid" -H "Content-Type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"chrome_read_dom\",\"arguments\":{}}}'
```

### 1.7 node fetch 示例(最小可用)

```js
import fs from 'node:fs';
import os from 'node:os';
const BASE = 'http://127.0.0.1:12306/mcp';
const TOKEN = fs.readFileSync(os.userInfo().homedir + '/.chrome-mcp/bridge-token', 'utf8').trim();
let sessionId = null;

function parseSse(text) {
  for (const line of text.split('\n'))
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {}
    }
  return null;
}

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + TOKEN,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const msg = parseSse(await res.text()) ?? JSON.parse(await res.text());
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

// 握手
await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'demo', version: '1.0' },
});
await rpc('notifications/initialized');
// 调工具
const r = await rpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} });
console.log(r.content[0].text);
```

---

## 2. 工具清单与参数 schema

### 2.1 规范注册工具总览 (共 50 个规范 MCP 工具)

全量工具清单严格基于 `TOOL_SCHEMAS` 导出（49 个浏览器/扩展端工具 + 1 个原生服务层自驱微闭环工具）：

**0. 自主执行微闭环 (1)**

- `chrome_act_toward_goal` —— 本地感知-决策-交互语义微循环（~200–400ms/步，零中间 MCP 往返，Jev/启发式双引擎）

**1. 窗口与标签页管理 (7)**

- `get_windows_and_tabs` —— 列出全部窗口与标签页（无参数，返回 `{windowCount, tabCount, windows}`）
- `chrome_switch_tab` —— 切换活跃标签页或绑定会话亲和
- `chrome_move_tab` —— 调整标签页位置或跨窗口移动
- `chrome_close_tabs` —— 批量关闭标签页（关闭前台活跃标签页需显式 `confirm: true`）
- `chrome_attach_tab` / `chrome_detach_tab` —— 显式附加/脱离 CDP 调试器

**2. 内容感知与检索 (7)**

- `chrome_read_dom` —— 核心: 生成 1-based 剪枝 DOM 交互树（详见 2.4.1）
- `chrome_scroll_until_found` —— 客户端高性能 RAF 平滑流式滚屏查找，自动沉降虚拟 DOM
- `chrome_grep` —— 毫秒级正则/文本定向检索，穿透 Shadow DOM 与子 Frame，免 dump 全量 DOM
- `chrome_get_markdown` —— 提取纯净 Markdown 文本内容（支持 `includeLinks: true`）
- `chrome_inspect_media` —— 提取 `<img>` 与 `<canvas>` 图像 Data URL，支持局部超采样
- `chrome_get_dropdown_options` —— 获取 select/combobox 候选列表
- `chrome_console` —— 捕获并过滤 JavaScript 控制台日志与错误

**3. 页面交互、输入与流水线 (15)**

- `chrome_interact_index` —— 核心: 派发物理级点击/悬停/双击/拖拽（支持 `includeDelta: true` 与视觉回退坐标补偿）
- `chrome_fill_index` —— 原生物理级文本填充与回车提交（支持清空与 `includeDelta: true`）
- `chrome_batch_actions` —— 闭环单回合批处理流水线（点击、输入、等待、assert 断言、extract 提取）
- `chrome_form_pipeline` —— 确定性复杂表单向导自驱流水线
- `chrome_smart_scroll` —— 智能自适应平滑滚屏
- `chrome_keyboard` —— 物理按键与快捷键派发
- `chrome_upload_file` —— 原生文件选择对话框路径注入
- `chrome_insert_media` —— 富文本/聊天框媒体文件零拷贝拖放注入
- `chrome_handle_dialog` —— JavaScript 原生弹窗（Alert/Confirm/Prompt）自动化处理
- `chrome_handle_download` —— 文件下载监听与路径追踪
- `chrome_computer` —— 统一光标与键盘物理控制接口（兼容 Anthropic Computer Use）
- `chrome_request_human_intervention` —— 毛玻璃弹层让渡控制权（供人类完成滑块/2FA）
- `chrome_undo_last_action` —— 5 步环形栈单步回滚
- `chrome_dismiss_overlay` —— 一键关闭各类营销浮层、广告模态框与 Cookie 授权条
- `chrome_javascript` —— 页面隔离世界中执行自定义 JavaScript（支持顶级 await 与自动 return）

**4. 视觉感知与底层执行 (3)**

- `chrome_screenshot` —— 捕获视口、全页或元素截图（纯内存 base64 直通，可选坐标标尺网格）
- `chrome_cdp_execute` —— 底层原生 CDP 指令逃生通道
- `chrome_tool_docs` —— 动态查询工具 Schema 并支持会话级免重启激活扩展分类（`activateForSession: true`）

**5. 标签分组、书签与存储 (10)**

- `chrome_tab_group_create` / `chrome_tab_group_update` / `chrome_tab_group_list` / `chrome_tab_group_ungroup` / `chrome_tab_group_close` —— 标签分组生命周期全套工具
- `chrome_history` —— 浏览器历史访问记录检索
- `chrome_bookmark_search` / `chrome_bookmark_add` / `chrome_bookmark_delete` —— 书签检索、新增与删除
- `chrome_storage` —— 读写与清理 localStorage、sessionStorage 与 Cookie

**6. 网络拦截与请求 (3)**

- `chrome_intercept_api` —— 实时嗅探并解码匹配 URL 模式的后端 JSON 响应
- `chrome_network_capture` —— 全链路网络请求抓取
- `chrome_network_request` —— 基于当前浏览器站点凭据代理发送原生 HTTP 请求

**7. 性能追踪与健康体检 (4)**

- `performance_start_trace` / `performance_stop_trace` / `performance_analyze_insight` —— Chromium 底层 Trace 录制与指标分析
- `chrome_doctor` —— 端口、Native Messaging 通信链路及环境健康自检

### 2.2 工具面严格对齐机制 (Tool Surface Strict Parity)

自 v3.0 起，扩展端 `tools/index.ts` 建立绝对严格的工具暴露对齐保障：

- 运行时 `toolsMap` 严格基于 `TOOL_SCHEMAS` 声明推导并过滤生成。
- **杜绝任何未声明的隐藏/隐式工具**：未在 `TOOL_SCHEMAS` 中正式注册的模块（如已被清理废弃的遗留工具 `chrome_click_element`、`chrome_fill_or_select`、`chrome_get_web_content`、`chrome_get_links`、`chrome_read_page` 等）会被底层安全路由直接拦截，返回 `Tool ... not found`，杜绝幽灵接口与未授权调用。
- 工具按需分层：默认采用 `core` Profile（14 个核心工具，~11.5k tokens），可设置 `CHROME_MCP_TOOL_PROFILE=full` 暴露全量 50 个工具，或在运行时通过 `chrome_tool_docs` 动态解锁。

### 2.3 通用参数与会话亲和

- 几乎所有工具都支持 `tabId` / `windowId` / `sessionId`。亲和解析顺序(`base-browser.ts resolveAffinityTab`):**显式 tabId > sessionId 绑定 > 当前活动 tab**。`sessionId` 适合多序列并行的会话-标签页绑定。
- Agent 控制开关:popup 里可暂停自动化(`chrome.storage.session.agentControlEnabled`);暂停时全部工具报错。`args.__admin_bypass__: true` 可绕过(仅管理用途)。
- 除 chrome_screenshot 的 `base64Data` 外,所有工具返回都是 `content[0].text` = JSON 字符串,成功形如 `{success: true, ...}`,失败形如 `{success: false, error: "..."}` 或工具级 `isError: true`。

### 2.4 重点工具详情

#### 2.4.1 chrome_read_dom(核心)

参数:

| 参数                               | 类型    | 说明                                               |
| ---------------------------------- | ------- | -------------------------------------------------- |
| `viewportThreshold`                | number  | 视口边界判定阈值,默认 1000(px)。调大可收录更远元素 |
| `tabId` / `windowId` / `sessionId` | —       | 目标标签页                                         |
| `highlight`                        | boolean | 可视化高亮已索引元素                               |

返回 JSON 字段(实测):

```json
{
  "treeString": "[Scroll Guidance: 0 pages above, 0.2 pages below...]\n[1] <button type=\"button\"> \"NEXUS\"</button>\n[2] <button type=\"button\"> \"DEBRIEF\"</button>...",
  "elementCount": 42,
  "interactiveCount": 30,
  "compressionRatio": 0.71,
  "indexMap": { "1": { "selector": "...", "frameId": 0 } },
  "indexedElements": [
    {
      "index": 1,
      "tagName": "button",
      "role": null,
      "text": "NEXUS",
      "attributes": { "type": "button" },
      "rect": { "x": 48, "y": 14, "width": 54, "height": 24 },
      "isVisible": true,
      "isInteractive": true
    }
  ],
  "pages_up": 0,
  "pages_down": 0.2,
  "scrollInfo": { "scrollY": 0, "viewportHeight": 720, "totalHeight": 900 }
}
```

treeString 行格式(1-based 扁平树):

```
[Scroll Guidance: X pages above, Y pages below. Use chrome_interact_index / scroll to reveal more content.]
[1] <button type="button"> "NEXUS"</button>
[4] <button type="button"> "P01
CLICK VECTOR"</button>
[16] <button id="fleeing-target" type="button"> "LOCK"</button>
[28] <button id="micro-target" type="button" aria-label="micro-target"></button>
<!-- Frame 1 -->
[31] <input name="email" type="email" placeholder="..."> "..."</input>
```

- `[n]` 是**全局唯一 1-based 索引**,后续 `chrome_interact_index` / `chrome_fill_index` / `chrome_batch_actions` / `chrome_screenshot(targetIndex)` 直接引用。
- 主帧索引在前;iframe 内容在 treeString **末尾**以 `<!-- Frame X -->` 段追加(子帧索引整体重映射)。
- 文本前带引号;保留属性:id,name,type,placeholder,aria-label,role,href,title,disabled,aria-disabled,contenteditable + data-*。
- 索引仅对**当前快照**有效:页面 DOM 变化后旧索引会失效(见第 4 节弱点 1),需要重新 read_dom。

#### 2.4.2 chrome_interact_index

参数:

| 参数              | 类型     | 说明                                                    |
| ----------------- | -------- | ------------------------------------------------------- |
| `index`           | number   | 1-based 元素索引(与 `coordinate` 二选一)                |
| `coordinate`      | `{x,y}`  | 视口像素坐标(Canvas/游戏/无索引目标用)                  |
| `action`          | enum     | `click`(默认)/ `hover` / `double_click` / `right_click` |
| `modifiers`       | string[] | `Alt`/`Control`/`Meta`/`Shift`                          |
| `waitForSettle`   | boolean  | 交互后等 DOM 静默 150ms(默认 false)                     |
| `settleTimeoutMs` | number   | 200-10000,默认 1500                                     |
| `humanize`        | boolean  | 拟人轨迹(3-5 步缓出 + 12-27ms 抖动,默认 false)          |

返回(实测 hover):

```json
{
  "success": true,
  "index": 1,
  "action": "hover",
  "tagName": "button",
  "text": "NEXUS",
  "isTrusted": true,
  "coordinates": { "x": 75, "y": 26 },
  "mode": "dom_index",
  "modifiers": [],
  "humanized": false
}
```

#### 2.4.3 chrome_fill_index

- 必填 `index`;`text`(或别名 `value`)要填的文本;`clear` 默认 true(先清空);`waitForSettle`/`settleTimeoutMs` 同上。
- 实现:CDP 坐标点击聚焦 → Ctrl/Meta+A + Backspace 清空 → `Input.insertText`。失败降级页内合成事件(React 18 原生 value setter + input/change)。已知弱点见 4.6/4.7。

#### 2.4.4 chrome_smart_scroll

参数:`direction`(`up`/`down`/`left`/`right`)、`amount`(像素,优先于 pages)、`pages`(视口页数,默认 1)、`index`(智能识别或聚焦目标容器)、`coordinate`(在该点滚)。
智能探测目标滚动容器，CDP 滚轮派发结合页内平滑滚动回退。

#### 2.4.5 chrome_batch_actions

- 必填 `actions`:数组,每项 `{type, ...}`,type ∈ `click`/`fill`/`hover`/`scroll`/`press_key`/`wait`。
- 动作参数:`index`(click/fill/hover)、`text`/`value`(fill)、`key`(press_key)、`coordinate`/`x`/`y`(click/scroll)、`direction`/`amount`(scroll)、`durationMs`(wait)、单项 `waitForSettle`/`settleTimeoutMs`。
- **事务语义:顺序执行、无回滚**。每步前有 URL 漂移守卫(URL 变了即中断,SPA pushState 也触发);失败记录 `{actionIndex, error, interruptedReason}` 后 break。press_key 支持 KEY_ALIASES(enter/tab/escape/arrow*/F1-F12 等),单字符走 insertText。

#### 2.4.6 chrome_screenshot

- 参数:`storeBase64`(默认 false,需文本 base64 时设 true)、`savePng`/`saveToDisk`(默认 false 纯内存零落盘，设为 true 时走系统 Temp 临时目录调试)、`fullPage`(默认 false)、`som`/`highlight`(Set-of-Mark 徽标)、`grid`(参考网格)、`targetIndex`+`padding`(按索引裁剪)、`format`(png/jpeg/webp)、`quality`(默认 80)、`selector`、`width`/`height`、`background`。
- 返回:`{image block (MCP 协议直出), text block (元数据 JSON)}` —— **默认通过纯内存 image block 直出，无物理落盘，绝不污染用户 Downloads 目录**。
- 限制:单张截图 450KB 安全预算，超限自动启动保真 WebP 压缩；显式 `savePng: true` 时经 native host 落盘至系统 Temp 目录 (`os.tmpdir()/chrome-mcp-uploads`)。
- `targetIndex` 裁剪对 <100x100 元素有 `expandSearchArea`(自动扩 200x200 上下文)。

#### 2.4.7 chrome_keyboard

- 必填 `keys`(如 `"Enter"`、`"Ctrl+C"`、`"Hello World"`);可选 `index`(先聚焦索引元素)/`selector`、`delay`(默认 50ms)、组合键支持 `+` 连接。

#### 2.4.8 chrome_handle_dialog

- 必填 `action`:`accept` / `dismiss`;可选 `promptText`(prompt 弹窗回复)、`tabId`。
- **必须在独立 MCP 调用中处理**(见 3.7:弹窗会挂起 renderer,阻塞后续一切调用)。

#### 2.4.9 chrome_navigate / chrome_switch_tab / get_windows_and_tabs

- `chrome_navigate`:`url`(或 `"back"`/`"forward"`)、`tabId`、`newWindow`、`width`/`height`(给宽高则开新窗,默认 1280x720)、`background`、`refresh`。
- `chrome_switch_tab`:必填 `tabId`。
- `get_windows_and_tabs`:无参数,返回窗口/标签页树(含 tabId、url、title、active 状态)。

---

## 3. 关键实现细节

### 3.1 dom-indexer.ts —— 索引分配与过滤

- **扁平 1-based 树**:两阶段(先收集候选元素,再批量命中测试 + 统一编号)。索引存入 `Symbol.for('__browser_use_isolated_index_map__')` 的 `Map<number, WeakRef<Element>>`(隔离宿主对象污染)。
- **Shadow DOM**:`chrome.dom.openOrClosedShadowRoot` 穿透 open/closed root,子元素正常入树。
- **伪装元素过滤**:`script/style/head/meta/link/title/noscript/template`、svg 内部、`display:none`、`visibility:hidden`、`opacity<=0`、零尺寸、|距视口| > viewportThreshold(默认 1000px)。**部分出视口的元素直接丢弃**(非裁剪,见 4.4)。
- **遮挡判定**:中心点 `elementFromPoint`,顶层元素 opacity >= 0.8 视为遮挡,`composedContains` 处理 shadow host 归属。
- **文本提取**:select 取选中项 / innerText / `::before`-`::after` content(含 CSS unicode 解码),截 120 字符。
- **isInteractive 启发式**:tag 语义(input/a/button...)、tabIndex>=0、aria-haspopup、cursor:pointer(含 cursor:pointer 父子抑制)等。
- 顶部可能带 `[Scroll Guidance: X pages above, Y pages below...]` 行(dom-indexer.ts:721)提示滚动余量。

### 3.2 read-dom.ts —— 快照与子帧

- allFrames 快照:主帧先编号 1..N;子帧内容重映射为全局索引,追加到 treeString 末尾 `<!-- Frame X -->` 段,并调 `inPageReindexFrame(offset)` 同步子帧内部 map。
- indexMap 的 selector 依赖 `data-mcp-idx` 属性,但该属性**实际从不写入** → indexMap 里的 selector 基本不可用(见 4.12),应只信 `indexedElements[].rect`。

### 3.3 interact-index.ts —— CDP 事件派发

- 主帧 `inPageGetElementCoordinates`:矩形中心 + iframe border/zoom 补偿,自动 scrollIntoView;失败则扫 allFrames 找元素。
- 派发:CDP `Input.dispatchMouseEvent`。click = press/release(clickCount 1);double_click = down(1)/up(1)/down(2)/up(2);right_click = right 按下 + 额外合成 `contextmenu`;hover = mouseMoved。
- modifiers 位掩码:Alt=1、Ctrl=2、Meta=4、Shift=8。
- `humanize: true`:3-5 步缓出轨迹 + 12-27ms 抖动后再点击(过简单轨迹检测)。
- cross-origin 子帧(frameId != 0 且 frameOffsetX/Y 为 0)改用**帧内合成事件**(isTrusted=false)——存在同源 iframe 偏移恰为 0 的误判 bug(见 4.3)。
- CDP 失败降级 `inPageInteractIndex` 合成事件。
- `waitForSettle`:MutationObserver 静默 150ms 防抖(仅主帧,见 4.11)。

### 3.4 fill-index.ts —— React 18 受控输入

- **首选 CDP 路径**:坐标点击聚焦 → 清空(Ctrl/Meta+A `rawKeyDown/rawKeyUp` + Backspace)→ `Input.insertText`(浏览器层注入,isTrusted=true,不逐键触发 keydown)→ 结束后补 blur/change 尾事件(如有)。
- **降级路径 `inPageFillIndex`(React 18 标准做法)**:用原生 prototype value setter(`HTMLInputElement`/`HTMLTextAreaElement`)覆盖 value + contenteditable 设 innerText,再派发 `input` + `change`(composed)——绕过 React 的 value 拦截器,触发受控组件 onChange。
- 已知弱点:insertText 无逐键 keydown → 依赖 keydown 过滤/掩码的输入框失效;聚焦失败时 Ctrl+A 全选整个文档 → Backspace 可能清页面(见 4.6);无 blur 时 change-on-blur 校验不触发(见 4.7)。

### 3.5 scroll.ts —— 嵌套容器滚动

- CDP `Input.dispatchMouseEvent` 类型 `mouseWheel`,单事件全量 delta(不做逐帧滚动)。
- **`index` 参数 → 轮子在该元素中心触发**:浏览器命中测试天然选中最内层可滚容器,这是嵌套容器滚动的正解(不要用视口中心滚内层容器)。
- `coordinate` → 指定点;默认视口中心。失败降级 `window.scrollBy`。
- 之后 `waitForPageSettle`(300ms / quiet 60ms)。

### 3.6 batch-actions.ts —— 批量动作

- 支持动作:`click` / `fill` / `hover` / `scroll` / `press_key` / `wait`。
- **顺序执行、无回滚、无重试**;每步前 URL 漂移守卫:URL 与批次开始不同即中断(SPA pushState 也触发,见 4.8)。
- 失败:`{success:false, actionIndex, error, interruptedReason, completedActions}`,之后动作不执行。
- `scroll` + `index` 走 `inPageScrollToIndex`(scrollIntoView 语义,与 chrome_smart_scroll 的 wheel 语义不同——batch 里滚嵌套容器请用 coordinate)。
- press_key:KEY_ALIASES 表(enter/backspace/tab/escape/space/pageup/pagedown/home/end/arrow*/F1-F12);单字符走 `Input.insertText`,其余 `rawKeyDown`/`rawKeyUp`(**未带 windowsVirtualKeyCode**,见 4.9)。

### 3.7 dialog.ts —— 对话框自动化

- 仅实现 CDP `Page.handleJavaScriptDialog`(accept/dismiss + promptText)。
- **全扩展没有 `javascriptDialogOpening` 自动监听**:页面弹 alert/confirm/prompt 会挂起 renderer,后续所有 executeInPage / CDP 调用全部等待。**必须在独立的 MCP 调用里调 `chrome_handle_dialog` 解锁**(触发弹窗的调用返回后,下一个调用发 handle_dialog)。

### 3.8 支撑组件速记

- `in-page-engine.ts`:executeInPage = 注入 inpage-engine.js + start/poll/retrieve 三次 executeScript 往返(15s 超时,10ms 轮询);异步函数经 promise box 协议。
- `cdp-session-manager.ts`:refcount + owner、每 tab 串行队列;refCount=0 后**延迟 5s detach**(保 hover 状态);断线自动重连一次;DevTools 等外部占用则拒绝 attach。
- `screenshot.ts`:纯内存 image block 直通;450KB 智能压缩预算;savePng 默认 false (零磁盘写入,绝不污染 Downloads)。
- `web-fetcher.ts`: 历史遗留工具，已由 `chrome_get_markdown` 替代并支持结构化 Markdown 输出。
- native host:`native-messaging-host.ts`,stdin 4 字节 LE 长度前缀帧,1MB 缓冲区保护上限,requestId 关联;扩展经 native-port 连接,START 指令起 HTTP 服务。
- stdio 代理:`mcp-server-stdio.ts` = stdio → HTTP(12306) 桥,供 Claude CLI 等使用。

---

## 4. 已知薄弱点与创新机会

复杂靶场可能踩中的具体缺陷,按风险排序:

1. **索引漂移(高频)**:read_dom 快照到 interact 之间 DOM 变化 → WeakRef 失效,报 `"Element with index [n] not found ... Please call chrome_read_dom"`。建议:索引加版本号 + 失效时自动重读一次再重试。
2. **误点击**:坐标快照后 CDP 直发,派发前无 `elementFromPoint` 复核,目标被动态替换时点错。建议:派发前中心点复核 tagName/role。
3. **跨域子帧误判 bug**:同源 iframe 的 frameOffset 恰为 0(全屏 iframe)被当 cross-origin → 走帧内合成事件路径(isTrusted=false)→ 事件被防机器逻辑拒绝。建议:判定条件加 frame origin 比较,而不是只看偏移。
4. **遮挡剪枝过猛**:部分出视口的元素整体丢弃(非裁剪),长列表中间项在 Guidance 提示前不可见。建议:改成出视口元素标记 + 裁剪坐标而非丢弃。
5. **委托事件元素漏索引**:React/Vue 委托事件、无 role/cursor/onclick 静态特征的 div 按钮不进树。建议:补事件监听启发式或全树 data-* 探测。
6. **fill Ctrl+A 危险**:聚焦失败时 Ctrl+A 全选文档 → Backspace 可能清掉页面内容甚至触发导航。建议:清空前验证 activeElement 是目标元素,否则跳过清空。
7. **insertText 无 keydown / 无 blur**:掩码输入、keydown 过滤、change-on-blur 校验失效。建议:高风险字段逐键 `Input.dispatchKeyEvent` + 显式 blur。
8. **batch URL 守卫过严**:任何路由变更(含 SPA pushState)中断批次,且无事务回滚。建议:允许白名单域内跳转,或提供 `strictUrlGuard: false`。
9. **press_key 缺 windowsVirtualKeyCode**:部分按 keyCode 判断的处理程序忽略按键。建议:补 key => keyCode 映射表。
10. **对话框无自动处理**:交互触发 alert 后,同连接后续调用全部挂起直到 handle_dialog。**操作序列必须预置弹窗处理步骤**(见 5.3)。
11. **waitForSettle 仅主帧**:iframe 内 DOM 变化不算;settleTimeout 内未静默返回 settled:false,长动画页面耗时。建议:全帧 MutationObserver。
12. **indexMap 的 data-mcp-idx 从不写入**:indexMap.selector 引用永不存在的属性,纯误导。建议:忽略 indexMap,只信 indexedElements[].rect。
13. **1MB Native Messaging 缓冲区上限**:大截图/超大 HTML 传输可能触碰管道物理限制。BrowserPaw 已优化为纯内存 base64 直通传输并具备 450KB 智能压缩预算，长页面建议优先使用 `chrome_read_dom` 或 `chrome_get_markdown`。
14. **微小元素(4px)点击偏移**:坐标 Math.round 中心可能落到边缘/子元素;交互路径无最小尺寸扩展(仅截图裁剪有 expandSearchArea)。建议:派发前中心点复核 + 必要时改用坐标直发(micro-target 类靶:先 read_dom 拿 rect,用 coordinate 直发中心点,并检查返回 coordinates 是否在目标 rect 内)。
15. **executeInPage 三次往返**:start/poll/retrieve 每次 3 次 executeScript,延迟放大。高频 JS 操作建议合并逻辑单次注入。

---

## 5. 工具调用速查

### 5.1 mcp-client.mjs(已存盘 test/mcp-client.mjs)

```js
import { mcpCall, callTool, listTools } from './test/mcp-client.mjs';

// 核心封装:mcpCall(tool, args) —— 自动握手 + SSE 解析 + isError 抛错 + JSON 解析
const tabs = await mcpCall('get_windows_and_tabs', {});
const dom = await mcpCall('chrome_read_dom', {}); // {treeString, indexedElements, ...}
await mcpCall('chrome_interact_index', { index: 3, action: 'click', waitForSettle: true });
await mcpCall('chrome_fill_index', { index: 12, text: 'hello' });
await mcpCall('chrome_smart_scroll', { direction: 'down', amount: 600 });
const shot = await mcpCall('chrome_screenshot', {
  storeBase64: true,
  savePng: false,
  fullPage: false,
  format: 'jpeg',
  quality: 40,
});

// 低层:callTool 返回 {structured, raw} 或 {text, raw};listTools 返回 [{name, schema}]
```

CLI 用法:

```
node test/mcp-client.mjs --list
node test/mcp-client.mjs chrome_read_dom '{}'
node test/mcp-client.mjs chrome_interact_index '{"index":3,"action":"click"}'
```

实现要点(与 1.7 一致):token 从 `~/.chrome-mcp/bridge-token` 读取;请求头 `Content-Type: application/json` + `Accept: application/json, text/event-stream` + `Authorization: Bearer`;会话建立后带 `mcp-session-id`;响应按 `data: ` 行解析。

### 5.2 标准操控循环

```
1. get_windows_and_tabs → 选定 tabId(或用 sessionId 绑定)
2. chrome_navigate {url, tabId} → 等 load
3. chrome_read_dom {tabId} → 解析 indexedElements 定位目标 index
4. chrome_interact_index {index, action: "click", waitForSettle: true}
5. 若页面结构变化 → 重新 chrome_read_dom 再取新索引
```

### 5.3 弹窗处理序列(alert/confirm/prompt)

弹窗会挂起 renderer,**必须分两个独立 MCP 调用**:

```
调用 A: chrome_interact_index {index: <触发弹窗的元素>}
调用 B: chrome_handle_dialog {action: "accept", promptText: "..."}   # 独立调用,解锁 renderer
之后:  chrome_read_dom {}   # 弹窗后的 DOM 重新索引
```

### 5.4 嵌套滚动容器

```
chrome_smart_scroll {index: <容器内元素索引>, direction: "down", amount: 300}   # 轮子在元素中心 → 命中最内层容器
# 或坐标直发:
chrome_smart_scroll {coordinate: {x: 400, y: 300}, direction: "down"}
```

### 5.5 微小目标 / 反爬靶(4px 按钮、fleeing target)

```
1. chrome_read_dom → 从 indexedElements[].rect 拿精确坐标
2. chrome_interact_index {coordinate: {x: rect.x + rect.width/2, y: rect.y + rect.height/2}, action: "click", humanize: true}
3. 校验返回 coordinates 落在目标 rect 内;索引失效立即重读
```

### 5.6 错误恢复

| 错误                                                               | 处置                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `Element with index [n] not found ... Please call chrome_read_dom` | 索引漂移:立即重读 DOM,映射新索引后重试                             |
| 工具调用超时(120s)                                                 | 页面可能被对话框挂起:先发 `chrome_handle_dialog {action:"accept"}` |
| `HTTP 401`                                                         | token 失效:重读 bridge-token 文件(env CHROME_MCP_TOKEN 优先)       |
| `HTTP 400 Invalid MCP request or session`                          | 会话丢失(10 分钟空闲回收):重新 initialize                          |
| 暂停报错                                                           | popup 恢复自动化,或 `args.__admin_bypass__: true`                  |

---

_手册完。所有 schema 与返回格式均基于 tools/list 实测 + 源码(native-server / 扩展 background tools)交叉验证。_
