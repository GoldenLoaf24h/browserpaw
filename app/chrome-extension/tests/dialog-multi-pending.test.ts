import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { handleDialogTool } from '../entrypoints/background/tools/browser/dialog';

const touchedTabs = new Set<number>();

function openDialog(tabId: number, sessionId: string | undefined, message: string) {
  touchedTabs.add(tabId);
  cdpSessionManager.handleCdpEvent(
    { tabId, ...(sessionId ? { sessionId } : {}) },
    'Page.javascriptDialogOpening',
    { type: 'confirm', message },
  );
}

afterEach(() => {
  for (const tabId of touchedTabs) {
    for (const dialog of cdpSessionManager.getPendingDialogs(tabId)) {
      cdpSessionManager.clearPendingDialog(tabId, dialog.dialogId);
    }
  }
  touchedTabs.clear();
  vi.restoreAllMocks();
});

describe('pending dialog fan-out', () => {
  it('keeps multiple tab+source dialogs in opening order with stable unique ids', () => {
    const tabId = 9101;
    openDialog(tabId, undefined, 'Root dialog');
    openDialog(tabId, 'frame-a', 'Frame A dialog');
    openDialog(tabId, 'frame-b', 'Frame B dialog');

    const first = cdpSessionManager.getPendingDialogs(tabId);
    expect(first.map((d) => [d.sessionId, d.message])).toEqual([
      [undefined, 'Root dialog'],
      ['frame-a', 'Frame A dialog'],
      ['frame-b', 'Frame B dialog'],
    ]);
    expect(new Set(first.map((d) => d.dialogId)).size).toBe(3);

    const second = cdpSessionManager.getPendingDialogs(tabId);
    expect(second.map((d) => d.dialogId)).toEqual(first.map((d) => d.dialogId));
    expect(cdpSessionManager.getPendingDialog(tabId)?.dialogId).toBe(first[2].dialogId);

    cdpSessionManager.clearPendingDialog(tabId, first[1].dialogId);
    openDialog(tabId, 'frame-a', 'Reopened frame A dialog');
    const reopened = cdpSessionManager
      .getPendingDialogs(tabId)
      .find((dialog) => dialog.message === 'Reopened frame A dialog');
    expect(reopened?.dialogId).not.toBe(first[1].dialogId);
  });

  it('closed and detached sources clear only their own dialogs', () => {
    const tabId = 9102;
    openDialog(tabId, undefined, 'Root dialog');
    openDialog(tabId, 'frame-a', 'Frame A dialog');
    openDialog(tabId, 'frame-b', 'Frame B dialog');

    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'frame-a' },
      'Page.javascriptDialogClosed',
      {},
    );
    expect(cdpSessionManager.getPendingDialogs(tabId).map((d) => d.sessionId)).toEqual([
      undefined,
      'frame-b',
    ]);

    cdpSessionManager.handleCdpEvent({ tabId }, 'Target.detachedFromTarget', {
      sessionId: 'frame-b',
    });
    expect(cdpSessionManager.getPendingDialogs(tabId).map((d) => d.sessionId)).toEqual([undefined]);
  });

  it('clears every pending dialog when the tab debugger fully detaches', async () => {
    const tabId = 9107;
    openDialog(tabId, undefined, 'Root dialog');
    openDialog(tabId, 'frame-a', 'Frame A dialog');

    await cdpSessionManager.detachDebugger(tabId);

    expect(cdpSessionManager.getPendingDialogs(tabId)).toEqual([]);
  });

  it('requires dialogId when multiple dialogs are pending and reports candidates', async () => {
    const tabId = 9103;
    openDialog(tabId, undefined, 'Root dialog');
    openDialog(tabId, 'frame-a', 'Frame A dialog');
    const candidates = cdpSessionManager.getPendingDialogs(tabId);

    vi.spyOn(handleDialogTool as any, 'resolveAffinityTab').mockResolvedValue({ id: tabId });
    const withSession = vi.spyOn(cdpSessionManager, 'withSession');
    const sendFrame = vi.spyOn(cdpSessionManager, 'sendFrameCommand');

    const result = await handleDialogTool.execute({ action: 'dismiss', tabId });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DIALOG_SELECTION_REQUIRED');
    expect(result.content[0].text).toContain(candidates[0].dialogId);
    expect(result.content[0].text).toContain(candidates[1].dialogId);
    expect(withSession).not.toHaveBeenCalled();
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it('handles the explicitly selected source and clears only that dialog', async () => {
    const tabId = 9104;
    openDialog(tabId, undefined, 'Root dialog');
    openDialog(tabId, 'frame-a', 'Frame A dialog');
    openDialog(tabId, 'frame-b', 'Frame B dialog');
    const selected = cdpSessionManager.getPendingDialogs(tabId)[1];

    vi.spyOn(handleDialogTool as any, 'resolveAffinityTab').mockResolvedValue({ id: tabId });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation((async (
      _tabId: number,
      _owner: string,
      run: () => Promise<unknown>,
    ) => run()) as any);
    const sendFrame = vi.spyOn(cdpSessionManager, 'sendFrameCommand').mockResolvedValue({});

    const result = await handleDialogTool.execute({
      action: 'accept',
      promptText: 'yes',
      tabId,
      dialogId: selected.dialogId,
    });

    expect(result.isError).toBe(false);
    expect(sendFrame).toHaveBeenCalledWith(tabId, 'frame-a', 'Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'yes',
    });
    expect(cdpSessionManager.getPendingDialogs(tabId).map((d) => d.sessionId)).toEqual([
      undefined,
      'frame-b',
    ]);
    expect(JSON.parse(result.content[0].text as string).handledDialog.dialogId).toBe(
      selected.dialogId,
    );
  });

  it('keeps the no-dialogId call compatible for a single pending dialog', async () => {
    const tabId = 9105;
    openDialog(tabId, 'frame-only', 'Only dialog');
    const [selected] = cdpSessionManager.getPendingDialogs(tabId);

    vi.spyOn(handleDialogTool as any, 'resolveAffinityTab').mockResolvedValue({ id: tabId });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation((async (
      _tabId: number,
      _owner: string,
      run: () => Promise<unknown>,
    ) => run()) as any);
    const sendFrame = vi.spyOn(cdpSessionManager, 'sendFrameCommand').mockResolvedValue({});

    const result = await handleDialogTool.execute({ action: 'dismiss', tabId });

    expect(result.isError).toBe(false);
    expect(sendFrame).toHaveBeenCalledWith(tabId, 'frame-only', 'Page.handleJavaScriptDialog', {
      accept: false,
      promptText: undefined,
    });
    expect(cdpSessionManager.getPendingDialogs(tabId)).toHaveLength(0);
    expect(JSON.parse(result.content[0].text as string).handledDialog.dialogId).toBe(
      selected.dialogId,
    );
  });

  it('rejects an unknown dialogId without clearing other pending dialogs', async () => {
    const tabId = 9106;
    openDialog(tabId, 'frame-a', 'Frame A dialog');
    const [pending] = cdpSessionManager.getPendingDialogs(tabId);

    vi.spyOn(handleDialogTool as any, 'resolveAffinityTab').mockResolvedValue({ id: tabId });

    const result = await handleDialogTool.execute({
      action: 'accept',
      tabId,
      dialogId: 'missing-dialog',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DIALOG_NOT_FOUND');
    expect(result.content[0].text).toContain(pending.dialogId);
    expect(cdpSessionManager.getPendingDialogs(tabId)).toHaveLength(1);
  });
});
