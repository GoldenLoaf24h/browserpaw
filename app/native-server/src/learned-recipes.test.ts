import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseCommand, type CallToolResult } from 'chrome-mcp-shared';
import { installSkill } from './skill-install';
import {
  coerceWorkflowInputs,
  expandRecipeSteps,
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

    const workflows = loadLearnedWorkflows(homeDir, { includeCandidates: false });
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

    expect(loadLearnedWorkflows(homeDir, { includeCandidates: false })[0]).toMatchObject({
      id: 'shared-workflow',
      kind: 'skill',
    });
    expect(showLearnedWorkflow('shared-workflow', homeDir)).toMatchObject({
      summary: { id: 'shared-workflow', kind: 'skill' },
    });

    const listed = await dispatchCommand(
      parseCommand(['recipe', 'list']),
      new AbortController().signal,
    );
    expect(listed.structuredContent?.workflows).toEqual([
      expect.objectContaining({ id: 'shared-workflow', kind: 'skill' }),
    ]);

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
      recovery: `browserpaw task finish ${autoTaskId}`,
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
      expect(fs.existsSync(path.join(homeDir, 'recipes', 'x-hot.json'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, 'learned-index.json'))).toBe(true);

      for (const skillDir of [userSkill.installedPath, projectSkill.installedPath]) {
        const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        expect(content).toContain('x-hot (x.com)');
        expect(content).toContain('browserpaw recipe run x-hot query=<query>');
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
      expect(opened.structuredContent).toMatchObject({
        tabId: 42,
        matchedRecipes: [
          {
            id: 'x-hot',
            command: 'browserpaw recipe run x-hot query=<query>',
          },
        ],
      });

      // Standalone recipe run with open step auto-starts and finishes a temporary task
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
      expect(fs.existsSync(path.join(homeDir, 'recipes', 'x-hot.json'))).toBe(false);
      const afterRemove = fs.readFileSync(path.join(userSkill.installedPath, 'SKILL.md'), 'utf8');
      expect(afterRemove).not.toContain('x-hot');
      expect(syncLearnedRouting(homeDir).workflowCount).toBe(0);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
