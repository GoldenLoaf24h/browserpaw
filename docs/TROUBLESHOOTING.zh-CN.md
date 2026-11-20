# 故障排查

先运行 `browserpaw doctor`，再按 [安装指南](../INSTALL.md) 核对扩展路径与宿主注册。其他连接与页面操作排查步骤见 [技能故障排查](../skills/browserpaw/references/TROUBLESHOOTING.zh-CN.md)。

## 扩展重载后仍是旧界面（如仍出现 Jev）或重载不生效

1. **核对 Chrome 实际加载路径**：打开 `chrome://extensions` → 点击 BrowserPaw 的**详情**，确认加载目录与实际更新目录一致（`browserpaw setup` 默认释放到 `~/.browserpaw/extension`，本地开发部署则由 `browserpaw.local.json` 的 `extensionSyncDir` 指定），并确保同一配置里没有同时启用两份未打包扩展。
2. **本地开发必须显式部署**：`pnpm verify`、`pnpm build`、`pnpm build:extension` 均不读取 `browserpaw.local.json`，只会更新仓库内 `app/chrome-extension/.output/chrome-mv3`。部署到 Chrome 加载目录必须执行 `pnpm build:deploy && pnpm verify:delivery`（自动清理已删旧文件并做全量 SHA-256 校验）。
3. 确认已运行 `browserpaw setup` 注册 v5 宿主。v4 使用 `com.chromemcp.nativehost`（端口 `12306`），v5 使用 `com.browserpaw.nativehost`（端口 `12307`）。未连接时，新弹窗显示 **Offline**。
4. 关闭弹窗与 DevTools，在 `chrome://extensions` 点击**重新加载**。测试内容脚本时刷新测试标签页。将 `browserpaw status` 返回的构建 ID 与加载目录的 `browserpaw-build.json` 对照。完整步骤见 [开发规范](development/DEVELOPMENT.md#extension-build-deploy-and-reload-rules)。
