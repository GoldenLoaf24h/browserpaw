import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Claude Code plugin lives outside the pnpm workspace (plugins/* is not a
// workspace package), so its contract coverage lives here next to the other
// root script tests and is picked up by `pnpm verify` step 7.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginDir = resolve(repoRoot, 'plugins/browserpaw-claude');
const manifestPath = join(pluginDir, '.claude-plugin/plugin.json');
const catalogPath = join(repoRoot, '.claude-plugin/marketplace.json');
const mcpPath = join(pluginDir, '.mcp.json');
const canonicalSkillDir = join(repoRoot, 'skill');
const mirrorSkillDir = join(pluginDir, 'skills/browserpaw');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

describe('browserpaw-claude plugin contract (Claude Code)', () => {
  it('ships a plugin manifest at the specification location', () => {
    assert.ok(existsSync(manifestPath), '.claude-plugin/plugin.json must exist');
    const manifest = readJson(manifestPath);

    assert.equal(manifest.name, 'browserpaw');
    // Specification: name is kebab-case, no spaces, no "@" or ":".
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    // Reserved-name rules: no leading claude-/anthropic-/cc-plugin- prefix.
    assert.doesNotMatch(manifest.name, /^(claude|anthropic|anthropics|cc-plugin)-/);
    assert.equal(manifest.version, readJson(join(repoRoot, 'package.json')).version);
  });

  it('lists itself in the repository marketplace catalog', () => {
    assert.ok(existsSync(catalogPath), '.claude-plugin/marketplace.json must exist');
    const catalog = readJson(catalogPath);

    assert.ok(catalog.name, 'catalog needs a name');
    assert.ok(catalog.owner?.name, 'catalog needs an owner.name');
    assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length > 0);

    const entry = catalog.plugins.find((p) => p.name === 'browserpaw');
    assert.ok(entry, 'the catalog must carry a browserpaw entry');
    // The entry name is the install id and must match the manifest name, or
    // `/plugin install browserpaw` and the skill namespace would disagree.
    assert.equal(entry.name, readJson(manifestPath).name);

    // Relative sources resolve from the marketplace root and may not escape it.
    assert.ok(!entry.source.startsWith('/') && !/^[a-zA-Z]:/.test(entry.source));
    assert.ok(!entry.source.split('/').includes('..'), 'source may not traverse upward');
    const resolved = resolve(repoRoot, entry.source);
    assert.ok(existsSync(resolved), `catalog source must exist: ${entry.source}`);
    assert.ok(statSync(resolved).isDirectory());
    assert.equal(resolved, pluginDir, 'the catalog source must point at this plugin');
  });

  it('declares the stdio MCP server with the canonical chrome_* surface', () => {
    const mcp = readJson(mcpPath);
    const server = mcp.mcpServers?.browserpaw;

    assert.ok(server, '.mcp.json must declare the browserpaw server');
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, 'mcp-chrome-stdio');
    // The mirror stays verbatim, so the plugin must not rename tools via env.
    assert.equal(server.env, undefined);
  });

  it('loads the skill under the bare /browserpaw name', () => {
    const skillFile = join(mirrorSkillDir, 'SKILL.md');
    assert.ok(existsSync(skillFile), 'skills/browserpaw/SKILL.md must exist');

    const frontmatter = readFileSync(skillFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, 'SKILL.md must open with YAML frontmatter');
    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    assert.equal(name, 'browserpaw');

    // Manifest name + skill name => /browserpaw:browserpaw, and the bare
    // /browserpaw resolves to it while no other command claims the name.
    const manifestName = readJson(manifestPath).name;
    assert.equal(`${manifestName}:${name}`, 'browserpaw:browserpaw');
  });

  it('mirrors the canonical skill byte-for-byte', () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
      );

    for (const src of walk(canonicalSkillDir)) {
      const rel = relative(canonicalSkillDir, src);
      if (rel === 'HERMES_PLUGIN_SKILL.md') continue;
      const dest = join(mirrorSkillDir, rel);
      assert.ok(existsSync(dest), `mirror is missing ${rel}`);
      // Verbatim: Claude Code speaks canonical chrome_* over stdio, so no
      // browserpaw_ prefix rewriting and no Hermes scope banner may appear.
      assert.deepEqual(readFileSync(dest), readFileSync(src), `mirror differs at ${rel}`);
    }

    assert.ok(
      !existsSync(join(mirrorSkillDir, 'HERMES_PLUGIN_SKILL.md')),
      'the Hermes-only skill must never be mirrored',
    );
    const skillText = readFileSync(join(mirrorSkillDir, 'SKILL.md'), 'utf8');
    assert.ok(skillText.includes('chrome_'), 'the mirror must keep canonical tool names');
    assert.ok(
      !skillText.includes('not available in the Hermes plugin'),
      'the Hermes scope banner belongs only to the Hermes target',
    );
  });
});
