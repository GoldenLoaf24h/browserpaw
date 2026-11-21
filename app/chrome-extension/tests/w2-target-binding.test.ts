import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BaseBrowserToolExecutor } from '../entrypoints/background/tools/base-browser';
import { sessionTabAffinity, startHandoverTracking } from '../utils/session-tab-affinity';
import { handleCallTool } from '../entrypoints/background/tools/index';
import { TabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';

class TestExecutor extends BaseBrowserToolExecutor {
  name = 'test_tool';
  async execute(args: any): Promise<any> {
    return this.resolveAffinityTab(args);
  }
}

describe('W2 & BUG-11 Regression Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionTabAffinity.clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('BUG-02: resolveAffinityTab with invalid explicit tabId must fail directly', () => {
    it('throws error and does not fallback to active tab or session affinity when explicit tabId does not exist', async () => {
      const activeTab = { id: 100, active: true, windowId: 1 };
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async (id: number) => {
            if (id === 999) throw new Error('Tab 999 not found');
            if (id === 100) return activeTab;
            throw new Error(`Tab ${id} not found`);
          }),
          query: vi.fn(async () => [activeTab]),
        },
      };

      const executor = new TestExecutor();
      // Should fail/throw because tabId 999 was explicitly provided and does not exist
      await expect(executor.execute({ tabId: 999, sessionId: 'sess-1' })).rejects.toThrow(
        /tab.*999.*not found/i,
      );
    });
  });

  describe('BUG-04: initial tabs snapshot ignores onActivated so existing tabs are not treated as newly seen', () => {
    it('does not treat an existing tab activated during query as a newly seen child tab', async () => {
      let queryResolve: (tabs: any[]) => void;
      const queryPromise = new Promise<any[]>((resolve) => {
        queryResolve = resolve;
      });

      const existingTab = { id: 50, windowId: 1, active: false, title: 'Existing' };
      const parentTab = { id: 10, windowId: 1, active: true, title: 'Parent' };

      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(info: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async (id: number) => {
            if (id === 10) return parentTab;
            if (id === 50) return existingTab;
            throw new Error('Not found');
          }),
          query: vi.fn(() => queryPromise),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      const tracker = startHandoverTracking(10, 'sess-handover', { windowId: 1 });

      // Before query completes, existingTab 50 is activated!
      for (const fn of activatedListeners) {
        fn({ tabId: 50, windowId: 1 });
      }

      // Allow microtasks to run (e.g. tabs.get)
      await new Promise((r) => setTimeout(r, 50));

      // Now query completes and returns existing tabs
      queryResolve!([parentTab, existingTab]);

      const result = await tracker.waitForHandover(200);

      // Tab 50 was an existing tab, NOT a newly created child tab!
      expect(result).toBeNull();
    });
  });

  describe('BUG-11: argument coercion respects schema types and preserves string fields', () => {
    it('preserves text "false" as a string', async () => {
      (globalThis as any).chrome = {
        storage: {
          session: {
            get: vi.fn().mockResolvedValue({ agentControlEnabled: true }),
          },
        },
        bookmarks: {
          remove: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue([{ id: '007', title: 'Test' }]),
        },
      };

      let capturedFillArgs: any = null;
      const fillModule = await import('../entrypoints/background/tools/browser/fill-index');
      vi.spyOn(fillModule.fillIndexTool, 'execute').mockImplementation(async (args: any) => {
        capturedFillArgs = { ...args };
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      });

      // Call chrome_fill_index with text: "false"
      await handleCallTool({
        name: 'chrome_fill_index',
        args: { index: 1, text: 'false' },
      });

      expect(capturedFillArgs.text).toBe('false');
    });

    it('coerces number field with decimal without losing fractional part', async () => {
      let capturedScreenshotArgs: any = null;
      const scModule = await import('../entrypoints/background/tools/browser/screenshot');
      vi.spyOn(scModule.screenshotTool, 'execute').mockImplementation(async (args: any) => {
        capturedScreenshotArgs = { ...args };
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      });

      await handleCallTool({
        name: 'chrome_screenshot',
        args: { quality: '0.85' },
      });

      expect(capturedScreenshotArgs.quality).toBe(0.85);
    });

    it('does not truncate float string to integer for integer schema field (e.g. index 2.5 is not truncated to 2)', async () => {
      let capturedKeyboardArgs: any = null;
      const kbModule = await import('../entrypoints/background/tools/browser/keyboard');
      vi.spyOn(kbModule.keyboardTool, 'execute').mockImplementation(async (args: any) => {
        capturedKeyboardArgs = { ...args };
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      });

      await handleCallTool({
        name: 'chrome_keyboard',
        args: { index: '2.5', keys: 'Enter' },
      });

      // Must not be truncated to 2! Kept as '2.5' for downstream validation
      expect(capturedKeyboardArgs.index).toBe('2.5');
    });
  });

  describe('ARCH-03: transport principal param.sessionId must override args.sessionId and args.sessionContext', () => {
    it('overrides caller-supplied args.sessionId and args.sessionContext with trusted param.sessionId', async () => {
      (globalThis as any).chrome = {
        storage: {
          session: {
            get: vi.fn().mockResolvedValue({ agentControlEnabled: true }),
          },
        },
      };

      let capturedArgs: any = null;
      const fillModule = await import('../entrypoints/background/tools/browser/fill-index');
      vi.spyOn(fillModule.fillIndexTool, 'execute').mockImplementation(async (args: any) => {
        capturedArgs = { ...args };
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      });

      await handleCallTool({
        name: 'chrome_fill_index',
        args: {
          index: 1,
          text: 'test',
          sessionId: 'untrusted-spoofed-session',
          sessionContext: 'untrusted-context',
        },
        sessionId: 'transport-principal-real',
      });

      expect(capturedArgs.sessionId).toBe('transport-principal-real');
      expect(capturedArgs.sessionContext).toBe('transport-principal-real');
    });
  });

  describe('NEW-AGENTCONTROL: storage read failure causes mutating tools to fail closed while diagnostic/read-only tools remain available', () => {
    it('fails closed for all tools when storage read throws', async () => {
      (globalThis as any).chrome = {
        storage: {
          session: {
            get: vi.fn().mockRejectedValue(new Error('Storage access failed')),
          },
        },
      };

      const res = await handleCallTool({
        name: 'chrome_fill_index',
        args: { index: 1, text: 'data' },
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/Agent control state could not be verified/i);

      const scRes = await handleCallTool({
        name: 'chrome_screenshot',
        args: {},
      });
      expect(scRes.isError).toBe(true);
      expect(scRes.content[0].text).toMatch(/Agent control state could not be verified/i);
    });
  });

  describe('ARCH-02: tab group cleanup only cleans managed groups and does not ungroup user "Agent" group', () => {
    it('does not ungroup tabs from user group titled "Agent" when group is not in managedGroupIds', async () => {
      const userGroup = { id: 99, title: 'Agent', windowId: 1 };
      const userTab = { id: 101, groupId: 99, windowId: 1, title: 'User Page' };

      const ungroupMock = vi.fn().mockResolvedValue(undefined);

      (globalThis as any).chrome = {
        storage: {
          session: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        tabGroups: {
          get: vi.fn(async (id: number) => {
            if (id === 99) return userGroup;
            throw new Error('Not found');
          }),
          query: vi.fn(async () => [userGroup]),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        tabs: {
          query: vi.fn(async (filter: any) => {
            if (filter.groupId === 99) return [userTab];
            return [userTab];
          }),
          ungroup: ungroupMock,
          remove: vi.fn().mockResolvedValue(undefined),
        },
      };

      const manager = new TabGroupManager();
      await manager.ensureStorageLoaded();

      // Run cleanup
      await manager.cleanupEmptyOrOrphanGroups();

      // User's tab in user group 99 must NOT be ungrouped!
      expect(ungroupMock).not.toHaveBeenCalled();
    });
  });
});
