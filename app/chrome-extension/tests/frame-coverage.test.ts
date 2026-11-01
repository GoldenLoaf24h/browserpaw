import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFrameCoverage } from '../utils/frame-coverage';

describe('coverage compares actual frame inventory rather than trusting returned frames', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('reports an omitted frame even if every returned frame succeeded', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: {
        getAllFrames: vi.fn(async () => [
          { frameId: 0, documentId: 'main' },
          { frameId: 5, documentId: 'child' },
        ]),
      },
    });
    const coverage = await describeFrameCoverage(1, [
      { frameId: 0, documentId: 'main', result: {} },
    ]);
    expect(coverage).toMatchObject({
      status: 'incomplete',
      expectedFrames: 2,
      missingFrameIds: [5],
      failedFrameCount: 1,
    });
  });
  it('rejects navigation races and refuses to claim completeness if enumeration fails', async () => {
    const getAllFrames = vi
      .fn()
      .mockResolvedValueOnce([{ frameId: 0, documentId: 'new' }])
      .mockRejectedValueOnce(new Error('unavailable'));
    vi.stubGlobal('chrome', { webNavigation: { getAllFrames } });
    expect(
      await describeFrameCoverage(1, [{ frameId: 0, documentId: 'old', result: {} }]),
    ).toMatchObject({ status: 'incomplete', changedFrameIds: [0] });
    expect(await describeFrameCoverage(1, [{ frameId: 0, result: {} }])).toMatchObject({
      status: 'incomplete',
      verificationError: expect.any(String),
    });
  });
  it('confirms complete coverage only when all expected document identities match', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, documentId: 'main' }]) },
    });
    expect(
      await describeFrameCoverage(1, [{ frameId: 0, documentId: 'main', result: {} }]),
    ).toMatchObject({ status: 'complete', expectedFrames: 1 });
  });
  it('preserves the document and failure reason for a stalled child renderer', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: {
        getAllFrames: vi.fn(async () => [
          { frameId: 0, documentId: 'main' },
          { frameId: 9, documentId: 'blocked' },
        ]),
      },
    });
    expect(
      await describeFrameCoverage(1, [
        { frameId: 0, documentId: 'main', result: {} },
        { frameId: 9, documentId: 'blocked', error: 'executeScript timeout' },
      ]),
    ).toMatchObject({
      status: 'incomplete',
      failedFrameCount: 1,
      failedFrames: [{ frameId: 9, documentId: 'blocked', reason: 'executeScript timeout' }],
    });
  });
});
