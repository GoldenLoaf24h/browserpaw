# BrowserClaw 实战靶场通关手册（NEXUS LAB）

> 依据 test/complex-html-testing/src 全量源码逐行阅读整理。用途：供操控者按 UI 合法交互通关。
> 零作弊红线：不改靶场代码、不注入 JS、不手改 localStorage。本手册只描述"真实用户式"操作。

---

## 0. 场地总览

### 0.1 基本盘

- 入口：`http://127.0.0.1:4173`（`serve.mjs` 静态服务 `dist/`，SPA 单文件构建）。
- 技术栈：**React 19.2 + Vite 7 + Tailwind 4**（package.json 实际为 react 19.2.6，任务背景所称 React 18 以源码为准），StrictMode，**hash 路由**（无 history API，靠 `hashchange`）。
- 12 个协议（P01-P12）、共 **79 条断言**（8+7+10+6+6+6+6+5+7+5+5+8）。

### 0.2 路由表（可直接改地址栏 hash 跳转）

| 协议 | 路由                                     | 名称                   |
| ---- | ---------------------------------------- | ---------------------- |
| 首页 | `#/`                                     | 任务板 / 变量来源      |
| 汇总 | `#/debrief`                              | DEBRIEF                |
| P01  | `#/protocol/click`                       | CLICK VECTOR           |
| P02  | `#/protocol/shadow`                      | SHADOW REALM           |
| P03  | `#/protocol/form`                        | FORM HYDRA（三步向导） |
| P04  | `#/protocol/timing`                      | TEMPORAL GATE          |
| P05  | `#/protocol/scroll`                      | SCROLL ABYSS           |
| P06  | `#/protocol/keyboard`                    | KEYBIND MATRIX         |
| P07  | `#/protocol/drag`                        | DRAG VECTOR            |
| P08  | `#/protocol/modal`                       | DIALOG STACK           |
| P09  | `#/protocol/visual`                      | PERCEPTION TRAP        |
| P10  | `#/protocol/state`（步骤 `/state/1..3`） | PERSISTENCE            |
| P11  | `#/protocol/grid`                        | DATA GRID              |
| P12  | `#/protocol/omega`                       | OMEGA SEQUENCE         |

### 0.3 评分与提交机制（全局）

- 每协议右侧栏有 **ASSERTIONS 面板**：逐条列出断言，通过项 ▣ 绿色 / 未过 □ 灰色，顶部显示 `n/m`。
- 断言状态是组件内存里的 flags（`useProtocol`），**切走页面或刷新即清零**；但右侧 `COMMIT PROTOCOL` 按钮（`id="protocol-commit"`）会把当前快照写入全局。
- 全部断言绿后按钮文本为 **COMMIT PROTOCOL**（否则 VALIDATE (MAY FAIL)）。点击后闪现提示：
  - 全过：绿色 `PASS // PROTOCOL SEALED`；
  - 未全过：红色 `FAIL // ASSERTIONS INCOMPLETE`。
- commit 可重复：多次 commit 会**整体覆盖**该协议的 checks 快照（attempts 计数递增，不影响最终判定）。所以"先部分 commit、后补全再 commit"是安全的；最终以**最后一次 commit**为准。
- 顶部 header 常驻 `P n/12`（右侧）与 `T mm:ss` 计时。
- 全局数据存 `localStorage["nexus-lab-v1"]`（session + runs + logs），由系统自动写入，**不要手改**。

### 0.4 会话变量（每局随机，必须抄当前值，禁止写死）

| 变量        | 格式/含义                                                  | 在哪读                     |
| ----------- | ---------------------------------------------------------- | -------------------------- |
| SESSION ID  | `NX-XXXXXX`                                                | 首页 hero 卡 / 顶部 header |
| OPERATOR    | 6 选 1：VOSS/QUINE/HADLEY/SOREN/NADIR/PAVEL（附中文名）    | 首页 OPERATOR 卡           |
| EMAIL       | `{operator小写}.{id后6位小写}@nexus.lab`                   | 仅 P03 目标栏              |
| PHONE       | 10 位数字，显示为 `(xxx) xxx-xxxx`                         | 仅 P03 目标栏              |
| COUNTRY     | 6 选 1（Estonia/Iceland/Uruguay/Singapore/Portugal/Chile） | 首页 COUNTRY 卡 + P03      |
| AUTH DATE   | `YYYY-MM-DD`，显示 `YYYY / MM / DD`                        | 仅 P03 目标栏              |
| CSRF        | 8 位大写；其后有**划线反序诱饵**，抄正常显示那个           | 首页 LIVE NONCE + P03      |
| TOKEN       | 4 位大写（P01 诱饵群、P05 横向卡由此派生）                 | 首页 LIVE NONCE            |
| SEQUENCE    | 3 个希腊字母（αβγδε 中选）                                 | 仅 P01 目标栏              |
| SLIDER      | 37-86 的整数                                               | 首页 LIVE NONCE + P07      |
| ROW         | `OP-XXXX`（P11 目标行）                                    | 首页 LIVE NONCE            |
| QUIZ        | animals / vehicles                                         | 首页 LIVE NONCE + P09      |
| GRID NOTE   | 4 字符（id 后 6 位的前 4 位）                              | 仅 P11 目标栏              |
| SORT COLUMN | token / latency                                            | 仅 P11 目标栏              |
| 短语确认    | `SEAL-{id后6位}`                                           | 仅 P08 目标栏              |
| 中文短语    | 核验通过 / 准许接入 / 影域已开                             | 仅 P06 目标栏              |
| OTP         | 6 位数字，30s 轮换，**仅悬停显示**                         | P03 / P12 悬停框           |

> 建议：开局先进 P03 目标栏把 EMAIL/PHONE/AUTH DATE 抄下来，其余变量首页可读。

### 0.5 全局诱饵与雷区（见到就绕开）

- 首页 `START TEST`（id `decoy-start`）：弹原生 alert 的诱饵。正确开始按钮是 **INITIALIZE SEQUENCE**（id `initialize-sequence`）。
- 首页/汇总页 `RESET LAB`（confirm 弹窗，烧掉全部进度）：**绝不触碰**。
- P01 诱饵按钮带 `data-answer="true"`；真按钮没有该属性。
- P03 蜜罐 `input.hp-trap[name="fax_number"]`（被 CSS 移到屏外）：**不要填**。
- P03 目标栏 CSRF 后的划线反序串是诱饵。
- P04 前 3 秒的 CONTINUE（条纹背景 `#fake-continue`）是骨架诱饵。
- P08/P12 Cookie 墙的 **Accept All** 会记失败；只点 **Accept Necessary Only**。
- P09 左侧 `CANCEL` 按钮（aria-label="Submit"）和右侧 `SUBMIT` 都是失败诱饵；真按钮是中间可见文本 **COMMIT**（内含零宽字符 U+200B，id `visible-commit`）。
- P10 页内 decoy 链接（弹 alert"用浏览器后退"）：别点。

### 0.6 输入真实性说明（受控输入如何生效）

- 全站输入都是 React 受控组件：值必须通过**原生 input 事件**进入 onChange 才会更新 state；直接改 DOM 的 `.value` 无效。
- **代码未检查 isTrusted**：只要 input 事件触发即可（真实键盘、IME、CDP `Input.insertText` 均可）。
- 粘贴敏感点：P06 `#paste-only` **只能粘贴**（单字符键入被 keydown 拦截）；P06 `#type-only` **只能键入**（onPaste 被拦截）；P03 OTP 六格支持整段粘贴 6 位数字。

---

## 1. P01 CLICK VECTOR（8 断言）

**目标栏**：TOKEN（4 位）、序列（3 个希腊字母，如 γ → α → δ）。

| key   | 断言                      | 元素                                                                        | 操作                                                                                                                                                                     |
| ----- | ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| flee  | 击中逃逸按钮              | `#fleeing-target` 文本 LOCK                                                 | `onPointerEnter` 瞬移（随机位置）。**推荐：键盘 Tab 聚焦该按钮后按 Enter**（focus 不触发 pointerenter，直接命中）。直接坐标点击会先触发 enter 导致按钮移位、click 落空。 |
| token | 8 个 AUTHORIZE 中点真按钮 | 8 个 `AUTHORIZE` 按钮                                                       | 真按钮 `data-k` === TOKEN 且**无** data-answer 属性；其余带 `data-answer="true"`（诱饵）。点真那个。                                                                     |
| hover | 悬停链菜单                | `SYSTEM ▾` → `DELTA ▸` → `#hover-release`（RELEASE）                        | 悬停 SYSTEM 弹菜单 → 鼠标**连续**移到 DELTA（子菜单在其右侧弹出）→ 点 RELEASE。路径中断菜单即消失（0ms 延迟）。ABORT 无效。                                              |
| dbl   | 双击                      | `#double-cell`（DOUBLE-CLICK）                                              | 双击。单击只记日志。                                                                                                                                                     |
| ctx   | 右键菜单                  | `#ctx-panel`（RIGHT-CLICK ME） → `#extract-key`（Extract Key）              | 在面板上右键（contextmenu 已 preventDefault，不会弹浏览器菜单）→ 点 Extract Key。Inspect 无效。                                                                          |
| micro | 粘性遮挡下的 8px 微目标   | `#micro-scroll` 内 `#micro-target`（8×8 青色方块，aria-label micro-target） | 在 `#micro-scroll` **容器内**滚动，让微目标完全可见且**不在顶部 48px 粘性条（OCCLUDER — I SWALLOW POINTER EVENTS）之下**，点击。                                         |
| dyn   | 动态 id 按钮              | id 每 1.6s 变为 `dyn-{Date.now()}`                                          | 文本恒定 `STABLE TEXT, UNSTABLE ID`。按**文本/样式**定位点击（勿缓存 id）。                                                                                              |
| seq   | 序列垫                    | 5 个 `[data-pad]`：α β γ δ ε                                                | 按目标栏序列顺序点击 3 个垫。**点错顺序立即清空重来**（前缀校验）。                                                                                                      |

陷阱：flee 的 pointerenter 移位（见上）；诱饵 data-answer；seq 前缀校验。

---

## 2. P02 SHADOW REALM（7 断言）

全部目标都**可见可点**，坐标点击或"穿透树"定位均可；closed shadow 与 iframe 内按钮通过 postMessage 作见证。

| key          | 目标                              | 位置                                                                                                    |
| ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| open         | `OPEN ROOT`（id open-shadow-btn） | `#open-shadow-host` 的 open shadowRoot 内                                                               |
| closed       | `CLOSED ROOT`                     | `#closed-shadow-host` 的 **closed** shadowRoot 内（host.shadowRoot === null，需坐标点击或扩展专有 API） |
| nested       | `NESTED CLOSED`                   | `#nested-shadow-host` open shadow → `#inner-host` closed shadow（两层嵌套）                             |
| slot         | `SLOTTED CONTROL`（#slotted-btn） | `#slot-host` 内 light DOM slotted 按钮（直接点即可）                                                    |
| iframe       | `PIERCE IFRAME`（#probe）         | `#realm-frame`（srcdoc 同源）L1 文档内                                                                  |
| nestedIframe | `DEEP FRAME`（#deep）             | L1 内 `#nested` iframe（L2，srcdoc）内                                                                  |
| iframeShadow | `IFRAME CLOSED SHADOW`            | L1 文档 `#host` 的 closed shadow 内                                                                     |

陷阱：closed root 查询不到（shadowRoot 为 null）；iframe 是独立文档，需切 frame 再找；L1 高 256px，L2 高 88px，均在可视范围内。

---

## 3. P03 FORM HYDRA（10 断言，三步向导，只能前进）

**目标栏先抄**：OPERATOR、EMAIL、PHONE、COUNTRY、AUTH DATE、CSRF、口令片段 `prefix`（= SESSION ID 第 4-5 字符，即 `NX-` 后 6 位的前 2 位）。

### 第 1 步 IDENTITY（一次校验 4 断言：identity / country / honeypot / date）

1. `OPERATOR SURNAME`：输入 operator（大小写均可）。
2. `MAILBOX`：输入 email（原样即可）。
3. `VOICE LINE`（掩码输入）：只管输入 10 位数字，掩码自动补 `(xxx) xxx-xxxx`。
4. `CLEARANCE COUNTRY`：点 `#country-trigger` → 可在 filter 框输入国名过滤 → 点列表中目标国。
5. `AUTHORIZATION WINDOW` 日历：**初始年月就是授权月**，直接点目标"日"的格子（选中变青色底）。
6. **蜜罐 `fax_number` 绝不填**（屏外隐藏）。
7. 点 `#form-next-1`（NEXT GATE）→ 4 项全对才进第 2 步；有错会标 FAIL，改完重按即可（可重试）。

### 第 2 步 SECRETS（校验 password / csrf / otp）

1. `USERNAME`：operator。
2. `PASSPHRASE` 规则：长度 ≥10、**包含 prefix**、包含 `#`、包含数字、**不包含用户名**。安全模板：`Zq9#{prefix}tR4`（不含操作员名即可）。
3. `CSRF TOKEN`：抄目标栏正常显示的 8 位（**不要抄划线反序串**）。
4. `TOTP`：悬停 `#otp-enclave` 才显示 6 位 OTP + 剩余秒数；移到 `#otp-0`..`#otp-5` 逐位输入（每格输完自动跳下格），或**在任意一格直接粘贴 6 位数字**一次填满。30s 窗口，接受当前与上一窗口值。
5. 点 `#form-next-2`（NEXT GATE）→ 全对进第 3 步。

### 第 3 步 SEAL（校验 legal / clearance / signDrop）

1. `#legal-box`：**滚动该容器本身**（不是 window）到物理底部（`— END OF DIRECTIVE —` 可见），随后 `#custom-check`（我已阅读并接受）才可点，点击勾选。
2. `#clearance-select`（原生 select）：选 **OMEGA**（Active 组）。
3. `#sig-canvas` 签名：pointerdown 后**连续拖动产生 >40 个 move 事件**再抬起（画一条长笔画/锯齿线），显示 stroke accepted。
4. `#cred-chip`（CREDENTIAL CHIP，draggable）HTML5 拖到 `#cred-dock`（drop 校验 text/plain === `NEXUS-CRED`）。
5. 点 `#form-finalize`（SEAL IDENTITY）判定 3 项。

陷阱：蜜罐、反序 CSRF、OTP 过期、条款必须滚容器本身、签名需要 >40 move、chip 的 dataTransfer 值固定 NEXUS-CRED。

---

## 4. P04 TEMPORAL GATE（6 断言）

| key      | 操作                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wait     | 点 `#begin-wait`（BEGIN WAIT）→ 等倒计时 5s 结束 → `#wait-unlock` 变 **ENGAGE** → 点击（提前不可点）。                                                                                                                   |
| toast    | 点 `#arm-toast` → **2s 后** toast 出现在容器右上角（`#claim-toast`），内含 `#claim-btn`（CLAIM）；**5.5s 消失**。出现后 3.5s 窗口内点击。可先把光标停在预期位置等它出现。                                                |
| dialogs  | 点 `#dialog-chain`：① alert（session 信息，确认）② confirm `Confirm temporal handshake?` **必须接受** ③ prompt `Enter operator surname` 输入 operator（大小写均可）。confirm 取消或 prompt 错都记 FAIL，但可重试整条链。 |
| seven    | `#counter-pad` 点**恰好 7 次**（按钮显示计数）→ `#lock-count`（LOCK）。多点点旁边 RESET 清零重来。                                                                                                                       |
| search   | `#op-search` 输入 operator（≥2 字符触发）→ 等 **420ms 防抖**出结果 → 点 operator 那行（青色高亮）。点错行记 FAIL 可重试。                                                                                                |
| skeleton | 点 `#load-gate` → **前 3 秒的 CONTINUE（条纹背景 #fake-continue）绝对不点**（点了记 FAIL）→ 3s 后真按钮 `#real-continue` 出现，点它。                                                                                    |

陷阱：原生对话框不在 DOM（扩展需能处理 alert/confirm/prompt，否则卡死）；toast 时窗；防抖 420ms；骨架诱饵点击即失败记录（可被后续重试覆盖，但别点）。

---

## 5. P05 SCROLL ABYSS（6 断言）

目标栏：横向目标卡 `C-XX`（由 TOKEN 派生，amber 高亮）、无限列表 `#048`。

| key      | 操作                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| nested   | 在 `#nested-scroll` 容器**内**滚到底，点 `#nested-deep-btn`（INNER TARGET）。                                                          |
| carousel | `#carousel` 横向滚动，找 **amber 高亮**的目标卡（`C-{序号}`，id `card-{i}`），点击。点错卡无反应。                                     |
| infinite | `#infinite-list` 反复滚到距底 48px 内触发加载（16→28→40→52→60），直到 `#048` 行挂载，滚到可见后点该行。                                |
| occlude  | `#occlude-scroll`：顶部 40px 粘性 `STICKY HITBOX` 吞点击。滚动让 `#occluded-btn`（REVEALED）出现在粘性条**之外**（容器中下部），点击。 |
| lazy     | 滚动内层容器使 `#lazy-sentinel` ≥80% 进入视口，**停留 1.5s**（中途移出则取消）→ `#lazy-btn`（MATERIALIZED）出现 → 点击。               |
| snap     | `#snap-row`（snap-x mandatory）横滚到第 4 屏（数字 04），点 `#snap-confirm`（CONFIRM SNAP）。                                          |

陷阱：滚动根是容器不是 window；粘性遮挡；无限列表虚拟挂载；lazy 有 1.5s 驻留要求。

---

## 6. P06 KEYBIND MATRIX（6 断言）

目标栏：复制源 = SESSION ID；中文短语；列表目标 = operator。

| key      | 操作                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| escape   | 进入页面即有 `#esc-veil`（INTERFERENCE VEIL）。**按一次 Esc**（未开命令面板时）→ veil 消失 pass。若先开了命令面板，第一次 Esc 只关面板，再按一次才 pass。                                                   |
| palette  | **Ctrl+K**（mac ⌘K）开面板 → `#command-input` 输入 `unlock-core` → Enter。也可点列表项 unlock-core（点击同样 pass，但按题意走键盘）。Enter 时取过滤列表第一项，输入部分前缀（如 unl）也可。                 |
| arrows   | 点击 `#arrow-list` 任意处使其聚焦（tabIndex=0）→ 方向键 ↑↓ 移动高亮 → 对准 operator 后按 **Enter**。高亮错人记 FAIL 可重试（列表序：VOSS QUINE HADLEY SOREN NADIR PAVEL；VOSS 为默认第 0 项）。             |
| paste    | `#copy-source`（只读，值=SESSION ID，聚焦自动全选）→ Ctrl+C 复制 → 聚焦 `#paste-only` → **Ctrl+V**。键入被拦截（单字符 keydown preventDefault），只有真实 paste 事件生效；内容 trim 后必须等于 SESSION ID。 |
| typeonly | `#type-only`：粘贴被拦截，**键入**中文短语（核验通过 / 准许接入 / 影域已开，trim 后相等即 pass）。CDP insertText 对中文有效。                                                                               |
| enter    | 点 `#open-confirm`（OPEN CONFIRM）→ `#enter-confirm` 框自动聚焦 → 按 **Enter**。框内"看起来像确认"按钮无效。                                                                                                |

陷阱：Esc 的两级语义（先关面板再关 veil）；paste/type 方向不对称；中文 composition 只要最终 onChange 值正确即可。

---

## 7. P07 DRAG VECTOR（6 断言）

目标栏：滑条值（37-86）、排序目标 A→Z：`GAUNT → KITE → NEXUS → ORBIT → PRISM`。

| key     | 操作                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| html5   | `#drag-module`（MODULE，draggable，text/plain=MODULE）拖到 `#drop-well`。drop 时校验 dataTransfer。                                                                    |
| pointer | `#pointer-block`（36px 青色方块）pointerdown 捕获后拖到 `#pointer-arena` **右下角 TARGET 框内**（进入判定区即 pass，无需抬起）。这不是 HTML5 DnD，必须走 pointermove。 |
| sort    | 两步完成 A→Z：①把 **GAUNT 拖到 ORBIT 上** ②把 **ORBIT 拖到 NEXUS 上**。顺序对即 pass（HTML5 li 拖放）。                                                                |
| range   | `#native-range`（0-100）：键盘 ←→ 步进 ±1，或点击轨道按比例落点。值 === SLIDER 目标即 pass（onChange 判定）。                                                          |
| custom  | `#custom-slider`：**直接点击轨道上对应比例位置即可**（pointerdown 就计算并判定，v=round((x-left)/width×100)）；不必拖动。                                              |
| resize  | 拖 `#resize-handle`（右缘 8px amber 手柄）把面板宽度调到 **320-360px**（实时显示，进区间瞬间 pass）。                                                                  |

陷阱：HTML5 DnD 的 drop 校验 dataTransfer 值；两种滑条机制不同；sort 的 drop 语义是"插入到目标位之前"。

---

## 8. P08 DIALOG STACK（5 断言）

**进入即弹 Cookie 墙**（portal 到 body，z-90，`#cookie-wall`）：点 `#accept-necessary`（**Accept Necessary Only**）。Accept All 会记 FAIL **且墙直接关掉无法在本轮补救**——若误点，离开本协议页再重进（flags 清零重做）。

| key     | 操作                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cookie  | 见上。                                                                                                                                                                            |
| stack   | `#open-stack`（OPEN L1，需先拆墙）→ portal 模态 L1 内 `#to-l2`（OPEN L2）→ L2 内 `#to-l3`（OPEN L3）→ L3 内 `#close-stack`（CLOSE STACK）→ pass。                                 |
| trap    | `#open-trap` → portal z-82 `#focus-trap`：焦点自动进输入框，Tab 在 input→DUMMY→SUBMIT 循环（Shift+Tab 反向）；点 `#trap-submit`（SUBMIT TRAP）pass。                              |
| phrase  | `#open-phrase` → portal z-84 `#phrase-mask` / `#phrase-dialog`：`#phrase-input` 输入 `SEAL-{SESSION ID 后 6 位}`（目标栏有显示）→ `#phrase-ok`（CONFIRM）。错短语记 FAIL 可重试。 |
| outside | 无独立动作：**全程不点遮罩**，phrase 成功提交时自动一起 pass。若误点遮罩（maskHits 计数+1，两项同时记 FAIL），重新走一遍 phrase 正确提交即可补回。                                |

陷阱：portal 内容挂在 body 下（不在主布局树内）；z 序 82/84 模态叠在页面上；误点遮罩的双重惩罚可恢复。

---

## 9. P09 PERCEPTION TRAP（7 断言）

目标栏：识图类别 animals / vehicles。

| key     | 操作                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quiz    | 6 宫格 `#quiz-0..5`，内容固定：0=猫(animals) 1=车(vehicles) 2=猫(animals) 3=建筑(无) 4=狗(animals) 5=车(vehicles)。按类别**选中全部**匹配格（animals→0,2,4；vehicles→1,5），选中格右上角出现 ON 徽章 → 点 `#quiz-submit`（SUBMIT GRID）。选错可改后重交。 |
| ghost   | `#ghost-btn`（文本 GHOST）透明度 0.02，位于容器左上（约 left 24px/top 24px）——"看不见但可点"，坐标点击。                                                                                                                                                  |
| pseudo  | 左侧 `CLICK ME` 是 `#pseudo-decoy` 的 **::before 伪元素，不可点**；真按钮 `#real-pseudo`（REAL NODE）在 right 侧（left≈128px），点击它。                                                                                                                  |
| canvas  | `#hit-canvas`（280×140）：青色圆 r=14 持续运动（x≈42-98，y≈48-92）。目测/截图定位后立即点圆心（容差 16px）。miss 只记日志。                                                                                                                               |
| svg     | `#hot-svg`：右侧青色 blob `#svg-hot` 即热区，点击 path 区域 pass。左侧三角无效。                                                                                                                                                                          |
| visible | 三按钮：CANCEL（aria-label=Submit，**点了记 FAIL**）｜**COMMIT**（中间，可见文本含零宽字符，id visible-commit，aria="Do not press"，点它 pass）｜SUBMIT（**点了记 FAIL**）。                                                                              |
| led     | `#led-dot` 小圆颜色（绿/青/黄）由会话派生，**看颜色不靠文字**。点同色垫 `#led-green` / `#led-cyan` / `#led-amber`。点错记 FAIL 可重试。                                                                                                                   |

陷阱：aria 与可见文本冲突；零宽字符；伪元素不可点；canvas 运动热区；LED 颜色需视觉/计算样式判断。

---

## 10. P10 PERSISTENCE（5 断言）——**推荐放最后做（含刷新）**

目标栏：第 1 步填 operator，第 2 步填 CSRF。

**最优顺序（一次会话内完成，刷新会清空 flags，必须按此序）：**

1. 进入 `#/protocol/state`（自动落到 step1）。`#wiz-op` 输入 operator → `#wiz-next-1`（NEXT · HASH）→ hash 变 `state/2`，**hash ✓**。
2. `#wiz-csrf` 输入 CSRF → `#wiz-next-2` → hash 变 `state/3`，此时 op+token 都已写入 localStorage 检查点 `nexus-wiz-v1`，**persist ✓**。
3. 点 `#arm-reload`（ARM RELOAD）。
4. **F5 刷新页面**。
5. 刷新后：点**浏览器后退**→ 回 step2（数据仍在），**back ✓**；再点**浏览器前进**→ 回 step3，**forward ✓**。
6. 点 `#resume-wiz`（RESUME 卡片，CHECKPOINT RECOVERED AFTER RELOAD），**reload ✓**。
7. 全绿 → COMMIT。

陷阱：页内 decoy 链接（弹 alert）不算后退；**刷新会清空所有 flags**，所以 back/forward 必须安排在刷新后、RESUME 前完成（如上序）；历史栈操作用浏览器后退/前进（history.back/forward）。

> P10 的 localStorage 检查点由页面表单正常写入，属合法交互；不要手工改存储。

---

## 11. P11 DATA GRID（5 断言）

目标栏：目标行 `OP-XXXX`、NOTE 内容（4 字符）、排序列（TOKEN 或 LAT）DESC 后的首行 ID。

推荐流程：

1. **定位**：`#grid-filter` 输入目标行 ID（如 OP-0102），虚拟列表只剩 1 行。
2. **note**：双击该行 NOTE 列（占位文本 `dbl-click`）→ 输入框 autoFocus，输入 NOTE 内容 → Enter（或点别处失焦）提交，pass。
3. **flagged**：在该行上**右键**（自绘菜单出现在鼠标处）→ 点 `#flag-row`（Flag）。
4. **selected**：点该行行首 checkbox 勾选。
5. **sorted**：**清空 filter** → 点目标列头（LAT 或 TOKEN，视 SORT COLUMN；首点即降序 ↓）→ 点第一行行首 ID（青色）→ pass（点击时校验当前排序为指定列 desc 且该行确为降序首行）。
6. `#grid-commit`（COMMIT SELECTION）→ 校验目标行 note/flagged/selected 三项齐备 → commit ✓。

陷阱：200 行虚拟列表（DOM 同时只有 ~15 行，必须滚动或过滤）；排序重排；右键菜单是自绘的；行内编辑走双击+blur/Enter 提交；排序断言要求无过滤干扰。

---

## 12. P12 OMEGA SEQUENCE（8 断言，强制顺序流水线）

顶部步骤灯：COOKIE → TOTP → SHADOW → SLIDE → PROMPT → DOTS → PICK → KEYBIND，**必须按序**，跳步无效（每步 UI 仅在对应 step 渲染）。

1. **COOKIE**：portal 墙 `#omega-cookie` → 点 `#omega-necessary`（Accept Necessary Only）。误点 Accept All 只记 FAIL 墙不关，再点 Necessary 补救即可。
2. **TOTP**：悬停 `#omega-otp` 读取 6 位 OTP（30s 窗口，接受当前+上一窗口）→ `#omega-otp-input` 输入 → `#omega-otp-go`（SUBMIT TOTP）。
3. **SHADOW**：`#omega-shadow-host` 的 **closed** shadow 内按钮（文本 PIERCE OMEGA ROOT）→ 坐标点击或专有 API。
4. **SLIDE**：`#omega-slider` 拉到 100——**直接点击轨道最右端后抬起即可**（pointerdown 即算值，pointerup 时值为 100 触发 pass）。
5. **PROMPT**：`#omega-prompt`（OPEN PROMPT）→ 原生 prompt 输入**完整 SESSION ID**（含 `NX-` 前缀，如 NX-3F9K2A；header/首页可读）。
6. **DOTS**：`#omega-canvas`（360×140）运动青点 r=11（x≈50-310，y≈30-110），**命中 3 次**（容差 16px）。
7. **PICK**：`#omega-pick-trigger`（Select operator…）→ 点列表中 operator。
8. **KEYBIND**：**按 Ctrl+Enter**（mac ⌘+Enter），不要点任何按钮。

全绿 → COMMIT。

陷阱：强制顺序；closed shadow（第 3 步）；原生 prompt（第 5 步）；运动圆点（第 6 步）；终局组合键（第 8 步）。

---

## 13. 评分汇总页（DEBRIEF）

入口：顶部右侧 **DEBRIEF** 按钮 / 首页 `#to-debrief` / 路由 `#/debrief`。

- 四张卡：`SEALED n/12`（封印协议数）、`ASSERTIONS n/79`、`TIME`、`SESSION`。
- **PROTOCOL MATRIX**：每协议一行，进度条 + `n/断言数`；绿 LED=已封印，黄=部分通过（未过断言名会列在行下方），红 LED=未通过。
- **COPY JSON REPORT**（`#copy-report`）导出完整 JSON（session、runs、logs）。
- TELEMETRY：全部日志（PASS/FAIL 流水）。
- 页脚 `⟳ RESET LAB`（confirm）：销毁会话，别点。

快速读分替代方案：顶部 header 常驻 `P n/12`；每协议页右侧 ASSERTIONS 面板即该协议实时断言状态。

---

## 14. 非点击交互总清单（操控者能力核对表）

| 类型              | 出现点                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| 右键 contextmenu  | P01 `#ctx-panel`；P11 目标行                                                                      |
| 双击              | P01 `#double-cell`；P11 NOTE 列编辑                                                               |
| 悬停（菜单/揭示） | P01 SYSTEM→DELTA 菜单；P03 `#otp-enclave`；P12 `#omega-otp`                                       |
| HTML5 拖放        | P03 cred-chip→dock；P07 module→well、列表排序                                                     |
| 指针拖拽          | P07 方块拖靶、custom slider、resize；P12 slider                                                   |
| 键盘组合/单键     | P01 Tab+Enter（flee）；P06 Esc/Ctrl+K/Enter/方向键；P10 F5+浏览器后退/前进；P12 Ctrl+Enter        |
| 原生对话框        | P04 alert/confirm/prompt；P12 prompt；（首页与 P10 的诱饵 alert、RESET 的 confirm —— 只需不触发） |
| iframe            | P02 L1 srcdoc + L2 嵌套 + L1 内 closed shadow                                                     |
| Shadow DOM        | P02 open/closed/嵌套；P12 closed                                                                  |
| Canvas            | P03 签名笔画；P09 运动圆；P12 运动圆点                                                            |
| 虚拟/无限列表     | P05 无限加载；P11 200 行虚拟滚动                                                                  |
| 粘贴              | P06 paste-only（仅粘贴）；P03 OTP（支持整段粘贴）；P06 type-only（禁粘贴）                        |
| 中文输入          | P06 `#type-only`                                                                                  |
| localStorage      | P10 `nexus-wiz-v1`（页面表单合法写入）；总分 `nexus-lab-v1`（系统自动）                           |

---

## 15. 推荐通关顺序与通用纪律

推荐顺序：**P01 → P02 → P04 → P05 → P06 → P07 → P08 → P09 → P11 → P03 → P12 → P10**

理由：P03 最长（三步向导+OTP）且变量最多，先抄完它的目标栏再打前面的；P12 是串联流水线放倒数第二；**P10 含整页刷新，必须最后做**（刷新会清掉所有未 commit 的 flags）。

通用纪律：

1. 每协议**全部断言绿后立即 COMMIT**，再切下一个（切页丢 flags，commit 过的 runs 安全）。
2. 每局先在 P03 目标栏抄全变量（EMAIL/PHONE/AUTH DATE 只在那里出现）。
3. 部分通过时 commit 无害；补全后再 commit 覆盖即可。
4. 绝不触碰：RESET LAB、START TEST、Accept All、蜜罐、P04 骨架 CONTINUE、P09 CANCEL/SUBMIT、P10 decoy 链接、data-answer 诱饵。
5. OTP 30 秒轮换：先填好其余字段，最后悬停读 OTP 立即提交。
6. failFlag 只是"记录当前为失败"，同键后续 pass 会覆盖回来——多数失误可当场重试补救；唯 P08 误点 Accept All 需重进该协议。
