# BrowserPaw 集成与控制手册

[English](./BROWSERPAW_MANUAL.md)

> **读者对象**：通过 HTTP、SSE 或 stdio JSON-RPC 直连 BrowserPaw 的开发者与 Agent 集成方。  
> **默认端点**：`http://127.0.0.1:12306/mcp`（Streamable HTTP / SSE）。  
> **协议**：Model Context Protocol (MCP) `2024-11-05`。

---

## 1. MCP 服务连通性

### 1.1 架构与管道

```text
MCP 客户端 ──POST http://127.0.0.1:12306/mcp (Streamable HTTP)──▶ 原生宿主（Node.js）
    原生宿主 ──Native Messaging（4 字节小端长度前缀帧）──▶ Chrome MV3 扩展
        扩展 ──CDP（硬件事件）/ 页内引擎──▶ 目标网页
```

**关键源码位置**：

- HTTP 服务器与认证：`app/native-server/src/server/index.ts`、`app/native-server/src/server/token.ts`
- MCP 会话与派发：`app/native-server/src/mcp/{mcp-server.ts, register-tools.ts, session-manager.ts}`
- Stdio 传输：`app/native-server/src/mcp/mcp-server-stdio.ts`

### 1.2 端点与协议

| 方法         | 路径        | 用途                                | 认证 |
| :----------- | :---------- | :---------------------------------- | :--- |
| **POST**     | `/mcp`      | 主通道：JSON-RPC（Streamable HTTP） | 必需 |
| **GET**      | `/mcp`      | SSE 事件流（服务器推送事件）        | 必需 |
| **DELETE**   | `/mcp`      | 会话终止与资源清理                  | 必需 |
| **GET**      | `/ping`     | 快速健康检查                        | 无   |
| **GET /sse** | `/sse`      | 旧版 SSE 传输流                     | 必需 |
| **POST**     | `/messages` | 旧版 SSE 消息接收端                 | 必需 |

### 1.3 认证

除 `/ping` 和 CORS 预检 `OPTIONS` 外，每个 HTTP 请求都需要通过以下三种等价请求头之一进行 Token 认证：

1. `Authorization: Bearer <token>`（推荐的标准方式）
2. `x-mcp-token: <token>`
3. 查询参数：`?token=<token>`

**Token 来源**：`~/.chrome-mcp/bridge-token`（Windows 上为 `%USERPROFILE%\.chrome-mcp\bridge-token`）。  
原生服务器是桥接 Token 的唯一初始化者（以独占 `wx` 创建保留有效的 48 位或 64 位十六进制 Token）。客户端从不生成 Token，也不支持环境变量覆盖。

### 1.4 会话握手流程

1. **`initialize`**：发送不带 `mcp-session-id` 请求头的 `POST /mcp`：
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2024-11-05",
       "capabilities": {},
       "clientInfo": { "name": "custom-agent", "version": "1.0" }
     }
   }
   ```
   服务器生成会话 UUID 并在响应头 `mcp-session-id` 中返回。
2. **`notifications/initialized`**：发送不带 `id` 字段的通知，携带 `mcp-session-id` 请求头。
3. **后续调用**：所有后续 `tools/list` 和 `tools/call` 请求都必须传入 `mcp-session-id` 请求头。
4. **生命周期**：空闲 10 分钟的会话会被自动垃圾回收。

### 1.5 最小 Node.js 客户端实现

```javascript
import fs from 'node:fs';
import os from 'node:os';

const BASE = 'http://127.0.0.1:12306/mcp';
const TOKEN = fs.readFileSync(`${os.userInfo().homedir}/.chrome-mcp/bridge-token`, 'utf8').trim();
let sessionId = null;

function parseSse(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {}
    }
  }
  return null;
}

async function rpc(method, params, isNotification = false) {
  const payload = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  if (!isNotification) {
    payload.id = Date.now();
  }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const rawText = (await res.text()).trim();
  if (!rawText) return null;
  const msg = parseSse(rawText) ?? JSON.parse(rawText);
  if (msg?.error) throw new Error(JSON.stringify(msg.error));
  return msg?.result;
}

// 1. 握手
await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'demo', version: '1.0' },
});
await rpc('notifications/initialized', undefined, true);

// 2. 执行规范工具
const windows = await rpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} });
console.log('Open tabs:', windows.content[0].text);

const dom = await rpc('tools/call', { name: 'chrome_read_dom', arguments: { viewportOnly: true } });
console.log('DOM snapshot:', dom.content[0].text);
```

---

## 2. 规范工具面（50 个 MCP 工具）

BrowserPaw 暴露 50 个规范 MCP 工具，组织为 8 个功能类别：

1. **自主微循环（1）**：`chrome_act_toward_goal`（本地快速决策循环）。
2. **导航与标签页（7）**：`chrome_navigate`、`chrome_switch_tab`、`chrome_close_tabs`、`chrome_move_tab`、`get_windows_and_tabs`、`chrome_attach_tab`、`chrome_detach_tab`。
3. **感知与内容（6）**：`chrome_read_dom`、`chrome_grep`、`chrome_get_markdown`、`chrome_inspect_media`、`chrome_get_dropdown_options`、`chrome_scroll_until_found`。
4. **交互与表单（13）**：`chrome_interact_index`、`chrome_fill_index`、`chrome_batch_actions`、`chrome_form_pipeline`、`chrome_smart_scroll`、`chrome_keyboard`、`chrome_upload_file`、`chrome_insert_media`、`chrome_undo_last_action`、`chrome_computer`、`chrome_handle_dialog`、`chrome_handle_download`、`chrome_dismiss_overlay`。
5. **观测与视觉（1）**：`chrome_screenshot`。
6. **数据与书签（9）**：`chrome_tab_group_create`、`chrome_tab_group_update`、`chrome_tab_group_list`、`chrome_tab_group_ungroup`、`chrome_tab_group_close`、`chrome_history`、`chrome_bookmark_search`、`chrome_bookmark_add`、`chrome_bookmark_delete`。
7. **诊断与脚本（4）**：`chrome_javascript`、`chrome_tool_docs`、`chrome_doctor`、`chrome_intercept_api`。
8. **网络与底层 CDP（9）**：`chrome_network_request`、`chrome_network_capture`、`chrome_cdp_execute`、`chrome_console`、`chrome_storage`、`chrome_request_human_intervention`、`performance_start_trace`、`performance_stop_trace`、`performance_analyze_insight`。

---

## 3. 高效模式

### 3.1 剪枝后的 1 起始 DOM 索引（`chrome_read_dom`）

- 提取紧凑的编号树（`[1]`、`[2]`、`[14]`），剔除装饰性包装和不可见元素。
- 直接把 `treeString` 返回给提示上下文，相比原始 HTML 削减 85%+ 的 Token 用量。
- 保留可访问性元数据：`role`、`aria-label`、`placeholder`、`disabled` 和 `href`。

### 3.2 动作增量搭车（`includeDelta: true`）

- 交互类工具（`chrome_interact_index`、`chrome_fill_index`、`chrome_batch_actions`）会自动对比动作前后的 DOM。
- 在动作响应中直接返回 `{ added: [...], modified: [...], removed: [...] }`，省去二次检查调用。

### 3.3 坐标标尺视觉定位

- 对于 canvas 应用、WebGL 或机器人混淆站点，调用 `chrome_screenshot({ grid: true })`。
- 直接从网格标尺读取 1:1 CSS 像素测量值，消除坐标漂移。
