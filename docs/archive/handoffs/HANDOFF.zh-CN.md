# BrowserClaw (原 MCP-Chrome) 终极交接文档 (HANDOFF)

> **更新时间**：2026-09-07 15:15  
> **状态里程碑**：**全域通关达成（12/12 Protocols Sealed, 79/79 Assertions 100% Pass）**  
> **文档定位**：供接棒 AI Agent / 工程师零门槛接手项目。严格遵循“零作弊、纯粹遵循 browser-use 交互逻辑”红线。

---

## 1. 核心红线与执行准则（最高优先级 ⚠️）

### 1.1 绝对禁止行为（已全量通过严苛验证）

- ❌ **严禁使用 `chrome_javascript` 抄近道/开外挂**：
  - **严禁偷读内存/存储**：严禁脚本注入读取 `localStorage` 偷取 Token、OTP、CSRF 密钥；
  - **严禁绕过真实输入**：严禁在页面上下文通过 `nativeSetter.call(input, val)`、`input.dispatchEvent`、`element.click()` 强行篡改 React 18/19 原型链。
- ✅ **100% 纯粹的 browser-use 原生交互范式**：
  - **感知**：通过 `chrome_read_dom` 获取 1-based 紧凑数字索引树，或通过 `chrome_screenshot` 视觉标尺；
  - **操作**：通过 `chrome_interact_index`（CDP 原生物理点击/双击/右键/悬停/拖拽）、`chrome_fill_index`（CDP 原生物理输入）、`chrome_batch_actions`（批量流水线）、`chrome_smart_scroll`（物理滚轮与智能滚动）；
  - **底线**：遇到任何卡点，必须在扩展源码库（`app/chrome-extension/entrypoints/background/tools/browser/`）中强化底层，绝不在测试脚本或页面中开后门。

---

## 2. 项目目录与当前资产清单

### 2.1 关键路径

- **主工程根目录**：`D:\workspace\mcp-chrome-master\mcp-chrome-master`
- **纯净独立扩展目录（可直接在 Chrome 开发者模式中加载）**：
  👉 [`D:\workspace\browserclaw`](file:///D:/workspace/browserclaw)
- **实战测试靶场工程**：
  👉 [`test\complex-html-testing`](file:///D:/workspace/mcp-chrome-master/mcp-chrome-master/test/complex-html-testing)
  - 静态服务端口：`http://127.0.0.1:4173`（入口：`node test/complex-html-testing/serve.mjs`）
- **Native Bridge 认证 Token**：
  - `C:\Users\Lenovo\.chrome-mcp\bridge-token`
- **MCP 调用客户端**：
  - `test/mcp-client.mjs`：支持 `node test/mcp-client.mjs <tool> '<args>'` 或 `import { mcpCall } from './mcp-client.mjs'`

---

## 3. 本次任务重大进展与已达成战果

### 3.1 靶场 12 大协议满分通关战报 (79/79 断言全部通过)

| 协议                    | 断言数 | 通关状态 | 核心攻坚与物理实现手段                                                                                                                                                                                                                     |
| :---------------------- | :----: | :------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P01 CLICK VECTOR**    |  8/8   | **PASS** | 物理悬停链击穿 0ms `:hover` 闭合、右键上下文原语、微像素移动靶捕捉                                                                                                                                                                         |
| **P02 SHADOW REALM**    |  7/7   | **PASS** | 自动穿透 Open/Closed Shadow DOM、嵌套子 frame 树合成与多层 iframe 点击                                                                                                                                                                     |
| **P03 FORM HYDRA**      | 10/10  | **PASS** | React 18 受控组件真机输入、悬停揭示 30s 动态 TOTP、条款滚动激活复选框、Canvas 连续轨迹真实涂抹、HTML5 芯片拖放入坞                                                                                                                         |
| **P04 TEMPORAL GATE**   |  6/6   | **PASS** | 5s 解锁倒计时等待、Toast 瞬态窗口物理拦截、原生 Alert→Confirm→Prompt 对话框链拦截                                                                                                                                                          |
| **P05 SCROLL ABYSS**    |  6/6   | **PASS** | 嵌套滚动容器局部寻址、粘性遮挡物理滚开、无限列表增量加载至 #048、哨兵 1.5s 驻留懒加载触发                                                                                                                                                  |
| **P06 KEYBIND MATRIX**  |  6/6   | **PASS** | CDP 修饰键组合 `Ctrl+K` 呼出命令面板、焦点键盘方向键移动、真实跨字段复制粘贴、中文核验输入                                                                                                                                                 |
| **P07 DRAG VECTOR**     |  6/6   | **PASS** | HTML5 拖拽排序（A→Z 两次调序）、Pointer 拖拽方块入靶、滑块精准物理定位至 50、面板手柄伸缩至 339px                                                                                                                                          |
| **P08 DIALOG STACK**    |  5/5   | **PASS** | 高 z-index 隐私墙过滤诱饵、Portal 模态栈逐层深入、焦点陷阱 Tab 循环提交、精确短语锁                                                                                                                                                        |
| **P09 PERCEPTION TRAP** |  7/7   | **PASS** | 视觉载具过滤（汽车/SUV）、0.02 幽灵按钮命中、伪元素诱饵规避、高频振荡 Canvas 脉冲序列命中、SVG path 坐标命中、LED 颜色采样                                                                                                                 |
| **P10 PERSISTENCE**     |  5/5   | **PASS** | 历史栈后退/前进驱动、检查点状态固化、真实浏览器刷新（F5）与会话状态复原                                                                                                                                                                    |
| **P11 DATA GRID**       |  5/5   | **PASS** | 200 行虚拟列表过滤、双击单元格内联编辑、自绘右键上下文菜单 Flag、表头排序与第一行命中                                                                                                                                                      |
| **P12 OMEGA SEQUENCE**  |  8/8   | **PASS** | 综合全链路终局协议：隐私墙拆除 $\rightarrow$ TOTP 悬停提交 $\rightarrow$ Closed Root 穿刺 $\rightarrow$ 100% 滑块 $\rightarrow$ 系统 Prompt $\rightarrow$ 动态 Canvas 脉冲 3 击 $\rightarrow$ 下拉选择 $\rightarrow$ `Ctrl+Enter` 终极封存 |

---

## 4. 浏览器控制插件的架构创新与底层强化

在通关过程中，针对发现的底层卡点对扩展代码进行了精准手术式强化：

1. **坐标滚动的局部滚动容器自动溯源 (`smart-scroll.ts`)**：
   - **问题**：原先滚动工具传入 `coordinate: { x, y }` 且 CDP 滚轮在后台/未聚焦窗口未响应时，机械回退到 `window.scrollBy`，导致带 `overflow: auto/scroll` 的局部容器（如内层列表、粘性遮挡区）完全无法滚动。
   - **创新**：注入了基于 `document.elementFromPoint(x, y)` 的向上回溯机制与 `chrome_smart_scroll`，自动找到具滚动余量的最近滚动容器并派发 `scrollBy`，彻底解决局部滚动盲区。
2. **CDP 会话管理与测试环境隔离 (`cdp-session-manager.ts`)**：
   - 修复了 `enablePageDomain` 在单元测试环境中意外消耗 Mock 计数器的问题，并前置断开/目标关闭时的异常拦截，杜绝死循环重试。
3. **DOM 索引环境安全性 (`dom-indexer.ts`)**：
   - 在计算元素坐标与值时，对 `HTMLInputElement` 全局对象进行类型安全防护，避免在 Node.js 测试无 DOM 环境下抛出 `ReferenceError`。
4. **高频运动目标的脉冲点击序列 (`chrome_interact_index points`)**：
   - 针对 `requestAnimationFrame` 高频连续振荡的微型目标（如 P09/P12 中移动速度高达数百 px/s 的圆点），利用扩展底层的 `points` 序列在单次 MCP 往返中下发密集点击波（步进 15–35ms），实现 100% 物理命中。

---

## 5. 全库质量门禁与基线现状

接棒 Agent 可直接运行以下命令验证代码健康度：

```powershell
# 1. 全局 TypeScript 类型检查（0 Errors）
pnpm typecheck

# 2. Chrome 扩展 Vue-TSC 编译检查（0 Errors）
pnpm --filter chrome-mcp-server compile

# 3. 全套核心特性与多模态视觉强化测试套件（129/129 PASS）
node --test test/boost-features.test.ts test/p0-p1-hardening.test.ts test/boost-phase1-phase4.test.ts

# 4. Native Bridge 单元与集成测试（30/30 PASS）
pnpm --filter mcp-chrome-bridge test
```

---

## 6. 常用维护与构建操作命令

### 6.1 重新编译扩展并同步到独立目录

```powershell
# 1. 编译 Chrome 扩展
pnpm --filter chrome-mcp-server build

# 2. 同步产物至 D:\workspace\browserclaw（使用 node 避免 powershell 通配符被策略拦截）
node -e "require('fs').cpSync('app/chrome-extension/.output/chrome-mv3', 'D:/workspace/browserclaw', { recursive: true }); console.log('SYNCED');"

# 3. 触发扩展重载
node test/manual/reload-extension.mjs
```

### 6.2 启动靶场服务

```powershell
node test/complex-html-testing/serve.mjs
```

### 6.3 快捷 MCP 交互调试

```powershell
# 读取当前激活标签页紧凑 DOM
node test/rd.mjs '{"tabId":1581256720}'

# 后台无感高速截图（默认高质量 WebP 1:1 CSS 视口归一化）
node test/mcp-client.mjs chrome_screenshot '{"tabId":1581256720,"background":true}'
```

---

## 7. 视觉操作优化与通用前沿多模态大模型对齐已交付能力 (Phase 1 - Phase 4)

1. **DPR 1:1 视口几何归一化 (P0)**：所有截屏通道通过 `OffscreenCanvas` 强制重采样为标准 CSS 视口尺寸，彻底消灭 Windows 125%/150%/200% 高分屏下的视觉视差漂移；
2. **450KB WebP 动态预算与防致盲传输保护 (P0)**：默认截屏升级为 WebP（quality 0.80）；超限落盘时自动附带高质量缩略图，永远保留 MCP `{ type: 'image' }` 图像块，彻底杜绝远端 Agent 致盲；
3. **`computer.ts` 二次缩放根除与局部 ROI 观察修复 (P0)**：消除了 `clickTool` 前置 `project()` 导致的 double-offset 缺陷；修复 `zoom` 动作边界框 `[ymin, xmin, ymax, xmax]` 轴反转，并在上下文记录 `originX / originY` 锚点；
4. **多态视觉坐标解析引擎 PCIE (P1)**：全工具支持各大前沿多模态大模型（Claude 3.5/3.7 Computer Use、OpenAI GPT-4o/4.5、Gemini 2.0/2.5 Pro/Flash、Qwen2.5-VL、UI-TARS）异构坐标格式（检测框、`box_2d` 千分比换算、`point` 顺序自适应、数组/对象）；
5. **Set-of-Mark 2.0 智能徽标 (P2)**：视锥动态剔除当前视口外节点，相邻中心距 $<25\text{px}$ 自动交错上下排布防重叠，微胶囊半透明样式不遮挡文字；
6. **代码与资产净化 (P2)**：清理历史废弃产物，统一更新 MCP 工具描述为 `chrome_read_dom`，修复 Prompt 文档，全面完成现代架构演进。
