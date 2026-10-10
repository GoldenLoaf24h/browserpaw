
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

// Creates a mock HTTP MCP server on an ephemeral dynamic port (port 0)
function createMockServer() {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-session-id': 'mock-session-ephemeral'
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { protocolVersion: '2024-11-05', capabilities: {} }
          }));
        } else if (parsed.method === 'notifications/initialized') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0' }));
        } else if (parsed.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              content: [{ type: 'text', text: 'CLI_SUCCESS_PORT_' + server.address().port }]
            }
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    server.on('error', err => reject(err));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close: () => new Promise(r => server.close(r)),
        getRequestCount: () => requestCount
      });
    });
  });
}

function runCli(env, args = ['doctor']) {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(__dirname, '../bin/browserpaw.cjs');
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', err => reject(err));
  });
}

// Intercepts http.request options inside the isolated child process to assert exact target port
// without firing outbound network requests to any active local server.
function interceptCliTargetPort(env) {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(__dirname, '../bin/browserpaw.cjs').replace(/\\/g, '/');
    const interceptScript = `
      const http = require('http');
      http.request = function(options, cb) {
        console.log('INTERCEPTED_TARGET_PORT:' + options.port);
        process.exit(0);
      };
      process.argv = [process.argv[0], '${cliPath}', 'doctor'];
      require('${cliPath}');
    `;
    const child = spawn(process.execPath, ['-e', interceptScript], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', () => {
      const match = stdout.match(/INTERCEPTED_TARGET_PORT:(\d+)/);
      if (match) {
        resolve(parseInt(match[1], 10));
      } else {
        reject(new Error('Failed to intercept CLI target port: ' + stdout + ' ' + stderr));
      }
    });
    child.on('error', err => reject(err));
  });
}

async function main() {
  console.log('--- Testing bin/browserpaw.cjs Dynamic Port Priority & Bounds ---');

  // Case 1: Custom dynamic port via CHROME_MCP_PORT
  let mock1 = null;
  try {
    mock1 = await createMockServer();
    const res1 = await runCli({ CHROME_MCP_PORT: String(mock1.port) });
    console.log('Case 1 Dynamic port ' + mock1.port + ' request count:', mock1.getRequestCount());
    assert(mock1.getRequestCount() > 0, 'Ephemeral server on ' + mock1.port + ' should receive request');
    assert(res1.stdout.includes('CLI_SUCCESS_PORT_' + mock1.port), 'CLI response should reflect dynamic port');
  } finally {
    if (mock1) await mock1.close();
  }

  // Case 2: Priority CHROME_MCP_PORT over MCP_HTTP_PORT using dynamic ephemeral ports
  let mock2A = null;
  let mock2B = null;
  try {
    mock2A = await createMockServer();
    mock2B = await createMockServer();
    await runCli({ CHROME_MCP_PORT: String(mock2A.port), MCP_HTTP_PORT: String(mock2B.port) });
    console.log('Case 2 Priority A count:', mock2A.getRequestCount(), 'B count:', mock2B.getRequestCount());
    assert(mock2A.getRequestCount() > 0, 'Higher priority CHROME_MCP_PORT must receive request');
    assert(mock2B.getRequestCount() === 0, 'Lower priority MCP_HTTP_PORT must not receive request');
  } finally {
    if (mock2A) await mock2A.close();
    if (mock2B) await mock2B.close();
  }

  // Case 3: MCP_HTTP_PORT fallback when CHROME_MCP_PORT is empty
  let mock3 = null;
  try {
    mock3 = await createMockServer();
    await runCli({ CHROME_MCP_PORT: '', MCP_HTTP_PORT: String(mock3.port) });
    console.log('Case 3 MCP_HTTP_PORT count:', mock3.getRequestCount());
    assert(mock3.getRequestCount() > 0, 'Fallback to MCP_HTTP_PORT should succeed');
  } finally {
    if (mock3) await mock3.close();
  }

  // Case 4: Precise assertion of port=12306 fallback on invalid, negative, overflow, and empty environments
  const portInvalid = await interceptCliTargetPort({ CHROME_MCP_PORT: 'invalid_port', MCP_HTTP_PORT: '' });
  console.log('Case 4 Invalid string target port:', portInvalid);
  assert.strictEqual(portInvalid, 12306, 'Invalid string should fallback to 12306');

  const portNegative = await interceptCliTargetPort({ CHROME_MCP_PORT: '-500', MCP_HTTP_PORT: '' });
  console.log('Case 4 Negative target port:', portNegative);
  assert.strictEqual(portNegative, 12306, 'Negative port should fallback to 12306');

  const portZero = await interceptCliTargetPort({ CHROME_MCP_PORT: '0', MCP_HTTP_PORT: '' });
  console.log('Case 4 Zero target port:', portZero);
  assert.strictEqual(portZero, 12306, 'Zero port (0) should fallback to 12306');

  const portOverflow = await interceptCliTargetPort({ CHROME_MCP_PORT: '75000', MCP_HTTP_PORT: '' });
  console.log('Case 4 Overflow target port:', portOverflow);
  assert.strictEqual(portOverflow, 12306, 'Overflow port (>65535) should fallback to 12306');

  const portDefault = await interceptCliTargetPort({ CHROME_MCP_PORT: '', MCP_HTTP_PORT: '' });
  console.log('Case 4 Default target port:', portDefault);
  assert.strictEqual(portDefault, 12306, 'Default target port should strictly be 12306');

  console.log('ALL CLI PORT INTERCEPTION & EPHEMERAL TESTS PASSED!');
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
