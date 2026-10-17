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
