import { describe, expect, it, jest } from '@jest/globals';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserTaskManager, type BrowserCall, type BrowserTaskResult } from './browser-tasks';

const USER_TAB = {
  tabId: 10,
  url: 'https://user.example/',
  documentId: 'doc-10',
  title: 'User page',
  status: 'complete',
  isAgentManaged: false,
};

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function live(extraTabs: Array<Record<string, unknown>> = [], browserInstanceId = 'browser-1') {
  return result({
    browserInstanceId,
    windowCount: 1,
    tabCount: 1 + extraTabs.length,
    windows: [
      {
        windowId: 1,
        focused: true,
        state: 'normal',
        bounds: {},
        tabs: [USER_TAB, ...extraTabs],
      },
    ],
  });
}

function tab(
  tabId: number,
  url: string,
  isAgentManaged = true,
  documentId = `doc-${tabId}`,
  browserInstanceId = 'browser-1',
  openerTabId?: number,
  status = 'complete',
) {
  return {
    tabId,
    url,
    documentId,
    browserInstanceId,
    title: `Tab ${tabId}`,
    status,
    isAgentManaged,
    ...(openerTabId !== undefined ? { openerTabId } : {}),
  };
}

function opened(tabId: number, url: string) {
  return result({
    success: true,
    message: 'Opened URL in new tab in existing window',
    tabId,
    windowId: 1,
    url,
  });
}

function expectedTabs(tabIds: number[]) {
  return tabIds.map((tabId) => ({
    tabId,
    documentId: `doc-${tabId}`,
    browserInstanceId: 'browser-1',
  }));
}

function viewport(
  status: 'native' | 'limited' = 'native',
  width = 1280,
  height = 720,
  dpr = 1.5,
  reason?: string,
) {
  return result({
    success: true,
    viewport: { status, width, height, dpr, ...(reason ? { reason } : {}) },
  });
}

function released() {
  return result({ success: true });
}

function testDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `browserpaw-tasks-${name}-`));
}

function failRenameSequence(failures: Array<{ contains: string | string[]; message: string }>) {
  const originalRename = fs.promises.rename.bind(fs.promises);
  const remaining = [...failures];
  return jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    const failure = remaining[0];
    const body = failure ? fs.readFileSync(from, 'utf8') : '';
    const contents = Array.isArray(failure?.contains)
      ? failure.contains
      : failure?.contains
        ? [failure.contains]
        : [];
    if (failure && contents.every((content) => body.includes(content))) {
      remaining.shift();
      throw new Error(failure.message);
    }
    await originalRename(from, to);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BrowserTaskManager', () => {
  it('persists a task and restores its exact owned page after a restart', async () => {
    const storageDir = testDir('restore');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(31, 'https://owned.example/');
      if (name === 'get_windows_and_tabs') return live([tab(31, 'https://owned.example/')]);
      throw new Error(`unexpected ${name}`);
    });
    const first = new BrowserTaskManager({ call, storageDir });

    const started = await first.execute({
      action: 'start',
      name: 'Restore task',
      goal: 'Verify persistence',
      browser: 'chrome-main',
    });
    const taskId = started.task!.id;
    const openedResult = await first.execute({
      action: 'open',
      taskId,
      url: 'https://owned.example/',
    });
    expect(openedResult.ok).toBe(true);
    expect(openedResult.task?.pendingCreations).toEqual([]);

    const second = new BrowserTaskManager({ call, storageDir });
    const resumed = await second.execute({ action: 'resume', taskId });

    expect(resumed.ok).toBe(true);
    expect(resumed.task?.browser).toBe('chrome-main');
    expect(resumed.task?.pages).toEqual([
      expect.objectContaining({
        tabId: 31,
        url: 'https://owned.example/',
        ownership: 'owned',
        exists: true,
        identityVerified: true,
      }),
    ]);
  });

  it('forces newTab/background and never adopts a reused browser page as owned', async () => {
    const storageDir = testDir('reuse');
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') {
        return result({
          success: true,
          message: 'Activated existing tab',
          tabId: 10,
          windowId: 1,
          url: 'https://user.example/',
        });
      }
      if (name === 'get_windows_and_tabs') return live();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const started = await manager.execute({ action: 'start', name: 'Reuse test' });

    const openedResult = await manager.execute({
      action: 'open',
      taskId: started.task!.id,
      url: 'https://user.example/',
    });

    expect(call).toHaveBeenCalledWith(
      'chrome_navigate',
      {
        url: 'https://user.example/',
        newTab: true,
        background: true,
      },
      undefined,
      undefined,
    );
    expect(openedResult.ok).toBe(false);
    expect(openedResult.error).toContain('native creation proof');
    const status = await manager.execute({ action: 'status', taskId: started.task!.id });
    expect(status.task?.pages).toEqual([]);
  });

  it('rejects the ninth owned page without invoking navigation and preserves user pages', async () => {
    const storageDir = testDir('budget');
    let nextTabId = 30;
    const openedTabs: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        const tabId = nextTabId++;
        openedTabs.push(tab(tabId, String(args.url)));
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') {
        return live(openedTabs);
      }
      if (name === 'chrome_interact_index') {
        openedTabs.push(tab(38, 'https://passive-popup.example/', true, 'doc-38', 'browser-1', 37));
        return result({
          success: true,
          tabId: args.tabId,
          receipt: {
            hasReceipt: true,
            popups: [
              {
                tabId: 38,
                openerTabId: 37,
                url: 'https://passive-popup.example/',
              },
            ],
          },
        });
      }
      if (name === 'chrome_close_tabs') {
        return result({ success: true, closedTabIds: args.tabIds });
      }
      if (name === 'browserpaw_release_owned_page') return released();
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Budget test' });

    for (let i = 0; i < 8; i++) {
      const openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: `https://item-${i}.example/`,
      });
      expect(openedResult.ok).toBe(true);
    }
    expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(8);

    const ninth = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://item-8.example/',
    });
    expect(ninth).toEqual(
      expect.objectContaining({ ok: false, status: 'blocked', retry: false, dispatched: false }),
    );
    expect(ninth.error).toContain('8');
    expect(ninth.task?.pages).toHaveLength(8);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(8);

    const passivePopup = await manager.callTool(task!.id, 'chrome_interact_index', {
      action: 'click',
    });
    expect((passivePopup._meta as any)?.budgetExceeded).toEqual(
      expect.objectContaining({ exceeded: true, budget: 8, pageCount: 9 }),
    );
    await expect(
      manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' }),
    ).rejects.toThrow('budget exceeded');
    const afterPopup = await manager.execute({ action: 'status', taskId: task!.id });
    expect(afterPopup.task?.pages).toHaveLength(9);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'chrome_close_tabs',
      {
        tabIds: Array.from({ length: 9 }, (_, i) => 30 + i),
        expectedTabs: expectedTabs(Array.from({ length: 9 }, (_, i) => 30 + i)),
      },
      undefined,
      undefined,
    );
    expect(call).not.toHaveBeenCalledWith('chrome_close_tabs', { tabIds: [10] });
  });

  it('borrows without owning or deleting and releases only the loan on finish', async () => {
    const storageDir = testDir('borrow');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_windows_and_tabs') return live();
      if (name === 'chrome_navigate') return opened(32, 'https://borrowed.example/');
      if (name === 'chrome_close_tabs') return result({ success: true, closedTabIds: args.tabIds });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Borrow test' });

    const borrowed = await manager.execute({
      action: 'borrow',
      taskId: task!.id,
      tabId: 10,
      url: 'https://user.example/',
    });
    expect(borrowed.ok).toBe(true);
    expect(borrowed.task?.pages).toEqual([
      expect.objectContaining({ tabId: 10, ownership: 'borrowed' }),
    ]);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(call).not.toHaveBeenCalledWith('chrome_close_tabs', expect.anything());
    expect(finished.task?.pages).toEqual([]);
  });

  it('finish closes owned but not borrowed, while keep turns owned pages over without releasing loans', async () => {
    const storageDir = testDir('finish');
    let nextTabId = 40;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(nextTabId++, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([
          tab(40, 'https://owned-a.example/'),
          tab(41, 'https://owned-b.example/'),
          tab(10, 'https://user.example/', false),
        ]);
      }
      if (name === 'chrome_close_tabs') {
        return result({ success: true, closedTabIds: args.tabIds });
      }
      if (name === 'browserpaw_release_owned_page') return released();
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Finish test' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://owned-a.example/' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://owned-b.example/' });
    await manager.execute({ action: 'borrow', taskId: task!.id, tabId: 10 });

    const partial = await manager.execute({ action: 'finish', taskId: task!.id, keep: [40] });
    expect(partial.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'chrome_close_tabs',
      { tabIds: [41], expectedTabs: expectedTabs([41]) },
      undefined,
      undefined,
    );
    expect(partial.task?.pages).toEqual([
      expect.objectContaining({ tabId: 40, ownership: 'user' }),
    ]);
    expect(partial.task?.status).toBe('finished');
  });

  it('handOff moves only a live verified owned page and detaches it from cleanup', async () => {
    const storageDir = testDir('handoff');
    let closeCalls = 0;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(50, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(50, 'https://handoff.example/')]);
      if (name === 'chrome_close_tabs') {
        closeCalls++;
        return result({ success: true });
      }
      if (name === 'browserpaw_release_owned_page') return released();
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Handoff test' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://handoff.example/' });

    const handed = await manager.execute({ action: 'handOff', taskId: task!.id, tabId: 50 });
    expect(handed.ok).toBe(true);
    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(closeCalls).toBe(0);
  });

  it('rejects false handOff/keep confirmation but succeeds only after the browser releases ownership', async () => {
    const storageDir = testDir('release-confirmation');
    let releaseSucceeds = false;
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(55, 'https://release.example/');
      if (name === 'get_windows_and_tabs') return live([tab(55, 'https://release.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'browserpaw_release_owned_page') {
        return releaseSucceeds ? released() : result({ success: false });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Release confirmation' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://release.example/' });

    const rejected = await manager.execute({ action: 'handOff', taskId: task!.id, tabId: 55 });
    expect(rejected.ok).toBe(false);
    const stillOwned = await manager.execute({ action: 'status', taskId: task!.id });
    expect(stillOwned.task?.pages[0]).toEqual(
      expect.objectContaining({ tabId: 55, ownership: 'owned' }),
    );

    releaseSucceeds = true;
    const kept = await manager.execute({ action: 'finish', taskId: task!.id, keep: [55] });
    expect(kept.ok).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'browserpaw_release_owned_page',
      {
        taskId: task!.id,
        tabId: 55,
        documentId: 'doc-55',
        browserInstanceId: 'browser-1',
      },
      undefined,
      undefined,
    );
    expect(kept.task?.pages[0]).toEqual(expect.objectContaining({ tabId: 55, ownership: 'user' }));
  });

  it('finishes cancelled-task cleanup, preserves cancellation, and returns finished tasks idempotently', async () => {
    const storageDir = testDir('finish-cancelled-idempotent');
    let nextTabId = 56;
    const closed: number[] = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(nextTabId++, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(56, 'https://cancelled.example/'), tab(57, 'https://finished.example/')]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closed.push(...(args.tabIds as number[]));
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const cancelledTask = (await manager.execute({ action: 'start', name: 'Cancelled cleanup' }))
      .task!;
    await manager.execute({
      action: 'open',
      taskId: cancelledTask.id,
      url: 'https://cancelled.example/',
    });
    await manager.execute({ action: 'cancel', taskId: cancelledTask.id });
    const cancelledCleanup = await manager.execute({
      action: 'finish',
      taskId: cancelledTask.id,
    });
    expect(cancelledCleanup.ok).toBe(true);
    expect(cancelledCleanup.task?.status).toBe('cancelled');
    expect(closed).toEqual([56]);

    const finishedTask = (await manager.execute({ action: 'start', name: 'Idempotent finish' }))
      .task!;
    await manager.execute({
      action: 'open',
      taskId: finishedTask.id,
      url: 'https://finished.example/',
    });
    const firstFinish = await manager.execute({ action: 'finish', taskId: finishedTask.id });
    const secondFinish = await manager.execute({ action: 'finish', taskId: finishedTask.id });
    expect(firstFinish.task?.status).toBe('finished');
    expect(secondFinish.ok).toBe(true);
    expect(secondFinish.message).toContain('already finished');
    expect(closed).toEqual([56, 57]);
  });

  it('records applied/limited viewport capability and reapplies it without closing the page', async () => {
    const storageDir = testDir('viewport-capability');
    let viewportResult = viewport('native');
    let viewportCalls = 0;
    let closeCalls = 0;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(58, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(58, 'https://viewport.example/')]);
      }
      if (name === 'browserpaw_set_owned_viewport') {
        viewportCalls++;
        return viewportResult;
      }
      if (name === 'chrome_close_tabs') {
        closeCalls++;
        return result({ success: true });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Viewport capability' });
    const openedTask = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://viewport.example/',
    });
    expect(openedTask.task?.pages[0]?.viewport).toEqual({
      status: 'native',
      width: 1280,
      height: 720,
      dpr: 1.5,
    });

    viewportResult = viewport('limited', 1200, 800, 1, 'Window is minimized');
    const resumed = await manager.execute({ action: 'resume', taskId: task!.id });
    expect(resumed.ok).toBe(true);
    expect(resumed.task?.pages[0]?.viewport).toEqual({
      status: 'limited',
      width: 1200,
      height: 800,
      dpr: 1,
      reason: 'Window is minimized',
    });
    expect(viewportCalls).toBe(2);
    expect(closeCalls).toBe(0);
  });

  it('resume rejects Chrome instance changes and tabId reuse without guessing', async () => {
    const storageDir = testDir('identity');
    let current = live([tab(60, 'https://original.example/')]);
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(60, 'https://original.example/');
      if (name === 'get_windows_and_tabs') {
        return current;
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({
      action: 'start',
      name: 'Identity test',
      browser: 'chrome-main',
    });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://original.example/' });

    current = live([tab(60, 'https://original.example/')], 'browser-2');
    const browserRestarted = await manager.execute({ action: 'resume', taskId: task!.id });
    expect(browserRestarted.ok).toBe(false);
    expect(browserRestarted.task?.pages[0]).toEqual(
      expect.objectContaining({ tabId: 60, exists: true, identityVerified: false }),
    );

    current = live([tab(61, 'https://original.example/')]);
    const reused = await manager.execute({ action: 'resume', taskId: task!.id });
    expect(reused.ok).toBe(false);
    expect(reused.task?.pages[0]).toEqual(
      expect.objectContaining({ tabId: 60, exists: false, identityVerified: false }),
    );
    expect(reused.task?.pages).toHaveLength(1);
  });

  it('callTool binds the current page, passes sessionId, and rejects foreign, borrowed-close, and handed-off mutations', async () => {
    const storageDir = testDir('call-tool-auth');
    const liveTabs = [tab(201, 'https://task-a.example/'), tab(202, 'https://task-b.example/')];
    const call = jest.fn<BrowserCall>(
      async (name: string, args: Record<string, unknown>, sessionId?: string) => {
        if (name === 'chrome_navigate') {
          const tabId = String(args.url).includes('task-a') ? 201 : 202;
          return opened(tabId, String(args.url));
        }
        if (name === 'get_windows_and_tabs') return live(liveTabs);
        if (name === 'chrome_interact_index') {
          return result({ success: true, tabId: args.tabId, sessionId });
        }
        if (name === 'browserpaw_release_owned_page') return released();
        if (name === 'browserpaw_set_owned_viewport') return viewport();
        throw new Error(`unexpected ${name}`);
      },
    );
    const manager = new BrowserTaskManager({ call, storageDir });
    const taskA = (await manager.execute({ action: 'start', name: 'Task A' })).task!;
    const taskB = (await manager.execute({ action: 'start', name: 'Task B' })).task!;
    await manager.execute({ action: 'open', taskId: taskA.id, url: 'https://task-a.example/' });
    await manager.execute({ action: 'open', taskId: taskB.id, url: 'https://task-b.example/' });

    const bound = await manager.callTool(
      taskA.id,
      'chrome_interact_index',
      { action: 'click' },
      'session-a',
    );
    expect(JSON.parse(String((bound.content[0] as { text: string }).text))).toEqual(
      expect.objectContaining({ tabId: 201, sessionId: 'session-a' }),
    );
    expect(call).toHaveBeenCalledWith(
      'chrome_interact_index',
      { action: 'click', tabId: 201 },
      'session-a',
      expect.any(AbortSignal),
    );

    await expect(
      manager.callTool(taskA.id, 'chrome_interact_index', { tabId: 202 }),
    ).rejects.toThrow('not an active page');
    await expect(
      manager.callTool(taskA.id, 'chrome_interact_index', { tabId: 10 }),
    ).rejects.toThrow('not an active page');
    await expect(manager.callTool(taskA.id, 'chrome_task', {})).rejects.toThrow(
      'Recursive task tool call',
    );

    await manager.execute({ action: 'borrow', taskId: taskA.id, tabId: 10 });
    await expect(manager.callTool(taskA.id, 'chrome_close_tabs', {})).rejects.toThrow(
      'Cannot close borrowed/user task page',
    );

    await manager.execute({ action: 'handOff', taskId: taskA.id, tabId: 201 });
    await expect(
      manager.callTool(taskA.id, 'chrome_interact_index', { tabId: 201 }),
    ).rejects.toThrow('not an active page');
  });

  it.each([
    ['target.tabId', { target: { tabId: 10 } }],
    [
      'target.targetId',
      {
        target: { targetId: 'user-target' },
        method: 'Target.closeTarget',
        params: { targetId: 'user-target' },
      },
    ],
  ])('forbids raw task-scoped CDP before any browser call (%s)', async (_label, cdpArgs) => {
    const storageDir = testDir('task-cdp-forbidden');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(203, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(203, 'https://task-cdp.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'CDP isolation' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://task-cdp.example/' });
    const callsBefore = call.mock.calls.length;

    await expect(
      manager.callTool(task!.id, 'chrome_cdp_execute', {
        method: 'Runtime.evaluate',
        params: { expression: 'document.title' },
        ...cdpArgs,
      }),
    ).rejects.toThrow('Task-scoped execution cannot call browser management tool');
    expect(call.mock.calls).toHaveLength(callsBefore);
    expect(call.mock.calls.some(([name]) => name === 'chrome_cdp_execute')).toBe(false);
  });

  it('inherits a receipt-proven popup from an owned parent and closes it on finish', async () => {
    const storageDir = testDir('owned-popup');
    const closed: number[] = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(100, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([
          tab(100, 'https://owned-parent.example/'),
          tab(101, 'https://owned-popup.example/', true, 'doc-101', 'browser-1', 100),
        ]);
      }
      if (name === 'chrome_interact_index') {
        return result({
          success: true,
          tabId: args.tabId,
          receipt: {
            hasReceipt: true,
            popups: [
              {
                tabId: 101,
                openerTabId: 100,
                url: 'https://owned-popup.example/',
              },
            ],
          },
        });
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closed.push(...(args.tabIds as number[]));
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Owned popup' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://owned-parent.example/',
    });
    await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });

    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([
      expect.objectContaining({ tabId: 100, ownership: 'owned' }),
      expect.objectContaining({ tabId: 101, ownership: 'owned', openerTabId: 100 }),
    ]);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(closed).toEqual([100, 101]);
  });

  it('does not grant close ownership to a popup opened from a borrowed parent', async () => {
    const storageDir = testDir('borrowed-popup');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_windows_and_tabs') {
        return live([
          tab(10, 'https://user.example/', false),
          tab(11, 'https://borrowed-popup.example/', true, 'doc-11', 'browser-1', 10),
        ]);
      }
      if (name === 'chrome_interact_index') {
        return result({
          success: true,
          tabId: args.tabId,
          receipt: {
            hasReceipt: true,
            popups: [
              {
                tabId: 11,
                openerTabId: 10,
                url: 'https://borrowed-popup.example/',
              },
            ],
          },
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Borrowed popup' });
    await manager.execute({ action: 'borrow', taskId: task!.id, tabId: 10 });
    await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });

    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([
      expect.objectContaining({ tabId: 10, ownership: 'borrowed' }),
    ]);
    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(call).not.toHaveBeenCalledWith('chrome_close_tabs', expect.anything());
  });

  it('records a receipt-proven popup even when the triggering action returned unknown/error', async () => {
    const storageDir = testDir('unknown-popup');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(110, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([
          tab(110, 'https://unknown-parent.example/'),
          tab(111, 'https://unknown-popup.example/', true, 'doc-111', 'browser-1', 110),
        ]);
      }
      if (name === 'chrome_interact_index') {
        return result(
          {
            success: false,
            status: 'unknown',
            tabId: args.tabId,
            receipt: {
              hasReceipt: true,
              popups: [
                {
                  tabId: 111,
                  openerTabId: 110,
                  url: 'https://unknown-popup.example/',
                },
              ],
            },
          },
          true,
        );
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Unknown popup' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://unknown-parent.example/',
    });

    const actionResult = await manager.callTool(task!.id, 'chrome_interact_index', {
      action: 'click',
    });
    expect(actionResult.isError).toBe(true);
    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([
      expect.objectContaining({ tabId: 110, ownership: 'owned' }),
      expect.objectContaining({ tabId: 111, ownership: 'owned', openerTabId: 110 }),
    ]);
  });

  it('checks browserInstanceId/documentId before every mutation and never adopts without explicit pending evidence', async () => {
    const storageDir = testDir('preflight-identity');
    let inventory = live([tab(300, 'https://stable.example/', true, 'doc-a')]);
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(300, String(args.url));
      if (name === 'get_windows_and_tabs') return inventory;
      if (name === 'chrome_interact_index') return result({ success: true, tabId: args.tabId });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Identity before mutation' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://stable.example/' });

    inventory = live([tab(300, 'https://stable.example/', true, 'doc-user-navigation')]);
    const blocked = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        error: expect.stringContaining('failed browser/document identity verification'),
      }),
    );
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(0);

    const resume = await manager.execute({ action: 'resume', taskId: task!.id, adopt: true });
    expect(resume.ok).toBe(false);
  });

  it('records self-navigation as pending evidence and requires resume adopt before the next mutation', async () => {
    const storageDir = testDir('navigation-adopt');
    let inventory = live([tab(310, 'https://first.example/', true, 'doc-first')]);
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        if (args.url === 'https://second.example/') {
          inventory = live([tab(310, 'https://second.example/', true, 'doc-second')]);
          return result({ success: true, tabId: 310, url: args.url });
        }
        return opened(310, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return inventory;
      if (name === 'chrome_interact_index') return result({ success: true, tabId: args.tabId });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Navigation adopt' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://first.example/' });

    await manager.callTool(task!.id, 'chrome_navigate', { url: 'https://second.example/' });
    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages[0]).toEqual(
      expect.objectContaining({
        documentId: 'doc-first',
        pendingDocumentId: 'doc-second',
      }),
    );

    const blocked = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(blocked.structuredContent).toEqual(
      expect.objectContaining({
        status: 'blocked',
        retry: false,
        dispatched: false,
        error: expect.stringContaining('resume with adopt: true'),
      }),
    );
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(0);

    const withoutAdopt = await manager.execute({ action: 'resume', taskId: task!.id });
    expect(withoutAdopt.ok).toBe(false);
    const adopted = await manager.execute({
      action: 'resume',
      taskId: task!.id,
      adopt: true,
    });
    expect(adopted.ok).toBe(true);
    expect(adopted.task?.pages[0]?.documentId).toBe('doc-second');
    await expect(
      manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' }),
    ).resolves.toBeDefined();
  });

  it('records delayed navigation after a successful action and adopts only its observed pending document', async () => {
    const storageDir = testDir('delayed-navigation-adopt');
    let inventoryReads = 0;
    let current = live([tab(500, 'https://search.example/', true, 'doc-0')]);
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(500, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        if (inventoryReads === 1) {
          return live([tab(500, 'https://search.example/', true, 'doc-0')]);
        }
        if (inventoryReads === 2) {
          return live([
            tab(500, 'https://search.example/', true, 'doc-0', 'browser-1', undefined, 'loading'),
          ]);
        }
        if (inventoryReads <= 4) {
          return live([tab(500, 'https://developer.mozilla.org/Fetch_API', true, 'doc-1')]);
        }
        return current;
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Delayed navigation' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://search.example/' });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      await jest.advanceTimersByTimeAsync(150);
      const actionResult = await pendingAction;

      expect(actionResult.isError).toBe(false);
      expect(actionResult.structuredContent).toBeUndefined();
      expect(JSON.parse((actionResult.content[0] as { text: string }).text)).toEqual({
        success: true,
        marker: 'key-delivered',
        receipt,
      });
      expect(inventoryReads).toBe(3);
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);

      const status = await manager.execute({ action: 'status', taskId: task!.id });
      expect(status.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-0',
          pendingDocumentId: 'doc-1',
        }),
      );

      const adopted = await manager.execute({
        action: 'resume',
        taskId: task!.id,
        adopt: true,
      });
      expect(adopted.ok).toBe(true);
      expect(adopted.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-1',
          identityVerified: true,
        }),
      );
      expect(adopted.task?.pages[0]).not.toHaveProperty('pendingDocumentId');

      current = live([tab(500, 'https://unobserved.example/', true, 'doc-2')]);
      const mutationCalls = call.mock.calls.filter(([name]) => name === 'chrome_keyboard').length;
      const blocked = await manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      expect(blocked.structuredContent).toEqual(
        expect.objectContaining({
          status: 'blocked',
          retry: false,
          dispatched: false,
          error: expect.stringContaining('failed browser/document identity verification'),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(
        mutationCalls,
      );

      const unverified = await manager.execute({
        action: 'resume',
        taskId: task!.id,
        adopt: true,
      });
      expect(unverified.ok).toBe(false);
      expect(unverified.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-1',
          identityVerified: false,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not turn committed-document resource loading into an unknown evaluation', async () => {
    let inventoryReads = 0;
    let markAfterRead!: () => void;
    const afterRead = new Promise<void>((resolve) => {
      markAfterRead = resolve;
    });
    const call = jest.fn<BrowserCall>(async (name, args) => {
      if (name === 'chrome_navigate') return opened(509, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        if (inventoryReads === 2) markAfterRead();
        return live([
          {
            ...tab(509, 'https://npm.example/', true, 'doc-0', 'browser-1', undefined, 'loading'),
            pendingUrl: null,
          },
        ]);
      }
      if (name === 'chrome_javascript') return result({ success: true, result: { width: 1440 } });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir: testDir('resource-loading') });
    const { task } = await manager.execute({ action: 'start', name: 'Committed resource loading' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://npm.example/' });
    inventoryReads = 0;
    jest.useFakeTimers();
    try {
      const pending = manager.callTool(task!.id, 'chrome_javascript', {
        code: 'return { width: innerWidth }',
      });
      await afterRead;
      await jest.advanceTimersByTimeAsync(150);
      expect(inventoryReads).toBe(2);
      expect((await pending).isError).toBe(false);
      expect(call.mock.calls.filter(([name]) => name === 'chrome_javascript')).toHaveLength(1);
    } finally {
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it.each([
    { pendingUrl: 'https://pending.example/next', committed: true },
    { pendingUrl: 'https://pending.example/', committed: true },
    { pendingUrl: 'https://pending.example/next', committed: false },
  ])(
    'tracks a pending navigation to $pendingUrl (committed=$committed)',
    async ({ pendingUrl, committed }) => {
      let inventoryReads = 0;
      const call = jest.fn<BrowserCall>(async (name, args) => {
        if (name === 'chrome_navigate') return opened(510, String(args.url));
        if (name === 'get_windows_and_tabs') {
          inventoryReads++;
          return live([
            inventoryReads < 3
              ? {
                  ...tab(
                    510,
                    'https://pending.example/',
                    true,
                    'doc-0',
                    'browser-1',
                    undefined,
                    'loading',
                  ),
                  pendingUrl,
                }
              : {
                  ...tab(
                    510,
                    committed ? pendingUrl : 'https://pending.example/',
                    true,
                    committed ? 'doc-1' : 'doc-0',
                    'browser-1',
                    undefined,
                    'loading',
                  ),
                  pendingUrl: null,
                },
          ]);
        }
        if (name === 'chrome_keyboard') return result({ success: true });
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir: testDir('pending-commit') });
      const { task } = await manager.execute({ action: 'start', name: 'Pending document' });
      await manager.execute({ action: 'open', taskId: task!.id, url: 'https://pending.example/' });
      inventoryReads = 0;
      jest.useFakeTimers();
      try {
        const pending = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
        await jest.advanceTimersByTimeAsync(150);
        expect((await pending).isError).toBe(false);
        expect(inventoryReads).toBe(3);
        const state = await manager.execute({ action: 'status', taskId: task!.id });
        expect(state.task?.pages[0]).toMatchObject({ documentId: 'doc-0' });
        if (committed) expect(state.task?.pages[0]?.pendingDocumentId).toBe('doc-1');
        else expect(state.task?.pages[0]).not.toHaveProperty('pendingDocumentId');
        expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('keeps the existing two inventory reads for a complete action', async () => {
    const storageDir = testDir('complete-action-reads');
    let inventoryReads = 0;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(501, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        return live([tab(501, 'https://complete.example/')]);
      }
      if (name === 'chrome_keyboard') return result({ success: true });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Complete action' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://complete.example/',
    });
    inventoryReads = 0;

    await manager.callTool(task!.id, 'chrome_keyboard', { keys: 'ArrowDown' });

    expect(inventoryReads).toBe(2);
    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages[0]).not.toHaveProperty('pendingDocumentId');
  });

  it('stops a loading-navigation wait on task cancellation without replaying the action', async () => {
    const storageDir = testDir('delayed-navigation-cancel');
    let inventoryReads = 0;
    let markLoadingRead!: () => void;
    const loadingRead = new Promise<void>((resolve) => {
      markLoadingRead = resolve;
    });
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(502, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        const status = inventoryReads === 1 ? 'complete' : 'loading';
        if (inventoryReads === 3) markLoadingRead();
        return live([
          tab(502, 'https://cancel-wait.example/', true, 'doc-0', 'browser-1', undefined, status),
        ]);
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel delayed navigation' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://cancel-wait.example/',
    });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      await jest.advanceTimersByTimeAsync(100);
      await loadingRead;
      await manager.execute({ action: 'cancel', taskId: task!.id });
      await jest.advanceTimersByTimeAsync(100);
      const cancelled = await pendingAction;

      expect(cancelled.isError).toBe(true);
      expect(cancelled.structuredContent).toEqual(
        expect.objectContaining({
          marker: 'key-delivered',
          receipt,
          status: 'cancelled',
          retry: false,
          cancelled: true,
          cancellation: expect.objectContaining({
            reason: 'task',
            retry: false,
          }),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
      expect(inventoryReads).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops a loading-navigation wait on an external AbortSignal', async () => {
    const storageDir = testDir('delayed-navigation-signal');
    let inventoryReads = 0;
    let markLoadingRead!: () => void;
    const loadingRead = new Promise<void>((resolve) => {
      markLoadingRead = resolve;
    });
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(503, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        const status = inventoryReads === 1 ? 'complete' : 'loading';
        if (inventoryReads === 3) markLoadingRead();
        return live([
          tab(503, 'https://signal-wait.example/', true, 'doc-0', 'browser-1', undefined, status),
        ]);
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Signal delayed navigation' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://signal-wait.example/',
    });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const external = new AbortController();
      const addListener = jest.spyOn(external.signal, 'addEventListener');
      const removeListener = jest.spyOn(external.signal, 'removeEventListener');
      const pendingAction = manager.callTool(
        task!.id,
        'chrome_keyboard',
        { keys: 'Enter' },
        undefined,
        external.signal,
      );
      await jest.advanceTimersByTimeAsync(100);
      await loadingRead;
      external.abort();
      await jest.advanceTimersByTimeAsync(100);
      const cancelled = await pendingAction;

      expect(cancelled.isError).toBe(true);
      expect(cancelled.structuredContent).toEqual(
        expect.objectContaining({
          marker: 'key-delivered',
          receipt,
          status: 'cancelled',
          retry: false,
          cancellation: expect.objectContaining({
            reason: 'signal',
            retry: false,
          }),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
      expect(inventoryReads).toBe(3);
      expect(addListener).toHaveBeenCalledTimes(2);
      expect(removeListener).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns explicit unknown without replay after delayed navigation times out', async () => {
    const storageDir = testDir('delayed-navigation-timeout');
    let inventoryReads = 0;
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(504, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        return live([
          tab(
            504,
            'https://timeout.example/',
            true,
            'doc-0',
            'browser-1',
            undefined,
            inventoryReads === 1 ? 'complete' : 'loading',
          ),
        ]);
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Timeout delayed navigation' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://timeout.example/',
    });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      await jest.advanceTimersByTimeAsync(10_050);
      const timedOut = await pendingAction;

      expect(timedOut.isError).toBe(true);
      expect(timedOut.structuredContent).toEqual(
        expect.objectContaining({
          marker: 'key-delivered',
          receipt,
          status: 'unknown',
          outcome: 'unknown',
          retry: false,
          postAction: expect.objectContaining({
            reason: 'navigation_loading_timeout',
            status: 'unknown',
            retry: false,
          }),
        }),
      );
      expect(JSON.parse((timedOut.content[0] as { text: string }).text)).toEqual(
        timedOut.structuredContent,
      );
      expect(timedOut._meta).toEqual(
        expect.objectContaining({
          postAction: expect.objectContaining({
            reason: 'navigation_loading_timeout',
            retry: false,
          }),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);

      const readsAtTimeout = inventoryReads;
      await jest.advanceTimersByTimeAsync(5_000);
      expect(inventoryReads).toBe(readsAtTimeout);
      const status = await manager.execute({ action: 'status', taskId: task!.id });
      expect(status.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-0',
        }),
      );
      expect(status.task?.pages[0]).not.toHaveProperty('pendingDocumentId');
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a stuck inventory read at the delayed-navigation deadline and ignores its late D1 result', async () => {
    const storageDir = testDir('delayed-navigation-stuck-read');
    let inventoryReads = 0;
    let resolveLateInventory!: (value: CallToolResult) => void;
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>((name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return Promise.resolve(opened(505, String(args.url)));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        if (inventoryReads === 1) {
          return Promise.resolve(live([tab(505, 'https://stuck.example/', true, 'doc-0')]));
        }
        if (inventoryReads === 2) {
          return Promise.resolve(
            live([
              tab(505, 'https://stuck.example/', true, 'doc-0', 'browser-1', undefined, 'loading'),
            ]),
          );
        }
        return new Promise<CallToolResult>((resolve) => {
          resolveLateInventory = resolve;
        });
      }
      if (name === 'chrome_keyboard') {
        return Promise.resolve(result({ success: true, marker: 'key-delivered', receipt }));
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Stuck delayed navigation' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://stuck.example/',
    });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      let settled: CallToolResult | undefined;
      void pendingAction.then(
        (value) => {
          settled = value;
        },
        () => undefined,
      );
      await jest.advanceTimersByTimeAsync(10_050);
      await Promise.resolve();
      const settledAtDeadline = Boolean(settled);

      resolveLateInventory(
        live([tab(505, 'https://developer.mozilla.org/Fetch_API', true, 'doc-1')]),
      );
      const timedOut = await pendingAction;

      expect(settledAtDeadline).toBe(true);
      expect(timedOut.isError).toBe(true);
      expect(timedOut.structuredContent).toEqual(
        expect.objectContaining({
          marker: 'key-delivered',
          receipt,
          status: 'unknown',
          outcome: 'unknown',
          retry: false,
          postAction: expect.objectContaining({
            reason: 'navigation_loading_timeout',
            retry: false,
          }),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
      const status = await manager.execute({ action: 'status', taskId: task!.id });
      expect(status.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-0',
        }),
      );
      expect(status.task?.pages[0]).not.toHaveProperty('pendingDocumentId');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'the tab disappears',
      inventory: () => live([]),
    },
    {
      label: 'the browser instance changes',
      inventory: () =>
        live([tab(506, 'https://identity.example/', true, 'doc-0', 'browser-2')], 'browser-2'),
    },
  ])(
    'preserves the action receipt as unknown when $label during delayed navigation polling',
    async ({ inventory: lostInventory }) => {
      const storageDir = testDir('delayed-navigation-identity');
      let inventoryReads = 0;
      const receipt = { hasReceipt: true, action: 'keyboard' };
      const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
        if (name === 'chrome_navigate') return opened(506, String(args.url));
        if (name === 'get_windows_and_tabs') {
          inventoryReads++;
          if (inventoryReads === 1) {
            return live([tab(506, 'https://identity.example/', true, 'doc-0')]);
          }
          if (inventoryReads === 2) {
            return live([
              tab(
                506,
                'https://identity.example/',
                true,
                'doc-0',
                'browser-1',
                undefined,
                'loading',
              ),
            ]);
          }
          return lostInventory();
        }
        if (name === 'chrome_keyboard') {
          return result({ success: true, marker: 'key-delivered', receipt });
        }
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir });
      const { task } = await manager.execute({ action: 'start', name: 'Lost delayed navigation' });
      await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://identity.example/',
      });
      inventoryReads = 0;

      jest.useFakeTimers();
      try {
        const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
        const outcomePromise = pendingAction.then(
          (value) => value,
          (error: Error) => error,
        );
        await jest.advanceTimersByTimeAsync(100);
        const outcome = await outcomePromise;

        expect(outcome).not.toBeInstanceOf(Error);
        expect(outcome).toEqual(
          expect.objectContaining({
            isError: true,
            structuredContent: expect.objectContaining({
              marker: 'key-delivered',
              receipt,
              status: 'unknown',
              outcome: 'unknown',
              retry: false,
              postAction: expect.objectContaining({
                reason: 'navigation_identity_lost',
                retry: false,
              }),
            }),
          }),
        );
        expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
        const status = await manager.execute({ action: 'status', taskId: task!.id });
        expect(status.task?.pages[0]).toEqual(
          expect.objectContaining({
            documentId: 'doc-0',
          }),
        );
        expect(status.task?.pages[0]).not.toHaveProperty('pendingDocumentId');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('preserves the action receipt as unknown when the first post-action inventory read fails', async () => {
    const storageDir = testDir('post-action-inventory-failure');
    let inventory = live([tab(507, 'https://verification.example/', true, 'doc-0')]);
    let inventoryReads = 0;
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(507, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        if (inventoryReads === 2) {
          throw new Error('inventory transport failed after action');
        }
        return inventory;
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({
      action: 'start',
      name: 'Post-action inventory failure',
    });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://verification.example/',
    });
    inventoryReads = 0;

    const outcome = await manager
      .callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' })
      .catch((error: Error) => error);

    expect(outcome).not.toBeInstanceOf(Error);
    expect(outcome).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: expect.objectContaining({
          marker: 'key-delivered',
          receipt,
          status: 'unknown',
          outcome: 'unknown',
          retry: false,
          postAction: expect.objectContaining({
            reason: 'post_action_verification_failed',
            retry: false,
            error: 'inventory transport failed after action',
            message: expect.stringMatching(/preserved.*must not be replayed/i),
          }),
        }),
      }),
    );
    expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
    const beforeAdopt = await manager.execute({ action: 'status', taskId: task!.id });
    expect(beforeAdopt.task?.pages[0]).toEqual(
      expect.objectContaining({
        documentId: 'doc-0',
      }),
    );
    expect(beforeAdopt.task?.pages[0]).not.toHaveProperty('pendingDocumentId');

    inventory = live([tab(507, 'https://unrecorded.example/', true, 'doc-1')]);
    const resume = await manager.execute({ action: 'resume', taskId: task!.id, adopt: true });
    expect(resume.ok).toBe(false);
    expect(resume.task?.pages[0]).toEqual(
      expect.objectContaining({
        documentId: 'doc-0',
        identityVerified: false,
      }),
    );
  });

  it('preserves the action receipt as unknown when delayed-navigation inventory rejects', async () => {
    const storageDir = testDir('delayed-inventory-reject');
    let inventory = live([tab(508, 'https://loading.example/', true, 'doc-0')]);
    let inventoryReads = 0;
    const receipt = { hasReceipt: true, action: 'keyboard' };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(508, String(args.url));
      if (name === 'get_windows_and_tabs') {
        inventoryReads++;
        if (inventoryReads === 2) {
          return live([
            tab(508, 'https://loading.example/', true, 'doc-0', 'browser-1', undefined, 'loading'),
          ]);
        }
        if (inventoryReads === 3) {
          throw new Error('delayed inventory transport failed');
        }
        return inventory;
      }
      if (name === 'chrome_keyboard') {
        return result({ success: true, marker: 'key-delivered', receipt });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({
      action: 'start',
      name: 'Delayed inventory rejection',
    });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://loading.example/',
    });
    inventoryReads = 0;

    jest.useFakeTimers();
    try {
      const pendingAction = manager.callTool(task!.id, 'chrome_keyboard', { keys: 'Enter' });
      const outcomePromise = pendingAction.then(
        (value) => value,
        (error: Error) => error,
      );
      await jest.advanceTimersByTimeAsync(100);
      const outcome = await outcomePromise;

      expect(outcome).not.toBeInstanceOf(Error);
      expect(outcome).toEqual(
        expect.objectContaining({
          isError: true,
          structuredContent: expect.objectContaining({
            marker: 'key-delivered',
            receipt,
            status: 'unknown',
            outcome: 'unknown',
            retry: false,
            postAction: expect.objectContaining({
              reason: 'post_action_verification_failed',
              retry: false,
              error: 'delayed inventory transport failed',
              message: expect.stringMatching(/preserved.*must not be replayed/i),
            }),
          }),
        }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_keyboard')).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);

      const beforeAdopt = await manager.execute({ action: 'status', taskId: task!.id });
      expect(beforeAdopt.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-0',
        }),
      );
      expect(beforeAdopt.task?.pages[0]).not.toHaveProperty('pendingDocumentId');

      inventory = live([tab(508, 'https://unrecorded.example/', true, 'doc-1')]);
      const resume = await manager.execute({ action: 'resume', taskId: task!.id, adopt: true });
      expect(resume.ok).toBe(false);
      expect(resume.task?.pages[0]).toEqual(
        expect.objectContaining({
          documentId: 'doc-0',
          identityVerified: false,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel interrupts future mutations without waiting for another task browser await', async () => {
    const storageDir = testDir('cancel-live');
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(400, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(400, 'https://long-call.example/')]);
      }
      if (name === 'chrome_interact_index') {
        markMutationStarted();
        await mutationGate;
        return result({ success: true, tabId: args.tabId });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel during call' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://long-call.example/' });

    const first = manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    await mutationStarted;
    const cancelled = await manager.execute({ action: 'cancel', taskId: task!.id });
    expect(cancelled.ok).toBe(true);

    const second = manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    releaseMutation();

    const firstResult = await first;
    expect(firstResult.isError).toBe(true);
    expect(firstResult.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        status: 'cancelled',
        retry: false,
        cancelled: true,
        taskStatus: 'cancelled',
      }),
    );
    const secondResult = await second;
    expect(secondResult.structuredContent).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        retry: false,
        cancelled: true,
        cancellation: expect.objectContaining({ requestDispatched: false, reason: 'task' }),
      }),
    );
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  it('returns structured cancellation for an external signal and cleans up its listener', async () => {
    const storageDir = testDir('cancel-signal');
    let interactionCalls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const call = jest.fn<BrowserCall>(
      async (name: string, args: Record<string, unknown>, _sessionId, signal?: AbortSignal) => {
        if (name === 'chrome_navigate') {
          return opened(args.url === 'https://signal-a.example/' ? 410 : 411, String(args.url));
        }
        if (name === 'get_windows_and_tabs') {
          return live([
            tab(410, 'https://signal-a.example/'),
            tab(411, 'https://signal-b.example/'),
          ]);
        }
        if (name === 'chrome_interact_index' && args.tabId === 410 && interactionCalls++ === 0) {
          markStarted();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return result({ success: true, marker: 'completed-after-signal-abort' });
        }
        if (name === 'chrome_interact_index' && args.tabId === 411) {
          return result({ success: true, marker: 'new-task-completed' });
        }
        throw new Error(`unexpected ${name}`);
      },
    );
    const manager = new BrowserTaskManager({ call, storageDir });
    const taskA = (await manager.execute({ action: 'start', name: 'Signal A' })).task!;
    await manager.execute({ action: 'open', taskId: taskA.id, url: 'https://signal-a.example/' });

    const external = new AbortController();
    const addListener = jest.spyOn(external.signal, 'addEventListener');
    const removeListener = jest.spyOn(external.signal, 'removeEventListener');
    const pending = manager.callTool(
      taskA.id,
      'chrome_interact_index',
      { action: 'click' },
      undefined,
      external.signal,
    );
    await started;
    external.abort();

    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        marker: 'completed-after-signal-abort',
        status: 'cancelled',
        retry: false,
        cancelled: true,
        cancellation: expect.objectContaining({
          status: 'cancelled',
          retry: false,
          requestDispatched: true,
          reason: 'signal',
        }),
      }),
    );
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    const taskB = (await manager.execute({ action: 'start', name: 'Signal B' })).task!;
    await manager.execute({ action: 'open', taskId: taskB.id, url: 'https://signal-b.example/' });
    const completed = await manager.callTool(taskB.id, 'chrome_interact_index', {
      action: 'click',
    });
    expect(completed.isError).toBe(false);
    expect(completed.structuredContent).toBeUndefined();
    expect(JSON.parse((completed.content[0] as { text: string }).text)).toEqual({
      success: true,
      marker: 'new-task-completed',
    });
  });

  it('preserves a completed action result when task.cancel wins in flight', async () => {
    const storageDir = testDir('cancel-completed');
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(420, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(420, 'https://completed.example/')]);
      if (name === 'chrome_interact_index') {
        markMutationStarted();
        await mutationGate;
        return result({
          success: true,
          marker: 'mutation-completed',
          receipt: { hasReceipt: true, dialogs: [] },
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel completed' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://completed.example/' });

    const pending = manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    await mutationStarted;
    await manager.execute({ action: 'cancel', taskId: task!.id });
    releaseMutation();

    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        marker: 'mutation-completed',
        receipt: { hasReceipt: true, dialogs: [] },
        status: 'cancelled',
        retry: false,
        cancelled: true,
        taskStatus: 'cancelled',
        cancellation: expect.objectContaining({
          status: 'cancelled',
          retry: false,
          requestDispatched: true,
          reason: 'task',
        }),
      }),
    );

    const callsBeforeLaterAction = call.mock.calls.length;
    const later = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(later.structuredContent).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        retry: false,
        cancelled: true,
        cancellation: expect.objectContaining({ requestDispatched: false, reason: 'task' }),
      }),
    );
    expect(call.mock.calls.length).toBe(callsBeforeLaterAction);
  });

  it('preserves unknown status, retry:false, and the original receipt after cancellation', async () => {
    const storageDir = testDir('cancel-unknown-result');
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const receipt = {
      hasReceipt: true,
      dialogs: [{ type: 'confirm', message: 'Commit?' }],
    };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(430, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(430, 'https://unknown.example/')]);
      if (name === 'chrome_form_pipeline') {
        markMutationStarted();
        await mutationGate;
        return result(
          {
            success: false,
            status: 'unknown',
            retry: false,
            dispatched: false,
            marker: 'unknown-outcome',
            receipt,
          },
          true,
        );
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel unknown result' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://unknown.example/' });

    const pending = manager.callTool(task!.id, 'chrome_form_pipeline', { fields: [] });
    await mutationStarted;
    await manager.execute({ action: 'cancel', taskId: task!.id });
    releaseMutation();

    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'unknown',
        retry: false,
        dispatched: false,
        marker: 'unknown-outcome',
        receipt,
        cancelled: true,
        taskStatus: 'cancelled',
        cancellation: expect.objectContaining({
          requestDispatched: true,
        }),
      }),
    );
    expect(JSON.parse((cancelled.content[0] as { text: string }).text)).toEqual(
      cancelled.structuredContent,
    );
  });

  it('keeps structured status and receipt when a cancelled in-flight call throws', async () => {
    const storageDir = testDir('cancel-unknown-throw');
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    let rejectMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      rejectMutation = resolve;
    });
    const receipt = {
      hasReceipt: true,
      fileChooser: { mode: 'selectSingle', requiresAction: true },
    };
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(440, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(440, 'https://throw.example/')]);
      if (name === 'chrome_batch_actions') {
        markMutationStarted();
        await mutationGate;
        throw Object.assign(new Error('CDP outcome unknown after dispatch'), {
          status: 'unknown',
          retry: false,
          receipt,
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel unknown throw' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://throw.example/' });

    const pending = manager.callTool(task!.id, 'chrome_batch_actions', { actions: [] });
    await mutationStarted;
    await manager.execute({ action: 'cancel', taskId: task!.id });
    rejectMutation();

    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'unknown',
        retry: false,
        receipt,
        error: 'CDP outcome unknown after dispatch',
        cancelled: true,
        taskStatus: 'cancelled',
        cancellation: expect.objectContaining({
          requestDispatched: true,
        }),
      }),
    );
  });

  it('marks a cancelled generic transport throw as unknown instead of claiming no physical action', async () => {
    const storageDir = testDir('cancel-transport-unknown');
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    let rejectMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      rejectMutation = resolve;
    });
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(450, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(450, 'https://transport.example/')]);
      if (name === 'chrome_interact_index') {
        markMutationStarted();
        await mutationGate;
        throw new Error('Native transport closed after request start');
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel transport unknown' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://transport.example/',
    });

    const pending = manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    await mutationStarted;
    await manager.execute({ action: 'cancel', taskId: task!.id });
    rejectMutation();

    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'unknown',
        outcome: 'unknown',
        retry: false,
        cancelled: true,
        taskStatus: 'cancelled',
        cancellation: expect.objectContaining({
          status: 'cancelled',
          retry: false,
          requestDispatched: true,
        }),
      }),
    );
    expect(cancelled.structuredContent).not.toHaveProperty('dispatched');
  });

  it('records a proven new page when cancel wins during navigate and lets finish clean it', async () => {
    const storageDir = testDir('cancel-open-race');
    let resolveNavigation!: () => void;
    let markNavigationStarted!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      markNavigationStarted = resolve;
    });
    const navigationGate = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    let viewportCalls = 0;
    const closed: number[] = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        markNavigationStarted();
        await navigationGate;
        return opened(95, 'https://cancel-open.example/');
      }
      if (name === 'get_windows_and_tabs') {
        return live([tab(95, 'https://cancel-open.example/')]);
      }
      if (name === 'browserpaw_set_owned_viewport') {
        viewportCalls++;
        return viewport();
      }
      if (name === 'chrome_close_tabs') {
        closed.push(...(args.tabIds as number[]));
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel open race' });
    const pendingOpen = manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://cancel-open.example/',
    });
    await navigationStarted;
    const cancelled = await manager.execute({ action: 'cancel', taskId: task!.id });
    expect(cancelled.ok).toBe(true);
    resolveNavigation();

    const openedResult = await pendingOpen;
    expect(openedResult.ok).toBe(false);
    expect(openedResult.dispatched).toBe(true);
    expect(openedResult.created).toEqual(
      expect.objectContaining({ tabId: 95, ownership: 'owned' }),
    );
    expect(openedResult.task?.status).toBe('cancelled');
    expect(openedResult.task?.pages).toEqual([
      expect.objectContaining({ tabId: 95, ownership: 'owned' }),
    ]);
    expect(viewportCalls).toBe(0);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(finished.task?.status).toBe('cancelled');
    expect(closed).toEqual([95]);
  });

  it('does not serialize browser waits across different tasks', async () => {
    const storageDir = testDir('parallel-tasks');
    let releaseA!: () => void;
    let markAStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        const tabId = args.url === 'https://a.example/' ? 501 : 502;
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') {
        return live([tab(501, 'https://a.example/'), tab(502, 'https://b.example/')]);
      }
      if (name === 'chrome_interact_index' && args.tabId === 501) {
        markAStarted();
        await aGate;
        return result({ success: true, tabId: 501 });
      }
      if (name === 'chrome_interact_index' && args.tabId === 502) {
        return result({ success: true, tabId: 502 });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const taskA = (await manager.execute({ action: 'start', name: 'Task A' })).task!;
    const taskB = (await manager.execute({ action: 'start', name: 'Task B' })).task!;
    await manager.execute({ action: 'open', taskId: taskA.id, url: 'https://a.example/' });
    await manager.execute({ action: 'open', taskId: taskB.id, url: 'https://b.example/' });

    const first = manager.callTool(taskA.id, 'chrome_interact_index', { action: 'click' });
    await aStarted;
    const second = manager.callTool(taskB.id, 'chrome_interact_index', { action: 'click' });
    const secondFinishedFirst = await Promise.race([
      second.then(() => true),
      delay(250).then(() => false),
    ]);
    releaseA();

    await expect(first).resolves.toBeDefined();
    expect(secondFinishedFirst).toBe(true);
  });

  it('serializes concurrent mutations and leaves shared storage parseable', async () => {
    const storageDir = testDir('concurrent');
    let nextTabId = 70;
    const openedTabs: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const tabId = nextTabId++;
        openedTabs.push(tab(tabId, String(args.url)));
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return live(openedTabs);
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Concurrent test' });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        manager.execute({ action: 'open', taskId: task!.id, url: `https://race-${i}.example/` }),
      ),
    );
    expect(results.every((item) => item.ok)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(path.join(storageDir, 'tasks.json'), 'utf8'));
    expect(stored.tasks[task!.id].pages).toHaveLength(8);
    expect(new Set(stored.tasks[task!.id].pages.map((p: any) => p.tabId)).size).toBe(8);
  });

  it('closes a proven self-created page and stays restarted-clean when ledger persistence fails', async () => {
    const storageDir = testDir('write-fail');
    const closeCalls: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(80, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(80, 'https://persist-fail.example/')]);
      }
      if (name === 'chrome_close_tabs') {
        closeCalls.push(args);
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Persistence test' });
    const rename = failRenameSequence([
      { contains: '"documentId": "doc-80"', message: 'disk full' },
    ]);
    try {
      const openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://persist-fail.example/',
      });

      expect(openedResult.ok).toBe(false);
      expect(openedResult.task?.pages).toEqual([]);
      expect(openedResult.task?.pendingCreations).toEqual([]);
      expect(openedResult.created).toEqual(
        expect.objectContaining({
          tabId: 80,
          state: 'closed',
          url: 'https://persist-fail.example/',
          documentId: 'doc-80',
          browserInstanceId: 'browser-1',
        }),
      );
      expect(openedResult.dispatched).toBe(true);
      expect(openedResult.error).toContain('persistence failed');
      expect(openedResult.task?.pendingCreations).toEqual([]);
      expect(openedResult.compensation).toEqual({
        status: 'closed',
        tabId: 80,
        documentId: 'doc-80',
        browserInstanceId: 'browser-1',
        ledgerPersisted: true,
      });
      expect(closeCalls).toEqual([
        {
          tabIds: [80],
          expectedTabs: [
            {
              tabId: 80,
              documentId: 'doc-80',
              browserInstanceId: 'browser-1',
            },
          ],
        },
      ]);
    } finally {
      rename.mockRestore();
    }

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const status = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([]);
    expect(status.task?.pendingCreations).toEqual([]);
  });

  it('compensates a viewport persistence failure without closing an existing task page', async () => {
    const storageDir = testDir('viewport-write-fail');
    let nextTabId = 81;
    const inventory: Array<Record<string, unknown>> = [];
    const closeCalls: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        const tabId = nextTabId++;
        inventory.push(tab(tabId, String(args.url)));
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return live(inventory);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closeCalls.push(args);
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Viewport persistence' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://kept.example/' });

    const originalRename = fs.promises.rename.bind(fs.promises);
    let renames = 0;
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      renames++;
      if (renames === 3) throw new Error('viewport disk failure');
      await originalRename(from, to);
    });
    try {
      const openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://viewport-fail.example/',
      });

      expect(openedResult.ok).toBe(false);
      expect(openedResult.error).toContain('viewport capability persistence failed');
      expect(openedResult.compensation).toEqual(
        expect.objectContaining({
          status: 'closed',
          tabId: 82,
          documentId: 'doc-82',
          browserInstanceId: 'browser-1',
          ledgerPersisted: true,
        }),
      );
      expect(openedResult.created).toEqual(expect.objectContaining({ tabId: 82, state: 'closed' }));
      expect(openedResult.task?.pages).toEqual([
        expect.objectContaining({ tabId: 81, ownership: 'owned' }),
      ]);
      expect(openedResult.task?.pendingCreations).toEqual([]);
      expect(closeCalls).toEqual([
        {
          tabIds: [82],
          expectedTabs: [
            {
              tabId: 82,
              documentId: 'doc-82',
              browserInstanceId: 'browser-1',
            },
          ],
        },
      ]);
    } finally {
      rename.mockRestore();
    }

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const status = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([expect.objectContaining({ tabId: 81 })]);
    expect(status.task?.pendingCreations).toEqual([]);
  });

  it('persists a cleanup-pending page when verified compensation fails and recovers it after restart', async () => {
    const storageDir = testDir('cleanup-failure');
    const closed: number[] = [];
    let closeSucceeds = false;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(82, 'https://cleanup-fail.example/');
      if (name === 'get_windows_and_tabs') {
        return live([tab(82, 'https://cleanup-fail.example/')]);
      }
      if (name === 'chrome_close_tabs') {
        if (!closeSucceeds) {
          return result({ success: false, error: 'document identity changed' });
        }
        closed.push(...(args.tabIds as number[]));
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cleanup failure' });
    const rename = failRenameSequence([
      { contains: '"documentId": "doc-82"', message: 'disk full' },
    ]);
    let openedResult: BrowserTaskResult;
    try {
      openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://cleanup-fail.example/',
      });
    } finally {
      rename.mockRestore();
    }

    expect(openedResult.ok).toBe(false);
    expect(openedResult.error).toContain('cleanup did not complete');
    expect(openedResult.task?.pendingCreations).toEqual([]);
    expect(openedResult.compensation).toEqual(
      expect.objectContaining({
        status: 'retained',
        tabId: 82,
        documentId: 'doc-82',
        browserInstanceId: 'browser-1',
        ledgerPersisted: true,
      }),
    );
    expect(openedResult.task?.pages).toEqual([
      expect.objectContaining({
        tabId: 82,
        ownership: 'owned',
        state: 'active',
        recovery: expect.objectContaining({
          status: 'cleanupPending',
          reason: expect.stringContaining('document identity changed'),
        }),
      }),
    ]);

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const recovered = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(recovered.task?.pages).toEqual([
      expect.objectContaining({
        tabId: 82,
        documentId: 'doc-82',
        browserInstanceId: 'browser-1',
        recovery: expect.objectContaining({ status: 'cleanupPending' }),
      }),
    ]);
    expect(recovered.task?.pendingCreations).toEqual([]);

    closeSucceeds = true;
    const finished = await reloaded.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(closed).toEqual([82]);
    expect(finished.task?.pages).toEqual([]);
  });

  it('does not claim a retained page is durable when cleanup and its recovery write both fail', async () => {
    const storageDir = testDir('cleanup-and-ledger-failure');
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(83, 'https://cleanup-unrecoverable.example/');
      if (name === 'get_windows_and_tabs') {
        return live([tab(83, 'https://cleanup-unrecoverable.example/')]);
      }
      if (name === 'chrome_close_tabs') {
        return result({ success: false, error: 'close denied' });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Unrecoverable cleanup' });
    const rename = failRenameSequence([
      { contains: '"documentId": "doc-83"', message: 'disk full' },
      { contains: '"status": "cleanupPending"', message: 'disk still full' },
    ]);
    let openedResult: BrowserTaskResult;
    try {
      openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://cleanup-unrecoverable.example/',
      });
    } finally {
      rename.mockRestore();
    }

    expect(openedResult.ok).toBe(false);
    expect(openedResult.compensation).toEqual({
      status: 'retained',
      tabId: 83,
      documentId: 'doc-83',
      browserInstanceId: 'browser-1',
      ledgerPersisted: false,
      error: 'close denied',
    });
    expect(openedResult.error).toContain(
      'neither cleanup nor its recovery record could be persisted',
    );
    expect(openedResult.task?.pendingCreations).toEqual([]);
    expect(openedResult.task?.pages).toEqual([
      expect.objectContaining({
        tabId: 83,
        recovery: expect.objectContaining({ status: 'cleanupPending', reason: 'close denied' }),
      }),
    ]);

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const status = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages).toEqual([]);
    expect(status.task?.pendingCreations).toHaveLength(1);
  });

  it('does not close or adopt a page when navigation changes its identity during compensation', async () => {
    const storageDir = testDir('navigation-conflict');
    let current = live([tab(84, 'https://before-navigation.example/', true, 'doc-84')]);
    const closeCalls: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        current = live([tab(84, 'https://before-navigation.example/', true, 'doc-84')]);
        return opened(84, 'https://before-navigation.example/');
      }
      if (name === 'get_windows_and_tabs') return current;
      if (name === 'chrome_close_tabs') {
        closeCalls.push(args);
        current = live([tab(84, 'https://after-navigation.example/', true, 'doc-after')]);
        return result({
          success: false,
          error: 'Refusing to close tab 84: document identity changed',
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Navigation conflict' });
    current = live([tab(84, 'https://after-navigation.example/', true, 'doc-after')]);
    const rename = failRenameSequence([
      { contains: '"documentId": "doc-84"', message: 'disk full' },
    ]);
    let openedResult: BrowserTaskResult;
    try {
      openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://before-navigation.example/',
      });
    } finally {
      rename.mockRestore();
    }

    expect(openedResult.ok).toBe(false);
    expect(openedResult.compensation).toEqual(
      expect.objectContaining({
        status: 'retained',
        tabId: 84,
        documentId: 'doc-84',
        browserInstanceId: 'browser-1',
        ledgerPersisted: true,
      }),
    );
    expect(closeCalls).toEqual([
      {
        tabIds: [84],
        expectedTabs: [
          {
            tabId: 84,
            documentId: 'doc-84',
            browserInstanceId: 'browser-1',
          },
        ],
      },
    ]);

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const resumed = await reloaded.execute({ action: 'resume', taskId: task!.id });
    expect(resumed.ok).toBe(false);
    expect(resumed.task?.pages[0]).toEqual(
      expect.objectContaining({
        tabId: 84,
        documentId: 'doc-84',
        exists: true,
        identityVerified: false,
        recovery: expect.objectContaining({ status: 'cleanupPending' }),
      }),
    );
    expect(resumed.task?.pendingCreations).toEqual([]);
  });

  it('finishes failed-open compensation before takeover and never closes an existing task page', async () => {
    const storageDir = testDir('takeover-conflict');
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let nextTabId = 84;
    const inventory: Array<Record<string, unknown>> = [];
    const closeCalls: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        const tabId = nextTabId++;
        inventory.push(tab(tabId, String(args.url)));
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return live(inventory);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closeCalls.push(args);
        markCloseStarted();
        await closeGate;
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute(
      { action: 'start', name: 'Takeover conflict' },
      'session-a',
    );
    await manager.execute(
      { action: 'open', taskId: task!.id, url: 'https://existing.example/' },
      'session-a',
    );

    const rename = failRenameSequence([
      { contains: '"documentId": "doc-85"', message: 'disk full' },
    ]);
    let failedOpen: Promise<BrowserTaskResult>;
    try {
      failedOpen = manager.execute(
        { action: 'open', taskId: task!.id, url: 'https://failed-open.example/' },
        'session-a',
      );
      await closeStarted;
    } finally {
      rename.mockRestore();
    }
    let takeoverAcknowledged = false;
    const takeover = manager
      .execute({ action: 'takeOver', taskId: task!.id, confirm: true }, 'session-b')
      .then((value) => {
        takeoverAcknowledged = true;
        return value;
      });
    await delay(100);
    expect(takeoverAcknowledged).toBe(false);
    releaseClose();

    const openedResult = await failedOpen;
    const takenOver = await takeover;
    expect(openedResult.ok).toBe(false);
    expect(openedResult.task?.pages).toEqual([
      expect.objectContaining({ tabId: 84, ownership: 'owned' }),
    ]);
    expect(takenOver.ok).toBe(true);
    expect(closeCalls).toEqual([
      {
        tabIds: [85],
        expectedTabs: [
          {
            tabId: 85,
            documentId: 'doc-85',
            browserInstanceId: 'browser-1',
          },
        ],
      },
    ]);
    const status = await manager.execute({ action: 'status', taskId: task!.id }, 'session-b');
    expect(status.task?.pages).toEqual([expect.objectContaining({ tabId: 84 })]);
    expect(status.task?.pendingCreations).toEqual([]);
  });

  it('closes only the concurrently failed open page and leaves other task pages intact', async () => {
    const storageDir = testDir('concurrent-failed-open');
    const inventory: Array<Record<string, unknown>> = [];
    const closeCalls: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        const tabId = String(args.url).includes('task-a') ? 86 : 87;
        inventory.push(tab(tabId, String(args.url)));
        return opened(tabId, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return live(inventory);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closeCalls.push(args);
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const taskA = (await manager.execute({ action: 'start', name: 'Task A' })).task!;
    const taskB = (await manager.execute({ action: 'start', name: 'Task B' })).task!;

    const rename = failRenameSequence([
      { contains: '"documentId": "doc-86"', message: 'disk full' },
    ]);
    let results: BrowserTaskResult[];
    try {
      results = await Promise.all([
        manager.execute({ action: 'open', taskId: taskA.id, url: 'https://task-a.example/' }),
        manager.execute({ action: 'open', taskId: taskB.id, url: 'https://task-b.example/' }),
      ]);
    } finally {
      rename.mockRestore();
    }

    expect(results[0].ok).toBe(false);
    expect(results[0].compensation).toEqual(
      expect.objectContaining({ status: 'closed', tabId: 86 }),
    );
    expect(results[0].created).toEqual(expect.objectContaining({ tabId: 86, state: 'closed' }));
    expect(results[1].ok).toBe(true);
    expect(results[0].task?.pendingCreations).toEqual([]);
    expect(closeCalls).toEqual([
      {
        tabIds: [86],
        expectedTabs: [
          {
            tabId: 86,
            documentId: 'doc-86',
            browserInstanceId: 'browser-1',
          },
        ],
      },
    ]);
    expect(closeCalls[0].expectedTabs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tabId: 10 })]),
    );

    const reloaded = new BrowserTaskManager({ call, storageDir });
    expect((await reloaded.execute({ action: 'status', taskId: taskA.id })).task?.pages).toEqual(
      [],
    );
    expect(
      (await reloaded.execute({ action: 'status', taskId: taskA.id })).task?.pendingCreations,
    ).toEqual([]);
    expect((await reloaded.execute({ action: 'status', taskId: taskB.id })).task?.pages).toEqual([
      expect.objectContaining({ tabId: 87 }),
    ]);
  });

  it.each(['throw', 'missing-document'] as const)(
    'retains a created-page receipt when inventory verification fails (%s)',
    async (mode) => {
      const storageDir = testDir(`pending-creation-${mode}`);
      const destructiveCalls: string[] = [];
      let inventoryCalls = 0;
      const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
        if (name === 'chrome_navigate') return opened(120, 'https://pending.example/');
        if (name === 'get_windows_and_tabs') {
          inventoryCalls++;
          if (inventoryCalls === 1) {
            if (mode === 'throw') throw new Error('inventory unavailable');
            return result({
              browserInstanceId: 'browser-1',
              windowCount: 1,
              tabCount: 1,
              windows: [
                {
                  windowId: 1,
                  tabs: [{ tabId: 120, url: 'https://pending.example/', isAgentManaged: true }],
                },
              ],
            });
          }
          return live([tab(120, 'https://pending.example/')]);
        }
        if (name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page') {
          destructiveCalls.push(name);
          return result({ success: true, closedTabIds: args.tabIds });
        }
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir });
      const { task } = await manager.execute({ action: 'start', name: 'Pending creation' });

      const openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://pending.example/',
      });
      const receipt = {
        tabId: 120,
        windowId: 1,
        requestedUrl: 'https://pending.example/',
        createdAt: expect.any(Number),
        reason: expect.any(String),
      };
      expect(openedResult.ok).toBe(false);
      expect(openedResult.dispatched).toBe(true);
      expect(openedResult.ledgerPersisted).toBe(true);
      expect(openedResult.pendingCreation).toEqual(receipt);
      expect(openedResult.task?.pages).toEqual([]);
      expect(openedResult.task?.pendingCreations).toEqual([receipt]);

      const restarted = new BrowserTaskManager({ call, storageDir });
      const recovered = await restarted.execute({ action: 'status', taskId: task!.id });
      expect(recovered.task?.pendingCreations).toEqual([receipt]);
      const listed = await restarted.execute({ action: 'list' });
      expect(listed.tasks).toEqual([
        expect.objectContaining({ id: task!.id, pendingCreations: [receipt] }),
      ]);

      const navigations = call.mock.calls.filter(([name]) => name === 'chrome_navigate').length;
      const blockedOpen = await restarted.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://blocked.example/',
      });
      expect(blockedOpen.ok).toBe(false);
      expect(blockedOpen.error).toMatch(/pending|unresolved/i);
      expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(
        navigations,
      );

      const finished = await restarted.execute({ action: 'finish', taskId: task!.id });
      expect(finished.ok).toBe(false);
      expect(finished.status).toBe('unverified');
      expect(finished.retry).toBe(false);
      expect(finished.dispatched).toBe(false);
      expect(finished.error).toMatch(/pending|unresolved/i);
      expect(finished.task?.status).toBe('active');
      expect(finished.task?.pendingCreations).toEqual([receipt]);
      expect(destructiveCalls).toEqual([]);
    },
  );

  it('allows finish to clear a pending creation only after the created tab is gone', async () => {
    const storageDir = testDir('pending-creation-gone');
    const destructiveCalls: string[] = [];
    let inventoryCalls = 0;
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(121, 'https://pending-gone.example/');
      if (name === 'get_windows_and_tabs') {
        inventoryCalls++;
        return inventoryCalls === 1
          ? result({
              browserInstanceId: 'browser-1',
              windowCount: 1,
              tabCount: 1,
              windows: [
                {
                  windowId: 1,
                  tabs: [
                    { tabId: 121, url: 'https://pending-gone.example/', isAgentManaged: true },
                  ],
                },
              ],
            })
          : live();
      }
      if (name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page') {
        destructiveCalls.push(name);
        return result({ success: true });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Pending creation gone' });
    const openedResult = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://pending-gone.example/',
    });
    expect(openedResult.task?.pendingCreations).toHaveLength(1);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(finished.task?.status).toBe('finished');
    expect(finished.task?.pendingCreations).toEqual([]);
    expect(destructiveCalls).toEqual([]);

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const status = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.status).toBe('finished');
    expect(status.task?.pendingCreations).toEqual([]);
  });

  it('adopts a delayed-identity pending creation through resume and completes normal cleanup', async () => {
    const storageDir = testDir('pending-creation-adopt');
    let inventoryCalls = 0;
    const closed: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(123, 'https://late-identity.example/start');
      if (name === 'get_windows_and_tabs') {
        inventoryCalls++;
        return inventoryCalls === 1
          ? result({
              browserInstanceId: 'browser-1',
              windowCount: 1,
              tabCount: 1,
              windows: [
                {
                  windowId: 1,
                  tabs: [
                    {
                      tabId: 123,
                      url: 'https://late-identity.example/final',
                      isAgentManaged: true,
                    },
                  ],
                },
              ],
            })
          : live([tab(123, 'https://late-identity.example/final', true, 'doc-late-123')]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_close_tabs') {
        closed.push(args);
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Late identity' });

    const openedResult = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://late-identity.example/start',
    });
    expect(openedResult.ok).toBe(false);
    expect(openedResult.task?.pages).toEqual([]);
    expect(openedResult.task?.pendingCreations).toHaveLength(1);

    const resumed = await manager.execute({
      action: 'resume',
      taskId: task!.id,
      adopt: true,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.task?.pendingCreations).toEqual([]);
    expect(resumed.task?.pages).toEqual([
      expect.objectContaining({
        tabId: 123,
        documentId: 'doc-late-123',
        url: 'https://late-identity.example/final',
        ownership: 'owned',
        state: 'active',
        exists: true,
        identityVerified: true,
      }),
    ]);

    const finished = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(finished.ok).toBe(true);
    expect(closed).toEqual([
      {
        tabIds: [123],
        expectedTabs: [
          {
            tabId: 123,
            documentId: 'doc-late-123',
            browserInstanceId: 'browser-1',
          },
        ],
      },
    ]);
    expect(finished.task?.status).toBe('finished');
  });

  it('does not silently adopt a late pending identity without explicit resume adopt', async () => {
    const storageDir = testDir('pending-creation-no-implicit-adopt');
    let inventoryCalls = 0;
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(124, 'https://explicit-adopt.example/');
      if (name === 'get_windows_and_tabs') {
        inventoryCalls++;
        return inventoryCalls === 1
          ? result({
              browserInstanceId: 'browser-1',
              windowCount: 1,
              tabCount: 1,
              windows: [
                {
                  windowId: 1,
                  tabs: [
                    { tabId: 124, url: 'https://explicit-adopt.example/', isAgentManaged: true },
                  ],
                },
              ],
            })
          : live([tab(124, 'https://explicit-adopt.example/', true, 'doc-explicit-124')]);
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Explicit adopt' });
    const openedResult = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://explicit-adopt.example/',
    });
    expect(openedResult.task?.pendingCreations).toHaveLength(1);

    const resumed = await manager.execute({ action: 'resume', taskId: task!.id });
    expect(resumed.ok).toBe(false);
    expect(resumed.task?.pages).toEqual([]);
    expect(resumed.task?.pendingCreations).toHaveLength(1);
    expect(resumed.error).toMatch(/resume.*adopt|pending/i);
  });

  it('retains a known pending tab only through explicit finish confirmation without closing it', async () => {
    const storageDir = testDir('pending-creation-explicit-retain');
    let inventoryCalls = 0;
    const destructiveCalls: string[] = [];
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(125, 'https://retain-pending.example/');
      if (name === 'get_windows_and_tabs') {
        inventoryCalls++;
        return result({
          browserInstanceId: 'browser-1',
          windowCount: 1,
          tabCount: 1,
          windows: [
            {
              windowId: 1,
              tabs: [{ tabId: 125, url: 'https://retain-pending.example/', isAgentManaged: true }],
            },
          ],
        });
      }
      if (name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page') {
        destructiveCalls.push(name);
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Retain pending' });
    const openedResult = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://retain-pending.example/',
    });
    expect(openedResult.task?.pendingCreations).toHaveLength(1);

    const refused = await manager.execute({ action: 'finish', taskId: task!.id });
    expect(refused.ok).toBe(false);
    expect(destructiveCalls).toEqual([]);

    const retained = await manager.execute({
      action: 'finish',
      taskId: task!.id,
      keepUnknownPages: true,
      confirm: true,
    });
    expect(retained.ok).toBe(true);
    expect(retained.task?.status).toBe('finished');
    expect(retained.task?.pendingCreations).toEqual([
      expect.objectContaining({ tabId: 125, retained: true }),
    ]);
    expect(retained.handedOverUnknown).toEqual([
      expect.objectContaining({ tabId: 125, retained: true }),
    ]);
    expect(destructiveCalls).toEqual([]);
  });

  it('reports an unpersisted pending creation and does not continue browser verification', async () => {
    const storageDir = testDir('pending-creation-write-fail');
    let inventoryCalls = 0;
    let closeCalls = 0;
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') return opened(122, 'https://pending-write-fail.example/');
      if (name === 'get_windows_and_tabs') {
        inventoryCalls++;
        return live([tab(122, 'https://pending-write-fail.example/')]);
      }
      if (name === 'chrome_close_tabs') {
        closeCalls++;
        return result({ success: true, closedTabIds: [122] });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Pending write failure' });
    const rename = failRenameSequence([
      { contains: '"requestedUrl": "https://pending-write-fail.example/"', message: 'disk full' },
    ]);
    let openedResult: BrowserTaskResult;
    try {
      openedResult = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://pending-write-fail.example/',
      });
    } finally {
      rename.mockRestore();
    }

    expect(openedResult.ok).toBe(false);
    expect(openedResult.dispatched).toBe(true);
    expect(openedResult.ledgerPersisted).toBe(false);
    expect(openedResult.pendingCreation).toEqual(
      expect.objectContaining({
        tabId: 122,
        windowId: 1,
        requestedUrl: 'https://pending-write-fail.example/',
      }),
    );
    expect(openedResult.task?.pendingCreations).toEqual([openedResult.pendingCreation]);
    expect(openedResult.error).toContain('pending creation receipt could not be persisted');
    expect(inventoryCalls).toBe(0);
    expect(closeCalls).toBe(0);

    const reloaded = new BrowserTaskManager({ call, storageDir });
    const status = await reloaded.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pendingCreations).toEqual([]);
  });

  it('cancel blocks every later mutation and never claims a rollback', async () => {
    const storageDir = testDir('cancel');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(90, String(args.url));
      if (name === 'chrome_close_tabs') {
        return result({ success: true, closedTabIds: args.tabIds });
      }
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancel test' });
    await manager.execute({ action: 'open', taskId: task!.id, url: 'https://cancel.example/' });

    const cancelled = await manager.execute({ action: 'cancel', taskId: task!.id });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.task?.status).toBe('cancelled');
    expect(cancelled.message).toContain('not rolled back');

    const later = await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://after-cancel.example/',
    });
    expect(later.ok).toBe(false);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(1);
  });

  it('cancels an unstarted request without cancelling its durable task', async () => {
    const storageDir = testDir('request-abort');
    const call = jest.fn<BrowserCall>();
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Recoverable' }, 'owner');
    const controller = new AbortController();
    controller.abort();
    const response = await (manager.execute as (...args: any[]) => Promise<BrowserTaskResult>)(
      { action: 'open', taskId: task!.id, url: 'https://example.com/' },
      'owner',
      controller.signal,
    );
    expect(response).toMatchObject({
      ok: false,
      status: 'cancelled',
      retry: false,
      dispatched: false,
    });
    expect(call).not.toHaveBeenCalled();
    const restored = new BrowserTaskManager({ call, storageDir });
    expect(
      (await restored.execute({ action: 'status', taskId: task!.id }, 'owner')).task?.status,
    ).toBe('active');
    expect(
      (await restored.execute({ action: 'cancel', taskId: task!.id }, 'owner')).task?.status,
    ).toBe('cancelled');
  });

  it('records a page created before request cancellation and skips later viewport mutation', async () => {
    const storageDir = testDir('request-abort-after-create');
    const controller = new AbortController();
    const pages: Array<Record<string, unknown>> = [];
    const call = jest.fn<BrowserCall>().mockImplementation(async (name, args) => {
      if (name === 'get_windows_and_tabs') return live(pages);
      if (name === 'chrome_navigate') {
        pages.push(tab(35, String(args.url)));
        controller.abort();
        return result({ success: true, created: true, tabId: 35 });
      }
      if (name === 'chrome_close_tabs') {
        pages.length = 0;
        return result({ success: true, closedTabIds: [35] });
      }
      return viewport();
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Interrupted open' }, 'owner');
    const response = await (manager.execute as (...args: any[]) => Promise<BrowserTaskResult>)(
      { action: 'open', taskId: task!.id, url: 'https://example.com/' },
      'owner',
      controller.signal,
    );
    expect(response).toMatchObject({
      ok: false,
      status: 'cancelled',
      dispatched: true,
      task: { status: 'active' },
    });
    expect(response.task?.pages).toMatchObject([{ tabId: 35, documentId: 'doc-35' }]);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(1);
    expect(
      call.mock.calls.filter(([name]) => name === 'browserpaw_set_owned_viewport'),
    ).toHaveLength(0);
    const restored = new BrowserTaskManager({ call, storageDir });
    expect((await restored.execute({ action: 'resume', taskId: task!.id }, 'owner')).ok).toBe(true);
    expect((await restored.execute({ action: 'finish', taskId: task!.id }, 'owner')).ok).toBe(true);
    expect(pages).toHaveLength(0);
  });

  it('lists and reports status without making browser calls', async () => {
    const storageDir = testDir('list');
    const call = jest.fn<BrowserCall>();
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'List test' });

    const listed = await manager.execute({ action: 'list' });
    const status = await manager.execute({ action: 'status', taskId: task!.id });

    expect(listed.tasks).toHaveLength(1);
    expect(status.task?.status).toBe('active');
    expect(call).not.toHaveBeenCalled();
  });

  it('persists completed handoffs before a finish request is cancelled', async () => {
    const storageDir = testDir('request-abort-finish');
    const controller = new AbortController();
    const pages: Array<Record<string, unknown>> = [];
    let nextTab = 31;
    const call = jest.fn<BrowserCall>().mockImplementation(async (name, args) => {
      if (name === 'get_windows_and_tabs') return live(pages);
      if (name === 'chrome_navigate') {
        const tabId = nextTab++;
        pages.push(tab(tabId, String(args.url)));
        return result({ success: true, created: true, tabId });
      }
      if (name === 'browserpaw_release_owned_page') {
        pages.find((page) => page.tabId === args.tabId)!.isAgentManaged = false;
        controller.abort();
        return result({ success: true });
      }
      if (name === 'chrome_close_tabs') {
        const ids = args.tabIds as number[];
        for (let i = pages.length - 1; i >= 0; i--)
          if (ids.includes(pages[i].tabId as number)) pages.splice(i, 1);
        return result({ success: true, closedTabIds: ids });
      }
      return viewport();
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Partial cleanup' }, 'owner');
    for (let i = 0; i < 3; i++)
      await manager.execute(
        { action: 'open', taskId: task!.id, url: `https://example.com/${i}` },
        'owner',
      );
    const response = await manager.execute(
      { action: 'finish', taskId: task!.id, keep: [31, 32] },
      'owner',
      controller.signal,
    );
    expect(response).toMatchObject({
      ok: false,
      status: 'cancelled',
      dispatched: true,
      completedActions: 1,
      task: { status: 'active' },
    });
    expect(
      call.mock.calls.filter(([name]) => name === 'browserpaw_release_owned_page'),
    ).toHaveLength(1);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(0);
    const restored = new BrowserTaskManager({ call, storageDir });
    const status = await restored.execute({ action: 'status', taskId: task!.id }, 'owner');
    expect(status.task?.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: 31, ownership: 'user', state: 'handedOff' }),
        expect.objectContaining({ tabId: 32, ownership: 'owned', state: 'active' }),
      ]),
    );
    expect((await restored.execute({ action: 'finish', taskId: task!.id }, 'owner')).ok).toBe(true);
    expect(pages.map((page) => page.tabId)).toEqual([31]);
    expect(call.mock.calls.find(([name]) => name === 'chrome_close_tabs')?.[1].tabIds).toEqual([
      32, 33,
    ]);
  });

  it('binds a durable task to its MCP session principal', async () => {
    const storageDir = testDir('session-owner');
    const call = jest.fn<BrowserCall>();
    const first = new BrowserTaskManager({ call, storageDir });
    const second = new BrowserTaskManager({ call, storageDir });
    const started = await first.execute({ action: 'start', name: 'Owner only' }, 'session-a');
    const taskId = started.task!.id;

    expect((await second.execute({ action: 'list' }, 'session-b')).tasks).toEqual([]);
    expect((await second.execute({ action: 'status', taskId }, 'session-b')).ok).toBe(false);
    expect((await second.execute({ action: 'cancel', taskId }, 'session-b')).ok).toBe(false);
    expect((await second.execute({ action: 'takeOver', taskId }, 'session-b')).ok).toBe(false);
    expect(
      (await second.execute({ action: 'takeOver', taskId, confirm: true }, 'session-b')).ok,
    ).toBe(true);
    const reloaded = new BrowserTaskManager({ call, storageDir });
    expect((await reloaded.execute({ action: 'status', taskId }, 'session-a')).ok).toBe(false);
    expect((await reloaded.execute({ action: 'status', taskId }, 'session-b')).ok).toBe(true);
    expect((await second.execute({ action: 'cancel', taskId }, 'session-b')).ok).toBe(true);
  });

  it('acknowledges takeover only after the old session call finishes its bookkeeping', async () => {
    const storageDir = testDir('takeover-in-flight');
    let release!: () => void;
    let dispatched!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let mutations = 0;
    const call: BrowserCall = async (name, args) => {
      if (name === 'chrome_navigate') return opened(91, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(91, 'https://takeover.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_interact_index') {
        mutations++;
        dispatched();
        await gate;
        return result({ success: true, receipt: { marker: 'issued-before-takeover' } });
      }
      throw new Error(`unexpected ${name}`);
    };
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute(
      { action: 'start', name: 'In-flight takeover' },
      'session-a',
    );
    await manager.execute(
      { action: 'open', taskId: task!.id, url: 'https://takeover.example/' },
      'session-a',
    );
    const oldCall = manager.callTool(
      task!.id,
      'chrome_interact_index',
      { action: 'click' },
      'session-a',
    );
    await entered;
    let acknowledged = false;
    const takeover = manager
      .execute({ action: 'takeOver', taskId: task!.id, confirm: true }, 'session-b')
      .then((value) => {
        acknowledged = true;
        return value;
      });
    let premature;
    try {
      await Promise.race([takeover, new Promise((resolve) => setTimeout(resolve, 150))]);
      premature = acknowledged;
    } finally {
      release();
    }
    const completed = await oldCall;
    expect((await takeover).ok).toBe(true);
    expect(premature).toBe(false);
    expect(completed.isError).not.toBe(true);
    expect((await manager.execute({ action: 'status', taskId: task!.id }, 'session-b')).ok).toBe(
      true,
    );
    await expect(
      manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' }, 'session-a'),
    ).rejects.toThrow(/session/i);
    expect(mutations).toBe(1);
  });

  it('refuses to report finish or handoff before an owned navigation is adopted', async () => {
    let documentId = 'doc-92';
    const call = jest.fn<BrowserCall>(async (name, args) => {
      if (name === 'chrome_navigate') return opened(92, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(92, 'https://navigation.example/', true, documentId)]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_keyboard') {
        documentId = 'next-document';
        return result({ success: true });
      }
      if (name === 'chrome_close_tabs') return result({ success: true, closedTabIds: args.tabIds });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({
      call,
      storageDir: testDir('finish-pending-document'),
    });
    const task = (await manager.execute({ action: 'start', name: 'Navigate before finish' })).task!;
    await manager.execute({ action: 'open', taskId: task.id, url: 'https://navigation.example/' });
    await manager.callTool(task.id, 'chrome_keyboard', { keys: 'ENTER' });

    const refused = await manager.execute({ action: 'finish', taskId: task.id });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/identity|document/i);
    expect(refused.status).toBe('unverified');
    expect(refused.retry).toBe(false);
    expect(refused.dispatched).toBe(false);
    expect(refused.task?.status).toBe('active');
    expect(refused.task?.pages[0]).toMatchObject({
      ownership: 'owned',
      state: 'active',
      pendingDocumentId: documentId,
    });
    expect(
      call.mock.calls.filter(
        ([name]) => name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page',
      ),
    ).toHaveLength(0);

    expect((await manager.execute({ action: 'resume', taskId: task.id, adopt: true })).ok).toBe(
      true,
    );
    expect((await manager.execute({ action: 'finish', taskId: task.id })).ok).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(1);
  });

  it('keeps cancelled mixed-identity pages untouched until the unresolved page is gone', async () => {
    let tabs = [tab(93, 'https://pending.example/'), tab(94, 'https://verified.example/')];
    const call = jest.fn<BrowserCall>(async (name, args) => {
      if (name === 'chrome_navigate')
        return opened(String(args.url).includes('pending') ? 93 : 94, String(args.url));
      if (name === 'get_windows_and_tabs') return live(tabs);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_keyboard') {
        tabs[0] = { ...tabs[0], documentId: 'pending-document' };
        return result({ success: true });
      }
      if (name === 'chrome_close_tabs') return result({ success: true, closedTabIds: args.tabIds });
      throw new Error(`unexpected ${name}`);
    });
    const manager = new BrowserTaskManager({
      call,
      storageDir: testDir('cancelled-mixed-cleanup'),
    });
    const task = (await manager.execute({ action: 'start', name: 'Cancelled cleanup' })).task!;
    await manager.execute({ action: 'open', taskId: task.id, url: tabs[0].url });
    await manager.execute({ action: 'open', taskId: task.id, url: tabs[1].url });
    await manager.callTool(task.id, 'chrome_keyboard', { tabId: 93, keys: 'ENTER' });
    await manager.execute({ action: 'cancel', taskId: task.id });

    const refused = await manager.execute({ action: 'finish', taskId: task.id });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/cancelled/i);
    expect(refused.error).not.toMatch(/resume/);
    expect(refused.task?.status).toBe('cancelled');
    expect(
      refused.task?.pages.every((page) => page.ownership === 'owned' && page.state === 'active'),
    ).toBe(true);
    expect(
      call.mock.calls.some(
        ([name]) => name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page',
      ),
    ).toBe(false);
    expect((await manager.execute({ action: 'resume', taskId: task.id, adopt: true })).ok).toBe(
      false,
    );

    tabs = tabs.filter((page) => page.tabId !== 93);
    const cleaned = await manager.execute({ action: 'finish', taskId: task.id });
    expect(cleaned.ok).toBe(true);
    expect(cleaned.task?.status).toBe('cancelled');
    expect(cleaned.task?.pages).toHaveLength(0);
    expect(
      call.mock.calls
        .filter(([name]) => name === 'chrome_close_tabs')
        .map(([, args]) => args.tabIds),
    ).toEqual([[94]]);
  });

  it('returns blocked status when pre-action inventory fails and does not dispatch the action', async () => {
    const storageDir = testDir('inventory-timeout');
    let actionPhase = false;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(61, String(args.url));
      if (name === 'get_windows_and_tabs') {
        if (actionPhase) {
          throw Object.assign(new Error('Request timed out after 5ms'), {
            requestDispatched: true,
          });
        }
        return live([tab(61, 'https://inventory-timeout.example/')]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_interact_index') return result({ success: true });
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Inventory timeout' });
    expect(
      (
        await manager.execute({
          action: 'open',
          taskId: task!.id,
          url: 'https://inventory-timeout.example/',
        })
      ).ok,
    ).toBe(true);
    actionPhase = true;

    const blocked = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        error: 'Request timed out after 5ms',
      }),
    );
    expect(blocked.structuredContent).not.toHaveProperty('outcome');
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(0);
  });

  it('returns structured cancellation for an already cancelled task without calling the extension', async () => {
    const storageDir = testDir('cancelled-entry');
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(62, String(args.url));
      if (name === 'get_windows_and_tabs')
        return live([tab(62, 'https://cancelled-entry.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Cancelled entry' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://cancelled-entry.example/',
    });
    await manager.execute({ action: 'cancel', taskId: task!.id });
    const callsAfterCancel = call.mock.calls.length;

    const cancelled = await manager.callTool(task!.id, 'chrome_interact_index', {
      action: 'click',
    });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        retry: false,
        cancelled: true,
        taskStatus: 'cancelled',
        cancellation: expect.objectContaining({
          requestDispatched: false,
          reason: 'task',
        }),
      }),
    );
    expect(call.mock.calls.length).toBe(callsAfterCancel);

    await expect(manager.callTool('missing-task', 'chrome_interact_index', {})).rejects.toThrow(
      'Unknown task',
    );
    const finished = await manager.execute({ action: 'start', name: 'Finished ordinary error' });
    expect((await manager.execute({ action: 'finish', taskId: finished.task!.id })).ok).toBe(true);
    const callsAfterFinish = call.mock.calls.length;
    await expect(
      manager.callTool(finished.task!.id, 'chrome_interact_index', { action: 'click' }),
    ).rejects.toThrow('finished');
    expect(call.mock.calls.length).toBe(callsAfterFinish);
  });

  it('preserves one action delivery as unknown unless transport proves it was not sent', async () => {
    const storageDir = testDir('action-transport');
    const receipt = { hasReceipt: true, marker: 'click-maybe' };
    const image = { type: 'image' as const, data: 'aaaa', mimeType: 'image/png' };
    let mode: 'timeout' | 'not-sent' | 'pre-send-cancel' | 'explicit-failed' = 'timeout';
    const external = new AbortController();
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(63, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(63, 'https://transport-action.example/')]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_interact_index') {
        if (mode === 'explicit-failed') {
          const failed = result(
            {
              success: false,
              status: 'failed',
              retry: true,
              receipt,
              error: 'extension failed',
            },
            true,
          );
          failed.content.push(image);
          throw Object.assign(new Error('socket dropped after response'), {
            requestDispatched: true,
            result: failed,
          });
        }
        if (mode === 'pre-send-cancel') {
          external.abort();
          throw Object.assign(new Error('bridge reset before write'), { requestDispatched: false });
        }
        const failure = result(
          {
            success: false,
            receipt,
            tabId: args.tabId,
            error: 'delivery lost',
          },
          true,
        );
        failure.content.push(image);
        throw Object.assign(new Error('Request timed out after 5ms'), {
          requestDispatched: mode === 'timeout',
          result: failure,
        });
      }
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Action transport' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://transport-action.example/',
    });

    const timedOut = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'unknown',
        outcome: 'unknown',
        retry: false,
        receipt,
        error: 'delivery lost',
      }),
    );
    expect(timedOut.structuredContent).not.toHaveProperty('dispatched');
    expect(timedOut.content).toContainEqual(image);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(1);

    mode = 'not-sent';
    const notSent = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(notSent.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        receipt,
        error: 'delivery lost',
      }),
    );
    expect(notSent.structuredContent).not.toHaveProperty('outcome');
    expect(notSent.content).toContainEqual(image);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(2);

    mode = 'pre-send-cancel';
    const preSend = await manager.callTool(
      task!.id,
      'chrome_interact_index',
      { action: 'click' },
      undefined,
      external.signal,
    );
    expect(preSend.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'cancelled',
        retry: false,
        cancelled: true,
        error: 'bridge reset before write',
        cancellation: expect.objectContaining({
          requestDispatched: false,
          reason: 'signal',
        }),
      }),
    );
    expect(preSend.structuredContent).not.toHaveProperty('outcome');
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(3);

    mode = 'explicit-failed';
    const explicit = await manager.callTool(task!.id, 'chrome_interact_index', { action: 'click' });
    expect(explicit.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'failed',
        retry: false,
        receipt,
        error: 'extension failed',
      }),
    );
    expect(explicit.structuredContent).not.toHaveProperty('outcome');
    expect(explicit.content).toContainEqual(image);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(4);
  });

  it('keeps an attached cancelled receipt when diagnostic text surrounds the JSON block', async () => {
    const storageDir = testDir('multi-content-status');
    const receipt = { hasReceipt: true, marker: 'partial-click' };
    const image = { type: 'image' as const, data: 'dddd', mimeType: 'image/png' };
    const diagnostic = 'diagnostic: click may have landed before the transport closed';
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(65, String(args.url));
      if (name === 'get_windows_and_tabs') return live([tab(65, 'https://multi-content.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'chrome_interact_index') {
        throw Object.assign(new Error('socket dropped after response'), {
          requestDispatched: true,
          result: {
            isError: true,
            content: [
              { type: 'text', text: diagnostic },
              image,
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  status: 'cancelled',
                  receipt,
                  error: 'extension cancelled the click',
                }),
              },
            ],
          },
        });
      }
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Multi content status' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://multi-content.example/',
    });

    const delivered = await manager.callTool(task!.id, 'chrome_interact_index', {
      action: 'click',
    });
    expect(delivered.isError).toBe(true);
    expect(delivered.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        status: 'cancelled',
        retry: false,
        receipt,
        error: 'extension cancelled the click',
      }),
    );
    expect(delivered.structuredContent).not.toHaveProperty('outcome');
    expect(delivered.structuredContent).not.toHaveProperty('dispatched');
    expect(delivered.content[0]).toEqual({ type: 'text', text: diagnostic });
    expect(delivered.content).toContainEqual(image);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  it('preserves structured open failures and pins a receipt only for a proven tab', async () => {
    const storageDir = testDir('open-structured-error');
    const receipt = { hasReceipt: true, navigation: 'maybe-created' };
    const image = { type: 'image' as const, data: 'bbbb', mimeType: 'image/png' };
    let mode: 'created' | 'untabbed' | 'unproven' | 'rejected' | 'success' = 'created';
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        if (mode === 'success') return opened(70, String(args.url));
        const payload =
          mode === 'created'
            ? {
                success: false,
                status: 'unknown',
                outcome: 'unknown',
                retry: true,
                created: true,
                tabId: 71,
                windowId: 1,
                receipt,
                error: 'navigation outcome unknown',
              }
            : mode === 'untabbed'
              ? {
                  success: false,
                  status: 'unknown',
                  outcome: 'unknown',
                  receipt,
                  error: 'navigation outcome unknown',
                }
              : mode === 'unproven'
                ? {
                    success: false,
                    status: 'unknown',
                    tabId: 72,
                    receipt,
                    error: 'no creation proof',
                  }
                : {
                    success: false,
                    status: 'blocked',
                    retry: false,
                    receipt,
                    error: 'navigation rejected before commit',
                  };
        const value = result(payload, true);
        value.content.push(image);
        return value;
      }
      if (name === 'get_windows_and_tabs') return live([tab(70, 'https://ok.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const navigations = () => call.mock.calls.filter(([name]) => name === 'chrome_navigate').length;
    const createdTask = (await manager.execute({ action: 'start', name: 'Open created unknown' }))
      .task!;
    const created = await manager.execute({
      action: 'open',
      taskId: createdTask.id,
      url: 'https://created-unknown.example/',
    });
    expect(created.ok).toBe(false);
    expect(created.status).toBe('unknown');
    expect(created.outcome).toBe('unknown');
    expect(created.retry).toBe(false);
    expect(created.dispatched).toBe(true);
    expect(created.receipt).toEqual(receipt);
    expect(created.content).toContainEqual(image);
    expect(created.pendingCreation).toEqual(
      expect.objectContaining({
        tabId: 71,
        windowId: 1,
        requestedUrl: 'https://created-unknown.example/',
      }),
    );
    expect(created.task?.pendingCreations).toEqual([created.pendingCreation]);
    expect(created.task?.pages).toEqual([]);
    expect(navigations()).toBe(1);
    const repeat = await manager.execute({
      action: 'open',
      taskId: createdTask.id,
      url: 'https://created-unknown-again.example/',
    });
    expect(repeat.ok).toBe(false);
    expect(repeat.error).toContain('unresolved page creation receipt');
    expect(navigations()).toBe(1);

    mode = 'untabbed';
    const untabbedTask = (await manager.execute({ action: 'start', name: 'Open untabbed unknown' }))
      .task!;
    const untabbed = await manager.execute({
      action: 'open',
      taskId: untabbedTask.id,
      url: 'https://untabbed-unknown.example/',
    });
    expect(untabbed.ok).toBe(false);
    expect(untabbed.status).toBe('unknown');
    expect(untabbed.outcome).toBe('unknown');
    expect(untabbed.retry).toBe(false);
    expect(untabbed.dispatched).toBeUndefined();
    expect(untabbed.receipt).toEqual(receipt);
    expect(untabbed.content).toContainEqual(image);
    expect(untabbed.pendingCreation).toEqual(
      expect.objectContaining({
        unknownId: expect.stringMatching(/^unknown:/),
        requestedUrl: 'https://untabbed-unknown.example/',
        receipt,
      }),
    );
    expect(untabbed.pendingCreation).not.toHaveProperty('tabId');
    expect(untabbed.error).toContain('blocks another open');
    expect(untabbed.task?.pendingCreations).toEqual([untabbed.pendingCreation]);
    expect(untabbed.task?.pages).toEqual([]);
    const untabbedAgain = await manager.execute({
      action: 'open',
      taskId: untabbedTask.id,
      url: 'https://untabbed-again.example/',
    });
    expect(untabbedAgain.ok).toBe(false);
    expect(untabbedAgain.error).toContain('unresolved page creation receipt');
    expect(navigations()).toBe(2);
    mode = 'unproven';
    const unprovenTask = (await manager.execute({ action: 'start', name: 'Open unproven tab' }))
      .task!;
    const unproven = await manager.execute({
      action: 'open',
      taskId: unprovenTask.id,
      url: 'https://unproven.example/',
    });
    expect(unproven.ok).toBe(false);
    expect(unproven.status).toBe('unknown');
    expect(unproven.retry).toBe(false);
    expect(unproven.dispatched).toBeUndefined();
    expect(unproven.receipt).toEqual(receipt);
    expect(unproven.pendingCreation).toBeUndefined();
    expect(unproven.task?.pages).toEqual([]);
    expect(unproven.error).not.toContain('no pending receipt was stored');
    expect(navigations()).toBe(3);

    mode = 'rejected';
    const rejectedTask = (await manager.execute({ action: 'start', name: 'Open rejected' })).task!;
    const rejected = await manager.execute({
      action: 'open',
      taskId: rejectedTask.id,
      url: 'https://rejected.example/',
    });
    expect(rejected).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'blocked',
        retry: false,
        receipt,
        error: 'navigation rejected before commit',
      }),
    );
    expect(rejected.dispatched).toBeUndefined();
    expect(rejected.pendingCreation).toBeUndefined();
    expect(navigations()).toBe(4);

    mode = 'success';
    const successTask = (await manager.execute({ action: 'start', name: 'Open success unchanged' }))
      .task!;
    const success = await manager.execute({
      action: 'open',
      taskId: successTask.id,
      url: 'https://ok.example/',
    });
    expect(success.ok).toBe(true);
    expect(success.status).toBeUndefined();
    expect(success.outcome).toBeUndefined();
    expect(success.receipt).toBeUndefined();
    expect(success.content).toBeUndefined();
    expect(success.pendingCreation).toBeUndefined();
    expect(success.task?.pages).toEqual([
      expect.objectContaining({ tabId: 70, ownership: 'owned', documentId: 'doc-70' }),
    ]);
    expect(success.task?.pendingCreations).toEqual([]);
    expect(navigations()).toBe(5);
  });

  it('keeps an open transport failure unknown unless the request was not sent', async () => {
    const storageDir = testDir('open-transport');
    let mode: 'timeout' | 'not-sent' = 'timeout';
    let navigations = 0;
    const call = jest.fn<BrowserCall>(async (name: string) => {
      if (name === 'chrome_navigate') {
        navigations += 1;
        throw Object.assign(new Error('Request timed out after 5ms'), {
          requestDispatched: mode === 'timeout',
        });
      }
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const timeoutTask = (await manager.execute({ action: 'start', name: 'Open timeout' })).task!;
    const timedOut = await manager.execute({
      action: 'open',
      taskId: timeoutTask.id,
      url: 'https://open-timeout.example/',
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.status).toBe('unknown');
    expect(timedOut.outcome).toBe('unknown');
    expect(timedOut.retry).toBe(false);
    expect(timedOut.dispatched).toBeUndefined();
    expect(timedOut.pendingCreation).toEqual(
      expect.objectContaining({
        unknownId: expect.stringMatching(/^unknown:/),
        requestedUrl: 'https://open-timeout.example/',
      }),
    );
    expect(timedOut.pendingCreation).not.toHaveProperty('tabId');
    expect(timedOut.error).toContain('Request timed out after 5ms');
    expect(timedOut.error).toContain('blocks another open');
    expect(navigations).toBe(1);
    const repeatedTimeout = await manager.execute({
      action: 'open',
      taskId: timeoutTask.id,
      url: 'https://open-timeout-again.example/',
    });
    expect(repeatedTimeout.ok).toBe(false);
    expect(navigations).toBe(1);
    mode = 'not-sent';
    const blockedTask = (await manager.execute({ action: 'start', name: 'Open not sent' })).task!;
    const notSent = await manager.execute({
      action: 'open',
      taskId: blockedTask.id,
      url: 'https://open-not-sent.example/',
    });
    expect(notSent).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        error: 'Request timed out after 5ms',
      }),
    );
    expect(notSent.pendingCreation).toBeUndefined();
    expect(notSent.task?.pendingCreations).toEqual([]);
    expect(notSent.error).not.toContain('no tabId');
    expect(navigations).toBe(2);
  });

  it('blocks later opens with a persisted unidentified receipt and retains it only by explicit finish', async () => {
    const storageDir = testDir('unknown-receipt');
    const receipt = { hasReceipt: true, navigation: 'unpinned' };
    const image = { type: 'image' as const, data: 'cccc', mimeType: 'image/png' };
    let phase: 'blocked' | 'allow' | 'unknown' = 'blocked';
    let navigations = 0;
    let closes = 0;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        navigations += 1;
        if (phase === 'blocked') {
          const failure = result({ success: false, receipt, error: 'not sent' }, true);
          failure.content.push(image);
          throw Object.assign(new Error('bridge down'), {
            requestDispatched: false,
            result: failure,
          });
        }
        if (phase === 'unknown') {
          const failure = result(
            {
              success: false,
              status: 'unknown',
              outcome: 'unknown',
              receipt,
              error: 'navigation outcome unknown',
            },
            true,
          );
          failure.content.push(image);
          throw Object.assign(new Error('Request timed out after 5ms'), {
            requestDispatched: true,
            result: failure,
          });
        }
        return opened(80, String(args.url));
      }
      if (name === 'get_windows_and_tabs') return live([tab(80, 'https://allowed.example/')]);
      if (name === 'chrome_close_tabs') {
        closes += 1;
        return result({ success: true, closedTabIds: args.tabIds });
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const blockedTask = (await manager.execute({ action: 'start', name: 'Pre-send blocked' }))
      .task!;
    const notSent = await manager.execute({
      action: 'open',
      taskId: blockedTask.id,
      url: 'https://not-sent.example/',
    });
    expect(notSent).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        receipt,
      }),
    );
    expect(notSent.content).toContainEqual(image);
    expect(notSent.pendingCreation).toBeUndefined();
    expect(notSent.task?.pendingCreations).toEqual([]);
    expect(navigations).toBe(1);
    phase = 'allow';
    const allowed = await manager.execute({
      action: 'open',
      taskId: blockedTask.id,
      url: 'https://allowed.example/',
    });
    expect(allowed.ok).toBe(true);
    expect(navigations).toBe(2);

    phase = 'unknown';
    const task = (await manager.execute({ action: 'start', name: 'Unknown receipt' })).task!;
    const openedResult = await manager.execute({
      action: 'open',
      taskId: task.id,
      url: 'https://unknown-page.example/',
    });
    expect(openedResult.status).toBe('unknown');
    expect(openedResult.outcome).toBe('unknown');
    expect(openedResult.receipt).toEqual(receipt);
    expect(openedResult.content).toContainEqual(image);
    expect(openedResult.dispatched).toBeUndefined();
    expect(openedResult.pendingCreation).toEqual(
      expect.objectContaining({
        unknownId: expect.stringMatching(/^unknown:/),
        requestedUrl: 'https://unknown-page.example/',
        receipt,
      }),
    );
    expect(openedResult.pendingCreation).not.toHaveProperty('tabId');
    expect(openedResult.task?.pages).toEqual([]);
    expect(navigations).toBe(3);
    const second = await manager.execute({
      action: 'open',
      taskId: task.id,
      url: 'https://second.example/',
    });
    expect(second.ok).toBe(false);
    expect(second).toEqual(
      expect.objectContaining({ status: 'blocked', retry: false, dispatched: false }),
    );
    expect(second.error).toContain('unresolved page creation receipt');
    expect(navigations).toBe(3);

    const restarted = new BrowserTaskManager({ call, storageDir });
    const restored = await restarted.execute({ action: 'status', taskId: task.id });
    expect(restored.task?.pendingCreations).toEqual([
      expect.objectContaining({
        unknownId: openedResult.pendingCreation?.unknownId,
        receipt,
      }),
    ]);
    const afterRestart = await restarted.execute({
      action: 'open',
      taskId: task.id,
      url: 'https://third.example/',
    });
    expect(afterRestart.ok).toBe(false);
    expect(navigations).toBe(3);

    const refused = await restarted.execute({ action: 'finish', taskId: task.id });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe('unverified');
    expect(refused.retry).toBe(false);
    expect(refused.dispatched).toBe(false);
    expect(refused.task?.status).toBe('active');
    expect(refused.task?.pendingCreations?.[0]?.unknownId).toBe(
      openedResult.pendingCreation?.unknownId,
    );
    expect(closes).toBe(0);

    const missingConfirm = await restarted.execute({
      action: 'finish',
      taskId: task.id,
      keepUnknownPages: true,
    });
    expect(missingConfirm.ok).toBe(false);
    expect(missingConfirm.status).toBeUndefined();
    expect(missingConfirm.error).toContain('confirm: true');
    expect(closes).toBe(0);
    expect((await restarted.execute({ action: 'status', taskId: task.id })).task?.status).toBe(
      'active',
    );

    const kept = await restarted.execute({
      action: 'finish',
      taskId: task.id,
      keepUnknownPages: true,
      confirm: true,
    });
    expect(kept.ok).toBe(true);
    expect(kept.task?.status).toBe('finished');
    expect(kept.warning).toContain('not closed');
    expect(kept.warning).toContain('not claimed');
    expect(kept.handedOverUnknown).toEqual([
      expect.objectContaining({
        unknownId: openedResult.pendingCreation?.unknownId,
        receipt,
        retained: true,
      }),
    ]);
    expect(closes).toBe(0);
    const reloaded = new BrowserTaskManager({ call, storageDir });
    const finishedStatus = await reloaded.execute({ action: 'status', taskId: task.id });
    expect(finishedStatus.task?.status).toBe('finished');
    expect(finishedStatus.task?.pendingCreations).toEqual(kept.handedOverUnknown);
    const afterFinish = await reloaded.execute({
      action: 'open',
      taskId: task.id,
      url: 'https://after-finish.example/',
    });
    expect(afterFinish.ok).toBe(false);
    expect(afterFinish.status).toBeUndefined();
    expect(afterFinish.error).toContain('finished');
    expect(navigations).toBe(3);
  });

  it.each<[string, CallToolResult]>([
    ['missing tabId', result({ success: true, created: true, receipt: { hasReceipt: true } })],
    ['malformed response', { content: [{ type: 'text', text: 'incomplete navigation reply' }] }],
  ])(
    'retains an unidentified creation after a successful transport with %s',
    async (_, response) => {
      const storageDir = testDir('invalid-open-response');
      const image = { type: 'image' as const, data: 'aaaa', mimeType: 'image/png' };
      response.content.push(image);
      const call = jest.fn<BrowserCall>(async (name) => {
        if (name === 'chrome_navigate') return response;
        if (name === 'get_windows_and_tabs') return live();
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir });
      const { task } = await manager.execute({ action: 'start', name: 'Invalid open reply' });
      const failed = await manager.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://pending.example/',
      });
      expect(failed).toEqual(
        expect.objectContaining({ ok: false, status: 'unknown', retry: false }),
      );
      expect(failed.content).toContainEqual(image);
      expect(failed.pendingCreation).toEqual(
        expect.objectContaining({ unknownId: expect.any(String) }),
      );
      const restarted = new BrowserTaskManager({ call, storageDir });
      const repeat = await restarted.execute({
        action: 'open',
        taskId: task!.id,
        url: 'https://next.example/',
      });
      expect(repeat).toEqual(
        expect.objectContaining({ ok: false, status: 'blocked', dispatched: false }),
      );
      expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(1);
      const cleanup = await restarted.execute({ action: 'finish', taskId: task!.id });
      expect(cleanup.status).toBe('unverified');
      expect(call.mock.calls.some(([name]) => name === 'chrome_close_tabs')).toBe(false);
    },
  );

  it('returns cancelled machine status for later task entry points and leaves ordinary errors plain', async () => {
    const storageDir = testDir('cancelled-actions');
    let navigations = 0;
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') {
        navigations += 1;
        return opened(81, String(args.url));
      }
      if (name === 'get_windows_and_tabs')
        return live([tab(81, 'https://cancel-actions.example/')]);
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const task = (await manager.execute({ action: 'start', name: 'Cancel actions' })).task!;
    await manager.execute({
      action: 'open',
      taskId: task.id,
      url: 'https://cancel-actions.example/',
    });
    await manager.execute({ action: 'cancel', taskId: task.id });
    const callsAfterCancel = call.mock.calls.length;
    for (const action of ['open', 'borrow', 'handOff', 'resume', 'takeOver'] as const) {
      const cancelled = await manager.execute(
        {
          action,
          taskId: task.id,
          url: 'https://later.example/',
          tabId: 81,
          confirm: true,
        },
        'session-b',
      );
      expect(cancelled.ok).toBe(false);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.retry).toBe(false);
      expect(cancelled.dispatched).toBe(false);
      expect(cancelled.error).toContain('cancelled');
    }
    expect(call.mock.calls.length).toBe(callsAfterCancel);
    expect(navigations).toBe(1);

    const finishedTask = (await manager.execute({ action: 'start', name: 'Finished plain' })).task!;
    expect((await manager.execute({ action: 'finish', taskId: finishedTask.id })).ok).toBe(true);
    const finishedOpen = await manager.execute({
      action: 'open',
      taskId: finishedTask.id,
      url: 'https://finished.example/',
    });
    expect(finishedOpen.ok).toBe(false);
    expect(finishedOpen.status).toBeUndefined();
    expect(finishedOpen.error).toContain('finished');
    const invalid = await manager.execute({ action: 'nope' });
    expect(invalid.ok).toBe(false);
    expect(invalid.status).toBeUndefined();
    const missing = await manager.execute({
      action: 'open',
      taskId: 'missing',
      url: 'https://missing.example/',
    });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBeUndefined();
    expect(missing.error).toContain('Unknown task');
  });

  it.each(
    (['handOff', 'finish'] as const).flatMap((action) =>
      (['inventory', 'not-sent', 'timeout', 'reply'] as const).map((failure) => ({
        action,
        failure,
      })),
    ),
  )(
    'preserves $action delivery state after $failure without replay',
    async ({ action, failure }) => {
      let failing = false;
      let mutations = 0;
      const receipt = { hasReceipt: true, marker: 'release-result' };
      const image = { type: 'image' as const, data: 'aaaa', mimeType: 'image/png' };
      const call = jest.fn<BrowserCall>(async (name, args) => {
        if (name === 'chrome_navigate') return opened(94, String(args.url));
        if (name === 'browserpaw_set_owned_viewport') return viewport();
        if (name === 'get_windows_and_tabs') {
          if (failing && failure === 'inventory') {
            throw Object.assign(new Error('Inventory response timed out'), {
              requestDispatched: true,
            });
          }
          return live([tab(94, 'https://release.example/')]);
        }
        if (name === 'browserpaw_release_owned_page' || name === 'chrome_close_tabs') {
          mutations++;
          if (failure === 'reply') {
            const denied = result(
              { success: false, status: 'blocked', dispatched: false, receipt },
              true,
            );
            denied.content.push(image);
            return denied;
          }
          throw Object.assign(new Error('Bridge request failed'), {
            requestDispatched: failure !== 'not-sent',
          });
        }
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir: testDir('cleanup-state') });
      const { task } = await manager.execute({ action: 'start', name: 'Cleanup delivery' });
      expect(
        (
          await manager.execute({
            action: 'open',
            taskId: task!.id,
            url: 'https://release.example/',
          })
        ).ok,
      ).toBe(true);
      failing = true;
      const failed = await manager.execute({ action, taskId: task!.id, tabId: 94 });
      expect(failed.ok).toBe(false);
      expect(failed.status).toBe(failure === 'timeout' ? 'unknown' : 'blocked');
      expect(failed.retry).toBe(false);
      if (failure !== 'timeout') expect(failed.dispatched).toBe(false);
      else expect(failed.dispatched).toBeUndefined();
      if (failure === 'reply') {
        expect(failed.receipt).toEqual(receipt);
        expect(failed.content).toContainEqual(image);
      }
      expect(mutations).toBe(failure === 'inventory' ? 0 : 1);
      failing = false;
      const status = await manager.execute({ action: 'status', taskId: task!.id });
      expect(status.task?.pages[0]).toMatchObject({ ownership: 'owned', state: 'active' });
    },
  );

  it('returns blocked handoff status when identity verification fails before release', async () => {
    const storageDir = testDir('handoff-blocked');
    let documentId = 'doc-64';
    const call = jest.fn<BrowserCall>(async (name: string, args: Record<string, unknown>) => {
      if (name === 'chrome_navigate') return opened(64, String(args.url));
      if (name === 'get_windows_and_tabs') {
        return live([tab(64, 'https://handoff-blocked.example/', true, documentId)]);
      }
      if (name === 'browserpaw_set_owned_viewport') return viewport();
      if (name === 'browserpaw_release_owned_page') return released();
      throw new Error('unexpected ' + name);
    });
    const manager = new BrowserTaskManager({ call, storageDir });
    const { task } = await manager.execute({ action: 'start', name: 'Handoff blocked' });
    await manager.execute({
      action: 'open',
      taskId: task!.id,
      url: 'https://handoff-blocked.example/',
    });
    documentId = 'doc-changed';

    const handed = await manager.execute({ action: 'handOff', taskId: task!.id, tabId: 64 });
    expect(handed.ok).toBe(false);
    expect(handed.status).toBe('blocked');
    expect(handed.retry).toBe(false);
    expect(handed.dispatched).toBe(false);
    expect(handed.error).toContain('failed browser/document identity verification');
    expect(
      call.mock.calls.filter(([name]) => name === 'browserpaw_release_owned_page'),
    ).toHaveLength(0);
    const status = await manager.execute({ action: 'status', taskId: task!.id });
    expect(status.task?.pages[0]).toEqual(
      expect.objectContaining({ tabId: 64, ownership: 'owned' }),
    );
  });

  it.each([false, undefined])(
    'accepts only an explicit release of a changed page (%s)',
    async (releasedOwnership) => {
      let documentId = 'doc-95';
      let managed: boolean | undefined = true;
      const call = jest.fn<BrowserCall>(async (name, args) => {
        if (name === 'chrome_navigate') return opened(95, String(args.url));
        if (name === 'get_windows_and_tabs')
          return live([
            { ...tab(95, 'https://released.example/', true, documentId), isAgentManaged: managed },
          ]);
        if (name === 'browserpaw_set_owned_viewport') return viewport();
        throw new Error(`unexpected ${name}`);
      });
      const manager = new BrowserTaskManager({ call, storageDir: testDir('explicit-release') });
      const task = (await manager.execute({ action: 'start', name: 'Explicit release' })).task!;
      await manager.execute({ action: 'open', taskId: task.id, url: 'https://released.example/' });
      documentId = 'changed-document';
      managed = releasedOwnership;
      const finished = await manager.execute({ action: 'finish', taskId: task.id });
      expect(finished.ok).toBe(releasedOwnership === false);
      expect(finished.task?.pages[0]).toMatchObject(
        releasedOwnership === false
          ? { ownership: 'user', state: 'handedOff' }
          : { ownership: 'owned', state: 'active' },
      );
      expect(
        call.mock.calls.some(
          ([name]) => name === 'chrome_close_tabs' || name === 'browserpaw_release_owned_page',
        ),
      ).toBe(false);
    },
  );
});
