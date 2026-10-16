import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';
import {
  BENCHMARK_GROUPS,
  FIXTURE_NAMES,
  FIXTURE_GOALS,
  calculatePercentiles,
  maskSensitive,
  generateFixtureHtml,
  evaluateTaskResult,
  parseNavigateResult,
  parseJavascriptResult,
  formatBenchmarkSummary,
  startFixtureServer,
  initializeMcpSession,
  cleanupMcpSession,
  createBridgeCaller,
  loadNativeModules,
  runSelfCheck,
} from './benchmark-jev-vision.mjs';

test('BENCHMARK_GROUPS defines exact three comparison groups with pinned models', () => {
  assert.equal(BENCHMARK_GROUPS.length, 3);

  const baseline = BENCHMARK_GROUPS.find((g) => g.id === 'baseline-1.13-text');
  assert.ok(baseline, 'baseline-1.13-text group must exist');
  assert.equal(baseline.modelId, 'jev-1.13.0');
  assert.equal(baseline.visionEnabled, false);

  const candidateText = BENCHMARK_GROUPS.find((g) => g.id === 'candidate-1.14-text');
  assert.ok(candidateText, 'candidate-1.14-text group must exist');
  assert.equal(candidateText.modelId, 'jev-1.14.0');
  assert.equal(candidateText.visionEnabled, false);

  const candidateVision = BENCHMARK_GROUPS.find((g) => g.id === 'candidate-1.14-vision');
  assert.ok(candidateVision, 'candidate-1.14-vision group must exist');
  assert.equal(candidateVision.modelId, 'jev-1.14.0');
  assert.equal(candidateVision.visionEnabled, true);
});

test('FIXTURE_NAMES contains all four required deterministic evaluation scenarios', () => {
  assert.deepEqual(
    [...FIXTURE_NAMES],
    ['search-preview', 'icon-toolbar', 'canvas-interactive', 'missing-target'],
  );

  for (const name of FIXTURE_NAMES) {
    assert.ok(typeof FIXTURE_GOALS[name] === 'string' && FIXTURE_GOALS[name].length > 0);
  }

  // Validity check: missing-target goal must be non-destructive to test absence/escalation
  assert.equal(FIXTURE_GOALS['missing-target'], 'Click on the blue calendar icon');
  assert.ok(!FIXTURE_GOALS['missing-target'].toLowerCase().includes('delete'));
  assert.ok(!FIXTURE_GOALS['missing-target'].toLowerCase().includes('export'));
});

test('calculatePercentiles correctly computes p50, p95, min, max, avg, and count', () => {
  assert.deepEqual(calculatePercentiles([]), { p50: 0, p95: 0, min: 0, max: 0, avg: 0, count: 0 });
  assert.deepEqual(calculatePercentiles(null), {
    p50: 0,
    p95: 0,
    min: 0,
    max: 0,
    avg: 0,
    count: 0,
  });

  const single = calculatePercentiles([100]);
  assert.deepEqual(single, { p50: 100, p95: 100, min: 100, max: 100, avg: 100, count: 1 });

  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const stats = calculatePercentiles(latencies);
  assert.equal(stats.count, 10);
  assert.equal(stats.min, 100);
  assert.equal(stats.max, 1000);
  assert.equal(stats.avg, 550);
  assert.equal(stats.p50, 550);
  assert.equal(stats.p95, 955);
});

test('maskSensitive redacts Bearer tokens, TypeSafe API keys, and raw hex hashes', () => {
  const raw =
    'Authorization: Bearer my_secret_token_12345; Key: ts_live_abcdef1234567890; Token: 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const masked = maskSensitive(raw);

  assert.ok(!masked.includes('my_secret_token_12345'));
  assert.ok(!masked.includes('ts_live_abcdef1234567890'));
  assert.ok(masked.includes('Bearer ***'));
  assert.ok(masked.includes('ts_***'));
  assert.ok(masked.includes('1234...cdef'));
  assert.equal(maskSensitive(null), null);
});

test('generateFixtureHtml produces valid HTML with required interactive elements', () => {
  const searchHtml = generateFixtureHtml('search-preview');
  assert.ok(searchHtml.includes('id="search-input"'));
  assert.ok(searchHtml.includes('id="preview-output"'));

  const iconHtml = generateFixtureHtml('icon-toolbar');
  assert.ok(iconHtml.includes('id="btn-star"'));
  assert.ok(iconHtml.includes('id="btn-bell"'));
  assert.ok(iconHtml.includes('id="btn-gear"'));

  const canvasHtml = generateFixtureHtml('canvas-interactive');
  assert.ok(canvasHtml.includes('id="action-canvas"'));
  assert.ok(canvasHtml.includes('__canvasState'));

  const missingHtml = generateFixtureHtml('missing-target');
  assert.ok(missingHtml.includes('__eventsCount'));
  assert.ok(!missingHtml.includes('button'));

  assert.throws(() => generateFixtureHtml('non-existent-fixture'), /Unknown fixture name/);
});

test('evaluateTaskResult checks real functional criteria for all fixtures', () => {
  assert.equal(
    evaluateTaskResult('search-preview', {
      inputValue: 'BrowserPaw',
      previewText: 'Preview: BrowserPaw',
    }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('search-preview', { inputValue: 'wrong', previewText: 'wrong' }).passed,
    false,
  );

  assert.equal(
    evaluateTaskResult('icon-toolbar', { iconClicks: { bell: 1, star: 0, gear: 0 } }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('icon-toolbar', { iconClicks: { bell: 1, star: 1, gear: 0 } }).passed,
    false,
  );
  assert.equal(
    evaluateTaskResult('icon-toolbar', { iconClicks: { bell: 0, star: 0, gear: 0 } }).passed,
    false,
  );

  assert.equal(
    evaluateTaskResult('canvas-interactive', { canvasState: 'settings_opened' }).passed,
    true,
  );
  assert.equal(evaluateTaskResult('canvas-interactive', { canvasState: 'idle' }).passed, false);

  // missing-target: must have eventsCount === 0 and safe escalation outcome
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, outcome: 'escalate' }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, outcome: 'escalated' }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, outcome: 'halted_no_target' }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, status: 'escalate' }).passed,
    true,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 1, outcome: 'escalated' }).passed,
    false,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, outcome: 'clicked_something' }).passed,
    false,
  );
  assert.equal(
    evaluateTaskResult('missing-target', { eventsCount: 0, outcome: 'done' }).passed,
    false,
  );

  assert.equal(evaluateTaskResult('search-preview', null).passed, false);
  assert.equal(evaluateTaskResult('unknown-fixture', {}).passed, false);
});

test('parseNavigateResult unwraps real MCP navigation response envelopes', () => {
  // Case A: Single tab result envelope from chrome_navigate
  const singleTabEnvelope = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Opened URL in new tab in existing window',
          tabId: 42,
          windowId: 1,
          url: 'http://127.0.0.1:1234/search-preview',
        }),
      },
    ],
    isError: false,
  };
  const parsedSingle = parseNavigateResult(singleTabEnvelope);
  assert.equal(parsedSingle.tabId, 42);
  assert.equal(parsedSingle.success, true);

  // Case B: New window result envelope with tabs array
  const windowTabEnvelope = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Opened URL in new window',
          windowId: 5,
          tabs: [{ tabId: 88, url: 'http://127.0.0.1:1234/icon-toolbar' }],
        }),
      },
    ],
    isError: false,
  };
  const parsedWindow = parseNavigateResult(windowTabEnvelope);
  assert.equal(parsedWindow.tabId, 88);

  // Case C: Direct object with tabId (when text is omitted)
  assert.equal(parseNavigateResult({ tabId: 10 }).tabId, 10);

  // Case D: Error or invalid tabId rejection
  assert.throws(
    () =>
      parseNavigateResult({
        isError: true,
        content: [{ type: 'text', text: 'Navigation aborted' }],
      }),
    /Navigation aborted/,
  );
  assert.throws(
    () =>
      parseNavigateResult({
        content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: 0 }) }],
      }),
    /valid tabId/,
  );
  assert.throws(
    () =>
      parseNavigateResult({
        content: [{ type: 'text', text: JSON.stringify({ success: false }) }],
      }),
    /valid tabId/,
  );
});

test('parseJavascriptResult unwraps authentic chrome_javascript MCP envelope', () => {
  // Case A: Authentic cdp execution with JSON-stringified page state in result
  const authenticCdpResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          tabId: 10,
          engine: 'cdp',
          result: JSON.stringify({
            inputValue: 'BrowserPaw',
            previewText: 'Preview: BrowserPaw',
            iconClicks: { star: 0, bell: 1, gear: 0 },
            canvasState: 'settings_opened',
            eventsCount: 0,
            outcome: 'done',
          }),
          metrics: { elapsedMs: 14 },
        }),
      },
    ],
    isError: false,
  };
  const parsed = parseJavascriptResult(authenticCdpResult);
  assert.equal(parsed.inputValue, 'BrowserPaw');
  assert.equal(parsed.previewText, 'Preview: BrowserPaw');
  assert.equal(parsed.iconClicks.bell, 1);
  assert.equal(parsed.canvasState, 'settings_opened');

  // Case B: Scripting execution with direct object in result
  const directObjResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          tabId: 10,
          engine: 'scripting',
          result: { inputValue: 'BrowserPaw' },
          metrics: { elapsedMs: 8 },
        }),
      },
    ],
    isError: false,
  };
  assert.deepEqual(parseJavascriptResult(directObjResult), { inputValue: 'BrowserPaw' });

  // Case C: Script failure envelope throws error
  const errorEnvelope = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          tabId: 10,
          engine: 'cdp',
          error: { kind: 'eval_error', message: 'ReferenceError: invalidFn is not defined' },
          metrics: { elapsedMs: 4 },
        }),
      },
    ],
    isError: true,
  };
  assert.throws(
    () => parseJavascriptResult(errorEnvelope),
    /ReferenceError: invalidFn is not defined/,
  );
});

test('formatBenchmarkSummary formats a clean Markdown table containing groups', () => {
  const sampleResults = [
    {
      groupId: 'baseline-1.13-text',
      modelId: 'jev-1.13.0',
      visionEnabled: false,
      fixtureName: 'search-preview',
      passed: true,
      latencyMs: 250,
      failureReason: null,
    },
    {
      groupId: 'baseline-1.13-text',
      modelId: 'jev-1.13.0',
      visionEnabled: false,
      fixtureName: 'icon-toolbar',
      passed: false,
      latencyMs: 310,
      failureReason: 'Missing icon text label',
    },
    {
      groupId: 'candidate-1.14-vision',
      modelId: 'jev-1.14.0',
      visionEnabled: true,
      fixtureName: 'icon-toolbar',
      passed: true,
      latencyMs: 540,
      failureReason: null,
    },
  ];

  const summary = formatBenchmarkSummary(sampleResults);
  assert.ok(summary.includes('| Group ID | Model | Vision | Pass Rate |'));
  assert.ok(summary.includes('baseline-1.13-text'));
  assert.ok(summary.includes('candidate-1.14-vision'));
  assert.ok(summary.includes('Missing icon text label'));
  assert.ok(summary.includes('Smoke Verification Notice'));

  assert.equal(formatBenchmarkSummary([]), 'No benchmark results available.');
});

test('startFixtureServer serves requested fixture HTML and shuts down gracefully', async () => {
  const server = await startFixtureServer();
  assert.ok(server.port > 0);
  assert.ok(server.baseUrl.startsWith('http://127.0.0.1:'));

  try {
    const res = await fetch(server.baseUrl + '/search-preview');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="search-input"'));

    const notFoundRes = await fetch(server.baseUrl + '/unknown-fixture');
    assert.equal(notFoundRes.status, 404);
  } finally {
    await server.close();
  }
});

test('fixture shutdown closes a browser preconnect socket', async () => {
  const server = await startFixtureServer();
  const socket = createConnection({ host: '127.0.0.1', port: server.port });
  await new Promise((resolve) => socket.once('connect', resolve));
  let timer;
  const closing = server.close();
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture shutdown hung')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closing;
  }
});

test('initializeMcpSession, cleanupMcpSession, and createBridgeCaller work against mock HTTP bridge', async () => {
  const recordedRequests = [];
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsedBody = body ? JSON.parse(body) : null;
      recordedRequests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: parsedBody,
      });

      if (req.url === '/mcp' && req.method === 'POST') {
        if (parsedBody?.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-session-id': 'sess-test-uuid-1234',
          });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }),
          );
        } else if (parsedBody?.method === 'notifications/initialized') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0' }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { message: 'Unexpected method' } }));
        }
      } else if (req.url === '/mcp' && req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
      } else if (req.url === '/call-tool' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Preserves authentic MCP ToolResult envelope inside data
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              content: [
                { type: 'text', text: JSON.stringify({ success: true, tool: parsedBody.name }) },
              ],
              isError: false,
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-abcdef1234567890abcdef1234567890';

  try {
    const sessionId = await initializeMcpSession(bridgeUrl, testToken);
    assert.equal(sessionId, 'sess-test-uuid-1234');

    const caller = createBridgeCaller(bridgeUrl, testToken, sessionId);
    const toolRes = await caller('chrome_read_dom', { tabId: 10 });
    // Preserves raw ToolResult structure
    assert.equal(toolRes.isError, false);
    assert.ok(toolRes.content[0].text.includes('chrome_read_dom'));

    await cleanupMcpSession(bridgeUrl, testToken, sessionId);

    // Verify initialize request was sent
    const initReq = recordedRequests.find(
      (r) => r.url === '/mcp' && r.body?.method === 'initialize',
    );
    assert.ok(initReq, 'initialize request must be sent');
    assert.equal(initReq.headers['authorization'], `Bearer ${testToken}`);
    assert.equal(initReq.headers['x-mcp-token'], testToken);

    // Verify notifications/initialized notification was sent with mcp-session-id
    const notifyReq = recordedRequests.find(
      (r) => r.url === '/mcp' && r.body?.method === 'notifications/initialized',
    );
    assert.ok(notifyReq, 'notifications/initialized must be sent');
    assert.equal(notifyReq.headers['mcp-session-id'], 'sess-test-uuid-1234');

    // Verify delete session request
    const deleteReq = recordedRequests.find((r) => r.url === '/mcp' && r.method === 'DELETE');
    assert.ok(deleteReq, 'DELETE /mcp must be sent');
    assert.equal(deleteReq.headers['mcp-session-id'], 'sess-test-uuid-1234');
  } finally {
    await new Promise((r) => mockServer.close(r));
  }
});

test('cleanup times out when the bridge never answers session deletion', async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  let timer;
  try {
    await Promise.race([
      cleanupMcpSession(`http://127.0.0.1:${server.address().port}`, 'dummy', 'session'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Session cleanup hung')), 6500);
      }),
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cleanup error/);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cleanup reports unsuccessful session deletion', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await cleanupMcpSession('http://bridge.invalid', 'dummy', 'session');
  assert.match(warnings[0], /HTTP 503/);
});

test('initializeMcpSession throws on JSON-RPC error response', async () => {
  const errorServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid protocol version' },
      }),
    );
  });

  await new Promise((r) => errorServer.listen(0, '127.0.0.1', r));
  const port = errorServer.address().port;
  const bridgeUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      () => initializeMcpSession(bridgeUrl, 'dummy-token'),
      /Invalid protocol version/,
    );
  } finally {
    await new Promise((r) => errorServer.close(r));
  }
});

test('initialize accepts SSE heartbeats, multiline data, and unrelated messages', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(options);
    if (calls.length > 1) return new Response(null, { status: 202 });
    const body = [
      ': keep-alive',
      'data:',
      'data: {"jsonrpc":"2.0","id":99,"error":{"message":"unrelated"}}',
      'event: message\r\ndata: {"jsonrpc":"2.0","id":1,\r\ndata: "result":{"protocolVersion":"2024-11-05"}}',
    ].join('\r\n\r\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sse-session' },
    });
  });
  assert.equal(await initializeMcpSession('http://bridge.invalid', 'dummy'), 'sse-session');
  assert.equal(JSON.parse(calls[1].body).method, 'notifications/initialized');
});

test('initialize failures after receiving a session header delete that session', async (t) => {
  for (const failure of ['malformed', 'wrong-id', 'missing-result', 'notification']) {
    await t.test(failure, async (t) => {
      const calls = [];
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        calls.push(options);
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        if (JSON.parse(options.body).method === 'notifications/initialized') {
          return new Response('notification rejected', { status: 500 });
        }
        const body =
          failure === 'malformed'
            ? 'not JSON'
            : JSON.stringify({
                jsonrpc: '2.0',
                id: failure === 'wrong-id' ? 99 : 1,
                ...(failure === 'missing-result'
                  ? {}
                  : { result: { protocolVersion: '2024-11-05' } }),
              });
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'failed-session' },
        });
      });
      await assert.rejects(() => initializeMcpSession('http://bridge.invalid', 'dummy'));
      assert.equal(calls.at(-1).method, 'DELETE');
      assert.equal(calls.at(-1).headers['mcp-session-id'], 'failed-session');
    });
  }
});

test('bridge caller injects session affinity and rejects logical close failures', async (t) => {
  const requests = [];
  const failure = { isError: true, content: [{ type: 'text', text: 'Tab close rejected' }] };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return Response.json({
      status: 'success',
      data: request.name === 'chrome_close_tabs' ? failure : { isError: false },
    });
  });
  const caller = createBridgeCaller('http://bridge.invalid', 'dummy', 'owned-session');
  const args = { tabId: 404 };
  await caller('chrome_read_dom', args);
  assert.equal(requests[0].args.sessionId, 'owned-session');
  assert.equal(args.sessionId, undefined);
  await caller('chrome_read_dom', { sessionId: 'explicit-session' });
  assert.equal(requests[1].args.sessionId, 'explicit-session');
  await assert.rejects(
    () => caller('chrome_close_tabs', { tabIds: [404] }),
    (err) => {
      assert.deepEqual(err.toolResult, failure);
      return /Tab close rejected/.test(err.message);
    },
  );
});

test('loadNativeModules dynamically loads FastDecisionEngine and jevModelManager via ts-node', () => {
  const { FastDecisionEngine, jevModelManager } = loadNativeModules(process.cwd());
  assert.equal(typeof FastDecisionEngine, 'function');
  assert.ok(jevModelManager);
  assert.equal(typeof jevModelManager.getRemoteConfig, 'function');
});

test('runSelfCheck passes deterministically without cloud requests', async () => {
  const result = await runSelfCheck(process.cwd());
  assert.equal(result.status, 'self_check_passed');
  assert.equal(result.fixturesCount, 4);
  assert.equal(result.engineLoaded, true);
});
