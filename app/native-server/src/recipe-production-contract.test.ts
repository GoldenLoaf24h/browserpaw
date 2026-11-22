import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { validator } from './schema-validation';
import { BrowserSkillStore, type SkillBrowser, type SkillDefinition } from './browser-skills';
import { PUBLISHED_READ_ONLY_PROGRAMS, programHash } from './skill-read-program';
import { sanitizeAndLimitOutput } from '../../chrome-extension/utils/output-sanitizer';

type JsonObject = Record<string, any>;

const recipeRoot = path.resolve(__dirname, '../../../skills/browserpaw/assets/recipes');
const recipe = (id: string): SkillDefinition =>
  JSON.parse(fs.readFileSync(path.join(recipeRoot, `${id}.json`), 'utf8')) as SkillDefinition;

const expandTemplateUrl = (template: string, inputs: JsonObject): string =>
  template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, key) => {
    const value = inputs[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`URL input ${key} must be a string or number`);
    }
    return encodeURIComponent(String(value));
  });

const assertValidExpandedRecipeUrl = (
  rawTemplate: string,
  inputs: JsonObject,
  domains: string[],
): void => {
  const expanded = expandTemplateUrl(rawTemplate, inputs);
  expect(expanded).not.toMatch(/\{\{|\}\}/);
  const parsed = new URL(expanded);
  expect(parsed.protocol).toBe('https:');
  expect(domains).toContain(parsed.hostname);
};

const toolResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  isError: false,
});

const decodeInput = (code: string): { input: JsonObject; body: string } => {
  const firstLine = code.slice(0, code.indexOf('\n'));
  const match = /^const input = (.*);$/.exec(firstLine);
  if (!match) throw new Error('BrowserSkillStore did not provide serialized input');
  return { input: JSON.parse(match[1]) as JsonObject, body: code.slice(firstLine.length + 1) };
};

interface FakePage {
  location: JsonObject;
  fetch: (url: string) => Promise<JsonObject>;
  document?: JsonObject;
  DOMParser?: new () => JsonObject;
  globalThis?: JsonObject;
  setTimeout?: (callback: () => void, delay?: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

const pageLocation = (href: string): JsonObject => {
  const url = new URL(href);
  return { origin: url.origin, href: url.href, pathname: url.pathname };
};

const response = (url: string, body: unknown, ok = true, status = 200): JsonObject => ({
  ok,
  status,
  url,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const runPageCode = async (code: string, page: FakePage): Promise<JsonObject> => {
  const { input, body } = decodeInput(code);
  const fn = new Function(
    'input',
    'location',
    'fetch',
    'document',
    'DOMParser',
    'URL',
    'setTimeout',
    'clearTimeout',
    'globalThis',
    `return (async () => {${body}})();`,
  ) as (...args: unknown[]) => Promise<unknown>;
  const value = await fn(
    input,
    page.location,
    page.fetch,
    page.document,
    page.DOMParser,
    URL,
    page.setTimeout || setTimeout,
    page.clearTimeout || clearTimeout,
    page.globalThis ?? globalThis,
  );
  const sanitized = sanitizeAndLimitOutput(value);
  return JSON.parse(sanitized.text) as JsonObject;
};

const atomDocument = (xml: string): JsonObject => {
  const entry = (body: string): JsonObject => {
    const tag = (name: string): string =>
      body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
    const link = body.match(/<link\b[^>]*\bhref="([^"]*)"/)?.[1] ?? '';
    return {
      querySelector: (selector: string) => {
        if (selector === 'title') return { textContent: tag('title') };
        if (selector === 'updated') return { textContent: tag('updated') };
        if (selector === 'link') return { getAttribute: () => link };
        return null;
      },
    };
  };
  return {
    querySelector: (selector: string) => (selector === 'parsererror' ? null : null),
    querySelectorAll: (selector: string) =>
      selector === 'entry'
        ? Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g), (match) => entry(match[1]))
        : [],
  };
};

const xArticle = (author: string, postId: string, text: string, parentId?: string): JsonObject => {
  const article: JsonObject = {
    __reactFiberFixture: {
      memoizedProps: { tweet: { id_str: postId, in_reply_to_status_id_str: parentId } },
    },
    getBoundingClientRect: () => ({ width: 600, height: 200 }),
    querySelector: (selector: string) => {
      if (selector === '[data-testid="tweetText"]') return { innerText: text };
      if (selector === '[data-testid="User-Name"]') return { innerText: `${author}\n@${author}` };
      return null;
    },
    querySelectorAll: (selector: string) =>
      selector === 'a:has(time)'
        ? [
            {
              getAttribute: () => `/${author}/status/${postId}`,
              querySelector: () => ({
                getAttribute: () => '2026-10-27T00:00:00.000Z',
              }),
            },
          ]
        : [],
    closest: (selector: string) => (selector === 'section' ? article.__section || null : null),
  };
  return article;
};

const xPage = (articles: JsonObject[], href: string): FakePage => {
  const section: JsonObject = {
    querySelectorAll: (selector: string) => (selector === 'article' ? articles : []),
  };
  for (const article of articles) article.__section = section;
  return {
    location: pageLocation(href),
    fetch: async () => response('', ''),
    document: {
      querySelectorAll: (selector: string) => {
        if (selector === 'article') return articles;
        if (selector === 'form') return [];
        return [];
      },
    },
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => {},
  };
};

const xEmptyStatePage = (text: string, href: string, hidden = false): FakePage => {
  const page = xPage([], href);
  page.document = {
    ...page.document,
    querySelector: (selector: string) =>
      selector === 'main [data-testid="emptyState"]'
        ? {
            hidden,
            getAttribute: () => null,
            getBoundingClientRect: () =>
              hidden ? { width: 0, height: 0 } : { width: 500, height: 120 },
            innerText: text,
          }
        : null,
  };
  return page;
};

const validateWithFixture = async (
  definition: SkillDefinition,
  pageFor: (url: string) => FakePage,
  observeFor: (input: JsonObject) => unknown,
): Promise<{ definitions: SkillDefinition[]; outputs: JsonObject[]; browser: SkillBrowser }> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-recipe-contract-'));
  let taskNumber = 0;
  const pages = new Map<string, FakePage>();
  const inputs = new Map<string, JsonObject>();
  const outputs: JsonObject[] = [];
  const browser: SkillBrowser = {
    start: jest.fn(async () => ({ taskId: `task-${++taskNumber}` })),
    open: jest.fn(async (taskId: string, url: string) => {
      pages.set(taskId, pageFor(url));
      return { tabId: taskNumber };
    }),
    call: jest.fn(async (taskId: string, tool: string, args: Record<string, unknown>) => {
      if (tool === 'chrome_javascript') {
        const current = pages.get(taskId);
        if (!current) throw new Error('Missing fake page');
        const { input } = decodeInput(String(args.code));
        inputs.set(taskId, input);
        const output = await runPageCode(String(args.code), current);
        outputs.push(output);
        return toolResult({ success: true, result: JSON.stringify(output) });
      }
      if (tool === 'chrome_read_dom') {
        return toolResult({ treeString: observeFor(inputs.get(taskId) || {}) });
      }
      if (tool === 'chrome_network_request') {
        const requestUrl = String(args.url || '');
        expect(requestUrl).not.toMatch(/\{\{|\}\}/);
        const parsedUrl = new URL(requestUrl);
        expect(parsedUrl.protocol).toBe('https:');
        expect(definition.domains).toContain(parsedUrl.hostname);
        return toolResult({ response: { body: observeFor(inputs.get(taskId) || {}) } });
      }
      throw new Error(`Unexpected recipe tool: ${tool}`);
    }),
    finish: jest.fn(async () => {}),
  };
  const store = new BrowserSkillStore({ root, browser });
  try {
    await store.loadBundledSkills(recipeRoot);
    await store.propose(definition);
    await store.validate(definition.id);
    return { definitions: [definition], outputs, browser };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe('bundled recipe production contracts', () => {
  it('enforces meta-contract across all bundled recipes (published hash, test inputs, and required-only default expansion)', () => {
    const files = fs
      .readdirSync(recipeRoot)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(17);

    for (const file of files) {
      const def = JSON.parse(
        fs.readFileSync(path.join(recipeRoot, file), 'utf8'),
      ) as SkillDefinition;
      expect(def.id).toBe(file.slice(0, -5));
      const code = String(def.steps[0]?.args?.code || '');
      expect(programHash(code)).toBe(PUBLISHED_READ_ONLY_PROGRAMS[def.id]);
      expect(def.tests.length).toBeGreaterThanOrEqual(2);

      const validateWithDefaults = validator.getDefaultingValidator(def.inputSchema);
      const verifications = Array.isArray(def.verification) ? def.verification : [def.verification];

      for (const testCase of def.tests) {
        const clonedInputs = structuredClone(testCase.inputs) as JsonObject;
        expect(validateWithDefaults(clonedInputs).valid).toBe(true);
        assertValidExpandedRecipeUrl(def.startUrl, clonedInputs, def.domains);
        for (const verify of verifications) {
          if (verify.tool === 'chrome_network_request') {
            assertValidExpandedRecipeUrl(String(verify.args.url), clonedInputs, def.domains);
          }
        }
      }

      const requiredKeys = Array.isArray(def.inputSchema.required)
        ? (def.inputSchema.required as string[])
        : [];
      const minimalInputs: JsonObject = {};
      for (const key of requiredKeys) {
        minimalInputs[key] = structuredClone(def.tests[0].inputs[key]);
      }
      expect(validateWithDefaults(minimalInputs).valid).toBe(true);
      assertValidExpandedRecipeUrl(def.startUrl, minimalInputs, def.domains);
      for (const verify of verifications) {
        if (verify.tool === 'chrome_network_request') {
          assertValidExpandedRecipeUrl(String(verify.args.url), minimalInputs, def.domains);
        }
      }
    }
  });

  it('keeps the MDN API source verifiable after runtime output sanitization', async () => {
    const definition = recipe('mdn-search');
    const fetch = async (url: string) => {
      const query = new URL(url).searchParams.get('q');
      const document =
        query === 'AbortController'
          ? {
              mdn_url: '/en-US/docs/Web/API/AbortController',
              title: 'AbortController',
              summary: 'The AbortController interface represents a controller object.',
            }
          : {
              mdn_url: '/en-US/docs/Web/API/Fetch_API',
              title: 'Fetch API',
              summary: 'The Fetch API provides an interface for fetching resources.',
            };
      return response(url, {
        documents: [document],
        metadata: { total: { value: 1 } },
      });
    };
    const pageFor = (url: string): FakePage => ({ location: pageLocation(url), fetch });
    const result = await validateWithFixture(definition, pageFor, (input) =>
      String(input.query || '').includes('Abort') ? 'AbortController' : 'Fetch API',
    );
    expect(result.outputs[0].sources).toEqual({
      api: 'https://developer.mozilla.org/api/v1/search?q=fetch&locale=en-US',
      page: 'https://developer.mozilla.org/en-US/search?q=fetch',
    });
    expect(result.outputs[0].documents[0].url).toBe(
      'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    );
  });

  it('follows GitHub canonical repository redirects and keeps the page source canonical', async () => {
    const definition = recipe('github-releases');
    const xml = (owner: string, repo: string, title: string) => `
      <feed>
        <entry>
          <title>${title}</title>
          <link href="https://github.com/${owner}/${repo}/releases/tag/v1.0.0" />
          <updated>2026-10-14T17:06:15Z</updated>
        </entry>
      </feed>`;
    const fetch = async (url: string) => {
      if (url.includes('/facebook/react/')) {
        return response(
          url.replace('/facebook/react/', '/react/react/'),
          xml('react', 'react', 'React release'),
        );
      }
      return response(url, xml('microsoft', new URL(url).pathname.split('/')[2], 'Release'));
    };
    const pageFor = (url: string): FakePage => {
      const canonical = url.replace('/facebook/react/', '/react/react/');
      return {
        location: pageLocation(canonical),
        fetch,
        DOMParser: class {
          parseFromString(value: string) {
            return atomDocument(value);
          }
        },
      };
    };
    const result = await validateWithFixture(
      definition,
      pageFor,
      (input) => `Releases: ${String(input.owner || 'react')}/${String(input.repo || 'react')}`,
    );
    expect(result.outputs[0]).toMatchObject({
      repository: 'react/react',
      sources: {
        atom: 'https://github.com/react/react/releases.atom',
        page: 'https://github.com/react/react/releases',
      },
    });
    const extra = await runPageCode(
      `const input = ${JSON.stringify({ owner: 'microsoft', repo: 'TypeScript' })};\n${definition.steps[0].args.code}`,
      pageFor('https://github.com/microsoft/TypeScript/releases'),
    );
    expect(extra.repository).toBe('microsoft/TypeScript');
    expect(extra.releases[0].url).toBe(
      'https://github.com/microsoft/TypeScript/releases/tag/v1.0.0',
    );
  });

  describe('npm-compare', () => {
    const npmMetadata = (
      name: string,
      version: string,
      description: string,
      repository: JsonObject = { url: `git+https://github.com/${name}.git` },
    ) => ({
      name,
      version,
      description,
      license: 'MIT',
      repository,
      engines: { node: '>=18' },
    });

    const metadataByName: Record<string, JsonObject> = {
      react: npmMetadata('react', '19.2.0', 'React is a JavaScript library for web UIs.'),
      vue: npmMetadata('vue', '3.5.22', 'Vue is a progressive JavaScript framework.'),
      express: npmMetadata('express', '5.1.0', 'Fast, unopinionated web framework.'),
      fastify: npmMetadata('fastify', '5.6.1', 'Fast and low overhead web framework.'),
    };

    const npmResponse = (url: string): JsonObject => {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const encodedName =
        parsed.hostname === 'registry.npmjs.org'
          ? segments[segments.length - 2] || ''
          : segments[segments.length - 1] || '';
      const name = decodeURIComponent(encodedName);
      if (parsed.hostname === 'registry.npmjs.org') {
        return JSON.parse(JSON.stringify(metadataByName[name])) as JsonObject;
      }
      return {
        package: name,
        downloads: name === 'react' ? 100 : name === 'vue' ? 50 : 25,
        start: '2026-06-25',
        end: '2026-07-01',
      };
    };

    it('maps latest metadata and declares independent left and right registry GETs', async () => {
      const definition = recipe('npm-compare');
      const fetch = async (url: string) => response(url, npmResponse(url));
      const run = (inputs: JsonObject) =>
        runPageCode(`const input = ${JSON.stringify(inputs)};\n${definition.steps[0].args.code}`, {
          location: pageLocation(`https://registry.npmjs.org/${inputs.left}`),
          fetch,
        });
      const reactVue = await run({ left: 'react', right: 'vue' });
      const expressFastify = await run({ left: 'express', right: 'fastify' });

      expect(reactVue).toMatchObject({
        left: {
          package: 'react',
          downloads: 100,
          latestVersion: '19.2.0',
          description: 'React is a JavaScript library for web UIs.',
          license: 'MIT',
          repository: 'https://github.com/react',
          engines: { node: '>=18' },
        },
        right: {
          package: 'vue',
          downloads: 50,
          latestVersion: '3.5.22',
          description: 'Vue is a progressive JavaScript framework.',
        },
        sources: {
          left: 'https://api.npmjs.org/downloads/point/last-week/react',
          right: 'https://api.npmjs.org/downloads/point/last-week/vue',
          metadata: {
            left: 'https://registry.npmjs.org/react/latest',
            right: 'https://registry.npmjs.org/vue/latest',
          },
        },
      });
      expect(expressFastify).toMatchObject({
        left: { package: 'express', latestVersion: '5.1.0' },
        right: { package: 'fastify', latestVersion: '5.6.1' },
      });

      const verifications = definition.verification as unknown as JsonObject[];
      expect(verifications).toMatchObject([
        {
          tool: 'chrome_network_request',
          args: {
            url: 'https://registry.npmjs.org/{{left}}/latest',
            method: 'GET',
          },
          resultPath: '/response/body',
        },
        {
          tool: 'chrome_network_request',
          args: {
            url: 'https://registry.npmjs.org/{{right}}/latest',
            method: 'GET',
          },
          resultPath: '/response/body',
        },
      ]);
      expect(
        definition.tests.map((test) =>
          (test.observe as unknown as JsonObject[]).map((schema) => schema.properties?.name?.const),
        ),
      ).toEqual([
        ['react', 'vue'],
        ['express', 'fastify'],
      ]);
      expect(
        definition.tests.every(
          (test) => (test.observe as unknown as JsonObject[]).length === verifications.length,
        ),
      ).toBe(true);
      expect(definition.tests[0].expect).toMatchObject({
        properties: {
          left: {
            required: ['package', 'downloads', 'latestVersion', 'description'],
          },
          right: {
            required: ['package', 'downloads', 'latestVersion', 'description'],
          },
        },
      });
      expect(
        ((definition.outputSchema as JsonObject).definitions as JsonObject).packageMetric.required,
      ).toEqual(
        expect.arrayContaining([
          'latestVersion',
          'description',
          'license',
          'repository',
          'engines',
        ]),
      );
    });

    it('starts the registry and downloads requests for both packages concurrently', async () => {
      const definition = recipe('npm-compare');
      const calls: string[] = [];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetch = async (url: string) => {
        calls.push(url);
        await blocked;
        return response(url, npmResponse(url));
      };
      const page: FakePage = { location: pageLocation('https://registry.npmjs.org/react'), fetch };
      const running = runPageCode(
        `const input = ${JSON.stringify({ left: 'react', right: 'vue' })};\n${definition.steps[0].args.code}`,
        page,
      );

      expect(calls.sort()).toEqual(
        [
          'https://registry.npmjs.org/react/latest',
          'https://registry.npmjs.org/vue/latest',
          'https://api.npmjs.org/downloads/point/last-week/react',
          'https://api.npmjs.org/downloads/point/last-week/vue',
        ].sort(),
      );
      release();
      await expect(running).resolves.toMatchObject({
        success: true,
        status: 'ok',
        left: { latestVersion: '19.2.0' },
        right: { latestVersion: '3.5.22' },
      });
    });

    it('encodes scoped package names for registry metadata and downloads', async () => {
      const definition = recipe('npm-compare');
      const runtime = npmMetadata('@vue/runtime-dom', '3.5.22', 'Vue DOM runtime.') as JsonObject;
      delete runtime.license;
      delete runtime.repository;
      delete runtime.engines;
      const scoped = {
        '@types/node': npmMetadata('@types/node', '24.10.0', 'TypeScript definitions for Node.js.'),
        '@vue/runtime-dom': runtime,
      };
      const calls: string[] = [];
      const fetch = async (url: string) => {
        calls.push(url);
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const encodedName =
          parsed.hostname === 'registry.npmjs.org'
            ? segments[segments.length - 2] || ''
            : segments[segments.length - 1] || '';
        const name = decodeURIComponent(encodedName);
        return response(
          url,
          parsed.hostname === 'registry.npmjs.org'
            ? scoped[name as keyof typeof scoped]
            : {
                package: name,
                downloads: 10,
                start: '2026-06-25',
                end: '2026-07-01',
              },
        );
      };
      const page: FakePage = {
        location: pageLocation('https://registry.npmjs.org/%40types%2Fnode'),
        fetch,
      };
      const output = await runPageCode(
        `const input = ${JSON.stringify({ left: '@types/node', right: '@vue/runtime-dom' })};\n${definition.steps[0].args.code}`,
        page,
      );

      expect(calls.sort()).toEqual(
        [
          'https://registry.npmjs.org/%40types%2Fnode/latest',
          'https://registry.npmjs.org/%40vue%2Fruntime-dom/latest',
          'https://api.npmjs.org/downloads/point/last-week/%40types%2Fnode',
          'https://api.npmjs.org/downloads/point/last-week/%40vue%2Fruntime-dom',
        ].sort(),
      );
      expect(output).toMatchObject({
        success: true,
        left: {
          package: '@types/node',
          latestVersion: '24.10.0',
        },
        right: {
          package: '@vue/runtime-dom',
          latestVersion: '3.5.22',
          license: null,
          repository: null,
          engines: {},
        },
        sources: {
          metadata: {
            left: 'https://registry.npmjs.org/%40types%2Fnode/latest',
            right: 'https://registry.npmjs.org/%40vue%2Fruntime-dom/latest',
          },
        },
      });
      const inputProperties = (definition.inputSchema as JsonObject).properties as JsonObject;
      expect(new RegExp(inputProperties.left.pattern as string).test('@types/node')).toBe(true);
    });

    it('fails explicitly without retries or guessed metadata for bad names and API failures', async () => {
      const definition = recipe('npm-compare');
      const run = (fetch: FakePage['fetch']) =>
        runPageCode(
          `const input = ${JSON.stringify({ left: 'react', right: 'vue' })};\n${definition.steps[0].args.code}`,
          { location: pageLocation('https://registry.npmjs.org/react'), fetch },
        );

      let calls = 0;
      const mismatched = await run(async (url) => {
        calls += 1;
        const body = npmResponse(url);
        if (url === 'https://registry.npmjs.org/react/latest') body.name = 'not-react';
        return response(url, body);
      });
      expect(calls).toBe(4);
      expect(mismatched).toMatchObject({
        success: false,
        status: 'api_error',
        left: 'react',
        right: 'vue',
      });
      expect(String(mismatched.message)).toMatch(/metadata.*name/i);
      expect(mismatched).not.toHaveProperty('left.latestVersion');

      calls = 0;
      const missingVersion = await run(async (url) => {
        calls += 1;
        const body = npmResponse(url);
        if (url === 'https://registry.npmjs.org/react/latest') {
          body.version = '';
        }
        return response(url, body);
      });
      expect(calls).toBe(4);
      expect(missingVersion).toMatchObject({
        success: false,
        status: 'api_error',
        left: 'react',
        right: 'vue',
      });
      expect(String(missingVersion.message)).toMatch(/version/i);

      calls = 0;
      const unavailable = await run(async (url) => {
        calls += 1;
        if (url.includes('/downloads/')) return response(url, {}, false, 503);
        return response(url, npmResponse(url));
      });
      expect(calls).toBe(4);
      expect(unavailable).toMatchObject({
        success: false,
        status: 'api_error',
        left: 'react',
        right: 'vue',
      });
      expect(String(unavailable.message)).toMatch(/downloads.*503/i);

      calls = 0;
      const offline = await run(async () => {
        calls += 1;
        throw new Error('ECONNRESET');
      });
      expect(calls).toBe(4);
      expect(offline).toMatchObject({
        success: false,
        status: 'api_error',
        left: 'react',
        right: 'vue',
      });
      expect(String(offline.message)).toMatch(/ECONNRESET/);
    });
  });

  it('waits for X search articles instead of treating SPA login text as authentication failure', async () => {
    const definition = recipe('x-search-thread');
    let polls = 0;
    const page: FakePage = {
      location: pageLocation('https://x.com/search?q=fetch&src=typed_query&f=live'),
      fetch: async () => response('', ''),
      document: {
        body: { innerText: 'Log in Sign up Search' },
        querySelector: () => null,
        querySelectorAll: () => {
          polls += 1;
          if (polls === 1) return [];
          return [
            {
              querySelector: (selector: string) => {
                if (selector === '[data-testid="tweetText"]') return { innerText: 'Loaded post' };
                if (selector === '[data-testid="User-Name"]')
                  return { innerText: 'Loaded Author\n@loaded' };
                return null;
              },
              querySelectorAll: (selector: string) =>
                selector === 'a:has(time)'
                  ? [
                      {
                        getAttribute: () => '/loaded/status/123',
                        querySelector: () => ({
                          getAttribute: () => '2026-10-27T00:00:00.000Z',
                        }),
                      },
                    ]
                  : [],
            },
          ];
        },
      },
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => {},
    };
    const output = await runPageCode(
      `const input = ${JSON.stringify({ query: 'fetch', limit: 8 })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output).toMatchObject({
      success: true,
      status: 'ok',
      query: 'fetch',
      sources: { page: 'https://x.com/search?q=fetch&src=typed_query&f=live' },
    });
    expect(output.posts[0].url).toBe('https://x.com/loaded/status/123');
    expect(definition.inputSchema).not.toHaveProperty('properties.thread');
  });

  for (const [language, emptyText] of [
    [
      'Chinese',
      '没有关于“from:MDNWebDocs”的结果尝试搜索其他内容，或者检查你的搜索设置，看看它们是否在保护你不受潜在敏感内容的影响。',
    ],
    ['English', 'No results for "from:MDNWebDocs" Try searching for something else.'],
  ] as const) {
    it(`returns an explicit X empty result instead of timing out (${language})`, async () => {
      const definition = recipe('x-search-thread');
      const href = 'https://x.com/search?q=from%3AMDNWebDocs&src=typed_query&f=live';
      const output = await runPageCode(
        `const input = ${JSON.stringify({ query: 'from:MDNWebDocs', limit: 8 })};\n${definition.steps[0].args.code}`,
        xEmptyStatePage(emptyText, href),
      );
      expect(output).toEqual({
        success: true,
        status: 'empty',
        query: 'from:MDNWebDocs',
        posts: [],
        sources: { page: href },
      });
    });
  }

  it('does not treat hidden, unknown, or mismatched X empty states as empty results', async () => {
    const definition = recipe('x-search-thread');
    const href = 'https://x.com/search?q=from%3AMDNWebDocs&src=typed_query&f=live';
    for (const { text, hidden } of [
      { text: '没有关于“from:MDNWebDocs”的结果', hidden: true },
      { text: 'Keine Ergebnisse für "from:MDNWebDocs"', hidden: false },
      { text: 'No results for "another query"', hidden: false },
    ]) {
      const output = await runPageCode(
        `const input = ${JSON.stringify({ query: 'from:MDNWebDocs', limit: 8 })};\n${definition.steps[0].args.code}`,
        xEmptyStatePage(text, href, hidden),
      );
      expect(output).toMatchObject({
        success: false,
        status: 'loading_timeout',
        requiresLogin: false,
        query: 'from:MDNWebDocs',
        source: href,
      });
      expect(output).not.toHaveProperty('sources');
    }
  });

  it('does not match a longer X query with the requested query as its prefix', async () => {
    const definition = recipe('x-search-thread');
    const href = 'https://x.com/search?q=foo&src=typed_query&f=live';
    const output = await runPageCode(
      `const input = ${JSON.stringify({ query: 'foo', limit: 8 })};\n${definition.steps[0].args.code}`,
      xEmptyStatePage('No results for "foobar"', href),
    );
    expect(output).toMatchObject({
      success: false,
      status: 'loading_timeout',
      requiresLogin: false,
      query: 'foo',
      source: href,
    });
    expect(output).not.toHaveProperty('sources');
  });

  it('does not infer an X empty result from a failed load', async () => {
    const definition = recipe('x-search-thread');
    const href = 'https://x.com/search?q=from%3AMDNWebDocs&src=typed_query&f=live';
    const page = xPage([], href);
    page.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const output = await runPageCode(
      `const input = ${JSON.stringify({ query: 'from:MDNWebDocs', limit: 8 })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output).toMatchObject({
      success: false,
      status: 'loading_timeout',
      requiresLogin: false,
      query: 'from:MDNWebDocs',
      source: href,
    });
    expect(output).not.toHaveProperty('sources');
  });

  it('keeps X ok and empty success schemas mutually exclusive', () => {
    const definition = recipe('x-search-thread');
    const validate = validator.getValidator(definition.outputSchema);
    const query = 'from:MDNWebDocs';
    const sources = { page: 'https://x.com/search?q=from%3AMDNWebDocs&src=typed_query&f=live' };
    const post = {
      text: 'A visible post',
      author: 'Example',
      url: 'https://x.com/example/status/123',
      publishedAt: '2026-10-27T00:00:00.000Z',
    };

    expect(validate({ success: true, status: 'ok', query, posts: [post], sources }).valid).toBe(
      true,
    );
    expect(validate({ success: true, status: 'empty', query, posts: [], sources }).valid).toBe(
      true,
    );
    expect(validate({ success: true, status: 'ok', query, posts: [], sources }).valid).toBe(false);
    expect(validate({ success: true, status: 'empty', query, posts: [post], sources }).valid).toBe(
      false,
    );
  });

  it('requires a real login page or visible login form for X requires_auth', async () => {
    const definition = recipe('x-search-thread');
    const page: FakePage = {
      location: pageLocation('https://x.com/search?q=fetch&src=typed_query&f=live'),
      fetch: async () => response('', ''),
      document: {
        body: { innerText: 'Log in Sign up Search' },
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => {},
    };
    const output = await runPageCode(
      `const input = ${JSON.stringify({ query: 'fetch', limit: 8 })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output).toMatchObject({
      success: false,
      status: 'loading_timeout',
      requiresLogin: false,
      query: 'fetch',
      source: 'https://x.com/search?q=fetch&src=typed_query&f=live',
    });
    expect(output).not.toHaveProperty('sources');
  });

  it('reports requires_auth only when X exposes a visible login form', async () => {
    const definition = recipe('x-search-thread');
    const visibleField = {
      getBoundingClientRect: () => ({ width: 200, height: 32 }),
    };
    const form = {
      ...visibleField,
      querySelectorAll: () => [visibleField, visibleField],
    };
    const page: FakePage = {
      location: pageLocation('https://x.com/search?q=fetch&src=typed_query&f=live'),
      fetch: async () => response('', ''),
      document: {
        querySelector: (selector: string) =>
          selector === 'main [data-testid="emptyState"]'
            ? {
                getAttribute: () => null,
                getBoundingClientRect: () => ({ width: 500, height: 120 }),
                innerText: '没有关于“fetch”的结果',
              }
            : null,
        querySelectorAll: (selector: string) => (selector === 'form' ? [form] : []),
      },
    };
    const output = await runPageCode(
      `const input = ${JSON.stringify({ query: 'fetch', limit: 8 })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output).toMatchObject({
      success: false,
      status: 'requires_auth',
      requiresLogin: true,
      query: 'fetch',
      source: 'https://x.com/search?q=fetch&src=typed_query&f=live',
    });
  });

  it('reads only the focal and later same-author visible articles from the same X section', async () => {
    const definition = recipe('x-visible-thread');
    const ytaoArticles = [
      xArticle('Ytautomation6', '2115063891591921877', '6/8'),
      xArticle('Ytautomation6', '2115063895245156744', '7/8', '2115063891591921877'),
      xArticle(
        'Ytautomation6',
        '2115063899267478012',
        '8/8 - Try Octo Browser',
        '2115063895245156744',
      ),
      xArticle('other_author', '2115063899999999999', 'other author'),
    ];
    const cryptoArticle = xArticle(
      'crypto_vazima',
      '2115072668210803107',
      'QA Automation Engineer',
    );
    const pageFor = (url: string): FakePage => {
      const pathname = new URL(url).pathname;
      const articles = pathname.includes('Ytautomation6') ? ytaoArticles : [cryptoArticle];
      return xPage(articles, url);
    };
    const result = await validateWithFixture(definition, pageFor, (input) =>
      input.author === 'Ytautomation6' ? '6/8 - Team Management' : 'QA Automation Engineer',
    );
    expect(result.outputs[0]).toMatchObject({
      coverage: 'visible_only',
      focal: { postId: '2115063891591921877' },
    });
    expect(result.outputs[0].posts.map((post: JsonObject) => post.postId)).toEqual([
      '2115063891591921877',
      '2115063895245156744',
      '2115063899267478012',
    ]);
    expect(result.outputs[1].focal.postId).toBe('2115072668210803107');
    expect(result.outputs[0].posts[1].parentId).toBe('2115063891591921877');
  });

  it('excludes X ancestors, other authors and duplicate focal articles when focal is last', async () => {
    const definition = recipe('x-visible-thread');
    const articles = [
      xArticle('Ytautomation6', '2115063891591921877', '6/8'),
      xArticle('Ytautomation6', '2115063895245156744', '7/8'),
      xArticle('Ytautomation6', '2115063899267478012', '8/8 - Try Octo Browser'),
      xArticle('other_author', '2115063899999999999', 'other author'),
      xArticle('Ytautomation6', '2115063899267478012', '8/8 - Try Octo Browser'),
      xArticle('Ytautomation6', '2115063900000000000', 'unrelated recommendation', '999'),
    ];
    const page = xPage(articles, 'https://x.com/Ytautomation6/status/2115063899267478012');
    const output = await runPageCode(
      `const input = ${JSON.stringify({
        author: 'Ytautomation6',
        postId: '2115063899267478012',
        limit: 8,
      })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output.posts.map((post: JsonObject) => post.postId)).toEqual(['2115063899267478012']);
    expect(output.coverage).toBe('visible_only');
  });

  it('does not accept an arbitrary X article when the exact focal post is absent', async () => {
    const definition = recipe('x-visible-thread');
    const page = xPage(
      [xArticle('Ytautomation6', '2115063891591921877', '6/8')],
      'https://x.com/Ytautomation6/status/2115063899267478012',
    );
    const output = await runPageCode(
      `const input = ${JSON.stringify({
        author: 'Ytautomation6',
        postId: '2115063899267478012',
        limit: 8,
      })};\n${definition.steps[0].args.code}`,
      page,
    );
    expect(output).toMatchObject({
      success: false,
      status: 'loading_timeout',
      requiresLogin: false,
      author: 'Ytautomation6',
      postId: '2115063899267478012',
    });
  });

  it('validates GitHub search, README, and issue recipes including microsoft/TypeScript sanitization and /repositories/ redirects', async () => {
    const searchDef = recipe('github-repo-search');
    const searchResult = await validateWithFixture(
      searchDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          const q = new URL(target).searchParams.get('q') || '';
          const items =
            q === 'typescript'
              ? [
                  {
                    full_name: 'microsoft/TypeScript',
                    owner: { login: 'microsoft' },
                    name: 'TypeScript',
                    html_url: 'https://github.com/microsoft/TypeScript',
                    description: 'TypeScript is a superset of JavaScript.',
                    language: 'TypeScript',
                    stargazers_count: 100000,
                    forks_count: 13000,
                    updated_at: '2026-11-20T00:00:00Z',
                    topics: ['typescript'],
                  },
                ]
              : [
                  {
                    full_name: 'react/react',
                    owner: { login: 'react' },
                    name: 'react',
                    html_url: 'https://github.com/react/react',
                    description: 'The library for web and native user interfaces.',
                    language: 'JavaScript',
                    stargazers_count: 230000,
                    forks_count: 47000,
                    updated_at: '2026-11-20T00:00:00Z',
                    topics: ['react'],
                  },
                ];
          return response(target, { total_count: 10, items });
        },
      }),
      (input) =>
        String(input.query) === 'typescript'
          ? 'link "microsoft/TypeScript" href="/microsoft/TypeScript"'
          : 'link "react/react" href="/react/react"',
    );
    expect(searchResult.outputs[1].repositories[0]).toMatchObject({
      owner: 'microsoft',
      repo: 'TypeScript',
      url: 'https://github.com/microsoft/TypeScript',
    });

    const readmeDef = recipe('github-repo-readme');
    const readmeResult = await validateWithFixture(
      readmeDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          if (target.endsWith('/readme')) {
            return response(target, '# Repository README\n\nDetailed documentation text.');
          }
          const parts = new URL(target).pathname.split('/').filter(Boolean);
          const full = `${parts[1]}/${parts[2]}`;
          return response(target, {
            full_name: full,
            owner: { login: parts[1] },
            name: parts[2],
            html_url: `https://github.com/${full}`,
            description: 'Repo description',
            default_branch: 'main',
            language: 'TypeScript',
            stargazers_count: 50000,
            forks_count: 8000,
            open_issues_count: 100,
            license: { spdx_id: 'MIT', name: 'MIT License' },
            topics: ['web'],
            updated_at: '2026-11-20T00:00:00Z',
          });
        },
      }),
      (input) =>
        `link "${String(input.repo)}" href="/${String(input.owner)}/${String(input.repo)}"`,
    );
    expect(readmeResult.outputs[0].repository).toMatchObject({ owner: 'react', repo: 'react' });

    const redirectedReadme = await runPageCode(
      `const input = ${JSON.stringify({ owner: 'facebook', repo: 'react' })};\n${readmeDef.steps[0].args.code}`,
      {
        location: pageLocation('https://github.com/facebook/react'),
        fetch: async (target) =>
          target.endsWith('/readme')
            ? response(
                'https://api.github.com/repositories/10270250/readme',
                '# React\n\nRedirected README body.',
              )
            : response('https://api.github.com/repositories/10270250', {
                full_name: 'microsoft/TypeScript',
                owner: { login: 'microsoft' },
                name: 'TypeScript',
                html_url: 'https://github.com/microsoft/TypeScript',
                description: 'Redirected repo test',
                default_branch: 'main',
                language: 'TypeScript',
                stargazers_count: 100,
                forks_count: 10,
                open_issues_count: 1,
                license: { spdx_id: 'Apache-2.0' },
                topics: [],
                updated_at: '2026-11-20T00:00:00Z',
              }),
      },
    );
    expect(validator.getValidator(readmeDef.outputSchema)(redirectedReadme).valid).toBe(true);
    expect(redirectedReadme.repository).toMatchObject({ owner: 'microsoft', repo: 'TypeScript' });

    const issueDef = recipe('github-issue-thread');
    const issueResult = await validateWithFixture(
      issueDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          if (target.includes('/comments')) {
            return response('https://api.github.com/repositories/10270250/issues/1/comments', [
              {
                user: { login: 'alice' },
                created_at: '2026-11-20T00:00:00Z',
                html_url: 'https://github.com/react/react/issues/1#issuecomment-1',
                body: 'First comment',
              },
            ]);
          }
          return response('https://api.github.com/repositories/10270250/issues/1', {
            number: 1,
            title: 'Initial issue',
            state: 'closed',
            user: { login: 'bob' },
            html_url: 'https://github.com/react/react/issues/1',
            created_at: '2026-11-19T00:00:00Z',
            updated_at: '2026-11-20T00:00:00Z',
            labels: [{ name: 'bug' }],
            body: 'Issue body',
            comments: 1,
          });
        },
      }),
      (input) =>
        `h1 "Initial issue - #${String(input.number)}"\nlink "repo" href="/${String(input.owner)}/${String(input.repo)}/issues/${String(input.number)}"`,
    );
    expect(issueResult.outputs[0].issue.number).toBe(1);
    expect(issueResult.outputs[0].sources.api).toBe(
      'https://api.github.com/repositories/10270250/issues/1',
    );
  });

  it('validates V2EX node and topic recipes', async () => {
    const nodeDef = recipe('v2ex-node-topics');
    const nodeResult = await validateWithFixture(
      nodeDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) =>
          response(target, [
            {
              id: 1001,
              title: 'Python 3.14 notes',
              url: 'https://www.v2ex.com/t/1001',
              node: { name: 'python', title: 'Python' },
              member: { username: 'dev1' },
              replies: 12,
              created: 1700000000,
              content: 'Topic summary text',
            },
          ]),
      }),
      () => [{ id: 1001, title: 'Python 3.14 notes' }],
    );
    expect(nodeResult.outputs[0].topics[0].id).toBe(1001);

    const topicDef = recipe('v2ex-topic-read');
    const topicResult = await validateWithFixture(
      topicDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          const parsed = new URL(target);
          if (parsed.pathname.includes('/replies/')) {
            return response(target, [
              { id: 501, member: { username: 'replier' }, created: 1700000010, content: 'Nice!' },
            ]);
          }
          const id = Number(parsed.searchParams.get('id') || 1);
          return response(target, [
            {
              id,
              title: `Topic ${id}`,
              url: `https://www.v2ex.com/t/${id}`,
              node: { name: 'babel', title: 'Project Babel' },
              member: { username: 'livid' },
              replies: 1,
              created: 1700000000,
              content: 'Welcome to V2EX',
            },
          ]);
        },
      }),
      (input) => [{ id: Number(input.topicId), title: `Topic ${input.topicId}` }],
    );
    expect(topicResult.outputs[0].topic.id).toBe(1);
    expect(topicResult.outputs[1].topic.id).toBe(2);
  });

  it('validates Bilibili popular and video detail recipes including risk control and bvid-checked fallback', async () => {
    const popularDef = recipe('bilibili-popular-videos');
    const popularResult = await validateWithFixture(
      popularDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) =>
          response(target, {
            code: 0,
            data: {
              list: [
                {
                  bvid: 'BV1xx411c7mD',
                  title: 'Popular Video',
                  owner: { name: 'Uploader' },
                  tname: 'Tech',
                  duration: 120,
                  pubdate: 1700000000,
                  stat: { view: 5000, like: 300, danmaku: 40 },
                },
              ],
            },
          }),
      }),
      () => ({ code: 0, data: { list: [{ bvid: 'BV1xx411c7mD' }] } }),
    );
    expect(popularResult.outputs[0].videos[0].bvid).toBe('BV1xx411c7mD');

    const rateLimited = await runPageCode(
      `const input = ${JSON.stringify({ limit: 3, page: 1 })};\n${popularDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.bilibili.com/v/popular/all'),
        fetch: async (target) => response(target, { code: -352, message: 'risk control' }),
      },
    );
    expect(rateLimited).toMatchObject({ success: false, status: 'rate_limited', code: -352 });

    const detailDef = recipe('bilibili-video-detail');
    const detailResult = await validateWithFixture(
      detailDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          const bvid = new URL(target).searchParams.get('bvid') || 'BV1xx411c7mD';
          return response(target, {
            code: 0,
            data: {
              bvid,
              aid: 2,
              title: `Video ${bvid}`,
              owner: { name: 'Author', mid: 10 },
              tname: 'Music',
              desc: 'Description',
              duration: 180,
              pubdate: 1700000000,
              stat: {
                view: 1000,
                like: 50,
                coin: 10,
                favorite: 20,
                share: 5,
                danmaku: 12,
                reply: 8,
              },
              pages: [{ page: 1, cid: 99, part: 'P1', duration: 180 }],
              subtitle: {
                list: [
                  { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/a.json' },
                ],
              },
            },
          });
        },
      }),
      (input) => ({ code: 0, data: { bvid: input.bvid } }),
    );
    expect(detailResult.outputs[0].video.bvid).toBe('BV1xx411c7mD');
    expect(detailResult.outputs[0].video.subtitles[0].url).toBe(
      'https://aisubtitle.hdslb.com/a.json',
    );

    // Stale __INITIAL_STATE__ from another bvid must NOT be returned on fetch error
    const staleFallback = await runPageCode(
      `const input = ${JSON.stringify({ bvid: 'BV1xx411c7mD' })};\n${detailDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.bilibili.com/video/BV1xx411c7mD'),
        fetch: async () => {
          throw new Error('network down');
        },
        globalThis: { __INITIAL_STATE__: { videoData: { bvid: 'BV1OTHER00000', title: 'Wrong' } } },
      },
    );
    expect(staleFallback).toMatchObject({ success: false, status: 'fetch_error' });
  });

  it('validates YouTube video reader and search recipes including stale SPA player recovery and DOM fallback', async () => {
    const videoDef = recipe('youtube-video-read');
    const videoResult = await validateWithFixture(
      videoDef,
      (url) => {
        const videoId = new URL(url).searchParams.get('v') || 'dQw4w9WgXcQ';
        return {
          location: pageLocation(url),
          fetch: async (target) =>
            response(target, {
              events: [{ segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }],
            }),
          globalThis: {
            ytInitialPlayerResponse: {
              playabilityStatus: { status: 'OK' },
              videoDetails: {
                videoId,
                title: `Video ${videoId}`,
                author: 'Channel',
                channelId: 'UC123',
                lengthSeconds: '212',
                viewCount: '1000',
                shortDescription: 'Desc',
              },
              microformat: { playerMicroformatRenderer: { publishDate: '2026-01-01' } },
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      languageCode: 'en',
                      name: { simpleText: 'English' },
                      baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=en',
                    },
                  ],
                },
              },
            },
          },
          setTimeout: (cb) => {
            cb();
            return 1;
          },
          clearTimeout: () => {},
        };
      },
      (input) => ({ title: `Video ${input.videoId}`, author_name: 'Channel' }),
    );
    expect(videoResult.outputs[0].video.videoId).toBe('dQw4w9WgXcQ');

    // Stale globalThis.ytInitialPlayerResponse must fall through to #movie_player.getPlayerResponse() and fetch subtitles
    const recoveredVideo = await runPageCode(
      `const input = ${JSON.stringify({ videoId: 'jNQXAC9IVRw', includeSubtitles: true, lang: 'en' })};\n${videoDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.youtube.com/watch?v=jNQXAC9IVRw'),
        fetch: async (target) =>
          response(target, {
            events: [{ segs: [{ utf8: 'Me at the zoo' }] }],
          }),
        globalThis: {
          ytInitialPlayerResponse: {
            playabilityStatus: { status: 'OK' },
            videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Stale Previous Video' },
          },
        },
        document: {
          getElementById: (id: string) =>
            id === 'movie_player'
              ? {
                  getPlayerResponse: () => ({
                    playabilityStatus: { status: 'OK' },
                    videoDetails: {
                      videoId: 'jNQXAC9IVRw',
                      title: 'Me at the zoo',
                      author: 'jawed',
                      channelId: 'UC4QobU6STFB0P71PMvOGN5A',
                      lengthSeconds: '19',
                      viewCount: '300000000',
                      shortDescription: 'First YouTube video',
                    },
                    captions: {
                      playerCaptionsTracklistRenderer: {
                        captionTracks: [
                          {
                            languageCode: 'en',
                            name: { simpleText: 'English' },
                            baseUrl: 'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en',
                          },
                        ],
                      },
                    },
                  }),
                }
              : null,
        },
        setTimeout: (cb) => {
          cb();
          return 1;
        },
        clearTimeout: () => {},
      },
    );
    expect(validator.getValidator(videoDef.outputSchema)(recoveredVideo).valid).toBe(true);
    expect(recoveredVideo.video.title).toBe('Me at the zoo');
    expect(recoveredVideo.subtitle).toMatchObject({ languageCode: 'en', text: 'Me at the zoo' });

    const ytSearchDef = recipe('youtube-search-videos');
    const ytSearchResult = await validateWithFixture(
      ytSearchDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async () => response('', ''),
        globalThis: {
          ytInitialData: {
            contents: {
              twoColumnSearchResultsRenderer: {
                primaryContents: {
                  sectionListRenderer: {
                    contents: [
                      {
                        itemSectionRenderer: {
                          contents: [
                            {
                              videoRenderer: {
                                videoId: 'dQw4w9WgXcQ',
                                title: { runs: [{ text: 'TypeScript JavaScript async guide' }] },
                                ownerText: { runs: [{ text: 'Dev Channel' }] },
                                shortViewCountText: { simpleText: '12K views' },
                                publishedTimeText: { simpleText: '2 days ago' },
                                lengthText: { simpleText: '10:00' },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        setTimeout: (cb) => {
          cb();
          return 1;
        },
        clearTimeout: () => {},
      }),
      () => 'TypeScript JavaScript async YouTube',
    );
    expect(ytSearchResult.outputs[0].videos[0].videoId).toBe('dQw4w9WgXcQ');

    // Modern YouTube lockupViewModel with channel and views/date split across separate metadataRows
    const lockupSearch = await runPageCode(
      `const input = ${JSON.stringify({ query: 'typescript tutorial', limit: 3 })};\n${ytSearchDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.youtube.com/results?search_query=typescript+tutorial'),
        fetch: async () => response('', ''),
        globalThis: {
          ytInitialData: {
            contents: {
              twoColumnSearchResultsRenderer: {
                primaryContents: {
                  sectionListRenderer: {
                    contents: [
                      {
                        itemSectionRenderer: {
                          contents: [
                            {
                              lockupViewModel: {
                                contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                                contentId: 'd56mG7DezGs',
                                metadata: {
                                  lockupMetadataViewModel: {
                                    title: { content: 'TypeScript Tutorial for Beginners' },
                                    metadata: {
                                      contentMetadataViewModel: {
                                        metadataRows: [
                                          {
                                            metadataParts: [
                                              {
                                                avatarStack: {
                                                  avatarStackViewModel: {
                                                    text: { content: 'Programming with Mosh' },
                                                  },
                                                },
                                              },
                                            ],
                                          },
                                          {
                                            metadataParts: [
                                              { text: { content: '2.2M views' } },
                                              { text: { content: '4 years ago' } },
                                            ],
                                          },
                                          {
                                            isSpacerRow: true,
                                            lockupContentMetadataRowExtension: {
                                              contentType: 'METADATA_ROW_CONTENT_TYPE_SPACER',
                                            },
                                          },
                                          {
                                            lockupContentMetadataRowExtension: {
                                              contentType: 'METADATA_ROW_CONTENT_TYPE_DESCRIPTION',
                                            },
                                            metadataParts: [
                                              { text: { content: 'Should not override views' } },
                                            ],
                                          },
                                        ],
                                      },
                                    },
                                  },
                                },
                                contentImage: {
                                  thumbnailViewModel: {
                                    overlays: [
                                      {
                                        thumbnailBottomOverlayViewModel: {
                                          badges: [
                                            { thumbnailBadgeViewModel: { text: '1:04:28' } },
                                          ],
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        setTimeout: (cb) => {
          cb();
          return 1;
        },
        clearTimeout: () => {},
      },
    );
    expect(validator.getValidator(ytSearchDef.outputSchema)(lockupSearch).valid).toBe(true);
    expect(lockupSearch.videos[0]).toEqual({
      videoId: 'd56mG7DezGs',
      title: 'TypeScript Tutorial for Beginners',
      url: 'https://www.youtube.com/watch?v=d56mG7DezGs',
      channel: 'Programming with Mosh',
      viewsText: '2.2M views',
      publishedText: '4 years ago',
      durationText: '1:04:28',
    });
  });

  it('validates Reddit subreddit/post recipes and X profile posts recipe', async () => {
    const subDef = recipe('reddit-subreddit-posts');
    const subResult = await validateWithFixture(
      subDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) =>
          response(target, {
            data: {
              children: [
                {
                  data: {
                    id: 'abc123',
                    subreddit: 'programming',
                    title: 'Programming systems discussion',
                    author: 'coder',
                    score: 420,
                    num_comments: 35,
                    permalink: '/r/programming/comments/abc123/programming_systems/',
                    url: 'https://example.com/article',
                    is_self: false,
                    selftext: '',
                  },
                },
              ],
            },
          }),
      }),
      () => 'r/programming Reddit',
    );
    expect(subResult.outputs[0].posts[0].id).toBe('abc123');

    const postDef = recipe('reddit-post-read');
    const postResult = await validateWithFixture(
      postDef,
      (url) => ({
        location: pageLocation(url),
        fetch: async (target) => {
          const postId = target.includes('f9ut5f') ? 'f9ut5f' : '226xun';
          return response(target, [
            {
              data: {
                children: [
                  {
                    data: {
                      id: postId,
                      subreddit: 'programming',
                      title: `Post ${postId}`,
                      author: 'op',
                      score: 99,
                      num_comments: 1,
                      permalink: `/r/programming/comments/${postId}/post/`,
                      selftext: 'Post body',
                    },
                  },
                ],
              },
            },
            {
              data: {
                children: [
                  {
                    kind: 't1',
                    data: { id: 'c1', author: 'commenter', score: 12, body: 'Great post' },
                  },
                ],
              },
            },
          ]);
        },
      }),
      () => 'r/programming comments Reddit',
    );
    expect(postResult.outputs[0].post.id).toBe('f9ut5f');
    expect(postResult.outputs[0].comments[0].id).toBe('c1');

    const profileDef = recipe('x-profile-posts');
    const profileResult = await validateWithFixture(
      profileDef,
      (url) => {
        const username = new URL(url).pathname.replace(/^\/+/, '').split('/')[0] || 'github';
        const page = xPage(
          [xArticle(username, '1234567890123456789', `Hello from ${username}`)],
          url,
        );
        page.document = {
          ...page.document,
          querySelector: (selector: string) => {
            if (selector === '[data-testid="UserName"]')
              return { innerText: `${username}\n@${username}` };
            if (selector === '[data-testid="UserDescription"]')
              return { innerText: `Bio for ${username}` };
            return null;
          },
        };
        return page;
      },
      (input) => `${String(input.username)} @${String(input.username)}`,
    );
    expect(profileResult.outputs[0].profile.username).toBe('github');
    expect(profileResult.outputs[0].posts[0].url).toBe(
      'https://x.com/github/status/1234567890123456789',
    );

    // Unready/opaque origins must return page_not_ready without throwing or issuing credentialed fetches
    const redditFetchOnNullOrigin = jest.fn(async () => response('', ''));
    const redditNotReady = await runPageCode(
      `const input = ${JSON.stringify({ subreddit: 'programming', postId: 'f9ut5f', limit: 5 })};\n${postDef.steps[0].args.code}`,
      {
        location: { origin: 'null', href: 'about:blank', pathname: '' },
        fetch: redditFetchOnNullOrigin,
      },
    );
    expect(redditNotReady).toMatchObject({
      success: false,
      status: 'page_not_ready',
      subreddit: 'programming',
      postId: 'f9ut5f',
    });
    expect(redditFetchOnNullOrigin).not.toHaveBeenCalled();

    const xNotReady = await runPageCode(
      `const input = ${JSON.stringify({ username: 'github', limit: 5 })};\n${profileDef.steps[0].args.code}`,
      {
        location: { origin: 'null', href: 'about:blank', pathname: '' },
        fetch: async () => response('', ''),
      },
    );
    expect(xNotReady).toMatchObject({
      success: false,
      status: 'page_not_ready',
      requiresLogin: false,
      username: 'github',
    });

    // old.reddit.com DOM fallback when .json API is unavailable
    const oldPostLinkEl = {
      getAttribute: (name: string) =>
        ({
          'data-fullname': 't3_f9ut5f',
          'data-subreddit': 'programming',
          'data-permalink':
            '/r/programming/comments/f9ut5f/the_most_recommended_programming_books/',
          'data-author': 'owenxl',
          'data-score': '2664',
          'data-comments-count': '339',
        })[name] ?? null,
      querySelector: (selector: string) => {
        if (selector === 'a.title') {
          return { innerText: 'The most recommended programming books' };
        }
        if (selector.includes('usertext-body')) {
          return { innerText: 'Curated programming books list.' };
        }
        return null;
      },
    };
    const oldDeletedCommentEl = {
      getAttribute: () => null,
      querySelector: (selector: string) =>
        selector.includes('usertext-body') ? { innerText: '[deleted]' } : null,
    };
    const oldCommentEl = {
      getAttribute: (name: string) =>
        ({
          'data-fullname': 't1_fiufpgf',
          'data-author': 'JessieArr',
        })[name] ?? null,
      querySelector: (selector: string) => {
        if (selector.includes('.score.unvoted')) {
          return {
            getAttribute: (attr: string) => (attr === 'title' ? '688' : null),
            textContent: '688 points',
          };
        }
        if (selector.includes('usertext-body')) {
          return { innerText: 'Working Effectively with Legacy Code' };
        }
        return null;
      },
    };
    const oldNestedChildCommentEl = {
      getAttribute: (name: string) =>
        ({
          'data-fullname': 't1_child99',
          'data-author': 'NestedReplyAuthor',
        })[name] ?? null,
      querySelector: (selector: string) => {
        if (selector.includes('.score.unvoted')) {
          return {
            getAttribute: (attr: string) => (attr === 'title' ? '12' : null),
            textContent: '12 points',
          };
        }
        if (selector.includes('usertext-body')) {
          return { innerText: 'Nested reply that should not be flattened into top-level comments' };
        }
        return null;
      },
    };
    const oldRedditFallback = await runPageCode(
      `const input = ${JSON.stringify({ subreddit: 'programming', postId: 'f9ut5f', limit: 5 })};\n${postDef.steps[0].args.code}`,
      {
        location: pageLocation(
          'https://old.reddit.com/r/programming/comments/f9ut5f/the_most_recommended_programming_books/',
        ),
        fetch: async (target) => response(target, { error: 'rate_limited' }, false, 429),
        document: {
          querySelector: (selector: string) =>
            selector.includes('.thing.link') ? oldPostLinkEl : null,
          querySelectorAll: (selector: string) => {
            if (selector === '.commentarea > .sitetable > .thing.comment') {
              return [oldDeletedCommentEl, oldCommentEl];
            }
            if (selector === '.commentarea .thing.comment') {
              return [oldDeletedCommentEl, oldCommentEl, oldNestedChildCommentEl];
            }
            return [];
          },
        },
      },
    );
    expect(validator.getValidator(postDef.outputSchema)(oldRedditFallback).valid).toBe(true);
    expect(oldRedditFallback).toMatchObject({
      success: true,
      status: 'ok',
      post: {
        id: 'f9ut5f',
        subreddit: 'programming',
        title: 'The most recommended programming books',
        author: 'owenxl',
        score: 2664,
        commentsCount: 339,
        body: 'Curated programming books list.',
      },
      comments: [
        {
          id: 'fiufpgf',
          author: 'JessieArr',
          score: 688,
          body: 'Working Effectively with Legacy Code',
        },
      ],
      sources: {
        api: null,
        page: 'https://old.reddit.com/r/programming/comments/f9ut5f/the_most_recommended_programming_books/',
      },
    });

    const oldRedditFlatDomFallback = await runPageCode(
      `const input = ${JSON.stringify({ subreddit: 'programming', postId: 'f9ut5f', limit: 5 })};\n${postDef.steps[0].args.code}`,
      {
        location: pageLocation(
          'https://old.reddit.com/r/programming/comments/f9ut5f/the_most_recommended_programming_books/',
        ),
        fetch: async (target) => response(target, { error: 'rate_limited' }, false, 429),
        document: {
          querySelector: (selector: string) =>
            selector.includes('.thing.link') ? oldPostLinkEl : null,
          querySelectorAll: (selector: string) =>
            selector === '.commentarea .thing.comment' ? [oldDeletedCommentEl, oldCommentEl] : [],
        },
      },
    );
    expect(oldRedditFlatDomFallback.comments).toEqual([
      {
        id: 'fiufpgf',
        author: 'JessieArr',
        score: 688,
        body: 'Working Effectively with Legacy Code',
      },
    ]);
  });

  it('classifies GitHub HTTP 403 rate limits separately from non-rate-limit forbidden responses', async () => {
    const readmeDef = recipe('github-repo-readme');
    const issueDef = recipe('github-issue-thread');
    const searchDef = recipe('github-repo-search');

    const withHeaders = (
      url: string,
      body: unknown,
      status: number,
      headers: Record<string, string>,
    ) => ({
      ...response(url, body, false, status),
      headers: new Headers(headers),
    });

    const readmeRateLimited = await runPageCode(
      `const input = ${JSON.stringify({ owner: 'react', repo: 'react' })};\n${readmeDef.steps[0].args.code}`,
      {
        location: pageLocation('https://github.com/react/react'),
        fetch: async (target) =>
          withHeaders(target, { message: 'API rate limit exceeded for 1.2.3.4.' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1795319179',
          }),
      },
    );
    expect(readmeRateLimited).toMatchObject({
      success: false,
      status: 'rate_limited',
      httpStatus: 403,
      rateLimitReset: '1795319179',
    });

    const readmeForbidden = await runPageCode(
      `const input = ${JSON.stringify({ owner: 'org', repo: 'private-repo' })};\n${readmeDef.steps[0].args.code}`,
      {
        location: pageLocation('https://github.com/org/private-repo'),
        fetch: async (target) =>
          withHeaders(target, { message: 'Repository access blocked' }, 403, {
            'x-ratelimit-remaining': '42',
          }),
      },
    );
    expect(readmeForbidden).toMatchObject({
      success: false,
      status: 'forbidden',
      httpStatus: 403,
      message: 'Repository access blocked',
    });

    const issueForbidden = await runPageCode(
      `const input = ${JSON.stringify({ owner: 'org', repo: 'private-repo', number: 1 })};\n${issueDef.steps[0].args.code}`,
      {
        location: pageLocation('https://github.com/org/private-repo/issues/1'),
        fetch: async (target) =>
          withHeaders(target, { message: 'Resource not accessible by integration' }, 403, {
            'x-ratelimit-remaining': '50',
          }),
      },
    );
    expect(issueForbidden).toMatchObject({
      success: false,
      status: 'forbidden',
      httpStatus: 403,
    });

    const searchForbidden = await runPageCode(
      `const input = ${JSON.stringify({ query: 'react' })};\n${searchDef.steps[0].args.code}`,
      {
        location: pageLocation('https://github.com/search?q=react&type=repositories'),
        fetch: async (target) =>
          withHeaders(target, { message: 'Forbidden' }, 403, { 'x-ratelimit-remaining': '9' }),
      },
    );
    expect(searchForbidden).toMatchObject({
      success: false,
      status: 'forbidden',
      httpStatus: 403,
    });
  });

  it('enforces X origin guards, promoted/repost filtering before limit, quote isolation, and media-reply chain continuity', async () => {
    const searchDef = recipe('x-search-thread');
    const searchNotReady = await runPageCode(
      `const input = ${JSON.stringify({ query: 'browserpaw', limit: 2 })};\n${searchDef.steps[0].args.code}`,
      {
        location: pageLocation('https://example.com/search?q=browserpaw'),
        fetch: async () => response('', ''),
      },
    );
    expect(searchNotReady).toMatchObject({ success: false, status: 'page_not_ready' });

    const makeRichArticle = (opts: {
      author: string;
      postId: string;
      text?: string;
      quoteText?: string;
      promoted?: boolean;
      repostedBy?: string;
      pinned?: boolean;
      displayName?: string;
    }): JsonObject => {
      const quoteWrap: JsonObject = {
        closest: (selector: string) => (selector.includes('quoteTweet') ? quoteWrap : null),
      };
      const primaryTextEl = opts.text ? { innerText: opts.text, closest: () => null } : null;
      const quoteTextEl = opts.quoteText
        ? {
            innerText: opts.quoteText,
            closest: (selector: string) => (selector.includes('quoteTweet') ? quoteWrap : null),
          }
        : null;
      const tweetTexts = [primaryTextEl, quoteTextEl].filter(Boolean);
      const userEl = {
        innerText: `${opts.displayName ?? opts.author}\n@${opts.author}`,
        closest: () => null,
      };
      const socialText = opts.promoted
        ? 'Promoted'
        : opts.repostedBy
          ? `${opts.repostedBy} reposted`
          : opts.pinned
            ? 'Pinned'
            : '';
      const socialEl = socialText ? { innerText: socialText, closest: () => null } : null;
      const article: JsonObject = {
        getBoundingClientRect: () => ({ width: 600, height: 200 }),
        contains: (node: unknown) => node === quoteWrap,
        closest: (selector: string) => {
          if (selector === 'section') return article.__section || null;
          if (opts.promoted && selector.includes('placementTracking')) return {};
          return null;
        },
        querySelector: (selector: string) => {
          if (selector === '[data-testid="tweetText"]') return primaryTextEl || quoteTextEl;
          if (selector === '[data-testid="User-Name"]') return userEl;
          if (selector.includes('socialContext') || selector.includes('SocialContext')) {
            return socialEl;
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector === '[data-testid="tweetText"]') return tweetTexts;
          if (selector === '[data-testid="User-Name"]') return [userEl];
          if (selector === 'a:has(time)') {
            return [
              {
                getAttribute: () => `/${opts.author}/status/${opts.postId}`,
                closest: () => null,
                querySelector: () => ({ getAttribute: () => '2026-11-22T00:00:00.000Z' }),
              },
            ];
          }
          if (selector === 'span') {
            return [
              {
                innerText: opts.displayName ?? opts.author,
                closest: (sel: string) => (sel.includes('User-Name') ? userEl : null),
              },
            ];
          }
          return [];
        },
      };
      return article;
    };

    const searchResult = await runPageCode(
      `const input = ${JSON.stringify({ query: 'browserpaw', limit: 2 })};\n${searchDef.steps[0].args.code}`,
      xPage(
        [
          makeRichArticle({ author: 'sponsor', postId: '1', text: 'Buy now', promoted: true }),
          makeRichArticle({ author: 'quoter', postId: '2', quoteText: 'Quoted only body' }),
          makeRichArticle({
            author: 'ad_author',
            displayName: 'Ad',
            postId: '3',
            text: 'Real post 1',
          }),
          makeRichArticle({ author: 'alice', postId: '4', text: 'Real post 2' }),
        ],
        'https://mobile.x.com/search?q=browserpaw&src=typed_query&f=live',
      ),
    );
    expect(searchResult).toMatchObject({
      success: true,
      status: 'ok',
      coverage: 'visible_only',
    });
    expect((searchResult.posts as JsonObject[]).map((post) => post.url)).toEqual([
      'https://x.com/ad_author/status/3',
      'https://x.com/alice/status/4',
    ]);
    expect((searchResult.posts as JsonObject[])[0].author).toBe('@ad_author');

    const profileDef = recipe('x-profile-posts');
    const profilePage = xPage(
      [
        makeRichArticle({ author: 'sponsor', postId: '10', text: 'Ad text', promoted: true }),
        makeRichArticle({
          author: 'other',
          postId: '11',
          text: 'Reposted item',
          repostedBy: 'github',
        }),
        makeRichArticle({ author: 'github', postId: '12', text: 'Pinned release', pinned: true }),
        makeRichArticle({ author: 'github', postId: '13', text: 'Second post' }),
      ],
      'https://x.com/github',
    );
    const profileResult = await runPageCode(
      `const input = ${JSON.stringify({ username: 'github', limit: 2 })};\n${profileDef.steps[0].args.code}`,
      profilePage,
    );
    expect(profileResult).toMatchObject({ success: true, status: 'ok', coverage: 'visible_only' });
    expect((profileResult.posts as JsonObject[]).map((post) => post.url)).toEqual([
      'https://x.com/github/status/12',
      'https://x.com/github/status/13',
    ]);

    const threadDef = recipe('x-visible-thread');
    const threadNotReady = await runPageCode(
      `const input = ${JSON.stringify({ author: 'alice', postId: '100', limit: 5 })};\n${threadDef.steps[0].args.code}`,
      {
        location: pageLocation('https://example.com/alice/status/100'),
        fetch: async () => response('', ''),
      },
    );
    expect(threadNotReady).toMatchObject({ success: false, status: 'page_not_ready' });

    const threadResult = await runPageCode(
      `const input = ${JSON.stringify({ author: 'alice', postId: '100', limit: 5 })};\n${threadDef.steps[0].args.code}`,
      xPage(
        [
          xArticle('alice', '100', 'Focal tweet'),
          xArticle('alice', '101', '', '100'),
          xArticle('alice', '102', 'Follow-up after media-only reply', '101'),
        ],
        'https://x.com/alice/status/100',
      ),
    );
    expect(threadResult).toMatchObject({ success: true, status: 'ok', coverage: 'visible_only' });
    expect((threadResult.posts as JsonObject[]).map((post) => post.postId)).toEqual(['100', '102']);
  });

  it('hardens Reddit, V2EX, Bilibili, and YouTube edge cases (defaults, 403/412, fallbacks, consent/bot walls)', async () => {
    const subDef = recipe('reddit-subreddit-posts');
    const sub403 = await runPageCode(
      `const input = ${JSON.stringify({ subreddit: 'nsfw_sub' })};\n${subDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.reddit.com/r/nsfw_sub/hot/'),
        fetch: async (target) => response(target, { reason: 'quarantined' }, false, 403),
      },
    );
    expect(sub403).toMatchObject({
      success: false,
      status: 'over18_or_quarantined',
      httpStatus: 403,
    });

    const subFiltered = await runPageCode(
      `const input = ${JSON.stringify({ subreddit: 'typescript', limit: 1 })};\n${subDef.steps[0].args.code}`,
      {
        location: pageLocation('https://sh.reddit.com/r/typescript/hot/'),
        fetch: async (target) =>
          response(target, {
            data: {
              children: [
                {
                  data: {
                    id: 'ad1',
                    title: 'Promoted',
                    promoted: true,
                    permalink: '/r/typescript/comments/ad1/x/',
                  },
                },
                {
                  data: {
                    id: 'p1',
                    title: 'TS 6.0',
                    author: 'dev',
                    score: 50,
                    num_comments: 3,
                    permalink: '/r/typescript/comments/p1/ts/',
                  },
                },
              ],
            },
          }),
      },
    );
    expect(subFiltered).toMatchObject({ success: true, status: 'ok', sort: 'hot' });
    expect((subFiltered.posts as JsonObject[]).map((post) => post.id)).toEqual(['p1']);

    const v2exDef = recipe('v2ex-node-topics');
    const v2exHot = await runPageCode(
      `const input = ${JSON.stringify({})};\n${v2exDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.v2ex.com/api/topics/hot.json'),
        fetch: async (target) => {
          expect(target).toBe('https://www.v2ex.com/api/topics/hot.json');
          return response(target, [
            {
              id: 2026,
              title: 'Hot V2EX topic',
              url: 'https://www.v2ex.com/t/2026',
              node: { name: 'share', title: 'Share' },
              member: { username: 'alice' },
              replies: 4,
              created: 1700000000,
              content: 'Summary',
            },
          ]);
        },
      },
    );
    expect(v2exHot).toMatchObject({ success: true, status: 'ok', node: 'hot' });

    const biliDef = recipe('bilibili-popular-videos');
    const bili412 = await runPageCode(
      `const input = ${JSON.stringify({ limit: 3, page: 1 })};\n${biliDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.bilibili.com/v/popular/all'),
        fetch: async (target) =>
          response(target, { code: -412, message: 'precondition failed' }, false, 412),
      },
    );
    expect(bili412).toMatchObject({ success: false, status: 'rate_limited', httpStatus: 412 });

    const biliDomFallback = await runPageCode(
      `const input = ${JSON.stringify({ limit: 2, page: 1 })};\n${biliDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.bilibili.com/v/popular/all'),
        fetch: async (target) => response(target, { code: -412 }, false, 412),
        document: {
          querySelectorAll: (selector: string) =>
            selector.includes('.video-card')
              ? [
                  {
                    querySelector: (sub: string) => {
                      if (sub.includes('/video/BV')) {
                        return { getAttribute: () => '/video/BV1Ab411c7mD' };
                      }
                      if (sub.includes('.video-name')) return { innerText: 'Fallback Video' };
                      if (sub.includes('.up-name')) return { innerText: 'Creator' };
                      return null;
                    },
                  },
                ]
              : [],
        },
      },
    );
    expect(biliDomFallback).toMatchObject({
      success: true,
      status: 'ok',
      sources: { api: null, page: 'https://www.bilibili.com/v/popular/all' },
    });

    const ytSearchDef = recipe('youtube-search-videos');
    const ytConsent = await runPageCode(
      `const input = ${JSON.stringify({ query: 'browserpaw' })};\n${ytSearchDef.steps[0].args.code}`,
      {
        location: pageLocation('https://consent.youtube.com/m?continue=https://www.youtube.com/'),
        fetch: async () => response('', ''),
      },
    );
    expect(ytConsent).toMatchObject({ success: false, status: 'consent_required' });

    const ytBot = await runPageCode(
      `const input = ${JSON.stringify({ query: 'browserpaw' })};\n${ytSearchDef.steps[0].args.code}`,
      {
        location: pageLocation('https://www.youtube.com/sorry/index'),
        fetch: async () => response('', ''),
      },
    );
    expect(ytBot).toMatchObject({ success: false, status: 'bot_check', requiresLogin: true });
  });
});
