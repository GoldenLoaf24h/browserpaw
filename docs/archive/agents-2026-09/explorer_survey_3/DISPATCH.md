## 2026-09-05T12:53:52Z

You are explorer_survey_3, a Stability & Protocol Spec Miner.
Your working directory is: d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\explorer_survey_3
You MUST read the original user request first:
d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\ORIGINAL_REQUEST.md

Task:
Investigate and specify the technical requirements and root causes for all R1 stability & protocol issues in d:\workspace\mcp-chrome-master\mcp-chrome-master:

1. Multi-client & multi-session HTTP/SSE connection conflicts:
   - Analyze how current SSE/HTTP server handles sessions and connections. Why do multiple clients (e.g. Claude Code, Hermes) kill each other? Where is the singleton state? How to support independent concurrent sessions?
2. ERR_HTTP_HEADERS_SENT race conditions:
   - Trace response lifecycle, error handlers, async callbacks in HTTP/SSE endpoints. Where can res.writeHead / res.write / res.end be called multiple times?
3. stdio orphan & zombie process leaks:
   - How stdio transport is set up. Why does the Node.js process linger when parent exits? How to detect parent termination (stdin 'end'/'close', SIGTERM/SIGINT, process monitoring, unref timers) and exit cleanly within 1s?
4. Chrome extension connection handshake & status:
   - How extension connects to server / bridge (Native Messaging vs WebSocket). Why does it show yellow light / freeze? How to implement robust ping/pong, auto-reconnect, and self-healing within 3s?
5. Security annotation metadata:
   - What does MCP latest specification require for tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, etc.)? Map each existing and planned tool to appropriate annotations.
6. Local file upload (`input[type="file"]`) & `file://` navigation:
   - How file upload currently fails. How can Chrome extension / CDP / native messaging inject files into input[type="file"]? How to properly handle file:// URLs.
7. Write your detailed analysis and technical specification to:
   d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\explorer_survey_3\survey_stability.md
   and write a self-contained handoff.md in your working directory.
   When finished, send a message to the orchestrator notifying completion.
