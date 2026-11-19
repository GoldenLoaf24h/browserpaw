# BrowserPaw

[English](README.md)

BrowserPaw 让 Agent 通过命令行操作现有的 Chrome 或 Chromium。Agent 阅读技能并执行 `browserpaw` 命令，浏览器扩展通过 Native Messaging 连接本机宿主并执行操作，截图和大结果以本地文件交付。

## 安装

需要 Node.js 22.6 或更高版本。npm 正式发布后，可用 `npx browserpaw@5.0.0 setup`，或先运行 `npm install -g browserpaw@5.0.0` 再运行 `browserpaw setup`。候选包可通过 `npx --yes --package ./browserpaw-5.0.0.tgz browserpaw setup` 安装。

通过 npx 安装后，后续命令也可加上 `npx --yes browserpaw@5.0.0` 前缀，例如 `npx --yes browserpaw@5.0.0 status`。

打开 `chrome://extensions`，启用开发者模式并加载 setup 输出的扩展目录。技能默认安装到 `~/.agents/skills/browserpaw`。用 `--skill-dir` 指定技能目录，或用 `--browser chromium` 注册 Chromium。

## 使用

先运行 `browserpaw status` 确认连接，随后运行 `browserpaw help` 查看命令。多步工作用 `task start` 获取任务 ID，并在后续命令传入 `--task ID`。在现有页面工作时可通过 `tabs` 取得标签页 ID，然后传入 `--tab ID`。观察页面后再用 ref 操作，核实业务结果后运行 `task finish`。

使用 `browserpaw doctor` 排查安装，`browserpaw doctor --fix` 修复注册。使用 `browserpaw uninstall` 卸载宿主和扩展文件，任务与配方数据默认保留。

参见 [命令参考](docs/COMMANDS.md)、[故障排查](docs/TROUBLESHOOTING.zh-CN.md) 和 [发布记录](docs/releases/README.md)。
