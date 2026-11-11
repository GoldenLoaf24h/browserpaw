import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inPageWaitForDOMSettle, waitForPageSettle } from '../utils/action-watchdog';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Action watchdog and confirmation trap observation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (globalThis as any).__MCP_INPAGE__;
  });

  it('inPageWaitForDOMSettle detects confirmation trap directly when mounted in page', async () => {
    const mockTrap = { detected: true, title: 'Discard changes?', buttons: ['Discard', 'Cancel'] };
    (globalThis as any).__MCP_INPAGE__ = {
      inPageDetectConfirmationTrap: vi.fn().mockReturnValue(mockTrap),
    };

    const res = await inPageWaitForDOMSettle(200, 20);
    expect(res.settled).toBe(true);
    expect(res.trapCheckedInPage).toBe(true);
    expect(res.confirmationTrap).toEqual(mockTrap);
    expect((globalThis as any).__MCP_INPAGE__.inPageDetectConfirmationTrap).toHaveBeenCalledTimes(
      1,
    );
  });

  it('inPageWaitForDOMSettle handles absence of inPageDetectConfirmationTrap gracefully', async () => {
    (globalThis as any).__MCP_INPAGE__ = {};

    const res = await inPageWaitForDOMSettle(200, 20);
    expect(res.settled).toBe(true);
    expect(res.trapCheckedInPage).toBe(false);
    expect(res.confirmationTrap).toBeUndefined();
  });

  it.each(['throws', 'invalid'])(
    'preserves fallback when the combined trap check %s',
    async (mode) => {
      (globalThis as any).__MCP_INPAGE__ = {
        inPageDetectConfirmationTrap: () => {
          if (mode === 'throws') throw new Error('observer unavailable');
          return undefined;
        },
      };
      const result = await inPageWaitForDOMSettle(200, 20);
      expect(result.trapCheckedInPage).toBe(false);
      expect(result.confirmationTrap).toBeUndefined();
    },
  );

  it('waitForPageSettle skips second IPC round-trip when trapCheckedInPage is true', async () => {
    const executeInPageSpy = vi
      .spyOn(inPageEngine, 'executeInPage')
      .mockImplementation(async (_target, method) => {
        if (method === 'inPageWaitForDOMSettle') {
          return [
            {
              result: {
                settled: true,
                durationMs: 45,
                mutationsObserved: 1,
                trapCheckedInPage: true,
                confirmationTrap: { detected: true, title: 'Unsaved draft' },
              },
            },
          ] as any;
        }
        if (method === 'inPageDetectConfirmationTrap') {
          throw new Error('Should not execute second IPC when trapCheckedInPage is true');
        }
        return [] as any;
      });

    const settleRes = await waitForPageSettle(101, {
      timeoutMs: 300,
      quietPeriodMs: 50,
      hasActiveRequests: false,
    });
    expect(settleRes.settled).toBe(true);
    expect(settleRes.confirmationTrap).toEqual({ detected: true, title: 'Unsaved draft' });
    expect(executeInPageSpy).toHaveBeenCalledTimes(1);
    expect(executeInPageSpy).toHaveBeenCalledWith(
      { tabId: 101 },
      'inPageWaitForDOMSettle',
      expect.any(Array),
    );
  });

  it('waitForPageSettle falls back to second IPC when trapCheckedInPage is falsy', async () => {
    const executeInPageSpy = vi
      .spyOn(inPageEngine, 'executeInPage')
      .mockImplementation(async (_target, method) => {
        if (method === 'inPageWaitForDOMSettle') {
          return [
            {
              result: {
                settled: true,
                durationMs: 30,
                mutationsObserved: 0,
                // trapCheckedInPage omitted (legacy/mocked unit test behavior)
              },
            },
          ] as any;
        }
        if (method === 'inPageDetectConfirmationTrap') {
          return [
            {
              result: {
                detected: true,
                title: 'Discard Post?',
              },
            },
          ] as any;
        }
        return [] as any;
      });

    const settleRes = await waitForPageSettle(102, {
      timeoutMs: 300,
      quietPeriodMs: 50,
      hasActiveRequests: false,
    });
    expect(settleRes.settled).toBe(true);
    expect(settleRes.confirmationTrap).toEqual({ detected: true, title: 'Discard Post?' });
    expect(executeInPageSpy).toHaveBeenCalledTimes(2);
    expect(executeInPageSpy).toHaveBeenNthCalledWith(
      1,
      { tabId: 102 },
      'inPageWaitForDOMSettle',
      expect.any(Array),
    );
    expect(executeInPageSpy).toHaveBeenNthCalledWith(
      2,
      { tabId: 102 },
      'inPageDetectConfirmationTrap',
      [],
    );
  });
});
