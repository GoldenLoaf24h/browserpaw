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
          mcpPublishedDuringEval: !!globalThis.__mcp,
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
      mcpPublishedDuringEval: true,
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
