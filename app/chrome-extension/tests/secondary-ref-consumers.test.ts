import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectMediaTool } from '../entrypoints/background/tools/browser/inspect-media';
import {
  indexElement,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';

describe('Secondary consumers preserve reference identity', () => {
  const tabId = 850;
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.spyOn(inspectMediaTool as any, 'tryGetTab').mockResolvedValue({ id: tabId });
    vi.spyOn(inspectMediaTool as any, 'safeExecuteScript').mockImplementation(
      async (_id, options: any) => {
        const callback = (0, eval)(`(${options.func.toString()})`);
        return [{ frameId: 0, result: await callback(...options.args) }];
      },
    );
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
