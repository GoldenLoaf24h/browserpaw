import type { DomDiffResult } from './snapshot-cache-manager';

export async function describeFrameCoverage(
  tabId: number,
  results: Array<{ frameId: number; documentId?: string; result?: any; error?: unknown }>,
): Promise<NonNullable<DomDiffResult['coverage']>> {
  const successful = results.filter(
    (frame) => frame.result && !frame.result.isErrorPage && !frame.error,
  );
  const failed = results.filter((frame) => frame.error || frame.result?.isErrorPage);
  const base = {
    attemptedFrames: 'all' as const,
    reportedFrames: results.length,
    successfulFrames: successful.length,
    ...(failed.length
      ? {
          failedFrames: failed.map((frame) => ({
            frameId: frame.frameId,
            documentId: frame.documentId,
            reason:
              frame.error instanceof Error
                ? frame.error.message
                : String(frame.error || frame.result?.error || 'Frame is showing error page'),
          })),
        }
      : {}),
  };
  try {
    const expected = await chrome.webNavigation.getAllFrames({ tabId });
    if (!expected?.length) throw new Error('No frame inventory');
    const observed = new Map(successful.map((frame) => [frame.frameId, frame]));
    const expectedIds = new Set(expected.map((frame) => frame.frameId));
    const missingFrameIds = expected
      .filter((frame) => !observed.has(frame.frameId))
      .map((frame) => frame.frameId);
    const changedFrameIds = expected
      .filter((frame) => {
        const actual = observed.get(frame.frameId);
        return actual && frame.documentId && actual.documentId !== frame.documentId;
      })
      .map((frame) => frame.frameId)
      .concat(
        successful.filter((frame) => !expectedIds.has(frame.frameId)).map((frame) => frame.frameId),
      );
    const failedFrameCount = new Set([
      ...results.filter((frame) => !successful.includes(frame)).map((frame) => frame.frameId),
      ...missingFrameIds,
      ...changedFrameIds,
    ]).size;
    return {
      ...base,
      expectedFrames: expected.length,
      status: failedFrameCount ? 'incomplete' : 'complete',
      ...(failedFrameCount ? { failedFrameCount, missingFrameIds, changedFrameIds } : {}),
    };
  } catch {
    return {
      ...base,
      status: 'incomplete',
      failedFrameCount: results.length - successful.length,
      verificationError: 'Expected frame inventory unavailable; coverage cannot be confirmed',
    };
  }
}
