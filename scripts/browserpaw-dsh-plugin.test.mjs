import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The dsh plugin lives outside the pnpm workspace (plugins/* is not a workspace package),
// so its behavioural coverage lives here next to the other root script tests.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginPath = resolve(repoRoot, 'plugins/browserpaw-dsh/index.js');
const pluginSource = readFileSync(pluginPath, 'utf8');
const pluginDir = resolve(repoRoot, 'plugins/browserpaw-dsh');
const manifestPath = join(pluginDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The DSH runtime this package was host-validated against (plugins/browserpaw-dsh/README.md).
const TESTED_DSH_VERSION = '0.2.1-rc.1';

// Stands in for the in-box client the harness loader resolves the bare specifier to.
const mcpClientNamespace = { name: 'mcp-client', inject: ['tools'], apply() {} };

function makeContext({ pluginGate } = {}) {
  const forks = [];
  const tools = [];
  const skills = new Map();
  const cleanups = [];
  const loaderImports = [];
  const ctx = {
    loader: {
      // The harness mounts entry rows through its own resolver, and that resolver is what
      // reaches the in-box client from a linked plugin; the double mirrors the same seam.
      async import(specifier) {
        loaderImports.push(specifier);
        return mcpClientNamespace;
      },
    },
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
  return { ctx, forks, tools, skills, cleanups, loaderImports };
}

async function bootSession({ pluginGate } = {}) {
  // Cache-bust so every case starts from a clean module instance.
  const mod = await import(`${pathToFileURL(pluginPath).href}?case=${Math.random()}`);
  const { ctx, forks, tools, skills, cleanups, loaderImports } = makeContext({ pluginGate });
  await mod.apply(ctx);
  const tool = tools.find((entry) => entry.name === 'browserpaw_session');
  assert.ok(tool, 'browserpaw_session tool should be registered');
  return { tool, forks, ctx, skills, tools, cleanups, loaderImports };
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

  it('B-05: the in-box client is resolved through the loader, never a static import', async () => {
    // A top-level static import of the in-box client cannot resolve from a linked plugin
    // outside the harness image, and cordis rejects a bare specifier string, so the
    // loader seam is the only shape that works in both environments.
    assert.doesNotMatch(
      pluginSource,
      /^\s*import\s+[^\n]*['"]@deepseek-ai\/dsh-mcp-client['"]/m,
      'the in-box client must not be statically imported',
    );

    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token' }, async () => {
      const { tool, forks, loaderImports } = await bootSession();
      assert.deepEqual(loaderImports, [], 'boot must not resolve the client before open()');

      await tool.execute({ action: 'open' });
      assert.deepEqual(
        loaderImports,
        ['@deepseek-ai/dsh-mcp-client'],
        'open() must resolve the in-box client through the loader',
      );
      assert.equal(forks.length, 1);
      assert.equal(forks[0].name, mcpClientNamespace, 'the loader result is what cordis accepts');

      await tool.execute({ action: 'close' });
      assert.deepEqual(loaderImports, ['@deepseek-ai/dsh-mcp-client'], 'close must not re-resolve');
    });
  });

  it('B-05: open() honours CHROME_MCP_PORT', async () => {
    await withEnv({ ...noPorts, CHROME_MCP_TOKEN: 'test-token', CHROME_MCP_PORT: '45678' }, async () => {
      const { tool, forks } = await bootSession();
      await tool.execute({ action: 'open' });
      assert.equal(forks.length, 1);
      assert.equal(forks[0].options.url, 'http://127.0.0.1:45678/mcp');
      assert.equal(forks[0].options.headers['x-mcp-token'], 'test-token');
      // The client swallows a failed first connection by default and retries in the
      // background, which would let open() report success with no tool registered.
      assert.equal(
        forks[0].options.failOnStartupError,
        true,
        'open() must surface a failed first connection instead of retrying silently',
      );
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

// `semver` is not resolvable from the repo root — it exists only in the pnpm virtual store, and
// `plugins/*` is not a workspace package — so the engine range is evaluated inline instead of by
// adding a dependency to a root script test.
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  assert.ok(match, `unparsable version: ${version}`);
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1; // a release outranks its own prereleases
  if (right.prerelease === null) return -1;
  const l = left.prerelease.split('.');
  const r = right.prerelease.split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    if (l[i] === r[i]) continue;
    const lNumeric = /^\d+$/.test(l[i]);
    const rNumeric = /^\d+$/.test(r[i]);
    if (lNumeric && rNumeric) return Number(l[i]) < Number(r[i]) ? -1 : 1;
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1; // numeric identifiers sort first
    return l[i] < r[i] ? -1 : 1;
  }
  return 0;
}

// Prerelease versions participate in range matching, so `includePrerelease` is the mode that
// decides this package's declared `>=lo <hi` range.
function satisfiesEngineRange(range, version) {
  const match = /^>=(\S+)\s+<(\S+)$/.exec(range);
  assert.ok(match, `unsupported engines.dsh range shape: ${range}`);
  return compareVersions(version, match[1]) >= 0 && compareVersions(version, match[2]) < 0;
}

describe('dsh-browserpaw manifest and loader compliance', () => {
  it('declares a bundle patch that resolves to a real file', () => {
    // A package without `dsh.bundle` is reconciled as a plain dependency: the patch never
    // applies, `apply()` never runs, and neither the skill nor the session tool exists.
    const patch = manifest.dsh?.bundle?.patch;
    assert.equal(typeof patch, 'string', 'dsh.bundle.patch must be a string');
    assert.notEqual(patch.trim(), '', 'dsh.bundle.patch must not be empty');
    const patchPath = resolve(pluginDir, patch);
    assert.ok(existsSync(patchPath), `dsh.bundle.patch must point at a real file: ${patchPath}`);
  });

  it('declares manifestVersion 1', () => {
    assert.equal(manifest.dsh?.manifestVersion, 1, 'dsh.manifestVersion must be 1');
  });

  it(`engines.dsh admits the host-validated runtime ${TESTED_DSH_VERSION} and rejects 0.3.0`, () => {
    const range = manifest.engines?.dsh;
    assert.equal(typeof range, 'string', 'engines.dsh must be a string');
    assert.notEqual(range.trim(), '', 'engines.dsh must not be empty');

    // An open-ended upper bound would claim compatibility with every future minor, which the
    // host validation never established.
    assert.ok(
      satisfiesEngineRange(range, TESTED_DSH_VERSION),
      `engines.dsh "${range}" must admit ${TESTED_DSH_VERSION}`,
    );
    assert.ok(!satisfiesEngineRange(range, '0.3.0'), `engines.dsh "${range}" must not claim 0.3.0`);
  });

  it('never hands ctx.plugin a bare specifier string', () => {
    // Cordis rejects a string plugin (`expect function or object with an "apply" method`), so
    // the loader-resolved namespace is the only shape that can be mounted.
    assert.doesNotMatch(
      pluginSource,
      /ctx\.plugin\(\s*['"][^'"]+['"]/,
      'ctx.plugin must receive the loader-resolved namespace, not a specifier string',
    );
  });

  it('registers the skill body verbatim behind the generated tool-naming note', async () => {
    const { ctx } = await bootSession();
    const skill = ctx.skills.get('browserpaw');
    assert.ok(skill, 'browserpaw skill must be registered');

    // The registered content must be the on-disk skill plus a prepended note: the note is
    // generated at apply() time because the skill directory is regenerated by sync-skills.mjs.
    const skillBytes = readFileSync(join(pluginDir, 'skills/browserpaw/SKILL.md'), 'utf8');
    const separator = '\n\n';
    assert.ok(
      skill.content.endsWith(`${separator}${skillBytes}`),
      'the skill file bytes must be registered verbatim after the note',
    );

    const note = skill.content.slice(
      0,
      skill.content.length - skillBytes.length - separator.length,
    );
    assert.notEqual(note.trim(), '', 'a tool-naming note must be prepended');
    assert.match(note, /mcp__browserpaw__/, 'the note must name the real server prefix');
    assert.doesNotMatch(note, /<serverName>/, 'the note must interpolate the server name');
    // The note must not offer `chrome_tool_docs` as a way to widen the tool set. That path is
    // dead in DSH: the native host never declares the `tools.listChanged` capability, so the
    // in-box client installs no list-changed handler and its tool table never refreshes after
    // an `activateForSession` call. Only a host restart with a wider CHROME_MCP_TOOL_PROFILE
    // changes what is callable, and the plugin cannot reach that from its own process.
    assert.doesNotMatch(
      note,
      /activateForSession/,
      'the note must not advertise a tool-unlock path that the host never observes',
    );
  });

  it('marks the in-box client peer optional so no installer fetches a second copy', () => {
    // The peer declaration documents the client this package was built against, and the loader
    // resolves that client out of the harness image. An installer must therefore never resolve
    // it a second time into the profile: a duplicate in-box `@deepseek-ai/*` package registers
    // the same Cordis symbols twice and breaks every tool call (Discussion #8287).
    //
    // pnpm profiles already run with `autoInstallPeers: false`, but npm does not: measured, a
    // required peer makes `npm install` pull 39 packages including
    // `@deepseek-ai/dsh-mcp-client`. Marking the peer optional is what stops that, while the
    // declared range stays readable as documentation.
    assert.equal(
      manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-mcp-client']?.optional,
      true,
      'the in-box client peer must be optional so npm does not install a duplicate',
    );
  });

  it('ships a publishable file set without internal agent notes', () => {
    // `files` is what npm publishes; anything outside it is unreachable to a user who installs
    // the package, so the loader patch, the entry module and the skill tree must all be listed.
    const files = manifest.files;
    assert.ok(Array.isArray(files), 'package.json must pin an explicit files list');
    for (const entry of ['index.js', 'cordis.patch.yml', 'skills', 'LICENSE']) {
      assert.ok(files.includes(entry), `files must include ${entry}`);
    }
    // AGENTS.md files are notes for agents working in the repo, not user documentation. The
    // skill tree is published wholesale, so the exclusion has to be a negation pattern.
    assert.ok(
      files.includes('!**/AGENTS.md'),
      'files must exclude the internal AGENTS.md notes from the published skill tree',
    );
    assert.ok(existsSync(join(pluginDir, 'LICENSE')), 'the published package needs its LICENSE');
  });
});
