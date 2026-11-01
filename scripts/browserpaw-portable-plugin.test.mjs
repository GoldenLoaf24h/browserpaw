import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginDir = join(repoRoot, 'plugins/browserpaw');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function findForbiddenEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.name === 'AGENTS.md') return [fullPath];
    return entry.isDirectory() ? findForbiddenEntries(fullPath) : [];
  });
}

describe('browserpaw portable ChatGPT/Codex plugin', () => {
  it('uses portable Agent Plugins v1 layout without a second Codex manifest', () => {
    const manifest = readJson(join(pluginDir, 'plugin.json'));
    assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(manifest.name, 'browserpaw');
    assert.equal(manifest.version, readJson(join(repoRoot, 'package.json')).version);
    assert.deepEqual(
      Object.keys(manifest).sort(),
      [
        '$schema',
        'author',
        'description',
        'extensions',
        'homepage',
        'keywords',
        'license',
        'name',
        'repository',
        'version',
      ].sort(),
      'plugin.json is a closed Agent Plugins v1 manifest',
    );
    assert.equal(manifest.extensions?.['com.openai']?.interface?.displayName, 'BrowserPaw');
    assert.ok(manifest.extensions['com.openai'].interface.shortDescription.length <= 30);
    assert.ok(existsSync(join(pluginDir, 'README.md')));
    assert.ok(existsSync(join(pluginDir, 'skills/browserpaw/SKILL.md')));
    assert.ok(existsSync(join(pluginDir, 'mcp.json')));
    assert.equal(existsSync(join(pluginDir, '.codex-plugin')), false);
    assert.equal(existsSync(join(pluginDir, 'mcp-skills')), false);
  });

  it('declares the canonical stdio MCP command', () => {
    const mcp = readJson(join(pluginDir, 'mcp.json'));
    assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    assert.deepEqual(mcp.mcpServers.browserpaw, {
      type: 'stdio',
      command: 'mcp-chrome-stdio',
      env: { CHROME_MCP_TOOL_PROFILE: 'full' },
    });
  });

  it('is discoverable from the repository marketplace', () => {
    const marketplace = readJson(join(repoRoot, '.agents/plugins/marketplace.json'));
    const entry = marketplace.plugins.find((item) => item.name === 'browserpaw');
    assert.ok(entry, 'marketplace must include browserpaw');
    assert.equal(entry.source.source, 'local');
    assert.equal(resolve(repoRoot, entry.source.path), pluginDir);
  });

  it('keeps installable plugin trees free of repository-only agent notes', () => {
    for (const name of [
      'browserpaw',
      'browserpaw-claude',
      'browserpaw-hermes',
      'browserpaw-dsh',
    ]) {
      assert.deepEqual(
        findForbiddenEntries(join(repoRoot, 'plugins', name)),
        [],
        `${name} must not ship AGENTS.md`,
      );
    }
  });
});
