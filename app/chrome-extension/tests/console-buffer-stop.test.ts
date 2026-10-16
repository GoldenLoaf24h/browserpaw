import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { consoleTool } from '../entrypoints/background/tools/browser/console';
import { consoleBuffer } from '../entrypoints/background/tools/browser/console-buffer';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { RAW_TOOL_SCHEMAS } from '../../../packages/shared/src/tools';

/**
 * P2-1: the persistent console buffer had no stop entry point, so a tab kept its
 * CDP attachment and enabled Runtime/Log domains until it was closed or navigated
 * to a new origin.
 */
describe('P2-1: console buffer stop entry point', () => {
  // cdpSessionManager keeps per-tab session and domain state for the whole file, so each
  // case takes its own tab to stay independent of what a previous case left attached.
  let TAB_ID = 0;
  let nextTabId = 100;

  beforeEach(() => {
    TAB_ID = nextTabId++;
    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id' },
      tabs: {
        get: vi.fn(async (id: number) => ({
          id,
          windowId: 1,
          url: 'https://tab' + id + '.test',
          title: 'Tab ' + id,
          status: 'complete',
        })),
        query: vi.fn(async () => []),
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async () => ({})),
        getTargets: vi.fn(async () => []),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(async () => {
    // Release anything a failed assertion left capturing.
    await consoleBuffer.stop(TAB_ID, 'test_cleanup').catch(() => {});
    vi.restoreAllMocks();
  });

  it('mode="stop" releases the buffer and reports the capture is gone', async () => {
    const startRes = await consoleTool.execute({ tabId: TAB_ID, mode: 'buffer' } as any);
    expect(startRes.isError).toBe(false);
    expect(consoleBuffer.isCapturing(TAB_ID)).toBe(true);

    const stopRes = await consoleTool.execute({ tabId: TAB_ID, mode: 'stop' } as any);
    expect(stopRes.isError).toBe(false);

    const parsed = JSON.parse((stopRes.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.stopped).toBe(true);
    expect(parsed.isCapturing).toBe(false);
    expect(consoleBuffer.isCapturing(TAB_ID)).toBe(false);
  });

  it('mode="stop" is idempotent and reports stopped=false when nothing was capturing', async () => {
    const first = await consoleTool.execute({ tabId: TAB_ID, mode: 'stop' } as any);
    const parsedFirst = JSON.parse((first.content[0] as any).text);
    expect(parsedFirst.stopped).toBe(false);
    expect(parsedFirst.isCapturing).toBe(false);

    // Stopping again must not throw and must stay false.
    const second = await consoleTool.execute({ tabId: TAB_ID, mode: 'stop' } as any);
    expect(second.isError).toBe(false);
    expect(JSON.parse((second.content[0] as any).text).stopped).toBe(false);
  });

  it('stop releases only the buffer own domain claims, leaving another owner enabled', async () => {
    // Another tool holds Runtime independently of the console buffer.
    await cdpSessionManager.attach(TAB_ID, 'other-tool');
    await cdpSessionManager.enableDomain(TAB_ID, 'Runtime');
    const beforeCount = cdpSessionManager.getDomainRefCount(TAB_ID, 'Runtime');

    await consoleTool.execute({ tabId: TAB_ID, mode: 'buffer' } as any);
    expect(cdpSessionManager.getDomainRefCount(TAB_ID, 'Runtime')).toBe(beforeCount + 1);

    await consoleTool.execute({ tabId: TAB_ID, mode: 'stop' } as any);

    // The other owner's claim survives; only the buffer's increment was released.
    expect(cdpSessionManager.getDomainRefCount(TAB_ID, 'Runtime')).toBe(beforeCount);
  });

  it('a stop issued while the buffer is still starting tears down the new capture', async () => {
    let releaseAttach: (() => void) | undefined;
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });

    vi.spyOn(cdpSessionManager, 'attach').mockImplementation(async () => {
      await attachGate;
    });

    const startPromise = consoleTool.execute({ tabId: TAB_ID, mode: 'buffer' } as any);

    // Give ensureStarted a turn to register the in-flight start.
    await new Promise((r) => setTimeout(r, 0));

    const stopPromise = consoleTool.execute({ tabId: TAB_ID, mode: 'stop' } as any);

    releaseAttach!();
    await startPromise;
    const stopRes = await stopPromise;

    // Without awaiting the in-flight start, stop tears down a session that is not
    // finished being built: startCapture then re-enables Runtime/Log after the
    // teardown and leaks the reference counts.
    expect(JSON.parse((stopRes.content[0] as any).text).stopped).toBe(true);
    expect(consoleBuffer.isCapturing(TAB_ID)).toBe(false);
    expect(cdpSessionManager.getDomainRefCount(TAB_ID, 'Runtime')).toBe(0);
    expect(cdpSessionManager.getDomainRefCount(TAB_ID, 'Log')).toBe(0);
  });

  it('advertises stop in the shared tool schema', () => {
    const schema = RAW_TOOL_SCHEMAS.find((s) => s.name === 'chrome_console');
    expect(schema).toBeDefined();
    const modeSchema = (schema as any).inputSchema.properties.mode;
    expect(modeSchema.enum).toContain('stop');
    expect(modeSchema.description).toContain('stop');
  });
});
