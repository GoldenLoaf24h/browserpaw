import { beforeEach, describe, expect, it, vi } from 'vitest';
import { undoLastActionTool } from '../entrypoints/background/tools/browser/undo-action';
import { inspectMediaTool } from '../entrypoints/background/tools/browser/inspect-media';
import {
  indexElement,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { actionHistoryManager } from '../utils/action-history-manager';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';

describe('Secondary consumers preserve reference identity', () => {
  const tabId = 850;
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    actionHistoryManager.clear(tabId);
    for (const tool of [undoLastActionTool, inspectMediaTool]) {
      vi.spyOn(tool as any, 'tryGetTab').mockResolvedValue({ id: tabId });
      vi.spyOn(tool as any, 'safeExecuteScript').mockImplementation(async (_id, options: any) => {
        const callback = (0, eval)(`(${options.func.toString()})`);
        return [{ frameId: 0, result: await callback(...options.args) }];
      });
    }
  });

  it('restores a live ref in the frame recorded by fill', async () => {
    const input = document.createElement('input');
    input.value = 'new';
    document.body.append(input);
    const index = indexElement(input);
    actionHistoryManager.pushAction(tabId, {
      type: 'fill',
      index,
      frameId: 7,
      prevValue: 'before',
      timestamp: Date.now(),
    });
    expect((await undoLastActionTool.execute({ tabId })).isError).toBe(false);
    expect(input.value).toBe('before');
    expect((undoLastActionTool as any).safeExecuteScript.mock.calls[0][1].target).toEqual({
      tabId,
      frameIds: [7],
    });
  });

  it('never restores historical text to a replacement with a forged attribute or matching selector', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    const index = indexElement(input);
    input.remove();
    const replacement = document.createElement('input');
    replacement.id = 'replacement';
    replacement.value = 'untouched';
    replacement.setAttribute('data-mcp-idx', String(index));
    document.body.append(replacement);
    actionHistoryManager.pushAction(tabId, {
      type: 'fill',
      index,
      selector: '#replacement',
      prevValue: 'private history',
      timestamp: Date.now(),
    });
    expect((await undoLastActionTool.execute({ tabId })).isError).toBe(true);
    expect(replacement.value).toBe('untouched');
    expect(actionHistoryManager.peekAction(tabId)).toBeDefined();
  });

  it('extracts the live canvas ref', async () => {
    const canvas = document.createElement('canvas');
    canvas.toDataURL = vi.fn(() => 'data:image/png;base64,cGl4ZWxz');
    document.body.append(canvas);
    const result = await inspectMediaTool.execute({ tabId, index: indexElement(canvas) });
    expect(result.isError).toBe(false);
    expect(result.content[1]).toMatchObject({ type: 'image', data: 'cGl4ZWxz' });
  });

  it('refuses a forged canvas without falling through to a supplied selector or screenshot', async () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'decoy';
    canvas.setAttribute('data-mcp-idx', '999999');
    canvas.toDataURL = vi.fn(() => 'data:image/png;base64,ZGVjb3k=');
    document.body.append(canvas);
    const crop = vi.spyOn(screenshotTool, 'execute');
    const result = await inspectMediaTool.execute({ tabId, index: 999999, selector: '#decoy' });
    expect(result.isError).toBe(true);
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(crop).not.toHaveBeenCalled();
  });
});
