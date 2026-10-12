# dsh-browserpaw

DeepSeek Harness plugin for [BrowserPaw](https://github.com/GoldenLoaf24h/browserpaw): high-speed dual-brain Chrome automation with native CDP and local MCP bridge.

## Architecture

- **MCP Client**: Bridges to local BrowserPaw Native Server (`http://127.0.0.1:12306/mcp`) via `@deepseek-ai/dsh-mcp-client`.
- **Skill Injection**: Registers canonical `browserpaw` skill into DeepSeek Harness Cordis runtime with 1-based numeric DOM indexing, autonomous micro-loops, and background tab isolation.
- **Token Authorization**: Dynamically reads token from `process.env.CHROME_MCP_TOKEN` or `~/.chrome-mcp/bridge-token`.
