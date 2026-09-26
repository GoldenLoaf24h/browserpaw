# BrowserPaw 工具契约报告 (2026-09)

> 基于工作区源码实时审计 (`packages/shared/src/`, `app/chrome-extension/entrypoints/background/tools/index.ts`, `app/native-server/src/mcp/register-tools.ts`)。当前全量注册工具共 **49 个** (48 个 Extension 工具 + 1 个 Native Server 微循环工具)。

---

## 1. 工具 Profile 档位与激活机制

共享契约见 [tool-profiles.ts:25-77](/packages/shared/src/tool-profiles.ts:25)。服务默认按 `core` 档位暴露，节省约 4.1k tokens/session；运行时支持动态解锁。

- **`core` 档位 (14 个)**：核心浏览、感知、交互与工具元感知。
  - 导航 (4): `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `get_windows_and_tabs`
  - 感知 (4): `chrome_read_dom`, `chrome_get_markdown`, `chrome_inspect_media`, `chrome_grep`
  - 执行 (3): `chrome_interact_index`, `chrome_fill_index`, `chrome_batch_actions`
  - 观察 (2): `chrome_screenshot`, `chrome_smart_scroll`
  - 元感知 (1): `chrome_tool_docs` (用于发现并解锁隐藏工具)
- **`crawl` 档位 (12 个)**：批量爬取与结构化提取，包含 `chrome_javascript`, `chrome_storage`, `chrome_cdp_execute`, `chrome_network_request` 及 core 部分感知工具。
- **`full` 档位 (49 个)**：暴露所有工具。
- **自动解锁机制** ([register-tools.ts:140-160](/app/native-server/src/mcp/register-tools.ts:140))：调用未暴露工具不会报错不存在，服务端按分类自动解锁对应分组；也可调用 `chrome_tool_docs(category, activateForSession: true)` 手动解锁。

---

## 2. 本轮迭代变动与替代映射 (对照 git)

| 变动类型     | 工具名称 / 参数                                   | 对应文件 / 行号                                     | 替代工具 / 覆盖方案                                                                                                                |
| :----------- | :------------------------------------------------ | :-------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **已删除**   | `chrome_fill_form`                                | [tools.ts 历史](/packages/shared/src/tools.ts)      | 替代为 **`chrome_batch_actions`** (内含 `type: 'fill_form'` 或多个 `fill`)；复杂向导使用 **`chrome_form_pipeline`**                |
| **已删除**   | `chrome_scroll`                                   | [tools.ts 历史](/packages/shared/src/tools.ts)      | 替代为 **`chrome_smart_scroll`** (智能容器滚动) 或 `chrome_batch_actions` 内 `type: 'scroll'`                                      |
| **已删除**   | `chrome_scroll_to_text`                           | [tools.ts 历史](/packages/shared/src/tools.ts)      | 替代为 **`chrome_grep`** 定位元素 index/ref，再配合 `chrome_smart_scroll` 或 `chrome_interact_index(action: 'hover')` 自动滚入视口 |
| **已删除**   | `chrome_network_capture_start/stop` 等 4 个旧工具 | [tools.ts 历史](/packages/shared/src/tools.ts)      | 收敛合并为单一入口 **`chrome_network_capture`** (通过 `action: 'start'                                                             | 'stop'`, `needResponseBody` 控制)       |
| **新增工具** | `chrome_dismiss_overlay`                          | [tools.ts:3178](/packages/shared/src/tools.ts:3178) | 1 步快速关闭营销浮层、优惠券弹窗与 Cookie 横幅，省去倾倒 DOM 与盲点成本                                                            |
| **新增参数** | `chrome_navigate.action`                          | [tools.ts:169](/packages/shared/src/tools.ts:169)   | 支持 `'back'                                                                                                                       | 'forward'`，直接执行浏览器历史后退/前进 |
| **新增参数** | `chrome_navigate.dismissOverlays`                 | [tools.ts:213](/packages/shared/src/tools.ts:213)   | 导航完成后自动检测并关闭营销弹窗                                                                                                   |
| **新增参数** | `chrome_read_dom.format`                          | [tools.ts:1022](/packages/shared/src/tools.ts:1022) | 扩展支持 `'fast'` (及 `fast: true`)，零 DOM-dump 极速感知                                                                          |
| **新增参数** | `chrome_read_dom.virtualizeViewport`              | [tools.ts:1049](/packages/shared/src/tools.ts:1049) | 将视口外大量重复列表项折叠为虚拟化集群摘要                                                                                         |
| **新增参数** | `chrome_read_dom.flattenCards`                    | [tools.ts:1056](/packages/shared/src/tools.ts:1056) | 将复合卡片节点拍平成单行结构化语义摘要                                                                                             |
| **新增参数** | `chrome_interact_index.pierceOverlay`             | [tools.ts:1200](/packages/shared/src/tools.ts:1200) | 允许点击事件自动穿透半透明浮层与遮罩层                                                                                             |
| **新增参数** | `chrome_interact_index.captureNetwork`            | [tools.ts:1218](/packages/shared/src/tools.ts:1218) | 点击同时内联捕获 API 响应，零 RTT 抓包                                                                                             |

---

## 3. 全量 MCP 工具契约清单 (49 个)

### 3.1 核心操作与感知 (Core Profiles)

| 工具名称                    | 档位 | 一句话职责                            | 关键参数                                                                                         | Skill 必要避坑与契约信息                                                                                              |
| :-------------------------- | :--: | :------------------------------------ | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **`chrome_read_dom`**       | core | 提取视口裁剪与遮挡剪枝的交互式 DOM 树 | `selector`, `fast`, `format`, `exclude`, `dismissOverlays`, `virtualizeViewport`, `flattenCards` | 1-based index 每次滚动后失效；优先使用 `selector` 局部提取，禁止无节制 dump 全页；大列表开启 `virtualizeViewport`。   |
| **`chrome_interact_index`** | core | 通过 1-based 序号点击、悬浮、拖拽元素 | `index` (必填), `action`, `pierceOverlay`, `waitForNetworkQuiescence`, `captureNetwork`          | 连续操作严禁单步调用（消耗 RTT）；遇半透明遮罩加 `pierceOverlay: true`；需捕获接口时直接配 `captureNetwork`。         |
| **`chrome_fill_index`**     | core | 向指定序号输入框填充文本              | `index` (必填), `text` / `value`, `clear`, `pressEnter`, `submit`                                | 搜索框直接带 `pressEnter: true`，1 步完成提交；连续表单项切勿逐个调用，改用 `chrome_batch_actions`。                  |
| **`chrome_batch_actions`**  | core | 单 RTT 顺序执行多步操作流水线         | `actions` (必填), `includeDelta`, `waitForSettle`, `waitForNetworkQuiescence`                    | **执行效率第一工具**。支持 click/fill/hover/scroll/wait/assert/extract；设置 `includeDelta: true` 自动回传 DOM 增量。 |
| **`chrome_navigate`**       | core | 页面跳转、刷新、前进后退              | `url`, `action` ('back'                                                                          | 'forward'), `refresh`, `newWindow`, `dismissOverlays`                                                                 | 历史回退直接传 `action: 'back'`，勿注入 JS；新开任务页推荐传 `autoGroup: true` 防止标签页污染。 |
| **`chrome_get_markdown`**   | core | 提取清洗后的分层正文 Markdown         | `includeLinks`, `fit`                                                                            | 纯读文章/文档首选；自动过滤脚本与隐藏节点，比 read_dom 更省 token。                                                   |
| **`chrome_grep`**           | core | 免 dump DOM 的全页关键词快速检索      | `query` (必填), `searchType` ('interactive'                                                      | 'all'                                                                                                                 | 'text_lines'), `limit`                                                                          | 查找特定按钮或文本首选；返回元素 index 可直接喂给 interact_index，无需 read_dom。 |
| **`chrome_inspect_media`**  | core | 提取图片/Canvas 媒体或验证码裁剪      | `index`, `selector`, `zoom`                                                                      | 纯内存无损提取；验证码/复杂容器会自动走 200%+ 超分辨率局部截图。                                                      |
| **`chrome_smart_scroll`**   | core | 智能识别并滚动页面或指定容器          | `direction`, `amount`, `selector`, `ref`, `index`, `coordinate`                                  | 自动处理内滚 div，无需盲猜 window 滚动；返回 pages_up/down 进度。                                                     |
| **`chrome_screenshot`**     | core | 截取视口、元素或全页 (纯内存 Base64)  | `selector`, `index`, `fullPage`, `som`, `grid`, `savePng`                                        | **严禁频繁截图**；默认内存传输，`savePng` 仅限本地调试落盘至临时目录。                                                |
| **`chrome_switch_tab`**     | core | 切换活动标签页                        | `tabId` (必填), `windowId`, `background`                                                         | 配合 `get_windows_and_tabs` 使用；后台切换传 `background: true`。                                                     |
| **`chrome_close_tabs`**     | core | 关闭一个或多个标签页                  | `tabId`, `tabIds`, `confirm`                                                                     | 批量关闭多标签页时必须设置 `confirm: true`。                                                                          |
| **`get_windows_and_tabs`**  | core | 获取所有打开的窗口与标签页清单        | 无必需参数                                                                                       | 任务开始前首选，获取已有目标 tabId 避免重复创建标签。                                                                 |
| **`chrome_tool_docs`**      | core | 动态查询并激活各分类工具 Schema       | `category` (必填), `activateForSession`                                                          | 缺工具时调用，传 `activateForSession: true` 可立刻在当前 session 解锁该类别。                                         |

### 3.2 进阶执行与自动化 (Act & Diagnose - Full Profile)

| 工具名称                                | 档位  | 一句话职责                               | 关键参数                                           | Skill 必要避坑与契约信息                                                         |
| :-------------------------------------- | :---: | :--------------------------------------- | :------------------------------------------------- | :------------------------------------------------------------------------------- |
| **`chrome_dismiss_overlay`**            | full  | 1 步关闭可见的营销弹窗与遮罩             | `maxOverlays`, `waitForSettle`                     | 页面被遮挡交互失败时立即调用，支持自动点击 × / 跳过或派发 Escape。               |
| **`chrome_form_pipeline`**              | full  | 本地循环自主推进多步/向导表单            | `fields` (必填), `maxSteps`, `autoAdvance`         | 自动语义匹配字段并按 Enter/Next 推进；遇验证码或阻塞时自动挂起中断。             |
| **`chrome_act_toward_goal`**            | full  | 本地双脑微循环 (Jev/启发式驱动)          | `goal` (必填), `maxSteps`, `confidenceThreshold`   | 极速本地决策循环 (200-400ms/步)；高风险或歧义自动升级回宏观 Agent。              |
| **`chrome_insert_media`**               | full  | 本地文件伪造剪贴板/拖拽注入编辑器        | `filePath`, `fileUrl`, `base64Data`, `index`       | 富文本编辑器 (X/Discord/Notion) 首选；Native Server 自动按大小流式注入。         |
| **`chrome_upload_file`**                | full  | 标准 HTML `<input type='file'>` 上传     | `filePath`, `selector`, `index`                    | 必须作用于原生 file input；若为现代拖拽区请使用 `chrome_insert_media`。          |
| **`chrome_handle_dialog`**              | full  | 处理 JS 原生 alert/confirm/prompt        | `action` (必填: accept                             | dismiss), `promptText`                                                           | 必须独立调用处理弹窗；严禁全局自动 accept 导致破坏性确认漏检。                  |
| **`chrome_handle_download`**            | full  | 等待并获取浏览器下载文件信息             | `filenameContains`, `timeoutMs`, `waitForComplete` | 监听落盘文件名与状态，切勿盲目 sleep 等待。                                      |
| **`chrome_keyboard`**                   | full  | 发送底层原生键盘按键与快捷键组合         | `keys` (必填), `index`, `selector`                 | 支持 Enter/Tab/Escape 与 Ctrl+C/V；优先使用 fill_index，此工具用于特殊快捷键。   |
| **`chrome_undo_last_action`**           | full  | 回滚最近一次变动操作                     | `tabId`                                            | 支持表单输入撤销或误点链接后退。                                                 |
| **`chrome_request_human_intervention`** | full  | 请求人类协助处理 2FA/滑块验证码          | `reason` (必填), `timeoutMs`                       | 遇硬阻断时唤起毛玻璃引导条，人类完成后平滑接管，避免无休止死循环。               |
| **`chrome_computer`**                   | full  | 视觉坐标级底层键鼠控制 (Visual Fallback) | `action` (必填), `coordinates`, `coordinateSpace`  | DOM 无法索引时的最后退路；坐标支持标准化/绝对像素，需配合截图校准。              |
| **`chrome_cdp_execute`**                | full  | 直接执行原始底层 CDP 指令                | `method` (必填), `params`                          | 专家逃生舱；可直接调用 Page/DOM/Network 域指令。                                 |
| **`chrome_javascript`**                 | crawl | 标签页上下文执行 JS 代码                 | `code` (必填), `timeoutMs`                         | 内置 `mcp` 辅助对象 (`mcp.run`, `mcp.waitFor`, `mcp.click`)；遵循只读/安全红线。 |
| **`chrome_storage`**                    | crawl | 读取 LocalStorage/Cookies (含 HttpOnly)  | `types`, `filter`, `includeHttpOnly`               | 诊断登录态首选；可读取 JS 看不到的 HttpOnly Cookie。                             |
| **`chrome_intercept_api`**              | full  | 拦截抓取匹配 URL 的后端真实 JSON 数据    | `urlPattern` (必填), `triggerAction`               | 绕过复杂 DOM 提取，100% 获取结构化真值。                                         |
| **`chrome_network_capture`**            | full  | 统一网络请求流量录制分析                 | `action` (必填: start                              | stop), `needResponseBody`                                                        | `needResponseBody: true` 走 Debugger (有冲突风险)；默认走 webRequest 轻量捕获。 |
| **`chrome_network_request`**            | crawl | 借助浏览器环境与 Cookie 发起外发请求     | `url` (必填), `method`, `headers`, `body`          | 携带当前站点会话状态访问 API，避免 CORS 限制。                                   |
| **`chrome_console`**                    | full  | 捕获浏览器控制台 Console 日志            | `mode` ('snapshot'                                 | 'buffer'), `onlyErrors`                                                          | 排查前端报错首选；支持持久 buffer 模式零延迟读取。                              |
| **`chrome_doctor`**                     | full  | 环境就绪检查与连通性自检                 | `verbose`                                          | 排查 Native Host 连接、端口与权限异常。                                          |

### 3.3 标签页与性能管理 (Manage & Diagnose - Full Profile)

| 工具名称                          | 档位 | 一句话职责                       | 关键参数                            | Skill 必要避坑与契约信息                         |
| :-------------------------------- | :--: | :------------------------------- | :---------------------------------- | :----------------------------------------------- |
| **`chrome_attach_tab`**           | full | 显式挂载 CDP 调试器与会话粘性    | `tabId`, `sessionId`                | 会弹出 Chrome 调试黄条，非必要不主动调用主窗口。 |
| **`chrome_detach_tab`**           | full | 卸载 CDP 调试器并解除粘性        | `tabId`, `sessionId`                | 任务结束后清理黄条。                             |
| **`chrome_move_tab`**             | full | 调整标签页位置或移至新窗口       | `index` (必填), `tabId`, `windowId` | 整理工作区标签页。                               |
| **`chrome_tab_group_create`**     | full | 创建新标签页分组                 | `tabIds` (必填), `title`, `color`   | 归类自动化任务标签。                             |
| **`chrome_tab_group_update`**     | full | 修改标签组属性 (标题/颜色/折叠)  | `groupId` (必填), `title`, `color`  | 维护分组状态。                                   |
| **`chrome_tab_group_list`**       | full | 枚举当前所有标签组               | `windowId`, `title`                 | 查找已有分组。                                   |
| **`chrome_tab_group_ungroup`**    | full | 解散标签组移出标签页             | `tabIds` (必填)                     | 移出管理。                                       |
| **`chrome_tab_group_close`**      | full | 关闭整组标签页                   | `groupId` (必填)                    | 快速清理一整批任务标签。                         |
| **`chrome_get_dropdown_options`** | full | 获取下拉菜单/Combobox 所有候选项 | `index`, `selector`                 | 辅助 fill_index 选值。                           |
| **`chrome_history`**              | full | 检索历史记录                     | `text`, `startTime`, `maxResults`   | 快速定位曾访问过的 URL。                         |
| **`chrome_bookmark_search`**      | full | 检索书签                         | `query`, `folderPath`               | 查找收藏夹地址。                                 |
| **`chrome_bookmark_add`**         | full | 添加新书签                       | `url`, `title`, `parentId`          | 保存关键页面。                                   |
| **`chrome_bookmark_delete`**      | full | 删除书签                         | `bookmarkId` (必填)                 | 清理无效书签。                                   |
| **`performance_start_trace`**     | full | 开启 DevTools 性能录制           | `reload`, `autoStop`, `durationMs`  | 录制页面耗时与渲染瓶颈。                         |
| **`performance_stop_trace`**      | full | 停止性能录制并导出               | `saveToDownloads`, `filenamePrefix` | 保存 trace 文件。                                |
| **`performance_analyze_insight`** | full | 分析上一轮 Trace 性能摘要        | `insightName`, `timeoutMs`          | 输出轻量性能与 CWV 指标。                        |

---

## 4. 核心避坑契约与 Agent 行为守则

1. **绝对优先批处理**：只要后续 2 步及以上动作可预测（如输入框+搜索键，或账号+密码+登录），**必须**使用 `chrome_batch_actions`，禁止往返拆解为多次单步交互。
2. **DOM 索引时效性**：`chrome_read_dom` 分配的 1-based index 仅在当前视口且未发生 DOM 突变/滚动时有效。滚动或刷新后必须重新感知。
3. **零磁盘开销红线**：`chrome_screenshot` 默认直出 Base64 内存数据。切勿在自动化链路中强制开启 `savePng` 刷写用户磁盘。
4. **单轮版本提示约定** ([register-tools.ts:250-272](/app/native-server/src/mcp/register-tools.ts:250))：若检测到新版本，系统仅在 Agent 会话的**首个**工具返回首部挂载一次系统升级提示，后续调用严格静默，Agent 无需反复向用户复述。
