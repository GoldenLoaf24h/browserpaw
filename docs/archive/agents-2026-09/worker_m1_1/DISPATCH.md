## 2026-09-05T12:59:34Z

You are worker_m1_1, implementing Milestone M1: Underlying Service Stability & Concurrency.
Your working directory is: d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\worker_m1_1
You MUST read the original user request first:
d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\ORIGINAL_REQUEST.md
Also read:

- Project architecture: d:\workspace\mcp-chrome-master\mcp-chrome-master\PROJECT.md
- Survey codebase report: d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\explorer_survey_1\survey_codebase.md
- Survey stability report: d:\workspace\mcp-chrome-master\mcp-chrome-master\.agents\explorer_survey_3\survey_stability.md

Exclusive Write Ownership:
You exclusively own:

- `app/native-server/src/mcp/`
- `app/native-server/src/server/index.ts`
- `app/chrome-extension/entrypoints/background/native-host.ts`
- `app/chrome-extension/entrypoints/popup/App.vue`
- `app/chrome-extension/entrypoints/background/tools/browser/file-upload.ts`
- `app/chrome-extension/entrypoints/background/tools/browser/common.ts`
- `packages/shared/src/tools.ts`
  Do NOT edit files in `test/` or create `TEST_INFRA.md`/`TEST_READY.md`.

Milestone M1 Tasks:

1. Multi-client HTTP/SSE Concurrency:
   - Create `app/native-server/src/mcp/session-manager.ts` (or integrate into mcp-server) to instantiate and manage isolated `Server` instances per transport/session.
   - Update `app/native-server/src/server/index.ts` to route `/sse`, `/messages`, and `/mcp` requests through session manager rather than a static singleton `mcpServer`.
2. ERR_HTTP_HEADERS_SENT elimination:
   - In `app/native-server/src/server/index.ts`, properly invoke `reply.hijack()` before raw writes. Check `!reply.raw.headersSent` and `!reply.raw.writableEnded` in error handlers and streaming hooks.
3. stdio process clean termination:
   - In `app/native-server/src/mcp/mcp-server-stdio.ts`, add event listeners for `process.stdin.on('end')`, `process.stdin.on('close')`, `process.on('SIGTERM')`, `process.on('SIGINT')`, and an unreferenced 800ms timer to ensure process exits cleanly within 1s when parent disconnects.
4. Chrome Extension Handshake & Self-Healing:
   - In `app/chrome-extension/entrypoints/background/native-host.ts` and `app/chrome-extension/entrypoints/popup/App.vue`, implement 2-way handshake, active 2s ping/pong, handle native host port errors / restart, and HTTP `/ping` verification recovering in <3s.
5. MCP Security Annotations:
   - In `packages/shared/src/tools.ts`, add `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) across all MCP tool schemas.
6. Local File Upload & file:// Navigation:
   - In `app/chrome-extension/entrypoints/background/tools/browser/file-upload.ts` and `common.ts`, support file upload via CDP `DOM.setFileInputFiles` (handling hidden inputs/dialogs) and normalize Windows file paths for `file://` URLs.
7. Run build (`pnpm --filter chrome-mcp-shared build`, `pnpm --filter mcp-chrome-bridge build`) and any unit tests to verify your implementation compiles and functions.
8. Document all commands, file changes, and verification evidence in `handoff.md` in your working directory and notify the orchestrator.
