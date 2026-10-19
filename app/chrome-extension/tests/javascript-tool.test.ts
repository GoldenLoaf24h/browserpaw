import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { javascriptTool, wrapUserCode } from '../entrypoints/background/tools/browser/javascript';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

describe('wrapUserCode', () => {
  it('auto-returns a simple expression', () => {
    const wrapped = wrapUserCode('document.title');
    expect(wrapped).toContain('return (\ndocument.title\n);');
    expect(wrapped).toMatch(/^\(async \(\) => {\n/);
    expect(wrapped).toMatch(/\n}\)\(\)$/);
  });

  it('auto-returns an expression with a trailing semicolon', () => {
    const wrapped = wrapUserCode('window.location.href;');
    expect(wrapped).toContain('return (\nwindow.location.href\n);');
  });

  it('auto-returns an object literal expression', () => {
    const wrapped = wrapUserCode('{ a: 1, b: "test" }');
    expect(wrapped).toContain('return (\n{ a: 1, b: "test" }\n);');
  });

  it('auto-returns an await expression', () => {
    const wrapped = wrapUserCode('await Promise.resolve(42)');
    expect(wrapped).toContain('return (\nawait Promise.resolve(42)\n);');
  });

  it('does not auto-return multi-line statements with declarations', () => {
    const code = 'const x = 10;\nconst y = 20;\nreturn x + y;';
    const wrapped = wrapUserCode(code);
    expect(wrapped).not.toContain('return (\n');
    expect(wrapped).toContain(code);
  });

  it('preserves code that already starts with return', () => {
    const code = 'return document.title;';
    const wrapped = wrapUserCode(code);
    expect(wrapped).not.toContain('return (\nreturn');
    expect(wrapped).toContain(code);
  });

  it('handles statements without return without crashing', () => {
    const code = 'let x = 1;\nx++;';
    const wrapped = wrapUserCode(code);
    expect(wrapped).not.toContain('return (\n');
    expect(wrapped).toContain(code);
  });

  it('handles empty code safely', () => {
    const wrapped = wrapUserCode('   ');
    expect(wrapped).toBe('(async () => {\n   \n})()');
  });

  it('auto-returns an expression with trailing semicolon and comment', () => {
    const wrapped = wrapUserCode('42; // answer');
    expect(wrapped).toContain('return (\n42\n);');
  });

  it('auto-returns an expression with block comments and semicolons', () => {
    const wrapped = wrapUserCode('document.title; /* gets current title */');
    expect(wrapped).toContain('return (\ndocument.title\n);');
  });
});

describe('JavaScriptTool restricted-URL guard (D-14)', () => {
  it('rejects chrome:// tabs before any CDP evaluation', async () => {
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 7,
      url: 'chrome://settings/',
    } as chrome.tabs.Tab);
    const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

    const res = await javascriptTool.execute({ code: 'document.title', tabId: 7 });

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(
      'Cannot operate on this browser internal page',
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe('scoped :has-text polyfill (D-15)', () => {
  const evaluate = (code: string) => (0, eval)(wrapUserCode(code)) as Promise<unknown>;

  it('keeps :has-text working during evaluation and restores prototypes afterwards', async () => {
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';
    const origDocQS = Document.prototype.querySelector;
    const origDocQSA = Document.prototype.querySelectorAll;
    const origElQS = Element.prototype.querySelector;
    const origElQSA = Element.prototype.querySelectorAll;

    const result = await evaluate(`
      const btn = document.querySelector('button:has-text("Confirm Order")');
      const all = document.querySelectorAll('button:has-text("Confirm")');
      return { id: btn ? btn.id : null, count: all.length };
    `);

    expect(result).toEqual({ id: 'confirm', count: 1 });
    expect(Document.prototype.querySelector).toBe(origDocQS);
    expect(Document.prototype.querySelectorAll).toBe(origDocQSA);
    expect(Element.prototype.querySelector).toBe(origElQS);
    expect(Element.prototype.querySelectorAll).toBe(origElQSA);
    expect(
      (Document.prototype as { __mcpHasTextPatched?: boolean }).__mcpHasTextPatched,
    ).toBeUndefined();
  });

  it('restores prototypes when user code throws and reinstalls on the next evaluation', async () => {
    const origDocQS = Document.prototype.querySelector;

    await expect(evaluate('throw new Error("boom");')).rejects.toThrow('boom');
    expect(Document.prototype.querySelector).toBe(origDocQS);

    document.body.innerHTML = '<button>Confirm Order</button>';
    const result = await evaluate(`
      return document.querySelector('button:has-text("Confirm Order")') ? 'ok' : 'missing';
    `);
    expect(result).toBe('ok');
    expect(Document.prototype.querySelector).toBe(origDocQS);
  });
});

describe('evaluation-local helper teardown (PR6 comment 4301519598)', () => {
  const evaluate = (code: string) => (0, eval)(wrapUserCode(code)) as Promise<unknown>;

  const resetPageGlobals = () => {
    delete (globalThis as { __mcp?: unknown }).__mcp;
    delete (globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill;
  };

  afterEach(() => {
    resetPageGlobals();
    document.body.innerHTML = '';
  });

  it('does not touch a page-owned globalThis.__mcp value or its descriptor', async () => {
    const pageOwned = { fromPage: true };
    Object.defineProperty(globalThis, '__mcp', {
      value: pageOwned,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const result = await evaluate(`
      return {
        duringEval: globalThis.__mcp === undefined ? 'overwritten' : 'untouched',
        helperWorks: typeof mcp.get === 'function',
      };
    `);

    expect(result).toEqual({ duringEval: 'untouched', helperWorks: true });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__mcp');
    expect(descriptor?.value).toBe(pageOwned);
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(true);
  });

  it('keeps page-owned __mcp and restores prototypes when evaluation throws', async () => {
    const pageOwned = { fromPage: true };
    (globalThis as Record<string, unknown>).__mcp = pageOwned;
    const origDocQS = Document.prototype.querySelector;

    await expect(evaluate('throw new Error("boom");')).rejects.toThrow('boom');

    expect((globalThis as { __mcp?: unknown }).__mcp).toBe(pageOwned);
    expect(Document.prototype.querySelector).toBe(origDocQS);
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  });

  it('lets overlapping evaluations clean up only their own polyfill install', async () => {
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';
    const origDocQS = Document.prototype.querySelector;
    const origDocQSA = Document.prototype.querySelectorAll;
    const origElQS = Element.prototype.querySelector;
    const origElQSA = Element.prototype.querySelectorAll;

    const first = evaluate(`
      const found = document.querySelector('button:has-text("Confirm Order")')?.id;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { found, stillPatchedAfterSecondEnded: !!globalThis.__mcpHasTextPolyfill };
    `);
    const second = evaluate(`
      await new Promise((resolve) => setTimeout(resolve, 10));
      return document.querySelector('button:has-text("Confirm Order")')?.id ?? null;
    `);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ found: 'confirm', stillPatchedAfterSecondEnded: true });
    expect(secondResult).toBe('confirm');
    expect(Document.prototype.querySelector).toBe(origDocQS);
    expect(Document.prototype.querySelectorAll).toBe(origDocQSA);
    expect(Element.prototype.querySelector).toBe(origElQS);
    expect(Element.prototype.querySelectorAll).toBe(origElQSA);
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  });

  it('restores the page prototypes after the last overlapping evaluation ends', async () => {
    const origDocQS = Document.prototype.querySelector;
    const first = evaluate('await new Promise((resolve) => setTimeout(resolve, 30)); return 1;');
    const second = evaluate('await new Promise((resolve) => setTimeout(resolve, 10)); return 2;');

    await Promise.all([first, second]);
    expect(Document.prototype.querySelector).toBe(origDocQS);
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  });

  it('leaves a page-owned __mcpHasTextPolyfill value and descriptor untouched', async () => {
    const pageOwned = { fromPage: true };
    Object.defineProperty(globalThis, '__mcpHasTextPolyfill', {
      value: pageOwned,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const origDocQS = Document.prototype.querySelector;
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';

    const result = await evaluate(`
      return {
        duringEval: globalThis.__mcpHasTextPolyfill === undefined ? 'missing' : 'untouched',
        helperQuery: mcp.query('button:has-text("Confirm Order")')?.id ?? null,
      };
    `);

    expect(result).toEqual({ duringEval: 'untouched', helperQuery: 'confirm' });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__mcpHasTextPolyfill');
    expect(descriptor?.value).toBe(pageOwned);
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(true);
    expect(Document.prototype.querySelector).toBe(origDocQS);
  });

  it('does not adopt a duck-typed page-owned __mcpHasTextPolyfill (numeric count + callable docQS)', async () => {
    // Same shape as BrowserPaw's marker but without the ownership token: a page
    // value with count 0 and missing docQSA/elQS/elQSA must not be mutated,
    // restored from, or deleted.
    const pageOwned = { count: 0, docQS: () => null };
    Object.defineProperty(globalThis, '__mcpHasTextPolyfill', {
      value: pageOwned,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const origDocQS = Document.prototype.querySelector;
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';

    const result = await evaluate(`
      return {
        duringEval: globalThis.__mcpHasTextPolyfill === undefined ? 'missing' : 'untouched',
        helperQuery: mcp.query('button:has-text("Confirm Order")')?.id ?? null,
      };
    `);

    expect(result).toEqual({ duringEval: 'untouched', helperQuery: 'confirm' });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__mcpHasTextPolyfill');
    expect(descriptor?.value).toBe(pageOwned);
    expect(pageOwned.count).toBe(0);
    expect(Document.prototype.querySelector).toBe(origDocQS);
  });

  it('leaves a non-writable page-owned __mcpHasTextPolyfill intact and unpatched', async () => {
    const pageOwned = { fromPage: true };
    Object.defineProperty(globalThis, '__mcpHasTextPolyfill', {
      value: pageOwned,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    const origDocQS = Document.prototype.querySelector;
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';

    const result = await evaluate(`
      return mcp.query('button:has-text("Confirm Order")')?.id ?? null;
    `);

    expect(result).toBe('confirm');
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBe(pageOwned);
    expect(Document.prototype.querySelector).toBe(origDocQS);
  });
});

describe('D-15 scripting fallback teardown', () => {
  const tab = { id: 42, url: 'https://example.com/' } as chrome.tabs.Tab;
  const prototypeOriginals = () => ({
    docQS: Document.prototype.querySelector,
    docQSA: Document.prototype.querySelectorAll,
    elQS: Element.prototype.querySelector,
    elQSA: Element.prototype.querySelectorAll,
  });
  const expectPrototypesRestored = () => {
    const orig = prototypeOriginals();
    expect(Document.prototype.querySelector).toBe(orig.docQS);
    expect(Document.prototype.querySelectorAll).toBe(orig.docQSA);
    expect(Element.prototype.querySelector).toBe(orig.elQS);
    expect(Element.prototype.querySelectorAll).toBe(orig.elQSA);
    expect((globalThis as { __mcp?: unknown }).__mcp).toBeUndefined();
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  };

  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue(tab);
    // Force executeViaCdp into a debugger conflict so execute() takes the scripting fallback.
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );
    // Run the real injected function in this realm, as chrome.scripting.executeScript would.
    executeScript = vi.fn(
      async (opts: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [
        { result: await opts.func(...(opts.args ?? [])) },
      ],
    );
    (chrome as unknown as { scripting: unknown }).scripting = { executeScript };
    document.body.innerHTML = '<button id="confirm">Confirm Order</button>';
  });

  afterEach(() => {
    delete (chrome as unknown as { scripting?: unknown }).scripting;
    delete (globalThis as { __mcp?: unknown }).__mcp;
    delete (globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill;
    document.body.innerHTML = '';
  });

  it('restores prototypes and global markers after a successful scripting fallback run', async () => {
    const orig = prototypeOriginals();
    const res = await javascriptTool.execute({
      tabId: 42,
      code: `
        const btn = document.querySelector('button:has-text("Confirm Order")');
        return {
          found: btn ? btn.id : null,
          polyfillActiveDuringEval: !!globalThis.__mcpHasTextPolyfill,
          pageGlobalsUntouched: !('__mcp' in globalThis),
        };
      `,
    });

    // No numeric literal in the code, so no bridge is stamped: one evaluation only.
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.engine).toBe('scripting');
    expect(JSON.parse(payload.result)).toEqual({
      found: 'confirm',
      polyfillActiveDuringEval: true,
      pageGlobalsUntouched: true,
    });

    expect(Document.prototype.querySelector).toBe(orig.docQS);
    expect(Document.prototype.querySelectorAll).toBe(orig.docQSA);
    expect(Element.prototype.querySelector).toBe(orig.elQS);
    expect(Element.prototype.querySelectorAll).toBe(orig.elQSA);
    expect((globalThis as { __mcp?: unknown }).__mcp).toBeUndefined();
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  });

  it('restores prototypes and global markers when the injected user code throws', async () => {
    const orig = prototypeOriginals();
    const res = await javascriptTool.execute({ tabId: 42, code: 'throw new Error("boom");' });

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('boom');

    expect(Document.prototype.querySelector).toBe(orig.docQS);
    expect(Document.prototype.querySelectorAll).toBe(orig.docQSA);
    expect(Element.prototype.querySelector).toBe(orig.elQS);
    expect(Element.prototype.querySelectorAll).toBe(orig.elQSA);
    expect((globalThis as { __mcp?: unknown }).__mcp).toBeUndefined();
    expect((globalThis as { __mcpHasTextPolyfill?: unknown }).__mcpHasTextPolyfill).toBeUndefined();
  });

  it('reinstalls the polyfill on the next scripting fallback run', async () => {
    await javascriptTool.execute({ tabId: 42, code: 'throw new Error("boom");' });
    expectPrototypesRestored();

    const res = await javascriptTool.execute({
      tabId: 42,
      code: `return document.querySelector('button:has-text("Confirm Order")') ? 'ok' : 'missing';`,
    });
    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    // String results are emitted verbatim by the output formatter.
    expect(payload.result).toBe('ok');
    expectPrototypesRestored();
  });
});

describe('snapshot index bridge across the execution world (PR6 comment 4310322679)', () => {
  const tab = { id: 42, url: 'https://example.com/' } as chrome.tabs.Tab;
  const snapshotSymbol = Symbol.for('__browser_use_last_snapshot_type__');
  const indexMapSymbol = Symbol.for('__browser_use_isolated_index_map__');
  const ISOLATED_KEYS = [
    '__pawFast',
    '__clawFast',
    '__MCP_INDEX_MAP__',
    snapshotSymbol,
    indexMapSymbol,
  ] as const;
  let executeScript: ReturnType<typeof vi.fn>;
  let world: 'MAIN' | 'ISOLATED';

  // Run `fn` with the isolated-world globals hidden, as the MAIN world sees them.
  const inPageWorld = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const saved = ISOLATED_KEYS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key as any),
    ]);
    for (const key of ISOLATED_KEYS) delete (globalThis as any)[key];
    try {
      return await fn();
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key as any, descriptor);
      }
    }
  };

  beforeEach(() => {
    document.body.innerHTML = '<button id="fast-target">Fast</button>';
    (globalThis as Record<string, unknown>).__pawFast = {
      actionElements: new Map<string | number, Element>([
        [1, document.getElementById('fast-target')],
      ]),
    };
    (globalThis as Record<string | symbol, unknown>)[snapshotSymbol] = 'fast';
    (globalThis as Record<string | symbol, unknown>)[indexMapSymbol] = new Map([
      [1, document.getElementById('fast-target')],
    ]);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue(tab);

    // executeScript lands in whichever world `world` names: the bridge stamp runs
    // isolated, the scripting-fallback evaluation runs in MAIN.
    world = 'MAIN';
    executeScript = vi.fn(async (opts: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      const run = async () => [{ result: await opts.func(...(opts.args ?? [])) }];
      return world === 'ISOLATED' ? run() : inPageWorld(run);
    });
    (chrome as unknown as { scripting: unknown }).scripting = { executeScript };
  });

  afterEach(() => {
    delete (chrome as unknown as { scripting?: unknown }).scripting;
    const g = globalThis as Record<string | symbol, unknown>;
    for (const key of ISOLATED_KEYS) delete g[key];
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-browserpaw-ref-attr');
  });

  it('resolves a numeric ref through the DOM stamp while the page world cannot see the map', async () => {
    // The bridge stamps through the isolated world; the evaluation runs in MAIN.
    executeScript.mockImplementation(
      async (opts: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
        world = 'ISOLATED';
        try {
          return [{ result: await opts.func(...(opts.args ?? [])) }];
        } finally {
          world = 'MAIN';
        }
      },
    );
    // executeViaCdp hands the wrapped expression to CDP, evaluated here in MAIN.
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tab: number, method: string, params?: any) => {
        if (method !== 'Runtime.evaluate') return {};
        const value = await inPageWorld(() => (0, eval)(params.expression));
        return { result: { value } };
      },
    );

    const res = await javascriptTool.execute({ tabId: 42, code: 'return mcp.get(1)?.id;' });

    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.engine).toBe('cdp');
    // String results are emitted verbatim by the output formatter.
    expect(payload.result).toBe('fast-target');
  });

  it('removes every stamp and the pointer after the evaluation, even when it throws', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );

    await javascriptTool.execute({ tabId: 42, code: 'throw new Error("boom");' });

    expect(document.documentElement.hasAttribute('data-browserpaw-ref-attr')).toBe(false);
    expect(document.querySelector('[data-browserpaw-ref-attr]')).toBeNull();
    expect(document.querySelectorAll('[data-browserpaw-ref-\\w]')).toHaveLength(0);
    expect(document.getElementById('fast-target')!.attributes).toHaveLength(1);
  });

  it('does not bridge when the code mentions no positive numeric literal', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );

    await javascriptTool.execute({ tabId: 42, code: 'return "no refs";' });

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute('data-browserpaw-ref-attr')).toBe(false);
  });

  it('keeps the evaluation result when the tab closes before cleanup', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );
    executeScript
      .mockImplementationOnce(
        async (opts: { func: (...a: any[]) => unknown; args?: unknown[] }) => [
          { result: await opts.func(...(opts.args ?? [])) },
        ],
      )
      .mockImplementationOnce(
        async (opts: { func: (...a: any[]) => unknown; args?: unknown[] }) => [
          { result: await opts.func(...(opts.args ?? [])) },
        ],
      )
      .mockRejectedValueOnce(new Error('No tab with id: 42'));

    const res = await javascriptTool.execute({ tabId: 42, code: 'return mcp.get(1)?.id;' });

    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.engine).toBe('scripting');
  });

  it('keeps a concurrent bridge alive when an earlier evaluation cleans up', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );
    // Two evaluations interleave: the first finishes and cleans up while the second
    // is still in flight, and the second's ref must keep resolving afterwards.
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let stampCount = 0;
    let evalCount = 0;
    const observed: Array<string | null> = [];
    // executeViaScripting's injected function is (userCode, inpageHelpers); the
    // bridge stamp is (attr, pointer, ids) and cleanup is (attr, pointer).
    const isEvaluation = (opts: { args?: unknown[] }) =>
      opts.args?.length === 2 && !String(opts.args[0]).startsWith('data-browserpaw-ref-');
    executeScript.mockImplementation(
      async (opts: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
        if (opts.args?.length === 3) {
          stampCount++;
          return [{ result: await opts.func(...opts.args) }];
        }
        if (!isEvaluation(opts)) {
          return [{ result: await opts.func(...(opts.args ?? [])) }];
        }
        const call = ++evalCount;
        await (call === 1 ? firstGate : secondGate);
        observed.push(
          await inPageWorld(() => (0, eval)(wrapUserCode('return mcp.get(1)?.id ?? null;'))),
        );
        // The injected function must return its own { ok, value } envelope.
        return [{ result: await opts.func(...(opts.args ?? [])) }];
      },
    );

    const first = javascriptTool.execute({ tabId: 42, code: 'return mcp.get(1)?.id;' });
    await vi.waitFor(() => expect(stampCount).toBe(1));
    const second = javascriptTool.execute({ tabId: 42, code: 'return mcp.get(1)?.id;' });
    await vi.waitFor(() => expect(stampCount).toBe(2));

    releaseFirst();
    const firstRes = await first;
    // The first cleanup dropped only its own entry; the second bridge still stands.
    expect(document.documentElement.hasAttribute('data-browserpaw-ref-attr')).toBe(true);
    releaseSecond();
    const secondRes = await second;

    expect(firstRes.isError).toBe(false);
    expect(secondRes.isError).toBe(false);
    expect(observed).toEqual(['fast-target', 'fast-target']);
    // Both cleanups ran, leaving no extension-owned attribute behind.
    expect(document.documentElement.hasAttribute('data-browserpaw-ref-attr')).toBe(false);
    expect(document.getElementById('fast-target')!.attributes).toHaveLength(1);
  });

  it.each(['open', 'closed'] as const)('removes stamps inside %s shadow roots', async (mode) => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Another debugger is already attached to this target'),
    );
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode });
    const inner = document.createElement('button');
    inner.id = 'shadow-target';
    shadow.appendChild(inner);
    document.body.appendChild(host);
    (globalThis as Record<string | symbol, unknown>)[indexMapSymbol] = new Map([[2, inner]]);

    await javascriptTool.execute({ tabId: 42, code: 'return mcp.get(2)?.id;' });

    // Cleanup removes the exact elements the stamping pass marked, so a closed
    // root (unreachable by any page-level query) is cleaned too.
    expect(inner.attributes).toHaveLength(1);
    expect(inner.id).toBe('shadow-target');
    expect(document.documentElement.hasAttribute('data-browserpaw-ref-attr')).toBe(false);
  });

  it('bounds a blocked renderer instead of hanging before the tool timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
        new Error('Another debugger is already attached to this target'),
      );
      // The bridge injection never settles, as with an open native dialog.
      executeScript.mockImplementation(() => new Promise(() => {}));

      const pending = javascriptTool.execute({
        tabId: 42,
        code: 'return mcp.get(1);',
        timeoutMs: 500,
      });
      // Bridge deadline (500) + bounded cleanup (1000) + scripting deadline (500).
      await vi.advanceTimersByTimeAsync(3000);

      const res = await pending;
      // The bridge gave up at the tool deadline instead of hanging the call before
      // its own timeout could apply; the evaluation path reports the timeout.
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
