import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'browserpaw';

export const name = 'browserpaw-session';

export const inject = ['skills', 'tools'];

function resolveBridgeToken() {
  if (process.env.CHROME_MCP_TOKEN?.trim()) return process.env.CHROME_MCP_TOKEN.trim();
  try {
    const fs = process.getBuiltinModule?.('node:fs') ?? undefined;
    const os = process.getBuiltinModule?.('node:os') ?? undefined;
    const pathMod = process.getBuiltinModule?.('node:path') ?? undefined;
    if (!fs || !os || !pathMod) return undefined;
    const tokenPath = pathMod.join(os.homedir(), '.chrome-mcp', 'bridge-token');
    return fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8').trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function apply(ctx) {
  // 技能常驻：体积极小（只占目录表），不占工具 schema
  const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.join(pkgRoot, 'skills', SERVER_NAME);
  const skillContent = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  ctx.skills.register({
    name: SERVER_NAME,
    description:
      'BrowserPaw 浏览器自动化操作技能：执行阶梯、工具选择表、状态机与失败恢复。使用前先调用 browserpaw_session 开启工具集。',
    content: skillContent,
    resourceBase: { kind: 'directory', path: skillDir },
  });

  let session = null;
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  async function open() {
    if (session) return;
    const fork = await ctx.plugin('@deepseek-ai/dsh-mcp-client', {
      serverName: SERVER_NAME,
      transport: 'streamable-http',
      url: 'http://127.0.0.1:12306/mcp',
      headers: { 'x-mcp-token': resolveBridgeToken() ?? '' },
    });
    session = {
      fork,
      startedAt: Date.now(),
    };
  }

  async function close() {
    clearIdleTimer();
    if (!session) return;
    await session.fork.dispose();
    session = null;
  }

  ctx.tools.register({
    name: 'browserpaw_session',
    description:
      '开启/关闭/查看 BrowserPaw 浏览器自动化工具集。action: open | close | status。open 后工具以 mcp__browserpaw__ 前缀出现；用完后务必 close 释放上下文。',
    parameters: {
      action: { type: 'string', enum: ['open', 'close', 'status'], description: '操作类型' },
    },
    output: { schema: { type: 'object', additionalProperties: true } },
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
    () => () => {
      clearIdleTimer();
      session?.fork.dispose().catch(() => {});
      session = null;
    },
    'browserpaw-session.dispose',
  );
}
