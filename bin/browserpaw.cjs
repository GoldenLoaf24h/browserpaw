#!/usr/bin/env node

/**
 * BrowserPaw Thin CLI Shim
 * Ultra-fast, zero-overhead command-line proxy for BrowserPaw MCP Server (12306).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
let token = '';
try {
  if (fs.existsSync(tokenPath)) {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  }
} catch {}

function resolveTargetPort() {
  const raw = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  const p = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : 12306;
}

const args = process.argv.slice(2);
let jsonOutput = args[0] === '--json';
if (jsonOutput) args.shift();

if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  console.log(`BrowserPaw CLI
Usage:
  browserpaw [--json] <tool_name> [json_args_or_key_val...]
  browserpaw repl
  browserpaw skill install [--target <skills-root>] [--force]
  browserpaw doctor
  browserpaw nav <url>
  browserpaw click <index>
  browserpaw fill <index> <text>
  browserpaw dom [deltaOnly]

Examples:
  browserpaw nav https://example.com
  browserpaw click 5
  browserpaw fill 2 "myusername"
  browserpaw chrome_read_dom
  browserpaw --json chrome_screenshot '{"tabId":123}' > result.json

Each one-shot command opens its own MCP session. Use browserpaw repl for multi-step tasks.
JSON mode preserves all content; save image payloads to a file rather than model context.
`);
  process.exit(0);
}

const command = args[0];
const rest = args.slice(1);
if (rest[0] === '--json' && command !== 'repl' && command !== 'skill') {
  jsonOutput = true;
  rest.shift();
}

if (command === 'repl' || command === 'skill') {
  const { spawn } = require('child_process');
  const nativeCli = path.resolve(__dirname, '..', 'app', 'native-server', 'dist', 'cli.js');
  if (!fs.existsSync(nativeCli)) {
    console.error(
      `BrowserPaw native CLI not found at ${nativeCli}. Please build the project first.`,
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, [nativeCli, command, ...rest], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    }
    process.exit(code ?? 0);
  });
  return;
}

let toolName = command;
let toolArgs = {};

// Convenience aliases
if (command === 'nav' || command === 'navigate' || command === 'goto') {
  toolName = 'chrome_navigate';
  toolArgs = { url: rest[0] || 'https://google.com' };
} else if (command === 'click') {
  toolName = 'chrome_interact_index';
  toolArgs = { index: parseInt(rest[0], 10), action: 'click' };
} else if (command === 'fill') {
  toolName = 'chrome_fill_index';
  toolArgs = { index: parseInt(rest[0], 10), text: rest[1] || '' };
} else if (command === 'dom' || command === 'read') {
  toolName = 'chrome_read_dom';
  toolArgs = { deltaOnly: rest[0] === 'true' || rest[0] === 'delta' };
} else if (command === 'doctor') {
  toolName = 'chrome_doctor';
  toolArgs = { verbose: rest.includes('--verbose') || rest.includes('-v') };
} else if (rest.length > 0) {
  try {
    toolArgs = JSON.parse(rest.join(' '));
  } catch {
    if (/^\s*[[{]/.test(rest[0])) {
      console.error('Invalid JSON arguments');
      process.exit(1);
    }
    toolArgs = {};
    for (let i = 0; i < rest.length; i++) {
      const eqIdx = rest[i].indexOf('=');
      if (eqIdx > 0) {
        const k = rest[i].slice(0, eqIdx);
        const v = rest[i].slice(eqIdx + 1);
        toolArgs[k] = v;
      }
    }
  }
}

if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
  console.error('Tool arguments must be a JSON object');
  process.exit(1);
}

// Keep all MCP content intact. SSE notifications are not tool-call responses.
function parseRpcResponse(response, id) {
  if (response.status !== 200) throw new Error(`MCP HTTP ${response.status}`);
  const body = response.body.trim();
  const messages = /^(?:event:|data:|:)/m.test(body)
    ? body.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        return data ? [JSON.parse(data)] : [];
      })
    : [JSON.parse(body)];
  const message = messages.find((value) => value && value.id === id);
  if (!message || message.jsonrpc !== '2.0' || Boolean(message.error) === Boolean(message.result))
    throw new Error('Invalid or missing MCP response');
  return message;
}

const postData = (payload, sessId, onSession) =>
  new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(dataStr),
    };
    if (token) headers['x-mcp-token'] = token;
    if (sessId) headers['mcp-session-id'] = sessId;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: resolveTargetPort(),
        path: '/mcp',
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        if (onSession && typeof res.headers['mcp-session-id'] === 'string') {
          onSession(res.headers['mcp-session-id']);
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('MCP response stream aborted')));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body,
            sessionId: res.headers['mcp-session-id'] || sessId,
          }),
        );
        res.on('close', () => clearTimeout(timer));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('MCP request timed out; do not replay uncertain actions')),
      360000,
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(dataStr);
  });

async function closeSession(sessionId) {
  await new Promise((resolve) => {
    const headers = { 'mcp-session-id': sessionId, Connection: 'close' };
    if (token) headers['x-mcp-token'] = token;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: resolveTargetPort(),
        path: '/mcp',
        method: 'DELETE',
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done();
    }, 1500);
    req.on('error', done);
    req.end();
  });
}

(async () => {
  let sessionId = null;
  let requestDispatched = false;
  try {
    // 1. Initialize
    const initRes = await postData({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browserpaw-cli', version: '1.0.0' },
      },
    }, undefined, (id) => { sessionId = id; });

    sessionId = initRes.sessionId;
    const initialized = parseRpcResponse(initRes, 1);
    if (initialized.error)
      throw new Error(initialized.error.message || 'MCP initialization failed');
    if (!sessionId) throw new Error('MCP initialize returned no session identity');
    const ready = await postData(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    if (ready.status < 200 || ready.status >= 300)
      throw new Error(`MCP initialization notification HTTP ${ready.status}`);

    // 2. Call Tool
    requestDispatched = true;
    const callRes = await postData(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs,
        },
      },
      sessionId,
    );

    const message = parseRpcResponse(callRes, 2);
    if (message.error) {
      process.exitCode = 1;
      if (jsonOutput) console.log(JSON.stringify({ error: message.error }));
      else console.error(`Error: ${message.error.message}`);
    } else {
      const result = message.result;
      if (!Array.isArray(result.content))
        throw new Error('Invalid MCP tool result: content must be an array');
      if (result.isError) process.exitCode = 1;
      if (jsonOutput) console.log(JSON.stringify(result));
      else {
        const text = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        if (text) console.log(text.trim());
        if (result.content.some((item) => item.type !== 'text')) {
          console.error('Non-text content is available with --json; redirect it to a file.');
        }
      }
    }
  } catch (err) {
    process.exitCode = 1;
    console.error(`BrowserPaw CLI Error: ${err.message}`);
    if (jsonOutput)
      console.log(
        JSON.stringify({
          isError: true,
          error: { message: err.message },
          status: requestDispatched ? 'unknown' : 'blocked',
          requestDispatched,
          retry: false,
        }),
      );
  } finally {
    if (sessionId) await closeSession(sessionId).catch(() => {});
  }
})();
