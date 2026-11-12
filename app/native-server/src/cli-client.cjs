const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { openSessionStore } = require('./cli-session.cjs');
const {
  prepareArtifactDirectory,
  writeArtifactResult,
  writeArtifactFailure,
} = require('./cli-artifacts.cjs');

const CLI_HELP = `BrowserPaw CLI
Usage:
  browserpaw [--json] [--port <port>] <tool_name> [json_args_or_key_val...]
  browserpaw session create <name> [--port <port>] [--json]
  browserpaw session call <name> <tool_name> [json_args_or_key_val...] [--json] [--artifacts <dir>]
  browserpaw --session <name> <tool_name> [json_args_or_key_val...] [--json] [--artifacts <dir>]
  browserpaw session status <name> [--json]
  browserpaw session close <name> [--json]
  browserpaw repl [--port <port>]
  browserpaw skill install [--target <skills-root>] [--force]
  browserpaw doctor [--verbose] [--json]
  browserpaw doctor --fix | --browser <browser> (Native installation diagnostics)
  browserpaw register | fix-permissions | update-port | report (Native management)
  browserpaw nav <url> | click <index> | fill <index> <text> | dom [deltaOnly]

Each one-shot command opens and closes its own MCP session.
Named sessions reuse the Native session, expiring after ten minutes without calls or status pings.
Finish tasks explicitly before closing a session. Expired sessions never reconnect or take over automatically.
--json preserves complete MCP results. --artifacts <empty-dir> saves result.json and media files,
and prints manifest.json with file references. Use a new directory for each call.
`;

function isManagementCommand(args) {
  const remaining = args[0] === '--json' ? args.slice(1) : args;
  return (
    [
      'register',
      'fix-permissions',
      'update-port',
      'report',
      'repl',
      'skill',
      '--version',
      '-V',
    ].includes(remaining[0]) ||
    (remaining[0] === 'doctor' &&
      remaining.some(
        (arg) =>
          arg === '--fix' || arg === '-b' || arg === '--browser' || arg.startsWith('--browser='),
      ))
  );
}

function parseOptions(args) {
  const options = { positional: [], json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const command = options.positional[0];
    const alias = options.session
      ? options.positional[0]
      : command === 'session' && options.positional[1] === 'call'
        ? options.positional[3]
        : command;
    const literal =
      arg === '--json' &&
      alias === 'fill' &&
      options.positional.at(-1) !== undefined &&
      ((options.session && options.positional.length === 2) ||
        (!options.session && command === 'fill' && options.positional.length === 2) ||
        (!options.session && command === 'session' && options.positional.length === 5) ||
        (options.session && options.positional.length === 2));
    if (arg === '--') {
      options.positional.push(...args.slice(index + 1));
      break;
    }
    if (literal) options.positional.push(arg);
    else if (arg === '--json') options.json = true;
    else if (['--session', '--port', '--artifacts'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = arg.slice(2);
      if (options[key] !== undefined) throw new Error(`Repeated option: ${arg}`);
      options[key] = value;
    } else options.positional.push(arg);
  }
  return options;
}

function resolvePort(explicit) {
  if (explicit !== undefined) {
    if (!/^\d+$/.test(explicit) || Number(explicit) < 1 || Number(explicit) > 65535)
      throw new Error('Port must be an integer between 1 and 65535');
    return Number(explicit);
  }
  const raw = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  const port = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 12306;
}

function parseTool(command, rest) {
  if (!command) throw new Error('A tool name is required');
  if (['nav', 'navigate', 'goto'].includes(command))
    return ['chrome_navigate', { url: rest[0] || 'https://google.com' }];
  if (command === 'click' || command === 'fill') {
    if (!/^\d+$/.test(rest[0] || '') || Number(rest[0]) < 1)
      throw new Error('Index must be a positive integer');
    return command === 'click'
      ? ['chrome_interact_index', { index: Number(rest[0]), action: 'click' }]
      : ['chrome_fill_index', { index: Number(rest[0]), text: rest[1] || '' }];
  }
  if (command === 'dom' || command === 'read')
    return ['chrome_read_dom', { deltaOnly: ['true', 'delta'].includes(rest[0]) }];
  if (command === 'doctor')
    return ['chrome_doctor', { verbose: rest.includes('--verbose') || rest.includes('-v') }];
  let toolArgs = {};
  if (rest.length) {
    try {
      toolArgs = JSON.parse(rest.join(' '));
    } catch {
      if (/^\s*[[{]/.test(rest[0])) throw new Error('Invalid JSON arguments');
      for (const value of rest) {
        const separator = value.indexOf('=');
        if (separator < 1) throw new Error('Expected a JSON object or key=value arguments');
        Object.defineProperty(toolArgs, value.slice(0, separator), {
          value: value.slice(separator + 1),
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs))
    throw new Error('Tool arguments must be a JSON object');
  return [command, toolArgs];
}

function parseRpcResponse(response, id) {
  if (response.status !== 200)
    throw Object.assign(new Error(`MCP HTTP ${response.status}`), { httpStatus: response.status });
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

function createTransport(port) {
  let token = '';
  const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
  if (fs.existsSync(tokenPath)) token = fs.readFileSync(tokenPath, 'utf8').trim();
  function request(method, payload, sessionId, onSession, timeoutMs = 360000) {
    return new Promise((resolve, reject) => {
      const data = payload === undefined ? '' : JSON.stringify(payload);
      const headers = { Accept: 'application/json, text/event-stream', Connection: 'close' };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      if (token) headers['x-mcp-token'] = token;
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/mcp', method, headers },
        (res) => {
          let body = '';
          if (onSession && typeof res.headers['mcp-session-id'] === 'string')
            onSession(res.headers['mcp-session-id']);
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
              sessionId: res.headers['mcp-session-id'] || sessionId,
            }),
          );
          res.on('close', () => clearTimeout(timer));
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error('MCP request timed out; do not replay uncertain actions')),
        timeoutMs,
      );
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end(data);
    });
  }
  return {
    post: (payload, sessionId, onSession) => request('POST', payload, sessionId, onSession),
    async close(sessionId) {
      const response = await request('DELETE', undefined, sessionId, undefined, 1500);
      if (!(response.status >= 200 && response.status < 300) && response.status !== 404)
        throw new Error(`MCP cleanup HTTP ${response.status}`);
    },
  };
}

async function initialize(transport, onSession) {
  const response = await transport.post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browserpaw-cli', version: '4.2.0' },
      },
    },
    undefined,
    onSession,
  );
  const initialized = parseRpcResponse(response, 1);
  if (initialized.error)
    throw Object.assign(new Error(initialized.error.message || 'MCP initialization failed'), {
      result: { error: initialized.error },
    });
  if (!response.sessionId) throw new Error('MCP initialize returned no session identity');
  const ready = await transport.post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    response.sessionId,
  );
  if (ready.status < 200 || ready.status >= 300)
    throw new Error(`MCP initialization notification HTTP ${ready.status}`);
  return response.sessionId;
}

function emit(result, json, artifacts) {
  if (artifacts) {
    try {
      console.log(JSON.stringify(writeArtifactResult(artifacts.root, result)));
    } catch (error) {
      console.log(JSON.stringify(writeArtifactFailure(artifacts.root, error)));
      throw error;
    }
  } else if (json) console.log(JSON.stringify(result));
  else if (Array.isArray(result.content)) {
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (text) console.log(text.trim());
    if (result.content.some((item) => item.type !== 'text'))
      console.error('Non-text content is available with --artifacts <empty-dir> or --json.');
  } else if (result.error) console.error(`Error: ${result.error.message}`);
  else console.log(JSON.stringify(result));
}

async function runBrowserCli(args, { nativeCli } = {}) {
  if (isManagementCommand(args) && nativeCli) {
    if (!fs.existsSync(nativeCli)) {
      console.error(
        `BrowserPaw native CLI not found at ${nativeCli}. Please build the project first.`,
      );
      process.exitCode = 1;
      return;
    }
    if (args[0] === '--json') args = [...args.slice(1), '--json'];
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [nativeCli, ...args], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
        resolve();
      });
      child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
        resolve();
      });
    });
    return;
  }
  let options = { json: args.includes('--json') || args.includes('--artifacts') };
  let artifacts, store, transport, ownedSession, result;
  let requestDispatched = false;
  try {
    const parsed = parseOptions(args);
    options = { ...options, ...parsed, json: parsed.json || Boolean(parsed.artifacts) };
    if (!options.positional.length || ['--help', '-h', 'help'].includes(options.positional[0])) {
      console.log(CLI_HELP);
      return;
    }
    if (options.session) {
      if (options.positional[0] === 'session')
        throw new Error('Use either --session or the session subcommand');
      options.positional = ['session', 'call', options.session, ...options.positional];
    }
    const [command, ...rest] = options.positional;
    const action = command === 'session' ? rest[0] : undefined;
    if (action && !['create', 'call', 'status', 'close'].includes(action))
      throw new Error('Expected session create, call, status or close');
    if (command === 'session' && !action) throw new Error('A session action is required');
    if (action && options.port !== undefined && action !== 'create')
      throw new Error(
        '--port is only accepted when creating a session; calls use its recorded port',
      );
    if (action && action !== 'call' && (rest.length !== 2 || options.artifacts))
      throw new Error('Session management requires one name and does not accept --artifacts');
    const tool = !action
      ? parseTool(command, rest)
      : action === 'call'
        ? parseTool(rest[2], rest.slice(3))
        : undefined;
    if (options.artifacts) artifacts = prepareArtifactDirectory(options.artifacts);
    let record;
    if (action) {
      store = openSessionStore(rest[1]);
      record = store.read();
      if (action === 'create' && record)
        throw new Error(
          'Session already exists; inspect status and close it explicitly before recreating it.',
        );
      if (action !== 'create' && !record) {
        if (action === 'call') throw new Error('CLI session missing; create a session explicitly.');
        result = { name: rest[1], status: 'missing' };
        process.exitCode = 1;
      }
    }
    if (!result) {
      const port = record?.port ?? resolvePort(options.port);
      transport = createTransport(port);
      if (action === 'close') {
        try {
          await transport.close(record.sessionId);
          result = { name: record.name, status: 'closed' };
        } finally {
          store.remove();
        }
      } else if (action === 'status') {
        const response = await transport.post(
          { jsonrpc: '2.0', id: 3, method: 'ping' },
          record.sessionId,
        );
        if (response.status === 404) {
          result = { name: record.name, status: 'expired' };
          process.exitCode = 1;
        } else {
          const message = parseRpcResponse(response, 3);
          if (message.error)
            throw Object.assign(new Error(message.error.message), {
              result: { error: message.error },
            });
          record.lastUsedAt = new Date().toISOString();
          store.write(record);
          result = { name: record.name, status: 'active', port, lastUsedAt: record.lastUsedAt };
        }
      } else {
        let sessionId = record?.sessionId;
        if (!sessionId)
          sessionId = await initialize(transport, (id) => {
            ownedSession = id;
          });
        if (action === 'create') {
          const now = new Date().toISOString();
          store.write({ name: rest[1], sessionId, port, createdAt: now, lastUsedAt: now });
          ownedSession = undefined;
          result = { name: rest[1], status: 'active', port, createdAt: now, lastUsedAt: now };
        } else {
          requestDispatched = true;
          const response = await transport.post(
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: tool[0], arguments: tool[1] },
            },
            sessionId,
          );
          if (action === 'call' && response.status === 404) {
            requestDispatched = false;
            throw new Error(
              'session_expired: Native session is missing or expired; do not replay actions or automatically take over tasks.',
            );
          }
          const message = parseRpcResponse(response, 2);
          result = message.error ? { error: message.error } : message.result;
          if (!message.error && !Array.isArray(result.content))
            throw new Error('Invalid MCP tool result: content must be an array');
          if (record) {
            record.lastUsedAt = new Date().toISOString();
            try {
              store.write(record);
            } catch (error) {
              console.error(`CLI session timestamp update failed: ${error.message}`);
            }
          }
          if (message.error || result.isError) process.exitCode = 1;
        }
      }
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(`BrowserPaw CLI Error: ${error.message}`);
    result = error.result || {
      isError: true,
      error: { message: error.message },
      status: requestDispatched ? 'unknown' : 'blocked',
      requestDispatched,
      retry: false,
    };
  } finally {
    if (ownedSession) {
      try {
        await transport.close(ownedSession);
      } catch (error) {
        console.error(`MCP session cleanup failed: ${error.message}`);
      }
    }
    if (result) {
      try {
        emit(result, options.json, artifacts);
      } catch (error) {
        process.exitCode = 1;
        console.error(
          `Artifact delivery failed: ${error.message}. Preserve the result directory; do not replay the browser action.`,
        );
      }
    }
    try {
      artifacts?.release();
    } catch (error) {
      process.exitCode = 1;
      console.error(`Artifact lock cleanup failed: ${error.message}`);
    }
    try {
      store?.release();
    } catch (error) {
      process.exitCode = 1;
      console.error(`CLI session lock cleanup failed: ${error.message}`);
    }
  }
}

module.exports = { runBrowserCli, isManagementCommand };
