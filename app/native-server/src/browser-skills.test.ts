import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserSkillStore, type SkillBrowser, type SkillDefinition } from './browser-skills';
import { createDomExtractionStep } from './skill-read-program';
import { JevClientWrapper } from './jev/jev-client';
import { jevModelManager } from './server/jev-model-manager';

const result = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  isError,
});

describe('verified browser skills', () => {
  let root: string;
  let browser: SkillBrowser;
  let store: BrowserSkillStore;
  let taskNumber: number;
  const definition = (): SkillDefinition => ({
    id: 'example-search',
    name: 'Example search',
    description: 'Find documentation with source links',
    source: { type: 'agent', urls: ['https://example.com/'] },
    domains: ['example.com'],
    keywords: ['documentation', 'search'],
    startUrl: 'https://example.com/search?q={{query}}',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { const: true },
        fields: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
          },
          required: ['title'],
          additionalProperties: false,
        },
        sources: {
          type: 'object',
          properties: { page: { const: 'https://example.com/' } },
          required: ['page'],
          additionalProperties: false,
        },
      },
      required: ['success', 'fields', 'sources'],
      additionalProperties: false,
    },
    steps: [
      createDomExtractionStep({ fields: [{ name: 'title', selector: 'h1', value: 'text' }] }),
    ],
    verification: { tool: 'chrome_read_dom', args: { format: 'compact' } },
    tests: [
      {
        inputs: { query: 'alpha' },
        expect: { properties: { fields: { properties: { title: { const: 'alpha' } } } } },
        observe: { type: 'object', required: ['text'], properties: { text: { pattern: 'alpha' } } },
      },
      {
        inputs: { query: 'beta' },
        expect: { properties: { fields: { properties: { title: { const: 'beta' } } } } },
        observe: { type: 'object', required: ['text'], properties: { text: { pattern: 'beta' } } },
      },
    ],
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-skills-'));
    taskNumber = 0;
    const queries = new Map<string, string>();
    browser = {
      start: jest.fn(async () => ({ taskId: `task-${++taskNumber}` })),
      open: jest.fn(async () => ({ tabId: 100 + taskNumber })),
      call: jest.fn(async (taskId, tool, args) => {
        if (tool === 'chrome_read_dom') return result({ text: queries.get(taskId) });
        const inputs = JSON.parse(
          String(args.code).split('\n')[0].slice('const input = '.length, -1),
        );
        queries.set(taskId, inputs.query);
        return result({
          success: true,
          result: JSON.stringify({
            success: true,
            fields: { title: inputs.query },
            sources: { page: 'https://example.com/' },
          }),
        });
      }),
      finish: jest.fn(async () => {}),
    };
    store = new BrowserSkillStore({ root, browser });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a proposed skill undiscoverable until two independent inputs pass in fresh tasks', async () => {
    const proposed = await store.propose(definition());
    expect(proposed.status).toBe('candidate');
    expect(await store.find('https://example.com/', 'search')).toEqual([]);
    const verified = await store.validate('example-search');
    expect(verified.status).toBe('active');
    expect(browser.start).toHaveBeenCalledTimes(2);
    expect(browser.finish).toHaveBeenCalledTimes(2);
    expect((await store.find('https://example.com/', 'documentation'))[0].version).toBe(1);
    expect(await store.find('https://example.com.attacker.test/', 'documentation')).toEqual([]);
  });

  it('rejects duplicated verification inputs and invalid inputs before opening a page', async () => {
    const bad = definition();
    bad.tests[1].inputs = { query: 'alpha' };
    await expect(store.propose(bad)).rejects.toThrow(/different inputs/i);
    await store.propose(definition());
    await store.validate('example-search');
    jest.mocked(browser.start).mockClear();
    await expect(store.run('example-search', { query: '' })).rejects.toThrow(/input/i);
    expect(browser.start).not.toHaveBeenCalled();
  });

  it('requires every independent source to agree before activating a comparison skill', async () => {
    const def = definition();
    def.verification = [
      ...(Array.isArray(def.verification) ? def.verification : [def.verification]),
      {
        tool: 'chrome_network_request',
        args: { url: 'https://example.com/meta?q={{query}}', method: 'GET' },
        resultPath: '/response/body',
      },
    ];
    for (const test of def.tests) {
      test.observe = [
        ...(Array.isArray(test.observe) ? test.observe : [test.observe]),
        {
          type: 'object',
          required: ['name'],
          properties: { name: { const: test.inputs.query } },
        },
      ];
    }
    const baseCall = jest.mocked(browser.call).getMockImplementation()!;
    let sourcesAgree = false;
    browser.call = jest.fn(async (taskId, tool, args, sessionId) => {
      if (tool === 'chrome_network_request')
        return result({
          response: {
            body: {
              name: sourcesAgree ? new URL(String(args.url)).searchParams.get('q') : 'wrong',
            },
          },
        });
      return baseCall(taskId, tool, args, sessionId);
    });
    await store.propose(def);
    await expect(store.validate(def.id)).rejects.toThrow(/independent observation/);
    expect(await store.find('https://example.com/', 'search')).toEqual([]);
    expect(browser.finish).toHaveBeenCalledTimes(1);
    sourcesAgree = true;
    await store.validate(def.id);
    expect((await store.find('https://example.com/', 'search'))[0].status).toBe('active');
    expect(store.get(def.id).evidence).toHaveLength(2);
    expect(browser.finish).toHaveBeenCalledTimes(3);
  });

  it('rejects a comparison with a missing or non-read independent check before any page opens', async () => {
    const def = definition();
    const verification = Array.isArray(def.verification) ? def.verification[0] : def.verification;
    const verifications = [verification, verification];
    def.verification = verifications;
    await expect(store.propose(def)).rejects.toThrow(/corresponding observation/);
    for (const test of def.tests) {
      const observation = Array.isArray(test.observe) ? test.observe[0] : test.observe;
      test.observe = [observation, observation];
    }
    verifications[1] = {
      tool: 'chrome_network_request',
      args: { url: 'https://example.com/', method: 'POST' },
    };
    await expect(store.propose(def)).rejects.toThrow(/GET/);
    verifications[1] = { tool: 'chrome_network_request' } as any;
    await expect(store.propose(def)).rejects.toThrow(/verification|DOM|GET/i);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('does not accept a script claiming success when the independent page observation disagrees', async () => {
    await store.propose(definition());
    jest
      .mocked(browser.call)
      .mockResolvedValueOnce(
        result({
          success: true,
          result: JSON.stringify({
            success: true,
            fields: { title: 'alpha' },
            sources: { page: 'https://example.com/' },
          }),
        }),
      )
      .mockResolvedValueOnce(result({ text: 'Sign in required' }));
    await expect(store.validate('example-search')).rejects.toThrow(
      /output|independent observation/i,
    );
    expect(await store.find('https://example.com/', 'search')).toEqual([]);
    expect(browser.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'unknown'])(
    'preserves %s delivery and content from the independent verification call',
    async (status) => {
      await store.propose(definition());
      const original = jest.mocked(browser.call).getMockImplementation()!;
      const controller = new AbortController();
      const delivery = {
        ...result(
          { success: false, status, retry: false, receipt: { event: 'original-read' } },
          true,
        ),
        content: [
          { type: 'image' as const, mimeType: 'image/png', data: 'dGVzdA==' },
          ...result({ success: false, status, retry: false, receipt: { event: 'original-read' } })
            .content,
        ],
      };
      jest.mocked(browser.call).mockImplementation(async (...args) => {
        if (args[1] !== 'chrome_read_dom') return original(...args);
        expect((args as unknown[])[4]).toBe(controller.signal);
        if (status === 'cancelled') controller.abort();
        return delivery;
      });
      await expect(
        store.validate('example-search', undefined, controller.signal, 'owner'),
      ).rejects.toMatchObject({ status, retry: false, result: delivery });
      expect(browser.start).toHaveBeenCalledTimes(1);
      expect(browser.finish).toHaveBeenLastCalledWith('task-1', 'owner');
      expect(await store.find('https://example.com/', 'search')).toEqual([]);
    },
  );

  it('serializes JS parameters as data and encodes URL parameters', async () => {
    await store.propose(definition());
    await store.validate('example-search');
    const query = '";throw Error("injected"); // &admin=true';
    const output = await store.run('example-search', { query });
    expect(output.output).toEqual({
      success: true,
      fields: { title: query },
      sources: { page: 'https://example.com/' },
    });
    expect(browser.open).toHaveBeenLastCalledWith(
      expect.any(String),
      `https://example.com/search?q=${encodeURIComponent(query)}`,
      undefined,
      undefined,
    );
  });

  it('keeps successful page text mentioning an unknown outcome as ordinary content', async () => {
    await store.propose(definition());
    await store.validate('example-search');
    const query = 'outcome unknown: stale connection troubleshooting';
    const output = await store.run('example-search', { query });
    expect(output.output).toMatchObject({ success: true, fields: { title: query } });
    expect(await store.find('https://example.com/', 'search')).toHaveLength(1);
  });

  it('retains the working version when a replacement fails validation', async () => {
    await store.propose(definition());
    await store.validate('example-search');
    const next = definition();
    next.description = 'replacement';
    await store.propose(next);
    jest.mocked(browser.call).mockResolvedValueOnce(
      result({
        success: true,
        result: JSON.stringify({
          success: true,
          fields: { title: '' },
          sources: { page: 'https://example.com/' },
        }),
      }),
    );
    await expect(store.validate('example-search')).rejects.toThrow(/output/i);
    expect((await store.find('https://example.com/', 'search'))[0].version).toBe(1);
  });

  it('persists activation, suspends a structural failure and can roll back without replaying', async () => {
    await store.propose(definition());
    await store.validate('example-search');
    const next = definition();
    next.description = 'replacement';
    await store.propose(next);
    await store.validate('example-search');
    store = new BrowserSkillStore({ root, browser });
    expect((await store.find('https://example.com/', 'search'))[0].version).toBe(2);
    jest.mocked(browser.call).mockResolvedValueOnce(
      result({
        success: true,
        result: JSON.stringify({
          success: true,
          fields: { title: 9 },
          sources: { page: 'https://example.com/' },
        }),
      }),
    );
    const before = jest.mocked(browser.call).mock.calls.length;
    await expect(store.run('example-search', { query: 'gamma' })).rejects.toThrow(/output/i);
    expect(jest.mocked(browser.call).mock.calls.length - before).toBe(1);
    expect(await store.find('https://example.com/', 'search')).toEqual([]);
    await store.rollback('example-search', 1);
    expect((await store.find('https://example.com/', 'search'))[0].version).toBe(1);
  });

  it('cleans the fresh task on timeout and leaves a verified skill available for transient failures', async () => {
    await store.propose(definition());
    await store.validate('example-search');
    jest.mocked(browser.call).mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(store.run('example-search', { query: 'gamma' })).rejects.toThrow('ECONNRESET');
    expect(browser.finish).toHaveBeenCalledTimes(3);
    expect(await store.find('https://example.com/', 'search')).toHaveLength(1);
  });

  it('stops at an unknown result without running a second step', async () => {
    const def = definition();
    def.steps.push(def.steps[0]);
    await store.propose(def);
    await store.validate('example-search');
    jest
      .mocked(browser.call)
      .mockResolvedValueOnce(result({ status: 'unknown', retry: false }, true));
    const before = jest.mocked(browser.call).mock.calls.length;
    await expect(store.run('example-search', { query: 'gamma' })).rejects.toThrow(/unknown/i);
    expect(jest.mocked(browser.call).mock.calls.length - before).toBe(1);
  });

  it('does not enable a workflow whose nested result reports a failed business state', async () => {
    await store.propose(definition());
    jest.mocked(browser.call).mockResolvedValueOnce(
      result({
        success: true,
        result: {
          success: false,
          status: 'requires_auth',
          message: 'login required',
        },
      }),
    );
    await expect(store.validate('example-search')).rejects.toMatchObject({
      status: 'blocked',
      retry: false,
      output: { success: false, status: 'requires_auth', message: 'login required' },
    });
    expect(await store.find('https://example.com/', 'search')).toEqual([]);
  });

  it('allows parallel verified reads and stops later steps when an in-flight run is cancelled', async () => {
    const def = definition();
    def.steps.push(def.steps[0]);
    await store.propose(def);
    await store.validate(def.id);
    const outputs = await Promise.all([
      store.run(def.id, { query: 'one' }),
      store.run(def.id, { query: 'two' }),
    ]);
    expect(
      outputs.map((item) => (item.output as { fields: { title: string } }).fields.title),
    ).toEqual(['one', 'two']);
    const controller = new AbortController();
    const before = jest.mocked(browser.call).mock.calls.length;
    jest.mocked(browser.call).mockImplementationOnce(async () => {
      controller.abort();
      return result({
        success: true,
        result: JSON.stringify({
          success: true,
          fields: { title: 'three' },
          sources: { page: 'https://example.com/' },
        }),
      });
    });
    await expect(
      store.run(def.id, { query: 'three' }, undefined, controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(jest.mocked(browser.call).mock.calls.length - before).toBe(1);
    expect(await store.find('https://example.com/', 'search')).toHaveLength(1);
  });

  it('forwards cancellation to the in-flight skill step and sends no later step', async () => {
    const def = definition();
    def.steps.push(def.steps[0]);
    await store.propose(def);
    await store.validate(def.id);
    const controller = new AbortController();
    const before = jest.mocked(browser.call).mock.calls.length;
    jest.mocked(browser.call).mockImplementationOnce(async (...args) => {
      expect((args as unknown[])[4]).toBe(controller.signal);
      controller.abort();
      return result({ success: false, status: 'cancelled', retry: false }, true);
    });
    await expect(
      store.run(def.id, { query: 'cancel-step' }, undefined, controller.signal, 'owner'),
    ).rejects.toThrow(/Skill stopped/);
    expect(jest.mocked(browser.call).mock.calls.length - before).toBe(1);
    expect(browser.finish).toHaveBeenLastCalledWith('task-3', 'owner');
    expect(await store.find('https://example.com/', 'search')).toHaveLength(1);
  });

  it('imports distributed data as candidates and preserves activation when a new bundle arrives', async () => {
    const bundled = path.join(root, 'bundled');
    fs.mkdirSync(bundled);
    const def = definition();
    def.source.type = 'builtin';
    fs.writeFileSync(path.join(bundled, 'example-search.json'), JSON.stringify(def));
    await store.loadBundledSkills(bundled);
    await store.loadBundledSkills(bundled);
    expect(store.get(def.id).version).toBe(1);
    expect(store.get(def.id).status).toBe('candidate');
    await store.validate(def.id);
    def.description = 'New bundled candidate';
    fs.writeFileSync(path.join(bundled, 'example-search.json'), JSON.stringify(def));
    await store.loadBundledSkills(bundled);
    expect(store.get(def.id).version).toBe(1);
    expect(store.get(def.id, 2).status).toBe('candidate');
  });

  it('rejects stored credentials, ephemeral refs, traversal and non-read-only automatic recipes', async () => {
    const bad = definition();
    bad.id = '../token';
    await expect(store.propose(bad)).rejects.toThrow(/id/i);
    const credentials = definition();
    credentials.source.urls = ['https://example.com/?token=private'];
    await expect(store.propose(credentials)).rejects.toThrow(/credential/i);
    const ref = definition();
    ref.steps = [{ tool: 'chrome_interact_index', args: { index: 32 } }];
    await expect(store.propose(ref)).rejects.toThrow(/ref|supported/i);
    const write = definition();
    write.steps = [
      { tool: 'chrome_network_request', args: { url: 'https://example.com/', method: 'POST' } },
    ];
    await expect(store.propose(write)).rejects.toThrow(/GET|read/i);
  });

  it('rejects self-authored broad checks and obvious write-oriented embedded code', async () => {
    const broad = definition();
    broad.tests[0].observe = { type: 'string', minLength: 1 };
    await expect(store.propose(broad)).rejects.toThrow(/concrete assertion/i);
    const emptyRequired = definition();
    emptyRequired.tests[0].expect = { type: 'object', required: [] };
    await expect(store.propose(emptyRequired)).rejects.toThrow(/concrete assertion/i);
    const writeCode = definition();
    writeCode.steps[0].args = { code: "document.querySelector('button').click(); return {}" };
    await expect(store.propose(writeCode)).rejects.toThrow(/unsupported|reviewed/i);
    const bracketWrite = definition();
    bracketWrite.steps[0].args = {
      code: "document.querySelector('button')['click'](); return {}",
    };
    await expect(store.propose(bracketWrite)).rejects.toThrow(/unsupported|reviewed/i);
    const dynamicMethod = definition();
    dynamicMethod.steps[0].args = {
      code: "fetch('https://example.com/', {['method']:'POST'}); return {}",
    };
    await expect(store.propose(dynamicMethod)).rejects.toThrow(/unsupported|reviewed/i);
    const leakedToken = definition();
    leakedToken.tests[0].inputs.query = 'ghp_abcdefghijklmnopqrstuvwxyz';
    await expect(store.propose(leakedToken)).rejects.toThrow(/credential/i);
    const missingToolArgs = definition();
    missingToolArgs.steps[0].args = {};
    await expect(store.propose(missingToolArgs)).rejects.toThrow(
      /exactly one|invalid args|bounded/i,
    );
  });

  it('rejects symlinked records without touching the external file', async () => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, 'untouched');
    const link = path.join(root, 'example-search.json');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      return;
    }
    await expect(store.propose(definition())).rejects.toThrow(/symbolic|link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });

  it('resolves find with exact zero-model only on explicit match, models single candidate under ambiguity, and flags coverage_limited above 32', async () => {
    const modeSpy = jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
    const querySpy = jest.spyOn(JevClientWrapper.prototype, 'query');
    try {
      await store.propose(definition());
      await store.validate('example-search');

      // 1. Single candidate with explicit keyword match -> zero model
      querySpy.mockClear();
      const exactMatch = await store.find('https://example.com/', 'documentation');
      expect(exactMatch).toHaveLength(1);
      expect(exactMatch[0].id).toBe('example-search');
      expect(exactMatch[0].diagnostics).toMatchObject({ strategy: 'exact', status: 'exact' });
      expect(querySpy).not.toHaveBeenCalled();

      // 2. Single candidate with ambiguous/unmatched intent -> calls model, none yields empty array
      querySpy.mockClear();
      querySpy.mockResolvedValueOnce({
        result: {
          model: 'jev-test',
          answers: {
            matched_target: {
              type: 'choice',
              choice: 'none',
              confidence: 0.95,
              probabilities: { 'example-search': 0.05, none: 0.95 },
            },
          },
        },
        errorReason: 'network_error',
      } as any);
      const unmatchedSingle = await store.find('https://example.com/', 'book flight ticket');
      expect(unmatchedSingle).toEqual([]);
      expect(querySpy).toHaveBeenCalledTimes(1);

      // 3. Add second candidate -> ambiguity
      const def2 = definition();
      def2.id = 'example-lookup';
      def2.name = 'Example quick lookup';
      def2.description = 'Quick keyword lookup without deep search';
      def2.keywords = ['lookup', 'quick'];
      await store.propose(def2);
      await store.validate('example-lookup');
      querySpy.mockClear();

      // 3a. Model returns matched choice
      querySpy.mockResolvedValueOnce({
        result: {
          model: 'jev-test',
          answers: {
            matched_target: {
              type: 'choice',
              choice: 'example-lookup',
              confidence: 0.95,
              probabilities: { 'example-search': 0.04, 'example-lookup': 0.95, none: 0.01 },
            },
          },
        },
        errorReason: 'network_error',
      } as any);
      const semanticMatched = await store.find('https://example.com/', 'look up fast');
      expect(Array.isArray(semanticMatched)).toBe(true);
      expect(semanticMatched[0].id).toBe('example-lookup');
      expect(semanticMatched[0].diagnostics).toMatchObject({
        strategy: 'semantic',
        status: 'matched',
        matchedId: 'example-lookup',
      });
      expect(querySpy).toHaveBeenCalledTimes(1);

      // 3b. Model returns none -> returns empty array
      querySpy.mockClear();
      querySpy.mockResolvedValueOnce({
        result: {
          model: 'jev-test',
          answers: {
            matched_target: {
              type: 'choice',
              choice: 'none',
              confidence: 0.98,
              probabilities: { 'example-search': 0.01, 'example-lookup': 0.01, none: 0.98 },
            },
          },
        },
        errorReason: 'network_error',
      } as any);
      const noneResult = await store.find('https://example.com/', 'completely unrelated target');
      expect(noneResult).toEqual([]);

      // 4. Over 32 candidates -> do not slice to model; fallback to keyword and flag coverage_limited
      querySpy.mockClear();
      for (let i = 1; i <= 32; i++) {
        const extraDef = definition();
        extraDef.id = `extra-skill-${i}`;
        extraDef.name = `Extra Skill ${i}`;
        extraDef.keywords = [`kw${i}`];
        await store.propose(extraDef);
        await store.validate(extraDef.id);
      }
      querySpy.mockClear();
      const overLimitResult = await store.find('https://example.com/', 'ambiguous search intent');
      expect(overLimitResult.length).toBeLessThanOrEqual(3);
      expect(overLimitResult[0].diagnostics).toMatchObject({
        strategy: 'keyword',
        status: 'unavailable',
        reason: 'coverage_limited',
      });
      expect(querySpy).not.toHaveBeenCalled();

      // 5. Invalid URL throws explicitly without silent fallback
      await expect(store.find('not-a-valid-url', 'search')).rejects.toThrow();

      // 6. Cancelled find throws explicitly, does not return keyword list
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      await expect(
        store.find('https://example.com/', 'ambiguous search', { signal: abortCtrl.signal }),
      ).rejects.toThrow(/cancelled/i);
    } finally {
      querySpy.mockRestore();
      modeSpy.mockRestore();
    }
  });

  it('enforces optional version and definitionHash pins on skill run with hash in summary', async () => {
    await store.propose(definition());
    const validated = await store.validate('example-search');
    const activeHash = validated.hash;
    expect(activeHash).toBeDefined();
    expect((validated as any).definitionHash).toBeUndefined();

    // Mismatched version throws before running
    await expect(
      store.run('example-search', { query: 'alpha' }, undefined, undefined, undefined, {
        version: 999,
      }),
    ).rejects.toThrow(/version.*not match/i);

    // Mismatched definitionHash throws before running
    await expect(
      store.run('example-search', { query: 'alpha' }, undefined, undefined, undefined, {
        definitionHash: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/definition hash.*not match/i);

    // Matching version and definitionHash passes and includes version/hash
    const runResult = await store.run(
      'example-search',
      { query: 'alpha' },
      undefined,
      undefined,
      undefined,
      {
        version: 1,
        definitionHash: activeHash,
      },
    );
    expect(runResult.version).toBe(1);
    expect(runResult.hash).toBe(activeHash);
    expect((runResult as any).definitionHash).toBeUndefined();
  });
});
