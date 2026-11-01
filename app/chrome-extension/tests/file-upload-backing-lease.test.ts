import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileBackingLeaseManager,
  fileUploadTool,
} from '../entrypoints/background/tools/browser/file-upload';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import type { FileBackingLease } from '../utils/file-backing-lease';

afterEach(() => {
  vi.restoreAllMocks();
});

function arrangeStaticInput() {
  vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => fn());
  return vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 42 };
    if (method === 'DOM.describeNode') {
      return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
    }
    return {};
  });
}

describe('file upload backing lease delivery', () => {
  it('returns the same selected-not-submitted delivery flag for direct paths', async () => {
    arrangeStaticInput();

    const result = await fileUploadTool.execute({
      tabId: 10,
      selector: '#file',
      filePath: 'sample.txt',
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text as string)).toMatchObject({
      success: true,
      delivery: 'selected',
      submitted: false,
    });
  });

  it('retains one unknown lease and returns its inspectable handle after uncertain dispatch', async () => {
    arrangeStaticInput();
    vi.spyOn(fileUploadTool as any, 'prepareFileFromRemote').mockResolvedValue({
      filePath: 'prepared.txt',
      fileName: 'prepared.txt',
      size: 4,
      assetId: '11111111-1111-4111-8111-111111111111',
      leaseId: '22222222-2222-4222-8222-222222222222',
    });
    const retained: FileBackingLease = {
      handle: {
        assetId: '11111111-1111-4111-8111-111111111111',
        leaseId: '22222222-2222-4222-8222-222222222222',
        filePath: 'prepared.txt',
        fileName: 'prepared.txt',
        size: 4,
      },
      assetId: '11111111-1111-4111-8111-111111111111',
      leaseId: '22222222-2222-4222-8222-222222222222',
      tabId: 10,
      documentId: 'doc-10',
      keep: false,
      delivery: 'unknown',
      retained: true,
      retainAttempted: true,
      updatedAt: 1,
    };
    const retain = vi.spyOn(fileBackingLeaseManager, 'retain').mockResolvedValue(retained);
    const send = vi.mocked(cdpSessionManager.sendCommand);
    send.mockImplementation(async (_tab, method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      }
      if (method === 'DOM.setFileInputFiles') throw new Error('Renderer disconnected');
      return {};
    });

    const result = await fileUploadTool.execute({
      tabId: 10,
      selector: '#file',
      base64Data: 'dGVzdA==',
      fileName: 'prepared.txt',
    });

    expect(result.isError).toBe(true);
    expect(send.mock.calls.filter((call) => call[1] === 'DOM.setFileInputFiles')).toHaveLength(1);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: retained.assetId,
        leaseId: retained.leaseId,
      }),
      'unknown',
      expect.objectContaining({ tabId: 10 }),
    );
    expect(JSON.parse(result.content[0].text as string)).toMatchObject({
      success: false,
      delivery: 'unknown',
      submitted: false,
      retained: true,
      assetId: retained.assetId,
      leaseId: retained.leaseId,
      handle: retained.handle,
    });
  });
});
