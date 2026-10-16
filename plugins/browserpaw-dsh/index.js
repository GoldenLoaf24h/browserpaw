import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'browserpaw';

// Kept in sync with packages/shared/src/constants.ts (this plugin is outside the workspace).
const DEFAULT_SERVER_PORT = 12306;

export const name = 'browserpaw-session';

export const inject = ['skills', 'tools'];

// Mirrors bin/browserpaw.cjs: CHROME_MCP_PORT wins, then MCP_HTTP_PORT, else the shared default.
function resolveServerPort() {
  const raw = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_SERVER_PORT;
}

function resolveBridgeToken() {
  if (process.env.CHROME_MCP_TOKEN?.trim()) return process.env.CHROME_MCP_TOKEN.trim();
  try {
    const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
    return fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8').trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function apply(ctx) {
  // Skill is always resident: tiny footprint (directory entry only), no tool schema cost
  const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.join(pkgRoot, 'skills', SERVER_NAME);
  const skillContent = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  ctx.skills.register({
    name: SERVER_NAME,
    source: 'runtime',
    description:
      'BrowserPaw 浏览器自动化操作技能：执行阶梯、工具选择表、状态机与失败恢复。使用前先调用 browserpaw_session 开启工具集。',
    content: skillContent,
    resourceBase: { kind: 'directory', path: skillDir },
  });

  let session = null;

  // Open and close transitions are serialized. `ctx.plugin` cannot be cancelled once it has
  // started, so a concurrent open would fork a second transport that nothing tracks, and a
  // close (or plugin unload) landing while an open is still awaiting would see no session,
  // return as a no-op, and let the connection reappear afterwards. Serializing makes each
  // transition observe the settled result of the previous one, so a close always ends with
  // no live connection and no undisposed fork.
  let transitions = Promise.resolve();

  function serialize(transition) {
    const run = transitions.then(transition);
    transitions = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function open() {
    return serialize(async () => {
      if (session) return;
      const token = resolveBridgeToken();
      if (!token) {
        throw new Error(
          'BrowserPaw bridge token not found. Start the native host or set CHROME_MCP_TOKEN.',
        );
      }
      const fork = await ctx.plugin('@deepseek-ai/dsh-mcp-client', {
        serverName: SERVER_NAME,
        transport: 'streamable-http',
        url: `http://127.0.0.1:${resolveServerPort()}/mcp`,
        headers: { 'x-mcp-token': token },
      });
      session = {
        fork,
        startedAt: Date.now(),
      };
    });
  }

  async function close() {
    return serialize(async () => {
      if (!session) return;
      const current = session;
      session = null;
      await current.fork.dispose();
    });
  }

  ctx.tools.register({
    name: 'browserpaw_session',
    description:
      '开启/关闭/查看 BrowserPaw 浏览器自动化工具集。action: open | close | status。open 后工具以 mcp__browserpaw__ 前缀出现；用完后务必 close 释放上下文。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'status'], description: '操作类型' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const action = args?.action ?? 'status';
      if (action === 'open') {
        await open();
        return { ok: true, action, note: 'browserpaw 工具已注入，调用后请 close' };
      }
      if (action === 'close') {
        await close();
        return { ok: true, action, note: 'browserpaw 工具已卸载' };
      }
      return {
        ok: true,
        action,
        active: session !== null,
      };
    },
  });

  ctx.effect(
    () => () =>
      // Route unload through close() so it queues behind any in-flight open instead of
      // observing an empty session and leaving that fork connected after the plugin is gone.
      close().catch(() => {}),
    'browserpaw-session.dispose',
  );
}
