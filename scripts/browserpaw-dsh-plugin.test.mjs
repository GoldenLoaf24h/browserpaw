import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The dsh plugin lives outside the pnpm workspace (plugins/* is not a workspace package),
// so its behavioural coverage lives here next to the other root script tests.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginPath = resolve(repoRoot, 'plugins/browserpaw-dsh/index.js');
const pluginSource = readFileSync(pluginPath, 'utf8');

function makeContext({ pluginGate } = {}) {
  const forks = [];
  const tools = [];
  const skills = new Map();
  const cleanups = [];
  const ctx = {
    skills: {
      register(skill) {
        if (!skill || typeof skill.name !== 'string' || !skill.description) {
          throw new Error('invalid skill registration');
        }
        skills.set(skill.name, skill);
        return () => skills.delete(skill.name);
      },
      get(name) {
        const def = skills.get(name);
        if (!def) return undefined;
        // Official deferred validation at packages/skill/skill/src/index.ts:763 (57190202).
        if (typeof def.source !== 'string') {
          throw new TypeError(`loaded skill "${name}" source must be a string`);
        }
        return def;
      },
    },
    tools: {
      register(tool) {
        const name = tool?.name;
        const output = tool?.output;
        // Official registration guard at packages/core/tools/src/index.ts:1071 (57190202).
        if (
          output === undefined ||
          typeof output !== 'object' ||
          typeof output.render !== 'function' ||
          (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')
        ) {
          throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
        }
        tools.push(tool);
        return () => {
          const idx = tools.indexOf(tool);
          if (idx !== -1) tools.splice(idx, 1);
        };
      },
      get(name) {
        return tools.find((t) => t.name === name);
      },
    },
    plugin: async (name, options) => {
      const fork = {
        name,
        options,
        disposed: false,
        dispose: async () => {
          fork.disposed = true;
        },
      };
      forks.push(fork);
      // Lets a case hold an open() in flight to exercise close/unload racing it.
      if (pluginGate) await pluginGate(fork);
      return fork;
    },
    effect: (register) => {
      // The real loader invokes the returned cleanup on unload; capture it so tests can.
      const cleanup = register();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
  };
  return { ctx, forks, tools, cleanups };
}

async function bootSession({ pluginGate } = {}) {
  // Cache-bust so every case starts from a clean module instance.
  const mod = await import(`${pathToFileURL(pluginPath).href}?case=${Math.random()}`);
  const { ctx, forks, tools, skills, cleanups } = makeContext({ pluginGate });
  await mod.apply(ctx);
  const tool = tools.find((entry) => entry.name === 'browserpaw_session');
  assert.ok(tool, 'browserpaw_session tool should be registered');
  return { tool, forks, ctx, skills, tools, cleanups };
}

async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const noPorts = { CHROME_MCP_PORT: undefined, MCP_HTTP_PORT: undefined };

describe('browserpaw-dsh plugin contract (B-05 / F-05)', () => {
  it('B-05: resolves the bridge token without process.getBuiltinModule (F-02 static-import shadowing)', () => {
    // Node >= 22 exposes getBuiltinModule, so the version split cannot be reproduced
    // behaviourally on the CI runtime; this guard pins the removal of the fallback.
    assert.doesNotMatch(
      pluginSource,
      /getBuiltinModule/,
      'bridge token resolution must use the top-level static fs/os/path imports',
    );
    assert.match(
      pluginSource,
      /import os from 'node:os'/,
      'the plugin must statically import node:os',
    );
  });

  it('B-05: open() honours CHROME_MCP_PORT', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token', CHROME_MCP_PORT: '45678' }, async () => {
      const { tool, forks } = await bootSession();
      await tool.execute({ action: 'open' });
      assert.equal(forks.length, 1);
      assert.equal(forks[0].options.url, 'http://127.0.0.1:45678/mcp');
      assert.equal(forks[0].options.headers['x-mcp-token'], 'test-token');
    });
  });

  it('B-05: open() falls back to MCP_HTTP_PORT and then to the shared default port', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token', MCP_HTTP_PORT: '45679' }, async () => {
      const { tool, forks } = await bootSession();
      await tool.execute({ action: 'open' });
      assert.equal(forks[0].options.url, 'http://127.0.0.1:45679/mcp');
    });

    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      const { tool, forks } = await bootSession();
      await tool.execute({ action: 'open' });
      assert.equal(forks[0].options.url, 'http://127.0.0.1:12306/mcp');
    });

    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token', CHROME_MCP_PORT: 'not-a-port' }, async () => {
      const { tool, forks } = await bootSession();
      await tool.execute({ action: 'open' });
      assert.equal(forks[0].options.url, 'http://127.0.0.1:12306/mcp');
    });
  });

  it('B-05: open() fails loudly instead of reporting ok when no bridge token exists', async () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-no-token-'));
    try {
      await withEnv(
        { ...noPorts, CHROME_MCP_TOKEN: undefined, HOME: sandboxHome, USERPROFILE: sandboxHome },
        async () => {
          const { tool, forks } = await bootSession();
          await assert.rejects(() => tool.execute({ action: 'open' }), /bridge token/i);
          assert.equal(forks.length, 0, 'no transport should be forked without a token');
        },
      );
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('F-05: the dead idle state is gone and no timer is ever scheduled', () => {
    assert.doesNotMatch(pluginSource, /idleTimer|clearIdleTimer/, 'dead idle state must be deleted');
    assert.doesNotMatch(pluginSource, /setTimeout|setInterval/, 'no idle/auto-close behaviour may be added');
  });

  it('F-05: open/close lifecycle still works and leaves no timer behind', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      const { tool, forks } = await bootSession();

      assert.equal((await tool.execute({ action: 'status' })).active, false);
      await tool.execute({ action: 'open' });
      assert.equal((await tool.execute({ action: 'status' })).active, true);
      await tool.execute({ action: 'close' });
      assert.equal((await tool.execute({ action: 'status' })).active, false);
      assert.equal(forks[0].disposed, true);

      const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      assert.equal(timersAfter, timersBefore, 'open/close must not leave a pending timer');
    });
  });

  it('P1: concurrent open() creates exactly one session', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      const { tool, forks } = await bootSession();

      await Promise.all([
        tool.execute({ action: 'open' }),
        tool.execute({ action: 'open' }),
        tool.execute({ action: 'open' }),
      ]);

      assert.equal(forks.length, 1, 'concurrent opens must fork exactly one transport');
      assert.equal((await tool.execute({ action: 'status' })).active, true);
    });
  });

  it('P1: a failed open leaves no session and can be retried', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      let attempts = 0;
      const { tool, forks } = await bootSession({
        pluginGate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transport handshake failed');
        },
      });

      await assert.rejects(() => tool.execute({ action: 'open' }), /handshake failed/);
      assert.equal((await tool.execute({ action: 'status' })).active, false);

      await tool.execute({ action: 'open' });
      assert.equal((await tool.execute({ action: 'status' })).active, true);
      assert.equal(forks.length, 2, 'the retry forks a fresh transport');
      assert.equal(forks[1].disposed, false);
    });
  });

  it('P1: close() during an in-flight open() leaves no live connection', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const { tool, forks } = await bootSession({ pluginGate: () => held });

      const opening = tool.execute({ action: 'open' });
      await Promise.resolve(); // let the open reach the transport fork
      const closing = tool.execute({ action: 'close' });
      release();
      await Promise.all([opening, closing]);

      assert.equal(forks.length, 1);
      assert.equal(forks[0].disposed, true, 'the racing close must dispose the opened fork');
      assert.equal((await tool.execute({ action: 'status' })).active, false);
    });
  });

  it('P1: unload during an in-flight open() disposes the connection', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const { tool, forks, cleanups } = await bootSession({ pluginGate: () => held });

      const opening = tool.execute({ action: 'open' });
      await Promise.resolve(); // let the open reach the transport fork
      // Unload queues behind the open, so it must not settle until the open has.
      const unloading = Promise.all(cleanups.map((cleanup) => cleanup()));
      release();
      await opening;
      await unloading;

      assert.equal(forks.length, 1);
      assert.equal(forks[0].disposed, true, 'unload must not leave an undisposed fork');
      assert.equal((await tool.execute({ action: 'status' })).active, false);
    });
  });

  it('P1: close() is idempotent and repeated closes never throw', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      const { tool, forks } = await bootSession();

      await tool.execute({ action: 'close' });
      await tool.execute({ action: 'open' });
      await Promise.all([
        tool.execute({ action: 'close' }),
        tool.execute({ action: 'close' }),
        tool.execute({ action: 'close' }),
      ]);

      assert.equal(forks.length, 1);
      assert.equal(forks[0].disposed, true);
      assert.equal((await tool.execute({ action: 'status' })).active, false);
    });
  });

  it('P2: failed disposal keeps the session active and blocks a second fork until close retries', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      let disposals = 0;
      const { tool, forks } = await bootSession({
        pluginGate: async (fork) => {
          fork.dispose = async () => {
            disposals += 1;
            if (disposals === 1) throw new Error('transport still open');
            fork.disposed = true;
          };
        },
      });
      await tool.execute({ action: 'open' });

      const closing = tool.execute({ action: 'close' });
      const reopening = tool.execute({ action: 'open' });
      await assert.rejects(closing, /transport still open/);
      await reopening;
      assert.equal((await tool.execute({ action: 'status' })).active, true);
      assert.equal(forks.length, 1, 'a failed close must not let queued open fork again');
      assert.equal(forks[0].disposed, false);

      await tool.execute({ action: 'close' });
      assert.equal(disposals, 2);
      assert.equal(forks[0].disposed, true);
      assert.equal((await tool.execute({ action: 'status' })).active, false);
      await tool.execute({ action: 'open' });
      assert.equal(forks.length, 2, 'successful disposal permits a fresh connection');
    });
  });

  it('P2: status stays active during disposal and unload retries a failed close', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      let rejectDisposal;
      let disposalStarted;
      const started = new Promise((resolve) => {
        disposalStarted = resolve;
      });
      const held = new Promise((_, reject) => {
        rejectDisposal = reject;
      });
      let disposals = 0;
      const { tool, forks, cleanups } = await bootSession({
        pluginGate: async (fork) => {
          fork.dispose = async () => {
            disposals += 1;
            if (disposals === 1) {
              disposalStarted();
              await held;
            }
            fork.disposed = true;
          };
        },
      });
      await tool.execute({ action: 'open' });
      const closing = tool.execute({ action: 'close' });
      await started;
      const activeDuringDisposal = (await tool.execute({ action: 'status' })).active;
      const rejected = assert.rejects(closing, /transport still open/);
      rejectDisposal(new Error('transport still open'));
      await rejected;
      await Promise.all(cleanups.map((cleanup) => cleanup()));

      assert.equal(activeDuringDisposal, true, 'status must not hide an in-flight transport');
      assert.equal(disposals, 2);
      assert.equal(forks[0].disposed, true);
      assert.equal((await tool.execute({ action: 'status' })).active, false);
    });
  });

  it('S-02: session tool output declares required render projection function', async () => {
    const { tool } = await bootSession();
    assert.equal(typeof tool.output?.render, 'function', 'output.render must be a function');
    const rendered = tool.output.render({}, { ok: true, action: 'status', active: false });
    assert.ok(Array.isArray(rendered), 'render must return an array of content blocks');
    assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true,"action":"status","active":false}' }]);
  });

  it('S-03: skill registration declares source and passes deferred resolution', async () => {
    const { ctx } = await bootSession();
    const skill = ctx.skills.get('browserpaw');
    assert.ok(skill, 'browserpaw skill must be registered and retrievable');
    assert.equal(skill.source, 'runtime', 'skill source must be "runtime"');
  });

  it('S-04: session tool parameters specify standard root object JSON Schema', async () => {
    const { tool } = await bootSession();
    assert.equal(tool.parameters?.type, 'object', 'parameters root must declare type "object"');
    assert.equal(typeof tool.parameters?.properties?.action, 'object', 'parameters.properties.action must exist');
    assert.deepEqual(
      tool.parameters.properties.action.enum,
      ['open', 'close', 'status'],
      'action enum must match allowed session actions',
    );
    const defaultStatus = await tool.execute({});
    assert.equal(defaultStatus.ok, true);
    assert.equal(defaultStatus.action, 'status');
    assert.equal(defaultStatus.active, false);
  });
});
