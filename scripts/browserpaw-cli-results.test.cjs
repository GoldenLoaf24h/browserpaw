const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function fixture(t, options = {}) {
  const calls = [];
  let nextSession = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const message = body ? JSON.parse(body) : {};
      calls.push({ method: req.method, session: req.headers['mcp-session-id'], message });
      if (req.method === 'DELETE') {
        if (!options.hangDelete) {
          res.writeHead(204);
          res.end();
        }
      } else if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', `isolated-${++nextSession}`);
        res.writeHead(options.initStatus || 200, { 'Content-Type': 'application/json' });
        if (options.abortInit) {
          res.flushHeaders();
          res.write('{');
          setTimeout(() => req.socket.destroy(), 20);
        } else res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        if (options.disconnect) {
          req.socket.destroy();
          return;
        }
        res.writeHead(options.status || 200, {
          'Content-Type': options.sse ? 'text/event-stream' : 'application/json',
        });
        const reply = {
          jsonrpc: '2.0',
          id: 2,
          ...(options.error
            ? { error: options.error }
            : {
                result: options.result || { content: [{ type: 'text', text: 'ok' }] },
              }),
        };
        const payload =
          options.raw ??
          (options.sse
            ? 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n' +
              'event: message\r\n' +
              JSON.stringify(reply, null, 2)
                .split('\n')
                .map((line) => `data: ${line}`)
                .join('\r\n') +
              '\r\n\r\n'
            : JSON.stringify(reply));
        if (options.splitUnicode) {
          const bytes = Buffer.from(payload);
          const offset = bytes.indexOf(Buffer.from('中')) + 1;
          res.write(bytes.subarray(0, offset));
          setTimeout(() => res.end(bytes.subarray(offset)), 20);
        } else res.end(payload);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    calls,
    run: (args = ['--json', 'chrome_screenshot', '{}']) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve(__dirname, '../bin/browserpaw.cjs'), ...args],
          {
            env: { ...process.env, CHROME_MCP_PORT: String(server.address().port) },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('CLI did not exit'));
        }, 8000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      }),
  };
}

for (const sse of [false, true]) {
  test(`CLI preserves complete mixed results over ${sse ? 'SSE' : 'JSON'}`, async (t) => {
    const result = {
      content: [
        { type: 'text', text: '  original\n' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(256000) },
        { type: 'resource', resource: { uri: 'file:///tmp/example', text: 'original' } },
      ],
      structuredContent: { status: 'unknown', retry: false, receipt: { dispatched: true } },
      isError: true,
    };
    const f = await fixture(t, { result, sse });
    const output = await f.run();
    assert.equal(output.code, 1);
    assert.deepEqual(JSON.parse(output.stdout), result);
    assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
  });
}

test('CLI preserves text mode and supports a JSON flag before tool arguments', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['doctor'])).stdout.trim(), 'ok');
  const output = await f.run(['chrome_read_dom', '--json', '{"tabId":7}']);
  assert.equal(JSON.parse(output.stdout).content[0].text, 'ok');
  const requests = f.calls.filter((call) => call.message.method === 'tools/call');
  assert.deepEqual(requests[1].message.params.arguments, { tabId: 7 });
  assert.notEqual(requests[0].session, requests[1].session);
});

for (const options of [
  { raw: 'invalid' },
  { status: 503 },
  { disconnect: true },
  { result: { content: 'invalid' } },
  { error: { code: -32602, message: 'bad args' } },
]) {
  test(`CLI fails closed and cleans up on ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const output = await f.run();
    assert.equal(output.code, 1);
    const value = JSON.parse(output.stdout);
    assert.ok(value.error || value.isError);
    if (!options.error) {
      assert.equal(value.status, 'unknown');
      assert.equal(value.retry, false);
    }
    assert.equal(f.calls.filter((call) => call.message.method === 'tools/call').length, 1);
    assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
  });
}

test('CLI cleans up after initialization errors without dispatching a tool', async (t) => {
  const f = await fixture(t, { initStatus: 503 });
  const output = await f.run();
  assert.equal(output.code, 1);
  assert.equal(JSON.parse(output.stdout).status, 'blocked');
  assert.equal(f.calls.filter((call) => call.message.method === 'tools/call').length, 0);
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
});

test('CLI bounds cleanup and preserves the business error', async (t) => {
  const f = await fixture(t, {
    hangDelete: true,
    result: { isError: true, content: [{ type: 'text', text: 'original failure' }] },
  });
  const start = Date.now();
  const output = await f.run();
  assert.ok(Date.now() - start < 5000);
  assert.equal(output.code, 1);
  assert.equal(JSON.parse(output.stdout).content[0].text, 'original failure');
});

test('malformed JSON arguments cannot dispatch empty arguments', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['chrome_navigate', '{broken'])).code, 1);
  assert.equal(f.calls.length, 0);
});

test('CLI preserves UTF-8 characters split across response chunks', async (t) => {
  const result = { content: [{ type: 'text', text: '中文回执 🐾' }] };
  const f = await fixture(t, { result, splitUnicode: true });
  const output = await f.run();
  assert.equal(output.code, 0);
  assert.deepEqual(JSON.parse(output.stdout), result);
});

test('non-object JSON arguments cannot dispatch a tool', async (t) => {
  const f = await fixture(t);
  for (const value of ['null', '[]', '42']) {
    assert.equal((await f.run(['chrome_navigate', value])).code, 1);
  }
  assert.equal(f.calls.length, 0);
});

test('CLI releases the initialized session when the response stream breaks after headers', async (t) => {
  const f = await fixture(t, { abortInit: true });
  const output = await f.run();
  assert.equal(output.code, 1);
  assert.equal(JSON.parse(output.stdout).status, 'blocked');
  assert.equal(f.calls.filter((call) => call.message.method === 'tools/call').length, 0);
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
});
