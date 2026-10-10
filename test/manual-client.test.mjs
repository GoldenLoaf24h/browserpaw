import http from 'node:http';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manualPath = path.resolve(__dirname, 'BROWSERPAW_MANUAL.md');
const manualContent = fs.readFileSync(manualPath, 'utf8');

// 1. Extract exact JS client code block from BROWSERPAW_MANUAL.md
const match = manualContent.match(/### 1\.5 Minimal Node\.js Client Implementation[\s\S]*?```javascript\n([\s\S]*?)\n```/);
assert(match && match[1], 'Failed to extract client code block from BROWSERPAW_MANUAL.md');
const extractedCode = match[1];

// 2. Set up Mock MCP HTTP Server (Fixture verifying protocol frames)
const receivedRequests = [];
const assignedSessionId = 'manual-client-extracted-session-88';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const parsed = body.trim() ? JSON.parse(body) : null;
    receivedRequests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsed,
    });

    if (parsed?.method === 'initialize') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'mcp-session-id': assignedSessionId,
      });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'mock-fixture', version: '1.0' },
          sessionId: assignedSessionId,
        },
      }));
    } else if (parsed?.method === 'notifications/initialized') {
      // 202 with empty body per MCP 2025-11-25 / transports spec
      res.writeHead(202, {
        'Content-Type': 'application/json',
        'mcp-session-id': assignedSessionId,
      });
      res.end('');
    } else if (parsed?.method === 'tools/call') {
      // Return SSE format to verify streamable / SSE handling
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'mcp-session-id': assignedSessionId,
      });
      res.end('data: ' + JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          content: [{ type: 'text', text: 'result_for_' + (parsed.params?.name || 'tool') }],
        },
      }) + '\n\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const TEST_BASE = 'http://127.0.0.1:' + port + '/mcp';
const TEST_TOKEN = 'mock-sandbox-token-fixture';

try {
  // 3. Prepare extracted code: inject isolated TEST_BASE / TEST_TOKEN boundary
  let runnableCode = extractedCode
    .replace(/const\s+BASE\s*=\s*['"][^'"]+['"];/, "const BASE = '" + TEST_BASE + "';")
    .replace(/const\s+TOKEN\s*=[\s\S]*?\.trim\(\);/, "const TOKEN = '" + TEST_TOKEN + "';")
    .replace(/^import\s+fs\s+from\s+['"]node:fs['"];/m, '// [isolated] import fs bypassed')
    .replace(/^import\s+os\s+from\s+['"]node:os['"];/m, '// [isolated] import os bypassed');

  // Security guard: scoped fetch strictly enforcing URL === TEST_BASE
  const scopedFetch = async (url, options) => {
    assert.strictEqual(url, TEST_BASE, 'Security violation: client attempted to request ' + url + ' instead of TEST_BASE ' + TEST_BASE);
    return fetch(url, options);
  };

  // Scoped console passed into runner to avoid mutating global console.log
  const scopedConsole = {
    log() {},
    error() {},
    warn() {},
  };

  // Execute the exact extracted code with scopedFetch and scopedConsole
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const runner = new AsyncFunction('fetch', 'console', runnableCode);
  await runner(scopedFetch, scopedConsole);

  // 4. Assert all 4 frames received and compliant
  assert.strictEqual(receivedRequests.length, 4, 'Expected exactly 4 requests, got ' + receivedRequests.length);

  // Frame 1: initialize handshake
  const req0 = receivedRequests[0];
  assert.notStrictEqual(req0.body.id, undefined, 'Frame 1: initialize must have an id');
  assert.strictEqual(req0.body.method, 'initialize');
  assert.strictEqual(req0.headers.authorization, 'Bearer ' + TEST_TOKEN);

  // Frame 2: notifications/initialized (JSON-RPC notification: NO id, session header present)
  const req1 = receivedRequests[1];
  assert.strictEqual(req1.body.id, undefined, 'Frame 2: notifications/initialized must NOT have an id');
  assert.strictEqual(req1.body.method, 'notifications/initialized');
  assert.strictEqual(req1.headers['mcp-session-id'], assignedSessionId, 'Frame 2: notification must carry mcp-session-id');

  // Frame 3: tools/call for get_windows_and_tabs
  const req2 = receivedRequests[2];
  assert.notStrictEqual(req2.body.id, undefined, 'Frame 3: tools/call must have an id');
  assert.strictEqual(req2.body.method, 'tools/call');
  assert.strictEqual(req2.body.params?.name, 'get_windows_and_tabs', 'Frame 3: tool name must be get_windows_and_tabs');
  assert.strictEqual(req2.headers['mcp-session-id'], assignedSessionId, 'Frame 3: tools/call must carry mcp-session-id');

  // Frame 4: tools/call for chrome_read_dom
  const req3 = receivedRequests[3];
  assert.notStrictEqual(req3.body.id, undefined, 'Frame 4: tools/call must have an id');
  assert.strictEqual(req3.body.method, 'tools/call');
  assert.strictEqual(req3.body.params?.name, 'chrome_read_dom', 'Frame 4: tool name must be chrome_read_dom');
  assert.strictEqual(req3.headers['mcp-session-id'], assignedSessionId, 'Frame 4: tools/call must carry mcp-session-id');

  console.log('PASS: test/manual-client.test.mjs verified extracted code and 4 protocol frames directly');
} finally {
  server.close();
}
