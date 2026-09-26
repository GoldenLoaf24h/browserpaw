import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';

/**
 * Guards the SKILL.md and reference examples against drifting away from the tool schemas.
 *
 * Every entry below is an argument object copied from a runnable SKILL.md or reference
 * example, ensuring that agents following documentation never hit schema rejection.
 */
const SKILL_EXAMPLES: Array<[string, Record<string, unknown>]> = [
  ['chrome_navigate', { url: 'https://example.com', background: true }],
  ['chrome_get_markdown', { fit: true }],
  ['chrome_grep', { query: 'Search', searchType: 'interactive_only' }],
  ['chrome_act_toward_goal', { goal: 'Search for wireless keyboard', tabId: 101, maxSteps: 10 }],
  ['chrome_read_dom', { isolateModal: true }],
  ['chrome_interact_index', { index: 1, action: 'click' }],
  ['chrome_fill_index', { index: 2, text: 'developer@example.com', clear: true }],
  ['chrome_fill_index', { index: 2, text: 'developer@example.com', clear: true, pressEnter: true }],
  ['chrome_screenshot', { grid: true, format: 'webp' }],
  ['chrome_screenshot', { fullPage: true, format: 'png' }],
  ['chrome_screenshot', { region: { x0: 300, y0: 200, x1: 700, y1: 500 }, highClarity: true }],
  ['chrome_upload_file', { index: 5, filePath: 'D:/data/document.pdf' }],
  ['chrome_upload_file', { clickTargetIndex: 5, filePath: 'D:/data/document.pdf' }],
  ['chrome_handle_dialog', { action: 'accept', promptText: 'confirmation_code' }],
  ['chrome_javascript', { code: 'document.title' }],
  ['chrome_request_human_intervention', { reason: 'Please solve slider verification' }],
  ['chrome_tool_docs', { category: 'network', activateForSession: true }],
  ['chrome_doctor', {}],
  ['chrome_computer', { action: 'left_click', coordinates: { x: 450, y: 320 } }],
  [
    'chrome_form_pipeline',
    {
      tabId: 101,
      fields: [{ query: 'Full Name', value: 'Jane Doe', type: 'text' }],
      autoAdvance: true,
      maxSteps: 20,
    },
  ],
  [
    'chrome_batch_actions',
    {
      actions: [
        { type: 'fill', index: 2, text: 'a@b.com', clear: true, pressEnter: true },
        { type: 'click', index: 4 },
        { type: 'wait', durationMs: 300 },
      ],
      waitForSettle: true,
    },
  ],
  [
    'chrome_batch_actions',
    {
      actions: [
        { type: 'fill', index: 2, text: 'flight from JFK to LHR', pressEnter: true },
        { type: 'click', index: 5 },
      ],
      includeDelta: true,
      captureNetwork: {
        urlPattern: '*/api/flights*',
        method: 'GET',
      },
    },
  ],
];

describe('SKILL.md parameter examples match the tool schemas', () => {
  const schemas = new Map(TOOL_SCHEMAS.map((t: any) => [t.name, t]));

  it.each(SKILL_EXAMPLES)('%s accepts its documented arguments', (name, args) => {
    const schema = schemas.get(name);
    expect(schema, `${name} must exist in TOOL_SCHEMAS`).toBeTruthy();

    const props = schema!.inputSchema?.properties || {};
    const unknown = Object.keys(args).filter((k) => !(k in props));
    const missing = ((schema!.inputSchema?.required as string[]) || []).filter((k) => !(k in args));

    expect(unknown, `${name} has undocumented params`).toEqual([]);
    expect(missing, `${name} is missing required params`).toEqual([]);
  });

  it('no longer documents the removed or invalid parameter names across skill docs', async () => {
    const fs = await import('node:fs');
    const files = [
      '../../skill/SKILL.md',
      '../../skill/references/batch-pipeline.md',
      '../../skill/references/visual-fallback.md',
      '../../skill/references/dual-brain-jev.md',
    ];

    const ghosts = [
      '"ref":',
      'enableGrid',
      'targetRef',
      'clickTargetRef',
      '"accept":',
      'showRuler',
      'somOptions',
      'submitSelector',
      '"script":',
    ];

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      for (const ghost of ghosts) {
        expect(content.includes(ghost), `${file} must not document ${ghost}`).toBe(false);
      }
    }
  });

  it('verifies mcp-config.json autoApprove contains only valid canonical tools', async () => {
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync('../../skill/config/mcp-config.json', 'utf-8'));
    const autoApprove: string[] =
      config.configurations.cline_and_roo_code.config.mcpServers.browserpaw?.autoApprove ||
      config.configurations.cline_and_roo_code.config.mcpServers.browserclaw?.autoApprove;
    for (const tool of autoApprove) {
      expect(
        schemas.has(tool),
        `autoApprove tool "${tool}" must exist in canonical TOOL_SCHEMAS`,
      ).toBe(true);
    }
  });

  it('verifies user installed skills are synchronized with canonical skill', async () => {
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');
    const canonical = fs.readFileSync('../../skill/SKILL.md', 'utf-8');
    const localDir = fs.existsSync('C:/Users/Lenovo/.gemini/config/skills/browserpaw')
      ? 'C:/Users/Lenovo/.gemini/config/skills/browserpaw'
      : 'C:/Users/Lenovo/.gemini/config/skills/browserclaw';
    const localPath = `${localDir}/SKILL.md`;
    if (!fs.existsSync(localPath)) return;
    const installedSkill = fs.readFileSync(localPath, 'utf-8');

    expect(installedSkill).toBe(canonical);

    // Verify managed hash matches installed SKILL.md
    const managedFile = fs.existsSync(`${localDir}/.browserpaw-managed.json`)
      ? `${localDir}/.browserpaw-managed.json`
      : `${localDir}/.browserclaw-managed.json`;
    if (fs.existsSync(managedFile)) {
      const managedBc = JSON.parse(fs.readFileSync(managedFile, 'utf-8'));
      const actualBcHash = crypto.createHash('sha256').update(installedSkill).digest('hex');
      expect(managedBc.contentHash).toBe(actualBcHash);
    }

    // Verify mcp-chrome skill is also aligned (except name: mcp-chrome)
    const mcpChromeDir = 'C:/Users/Lenovo/.gemini/config/skills/mcp-chrome';
    if (!fs.existsSync(`${mcpChromeDir}/SKILL.md`)) return;
    const installedMcpChrome = fs.readFileSync(`${mcpChromeDir}/SKILL.md`, 'utf-8');
    expect(installedMcpChrome).toBe(
      canonical.replace(/^name:\s*(browserpaw|browserclaw)/m, 'name: mcp-chrome'),
    );
    const managedMcFile = fs.existsSync(`${mcpChromeDir}/.browserpaw-managed.json`)
      ? `${mcpChromeDir}/.browserpaw-managed.json`
      : `${mcpChromeDir}/.browserclaw-managed.json`;
    if (fs.existsSync(managedMcFile)) {
      const managedMc = JSON.parse(fs.readFileSync(managedMcFile, 'utf-8'));
      const actualMcHash = crypto.createHash('sha256').update(installedMcpChrome).digest('hex');
      expect(managedMc.contentHash).toBe(actualMcHash);
    }
  });
});
