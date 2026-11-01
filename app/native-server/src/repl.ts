import * as repl from 'node:repl';
import { URL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResult, ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_SERVER_PORT } from 'chrome-mcp-shared';
import { readBridgeToken } from './server/token';
import { createBrowserApi, type BrowserApi } from './browser-api';

import { loadSiteNote, SiteNoteResult } from './site-notes';
export { SiteNoteResult } from './site-notes';

export interface ReplToolCallResult extends CallToolResult {
  text?: string;
  data?: unknown;
}

export interface ReplCallOptions {
  signal?: AbortSignal;
}

export interface ReplMcpContext extends BrowserApi {
  call: (
    name: string,
    args?: Record<string, unknown>,
    options?: ReplCallOptions,
  ) => Promise<ReplToolCallResult>;
  tools: () => Promise<Tool[]>;
  notes: (url: string) => Promise<SiteNoteResult>;
}

export interface ReplOptions {
  port?: number | string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  terminal?: boolean;
  prompt?: string;
  silent?: boolean;
  client?: Client;
}

interface SkillNoteSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  verifiedAt?: string;
  status?: string;
}

function noteHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.hostname.toLowerCase().replace(/\.$/, '')
      : '';
  } catch {
    return '';
  }
}

function activeSkillSummary(value: unknown): SkillNoteSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.version !== 'number' ||
    !Number.isInteger(candidate.version) ||
    candidate.version <= 0 ||
    (candidate.status !== undefined && candidate.status !== 'active')
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    version: candidate.version,
    name:
      typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : candidate.id,
    description: typeof candidate.description === 'string' ? candidate.description.trim() : '',
    ...(typeof candidate.verifiedAt === 'string' ? { verifiedAt: candidate.verifiedAt } : {}),
    ...(typeof candidate.status === 'string' ? { status: candidate.status } : {}),
  };
}

function skillSummaryNote(hostname: string, skill: SkillNoteSummary): SiteNoteResult {
  const description = skill.description || skill.name;
  const truncated = description.length > 3500;
  const summary = truncated ? `${description.slice(0, 3500)}...` : description;
  const verifiedAt = skill.verifiedAt || 'unverified';
  const verifiedDate = skill.verifiedAt ? new Date(skill.verifiedAt) : null;
  const isStale =
    !verifiedDate ||
    Number.isNaN(verifiedDate.getTime()) ||
    Date.now() - verifiedDate.getTime() > 90 * 86400 * 1000;
  return {
    hostname,
    found: true,
    source: `skill:${skill.id}@${skill.version}`,
    content:
      `${summary}\n\nVerified: ${verifiedAt}\n` +
      `Call mcp.skills.get('${skill.id}', ${skill.version}) only when the full verified recipe is needed.`,
    truncated,
    isStale,
    ...(isStale
      ? { warning: 'Skill verification date is missing, invalid, or older than 90 days.' }
      : {}),
  };
}

export function assertLocalBridgeUrl(targetUrl: URL): void {
  if (
    targetUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(targetUrl.hostname) ||
    targetUrl.username ||
    targetUrl.password
  ) {
    throw new Error('BrowserPaw credentials may only be sent to a local HTTP bridge.');
  }
}

export function parseStrictPort(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 1 && raw <= 65535) {
      return raw;
    }
    return null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const num = Number(trimmed);
    if (Number.isInteger(num) && num >= 1 && num <= 65535) {
      return num;
    }
    return null;
  }
  return null;
}

export function resolveReplTargetUrl(overridePort?: number | string): URL {
  if (overridePort !== undefined && overridePort !== null) {
    const parsed = parseStrictPort(overridePort);
    if (parsed === null) {
      throw new Error(
        `Invalid port: ${overridePort}. Port must be an integer between 1 and 65535.`,
      );
    }
    const targetUrl = new URL(`http://127.0.0.1:${parsed}/mcp`);
    assertLocalBridgeUrl(targetUrl);
    return targetUrl;
  }

  const envPortRaw = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  if (envPortRaw) {
    const parsed = parseStrictPort(envPortRaw);
    if (parsed === null) {
      throw new Error(
        `Invalid port in environment: "${envPortRaw}". Port must be an integer between 1 and 65535.`,
      );
    }
    const targetUrl = new URL(`http://127.0.0.1:${parsed}/mcp`);
    assertLocalBridgeUrl(targetUrl);
    return targetUrl;
  }

  try {
    const configPath = path.join(__dirname, 'mcp', 'stdio-config.json');
    if (fs.existsSync(configPath)) {
      const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsedConfig?.url) {
        const configUrl = new URL(parsedConfig.url);
        assertLocalBridgeUrl(configUrl);
        return configUrl;
      }
    }
  } catch (err: any) {
    if (err.message && err.message.includes('BrowserPaw credentials')) {
      throw err;
    }
  }

  const targetUrl = new URL(`http://127.0.0.1:${DEFAULT_SERVER_PORT}/mcp`);
  assertLocalBridgeUrl(targetUrl);
  return targetUrl;
}

const OWNED_SESSION_CLOSE_MS = 1000;
export const REPL_SESSION_KEEPALIVE_MS = 4 * 60 * 1000;

export function startReplKeepalive(
  client: Pick<Client, 'ping'>,
  intervalMs = REPL_SESSION_KEEPALIVE_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void client.ping().catch(() => {});
  }, intervalMs);
  timer.unref();
  return timer;
}

// Release the owned server session before aborting local HTTP streams.
function bindOwnedSessionClose(
  client: Client,
  transport: StreamableHTTPClientTransport,
  onClose: () => void,
): void {
  const closeTransport = client.close.bind(client);
  let pending: Promise<void> | undefined;
  client.close = () =>
    (pending ??= (async () => {
      onClose();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.terminateSession(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, OWNED_SESSION_CLOSE_MS);
          }),
        ]);
      } catch {
        // Expired or unreachable sessions still require local cleanup.
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await closeTransport();
      }
    })());
}

export async function createReplMcpClient(options?: {
  port?: number | string;
  client?: Client;
}): Promise<{ client: Client; mcp: ReplMcpContext }> {
  let client = options?.client;
  let keepalive: NodeJS.Timeout | undefined;
  if (!client) {
    const targetUrl = resolveReplTargetUrl(options?.port);
    const token = readBridgeToken();
    client = new Client({ name: 'browserpaw-repl', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(targetUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
      },
    });
    bindOwnedSessionClose(client, transport, () => {
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
    });
    try {
      await client.connect(transport);
    } catch (err) {
      try {
        await client.close();
      } catch {}
      throw err;
    }
    keepalive = startReplKeepalive(client);
  }

  const mcp: ReplMcpContext = {
    call: async (name: string, args: Record<string, unknown> = {}, options?: ReplCallOptions) => {
      const raw = (await client.callTool(
        { name, arguments: args },
        undefined,
        options,
      )) as CallToolResult;
      if (raw.isError) {
        const errorMsg =
          raw.content?.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') ||
          `Tool execution failed: ${name}`;
        const err = new Error(errorMsg);
        (err as any).result = raw;
        throw err;
      }

      const result: ReplToolCallResult = {
        ...raw,
      };

      const textBlocks = (raw.content || []).filter((c) => c.type === 'text');
      if (textBlocks.length > 0) {
        const mergedText = textBlocks.map((c) => (c as any).text).join('\n');
        result.text = mergedText;
        try {
          result.data = JSON.parse(
            textBlocks
              .filter((block) => !block.text.startsWith('[System Note:'))
              .map((block) => block.text)
              .join('\n'),
          );
        } catch {}
      }
      if (raw.structuredContent !== undefined) result.data = raw.structuredContent;
      return result;
    },
    tools: async () => {
      const list = (await client.listTools()) as ListToolsResult;
      return list.tools || [];
    },
    notes: async (url: string) => {
      const hostname = noteHostname(url);
      try {
        const lookup = await mcp.skills.find(url);
        if (!Array.isArray(lookup.data)) {
          throw new Error('chrome_skill find returned no skill summary array');
        }
        const skill = lookup.data.map(activeSkillSummary).find(Boolean);
        if (skill) return skillSummaryNote(hostname, skill);
        if (lookup.data.length > 0) {
          throw new Error('chrome_skill find returned no valid active skill summary');
        }
        return loadSiteNote(url);
      } catch (error) {
        const fallback = await loadSiteNote(url);
        const warning = `MCP skill lookup failed; used static note fallback: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return {
          ...fallback,
          warning: [fallback.warning, warning].filter(Boolean).join(' '),
        };
      }
    },
    ...createBrowserApi(
      async (name, args = {}, options) => mcp.call(name, args, options),
      () => mcp.tools(),
    ),
  };

  return { client, mcp };
}

export async function startRepl(options?: ReplOptions): Promise<repl.REPLServer> {
  const { client, mcp } = await createReplMcpClient({
    port: options?.port,
    client: options?.client,
  });

  try {
    const input = options?.input || process.stdin;
    const output = options?.output || process.stdout;

    if (!options?.silent) {
      const url = resolveReplTargetUrl(options?.port);
      output.write(`BrowserPaw Persistent REPL\n`);
      output.write(`Connected to bridge at ${url.origin}/mcp\n`);
      output.write(
        `Injected context: browser === mcp, mcp.call/tools/notes, task, skills, help(name)\n`,
      );
      output.write(`Note: Exiting closes the MCP session without closing browser tabs.\n`);
      output.write(
        `      To close tabs explicitly, run: await mcp.call('chrome_close_tabs', ...)\n\n`,
      );
    }

    const server = repl.start({
      prompt: options?.prompt || 'browserpaw> ',
      input,
      output,
      terminal: options?.terminal,
      useGlobal: false,
    });

    server.context.mcp = mcp;
    server.context.browser = mcp;

    let closed = false;
    const handleClose = () => {
      if (closed) return;
      closed = true;
      client.close().catch(() => {});
    };

    server.once('close', handleClose);
    server.once('exit', handleClose);

    return server;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    throw err;
  }
}
