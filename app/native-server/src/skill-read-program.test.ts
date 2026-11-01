import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { BrowserSkillStore, type SkillBrowser, type SkillDefinition } from './browser-skills';
import {
  DOM_EXTRACTION_MAX_MATCHES,
  DOM_EXTRACTION_MAX_VALUE_CHARS,
  DOM_EXTRACTION_OUTPUT_SCHEMA,
  DOM_EXTRACTION_PROGRAM,
  DOM_EXTRACTION_PROGRAM_ALIAS,
  createDomExtractionStep,
  assertReadOnlyDomConfig,
} from './skill-read-program';

type JsonObject = Record<string, any>;

const recipeRoot = path.resolve(__dirname, '../../../skills/browserpaw/assets/recipes');
const publishedIds = [
  'github-releases',
  'mdn-search',
  'npm-compare',
  'x-search-thread',
  'x-visible-thread',
];

const toolResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  isError: false,
});

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const genericDefinition = (): SkillDefinition => ({
  id: 'new-site-extract',
  name: 'New site extractor',
  description: 'Read configured fields from a page',
  source: { type: 'agent', urls: ['https://new.example/search?q=alpha'] },
  domains: ['new.example'],
  keywords: ['extract', 'generic'],
  startUrl: 'https://new.example/search?q={{query}}',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
  steps: [
    createDomExtractionStep({
      fields: [
        { name: 'heading', selector: '#heading', value: 'text' },
        {
          name: 'links',
          selector: 'a.detail',
          value: 'attribute',
          attribute: 'href',
          multiple: true,
        },
      ],
    }),
  ],
  verification: { tool: 'chrome_read_dom', args: { format: 'compact' }, resultPath: '/text' },
  tests: [
    {
      inputs: { query: 'alpha' },
      expect: {
        type: 'object',
        properties: {
          fields: {
            properties: {
              heading: { const: 'Alpha result' },
              links: { const: ['/alpha-detail'] },
            },
          },
          sources: {
            properties: { page: { pattern: '^https://new\\.example/search\\?q=alpha$' } },
          },
        },
        required: ['fields', 'sources'],
      },
      observe: { type: 'string', pattern: 'Alpha result' },
    },
    {
      inputs: { query: 'beta' },
      expect: {
        type: 'object',
        properties: {
          fields: {
            properties: {
              heading: { const: 'Beta result' },
              links: { const: ['/beta-detail'] },
            },
          },
          sources: { properties: { page: { pattern: '^https://new\\.example/search\\?q=beta$' } } },
        },
        required: ['fields', 'sources'],
      },
      observe: { type: 'string', pattern: 'Beta result' },
    },
  ],
});

const screenshotDefinition = (args: JsonObject = {}): SkillDefinition => {
  const definition = genericDefinition();
  definition.id = 'new-site-shot';
  definition.steps = [{ tool: 'chrome_screenshot', args: { background: true, ...args } }];
  return definition;
};

const pageFor = (url: string) => {
  const parsed = new URL(url);
  const query = parsed.searchParams.get('query') || parsed.searchParams.get('q') || '';
  const heading = `${query[0]?.toUpperCase() || ''}${query.slice(1)} result`;
  const link = { getAttribute: (name: string) => (name === 'href' ? `/${query}-detail` : null) };
  return {
    location: { href: url },
    text: heading,
    elements: {
      '#heading': [{ textContent: heading, innerText: heading }],
      'a.detail': [link],
    } as Record<string, JsonObject[]>,
  };
};

const executePageCode = async (code: string, page: ReturnType<typeof pageFor>) => {
  const document = {
    querySelectorAll: (selector: string) => page.elements[selector] || [],
  };
  const fn = new Function('location', 'document', `return (async () => {${code}})();`) as (
    location: JsonObject,
    document: JsonObject,
  ) => Promise<unknown>;
  return fn(page.location, document) as Promise<JsonObject>;
};

type PageFixture = ReturnType<typeof pageFor>;

const createBrowser = (makePage: (url: string) => PageFixture = pageFor) => {
  let taskNumber = 0;
  const pages = new Map<string, PageFixture>();
  const browser: SkillBrowser = {
    start: jest.fn(async () => ({ taskId: `task-${++taskNumber}` })),
    open: jest.fn(async (taskId: string, url: string) => {
      pages.set(taskId, makePage(url));
      return { tabId: taskNumber };
    }),
    call: jest.fn(async (taskId: string, tool: string, args: JsonObject) => {
      const page = pages.get(taskId);
      if (!page) throw new Error('Missing page');
      if (tool === 'chrome_javascript') {
        const output = await executePageCode(String(args.code), page);
        return toolResult({ success: true, result: JSON.stringify(output) });
      }
      if (tool === 'chrome_read_dom') return toolResult({ text: page.text });
      throw new Error(`Unexpected tool: ${tool}`);
    }),
    finish: jest.fn(async () => {}),
  };
  return { browser, pages };
};

const writeRecord = (root: string, id: string, mutate: (record: JsonObject) => void) => {
  const filename = path.join(root, `${id}.json`);
  const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as JsonObject;
  mutate(record);
  fs.writeFileSync(filename, JSON.stringify(record, null, 2));
};

const replaceVersionCode = (root: string, id: string, version: number, code: string): void => {
  writeRecord(root, id, (record) => {
    const entry = record.versions.find((item: JsonObject) => item.version === version);
    entry.definition.steps[0].args.code = code;
    delete entry.definition.steps[0].args.program;
    const oldConfig = entry.definition.steps[0].args.config;
    if (oldConfig) delete entry.definition.steps[0].args.config;
    entry.hash = hash(entry.definition);
  });
};

describe('reviewed read-only programs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-readonly-program-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('activates a generic new-domain extractor from two independent module runs', async () => {
    const { browser, pages } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await store.propose(genericDefinition());
    const active = await store.validate('new-site-extract');

    expect(active.status).toBe('active');
    const outputs = pages.size;
    expect(outputs).toBe(2);
    expect(await store.find('https://new.example/search?q=alpha', 'extract')).toHaveLength(1);

    const calls = jest
      .mocked(browser.call)
      .mock.calls.filter(([, tool]) => tool === 'chrome_javascript');
    expect(calls).toHaveLength(2);
    const config = genericDefinition().steps[0].args.config;
    for (const [, , args] of calls) {
      const code = String((args as JsonObject).code);
      expect(code).toBe(
        `const input = ${JSON.stringify({
          query: code.includes('"alpha"') ? 'alpha' : 'beta',
          config,
        })};\n${DOM_EXTRACTION_PROGRAM}`,
      );
      expect(args).not.toHaveProperty('program');
      expect(args).not.toHaveProperty('config');
    }
  });

  it('resolves only the dom-extract alias and rejects mixed or unknown programs', async () => {
    const step = createDomExtractionStep({
      fields: [{ name: 'heading', selector: '#heading', value: 'text' }],
    });
    expect(step.args).toEqual({
      program: DOM_EXTRACTION_PROGRAM_ALIAS,
      config: { fields: [{ name: 'heading', selector: '#heading', value: 'text' }] },
    });
    expect(step.args).not.toHaveProperty('code');

    for (const mutate of [
      (definition: SkillDefinition) => {
        definition.steps[0].args.program = 'unknown-template';
      },
      (definition: SkillDefinition) => {
        definition.steps[0].args.code = DOM_EXTRACTION_PROGRAM;
      },
    ]) {
      const definition = genericDefinition();
      mutate(definition);
      const { browser } = createBrowser();
      const store = new BrowserSkillStore({ root, browser });
      await expect(store.propose(definition)).rejects.toMatchObject({ status: 'unsupported' });
      expect(browser.start).not.toHaveBeenCalled();
      expect(browser.call).not.toHaveBeenCalled();
    }
  });

  it('rejects config fields that could try to add executable options', async () => {
    expect(() =>
      assertReadOnlyDomConfig({
        fields: [
          {
            name: 'heading',
            selector: '#heading',
            value: 'text',
            expression: 'globalThis.pwned = true',
          },
        ],
      }),
    ).toThrow(/config.*unsupported|unsupported.*config/i);

    const definition = genericDefinition();
    definition.steps[0].args.config = {
      fields: [{ name: '__proto__', selector: '#heading', value: 'text' }],
    };
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await expect(store.propose(definition)).rejects.toMatchObject({ status: 'unsupported' });
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it.each([
    [
      'match count',
      { fields: [{ name: 'items', selector: 'li', value: 'text', multiple: true }] },
      {
        location: { href: 'https://new.example/search?q=alpha' },
        text: 'many',
        elements: {
          li: Array.from({ length: DOM_EXTRACTION_MAX_MATCHES + 1 }, (_, index) => ({
            textContent: `item-${index}`,
          })),
        },
      },
      {
        status: 'limit_exceeded',
        count: DOM_EXTRACTION_MAX_MATCHES + 1,
        limit: DOM_EXTRACTION_MAX_MATCHES,
      },
    ],
    [
      'value length',
      { fields: [{ name: 'long', selector: '#long', value: 'text' }] },
      {
        location: { href: 'https://new.example/search?q=alpha' },
        text: 'long',
        elements: {
          '#long': [{ textContent: 'x'.repeat(DOM_EXTRACTION_MAX_VALUE_CHARS + 1) }],
        },
      },
      {
        status: 'value_limit_exceeded',
        length: DOM_EXTRACTION_MAX_VALUE_CHARS + 1,
        limit: DOM_EXTRACTION_MAX_VALUE_CHARS,
      },
    ],
  ])('fails validation instead of truncating %s', async (_name, config, page, output) => {
    const definition = genericDefinition();
    definition.steps[0].args.config = config;
    const { browser } = createBrowser(() => page as PageFixture);
    const store = new BrowserSkillStore({ root, browser });
    await store.propose(definition);
    await expect(store.validate(definition.id)).rejects.toMatchObject({
      status: 'blocked',
      output,
    });
    expect(await store.find('https://new.example/search?q=alpha', 'extract')).toEqual([]);
  });

  it.each([
    ['prototype call', 'HTMLFormElement.prototype.requestSubmit.call(document.forms[0]);'],
    ['apply', "Reflect.apply(fetch, globalThis, ['https://new.example/write', {method:'POST'}]);"],
    ['dynamic property', "globalThis['fet' + 'ch']('https://new.example/write',{method:'POST'});"],
  ])('rejects unapproved %s before validation starts a browser task', async (_name, code) => {
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    const definition = genericDefinition();
    definition.source.type = 'builtin';
    definition.steps[0].args = { code };

    await expect(store.propose(definition)).rejects.toMatchObject({ status: 'unsupported' });
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it('rejects a forged builtin bundle instead of trusting source.type', async () => {
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(bundle);
    const definition = genericDefinition();
    definition.id = 'forged-builtin';
    definition.source.type = 'builtin';
    definition.steps[0].args = {
      code: 'HTMLFormElement.prototype.requestSubmit.call(document.forms[0]);',
    };
    fs.writeFileSync(path.join(bundle, 'forged-builtin.json'), JSON.stringify(definition));
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });

    await expect(store.loadBundledSkills(bundle)).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it('loads all five reviewed programs from their actual bundle contents', async () => {
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(bundle);
    for (const id of publishedIds) {
      fs.copyFileSync(path.join(recipeRoot, `${id}.json`), path.join(bundle, `${id}.json`));
    }
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await store.loadBundledSkills(bundle);

    for (const id of publishedIds) {
      expect(store.get(id).status).toBe('candidate');
    }
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it('allows a reviewed body to be reused by a new personal skill id', async () => {
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(bundle);
    fs.copyFileSync(
      path.join(recipeRoot, 'github-releases.json'),
      path.join(bundle, 'github-releases.json'),
    );
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await store.loadBundledSkills(bundle);

    const cloned = JSON.parse(
      fs.readFileSync(path.join(recipeRoot, 'github-releases.json'), 'utf8'),
    ) as SkillDefinition;
    cloned.id = 'personal-github-reader';
    cloned.name = 'Personal GitHub reader';
    cloned.source.type = 'agent';
    await expect(store.propose(cloned)).resolves.toMatchObject({ status: 'candidate' });
    expect(store.get(cloned.id)).toMatchObject({
      status: 'candidate',
      executionSupported: true,
    });
  });

  it('reports stored status and unsupported execution reason without rewriting a version', async () => {
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await store.propose(genericDefinition());
    await store.validate('new-site-extract');
    const code = "globalThis['fet' + 'ch']('https://new.example/write',{method:'POST'});";
    replaceVersionCode(root, 'new-site-extract', 1, code);

    const version = store.get('new-site-extract');
    expect(version).toMatchObject({
      status: 'active',
      executionSupported: false,
    });
    expect(version.unsupportedReason).toMatch(/reviewed|unsupported/i);
    expect(version.definition.steps[0].args.code).toBe(code);
  });

  it('rechecks tampered validate, run, and rollback versions without rewriting them', async () => {
    const validateBrowser = createBrowser();
    let store = new BrowserSkillStore({ root, browser: validateBrowser.browser });
    await store.propose(genericDefinition());
    const validateCode = "globalThis['fet' + 'ch']('https://new.example/write',{method:'POST'});";
    replaceVersionCode(root, 'new-site-extract', 1, validateCode);
    await expect(store.validate('new-site-extract')).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(validateBrowser.browser.start).not.toHaveBeenCalled();
    expect(validateBrowser.browser.call).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'new-site-extract.json'), 'utf8')).versions[0]
        .definition.steps[0].args.code,
    ).toBe(validateCode);

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-readonly-program-'));
    const runBrowser = createBrowser();
    store = new BrowserSkillStore({ root, browser: runBrowser.browser });
    await store.propose(genericDefinition());
    await store.validate('new-site-extract');
    const runCode = 'HTMLFormElement.prototype.requestSubmit.call(document.forms[0]);';
    replaceVersionCode(root, 'new-site-extract', 1, runCode);
    jest.mocked(runBrowser.browser.start).mockClear();
    jest.mocked(runBrowser.browser.call).mockClear();
    await expect(store.run('new-site-extract', { query: 'alpha' })).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(runBrowser.browser.start).not.toHaveBeenCalled();
    expect(runBrowser.browser.call).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'new-site-extract.json'), 'utf8')).versions[0]
        .definition.steps[0].args.code,
    ).toBe(runCode);

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-readonly-program-'));
    const rollbackBrowser = createBrowser();
    store = new BrowserSkillStore({ root, browser: rollbackBrowser.browser });
    await store.propose(genericDefinition());
    await store.validate('new-site-extract');
    const next = genericDefinition();
    next.description = 'Replacement';
    await store.propose(next);
    await store.validate('new-site-extract');
    replaceVersionCode(root, 'new-site-extract', 1, runCode);
    jest.mocked(rollbackBrowser.browser.start).mockClear();
    jest.mocked(rollbackBrowser.browser.call).mockClear();
    await expect(store.rollback('new-site-extract', 1)).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(rollbackBrowser.browser.start).not.toHaveBeenCalled();
    expect(rollbackBrowser.browser.call).not.toHaveBeenCalled();
    expect((await store.find('https://new.example/search?q=alpha', 'extract'))[0].version).toBe(2);
  });

  it.each([
    ['read_dom dismissOverlays', 'chrome_read_dom', { dismissOverlays: true }],
    ['read_dom highlight', 'chrome_read_dom', { highlight: true }],
    ['grep autoScroll', 'chrome_grep', { query: 'a', autoScroll: true }],
    [
      'network GET body',
      'chrome_network_request',
      { url: 'https://new.example/', method: 'GET', body: 'private' },
    ],
    ['screenshot savePng', 'chrome_screenshot', { savePng: true }],
    ['screenshot saveToDisk', 'chrome_screenshot', { saveToDisk: true }],
    ['screenshot fullPage', 'chrome_screenshot', { fullPage: true }],
    ['screenshot som', 'chrome_screenshot', { som: true }],
    ['screenshot grid', 'chrome_screenshot', { grid: true }],
  ])('rejects side-effecting %s arguments', async (_name, tool, args) => {
    const definition = genericDefinition();
    definition.steps = [{ tool, args }];
    const { browser } = createBrowser();
    const store = new BrowserSkillStore({ root, browser });
    await expect(store.propose(definition)).rejects.toMatchObject({ status: 'unsupported' });
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it('allows an in-memory screenshot and rejects a tampered disk-write version on run', async () => {
    const taskId = 'task-shot';
    const urls = new Map<string, string>();
    const browser: SkillBrowser = {
      start: jest.fn(async () => ({ taskId })),
      open: jest.fn(async (openedTaskId, url) => {
        urls.set(String(openedTaskId), String(url));
        return { tabId: 1 };
      }),
      call: jest.fn(async (calledTaskId, tool) => {
        const pageUrl = urls.get(String(calledTaskId)) || '';
        const parsed = new URL(pageUrl);
        const query = parsed.searchParams.get('query') || parsed.searchParams.get('q') || 'alpha';
        const heading = `${query[0]?.toUpperCase() || ''}${query.slice(1)} result`;
        if (tool === 'chrome_read_dom') {
          return toolResult({ text: heading });
        }
        if (tool === 'chrome_screenshot') {
          return toolResult({
            success: true,
            fields: { heading, links: [`/${query}-detail`] },
            sources: { page: pageUrl },
          });
        }
        throw new Error(`Unexpected tool: ${tool}`);
      }),
      finish: jest.fn(async () => {}),
    };
    const store = new BrowserSkillStore({ root, browser });
    const definition = screenshotDefinition({ savePng: false, saveToDisk: false });
    await store.propose(definition);
    await store.validate(definition.id);
    const output = await store.run(definition.id, { query: 'alpha' });
    expect(output.output).toMatchObject({
      success: true,
      sources: { page: 'https://new.example/search?q=alpha' },
    });
    const screenshotCall = jest
      .mocked(browser.call)
      .mock.calls.find(([, tool]) => tool === 'chrome_screenshot');
    expect(screenshotCall?.[2]).toMatchObject({
      background: true,
      savePng: false,
      saveToDisk: false,
    });

    writeRecord(root, definition.id, (record) => {
      const entry = record.versions.find((item: JsonObject) => item.status === 'active');
      entry.definition.steps[0].args.savePng = true;
      entry.hash = hash(entry.definition);
    });
    jest.mocked(browser.start).mockClear();
    jest.mocked(browser.call).mockClear();
    await expect(store.run(definition.id, { query: 'alpha' })).rejects.toMatchObject({
      status: 'unsupported',
    });
    expect(browser.start).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });
});
