import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { BrowserSkillStore, type SkillBrowser, type SkillDefinition } from './browser-skills';
import { sanitizeAndLimitOutput } from '../../chrome-extension/utils/output-sanitizer';

type JsonObject = Record<string, any>;

const recipeRoot = path.resolve(__dirname, '../../../skills/browserpaw/assets/recipes');
const recipe = (id: string): SkillDefinition =>
  JSON.parse(fs.readFileSync(path.join(recipeRoot, `${id}.json`), 'utf8')) as SkillDefinition;

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
    closest: () => article.__section || null,
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
    const validate = new AjvJsonSchemaValidator().getValidator(definition.outputSchema);
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
});
