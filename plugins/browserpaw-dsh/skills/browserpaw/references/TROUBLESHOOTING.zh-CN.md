# BrowserPaw 故障排查

连接异常时，在已安装技能的根目录运行通用诊断脚本：

```powershell
node scripts/doctor.mjs
```

`--fix` 只适用于 BrowserPaw 源码 checkout，或 `BROWSERPAW_REPO_ROOT`
显式指向源码仓库的情况。已安装技能会检查正在运行的 Native/MCP 状态，而不是源码构建文件。

## 常见原因

- Chrome 未启动、BrowserPaw 扩展未加载，或 Native Host 未注册。
- 回环端口 `12306` 被其他进程占用。
- bridge token 缺失或不可读；不要把凭据写入提示词或技能文件。
- 页面导航后仍使用旧 ref；重新观察当前页。
- 严格定位匹配到多个元素；改用更具体的选择器、角色、标签或 frame。
- 截图坐标过期；重新截图并使用新的 capture 身份。
- 同时出现多个 dialog、下载、popup 或上传来源；先明确来源再操作。
- Chrome 正在显示原生网络错误页（`chrome-error://chromewebdata/`）时无法注入内容脚本；重新加载或导航到正常页面后获取新的 ref。这属于预期的页面限制，不是 bridge 故障。
- Jev 在网络、超时或限流故障后会临时暂停，并保留用户选择的 Remote/Local；下一次使用时可在 30 秒后恢复同一后端。认证或配置错误需先修正配置，修正后恢复原选择；用户主动关闭则保持关闭。

## 恢复顺序

1. 调用 `chrome_doctor` 并保留诊断结果。
2. 打开扩展的正常连接控件并重连。
3. 对读操作重新观察准确的 tab/document。
4. 写操作结果未知时先观察当前状态，不要重放请求。
5. 遇到 CAPTCHA、2FA、付款或登录墙时交给用户处理。
6. 查看 `chrome_doctor` 中已确认的模式、用户请求模式、关闭原因和重试时间；不要通过切换后端或重复原动作绕过暂停。

## 组件位置

- 诊断脚本：`../scripts/`
- 静态 recipe：`../assets/recipes/`
- 学习技能：`$BROWSERPAW_HOME/skills`（默认 `~/.browserpaw/skills`）
