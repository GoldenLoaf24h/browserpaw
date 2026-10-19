import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'browserpaw';

// The MCP client ships inside the harness image, so it is never a dependency of this
// package. `ctx.loader.import` is the resolver that mounts entry rows and reaches the
// in-box copy from a linked plugin; resolving it at open() time rather than with a
// top-level static import also keeps this module importable under plain Node, where the
// repo contract test runs with no harness resolver.
const MCP_CLIENT_SPECIFIER = '@deepseek-ai/dsh-mcp-client';

// Kept in sync with packages/shared/src/constants.ts (this plugin is outside the workspace).
const DEFAULT_SERVER_PORT = 12306;

export const name = 'browserpaw-session';

export const inject = ['skills', 'tools', 'loader'];

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
  // The skill body documents the canonical MCP names (`chrome_*`, `performance_*`,
  // `get_windows_and_tabs`), but DSH surfaces every injected tool as
  // `mcp__<serverName>__<raw name>` and the in-box client has no rename capability, so the
  // callable names differ from the ones the body uses. Prepending the mapping here keeps it
  // out of the skill directory, which scripts/sync-skills.mjs regenerates, and interpolates
  // the real server name instead of restating it.
  //
  // The trailing sentence must not advertise `chrome_tool_docs` as an unlock path. The native
  // host only announces the `core` profile by default, and although `activateForSession: true`
  // widens that set server-side, the in-box MCP client never learns about it: the server does
  // not declare the `tools.listChanged` capability, so the client's list-changed handler is
  // never installed and its tool table never refreshes. A tool outside the announced profile
  // therefore stays unregistered in DSH until the native host is restarted with a wider
  // `CHROME_MCP_TOOL_PROFILE`, which the plugin cannot reach from inside its own process.
  const toolNamingNote =
    `> **DSH tool names**: DSH exposes every BrowserPaw tool as \`mcp__${SERVER_NAME}__<raw name>\`, ` +
    `and the MCP client passes each raw name through unchanged — so the \`chrome_*\`, ` +
    `\`performance_*\` and \`get_windows_and_tabs\` names used below are callable as ` +
    `\`mcp__${SERVER_NAME}__chrome_<name>\`, \`mcp__${SERVER_NAME}__performance_<name>\` and ` +
    `\`mcp__${SERVER_NAME}__get_windows_and_tabs\`. Open the tool set first with ` +
    `\`browserpaw_session\` (\`action: "open"\`). The active tool profile announces only a ` +
    `subset of these names, so a tool that is not listed yet is not callable until the ` +
    `native host is restarted with \`CHROME_MCP_TOOL_PROFILE=full\`.`;
  ctx.skills.register({
    name: SERVER_NAME,
    source: 'runtime',
    description:
      'BrowserPaw 浏览器自动化操作技能：执行阶梯、工具选择表、状态机与失败恢复。使用前先调用 browserpaw_session 开启工具集。',
    content: `${toolNamingNote}\n\n${skillContent}`,
    resourceBase: { kind: 'directory', path: skillDir },
  });

  let session = null;

  // Open and close transitions are serialized. `ctx.plugin` cannot be cancelled once it has
  // started, so a concurrent open would fork a second transport that nothing tracks, and a
  // close (or plugin unload) landing while an open is still awaiting would see no session,
  // return as a no-op, and let the connection reappear afterwards. Serializing makes each
  // transition observe the settled result of the previous one, so close can dispose the
  // fork created by an in-flight open.
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
      // Cordis rejects a bare specifier here: it needs a function or an object carrying
      // `apply`, which is exactly what the loader resolves the specifier to.
      const client = await ctx.loader.import(MCP_CLIENT_SPECIFIER);
      // `failOnStartupError` defaults to false, which makes the client swallow a failed first
      // connection and retry in the background. open() would then report success while no tool
      // exists, so a caller that trusts the result calls a name that was never registered. Turn
      // the failure into a rejection: the bridge either answers now or open() fails loudly.
      const fork = await ctx.plugin(client, {
        serverName: SERVER_NAME,
        transport: 'streamable-http',
        url: `http://127.0.0.1:${resolveServerPort()}/mcp`,
        headers: { 'x-mcp-token': token },
        failOnStartupError: true,
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
      // Retain the session until disposal succeeds so status stays honest and a
      // failed close can be retried without allowing a second transport to open.
      await session.fork.dispose();
      session = null;
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
