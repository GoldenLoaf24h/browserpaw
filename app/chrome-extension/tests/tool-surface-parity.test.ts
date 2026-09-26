import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';

/**
 * The callable tool set must equal the declared schema set.
 *
 * browser/index.ts exports more instances than TOOL_SCHEMAS declares: the
 * network capture start/stop pair is invoked directly by network-capture.ts,
 * get_interactive_elements is internal, and inject-script / userscript register
 * page listeners. Deriving toolsMap from every export made those callable but
 * invisible — a name known to an agent could execute without appearing in
 * tools/list and without schema validation. toolsMap is now filtered to the
 * declared schemas, so this test pins that invariant.
 */
describe('tool surface parity', () => {
  it('every declared schema has an exported implementation', async () => {
    const fs = await import('node:fs');
    const dir = 'entrypoints/background/tools/browser';
    const sources = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.ts'))
      .map((f: string) => fs.readFileSync(`${dir}/${f}`, 'utf-8'))
      .join('\n');

    // Both sides reference TOOL_NAMES constants, so compare the constant keys —
    // comparing resolved names against source text always fails.
    const constantsUsed = new Set(
      (sources.match(/TOOL_NAMES\.BROWSER\.[A-Z_]+/g) || []).map((s) => s.split('.').pop()),
    );
    const schemaConstants = new Set(
      (
        fs
          .readFileSync('../../packages/shared/src/tools.ts', 'utf-8')
          .match(/name: TOOL_NAMES\.BROWSER\.[A-Z_]+/g) || []
      ).map((s) => s.split('.').pop()),
    );

    const missing = [...schemaConstants].filter((c) => !constantsUsed.has(c));
    expect(missing, `declared but not implemented: ${missing.join(', ')}`).toEqual([]);
  });

  it('toolsMap is built from declared schemas, not from every export', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('entrypoints/background/tools/index.ts', 'utf-8');

    // The filter is the fix; without it an undeclared export becomes callable.
    expect(src).toContain('declaredToolNames');
    expect(src).toContain('declaredToolNames.has(tool.name)');
  });

  it('unknown tool names get a "not a BrowserPaw tool" message, not a profile hint', async () => {
    const fs = await import('node:fs');
    for (const path of [
      '../../app/native-server/src/mcp/register-tools.ts',
      '../../app/native-server/src/mcp/mcp-server-stdio.ts',
    ]) {
      const src = fs.readFileSync(path, 'utf-8');
      expect(src, `${path} must distinguish unknown from profile-hidden`).toContain(
        'is not a BrowserPaw tool',
      );
      expect(src).toContain('const known = TOOL_SCHEMAS.some');
    }
  });
});
