# BrowserPaw 架构审查报告：Native-Server MCP/HTTP 层与 Native Messaging 层

**审查范围**：

- `app/native-server/src/index.ts`
- `app/native-server/src/cli.ts`
- `app/native-server/src/native-messaging-host.ts`
- `app/native-server/src/file-handler.ts`
- `app/native-server/src/media-asset-store.ts`
- `app/native-server/src/trace-analyzer.ts`
- `app/native-server/src/constant/index.ts`
- `app/native-server/src/mcp/` 全部 (`mcp-server.ts`, `mcp-server-stdio.ts`, `register-tools.ts`, `session-manager.ts`, `stdio-config.json`)
- `app/native-server/src/server/` 全部 (`index.ts`, `token.ts`)

**审查重点维度**：

1. 安全（Token生成/校验、Bridge Token、越权、注入、路径穿越、SSRF）
2. 并发与状态共享（Session 管理、多客户端同时连接）
3. 协议正确性（MCP initialize/tools-call 生命周期、Streamable HTTP/SSE 细节、Content-Length、JSON-RPC id 处理）
4. 错误恢复与超时
5. 资源清理（端口、定时器、连接）
6. Stdio 与 HTTP 双模式差异

---

## 一、核心问题详表

### [P0] 安全漏洞：`readMediaFile` 无目录沙箱限制导致宿主机任意文件读取

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\file-handler.ts:639-668`
- **严重度**：P0（安全漏洞）
- **问题描述**：`FileHandler.readMediaFile(filePath)` 直接接收外部传入的 `filePath` 参数，通过 `path.resolve(filePath)` 解析后未做任何目录沙箱约束（对比同文件的 `readBase64File` 和 `cleanupFile` 均强制检查是否位于 `tempDir` 沙箱内部），直接读取文件并转换为 Base64 或写入流式存储。若浏览器扩展受到 XSS 侵害或恶意第三方程序连接 Native Host，可任意读取宿主机敏感文件（如 `~/.ssh/id_rsa`、Chrome 凭证数据库、系统配置）。
- **代码证据与触发推演**：
  ```ts
  // file-handler.ts:639
  async readMediaFile(filePath: string): Promise<any> {
    try {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Media file does not exist: ${filePath}`);
      }
      const stats = fs.statSync(resolvedPath);
      ...
      const buf = await fs.promises.readFile(resolvedPath);
      const base64 = buf.toString('base64');
  ```
  对比 `readBase64File`（行 716-724）：
  ```ts
  if (!normalizedPath.startsWith(normalizedTempDir + path.sep)) {
    return {
      success: false,
      error: 'Access denied: filePath must be strictly within the temp directory',
    };
  }
  ```
  触发路径：Chrome 扩展向 Native Host 发送 `{ action: 'readMediaFile', filePath: 'C:/Users/User/.ssh/id_rsa' }`，`native-messaging-host.ts:153` 直接将其交由 `handleFileRequest` 处理，无沙箱拦截，宿主机机密文件内容被直接打包回传。
- **一句话净收益**：对 `readMediaFile` 强制实施严格的目录沙箱或允许目录白名单校验，彻底阻断宿主机敏感数据越权外泄。

---

### [P0] 确定性 Bug / 功能阻断：媒体流式端点未携带 Token 导致扩展端流式大图 100% 401 失败

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\index.ts:121-155, 285-303`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\mcp\register-tools.ts:63`
- **严重度**：P0（确定性 Bug / 功能完全损坏）
- **问题描述**：Fastify 的全局 `preHandler` 钩子对除 `/ping` 和 OPTIONS 以外的所有 HTTP 请求执行严格的 Bridge Token 鉴权。然而在处理大于 650KB 的大媒体文件时，`register-tools.ts` 和 `file-handler.ts` 生成的下载 URL 为 `http://127.0.0.1:12306/media-asset/${assetId}`（未附带任何 token 参数）；而 Chrome 扩展端 `insert-media.ts` 直接通过原生 `fetch(mediaUrl)` 拉取数据（未设置 Authorization 头）。这导致所有通过流式传输的大图/视频在请求时 100% 被 401 Unauthorized 拦截，大文件媒体插入功能完全无法使用。
- **代码证据与触发推演**：
  1. `server/index.ts:127-130`：
     ```ts
     const pathOnly = (request.raw.url || request.url || '').split('?')[0];
     if (pathOnly === '/ping') return;
     ...
     return reply.status(401).send({ error: 'Unauthorized...' });
     ```
  2. `register-tools.ts:63`：
     ```ts
     args.mediaUrl = `http://${SERVER_CONFIG.HOST}:${port}/media-asset/${assetId}`;
     ```
  3. 扩展端 `insert-media.ts:49`：
     ```ts
     const resp = await fetch(fetchTargetUrl);
     if (!resp.ok) {
       return createErrorResponse(
         `Failed to stream media asset from server (${resp.status}): ${nativeRes.mediaUrl}`,
       );
     }
     ```
  扩展发出的 GET 请求无 Token，返回 401，媒体插入任务必现中断。
- **一句话净收益**：在生成的 `mediaUrl` 中附带短期安全 Token（如 `?token=${oneTimeToken}`）或在路由鉴权白名单中放行具备不可预测 UUID 的 `/media-asset/:assetId`，修复大文件流式插入 100% 失败的严重缺陷。

---

### [P0] 协议致命错误：Native 消息长度异常时清空缓冲区导致后续通信帧永久错位

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\native-messaging-host.ts:63-71`
- **严重度**：P0（协议破坏与级联故障）
- **问题描述**：当 Native Messaging Host 解析到非法的 `expectedLength`（<=0 或 > 1MB）时，代码执行 `expectedLength = -1; buffer = Buffer.alloc(0); break;` 试图“重新同步”流。然而在二进制流协议中，异常帧的后续主体字节此时正持续到达管道，清空本地缓冲并不能跳过管道中在途的字节，后续字节会被错误解释为下一条消息的长度前缀，导致通信帧边界永久错位，Native Messaging 管道永久瘫痪。
- **代码证据与触发推演**：
  ```ts
  if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE_BYTES) {
    this.sendError(`Invalid message length: ${expectedLength} (exceeds Chrome 1MB limit)`);
    // Reset state to resynchronize stream
    expectedLength = -1;
    buffer = Buffer.alloc(0);
    break;
  }
  ```
  触发推演：若接收到一个损坏的头部（声明长度 2MB），代码清空了当前的 `buffer`。但 Chrome 写入管道的 2MB 数据块中的后续数据随后被 `stdin.read()` 读出。下一批字节的最初 4 字节（原本是 JSON 文本，如 `{"id"` 对应数值 0x6469227B = 1.68GB）再次被当作长度头解析，继续判定超限清空，自此 Native Host 永远无法读到任何有效消息。
- **一句话净收益**：二进制帧同步损坏时，必须主动触发优雅关闭并退出进程，促使 Chrome 自动重建干净的 Native Messaging 进程，避免管道静默报废。

---

### [P0] 并发状态损坏：DevTools `engine` 模块级单例并发解析 Trace 导致状态相互覆写

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\trace-analyzer.ts:18, 26-38`
- **严重度**：P0（并发状态竞争/报告损坏）
- **问题描述**：`trace-analyzer.ts` 内部定义了单例 `const engine = TraceEngine.TraceModel.Model.createWithAllHandlers()`。在 `parseTrace` 中，每次解析直接操作该单例：`engine.resetProcessor()`、`await engine.parse(events)`、`engine.parsedTrace()`。当有两个并发请求（如多个标签页或并发测试）同时请求分析 Trace 时，后发请求的 `resetProcessor()` 会清空前一请求正在解析的内部状态，导致前一请求报告空数据或抛出 `No parsed trace returned by engine` 异常。
- **代码证据与触发推演**：
  ```ts
  const engine = TraceEngine.TraceModel.Model.createWithAllHandlers();
  ...
  export async function parseTrace(json: any) {
    engine.resetProcessor();
    ...
    await engine.parse(events);
    const parsedTrace = engine.parsedTrace();
    ...
  }
  ```
  请求 A 开始解析并进入异步等待；请求 B 到达，执行 `engine.resetProcessor()` 重置底层状态机；请求 A 恢复执行并调用 `engine.parsedTrace()`，获取到的数据已被 B 破坏，造成严重数据竞态。
- **一句话净收益**：将 TraceEngine 改为按请求即时创建实例（或引入互斥排队锁），彻底杜绝 Trace 并发分析状态冲突。

---

### [P1] 资源泄漏：`mediaAssetStore` 存储条目永不删除导致内存无限增长

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\media-asset-store.ts:10`
- **严重度**：P1（内存泄漏）
- **问题描述**：`mediaAssetStore` 是一个全局单一的 `Map<string, MediaAssetEntry>`。在文件处理与媒体插入过程中不断向其中 `.set(assetId, ...)`，但全库没有一处代码调用 `.delete(assetId)`，也没有配置任何 TTL 超时淘汰机制。长期运行的 Native Server 处理多次文件传输后，该 Map 及其引用的文件路径/Buffer 将永久滞留内存。
- **代码证据与触发推演**：
  全局搜索 `mediaAssetStore`：仅在 `register-tools.ts:58`、`file-handler.ts:391` 写入，在 `server/index.ts:289` 读取。若有频繁自动化任务上传媒体，Map 规模单调递增，占用过多 V8 堆内存，最终引发 OOM。
- **一句话净收益**：在 HTTP 端点流式返回完成后立即删除条目，并配合 10 分钟滑动过期清理，防止内存泄漏。

---

### [P1] 协议健壮性：Streamable HTTP 初始化请求带 `mcp-session-id` 时直接返回 404

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\index.ts:366-385`
- **严重度**：P1（协议异常处理缺陷）
- **问题描述**：在 `POST /mcp` 路由中，初始化判断分支条件为 `if (!transport && !sessionId && isInit)`。当客户端因重试或代理透传了旧的（但本地已过期的）`mcp-session-id` 发起 `initialize` 请求时，由于 `sessionId` 存在，条件判定失败，代码直接落入 `else if (!transport)` 分支，向客户端返回 404 `INVALID_SESSION_ID`，阻止了合法的重初始化握手。
- **代码证据与触发推演**：
  ```ts
  const sessionId = request.headers['mcp-session-id'] as string | undefined;
  const session = sessionId ? mcpSessionManager.getSession(sessionId) : undefined;
  let transport: StreamableHTTPServerTransport | undefined = session?.transport as ...;

  const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);

  if (!transport && !sessionId && isInit) {
    // 正常新建 Session
  } else if (!transport) {
    const status = sessionId ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST;
    safeWriteError(reply, status, { error: message, hint });
    return;
  }
  ```
  客户端重连并发送 `initialize` 时携带了上一次会话 ID，由于内存中 session 已销毁，服务端返回 404，导致客户端重连失败，死锁在未初始化状态。
- **一句话净收益**：对包含 `isInitializeRequest` 的请求，忽略已失效的旧 sessionId 并无条件建立新 Session，保障客户端断线重连顺畅。

---

### [P1] 资源管理：GET `/mcp` (SSE Stream) 客户端断开连接不回收 Session

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\index.ts:424-427`
- **严重度**：P1（资源长期悬挂）
- **问题描述**：在 Streamable HTTP 的 GET 长连接断开时，`request.socket.on('close')` 仅记录日志，并没有调用 `mcpSessionManager.closeSession(sessionId)`。只有等待全局 10 分钟定时器扫描且超过 10 分钟空闲时才会回收，若有短连接批量接入，内存中将堆积大量孤儿 Server 实例。
- **代码证据与触发推演**：
  ```ts
  request.socket.on('close', () => {
    request.log.info(`SSE client disconnected for session: ${sessionId}`);
  });
  ```
  对比 `/sse` 端点在 close 时立即清理，此处缺失了 Session 状态的主动回收。
- **一句话净收益**：在长连接通道中断时主动触发会话生命周期评估，降低孤儿会话在内存中的滞留时间。

---

### [P1] 跨平台缺陷：Windows 平台 `startParentWatchdog` 依赖 `process.kill(pid, 0)` 面临 PID 复用致僵尸常驻

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\mcp\mcp-server-stdio.ts:241-253`
- **严重度**：P1（系统资源占用/僵尸进程）
- **问题描述**：Stdio 看门狗每 500ms 通过 `process.kill(parentPid, 0)` 探测父进程存活性。在 Windows 操作系统中，PID 极易快速循环重用。父进程（如 Claude Desktop 或某终端）异常退出后，其 PID 极可能在极短时间内被操作系统重新赋予其他系统进程（如 svchost.exe），导致 `process.kill` 永远不抛出 `ESRCH`，使得 Stdio 子进程永久驻留后台不退出。
- **代码证据与触发推演**：
  ```ts
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        triggerCleanExit(0);
      }
    }
  }, 500);
  ```
  Windows 平台的 PID 重用机制使得仅凭 PID 数字检查父进程存活极不可靠。
- **一句话净收益**：在 Windows 上通过 Node.js 父进程输入流退出兜底或结合 Windows Job Object，避免孤儿进程永久残留。

---

### [P1] 状态一致性：`clearBridgeTokenCache()` 未清理环境变量致 Token 无法重置

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\token.ts:25-28, 60-64`
- **严重度**：P1（缓存状态不一致）
- **问题描述**：`clearBridgeTokenCache()` 仅置空了 `cachedToken = null`，但在首次加载时代码已把 token 写入 `process.env.CHROME_MCP_TOKEN`。再次调用 `resolveBridgeToken()` 时，由于第一步优先读取该环境变量，旧 token 立即被重新装载回内存，使得清理缓存操作实质失效。
- **代码证据与触发推演**：
  ```ts
  export function resolveBridgeToken(): string {
    if (cachedToken) return cachedToken;
    if (process.env.CHROME_MCP_TOKEN && process.env.CHROME_MCP_TOKEN.trim().length > 0) {
      cachedToken = process.env.CHROME_MCP_TOKEN.trim();
      return cachedToken;
    }
  ...
  export function clearBridgeTokenCache(): void {
    cachedToken = null; // process.env.CHROME_MCP_TOKEN 依然存在！
  }
  ```
- **一句话净收益**：在清空缓存时同步删除 `process.env.CHROME_MCP_TOKEN`，保障鉴权令牌重载一致性。

---

### [P1] 架构硬伤：Native Host 超时后未向扩展端发送取消信号致浏览器资源浪费

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\native-messaging-host.ts:254-265`
- **严重度**：P1（架构设计缺陷）
- **问题描述**：当 `sendRequestToExtensionAndWait` 发生 120 秒超时后，本地 Promise 被 reject，从 `pendingRequests` 中剔除了该请求。但 Native Host 从未向 Chrome 扩展端发出任何取消命令（Abort）。扩展端仍在浏览器后台继续执行高开销的 CDP 操作（如全页面重排截屏、长轮询等待等），产生僵尸操作并阻塞后续请求队列。
- **代码证据与触发推演**：
  超时触发逻辑中仅有本地 `this.pendingRequests.delete(requestId); reject(...)`。扩展端执行完毕后回传消息时，由于 requestId 已被移除，在 `native-messaging-host.ts:133` 命中 `// just ignore`，不仅白白消耗了浏览器端性能，而且可能因后台残留动作与后续新工具调用发生冲突。
- **一句话净收益**：引入取消协议并在超时触发时向扩展发送中断指令，释放浏览器端无谓的计算开销。

---

### [P1] 双模式差异：Stdio 代理重连后导致 HTTP 端动态激活工具状态丢失

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\mcp\mcp-server-stdio.ts:40, 195-212`
- **严重度**：P1（双模式状态一致性）
- **问题描述**：Stdio 模式下，动态工具通过 `dynamicExtraTools = new Set<string>()` 维护在本地内存中。当网络出现异常触发自动重连时，`mcpClient` 重新与 HTTP 服务端协商建立全新的 HTTP Session。然而 Stdio 代理并没有将之前已激活的工具分类同步给新的 HTTP Session，导致后续请求若需要 HTTP 校验 Session 权限时可能出现不一致或功能受阻。
- **一句话净收益**：在 Stdio 重连建立新 Session 后，主动同步补发当前已激活的分类列表，保持双端状态闭环。

---

### [P2] 状态维护错误：`native-messaging-host.ts` 访问不存在的 `Server.port` 属性

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\native-messaging-host.ts:159`
- **严重度**：P2（状态维护不一致）
- **问题描述**：在处理 `get_server_info` 与 `get_token` 消息时，代码尝试读取 `(this.associatedServer as any)?.port || 12306`。但 `Server` 类（`server/index.ts`）中根本没有定义 `port` 属性或 getter，导致无论服务实际在哪个端口启动，返回给扩展的信息中端口号永远退化为硬编码的 12306。
- **代码证据与触发推演**：
  查看 `Server` 类定义，无 `port` 成员。若用户通过环境变量配置了自定义端口（如 12308），扩展获取到的端口依然显示 12306，产生配置脱节。
- **一句话净收益**：在 `Server` 类显式维护实际绑定的端口属性，保证扩展端读取信息准确。

---

### [P2] 协议错误处理：未捕获异常响应中错误类型被硬编码为 `file_operation_response`

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\native-messaging-host.ts:84-88`
- **严重度**：P2（协议语义混乱）
- **问题描述**：在处理 Native 消息的全局 catch 块中，当捕获到异常且消息中携带 `requestId` 时，响应消息被写死为 `type: 'file_operation_response'`。如果异常发生于非文件操作请求（例如启动命令、系统设置等），扩展端会收到一个伪造的文件操作响应，破坏扩展端的消息路由协议。
- **一句话净收益**：基于原消息类型动态生成响应类型，消除跨模块协议混淆。

---

### [P2] 安全审计：Fastify 全局开放 Query 参数传递 Token

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\index.ts:145-147`
- **严重度**：P2（安全规范缺陷）
- **问题描述**：Fastify 全局认证钩子对所有路由（包括敏感的 `POST /mcp`, `GET /agent-control`, `POST /reload-extension`）无差别支持通过 `?token=...` 认证。Query 参数极易被浏览器历史、服务器日志记录外泄。
- **一句话净收益**：将 Query Token 限制仅在标准 EventSource 必要的 `/sse` 路由生效，其余端点强制要求 Headers 传递。

---

### [P2] 协议冗余：SSE `/sse` 端点挂载三重 close 监听器

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\index.ts:323-329`
- **严重度**：P2（代码冗余与重复清理）
- **问题描述**：在 `/sse` 路由中，在 `mcpSessionManager.createSession` 内部已经通过 `transport.onclose` 挂载了清理逻辑，外部又同时对 `reply.raw.on('close')` 和 `req.raw.on('close')` 绑定了清理回调，造成同一个底层 socket 关闭时触发多达 3 次销毁逻辑。
- **一句话净收益**：清理冗余监听器，统一由 Transport 自身生命周期驱动销毁。

---

### [P2] 协议功能缺失：Stdio 模式未中继 MCP Notifications 与进度事件

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\mcp\mcp-server-stdio.ts:68-105`
- **严重度**：P2（功能完整性）
- **问题描述**：Stdio 代理端仅实现了对工具请求与列表的单向转发，未挂载从底层 HTTP 服务传回的 MCP notifications（如 `notifications/progress`、`notifications/message`）。导致后台 Jev 决策微循环或长任务向客户端推送的实时进度被静默丢弃，Claude Desktop 端体验退化为长时间无响应等待。
- **一句话净收益**：打通 Stdio 代理层的 Notifications 双向转发，实现客户端可见的实时长任务进度。

---

### [P3] 超时常量分散且存在硬编码

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\constant\index.ts:16-20`，`app\native-server\src\mcp\register-tools.ts:228`，`app\native-server\src\mcp\mcp-server-stdio.ts:173`
- **严重度**：P3（代码规范与维护性）
- **问题描述**：`TIMEOUTS.DEFAULT_REQUEST_TIMEOUT` 定义为 15000ms，但工具调用在 `register-tools.ts` 中硬编码为 120000ms，在 `mcp-server-stdio.ts` 中硬编码为 `2 * 60 * 1000`。常量分散在多处未统一从 `constant` 模块引用。
- **一句话净收益**：将 120s 工具超时统一收敛至 `constant`，提高配置的可维护性。

---

## 二、死代码 / 重复实现 / 过度设计

1. **未使用的全局单例死代码**
   - **位置**：`app/native-server/src/mcp/mcp-server.ts:24-29`
   - **代码**：
     ```ts
     export let mcpServer: Server | null = null;
     export const getMcpServer = () => { ... };
     ```
   - **分析**：全库搜索除自身导出外，没有任何模块调用 `getMcpServer` 或 `mcpServer`。系统目前完全采用 `createMcpServerInstance(sessionId)` 进行基于会话的动态隔离实例化。该模块级单例为历史遗留的死代码。

2. **过度设计与脆弱设计：`update-port` CLI 命令物理修改包内 JSON**
   - **位置**：`app/native-server/src/cli.ts:143-167`
   - **分析**：`update-port` 命令通过直接读取并覆写安装目录下的 `mcp/stdio-config.json` 来修改配置端口。在只读环境（如 Linux 全局 `/usr/local/lib` 安装或受限用户目录）下执行必抛 `EACCES`。端口配置完全可以通过标准环境变量（如 `CHROME_MCP_PORT`）或命令行参数传递，物理修改包内文件的设计属于反模式过度设计。

3. **枚举重复定义与命名冲突**
   - **位置**：`app/native-server/src/constant/index.ts:1-9`
   - **分析**：本地定义了全大写的 `NATIVE_MESSAGE_TYPE` 枚举，而跨模块交互大量使用从 `chrome-mcp-shared` 导出的 `NativeMessageType`。两套枚举同时存在，字段部分重合但命名风格不同，增大了开发维护的心智负担。

4. **无意义的默认参数死代码**
   - **位置**：`app/native-server/src/mcp/session-manager.ts:32, 110`
   - **分析**：`cleanupStaleSessions(maxIdleMs: number = 300_000)` 声明了 5 分钟的默认超时，但在构造函数的 `setInterval` 中硬编码传入了 `10 * 60 * 1000`（10分钟），使得其默认参数永远无法触发。

---

## 三、性能观察（量化分析）

1. **消息发送双重序列化开销**：
   - **位置**：`app/native-server/src/native-messaging-host.ts:228-245` 与 `324-325`
   - **分析**：在 `sendRequestToExtensionAndWait` 中，为了进行 1MB 物理上限预检，先执行了一次 `JSON.stringify` 并计算 `Buffer.byteLength`；紧接着调用 `this.sendMessage`，又对完全相同的对象执行了第二次 `JSON.stringify` 和 `Buffer.from`。对于频繁传输的大型 DOM 快照（如 500KB），每秒产生 1MB 额外的重复 V8 序列化开销与垃圾回收压力。

2. **`stdin.on('readable')` 累积内存拷贝 (O(N²) 模式)**：
   - **位置**：`app/native-server/src/native-messaging-host.ts:100-104`
   - **分析**：`buffer = Buffer.concat([buffer, chunk])` 在持续接收分片流时，每次读入 chunk 都会重新申请内存并搬运历史全部字节。若一个 1MB 的大消息被分为 16 个 64KB 的 chunk 传入，总共会发生约 8.5MB 的内存分配和搬运。建议改用定长 Buffer 预分配或 Chunk 队列遍历，消除内存拷贝二次放大。

3. **双层反向代理调用链与往返延迟**：
   - **路径**：`MCP 客户端 (Stdio) -> Stdio 代理进程 (mcp-server-stdio.ts) -> 本地 HTTP 服务 (Fastify 12306) -> Native Messaging Host -> Chrome Extension -> CDP Target`
   - **分析**：每次工具调用经历 4 层进程间通信（IPC）与 2 次 HTTP 握手。单次工具调用基线 IPC 开销在 10~~25ms，若能在支持 Stdio 的场景下减少一层代理或支持本地直连，可进一步削减 5~~10ms 网络开销。

---

## 四、模块依赖与被依赖关系清单

### 1. 本模块内部层次依赖关系

```
cli.ts / index.ts
  └── native-messaging-host.ts
        ├── server/index.ts (Fastify HTTP/SSE 服务)
        │     ├── server/token.ts (Bridge Token 鉴权)
        │     ├── mcp/session-manager.ts (MCP 会话生命周期)
        │     │     └── mcp/mcp-server.ts -> mcp/register-tools.ts
        │     └── media-asset-store.ts (流式媒体存储)
        └── file-handler.ts (本地文件操作与沙箱)
              ├── trace-analyzer.ts (DevTools Trace 分析)
              └── media-asset-store.ts
```

### 2. 外部直接依赖（上游）

- `@modelcontextprotocol/sdk` (`^1.30.0`): 提供 MCP 核心 Server、Client、Transport 与 JSON-RPC 协议解析。
- `fastify` (`^4.x` / `^5.x`) + `@fastify/cors`: 提供高性能本地 HTTP 桥接与严格 Origin 校验。
- `chrome-devtools-frontend`: 提供 Chrome 原生 Performance Trace 分析模型。
- `chrome-mcp-shared`: 提供共享工具 Schema、动态 Profile 过滤规则、错误格式化器。
- `commander`: 提供 CLI 命令解析。
- `node-fetch`: 提供安全受限的 HTTP 文件下载。

### 3. 被依赖模块（下游消费方）

- **`app/chrome-extension`**：通过 Chrome 原生 `chrome.runtime.connectNative` 建立全双工管道通信，并消费 `http://127.0.0.1:12306/media-asset/:assetId`。
- **Claude Desktop / Cursor / 外部 Agent**：通过 `mcp-server-stdio.ts` 包装器执行标准 Stdio MCP 通信，或直接连接 HTTP `/mcp` 端点。
- **`app/native-server/src/scripts`**：`register.ts`、`doctor.ts` 与 `report.ts` 依赖该模块的部署文件、端口配置与自检状态。
