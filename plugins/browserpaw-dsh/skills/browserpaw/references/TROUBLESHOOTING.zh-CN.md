# 故障排查

- 运行 `browserpaw doctor` 检查安装和连接，运行 `browserpaw doctor --fix` 修复注册。
- 在 `chrome://extensions` 加载 setup 输出的目录。升级后若 setup 提示尚未重载，在扩展页手动重载一次。
- 安装与调用需使用同一 `BROWSERPAW_HOME`。退出码 4 表示动作可能已发出，先观察页面再决定下一步。
