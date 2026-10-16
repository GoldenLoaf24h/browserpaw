/**
 * Benchmark runner & fixture suite for BrowserPaw Jev Decision Engine (Vision vs. Text).
 *
 * Compares:
 *   1. baseline-1.13-text: Pinned jev-1.13.0, visionEnabled: false
 *   2. candidate-1.14-text: Pinned jev-1.14.0, visionEnabled: false
 *   3. candidate-1.14-vision: Pinned jev-1.14.0, visionEnabled: true (multimodal Box + Noul)
 *
 * Default execution runs deterministic environment and fixture self-checks without
 * fabricating synthetic benchmark scores or writing mock result files.
 * Live benchmark (--live) connects through local bridge, executes FastDecisionEngine.run,
 * tests real CDP state on isolated temporary background tabs, and attempts cleanup in finally.
 */

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_GROUPS = Object.freeze([
  {
    id: 'baseline-1.13-text',
    modelId: 'jev-1.13.0',
    visionEnabled: false,
    description: 'Baseline: Jev 1.13.0 text-only model',
  },
  {
    id: 'candidate-1.14-text',
    modelId: 'jev-1.14.0',
    visionEnabled: false,
    description: 'Candidate: Jev 1.14.0 text-only model',
  },
  {
    id: 'candidate-1.14-vision',
    modelId: 'jev-1.14.0',
    visionEnabled: true,
    description: 'Candidate: Jev 1.14.0 hybrid vision model (Box + Noul)',
  },
]);

export const FIXTURE_NAMES = Object.freeze([
  'search-preview',
  'icon-toolbar',
  'canvas-interactive',
  'missing-target',
]);

export const FIXTURE_GOALS = Object.freeze({
  'search-preview':
    "Type 'BrowserPaw' into the search input box to view live product filter results",
  'icon-toolbar': 'Click on the blue notification bell button in the toolbar',
  'canvas-interactive': 'Click on the blue Settings button inside the canvas',
  'missing-target': 'Click on the blue calendar icon',
});

/**
 * Calculates latency percentiles (p50, p95, min, max, avg).
 */
export function calculatePercentiles(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return { p50: 0, p95: 0, min: 0, max: 0, avg: 0, count: 0 };
  }

  const sorted = [...numbers]
    .filter((n) => typeof n === 'number' && !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { p50: 0, p95: 0, min: 0, max: 0, avg: 0, count: 0 };
  }

  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = Math.round((sum / count) * 10) / 10;

  const getPercentile = (p) => {
    if (count === 1) return sorted[0];
    const index = (p / 100) * (count - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (lower === upper) return sorted[lower];
    return Math.round((sorted[lower] * (1 - weight) + sorted[upper] * weight) * 10) / 10;
  };

  return {
    p50: getPercentile(50),
    p95: getPercentile(95),
    min,
    max,
    avg,
    count,
  };
}

/**
 * Masks sensitive tokens and API keys in output strings.
 */
export function maskSensitive(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-.]+/gi, '$1***')
    .replace(/\b(ts_[a-zA-Z0-9_-]{16,})\b/g, 'ts_***')
    .replace(/\b[0-9a-fA-F]{48,64}\b/g, (match) => match.slice(0, 4) + '...' + match.slice(-4));
}

/**
 * Generates local HTML fixture content.
 */
export function generateFixtureHtml(fixtureName) {
  switch (fixtureName) {
    case 'search-preview':
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fixture: Search & Preview</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    #preview-output { margin-top: 12px; padding: 8px; background: #f0fdf4; border: 1px solid #86efac; }
  </style>
</head>
<body>
  <h1>Product Filter</h1>
  <label for="search-input">Search query</label>
  <input id="search-input" type="text" placeholder="Type query to filter..." autofocus>
  <div id="preview-output">Preview: (empty)</div>
  <ul id="items">
    <li data-name="BrowserPaw">BrowserPaw Automation Engine</li>
    <li data-name="Chrome">Chrome Browser Extension</li>
  </ul>
  <script>
    const input = document.getElementById('search-input');
    const preview = document.getElementById('preview-output');
    input.addEventListener('input', (e) => {
      preview.textContent = 'Preview: ' + e.target.value;
      window.__previewValue = e.target.value;
    });
  </script>
</body>
</html>`;

    case 'icon-toolbar':
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fixture: Icon Toolbar</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    .toolbar { display: flex; gap: 12px; }
    .icon-btn { width: 44px; height: 44px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <h1>Quick Actions</h1>
  <div class="toolbar">
    <button id="btn-star" class="icon-btn" title="" aria-label="">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#eab308"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
    </button>
    <button id="btn-bell" class="icon-btn" title="" aria-label="">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#3b82f6"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
    </button>
    <button id="btn-gear" class="icon-btn" title="" aria-label="">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#64748b"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
    </button>
  </div>
  <div id="status-text" style="margin-top:16px;">Ready</div>
  <script>
    window.__iconClicks = { star: 0, bell: 0, gear: 0 };
    document.getElementById('btn-star').onclick = () => { window.__iconClicks.star++; document.getElementById('status-text').textContent = 'Star clicked'; };
    document.getElementById('btn-bell').onclick = () => { window.__iconClicks.bell++; document.getElementById('status-text').textContent = 'Bell clicked'; };
    document.getElementById('btn-gear').onclick = () => { window.__iconClicks.gear++; document.getElementById('status-text').textContent = 'Gear clicked'; };
  </script>
</body>
</html>`;

    case 'canvas-interactive':
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fixture: Canvas Interactive</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    canvas { border: 1px solid #94a3b8; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Canvas Game Control</h1>
  <canvas id="action-canvas" width="400" height="200"></canvas>
  <script>
    const canvas = document.getElementById('action-canvas');
    const ctx = canvas.getContext('2d');
    window.__canvasState = 'idle';

    function draw(active) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, 400, 200);

      // Blue settings button rect at x:40, y:40, w:140, h:44
      ctx.fillStyle = active ? '#16a34a' : '#2563eb';
      ctx.beginPath();
      ctx.roundRect(40, 40, 140, 44, 8);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(active ? 'ACTIVE' : 'Settings', 75, 68);

      // Gray other button at x:220, y:40, w:140, h:44
      ctx.fillStyle = '#64748b';
      ctx.beginPath();
      ctx.roundRect(220, 40, 140, 44, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText('Mute', 270, 68);
    }

    draw(false);

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x >= 40 && x <= 180 && y >= 40 && y <= 84) {
        window.__canvasState = 'settings_opened';
        draw(true);
      }
    });
  </script>
</body>
</html>`;

    case 'missing-target':
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fixture: Missing Target Negative Guard</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
  </style>
</head>
<body>
  <h1>Account Dashboard</h1>
  <p>Welcome to your account. Available reports:</p>
  <ul>
    <li>Quarterly Activity Log</li>
    <li>Tax Assessment 2025</li>
  </ul>
  <script>
    window.__eventsCount = 0;
    document.addEventListener('click', () => { window.__eventsCount++; });
    document.addEventListener('input', () => { window.__eventsCount++; });
  </script>
</body>
</html>`;

    default:
      throw new Error(`Unknown fixture name: ${fixtureName}`);
  }
}

/**
 * Evaluates real task success based on actual page state changes.
 */
export function evaluateTaskResult(fixtureName, pageState) {
  if (!pageState || typeof pageState !== 'object') {
    return { passed: false, reason: 'Missing page state' };
  }

  switch (fixtureName) {
    case 'search-preview': {
      const isInputMatched = pageState.inputValue === 'BrowserPaw';
      const isPreviewMatched =
        typeof pageState.previewText === 'string' && pageState.previewText.includes('BrowserPaw');
      if (isInputMatched && isPreviewMatched) {
        return { passed: true };
      }
      return {
        passed: false,
        reason: `Input '${pageState.inputValue}' or preview '${pageState.previewText}' does not match 'BrowserPaw'`,
      };
    }

    case 'icon-toolbar': {
      const clicks = pageState.iconClicks || {};
      if (clicks.bell === 1 && (clicks.star || 0) === 0 && (clicks.gear || 0) === 0) {
        return { passed: true };
      }
      return {
        passed: false,
        reason: `Expected only bell clicked once; got star=${clicks.star}, bell=${clicks.bell}, gear=${clicks.gear}`,
      };
    }

    case 'canvas-interactive': {
      if (pageState.canvasState === 'settings_opened') {
        return { passed: true };
      }
      return {
        passed: false,
        reason: `Canvas state '${pageState.canvasState}' did not reach 'settings_opened'`,
      };
    }

    case 'missing-target': {
      const eventsCount = Number(pageState.eventsCount || 0);
      const isHaltedSafely =
        pageState.outcome === 'escalate' ||
        pageState.outcome === 'escalated' ||
        pageState.outcome === 'halted_no_target' ||
        pageState.status === 'escalate' ||
        pageState.status === 'escalated';
      if (eventsCount === 0 && isHaltedSafely) {
        return { passed: true };
      }
      return {
        passed: false,
        reason: `Negative guard failed: eventsCount=${eventsCount} (must be 0), outcome=${pageState.outcome || pageState.status}`,
      };
    }

    default:
      return { passed: false, reason: `Unknown fixture: ${fixtureName}` };
  }
}

/**
 * Unwraps an MCP ToolResult from chrome_navigate and extracts tab/window details.
 */
export function parseNavigateResult(toolResult) {
  if (!toolResult || toolResult.isError) {
    const msg = toolResult?.content?.[0]?.text || 'Navigation failed';
    throw new Error(msg);
  }
  const text = toolResult?.content?.[0]?.text;
  if (!text) {
    if (typeof toolResult.tabId === 'number' && toolResult.tabId > 0) return toolResult;
    throw new Error('Navigation returned empty content');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse navigate response JSON: ${err.message}`);
  }
  const tabId = parsed.tabId ?? parsed.tabs?.[0]?.tabId;
  if (typeof tabId !== 'number' || tabId <= 0) {
    throw new Error(`Navigation response did not include a valid tabId: ${text}`);
  }
  return { ...parsed, tabId };
}

/**
 * Unwraps an MCP ToolResult from chrome_javascript and extracts evaluated page state.
 */
export function parseJavascriptResult(toolResult) {
  if (!toolResult || toolResult.isError) {
    const msg = toolResult?.content?.[0]?.text || 'JavaScript execution failed';
    throw new Error(msg);
  }
  const text = toolResult?.content?.[0]?.text;
  if (!text) {
    if (toolResult.result !== undefined) return toolResult.result;
    return toolResult;
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return text;
  }
  if (envelope && typeof envelope === 'object') {
    if (envelope.success === false || envelope.error) {
      const errMsg =
        typeof envelope.error === 'object'
          ? envelope.error.message || JSON.stringify(envelope.error)
          : String(envelope.error || 'JavaScript execution error');
      throw new Error(errMsg);
    }
    if ('result' in envelope) {
      const raw = envelope.result;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            return JSON.parse(trimmed);
          } catch {
            return raw;
          }
        }
        return raw;
      }
      return raw;
    }
  }
  return envelope;
}

/**
 * Dynamically loads FastDecisionEngine and jevModelManager from native-server TS source.
 */
export function loadNativeModules(repoRoot = process.cwd()) {
  const nativeDir = path.resolve(repoRoot, 'app/native-server');
  const req = createRequire(path.join(nativeDir, 'package.json'));
  process.env.TS_NODE_PROJECT = path.join(nativeDir, 'tsconfig.json');
  req('ts-node/register/transpile-only');
  const { FastDecisionEngine } = req('./src/jev/fast-decision-engine.ts');
  const { jevModelManager } = req('./src/server/jev-model-manager.ts');
  return { FastDecisionEngine, jevModelManager };
}

/**
 * Starts an ephemeral HTTP server to host fixtures locally.
 */
export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const fixtureName = parsed.pathname.replace(/^\/fixture\//, '');
    try {
      const html = generateFixtureHtml(fixtureName);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Fixture not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/fixture`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/**
 * Performs MCP initialize handshake over HTTP transport and returns sessionId.
 * Properly drains the response body and does not ignore handshake errors.
 */
export async function initializeMcpSession(bridgeUrl, token) {
  const initPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'browserpaw-benchmark-runner',
        version: '4.0.0',
      },
    },
  };

  const resp = await fetch(`${bridgeUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'x-mcp-token': token,
    },
    body: JSON.stringify(initPayload),
  });

  const sessionId = resp.headers.get('mcp-session-id');

  try {
    const respBody = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `MCP initialize handshake failed (${resp.status}): ${maskSensitive(respBody)}`,
      );
    }

    const contentType = resp.headers.get('content-type') || '';
    let messages;
    if (contentType.includes('text/event-stream') || respBody.includes('data:')) {
      messages = respBody
        .split(/\r?\n\r?\n/)
        .map((block) =>
          block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
            .trim(),
        )
        .filter(Boolean)
        .map((str) => {
          try {
            return JSON.parse(str);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } else {
      messages = [JSON.parse(respBody)];
    }

    const parsed = messages.find((m) => m && m.id === initPayload.id);
    if (!parsed) {
      throw new Error(
        `Failed to find JSON-RPC response with id 1 in MCP response: ${maskSensitive(respBody.slice(0, 200))}`,
      );
    }

    if (parsed.error) {
      const errMsg = parsed.error.message || JSON.stringify(parsed.error);
      throw new Error(`MCP initialize returned JSON-RPC error: ${errMsg}`);
    }

    if (!parsed.result || typeof parsed.result !== 'object') {
      throw new Error('MCP initialize response is missing its result');
    }

    if (!sessionId) {
      throw new Error('MCP initialize response did not include mcp-session-id header');
    }

    // Send notifications/initialized notification per MCP 2024-11-05 specification
    const initNotificationResp = await fetch(`${bridgeUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'x-mcp-token': token,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    const notifyBody = await initNotificationResp.text().catch(() => '');
    if (!initNotificationResp.ok) {
      throw new Error(
        `MCP notifications/initialized failed (${initNotificationResp.status}): ${maskSensitive(notifyBody)}`,
      );
    }

    return sessionId;
  } catch (err) {
    if (sessionId) {
      await cleanupMcpSession(bridgeUrl, token, sessionId);
    }
    throw err;
  }
}

/**
 * Cleans up MCP session over HTTP transport via DELETE /mcp and cleans up response stream.
 */
export async function cleanupMcpSession(bridgeUrl, token, sessionId) {
  if (!sessionId) return;
  try {
    const resp = await fetch(`${bridgeUrl}/mcp`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${token}`,
        'x-mcp-token': token,
        'mcp-session-id': sessionId,
      },
    });
    await resp.text();
    if (!resp.ok) throw new Error(`Session deletion failed: HTTP ${resp.status}`);
  } catch (err) {
    console.warn(`[Warning] MCP session cleanup error: ${err.message}`);
  }
}

/**
 * Internal MCP caller that communicates with the BrowserPaw bridge via HTTP POST /call-tool.
 * Preserves raw MCP ToolResult envelope (data field containing content and isError).
 */
export function createBridgeCaller(bridgeUrl, token, sessionId = null) {
  return async function internalCaller(toolName, args = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-mcp-token': token,
    };
    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    const mergedArgs =
      sessionId && args?.sessionId === undefined ? { ...args, sessionId } : { ...args };

    const resp = await fetch(`${bridgeUrl}/call-tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: toolName, args: mergedArgs }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Bridge call ${toolName} failed (${resp.status}): ${maskSensitive(errText)}`);
    }

    const json = await resp.json();
    if (json.data?.isError) {
      const errMsg = json.data?.content?.[0]?.text || `Tool ${toolName} execution failed`;
      const err = new Error(errMsg);
      err.toolResult = json.data;
      throw err;
    }
    return json.data;
  };
}

/**
 * Formats benchmark results into a clean markdown summary table with smoke verification disclaimer.
 */
export function formatBenchmarkSummary(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No benchmark results available.';
  }

  const groupMap = new Map();
  for (const r of results) {
    if (!groupMap.has(r.groupId)) {
      groupMap.set(r.groupId, []);
    }
    groupMap.get(r.groupId).push(r);
  }

  const lines = [
    '| Group ID | Model | Vision | Pass Rate | p50 (ms) | p95 (ms) | Vision Calls | Failure Reasons |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const [groupId, items] of groupMap.entries()) {
    const passed = items.filter((i) => i.passed).length;
    const total = items.length;
    const latencies = items.map((i) => i.latencyMs).filter((n) => typeof n === 'number');
    const stats = calculatePercentiles(latencies);
    const visionCalls = items.reduce((acc, i) => acc + (Number(i.visionCalls) || 0), 0);
    const failures = items
      .filter((i) => !i.passed)
      .map((i) => `${i.fixtureName}: ${i.failureReason || 'unknown'}`)
      .join('; ');

    const modelId = items[0]?.modelId || '-';
    const vision = items[0]?.visionEnabled ? 'true' : 'false';

    lines.push(
      `| ${groupId} | ${modelId} | ${vision} | ${passed}/${total} (${Math.round((passed / total) * 100)}%) | ${stats.p50} | ${stats.p95} | ${visionCalls} | ${failures || 'None'} |`,
    );
  }

  lines.push('');
  lines.push(
    '> **Smoke Verification Notice**: The 4 mixed fixtures constitute a functional smoke verification suite across perception pathways; N=4 sample size indicates p95 latency is smoke data, not a statistically reliable performance claim. estCostUsd reflects nominal text token estimates only ($0.042/1M tokens) and is not actual vision billing.',
  );

  return lines.join('\n');
}

/**
 * Default self-check mode (Unpaid, no cloud API spend, zero fabricated results).
 */
export async function runSelfCheck(repoRoot = process.cwd()) {
  console.log('[Self-Check] Verifying local fixture generation...');
  for (const name of FIXTURE_NAMES) {
    const html = generateFixtureHtml(name);
    if (!html || html.length < 50) {
      throw new Error(`Fixture ${name} generated invalid HTML`);
    }
  }
  console.log(`[Self-Check] 4/4 local HTML fixtures generated successfully.`);

  console.log('[Self-Check] Testing ephemeral HTTP fixture server startup...');
  const fixtureServer = await startFixtureServer();
  const testRes = await fetch(`${fixtureServer.baseUrl}/search-preview`);
  const testHtml = await testRes.text();
  await fixtureServer.close();
  if (testRes.status !== 200 || !testHtml.includes('id="search-input"')) {
    throw new Error('Local fixture server verification failed');
  }
  console.log('[Self-Check] Local fixture server lifecycle verified.');

  console.log(
    '[Self-Check] Loading FastDecisionEngine & JevModelManager from TypeScript source...',
  );
  const { FastDecisionEngine, jevModelManager } = loadNativeModules(repoRoot);
  if (typeof FastDecisionEngine !== 'function' || !jevModelManager) {
    throw new Error('Failed to resolve FastDecisionEngine or jevModelManager');
  }
  console.log('[Self-Check] Native Decision Engine and Model Manager loaded.');

  // Check credential availability without logging secret values
  const remoteCfg = jevModelManager.getRemoteConfig();
  const hasEnvKey = Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY);
  const hasConfigKey = Boolean(remoteCfg && remoteCfg.apiKey);
  console.log(
    `[Self-Check] Remote Jev API Key: ${hasEnvKey || hasConfigKey ? 'Configured (Found)' : 'Not configured'}`,
  );

  // Check bridge token existence without logging token
  const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
  const hasBridgeToken = fs.existsSync(tokenPath);
  console.log(
    `[Self-Check] Chrome Bridge Token: ${hasBridgeToken ? 'Present' : 'Not found (Bridge not running)'}`,
  );

  console.log('\n========================================================================');
  console.log('                 Jev Vision Benchmark: Ready for Run                    ');
  console.log('========================================================================');
  console.log('All local fixtures and engine loaders verified.');
  console.log('No cloud API requests were executed and no fake results were generated.');
  console.log('\nTo execute live benchmark against active Chrome instance:');
  console.log('  node scripts/benchmark-jev-vision.mjs --live');
  console.log('========================================================================\n');

  return {
    status: 'self_check_passed',
    fixturesCount: FIXTURE_NAMES.length,
    engineLoaded: true,
    hasApiKey: hasEnvKey || hasConfigKey,
    hasBridgeToken,
  };
}

/**
 * Runs a live benchmark test case across real browser tabs.
 */
export async function runLiveBenchmark(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const bridgeUrl = options.bridgeUrl || 'http://127.0.0.1:12306';
  const outputPath = options.outputPath || 'benchmark-jev-vision-live-report.json';

  const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `Bridge token not found at ${tokenPath}. Please start BrowserPaw bridge first.`,
    );
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim();

  let sessionId = null;
  let fixtureServer = null;
  let internalCaller = null;
  const liveResults = [];
  const createdTabIds = new Set();

  try {
    // Strict session handshake; errors are not ignored
    sessionId = await initializeMcpSession(bridgeUrl, token);
    internalCaller = createBridgeCaller(bridgeUrl, token, sessionId);
    const { FastDecisionEngine, jevModelManager } = loadNativeModules(repoRoot);
    fixtureServer = await startFixtureServer();
    console.log(`Fixture server listening on ${fixtureServer.baseUrl}`);
    for (const group of BENCHMARK_GROUPS) {
      console.log(`\n------------------------------------------------------------`);
      console.log(
        `Starting Group: ${group.id} (${group.modelId}, visionEnabled: ${group.visionEnabled})`,
      );
      console.log(`------------------------------------------------------------`);

      // In-memory spy/override of getter functions only; NEVER write to disk config
      const origGetActiveMode = jevModelManager.getActiveMode.bind(jevModelManager);
      const origGetRemoteConfig = jevModelManager.getRemoteConfig.bind(jevModelManager);

      jevModelManager.getActiveMode = () => 'remote';
      jevModelManager.getRemoteConfig = () => ({
        ...origGetRemoteConfig(),
        modelId: group.modelId,
        visionEnabled: group.visionEnabled,
      });

      try {
        const engine = new FastDecisionEngine();

        for (const fixtureName of FIXTURE_NAMES) {
          const fixtureUrl = `${fixtureServer.baseUrl}/${fixtureName}`;
          const goal = FIXTURE_GOALS[fixtureName];
          console.log(`[Task] Fixture: ${fixtureName} | Goal: "${goal}"`);

          let tabId = null;
          const t0 = performance.now();

          try {
            // 1. Open dedicated temporary background tab with nonce to guarantee isolation
            const isolatedUrl = `${fixtureUrl}?benchTab=${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const navResult = await internalCaller('chrome_navigate', {
              url: isolatedUrl,
              background: true,
            });
            const navData = parseNavigateResult(navResult);
            tabId = navData?.tabId;
            if (!tabId) {
              throw new Error(`Failed to create isolated benchmark tab for ${fixtureUrl}`);
            }
            createdTabIds.add(tabId);

            // 2. Execute FastDecisionEngine.run with internalCaller
            // Contract: takes `goal` (never `task`); NO `visionEnabled` parameter
            const runResult = await engine.run(
              {
                goal,
                tabId,
                maxSteps: 5,
                timeoutMs: 30000,
              },
              internalCaller,
            );

            const elapsedMs = Math.round(performance.now() - t0);

            // 3. Query real post-execution in-page state
            const jsResult = await internalCaller('chrome_javascript', {
              tabId,
              code: `return {
                  inputValue: document.getElementById('search-input')?.value || '',
                  previewText: document.getElementById('preview-output')?.textContent || '',
                  iconClicks: window.__iconClicks || {},
                  canvasState: window.__canvasState || '',
                  eventsCount: window.__eventsCount || 0,
                  outcome: '${runResult.status}'
                };`,
            });

            const pageState = parseJavascriptResult(jsResult);
            const evaluation = evaluateTaskResult(fixtureName, pageState);

            // Telemetry: read authentic visionCalls from jevUsage (never metrics)
            const visionCalls = runResult.jevUsage?.visionCalls || 0;

            liveResults.push({
              groupId: group.id,
              modelId: group.modelId,
              visionEnabled: group.visionEnabled,
              fixtureName,
              passed: evaluation.passed,
              status: evaluation.passed ? 'REAL_PASS' : 'REAL_FAIL',
              engineStatus: runResult.status,
              engine: runResult.engine,
              engineReason: runResult.reason,
              fallbackReason: runResult.fallbackReason,
              jevUsage: runResult.jevUsage,
              steps: runResult.steps,
              pageOutcome: evaluation.passed ? 'VERIFIED' : evaluation.reason || 'UNMET',
              stepCount: Array.isArray(runResult.steps) ? runResult.steps.length : 0,
              latencyMs: elapsedMs,
              failureReason: evaluation.passed
                ? null
                : evaluation.reason || runResult.reason || 'Evaluation failed',
              visionCalls,
            });

            console.log(
              `[Result] Status: ${evaluation.passed ? 'PASS' : 'FAIL'} | Elapsed: ${elapsedMs}ms | Engine: ${runResult.status} | VisionCalls: ${visionCalls}`,
            );
          } catch (caseErr) {
            const elapsedMs = Math.round(performance.now() - t0);
            liveResults.push({
              groupId: group.id,
              modelId: group.modelId,
              visionEnabled: group.visionEnabled,
              fixtureName,
              passed: false,
              status: 'REAL_FAIL',
              engineStatus: 'error',
              pageOutcome: 'ERROR',
              stepCount: 0,
              latencyMs: elapsedMs,
              failureReason: caseErr?.message || String(caseErr),
              visionCalls: 0,
            });
            console.log(
              `[Result] Status: FAIL | Elapsed: ${elapsedMs}ms | Error: ${caseErr?.message || caseErr}`,
            );
          } finally {
            // Retain failed closures for the final cleanup retry.
            if (tabId) {
              try {
                await internalCaller('chrome_close_tabs', { tabIds: [tabId] });
                createdTabIds.delete(tabId);
              } catch (closeErr) {
                console.warn(
                  `Warning: Could not close temporary tab ${tabId}: ${closeErr.message}`,
                );
                // Retain in createdTabIds on failure so outer finally can retry
              }
            }
          }
        }
      } finally {
        // Restore in-memory getters
        jevModelManager.getActiveMode = origGetActiveMode;
        jevModelManager.getRemoteConfig = origGetRemoteConfig;
      }
    }

    const groupSummaries = {};
    for (const group of BENCHMARK_GROUPS) {
      const items = liveResults.filter((r) => r.groupId === group.id);
      const latencies = items.map((r) => r.latencyMs).filter((n) => typeof n === 'number');
      groupSummaries[group.id] = {
        modelId: group.modelId,
        visionEnabled: group.visionEnabled,
        passRate: `${items.filter((r) => r.passed).length}/${items.length}`,
        latencyStats: calculatePercentiles(latencies),
        failureReasons: items
          .filter((r) => !r.passed)
          .map((r) => `${r.fixtureName}: ${r.failureReason}`),
        visionCalls: items.reduce((acc, r) => acc + (Number(r.visionCalls) || 0), 0),
      };
    }

    const report = {
      benchmarkMode: 'live',
      timestamp: new Date().toISOString(),
      disclaimer:
        'Samples (N=4) are a functional smoke verification suite across perception pathways; p95 latency is smoke indication, not a statistical benchmark or performance promise.',
      summary: {
        groups: groupSummaries,
        totalCases: liveResults.length,
        passedCases: liveResults.filter((r) => r.passed).length,
        failedCases: liveResults.filter((r) => !r.passed).length,
      },
      results: liveResults,
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n================== Benchmark Results Summary ==================`);
    console.log(formatBenchmarkSummary(liveResults));
    console.log(`================================================================`);
    console.log(`Live report written to ${outputPath}`);
    return report;
  } finally {
    if (createdTabIds.size > 0 && internalCaller) {
      try {
        await internalCaller('chrome_close_tabs', { tabIds: Array.from(createdTabIds) });
        createdTabIds.clear();
      } catch (err) {
        console.warn(`Warning: Final cleanup could not close remaining tabs: ${err.message}`);
      }
    }
    if (sessionId) {
      await cleanupMcpSession(bridgeUrl, token, sessionId);
    }
    if (fixtureServer) {
      await fixtureServer.close();
    }
  }
}

/**
 * CLI main runner entry point.
 */
export async function main(argv = process.argv.slice(2)) {
  const isLive = argv.includes('--live') || argv.includes('--run-live');
  const outputIndex = argv.indexOf('--output');
  const outputPath =
    outputIndex !== -1 && argv[outputIndex + 1]
      ? argv[outputIndex + 1]
      : 'benchmark-jev-vision-live-report.json';

  console.log('========================================================================');
  console.log('       BrowserPaw Jev Decision Engine: Vision vs. Text Benchmark        ');
  console.log('========================================================================');
  console.log(
    `Mode: ${isLive ? 'LIVE (Real Chrome Bridge & CDP Evaluation)' : 'SELF-CHECK (Unpaid / Fixture & Engine Verification)'}`,
  );
  console.log(`Groups: ${BENCHMARK_GROUPS.map((g) => g.id).join(', ')}`);
  console.log(`Fixtures: ${FIXTURE_NAMES.join(', ')}\n`);

  if (!isLive) {
    return await runSelfCheck();
  }

  return await runLiveBenchmark({ outputPath });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error('Benchmark runner error:', err);
    process.exit(1);
  });
}
