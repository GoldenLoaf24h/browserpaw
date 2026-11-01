import { executeInPage } from '../entrypoints/background/tools/browser/in-page-engine';

export async function assertObservedTarget(
  tabId: number,
  index: number | undefined,
  frameId: number | undefined,
  expectedGuard: unknown[] | undefined,
): Promise<void> {
  if (expectedGuard === undefined) return;
  const results =
    typeof index === 'number' && Array.isArray(expectedGuard)
      ? await executeInPage({ tabId, frameIds: [frameId ?? 0] }, 'inPageValidateObservedGuard', [
          index,
          expectedGuard,
        ])
      : [];
  if (results.length !== 1 || results[0]?.result !== true) {
    throw Object.assign(new Error('Observed target changed; read the page before deciding again'), {
      status: 'blocked',
      requestDispatched: false,
      dispatched: false,
    });
  }
}
