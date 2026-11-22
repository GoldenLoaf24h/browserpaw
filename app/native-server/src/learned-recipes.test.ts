import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseCommand, type CallToolResult } from 'chrome-mcp-shared';
import { installSkill } from './skill-install';
import {
  coerceWorkflowInputs,
  expandRecipeSteps,
  findLearnedWorkflows,
  loadLearnedWorkflows,
  matchLearnedWorkflows,
  showLearnedWorkflow,
  syncLearnedRouting,
  validateSavedRecipe,
} from './learned-recipes';
import { handleBrowserCall } from './browser-dispatch';
import { dispatchCommand } from './command-dispatch';

jest.mock('./browser-dispatch', () => ({
  handleBrowserCall: jest.fn(),
}));

const mockedBrowserCall = jest.mocked(handleBrowserCall);

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function writeActiveSkill(homeDir: string, id: string, definition: Record<string, unknown>) {
  const skillsDir = path.join(homeDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, `${id}.json`),
    JSON.stringify({
      id,
      activeVersion: 1,
      versions: [{ version: 1, status: 'active', hash: 'test-hash', definition, evidence: [] }],
    }),
  );
}

function writeSavedRecipe(homeDir: string, id: string, steps: string[][]) {
  const recipesDir = path.join(homeDir, 'recipes');
  fs.mkdirSync(recipesDir, { recursive: true });
  fs.writeFileSync(path.join(recipesDir, `${id}.json`), JSON.stringify({ id, name: id, steps }));
}

function createSkillFixture() {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-learned-skill-src-'));
  fs.writeFileSync(
    path.join(sourceDir, 'SKILL.md'),
    '---\nname: browserpaw\ndescription: Base BrowserPaw skill.\n---\n\n# BrowserPaw\n',
  );
  return sourceDir;
}

describe('~/.browserpaw self-learning, CLI execution, and auto-routing', () => {
  let homeDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.BROWSERPAW_HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-learned-home-'));
    process.env.BROWSERPAW_HOME = homeDir;
    mockedBrowserCall.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.BROWSERPAW_HOME;
    else process.env.BROWSERPAW_HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('matches active skills and saved recipes across subdomains and bilingual queries', () => {
    writeActiveSkill(homeDir, 'x-search-thread', {
      id: 'x-search-thread',
      name: 'X search results reader',
      description: 'Read visible X search results and return source-linked posts.',
      domains: ['x.com', 'twitter.com'],
      keywords: ['x', 'twitter', 'search', 'posts'],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', default: 8 },
        },
        required: ['query'],
      },
    });

    const workflows = loadLearnedWorkflows(homeDir, {
      includeCandidates: false,
      includeBundled: false,
    });
    expect(workflows).toHaveLength(1);
    expect(workflows[0].command).toBe('browserpaw recipe run x-search-thread query=<query>');

    const zhMatch = matchLearnedWorkflows(workflows, { query: '推特搜索' });
    expect(zhMatch[0]?.id).toBe('x-search-thread');

    const subdomainMatch = matchLearnedWorkflows(workflows, {
      url: 'https://mobile.twitter.com/search?q=ai',
    });
    expect(subdomainMatch[0]?.id).toBe('x-search-thread');

    const spoofed = matchLearnedWorkflows(workflows, {
      url: 'https://x.com.attacker.test/search?q=ai',
    });
    expect(spoofed).toEqual([]);
  });

  it('validates saved recipes, rejects secrets, coerces typed inputs, and URL-encodes URL placeholders', () => {
    expect(() =>
      validateSavedRecipe({
        id: 'bad-secret',
        steps: [['open', 'https://example.com/?token=secret123']],
      }),
    ).toThrow(/credential/i);

    expect(() =>
      validateSavedRecipe({
        id: 'bad-header',
        notes: 'Bearer supersecrettokenvalue1234',
        steps: [['text', 'css:h1']],
      }),
    ).toThrow(/credential/i);

    const coerced = coerceWorkflowInputs(
      { query: 'gpt 6', limit: '5', strict: 'true' },
      {
        query: { type: 'string', required: true },
        limit: { type: 'integer', default: 8 },
        strict: { type: 'boolean' },
        lang: { type: 'string', default: 'en' },
      },
    );
    expect(coerced).toEqual({ query: 'gpt 6', limit: 5, strict: true, lang: 'en' });
    expect(() => coerceWorkflowInputs({ limit: 'five' }, { limit: { type: 'integer' } })).toThrow(
      /integer/,
    );

    const expanded = expandRecipeSteps(
      [
        ['open', 'https://x.com/search?q={{query}}&f=live'],
        ['fill', 'css:input', '{{query}}'],
        ['open', '{{target}}'],
      ],
      { query: 'AI agent', target: 'https://example.com/a?b=1' },
    );
    expect(expanded).toEqual([
      ['open', 'https://x.com/search?q=AI%20agent&f=live'],
      ['fill', 'css:input', 'AI agent'],
      ['open', 'https://example.com/a?b=1'],
    ]);
  });

  it('rejects volatile targeting options and observed element refs in saved recipes', () => {
    for (const args of [
      ['click', 'css:#go', '--tab', '12'],
      ['click', 'css:#go', '--task', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['click', 'css:#go', '--session', 'persistent'],
      ['click', 'css:#go', '--recipe', 'nested'],
    ]) {
      expect(() => validateSavedRecipe({ id: 'volatile-context', steps: [args] })).toThrow(
        /volatile targeting option/,
      );
    }
    for (const args of [
      ['click', '12'],
      ['fill', '3', 'text'],
      ['press', 'Control+A', '4'],
    ]) {
      expect(() => validateSavedRecipe({ id: 'volatile-target', steps: [args] })).toThrow(
        /volatile observed ref.*durable css:/,
      );
    }
  });

  it('uses one canonical Skill-before-recipe resolution for list, show, run, and save', async () => {
    writeSavedRecipe(homeDir, 'shared-workflow', [['text', 'css:.recipe']]);
    writeActiveSkill(homeDir, 'shared-workflow', {
      id: 'shared-workflow',
      name: 'Canonical Skill',
      domains: ['example.com'],
      inputSchema: { type: 'object', properties: {} },
    });

    expect(
      loadLearnedWorkflows(homeDir, { includeCandidates: false, includeBundled: false })[0],
    ).toMatchObject({
      id: 'shared-workflow',
      kind: 'skill',
    });
    expect(showLearnedWorkflow('shared-workflow', homeDir)).toMatchObject({
      summary: { id: 'shared-workflow', kind: 'skill' },
    });

    const listed = loadLearnedWorkflows(homeDir, {
      includeCandidates: false,
      includeBundled: false,
    });
    expect(listed).toEqual([expect.objectContaining({ id: 'shared-workflow', kind: 'skill' })]);

    mockedBrowserCall
      .mockResolvedValueOnce(
        result({
          id: 'shared-workflow',
          status: 'active',
          definition: { inputSchema: { type: 'object', properties: {} } },
        }),
      )
      .mockResolvedValueOnce(result({ success: true, kind: 'skill' }));
    const ran = await dispatchCommand(
      parseCommand(['recipe', 'run', 'shared-workflow']),
      new AbortController().signal,
    );
    expect(ran.isError).toBe(false);
    expect(mockedBrowserCall.mock.calls[0][0]).toBe('chrome_skill');
    expect(mockedBrowserCall.mock.calls[0][1]).toMatchObject({ action: 'get' });

    await expect(
      dispatchCommand(
        parseCommand(['recipe', 'save', 'placeholder.json']),
        new AbortController().signal,
        { id: 'shared-workflow', steps: [['text', 'css:h1']] },
      ),
    ).rejects.toThrow(/already used by a built-in or active Skill.*distinct ID/);
  });

  it('keeps caller context authoritative over legacy recipe step options', async () => {
    writeSavedRecipe(homeDir, 'legacy-context', [['click', 'css:#go', '--tab', '99']]);
    mockedBrowserCall.mockResolvedValueOnce(result({ success: true }));

    await dispatchCommand(
      parseCommand(['recipe', 'run', 'legacy-context', '--tab', '7']),
      new AbortController().signal,
    );

    expect(mockedBrowserCall).toHaveBeenCalledWith(
      'chrome_batch_actions',
      { actions: [{ type: 'click', selector: '#go' }], tabId: 7 },
      'cli-tab:7',
      expect.any(AbortSignal),
    );
  });

  it('reports auto-task IDs and surfaces cleanup failures after a successful recipe', async () => {
    writeSavedRecipe(homeDir, 'cleanup-failure', [
      ['open', 'https://example.com'],
      ['text', 'css:h1'],
    ]);
    const autoTaskId = '22222222-2222-4222-8222-222222222222';
    mockedBrowserCall
      .mockResolvedValueOnce(result({ ok: true, task: { id: autoTaskId } }))
      .mockResolvedValueOnce(result({ ok: true, tabId: 77 }))
      .mockResolvedValueOnce(result({ success: true, text: 'heading' }))
      .mockResolvedValueOnce(
        result({ success: false, status: 'failed', error: 'close denied' }, true),
      );

    const ran = await dispatchCommand(
      parseCommand(['recipe', 'run', 'cleanup-failure']),
      new AbortController().signal,
    );

    expect(ran.isError).toBe(true);
    expect(ran.structuredContent).toMatchObject({
      taskId: autoTaskId,
      success: false,
      status: 'cleanup_pending',
      cleanupPending: true,
      cleanupError: 'close denied',
      recovery: `browserpaw task finish --task ${autoTaskId}`,
    });
  });

  it('saves recipes into ~/.browserpaw, syncs global and project skills, and dispatches auto-routed commands', async () => {
    const sourceDir = createSkillFixture();
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-user-skills-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-proj-skills-'));
    try {
      const userSkill = installSkill({ sourceDir, targetRoot: userRoot, version: '5.0.0' });
      const projectSkill = installSkill({
        sourceDir,
        scope: 'project',
        cwd: projectRoot,
        version: '5.0.0',
      });
      fs.writeFileSync(
        path.join(homeDir, 'installation.json'),
        JSON.stringify({
          version: '5.0.0',
          browsers: ['chrome'],
          skillPath: projectSkill.installedPath,
          skillPaths: [userSkill.installedPath, projectSkill.installedPath],
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      );

      const saveRes = await dispatchCommand(
        parseCommand(['recipe', 'save', 'x-hot.json']),
        new AbortController().signal,
        {
          id: 'x-hot',
          name: 'Twitter Quick Search',
          description: 'Search Twitter posts by query',
          keywords: ['twitter', 'x', 'search', '推特'],
          steps: [
            ['open', 'https://x.com/search?q={{query}}&f=live'],
            ['text', 'css:main'],
          ],
        },
      );
      expect(saveRes.isError).toBeFalsy();
      expect(fs.existsSync(path.join(homeDir, 'recipes', 'x-hot.candidate.json'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, 'learned-index.json'))).toBe(true);

      for (const skillDir of [userSkill.installedPath, projectSkill.installedPath]) {
        const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        expect(content).not.toContain('x-hot (x.com)');
      }

      // Opening x.com returns matchedRecipes hint automatically
      mockedBrowserCall.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: 42 }) }],
        isError: false,
      });
      const opened = await dispatchCommand(
        parseCommand(['open', 'https://x.com/home']),
        new AbortController().signal,
      );
      const matchedIds = (
        (opened.structuredContent?.matchedRecipes as Array<{ id: string }> | undefined) ?? []
      ).map((item) => item.id);
      expect(matchedIds).not.toContain('x-hot');
      expect(matchedIds).toEqual(
        expect.arrayContaining(['x-search-thread', 'x-profile-posts', 'x-visible-thread']),
      );

      // Candidate recipes remain explicitly runnable without entering automatic routing.
      mockedBrowserCall.mockClear();
      const autoTaskId = '11111111-1111-4111-8111-111111111111';
      mockedBrowserCall
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, task: { id: autoTaskId } }) }],
          isError: false,
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, tabId: 77 }) }],
          isError: false,
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ success: true, text: 'posts' }) }],
          isError: false,
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
          isError: false,
        });
      const ran = await dispatchCommand(
        parseCommand(['recipe', 'run', 'x-hot', 'query=ai agent']),
        new AbortController().signal,
      );
      expect(ran.isError).toBe(false);
      expect(ran.structuredContent?.taskId).toBe(autoTaskId);
      expect(mockedBrowserCall.mock.calls[0][0]).toBe('chrome_task');
      expect(mockedBrowserCall.mock.calls[0][1]).toMatchObject({ action: 'start' });
      expect(mockedBrowserCall.mock.calls[1][1]).toMatchObject({
        action: 'open',
        url: 'https://x.com/search?q=ai%20agent&f=live',
      });
      expect(mockedBrowserCall.mock.calls[3][1]).toMatchObject({
        action: 'finish',
        taskId: autoTaskId,
      });

      // Verified skill execution coerces integer inputs before calling chrome_skill
      mockedBrowserCall
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: 'x-search-thread',
                status: 'active',
                definition: {
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string' },
                      limit: { type: 'integer', default: 8 },
                    },
                    required: ['query'],
                  },
                },
              }),
            },
          ],
          isError: false,
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ success: true, posts: [] }) }],
          isError: false,
        });
      await dispatchCommand(
        parseCommand(['recipe', 'run', 'x-search-thread', 'query=codex', 'limit=5']),
        new AbortController().signal,
      );
      expect(mockedBrowserCall).toHaveBeenLastCalledWith(
        'chrome_skill',
        { action: 'run', id: 'x-search-thread', inputs: { query: 'codex', limit: 5 } },
        undefined,
        expect.any(AbortSignal),
      );

      // Candidate skill returns an actionable validation hint instead of opaque failure
      mockedBrowserCall.mockResolvedValueOnce({
        content: [
          { type: 'text', text: JSON.stringify({ id: 'mdn-search', status: 'candidate' }) },
        ],
        isError: false,
      });
      const candidateRun = await dispatchCommand(
        parseCommand(['recipe', 'run', 'mdn-search', 'query=fetch']),
        new AbortController().signal,
      );
      expect(candidateRun.isError).toBe(true);
      expect(candidateRun.structuredContent).toMatchObject({
        code: 'skill_unvalidated',
      });

      // Removing the recipe clears it from ~/.browserpaw and synced skills
      await dispatchCommand(parseCommand(['recipe', 'rm', 'x-hot']), new AbortController().signal);
      expect(fs.existsSync(path.join(homeDir, 'recipes', 'x-hot.candidate.json'))).toBe(false);
      const afterRemove = fs.readFileSync(path.join(userSkill.installedPath, 'SKILL.md'), 'utf8');
      expect(afterRemove).not.toContain('x-hot');
      const synced = syncLearnedRouting(homeDir);
      expect(synced.workflowCount).toBe(
        loadLearnedWorkflows(homeDir, { includeCandidates: false }).length,
      );
      expect(
        loadLearnedWorkflows(homeDir, { includeCandidates: false, includeBundled: false }),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('patches a candidate without replacing the active revision and promotes only a verified read-only candidate', async () => {
    writeSavedRecipe(homeDir, 'x-search', [
      ['open', 'https://x.com/search?q={{query}}'],
      ['text', 'css:main'],
    ]);
    const activePath = path.join(homeDir, 'recipes', 'x-search.json');
    const candidatePath = path.join(homeDir, 'recipes', 'x-search.candidate.json');
    const activeBefore = fs.readFileSync(activePath, 'utf8');

    const patched = await dispatchCommand(
      parseCommand(['recipe', 'patch', 'x-search', '--step', '1', '--', 'text', 'css:article']),
      new AbortController().signal,
    );
    expect(patched.structuredContent).toMatchObject({ status: 'candidate', stepIndex: 1 });
    expect(fs.readFileSync(activePath, 'utf8')).toBe(activeBefore);
    expect(JSON.parse(fs.readFileSync(candidatePath, 'utf8'))).toMatchObject({
      id: 'x-search',
      status: 'candidate',
      steps: [
        ['open', 'https://x.com/search?q={{query}}'],
        ['text', 'css:article'],
      ],
    });
    expect(
      loadLearnedWorkflows(homeDir, { includeCandidates: false, includeBundled: false }),
    ).toHaveLength(1);
    expect(
      loadLearnedWorkflows(homeDir, { includeCandidates: true, bundledDir: homeDir }).find(
        (workflow) => workflow.id === 'x-search',
      ),
    ).toMatchObject({ id: 'x-search', status: 'candidate' });

    mockedBrowserCall
      .mockResolvedValueOnce(result({ ok: true, tabId: 7 }))
      .mockResolvedValueOnce(result({ success: true, text: 'active' }));
    await dispatchCommand(
      parseCommand(['recipe', 'run', 'x-search', 'query=codex', '--tab', '7']),
      new AbortController().signal,
    );
    expect(mockedBrowserCall).toHaveBeenCalledTimes(2);
    expect(mockedBrowserCall.mock.calls[0]).toEqual([
      'chrome_navigate',
      { tabId: 7, url: 'https://x.com/search?q=codex' },
      'cli-tab:7',
      expect.any(AbortSignal),
    ]);
    expect(JSON.stringify(mockedBrowserCall.mock.calls[1])).toContain('main');
    mockedBrowserCall.mockClear();

    const autoTaskId = '33333333-3333-4333-8333-333333333333';
    mockedBrowserCall
      .mockResolvedValueOnce(result({ ok: true, task: { id: autoTaskId } }))
      .mockResolvedValueOnce(result({ ok: true, tabId: 77 }))
      .mockResolvedValueOnce(result({ success: true, text: 'results' }))
      .mockResolvedValueOnce(result({ ok: true }));

    const validated = await dispatchCommand(
      parseCommand(['recipe', 'validate', 'x-search', 'query=codex']),
      new AbortController().signal,
    );
    expect(validated.structuredContent).toMatchObject({ status: 'active', taskId: autoTaskId });
    expect(validated.isError).toBeFalsy();
    expect(fs.existsSync(candidatePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8'))).toMatchObject({
      status: 'active',
      steps: [
        ['open', 'https://x.com/search?q={{query}}'],
        ['text', 'css:article'],
      ],
    });
  });

  it('keeps write-capable candidates manual and returns failed-step context without page text', async () => {
    writeSavedRecipe(homeDir, 'write-candidate', [
      ['open', 'https://example.com'],
      ['click', 'css:button'],
    ]);
    fs.writeFileSync(
      path.join(homeDir, 'recipes', 'write-candidate.candidate.json'),
      JSON.stringify({
        id: 'write-candidate',
        status: 'candidate',
        steps: [
          ['open', 'https://example.com'],
          ['click', 'css:button'],
        ],
      }),
    );
    const manual = await dispatchCommand(
      parseCommand(['recipe', 'validate', 'write-candidate']),
      new AbortController().signal,
    );
    expect(manual.isError).toBe(true);
    expect(manual.structuredContent).toMatchObject({ code: 'manual_validation_required' });
    expect(mockedBrowserCall).not.toHaveBeenCalled();

    const autoTaskId = '44444444-4444-4444-8444-444444444444';
    mockedBrowserCall
      .mockResolvedValueOnce(result({ ok: true, task: { id: autoTaskId } }))
      .mockResolvedValueOnce(result({ ok: true, tabId: 77 }))
      .mockResolvedValueOnce(result({ success: false, error: 'button missing' }, true))
      .mockResolvedValueOnce(
        result({ tabUrl: 'https://example.com', tabTitle: 'Example', interactiveCount: 3 }),
      )
      .mockResolvedValueOnce(result({ ok: true }));
    const failed = await dispatchCommand(
      parseCommand(['recipe', 'run', 'write-candidate']),
      new AbortController().signal,
    );
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      recipeId: 'write-candidate',
      failedStepIndex: 1,
      failedStep: { index: 1, command: 'click', template: ['click', 'css:button'] },
      completedSteps: 1,
      pageSummary: { url: 'https://example.com', title: 'Example', interactiveElements: 3 },
    });
    expect(JSON.stringify(failed.structuredContent)).not.toContain('button missing'.repeat(100));
  });

  it('validates expanded inputs on an existing tab and preserves a candidate edited mid-run', async () => {
    const directory = path.join(homeDir, 'recipes');
    const candidatePath = path.join(directory, 'lookup.candidate.json');
    const candidate = {
      id: 'lookup',
      status: 'candidate',
      inputs: { query: { type: 'string' } },
      steps: [['find', '{{query}}']],
    };
    fs.mkdirSync(directory);
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));
    mockedBrowserCall.mockImplementationOnce(async (_, fields) => {
      expect(fields).toMatchObject({ query: 'actual input' });
      fs.writeFileSync(candidatePath, JSON.stringify({ ...candidate, name: 'New draft' }));
      return result({ success: true });
    });
    const validation = await dispatchCommand(
      parseCommand(['recipe', 'validate', 'lookup', 'query=actual input', '--tab', '7']),
      new AbortController().signal,
    );
    expect(validation.structuredContent).toMatchObject({ code: 'recipe_candidate_changed' });
    expect(fs.existsSync(path.join(directory, 'lookup.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(candidatePath, 'utf8')).name).toBe('New draft');
  });

  it('discovers trusted canonical bundled skills by default and matches Chinese queries without --all', () => {
    const canonicalBundledDir = path.resolve(
      __dirname,
      '../../../skills/browserpaw/assets/recipes',
    );
    const defaults = loadLearnedWorkflows(homeDir, { bundledDir: canonicalBundledDir });
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.every((item) => item.kind === 'skill' && item.status === 'bundled')).toBe(true);
    expect(defaults.map((item) => item.id)).toEqual(
      expect.arrayContaining(['x-search-thread', 'reddit-subreddit-posts']),
    );

    const canonicalMatch = matchLearnedWorkflows(defaults, { query: '推特搜索' });
    expect(canonicalMatch[0]).toMatchObject({ id: 'x-search-thread', status: 'bundled' });

    const found = findLearnedWorkflows(homeDir, { query: '推特搜索' });
    expect(found.matches[0]).toMatchObject({ id: 'x-search-thread', status: 'bundled' });
  });

  it('suppresses bundled entries when a skill is disabled, rolled back/pinned, or user-owned', () => {
    const canonicalBundledDir = path.resolve(
      __dirname,
      '../../../skills/browserpaw/assets/recipes',
    );
    const skillsDir = path.join(homeDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, 'x-search-thread.json');

    // 1. Disabled skill suppresses bundled entry
    fs.writeFileSync(
      skillPath,
      JSON.stringify({
        id: 'x-search-thread',
        autoUpdatePolicy: 'disabled',
        versions: [
          {
            version: 1,
            status: 'disabled',
            hash: 'disabled-hash',
            definition: { id: 'x-search-thread', source: { type: 'builtin', urls: [] } },
            evidence: [],
          },
        ],
      }),
    );
    expect(
      loadLearnedWorkflows(homeDir, { bundledDir: canonicalBundledDir }).some(
        (item) => item.id === 'x-search-thread',
      ),
    ).toBe(false);

    // 2. Rolled-back / pinned active skill exposes only the active version without a duplicate bundled entry
    fs.writeFileSync(
      skillPath,
      JSON.stringify({
        id: 'x-search-thread',
        activeVersion: 1,
        autoUpdatePolicy: 'pinned',
        versions: [
          {
            version: 1,
            status: 'active',
            hash: 'pinned-v1',
            definition: {
              id: 'x-search-thread',
              name: 'Pinned v1 X search',
              domains: ['x.com'],
              source: { type: 'builtin', urls: ['https://x.com/'] },
              inputSchema: { type: 'object', properties: {} },
            },
            evidence: [],
          },
          {
            version: 2,
            status: 'verified',
            hash: 'newer-v2',
            definition: {
              id: 'x-search-thread',
              name: 'Newer v2 X search',
              domains: ['x.com'],
              source: { type: 'builtin', urls: ['https://x.com/'] },
              inputSchema: { type: 'object', properties: {} },
            },
            evidence: [],
          },
        ],
      }),
    );
    const pinnedMatches = loadLearnedWorkflows(homeDir, {
      bundledDir: canonicalBundledDir,
    }).filter((item) => item.id === 'x-search-thread');
    expect(pinnedMatches).toHaveLength(1);
    expect(pinnedMatches[0]).toMatchObject({ status: 'active', name: 'Pinned v1 X search' });

    // 3a. User-owned candidate suppresses bundled entry by default
    fs.writeFileSync(
      skillPath,
      JSON.stringify({
        id: 'x-search-thread',
        versions: [
          {
            version: 1,
            status: 'candidate',
            hash: 'user-candidate',
            definition: {
              id: 'x-search-thread',
              name: 'User candidate X search',
              domains: ['x.com'],
              source: { type: 'agent', urls: ['https://x.com/'] },
              inputSchema: { type: 'object', properties: {} },
            },
            evidence: [],
          },
        ],
      }),
    );
    expect(
      loadLearnedWorkflows(homeDir, { bundledDir: canonicalBundledDir }).some(
        (item) => item.id === 'x-search-thread',
      ),
    ).toBe(false);

    // 3b. Active user-owned skill exposes only the user-owned entry without a duplicate bundled entry
    writeActiveSkill(homeDir, 'x-search-thread', {
      id: 'x-search-thread',
      name: 'User active X search',
      domains: ['x.com'],
      source: { type: 'agent', urls: ['https://x.com/'] },
      inputSchema: { type: 'object', properties: {} },
    });
    const userActiveMatches = loadLearnedWorkflows(homeDir, {
      bundledDir: canonicalBundledDir,
    }).filter((item) => item.id === 'x-search-thread');
    expect(userActiveMatches).toHaveLength(1);
    expect(userActiveMatches[0]).toMatchObject({ status: 'active', name: 'User active X search' });
  });

  it('hides forged builtin skills with unapproved JavaScript hashes unless includeCandidates is true', () => {
    const forgedBundledDir = path.join(homeDir, 'forged-bundled');
    fs.mkdirSync(forgedBundledDir, { recursive: true });
    const forgedCode = 'return { success: true, sources: { page: location.href } };';

    fs.writeFileSync(
      path.join(forgedBundledDir, 'forged-builtin.json'),
      JSON.stringify({
        id: 'forged-builtin',
        name: 'Forged builtin',
        description: 'Untrusted custom JS pretending to be builtin',
        source: { type: 'builtin', urls: ['https://example.com/'] },
        domains: ['example.com'],
        steps: [{ tool: 'chrome_javascript', args: { code: forgedCode }, resultPath: '/result' }],
      }),
    );
    fs.writeFileSync(
      path.join(forgedBundledDir, 'x-search-thread.json'),
      JSON.stringify({
        id: 'x-search-thread',
        name: 'Tampered X search',
        description: 'Tampered JS with a valid builtin id',
        source: { type: 'builtin', urls: ['https://x.com/'] },
        domains: ['x.com'],
        steps: [{ tool: 'chrome_javascript', args: { code: forgedCode }, resultPath: '/result' }],
      }),
    );

    expect(
      loadLearnedWorkflows(homeDir, { includeCandidates: false, bundledDir: forgedBundledDir }),
    ).toEqual([]);

    const withCandidates = loadLearnedWorkflows(homeDir, {
      includeCandidates: true,
      bundledDir: forgedBundledDir,
    });
    expect(withCandidates).toHaveLength(2);
    expect(withCandidates.every((item) => item.status === 'candidate')).toBe(true);
  });
});
