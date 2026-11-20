import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  apply as applyDshPlugin,
  buildLearnedWorkflowsSection,
  buildRuntimeNote,
  name as dshPluginName,
  inject as dshPluginInject,
  readLearnedWorkflows as readDshLearnedWorkflows,
} from '../plugins/browserpaw-dsh/index.js';
import { buildSessionContext } from '../plugins/browserpaw-claude/scripts/session-start.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('dsh-browserpaw manifest declares bundle patch, browserpaw dependency, and pack files', () => {
  const rootVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const dshDir = path.join(repoRoot, 'plugins/browserpaw-dsh');
  const pkg = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'));

  assert.equal(pkg.name, 'dsh-browserpaw');
  assert.equal(pkg.version, rootVersion);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(pkg.dependencies?.browserpaw, 'dsh-browserpaw must depend on browserpaw npm package');
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-mcp-client'], undefined);
  assert.equal(dshPluginName, 'browserpaw-skill');
  assert.deepEqual(dshPluginInject, ['skills']);

  const patch = fs.readFileSync(path.join(dshDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*browserpaw-skill/);
  assert.match(patch, /name:\s*dsh-browserpaw/);

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pack = spawnSync(npmCmd, ['pack', '--dry-run', '--json'], {
    cwd: dshDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const entries = JSON.parse(pack.stdout)[0].files.map((item) => item.path);
  assert.ok(entries.includes('index.js'));
  assert.ok(entries.includes('cordis.patch.yml'));
  assert.ok(entries.includes('skills/browserpaw/SKILL.md'));
});

test('dsh-browserpaw apply registers read-only runtime skill and surfaces ~/.browserpaw workflows', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-dsh-home-'));
  const prevHome = process.env.BROWSERPAW_HOME;
  try {
    fs.writeFileSync(
      path.join(tempHome, 'learned-index.json'),
      JSON.stringify({
        version: 1,
        workflows: [
          {
            id: 'x-search-thread',
            status: 'active',
            domains: ['x.com'],
            command: 'browserpaw recipe run x-search-thread query=<query>',
            description: 'Search X posts',
          },
        ],
      }),
    );
    process.env.BROWSERPAW_HOME = tempHome;

    const registered = [];
    applyDshPlugin({
      skills: {
        register(skill) {
          registered.push(skill);
        },
      },
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'browserpaw');
    assert.equal(registered[0].source, 'runtime');
    assert.equal(registered[0].resourceBase?.kind, 'directory');
    assert.ok(fs.existsSync(path.join(registered[0].resourceBase.path, 'SKILL.md')));
    assert.match(registered[0].content, /x-search-thread/);
    assert.match(registered[0].content, /browserpaw recipe run x-search-thread/);
    assert.doesNotMatch(registered[0].content, /\n---\r?\nname:\s*browserpaw/);

    const note = buildRuntimeNote({
      bundledCliPath: '/opt/dsh/node_modules/browserpaw/dist/v5/cli.cjs',
      homeDir: tempHome,
    });
    assert.match(note, /node "\/opt\/dsh\/node_modules\/browserpaw\/dist\/v5\/cli\.cjs"/);
    assert.match(note, /Invoke the plugin-bundled CLI via/);
    const table = buildLearnedWorkflowsSection(readDshLearnedWorkflows(tempHome));
    assert.match(table, /## Active Learned Workflows/);
    assert.match(table, /x-search-thread/);
    assert.ok(
      registered[0].content.indexOf('# BrowserPaw') <
        registered[0].content.indexOf('## Active Learned Workflows'),
    );
  } finally {
    if (prevHome === undefined) delete process.env.BROWSERPAW_HOME;
    else process.env.BROWSERPAW_HOME = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('claude plugin has SessionStart hook without top-level bin/ and emits valid JSON context', () => {
  const claudeDir = path.join(repoRoot, 'plugins/browserpaw-claude');
  assert.equal(fs.existsSync(path.join(claudeDir, 'bin')), false);
  assert.deepEqual(fs.readdirSync(path.join(claudeDir, '.claude-plugin')), ['plugin.json']);
  const claudeManifest = JSON.parse(
    fs.readFileSync(path.join(claudeDir, '.claude-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(claudeManifest.icon, './assets/icon.png');
  assert.equal(fs.existsSync(path.join(claudeDir, claudeManifest.icon)), true);
  const hooks = JSON.parse(fs.readFileSync(path.join(claudeDir, 'hooks/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.type, 'command');
  assert.equal(hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.timeout, 10);
  assert.match(
    hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command || '',
    /CLAUDE_PLUGIN_ROOT.*scripts\/session-start\.mjs/,
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-claude-hook-'));
  try {
    const binDir = path.join(tempRoot, 'bin');
    const homeDir = path.join(tempRoot, 'home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const fakeBin = path.join(binDir, process.platform === 'win32' ? 'browserpaw.cmd' : 'browserpaw');
    fs.writeFileSync(fakeBin, '');
    fs.writeFileSync(
      path.join(homeDir, 'learned-index.json'),
      JSON.stringify({
        version: 1,
        workflows: [
          {
            id: 'github-releases',
            status: 'active',
            domains: ['github.com'],
            command: 'browserpaw recipe run github-releases repo=<repo>',
          },
        ],
      }),
    );

    const present = buildSessionContext({ PATH: binDir, BROWSERPAW_HOME: homeDir });
    assert.equal(present.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(present.hookSpecificOutput.additionalContext, /CLI is available at/);
    assert.match(present.hookSpecificOutput.additionalContext, /github-releases/);

    const cachedRoot = path.join(tempRoot, 'plugin-root');
    const cachedBinDir = path.join(cachedRoot, 'node_modules', '.bin');
    fs.mkdirSync(cachedBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(cachedBinDir, process.platform === 'win32' ? 'browserpaw.cmd' : 'browserpaw'),
      '',
    );
    const fromPluginRoot = buildSessionContext({
      PATH: '',
      CLAUDE_PLUGIN_ROOT: cachedRoot,
      BROWSERPAW_HOME: homeDir,
    });
    assert.match(fromPluginRoot.hookSpecificOutput.additionalContext, /CLI is available at/);

    const missing = buildSessionContext({ PATH: '', BROWSERPAW_HOME: homeDir });
    assert.match(missing.hookSpecificOutput.additionalContext, /npm install -g browserpaw/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('portable ChatGPT/Codex plugin satisfies Agent Plugins v1 interface icons and marketplace contract', () => {
  const portableDir = path.join(repoRoot, 'plugins/browserpaw');
  const manifest = JSON.parse(fs.readFileSync(path.join(portableDir, 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'browserpaw');
  assert.equal(fs.existsSync(path.join(portableDir, 'hooks')), false);
  assert.equal(manifest.extensions?.['com.openai']?.hooks, undefined);
  const ui = manifest.extensions?.['com.openai']?.interface;
  assert.equal(typeof ui?.composerIcon, 'string');
  assert.equal(typeof ui?.logo, 'string');
  assert.equal(fs.existsSync(path.join(portableDir, ui.composerIcon)), true);
  assert.equal(fs.existsSync(path.join(portableDir, ui.logo)), true);
  assert.ok(
    marketplace.plugins?.some(
      (entry) => entry.name === 'browserpaw' && entry.source?.path === './plugins/browserpaw',
    ),
  );
});
