const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');

const cliPath = path.resolve(__dirname, '../bin/browserpaw.cjs');

function runCli(port, home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, BROWSERPAW_HOME: home, CHROME_MCP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI did not exit'));
    }, 10000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function createFixture(t, options = {}) {
  const calls = [];
  const sessions = new Set();
  let nextSession = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = body ? JSON.parse(body) : {};
      const session = request.headers['mcp-session-id'];
      calls.push({ method: request.method, session, message });
      if (session && !sessions.has(session)) {
        response.writeHead(404);
        response.end('expired');
        return;
      }
      if (request.method === 'DELETE') {
        if (options.hangDelete) return;
        sessions.delete(session);
        response.writeHead(204);
        response.end();
        return;
      }
      if (message.method === 'initialize') {
        const id = `session-${++nextSession}`;
        sessions.add(id);
        response.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': id });
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }),
        );
        return;
      }
      if (message.method === 'notifications/initialized') {
        if (options.rejectHandshake) options.beforeReply?.();
        response.writeHead(options.rejectHandshake ? 400 : 202);
        response.end();
        return;
      }
      if (message.method === 'ping') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        return;
      }
      const result = options.result || { content: [{ type: 'text', text: 'ok' }] };
      options.beforeReply?.();
      if (options.disconnect) {
        request.socket.destroy();
        return;
      }
      const reply = {
        jsonrpc: '2.0',
        id: message.id,
        ...(options.error ? { error: options.error } : { result }),
      };
      response.writeHead(200, {
        'Content-Type': options.sse ? 'text/event-stream' : 'application/json',
      });
      response.end(
        options.sse ? `event: message\ndata: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply),
      );
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        calls,
        expire() {
          sessions.clear();
        },
      }),
    );
  });
}

test('named CLI sessions reuse MCP identity and close explicitly', async (t) => {
  const fixture = await createFixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const created = await runCli(fixture.port, home, ['session', 'create', 'work', '--json']);
  assert.equal(created.code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(home, 'cli-sessions', 'work.json'), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt',
    'lastUsedAt',
    'name',
    'port',
    'sessionId',
  ]);

  const first = await runCli(fixture.port, home, [
    'session',
    'call',
    'work',
    'chrome_read_dom',
    '{}',
    '--json',
  ]);
  const second = await runCli(fixture.port, home, [
    '--session',
    'work',
    'chrome_read_dom',
    '{}',
    '--json',
  ]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const calls = fixture.calls.filter(({ message }) => message.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session, record.sessionId);
  assert.equal(calls[1].session, record.sessionId);
  assert.equal(fixture.calls.filter(({ method }) => method === 'DELETE').length, 0);

  const status = await runCli(fixture.port, home, ['session', 'status', 'work', '--json']);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).status, 'active');
  const closed = await runCli(fixture.port, home, ['session', 'close', 'work', '--json']);
  assert.equal(closed.code, 0);
  assert.equal(fixture.calls.filter(({ method }) => method === 'DELETE').length, 1);
  assert.equal(fs.existsSync(path.join(home, 'cli-sessions', 'work.json')), false);
});

test('expired named sessions fail without a new initialize or replay', async (t) => {
  const fixture = await createFixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-expired-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  fixture.expire();
  const before = fixture.calls.length;
  const result = await runCli(fixture.port, home, [
    'session',
    'call',
    'work',
    'chrome_read_dom',
    '{}',
    '--json',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /session_expired/);
  assert.equal(
    fixture.calls.slice(before).filter(({ message }) => message.method === 'initialize').length,
    0,
  );
  assert.equal(
    fixture.calls.slice(before).filter(({ message }) => message.method === 'tools/call').length,
    1,
  );
});

test('artifacts mode writes raw result and hashed media references', async (t) => {
  const bytes = Buffer.from('browserpaw-media');
  const fixture = await createFixture(t, {
    result: {
      content: [
        { type: 'text', text: 'receipt' },
        { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
      ],
      structuredContent: { status: 'ok' },
    },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-artifact-home-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-artifact-output-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });

  const result = await runCli(fixture.port, home, [
    '--artifacts',
    output,
    'chrome_screenshot',
    '{}',
  ]);
  assert.equal(result.code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  const reference = manifest.content.find((item) => item.type === 'artifact_ref');
  assert.deepEqual(raw.content[1].data, bytes.toString('base64'));
  assert.equal(fs.readFileSync(reference.path).toString(), bytes.toString());
  assert.equal(reference.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.stdout.includes(bytes.toString('base64')), false);
});

test('session calls can deliver resource blobs through artifacts', async (t) => {
  const bytes = Buffer.from('browserpaw-resource');
  const fixture = await createFixture(t, {
    result: {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///result.bin',
            blob: bytes.toString('base64'),
            mimeType: 'application/octet-stream',
          },
        },
      ],
    },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-artifact-home-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-artifact-output-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });

  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  const result = await runCli(fixture.port, home, [
    'session',
    'call',
    'work',
    'chrome_screenshot',
    '{}',
    '--artifacts',
    output,
  ]);
  assert.equal(result.code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  const reference = manifest.content[0];
  assert.equal(reference.type, 'artifact_ref');
  assert.equal(fs.readFileSync(reference.path).toString(), bytes.toString());
});

test('invalid session names are rejected before any MCP request', async (t) => {
  const fixture = await createFixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-invalid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runCli(fixture.port, home, ['session', 'create', '../bad']);
  assert.equal(result.code, 1);
  assert.equal(fixture.calls.length, 0);
});

test('active named session locks reject concurrent calls before dispatch', async (t) => {
  const fixture = await createFixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-session-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  const lock = path.join(home, 'cli-sessions', 'work.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const result = await runCli(fixture.port, home, [
    'session',
    'call',
    'work',
    'chrome_read_dom',
    '{}',
    '--json',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Session busy/);
  assert.equal(fixture.calls.filter(({ message }) => message.method === 'tools/call').length, 0);
});

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-rc-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

for (const sse of [false, true]) {
  test(`artifacts externalize large images, duplicate payloads, audio and text over ${sse ? 'SSE' : 'JSON'}`, async (t) => {
    const image = Buffer.alloc(450000, 97).toString('base64');
    const result = {
      content: [
        { type: 'text', text: JSON.stringify({ success: true, base64Data: image }) },
        { type: 'image', mimeType: 'image/jpeg', data: image },
        { type: 'audio', mimeType: 'audio/wav', data: Buffer.from('audio').toString('base64') },
        { type: 'text', text: '中'.repeat(4000) },
        { type: 'resource', resource: { uri: 'file:///text', text: 'r'.repeat(5000) } },
      ],
      structuredContent: {
        status: 'unknown',
        retry: false,
        base64Data: image,
        receipt: { dispatched: true },
      },
      isError: true,
    };
    const fixture = await createFixture(t, { result, sse });
    const output = temporary(t);
    const response = await runCli(fixture.port, temporary(t), [
      '--artifacts',
      output,
      'chrome_screenshot',
      '{}',
    ]);
    assert.equal(response.code, 1);
    const raw = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
    assert.deepEqual(raw, result);
    const manifest = JSON.parse(response.stdout);
    assert.equal(
      manifest.content.every((block) => block.type === 'artifact_ref'),
      true,
    );
    assert.equal(response.stdout.includes(image), false);
    assert.equal(manifest.structuredContent.status, 'unknown');
    assert.equal(manifest.structuredContent.retry, false);
    assert.equal(fs.readFileSync(manifest.content[1].path).length, 450000);
    assert.equal(manifest.content[3].bytes, 12000);
  });
}

test('artifact extraction failure keeps the complete business error and returns a machine receipt', async (t) => {
  const result = {
    isError: true,
    content: [
      { type: 'text', text: 'original failure' },
      { type: 'image', mimeType: 'image/png', data: '!invalid!' },
    ],
  };
  const fixture = await createFixture(t, { result });
  const output = temporary(t);
  const response = await runCli(fixture.port, temporary(t), [
    '--artifacts',
    output,
    'chrome_screenshot',
    '{}',
  ]);
  assert.equal(response.code, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')), result);
  assert.equal(JSON.parse(response.stdout).isError, true);
  assert.equal(JSON.parse(response.stdout).resultPath, path.join(output, 'result.json'));
  assert.match(response.stderr, /Artifact delivery failed/);
  assert.equal(fixture.calls.filter(({ message }) => message.method === 'tools/call').length, 1);
});

test('artifact write failures print a receipt with the actual dispatch and recovery state', async (t) => {
  for (const [blockedFile, rejectHandshake] of [
    ['result.json', false],
    ['manifest.json', false],
    ['manifest.json', true],
  ]) {
    const output = temporary(t);
    const blockWrite = () => fs.mkdirSync(path.join(output, blockedFile));
    const fixture = await createFixture(t, {
      rejectHandshake,
      beforeReply: blockWrite,
    });
    const response = await runCli(fixture.port, temporary(t), [
      '--artifacts',
      output,
      'chrome_read_dom',
      '{}',
    ]);
    assert.equal(response.code, 1);
    const receipt = JSON.parse(response.stdout);
    assert.equal(receipt.requestDispatched, !rejectHandshake);
    assert.equal(receipt.retry, false);
    assert.equal(
      receipt.resultPath,
      blockedFile === 'manifest.json' ? path.join(output, 'result.json') : undefined,
    );
    assert.equal(
      fixture.calls.filter(({ message }) => message.method === 'tools/call').length,
      rejectHandshake ? 0 : 1,
    );
    assert.match(response.stderr, /Artifact delivery failed/);
  }
});

test('protocol and network errors retain artifact receipts without replay', async (t) => {
  for (const options of [
    { error: { code: -32602, message: 'original protocol error' } },
    { disconnect: true },
  ]) {
    const fixture = await createFixture(t, options);
    const output = temporary(t);
    const response = await runCli(fixture.port, temporary(t), [
      '--artifacts',
      output,
      'chrome_read_dom',
      '{}',
    ]);
    assert.equal(response.code, 1);
    const raw = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
    assert.ok(raw.error);
    if (options.error) assert.deepEqual(raw.error, options.error);
    else assert.equal(raw.retry, false);
    assert.equal(fixture.calls.filter(({ message }) => message.method === 'tools/call').length, 1);
  }
});

test('artifact preflight refuses reuse or junctions before dispatch', async (t) => {
  const fixture = await createFixture(t);
  const output = temporary(t);
  fs.writeFileSync(path.join(output, 'result.json'), 'preserved');
  const response = await runCli(fixture.port, temporary(t), [
    '--artifacts',
    output,
    'chrome_screenshot',
    '{}',
  ]);
  assert.equal(response.code, 1);
  assert.equal(JSON.parse(response.stdout).requestDispatched, false);
  assert.equal(fs.readFileSync(path.join(output, 'result.json'), 'utf8'), 'preserved');
  const link = path.join(temporary(t), 'linked');
  fs.symlinkSync(output, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(
    (
      await runCli(fixture.port, temporary(t), [
        '--artifacts',
        link,
        'chrome_screenshot',
        '{}',
        '--json',
      ])
    ).code,
    1,
  );
  assert.equal(fixture.calls.length, 0);
});

test('fill aliases preserve option-like literal input values', async (t) => {
  const fixture = await createFixture(t);
  const home = temporary(t);
  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  for (const prefix of [[], ['--session', 'work'], ['session', 'call', 'work']]) {
    const before = fixture.calls.length;
    const rejected = await runCli(fixture.port, home, [
      ...prefix,
      'fill',
      '2',
      '--artifacts',
      temporary(t),
    ]);
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.stdout).requestDispatched, false);
    assert.equal(fixture.calls.length, before);
    for (const [args, text] of [
      [['--json'], '--json'],
      [[''], ''],
      [['--', '--artifacts'], '--artifacts'],
    ]) {
      const response = await runCli(fixture.port, home, [...prefix, 'fill', '2', ...args]);
      assert.equal(response.code, 0, response.stderr);
      assert.equal(
        fixture.calls.findLast(({ message }) => message.method === 'tools/call').message.params
          .arguments.text,
        text,
      );
    }
  }
  assert.equal((await runCli(fixture.port, home, ['session', 'close', 'work'])).code, 0);
});

test('session closure bounds release timeout and expired sessions can be removed', async (t) => {
  const home = temporary(t);
  const fixture = await createFixture(t, { hangDelete: true });
  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  const duplicate = await runCli(fixture.port, home, ['session', 'create', 'work', '--json']);
  assert.equal(duplicate.code, 1);
  const began = Date.now();
  assert.equal((await runCli(fixture.port, home, ['session', 'close', 'work', '--json'])).code, 1);
  assert.ok(Date.now() - began < 5000);
  assert.equal(fs.existsSync(path.join(home, 'cli-sessions', 'work.json')), false);
  assert.equal((await runCli(fixture.port, home, ['session', 'create', 'work'])).code, 0);
  fixture.expire();
  const status = await runCli(fixture.port, home, ['session', 'status', 'work', '--json']);
  assert.equal(JSON.parse(status.stdout).status, 'expired');
  assert.equal((await runCli(fixture.port, home, ['session', 'close', 'work', '--json'])).code, 0);
});

test('stale lock recovery admits one concurrent owner', { timeout: 10000 }, async (t) => {
  const directory = temporary(t);
  const target = path.join(directory, 'shared.lock');
  fs.writeFileSync(
    target,
    JSON.stringify({ pid: 2147483647, token: 'stale', createdAt: new Date().toISOString() }),
  );
  const script = `
    const { acquireLock } = require(${JSON.stringify(path.resolve(__dirname, '../app/native-server/src/cli-files.cjs'))});
    process.channel.ref();
    process.once('message', () => {
      try {
        const release = acquireLock(process.argv[1]);
        process.once('message', () => { release(); process.disconnect(); });
        process.send('acquired');
      } catch (error) {
        process.send(error.message);
        process.disconnect();
      }
    });
  `;
  const children = Array.from({ length: 6 }, () =>
    spawn(process.execPath, ['-e', script, target], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  );
  t.after(() =>
    children.forEach((child) => {
      if (child.exitCode === null) child.kill();
    }),
  );
  const exits = children.map((child) => once(child, 'exit'));
  const responses = children.map((child) => once(child, 'message'));
  children.forEach((child) => child.send('start'));
  const results = (await Promise.all(responses)).map(([message]) => message);
  assert.equal(results.filter((result) => result === 'acquired').length, 1);
  assert.equal(results.filter((result) => /Session busy/.test(result)).length, 5);
  children[results.indexOf('acquired')].send('release');
  await Promise.all(exits);
  assert.equal(fs.existsSync(target), false);
});
