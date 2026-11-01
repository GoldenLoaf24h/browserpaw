import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DownloadObservation } from 'chrome-mcp-shared';
import { BrowserTaskManager, type BrowserCall } from './browser-tasks';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const result = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

function download(tabId = 31, state: DownloadObservation['state'] = 'inProgress') {
  return {
    guid: `download-${tabId}`,
    tabId,
    frameId: `frame-${tabId}`,
    url: 'https://example.com/report.txt',
    suggestedFilename: 'report.txt',
    state,
    receivedBytes: 0,
    totalBytes: 20,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    epoch: 'worker-1',
    sequence: 1,
  } satisfies DownloadObservation;
}

async function setup(sourceDownloads = true, otherManaged = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-download-scope-'));
  roots.push(root);
  let downloads: DownloadObservation[] = [];
  const call = jest.fn<BrowserCall>(async (name) => {
    if (name === 'chrome_navigate')
      return result({
        success: true,
        message: 'Opened URL in new tab in existing window',
        tabId: 31,
      });
    if (name === 'browserpaw_set_owned_viewport')
      return result({
        success: true,
        viewport: { status: 'native', width: 1280, height: 720, dpr: 2 },
      });
    if (name === 'get_windows_and_tabs')
      return result({
        browserInstanceId: 'browser-1',
        capabilities: { sourceDownloads },
        windows: [
          {
            tabs: [31, 32].map((tabId) => ({
              tabId,
              documentId: `doc-${tabId}`,
              url: 'https://example.com/',
              isAgentManaged: tabId === 31 || otherManaged,
              downloads: downloads.filter((item) => item.tabId === tabId),
            })),
          },
        ],
      });
    if (name === 'chrome_handle_download')
      return result({ success: true, download: { id: 999, filename: 'another-user-report.txt' } });
    if (name === 'chrome_close_tabs') return result({ success: true, closedTabIds: [31] });
    if (name === 'browserpaw_release_owned_page') return result({ success: true });
    throw new Error(`Unexpected ${name}`);
  });
  const manager = new BrowserTaskManager({ call, storageDir: root });
  const started = await manager.execute({ action: 'start', name: 'Download isolation' });
  const taskId = started.task!.id;
  expect((await manager.execute({ action: 'open', taskId, url: 'https://example.com/' })).ok).toBe(
    true,
  );
  return {
    manager,
    taskId,
    call,
    root,
    setDownloads: (value: DownloadObservation[]) => {
      downloads = value;
    },
  };
}

describe('task download provenance', () => {
  it.each(['inProgress', 'unknown'] as const)(
    'keeps newer inventory state over an older action receipt (%s)',
    async (state) => {
      const { manager, taskId, call, setDownloads, root } = await setup();
      const original = call.getMockImplementation()!;
      const old = download();
      const latest = { ...old, state, sequence: 4, receivedBytes: 18 };
      call.mockImplementation(async (...args) => {
        if (args[0] === 'chrome_interact_index') {
          setDownloads([latest]);
          return result({ success: true, receipt: { downloads: [old] } });
        }
        return original(...args);
      });
      await manager.callTool(taskId, 'chrome_interact_index', { index: 17 });
      const ledger = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'));
      expect(ledger.tasks[taskId].downloads).toEqual([
        expect.objectContaining({ state, sequence: 4, receivedBytes: 18 }),
      ]);
    },
  );

  it('retains error observations even when the source tab disappears before the post-action inventory', async () => {
    const { manager, taskId, call } = await setup();
    const original = call.getMockImplementation()!;
    let gone = false;
    const observed = download(31, 'unknown');
    call.mockImplementation(async (...args) => {
      if (args[0] === 'chrome_interact_index') {
        gone = true;
        return {
          ...result({ success: false, status: 'unknown', retry: false, downloads: [observed] }),
          isError: true,
        };
      }
      const response = await original(...args);
      if (gone && args[0] === 'get_windows_and_tabs') {
        const data = JSON.parse((response.content[0] as { text: string }).text);
        data.windows[0].tabs = data.windows[0].tabs.filter(
          (tab: { tabId: number }) => tab.tabId !== 31,
        );
        return result(data);
      }
      return response;
    });
    expect((await manager.callTool(taskId, 'chrome_interact_index', { index: 17 })).isError).toBe(
      true,
    );
    const status = await manager.execute({ action: 'status', taskId });
    expect(status.task?.downloads).toEqual([
      expect.objectContaining({ guid: 'download-31', state: 'unknown' }),
    ]);
    const finished = await manager.execute({ action: 'finish', taskId });
    expect(finished.ok).toBe(true);
    expect(finished.warning).toMatch(/download/i);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(0);
  });

  it('rejects old extensions before a source-scoped request can select a global file', async () => {
    const { manager, taskId, call } = await setup(false);
    const response = await manager.callTool(taskId, 'chrome_handle_download', {
      clickTargetIndex: 17,
    });
    expect(response.isError).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_handle_download')).toHaveLength(0);
  });

  it('requires a GUID or one compound trigger instead of silently waiting browser-wide', async () => {
    const { manager, taskId, call } = await setup();
    expect(
      (await manager.callTool(taskId, 'chrome_handle_download', { filenameContains: 'report' }))
        .isError,
    ).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_handle_download')).toHaveLength(0);
  });

  it('does not accept a source-less result from a handler as a task download', async () => {
    const { manager, taskId, call } = await setup();
    const response = await manager.callTool(taskId, 'chrome_handle_download', {
      clickTargetIndex: 17,
    });
    expect(response.isError).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_handle_download')).toHaveLength(1);
    expect(JSON.stringify(response)).toContain('unknown');
    expect(JSON.stringify(response)).toContain('another-user-report.txt');
  });

  it('refuses cleanup while its page has an active download, excluding another task page', async () => {
    const { manager, taskId, call, setDownloads } = await setup();
    setDownloads([download(31), download(32)]);
    const blocked = await manager.execute({ action: 'finish', taskId });
    expect(blocked.ok).toBe(false);
    expect(blocked.task?.status).toBe('active');
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(0);
    expect((blocked.task as any).downloads).toEqual([
      expect.objectContaining({ guid: 'download-31' }),
    ]);
    setDownloads([download(31, 'completed'), download(32)]);
    const finished = await manager.execute({ action: 'finish', taskId });
    expect(finished.ok).toBe(true);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(1);
  });

  it('persists provenance across Native restart and treats lost live evidence as unknown', async () => {
    const { manager, taskId, call, root, setDownloads } = await setup();
    setDownloads([download(31)]);
    await manager.execute({ action: 'finish', taskId });
    setDownloads([]);
    const restored = new BrowserTaskManager({ call, storageDir: root });
    const finished = await restored.execute({ action: 'finish', taskId });
    expect(finished.ok).toBe(false);
    expect((finished.task as any).downloads).toEqual([
      expect.objectContaining({ guid: 'download-31', state: 'unknown' }),
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks[taskId].downloads[0]
        .state,
    ).toBe('unknown');
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(0);
  });

  it('lets the user retain a downloading page without claiming download completion', async () => {
    const { manager, taskId, setDownloads } = await setup();
    setDownloads([download(31)]);
    const retained = await manager.execute({ action: 'finish', taskId, keep: [31] });
    expect(retained.ok).toBe(true);
    expect(retained.warning).toMatch(/download/i);
    expect((retained.task as any).downloads[0].state).toBe('unknown');
    expect(retained.task!.pages[0]).toMatchObject({ ownership: 'user', state: 'handedOff' });
  });

  it('does not adopt pre-existing downloads from a borrowed user page', async () => {
    const { manager, taskId, setDownloads } = await setup(true, false);
    expect((await manager.execute({ action: 'borrow', taskId, tabId: 32 })).ok).toBe(true);
    setDownloads([download(32)]);
    const finished = await manager.execute({ action: 'finish', taskId });
    expect(finished.ok).toBe(true);
    expect(finished.task?.downloads).toEqual([]);
  });

  it('records lost observation when an active downloading page is handed to the user', async () => {
    const { manager, taskId, setDownloads } = await setup();
    setDownloads([download(31)]);
    const handedOff = await manager.execute({ action: 'handOff', taskId, tabId: 31 });
    expect(handedOff.ok).toBe(true);
    expect(handedOff.task?.downloads).toEqual([
      expect.objectContaining({
        guid: 'download-31',
        state: 'unknown',
        reason: expect.stringContaining('handed'),
      }),
    ]);
  });
});
