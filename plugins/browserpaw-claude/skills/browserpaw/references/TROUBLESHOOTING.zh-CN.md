# BrowserPaw 故障排查

连接异常时先运行通用诊断脚本：

```powershell
node scripts/doctor.mjs
node scripts/doctor.mjs --fix
```

Windows 用户也可以运行 `scripts/repair.bat`。

## 常见原因

- Chrome 未启动、BrowserPaw 扩展未加载，或 Native Host 未注册。
- 回环端口 `12306` 被其他进程占用。
- bridge token 缺失或不可读；不要把凭据写入提示词或技能文件。
- 页面导航后仍使用旧 ref；重新观察当前页。
- 严格定位匹配到多个元素；改用更具体的选择器、角色、标签或 frame。
- 截图坐标过期；重新截图并使用新的 capture 身份。
- 同时出现多个 dialog、下载、popup 或上传来源；先明确来源再操作。

## 恢复顺序

1. 调用 `chrome_doctor` 并保留诊断结果。
2. 打开扩展的正常连接控件并重连。
3. 对读操作重新观察准确的 tab/document。
4. 写操作结果未知时先观察当前状态，不要重放请求。
5. 遇到 CAPTCHA、2FA、付款或登录墙时交给用户处理。

## 组件位置

- 诊断脚本：`../scripts/`
- 静态 recipe：`../assets/recipes/`
- 学习技能：`$BROWSERPAW_HOME/skills`（默认 `~/.browserpaw/skills`）
