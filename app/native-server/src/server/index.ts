import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCommand, CURRENT_VERSION } from 'chrome-mcp-shared';
import type { NativeMessagingHost } from '../native-messaging-host';
import { CommandError, dispatchCommand } from '../command-dispatch';
import { tryParseCallResult } from '../browser-tasks';
import { initializeBridgeToken, isValidBridgeToken, TOKEN_DIR } from './token';

export { getBridgeToken, isValidBridgeToken } from './token';

function send(reply: ServerResponse, code: number, payload: unknown) {
  if (reply.destroyed || reply.writableEnded) return;
  reply.writeHead(code, { 'content-type': 'application/json' });
  reply.end(JSON.stringify(payload));
}

async function body(request: IncomingMessage) {
  const max = 8 * 1024 * 1024;
  if (Number(request.headers['content-length']) > max)
    throw new CommandError('Request body is too large.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new CommandError('Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CommandError('Expected a JSON request object.');
  }
}

export class Server {
  private host: NativeMessagingHost | null = null;
  private starting?: Promise<void>;
  private readonly requests = new Map<string, AbortController>();
  private readonly context = new Set<string>();
  private readonly discoveryPath = join(TOKEN_DIR, 'host.json');
  private readonly server = createServer((request, reply) => {
    void this.dispatch(request, reply).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CommandError) send(reply, 400, { code: error.code, message });
      else send(reply, 500, { code: 'command_failed', message });
    });
  });

  get isRunning() {
    return this.server.listening;
  }

  get port() {
    const address = this.server.address();
    return address && typeof address !== 'string' ? address.port : undefined;
  }

  setNativeHost(host: NativeMessagingHost) {
    this.host = host;
  }

  async start(port: number, host: NativeMessagingHost): Promise<void> {
    if (this.isRunning) return;
    if (this.starting) return this.starting;
    this.host = host;
    this.starting = (async () => {
      await initializeBridgeToken();
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(port, '127.0.0.1', () => {
          this.server.removeListener('error', reject);
          resolve();
        });
      });
      const temporary = this.discoveryPath + '.' + process.pid + '.tmp';
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            port: this.port,
            pid: process.pid,
            version: CURRENT_VERSION,
            protocol: 1,
          }),
          { flag: 'wx', mode: 0o600 },
        );
        await rename(temporary, this.discoveryPath);
      } catch (error) {
        await this.stop();
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async stop(): Promise<void> {
    for (const request of this.requests.values()) request.abort();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private async dispatch(request: IncomingMessage, reply: ServerResponse) {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${this.port}` || request.headers.origin)
      return send(reply, 403, { code: 'forbidden', message: 'Use the local BrowserPaw CLI.' });
    if (request.method === 'GET' && request.url === '/ping')
      return send(reply, 200, { status: 'ok' });
    const token = request.headers['x-browserpaw-token'];
    if (typeof token !== 'string' || !isValidBridgeToken(token))
      return send(reply, 401, {
        code: 'unauthorized',
        message: 'Local BrowserPaw credentials are invalid.',
      });

    if (request.method === 'GET' && request.url === '/v1/status') {
      const connected = this.host?.isConnected === true;
      const extension = connected
        ? tryParseCallResult(
            await dispatchCommand(
              { name: 'doctor', operands: [], options: {} },
              AbortSignal.timeout(2500),
            ),
          )
        : undefined;
      return send(reply, 200, {
        protocol: 1,
        version: CURRENT_VERSION,
        connected,
        pid: process.pid,
        port: this.port,
        extension,
      });
    }
    if (request.method !== 'POST') return send(reply, 404, { code: 'not_found' });
    if (request.url === '/v1/restart') {
      if (this.requests.size)
        return send(reply, 409, { message: 'Browser commands are in flight.' });
      const host = this.host;
      if (!host?.isConnected)
        return send(reply, 503, { message: 'Browser extension is disconnected.' });
      reply.once('finish', () => {
        void host
          .sendRequestToExtensionAndWait({}, 'reload_extension', 2000)
          .catch((error: unknown) => {
            console.error('Extension reload was not acknowledged:', error);
          });
      });
      return send(reply, 202, { reloadRequested: true });
    }
    if (request.url !== '/v1/run' && request.url !== '/v1/cancel')
      return send(reply, 404, { code: 'not_found' });
    const { requestId, argv, input } = await body(request);
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId))
      throw new CommandError('Expected a valid request ID.');
    if (request.url === '/v1/cancel') {
      const controller = this.requests.get(requestId);
      controller?.abort();
      return send(reply, 200, { cancelled: Boolean(controller) });
    }
    if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string'))
      throw new CommandError('Expected a CLI argument array.');
    let command;
    try {
      command = parseCommand(argv);
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
    const key = command.options.task
      ? `task:${command.options.task}`
      : command.options.tab
        ? `tab:${command.options.tab}`
        : undefined;
    if (this.requests.has(requestId) || (key && this.context.has(key)))
      return send(reply, 409, {
        code: 'busy',
        message: 'A command is already running for this page or task.',
      });
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.requests.set(requestId, controller);
    if (key) this.context.add(key);
    reply.once('close', abort);
    try {
      const result = await dispatchCommand(command, controller.signal, input);
      send(reply, 200, { result });
    } finally {
      reply.removeListener('close', abort);
      this.requests.delete(requestId);
      if (key) this.context.delete(key);
    }
  }
}

export default new Server();
