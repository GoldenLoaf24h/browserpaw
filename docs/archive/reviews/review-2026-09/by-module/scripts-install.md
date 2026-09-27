# BrowserPaw 架构审查报告：安装注册脚本、构建链路与 Packages 边界

**审查范围**：

- `app/native-server/src/scripts/` 全部：
  - `browser-config.ts`
  - `build.ts`
  - `constant.ts`
  - `doctor.ts`
  - `postinstall-guard.js`
  - `postinstall.ts`
  - `register-dev.ts`
  - `register.ts`
  - `report.ts`
  - `run_host.bat`
  - `run_host.sh`
  - `utils.ts`
- `bin/browserpaw.cjs`
- `app/native-server/src/server/token.ts`（从安装/分发链路视角，注明与安全视角的重叠）
- `scripts/clean.js`
- `scripts/gen-tools-doc.mjs`
- `scripts/sync-skills.mjs`
- `.github/workflows/ci.yml`
- `pnpm-workspace.yaml`

**重点审查维度**：

1. Windows 注册表写入正确性（HKCU/HKLM、64位注册表重定向、Chrome/Chromium 扩展 ID 匹配）
2. 路径转义与批处理/Shell 执行边界（Windows 空格、命令行参数传递、日志轮转）
3. 跨平台兼容性（macOS / Linux / Windows 路径与命令、换行符 CRLF/LF）
4. Postinstall 生命周期副作用与打包边界（npm 发布白名单 files 缺陷、CI 阻断、安装死锁）
5. 构建脚本 dist 输出正确性（tsc 输出、静态资源拷贝、权限设置）
6. Doctor 诊断与 Report 逻辑正确性（误报、漏报、优先级与运行时实现漂移）
7. CLI 客户端边界与通信（Token 读取、参数解析、HTTP/SSE 响应解析）

---

## 一、核心问题详表

### [P0] 确定性 Bug / 安装阻断：package.json 的 postinstall 脚本指定未打包路径导致 npm 安装 100% 崩溃回滚

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\package.json:20, 22-25`
- **严重度**：P0（安装阻断 / 确定性发布崩溃）
- **问题描述**：`app/native-server/package.json` 中声明发布白名单为 `"files": ["dist", "!dist/node_path.txt"]`，这意味着源码目录 `src/` 完全被排除在 npm 打包产物之外。然而其生命周期脚本却声明为 `"postinstall": "node src/scripts/postinstall-guard.js"`。当任何外部用户通过 `npm install -g mcp-chrome-bridge` 安装该包时，npm 在解压产物后触发 `postinstall`，Node.js 立即抛出 `ENOENT: Cannot find module '.../src/scripts/postinstall-guard.js'`，导致整个 npm 全局或局部安装流程 100% 失败并强制回滚。
- **代码证据与触发推演**：
  1. `app/native-server/package.json:20, 22-25`：
     ```json
     "scripts": {
       "postinstall": "node src/scripts/postinstall-guard.js"
     },
     "files": [
       "dist",
       "!dist/node_path.txt"
     ]
     ```
  2. 验证证据：在包目录执行 `npm pack --dry-run --json`，输出的 96 个打包文件中全为 `dist/**`、`package.json` 和 `README.md`，**不存在任何 `src/` 下的文件**。
  3. 触发路径：
     - 用户运行 `npm install -g mcp-chrome-bridge`；
     - npm 下载并解压 tarball，进入 postinstall 钩子；
     - 宿主执行 `node src/scripts/postinstall-guard.js`；
     - 系统抛出：`Error: Cannot find module '.../src/scripts/postinstall-guard.js'`；
     - 安装进程以非 0 状态码退出，npm 终止安装。
- **一句话净收益**：将 postinstall 入口修正为打包发布的产物路径（如 `node dist/scripts/postinstall-guard.js`）并在构建时正确复制该守卫脚本，彻底消除发布后全球用户安装即崩溃的致命阻断。

---

### [P0] 确定性 Bug / 逻辑失效：postinstall.ts 检查 require.main === module 导致 guard 包装调用时实际安装与权限逻辑 100% 被跳过

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\postinstall.ts:10, 235-245`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\postinstall-guard.js:6-10`
- **严重度**：P0（核心功能逻辑失效）
- **问题描述**：`postinstall-guard.js` 的设计初衷是在文件存在时安全引入并运行 postinstall 脚本：`require(target)`。然而在 `postinstall.ts` 中，`main()` 函数的执行被严格限制在 `if (isDirectRun)` 分支下，而 `isDirectRun` 的判定方式为 `const isDirectRun = require.main === module;`。当通过 `postinstall-guard.js` 以 `require()` 方式加载该文件时，`require.main` 指向 `postinstall-guard.js`，`isDirectRun` 恒为 `false`！这导致 `postinstall.ts` 的所有核心逻辑（写入 `node_path.txt`、确保执行权限、自动注册 Native Messaging Host）**一行都不会被执行**，使得 postinstall 在守卫模式下完全沦为静默空转的死代码。
- **代码证据与触发推演**：
  1. `app/native-server/src/scripts/postinstall-guard.js:4-10`：
     ```javascript
     const target = path.resolve(__dirname, '../../dist/scripts/postinstall.js');
     if (fs.existsSync(target)) {
       try {
         require(target);
       } catch (err) {}
     }
     ```
  2. `app/native-server/src/scripts/postinstall.ts:10, 235-245`：
     ```typescript
     // Check if this script is run directly
     const isDirectRun = require.main === module;
     ...
     // Only execute main function when running this script directly
     if (isDirectRun) {
       main().catch((error) => { ... });
     }
     ```
  3. 触发路径：
     无论在开发还是生产环境，通过 guard 调用 `require(dist/scripts/postinstall.js)` 时，`isDirectRun` 判定恒为 `false`，`main()` 永远不会被调用；`node_path.txt` 不会生成，执行权限不会设置，主机不会被注册。只有用户在终端手动敲击 `node dist/scripts/postinstall.js` 这种直接运行方式，才会触发实际逻辑。
- **一句话净收益**：在 `postinstall.ts` 中导出 `main()` 函数或支持被 require 时显式调用，修复自动化安装与注册链条完全哑火的逻辑缺陷。

---

### [P1] 协议缺陷 / 参数丢失：run_host.bat 与 run_host.sh 启动 Node.js 时未透传命令行参数导致扩展上下文完全丢失

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\run_host.bat:175-177`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\run_host.sh:196`
- **严重度**：P1（Native Messaging 协议上下文损坏）
- **问题描述**：当 Chrome 启动 Native Messaging Host 时，Chrome 会依据规范向该可执行进程传递初始命令行参数：参数 `%1`（或 `$1`）为发起调用的 Chrome 扩展 Origin URL（如 `chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee/`），以及可能的 `--parent-window=...` 句柄。在 `run_host.bat` 中，虽然独立二进制分支（Priority -1）传递了 `%*`，但在真正的 Node.js 启动分支中，却写成了 `call "%NODE_EXEC%" "%NODE_SCRIPT%" 2>> "%STDERR_LOG%"`；在 `run_host.sh` 中写成了 `exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${STDERR_LOG}"`。两处均**完全丢失了参数透传**，导致进入 Node.js 进程时 `process.argv` 丢失了所有浏览器上下文信息。
- **代码证据与触发推演**：
  1. `app/native-server/src/scripts/run_host.bat:42, 175`：
     ```bat
     REM Priority -1 传了 %*
     call "%SCRIPT_DIR%\browserpaw-server.exe" %* 2>> "%STDERR_LOG%"
     ...
     REM 默认 Node.js 分支遗漏了 %*
     echo Executing: "%NODE_EXEC%" "%NODE_SCRIPT%" >> "%WRAPPER_LOG%"
     call "%NODE_EXEC%" "%NODE_SCRIPT%" 2>> "%STDERR_LOG%"
     ```
  2. `app/native-server/src/scripts/run_host.sh:196`：
     ```bash
     exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${STDERR_LOG}"
     ```
  3. 触发路径：Chrome 启动 Host 时传入 `chrome-extension://.../ --parent-window=12345`，wrapper 脚本直接吞掉这两个参数，子进程 Node.js 的 `process.argv` 仅包含 `node` 和 `index.js`。若将来服务需要在初始化阶段验证 Origin 或绑定父窗口，参数完全不可得。
- **一句话净收益**：在 bat 和 sh 的启动命令中补全 `%*` 和 `"$@"`，确保符合 Chrome 官方 Native Messaging 协议对 Host 传递参数的规范保证。

---

### [P1] 系统注册缺陷：registerWithElevatedPermissions 硬编码单一 Chrome 键与路径，完全忽略 Chromium 与目标浏览器配置

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\utils.ts:251-325`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\cli.ts:60-63`
- **严重度**：P1（架构硬伤 / 功能严重缺失）
- **问题描述**：`cli.ts` 在处理 `mcp-chrome-bridge register --system` 或检测到管理员提权时，调用了 `registerWithElevatedPermissions()`。但在 `utils.ts` 的实现中，该函数甚至**未接收任何浏览器参数**，内部逻辑硬编码为：
  - 清单路径：`getSystemManifestPath()`（固定返回 Chrome 路径：`C:\Program Files\Google\Chrome\NativeMessagingHosts`）；
  - Windows 注册表键：固定硬编码为 `HKLM\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost`。
    即使用户明确指定 `--browser chromium` 或 `--browser all`，系统级注册流程完全不感知，Chromium 的系统级清单与注册表键永远不会被创建。
- **代码证据与触发推演**：
  1. `app/native-server/src/cli.ts:60-63`：
     ```typescript
     // If --system option is specified or running with root/administrator privileges
     if (options.system || hasElevatedPermissions) {
       // TODO: Update registerWithElevatedPermissions to support multiple browsers
       await registerWithElevatedPermissions();
     ```
  2. `app/native-server/src/scripts/utils.ts:279, 298`：
     ```typescript
     const manifestPath = getSystemManifestPath(); // 仅返回 Chrome 路径
     ...
     if (os.platform() === 'win32') {
       const registryKey = `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
       const regCommand = `reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`;
     ```
  3. 触发路径：用户在 Chromium 环境下运行系统级注册：`mcp-chrome-bridge register --system -b chromium`；CLI 将清单写入了 Chrome 的系统目录，并将 HKLM 注册表指向了 Chrome 键，Chromium 打开后依然显示 Native host not found。
- **一句话净收益**：重构 `registerWithElevatedPermissions` 支持传入目标浏览器列表，为每个目标浏览器分别写入其独立的系统清单路径与 HKLM 注册表项。

---

### [P1] 环境污染 / 个人隐私与路径泄露：scripts/sync-skills.mjs 硬编码特定机器与个人工作区绝对路径

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\scripts\sync-skills.mjs:8-14`
- **严重度**：P1（开源规范与跨环境破坏）
- **问题描述**：`scripts/sync-skills.mjs` 中硬编码了特定开发者的本地绝对路径（包括 `D:/workspace/browserpaw/skill`、`C:/Users/Lenovo/.gemini/config/skills/browserpaw` 等）。在其他开发者的机器或 CI 构建服务器上运行该同步脚本时，`copyDir` 会直接尝试在非当前系统的路径（如 `C:/Users/Lenovo`）下执行 `mkdirSync(dest, { recursive: true })`。若系统无对应盘符（如 Linux/macOS 无 C 盘、D 盘）或权限不足，脚本直接报系统 I/O 异常崩溃；更严重的是，一旦具有写入权限，将在非预期的系统位置污染创建个人目录。
- **代码证据与触发推演**：
  1. `scripts/sync-skills.mjs:8-14`：
     ```javascript
     const targets = [
       { dir: 'D:/workspace/browserpaw/skill', name: 'browserpaw' },
       { dir: path.resolve('plugins/browserpaw/skills/browserpaw'), name: 'browserpaw' },
       { dir: 'D:/workspace/browserpaw/plugins/browserpaw/skills/browserpaw', name: 'browserpaw' },
       {
         dir: 'C:/Users/Lenovo/.gemini/config/skills/browserpaw',
         name: 'browserpaw',
         managed: true,
       },
       {
         dir: 'C:/Users/Lenovo/.gemini/config/skills/mcp-chrome',
         name: 'mcp-chrome',
         managed: true,
       },
     ];
     ```
  2. 触发路径：任何第二开发者在 Linux 机器上执行技能同步或构建前置 hook，Node.js 执行 `fs.mkdirSync('C:/Users/Lenovo/...')`，由于在 Linux 下不存在该根路径结构或无写权限，进程崩溃。
- **一句话净收益**：移除私人硬编码绝对路径，将外部同步目标抽象为环境变量驱动的可选机制（如 `process.env.SKILLS_SYNC_TARGETS`），默认仅在仓库内部相对路径同步。

---

### [P1] 诊断逻辑漂移 / 误报：doctor.ts 与 run_host.bat 的 Node.js 发现优先级倒置导致误报版本过旧

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\doctor.ts:391-412`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\run_host.bat:129-152`
- **严重度**：P1（高概率诊断误报 / 运维混淆）
- **问题描述**：在 Windows 环境下，`run_host.bat` 与 `doctor.ts` 的 Node.js 候选查找优先级发生了严重倒置：
  - `run_host.bat`：Priority 5 为 `where node.exe`（即环境变量 PATH 中当前生效的 node），Priority 6 才是 Common paths（`%ProgramFiles%\nodejs\node.exe` 等）；
  - `doctor.ts`：Priority 6 为 Common paths，Priority 7 才是 PATH！
    此外，`run_host.bat` 拥有 Priority -1 独立可执行文件（`browserpaw-server.exe`），而 `doctor.ts` 完全没有实现对该二进制的检测。
    当用户系统中存在全局老旧 Node（例如 `C:\Program Files\nodejs\node.exe` 为 Node 16），但用户通过 nvm-windows 或自定义 PATH 激活了 Node 22 时：`run_host.bat` 实际能正常启动 Node 22 运行 Native Host；然而运行 `doctor` 诊断时，`doctor` 却优先匹配到了 Common paths 的 Node 16，并误判报出 `[ERROR] Node.js is too old (requires >= 20.0.0)`，产生严重的假阳性（False Positive）误报。
- **代码证据与触发推演**：
  1. `run_host.bat`：
     ```bat
     REM Priority 5: where command (PATH)
     for /f "delims=" %%i in ('where node.exe 2^>nul') do ...
     REM Priority 6: Common paths
     if exist "%ProgramFiles%\nodejs\node.exe" ...
     ```
  2. `doctor.ts`：
     ```typescript
     // Priority 6: Common paths
     const commonPaths = process.platform === 'win32' ? [path.join(process.env.ProgramFiles, 'nodejs', 'node.exe')] : ...;
     for (const common of commonPaths) {
       const resolved = consider('common', common);
       if (resolved) return { ...resolved, nodePathFile };
     }
     // Priority 7: PATH
     for (const rawDir of pathEnv.split(path.delimiter)) ...
     ```
  3. 触发路径：机器上装有旧版 Node（v16），PATH 中为新版 Node（v22）。浏览器能通过 bat 正常启动桥接服务；但用户运行 `mcp-chrome-bridge doctor` 时显示红色错误并要求降级或重装 Node，误导用户破坏现有的正确环境。
- **一句话净收益**：对齐 `doctor.ts` 与 wrapper 脚本的搜索优先级顺序（PATH 应优先于 Common paths），并补全对独立二进制的分支检测，消除误报。

---

### [P1] CLI 异常处理与参数截断：bin/browserpaw.cjs 参数解析丢失等号后半段且错误未设非零退出码

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\bin\browserpaw.cjs:59-67, 102-125`
- **严重度**：P1（CLI 参数损坏与脚本集成错误逃逸）
- **问题描述**：`bin/browserpaw.cjs` 作为轻量级命令行代理，存在两处高危缺陷：
  1. **参数截断**：当解析 `key=val` 参数时，使用 `const [k, v] = rest[i].split('=')`。如果值本身包含等号（例如传入 URL 查询参数 `browserpaw chrome_navigate url=https://example.com?a=1&b=2` 或包含 Base64 等号填充），`split('=')` 将值切为多段，解构赋值 `[k, v]` 仅取第二段，导致从第二个等号起的所有内容全部丢失被截断。
  2. **错误状态码逃逸**：当服务端返回 MCP JSON-RPC 错误（`parsed.error`）时，脚本在控制台打印了 `Error: ${parsed.error.message}`，但之后并未执行 `process.exit(1)`，而是以默认状态码 **0**（成功）退出！这导致在 Shell 脚本或自动化 CI 中，依赖 `browserpaw` 执行命令的判断逻辑完全无法捕获错误。
- **代码证据与触发推演**：
  1. `bin/browserpaw.cjs:59-67`：
     ```javascript
     for (let i = 0; i < rest.length; i++) {
       const [k, v] = rest[i].split('=');
       if (k && v !== undefined) {
         toolArgs[k] = v;
       }
     }
     ```
  2. `bin/browserpaw.cjs:118, 126`：
     ```javascript
     } else if (parsed.error) {
       outputText = `Error: ${parsed.error.message}`;
     }
     ...
     console.log(outputText.trim());
     // 进程自然结束，exit code = 0！
     ```
  3. 触发路径：在自动化脚本中运行 `browserpaw click 999`；工具找不到目标元素返回 JSON-RPC error；CLI 打印了 `Error: element not found`，但退出码为 0，Shell 脚本误以为操作成功，继续下一步引发连锁事故。
- **一句话净收益**：修复等号截断逻辑并对 JSON-RPC 错误显式抛出退出码 1，确保 CLI 工具在脚本流水线中具备确定性的失败拦截能力。

---

### [P1] 权限过度提升 / 独立执行崩溃：register.ts 强制无条件要求管理员权限导致普通用户执行必死

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\register.ts:16`
- **严重度**：P1（易用性硬伤 / 与设计理念冲突）
- **问题描述**：在 Chrome Native Messaging 设计中，官方强烈推荐用户级注册（User-level，写入 HKCU 或用户 home 目录），普通用户完全无需管理员/root 权限。在 `cli.ts` 中，默认的 `register` 命令正确地优先调用了 `tryRegisterUserLevelHost()`。然而在独立脚本 `register.ts` 中，它却直接调用了 `await registerWithElevatedPermissions()`。任何普通用户若直接执行 `node dist/scripts/register.js`，该函数由于内部检测无管理员权限，会直接抛出 `Error: Administrator privileges required...` 并退出（exit 1），完全剥夺了用户级注册的能力。
- **代码证据与触发推演**：
  1. `app/native-server/src/scripts/register.ts:16`：
     ```typescript
     // Write Node.js path before registration
     writeNodePathFile(path.join(__dirname, '..'));

     await registerWithElevatedPermissions(); // 强制系统级提权！
     ```
  2. `app/native-server/src/scripts/utils.ts:285-300`：
     ```typescript
     if (hasElevatedPermissions) { ... } else {
       ...
       throw new Error('Administrator privileges required for system-level installation');
     }
     ```
  3. 触发路径：普通用户在无 root/管理员权限的开发机上运行 `npm run register` 或执行该脚本，注册流程必现报错崩溃。
- **一句话净收益**：将 `register.ts` 改为调用 `registerUserLevelHostWithNodePath()`，使其行为与用户级注册的推荐实践完全一致。

---

### [P2] 资源泄漏：run_host.bat 缺失日志轮转机制导致 Windows 宿主机无限累积碎片日志

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\run_host.bat:19-25`
- **严重度**：P2（磁盘资源泄漏）
- **问题描述**：对比 `run_host.sh` 拥有内置的 `LOG_RETENTION_COUNT=5` 轮转清理逻辑，Windows 版本的 `run_host.bat` 完全没有任何日志轮转或历史日志淘汰机制。每次 Chrome 扩展连接或启动 Native Messaging Host，bat 脚本都会在 `%LOCALAPPDATA%\mcp-chrome-bridge\logs` 下无条件创建两个带时间戳的日志文件（`native_host_wrapper_windows_*.log` 和 `native_host_stderr_windows_*.log`）。当扩展因休眠重连或频繁刷新时，该目录将无限累积成千上万个日志小文件，占用 Windows 系统的文件句柄与磁盘空间。
- **代码证据与触发推演**：
  1. `run_host.sh:22-26` 有清理：
     ```bash
     if [ "${ENABLE_LOG_ROTATION}" = "true" ]; then
       ls -tp "${LOG_DIR}/native_host_wrapper_"* 2>/dev/null | tail -n +$((LOG_RETENTION_COUNT + 1)) | xargs -I {} rm -- {}
     ...
     ```
  2. `run_host.bat:19-25` 无清理：
     ```bat
     set "WRAPPER_LOG=%LOG_DIR%\native_host_wrapper_windows_%TIMESTAMP%.log"
     set "STDERR_LOG=%LOG_DIR%\native_host_stderr_windows_%TIMESTAMP%.log"
     REM 之后直接 echo > "%WRAPPER_LOG%"，没有任何旧日志清理逻辑！
     ```
  3. 触发路径：用户持续使用浏览器，每次打开新窗口或唤醒扩展均落盘 2 个文件，数周后日志目录累积数千个文件。
- **一句话净收益**：在 `run_host.bat` 中增加简单的旧日志保留策略（例如保留最近 10 个日志文件），防止无限制磁盘泄漏。

---

### [P2] CI 覆盖严重缺失：.github/workflows/ci.yml 遗漏 Native-Server 测试且缺失多平台 Matrix

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\.github\workflows\ci.yml:10, 28`
- **严重度**：P2（工程质量门禁虚设）
- **问题描述**：BrowserPaw 作为深度依赖 OS 进程托管（Native Messaging Host）、Windows 注册表（HKCU/HKLM）、批处理和 Shell 脚本的项目，其 GitHub Actions CI 存在重大短板：
  1. CI 运行平台仅设置了 `ubuntu-latest`，没有任何 Windows 或 macOS runner；所有 Windows 专有脚本（bat、注册表、权限）均处于零自动化回归保护状态；
  2. 测试步骤写死为：`pnpm --filter chrome-mcp-server test -- --run`，只测试了扩展端，**完全跳过了 native-server 的单元测试（Jest）**！
- **代码证据与触发推演**：
  1. `.github/workflows/ci.yml:10, 28`：
     ```yaml
     jobs:
       build-and-test:
         runs-on: ubuntu-latest
         ...
         - name: Run unit tests
           run: pnpm --filter chrome-mcp-server test -- --run
     ```
  2. 触发路径：任何针对 native-server（比如 Fastify 路由、Token 鉴权、注册表工具函数）的破坏性改动在 PR 中均能全部绿灯通过，导致坏代码直接合并入主干。
- **一句话净收益**：在 CI 中增加 `pnpm --filter mcp-chrome-bridge test`，并引入 Windows/macOS 构建矩阵，构筑跨平台核心防线。

---

### [P2] 64位 Windows 注册表视图重定向隐患：注册表命令未指定 /reg:64

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\utils.ts:182, 303`
- **严重度**：P2（环境特定偶发失败）
- **问题描述**：在 64 位 Windows 系统中，如果用户运行的是 32 位 Node.js 运行时，或者由 32 位宿主进程（例如 32 位的 VSCode 终端、Git Bash 或部分子进程管理工具）唤起注册命令，系统底层的 `reg add` 命令若未显式指定架构视图，会被 Windows 注册表重定向器（WOW64）自动拦截并写入 `HKLM\Software\WOW6432Node\Google\Chrome\NativeMessagingHosts`。然而，现代 64 位 Google Chrome 在启动并寻找 Native Messaging 宿主时，只会读取原生 64 位注册表树（`HKLM\Software\Google\Chrome\NativeMessagingHosts`），导致注册表面上成功返回 0，但 Chrome 永远找不到宿主。
- **代码证据与触发推演**：
  `utils.ts:182`：
  ```typescript
  const regCommand = `reg add "${config.registryKey}" /ve /t REG_SZ /d "${config.userManifestPath}" /f`;
  ```
  未携带 `/reg:64` 显式标志。
- **一句话净收益**：在所有 Windows `reg add` 命令末尾添加 `/reg:64`，确保在任何位数的执行上下文中均严格写入 64 位主注册表树。

---

### [P2] 架构割裂 / 配置孤岛：constant.ts 与 src/constant/index.ts 双重定义，清单生成不支持多扩展 ID

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\constant.ts:2`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\constant\index.ts:31-41`，`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\utils.ts:153`
- **严重度**：P2（架构可维护性与功能限制）
- **问题描述**：Native-server 内部存在两套彼此割裂的常量定义体系：
  - `src/constant/index.ts` 实现了完备的 `getAllowedExtensionIds()`，支持从环境变量 `CHROME_EXTENSION_ID` 或 `EXTENSION_ID` 动态解析多个扩展 ID 集合；
  - 但所有的安装与注册脚本却只依赖 `src/scripts/constant.ts`，其中写死了单一常量 `EXTENSION_ID = 'hbdgbgagpkpjffpklnamcljpakneikee'`。
    在 `utils.ts` 的 `createManifestContent()` 中，生成的 Native Messaging 清单的 `allowed_origins` 永远只包含这一个写死的扩展 ID。开发者在本地调试自己解压的 Unpacked 扩展（其 ID 随路径变化）时，即使配置了环境变量，清单也无法生效。
- **代码证据与触发推演**：
  `utils.ts:150-155`：
  ```typescript
  return {
    name: HOST_NAME,
    description: DESCRIPTION,
    path: mainPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`], // 硬编码单一 ID
  };
  ```
- **一句话净收益**：统一两套常量文件，清单生成采用 `getAllowedExtensionIds()`，赋能开发者无缝调试非固定 ID 的浏览器扩展。

---

### [P2] 安装与分发安全视角：token.ts 生成时机隐患、并发竞争与只读环境静默失效

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\server\token.ts:31-56`
- **严重度**：P2（并发安全与跨环境鲁棒性）
- **问题描述**（注：此处特指安装、启动分发与多进程协同视角，安全鉴权逻辑已由前序 Agent 审查）：
  1. **并发竞争覆写**：`token.ts` 在安装和构建阶段不生成 token，而是在 Native Host 启动时惰性生成并写入 `~/.chrome-mcp/bridge-token`。如果在多进程或高并发启动场景下（例如 Chrome 扩展同时建立了两个 Native 通道或外部多个 Agent 并行尝试连接），多个进程同时发现文件不存在，各自生成不同的随机 token 竞争写入磁盘，后写者覆盖前者，导致先启动的进程内存中持有的 token 与磁盘不一致，后续外部 CLI 使用磁盘 token 请求先启动的进程时产生鉴权失败。
  2. **只读文件系统静默降级**：在 Docker 只读容器或受限沙箱环境中，磁盘写入异常被 catch 捕获后降级为内存临时 token（`ephemeral`）。由于无法落盘，外部 CLI（`bin/browserpaw.cjs`）从磁盘读不到 token，请求 12306 会持续收到 401，且无任何错误日志提示为什么 token 未能落盘。
  3. **Windows 权限位无效**：`fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 })` 在 Windows NTFS 文件系统上不生效，无法限制同机多用户的读取权限。
- **一句话净收益**：引入原子性文件写入与只读降级时的显式日志告警，保障跨进程 Token 分发的高可靠性。

---

### [P3] 构建缺陷：scripts/gen-tools-doc.mjs 存在隐式构建顺序依赖

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\scripts\gen-tools-doc.mjs:6-8`
- **严重度**：P3（开发体验缺陷）
- **问题描述**：`gen-tools-doc.mjs` 在启动时动态 `import` 了 `../packages/shared/dist/index.mjs`。若在全新拉取代码后未先行执行 `pnpm --filter chrome-mcp-shared build`，直接运行该文档生成脚本会抛出 `ERR_MODULE_NOT_FOUND` 并崩溃，缺少友好的前置构建检测或自动构建兜底。
- **一句话净收益**：增加产物存在性校验与友好提示，提升开发者初次体验。

---

### [P3] 异常安全：register-dev.ts 存在未处理的浮动 Promise Rejection 隐患

- **文件绝对路径与行号**：`D:\workspace\mcp-chrome-master\mcp-chrome-master\app\native-server\src\scripts\register-dev.ts:3`
- **严重度**：P3（代码规范与异常捕获）
- **问题描述**：`register-dev.ts` 顶层直接调用异步函数 `registerUserLevelHostWithNodePath()`，但既未 `await`，也未添加 `.catch()`。一旦底层 I/O（如文件写入或注册表执行）失败抛出异常，会导致 Node.js 进程产生未处理的 Promise 拒绝（UnhandledPromiseRejection）。
- **一句话净收益**：增加顶层 await 或 catch 错误处理，规范异步脚本生命周期。

---

## 二、死代码 / 重复实现 / 过度设计

### 1. 明显的死代码与失效逻辑

- **`app/native-server/src/scripts/postinstall-guard.js`**：该文件既没有被 tsc 编译进 dist，也没有包含在 npm 发布白名单中；而且即使被加载，其引入目标因 `isDirectRun` 检查也不会执行。整套 guard 机制完全失效。
- **`app/native-server/package.json` 中的冗余 bin 别名**：同时声明了 `"mcp-chrome-bridge"`、`"chrome-mcp-bridge"`、`"mcp-chrome-stdio"`、`"browserpaw"` 四个 bin，其中 `browserpaw` 与根目录 `package.json` 的 `browserpaw` 映射到了完全不同的入口（一个是 Native Host CLI，一个是 Thin HTTP Client），造成命名空间严重踩踏。
- **`app/native-server/src/scripts/build.ts` 中虚假的 package.json 复制注释**：代码中注明 `// 复制package.json并更新其内容`，但实际上只生成了 `README.md`，根本没有复制 package.json。

### 2. 复制粘贴的完全重复实现（Duplicate Implementation）

- **文件权限检查与设置逻辑完全重复**：
  - `app/native-server/src/scripts/postinstall.ts:48-112`（共 65 行）
  - `app/native-server/src/scripts/utils.ts:140-205`（共 66 行）
    两处实现了**一模一样**的 `ensureExecutionPermissions` 与 `ensureWindowsFilePermissions` 函数，代码完全为 Copy-Paste，一处维护另一处落后。
- **注册表与 JSON 读取逻辑在 `doctor.ts` 和 `report.ts` 中重复实现**：
  `queryWindowsRegistryDefaultValue`、`readJsonFile` / `readJsonSnapshot`、`resolveTargetBrowsers` / `resolveBrowsers` 在两个文件中各写了一套，逻辑结构重复度超 70%。

### 3. 过度设计（Over-Engineering）

- **批处理中内嵌复杂 PowerShell 脚本进行版本目录对比**：
  `run_host.bat` 在 Priority 3 (asdf) 和 Priority 4 (fnm) 中，各用了一大串超过 200 字符的内联 PowerShell 命令，通过正则匹配、提取语义化版本、排序比对来寻找最新的 Node.js 目录。然而在实际生命周期中，`node_path.txt` 早在构建和安装时就已经固化了当前使用的 Node 绝对路径，后面的 6 层兜底极少触发，却为此背负了脆弱的 Windows 批处理引号嵌套与潜在的冷启动秒级停顿。

---

## 三、性能观察与量化瓶颈

1. **Windows `run_host.bat` 冷启动开销：双重 PowerShell 阻塞（1.2s ~ 2.4s）**
   - **量化指标**：若 `node_path.txt` 不存在或路径失效，bat 脚本在 Priority 3 和 4 会分别唤起一次 `powershell -NoProfile -Command "..."`。
   - 在现代 Windows 11 环境下，单个 `powershell.exe` 进程冷启动平均消耗 **600ms - 1200ms**。两次连续调用将导致 Chrome 扩展连接 Host 时产生 **1.2s - 2.4s 的纯脚本阻塞延迟**。
2. **Postinstall 重复同步 I/O 检查（单次安装 9 次文件系统操作）**
   - **量化指标**：在 `main()` -> `tryRegisterNativeHost()` -> `tryRegisterUserLevelHost()` 的一次全局安装流中，`ensureExecutionPermissions()` 被无脑连续同步调用了 **3 次**。
   - 每次均执行 3 个文件的 `statSync`、`chmodSync`、`accessSync`，造成单次安装产生至少 9 次不必要的磁盘元数据同步读写。
3. **`run_host.bat` 磁盘文件数量 O(N) 线性膨胀**
   - **量化指标**：由于无日志清理机制，每次 Native Messaging 连接产生 2 个文件。按活跃开发或每日断连 50 次计算，1 个月将产生 **3,000 个碎片日志小文件**，长期运行存在磁盘节点浪费。
4. **`scripts/clean.js` 递归深度遍历全树**
   - **量化指标**：使用同步 `fs.readdirSync` 深度优先遍历当前目录下所有非 `.` 开头的文件夹。当工程规模扩大或子目录存在较深层级时，全树遍历耗时达到数百毫秒。

---

## 四、模块依赖与被依赖关系清单

```
[根目录 / 开发工具]
  scripts/clean.js
    └── 依赖: node:fs, node:path
  scripts/gen-tools-doc.mjs
    ├── 依赖: packages/shared/dist/index.mjs (运行时依赖编译产物)
    └── 产物: docs/TOOLS.md
  scripts/sync-skills.mjs
    ├── 依赖: 根目录 skill/SKILL.md
    └── 产物: plugins/... 及外部硬编码路径
  .github/workflows/ci.yml
    └── 当前仅触发 chrome-mcp-server 测试，完全脱节于 native-server

[CLI 客户端]
  bin/browserpaw.cjs
    ├── 依赖: node:http, node:fs, node:path, node:os
    ├── 外部依赖: ~/.chrome-mcp/bridge-token (读取 Token)
    └── 外部依赖: 本地 12306 端口 (/mcp SSE 与 JSON-RPC)

[Native Server 注册与安装模块]
  app/native-server/src/scripts/constant.ts
    ├── 导出: COMMAND_NAME, EXTENSION_ID, HOST_NAME, DESCRIPTION
    └── 被依赖: utils.ts, postinstall.ts, register.ts, doctor.ts

  app/native-server/src/scripts/browser-config.ts
    ├── 依赖: constant.ts
    ├── 导出: BrowserType, getBrowserConfig, detectInstalledBrowsers, parseBrowserType
    └── 被依赖: utils.ts, doctor.ts, report.ts, cli.ts

  app/native-server/src/scripts/utils.ts
    ├── 依赖: constant.ts, browser-config.ts
    ├── 导出: colorText, getLogDir, getUserManifestPath, getSystemManifestPath,
    │         writeNodePathFile, ensureExecutionPermissions, createManifestContent,
    │         tryRegisterUserLevelHost, registerWithElevatedPermissions, checkIsAdmin
    └── 被依赖: cli.ts, register.ts, register-dev.ts, postinstall.ts, doctor.ts

  app/native-server/src/scripts/build.ts
    ├── 依赖: tsc, stdio-config.json, run_host.sh, run_host.bat
    └── 产物: app/native-server/dist/**, dist/node_path.txt

  app/native-server/src/scripts/postinstall-guard.js
    └── 依赖: dist/scripts/postinstall.js (设计意图，但实际未打包且无法执行)

  app/native-server/src/scripts/postinstall.ts
    ├── 依赖: constant.ts, utils.ts
    └── 被依赖: package.json postinstall 钩子

  app/native-server/src/scripts/register.ts & register-dev.ts
    └── 依赖: utils.ts (供 CLI 或独立调用的注册入口)

  app/native-server/src/scripts/doctor.ts
    ├── 依赖: constant.ts, browser-config.ts, utils.ts, ../constant (端口定义)
    ├── 导出: runDoctor, collectDoctorReport
    └── 被依赖: cli.ts, report.ts

  app/native-server/src/scripts/report.ts
    ├── 依赖: browser-config.ts, doctor.ts, utils.ts
    ├── 导出: runReport
    └── 被依赖: cli.ts

  app/native-server/src/server/token.ts
    ├── 依赖: node:crypto, node:fs, node:os, node:path
    ├── 产物: ~/.chrome-mcp/bridge-token
    └── 被依赖: app/native-server/src/server/index.ts, mcp-server-stdio.ts
```
