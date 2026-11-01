import { afterEach, describe, expect, it, vi } from 'vitest';

describe('registered observation entrypoints', () => {
  afterEach(() => {
    (globalThis as any).__MCP_OBSERVATION_DISPOSE__?.();
    delete (globalThis as any).__MCP_INPAGE__;
    delete (globalThis as any).__MCP_INPAGE_VERSION__;
    delete (globalThis as any).__MCP_OBSERVATION_DISPOSE__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('reuses production entrypoints, invalidates mutations, and disposes old engines', async () => {
    document.body.innerHTML = '<button>Save</button>';
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      width: 100,
      height: 25,
      top: 10,
      left: 10,
      right: 110,
      bottom: 35,
    } as DOMRect);
    vi.stubGlobal('defineUnlistedScript', (run: () => void) => run);
    const install = (await import('../entrypoints/inpage-engine')).default as unknown as () => void;
    install();
    const engine = (globalThis as any).__MCP_INPAGE__;
    const first = engine.inPageDOMPruner();
    const next = engine.inPageDOMPruner();
    expect(first.observationReused).toBe(false);
    expect(next.observationReused).toBe(true);
    expect(next.indexMap).toEqual(first.indexMap);
    // read_dom's explicit defaults and delta's small option object share the collector.
    expect(
      engine.inPageDOMPruner({
        format: 'compact',
        maxTextLength: undefined,
        viewportThreshold: 1000,
        highlight: false,
      }).observationReused,
    ).toBe(true);
    document.querySelector('button')!.textContent = 'Updated';
    expect(engine.inPageDOMPruner()).toMatchObject({ observationReused: false });
    const fast = engine.inPageFastSnapshot();
    const fastAlias = engine.snapshot();
    expect(fast.observationReused).toBe(false);
    expect(fastAlias.observationReused).toBe(true);
    expect(fastAlias.actions).toEqual(fast.actions);
    expect((globalThis as any).__pawFast.snapshot().observationReused).toBe(true);
    const dispose = vi.fn((globalThis as any).__MCP_OBSERVATION_DISPOSE__);
    (globalThis as any).__MCP_OBSERVATION_DISPOSE__ = dispose;
    (globalThis as any).__MCP_INPAGE_VERSION__ = 'old';
    install();
    expect(dispose).toHaveBeenCalledOnce();
    expect((globalThis as any).__MCP_INPAGE__.inPageDOMPruner().observationReused).toBe(false);
  });
});
