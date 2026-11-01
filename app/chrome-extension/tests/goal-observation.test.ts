import { describe, expect, it, vi } from 'vitest';
import { captureGoalObservation } from '../utils/delta-helper';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';

vi.mock('../entrypoints/background/tools/browser/read-dom', () => ({
  readDOMTool: { execute: vi.fn() },
}));

describe('guarded goal observation', () => {
  it.each([false, true])(
    'keeps the complete read result, including failure=%s, on the exact source page',
    async (isError) => {
      const result = {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ guards: { 7: ['identity', 'button', 'Search'] } }),
          },
        ],
        isError,
      };
      vi.mocked(readDOMTool.execute).mockResolvedValueOnce(result);
      const observed = await captureGoalObservation(42, 'owned-session');
      expect(observed).toEqual({ tabId: 42, result });
      expect(readDOMTool.execute).toHaveBeenLastCalledWith({
        tabId: 42,
        sessionId: 'owned-session',
        fast: true,
        format: 'fast',
        includeDetails: true,
        activeViewportOnly: true,
        limit: 100,
      });
    },
  );
});
