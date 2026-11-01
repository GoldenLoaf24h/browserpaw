import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { executeInPage } from './in-page-engine';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { validateScreenshotCoordinateBinding } from '@/utils/screenshot-validity';
import {
  resolveTargetLocation as baseResolveTargetLocation,
  formatLocatorDiagnostics,
  type BrowserLocatorOptions,
  type BrowserLocatorResult,
} from '@/utils/unified-locator';

export { baseResolveTargetLocation, formatLocatorDiagnostics };
export type { BrowserLocatorOptions, BrowserLocatorResult };

/**
 * Unified Element Locator Layer
 *
 * Implements the unified positioning abstraction (P1-4):
 * 1. Supports ref (default 1-based index or string ref), CSS/XPath selector, text/role, and coordinate (fallback).
 * 2. Strict degradation order: ref -> selector -> text/role -> coordinate.
 * 3. Reports actual resolutionPath ('ref' | 'selector' | 'text' | 'role' | 'coordinate' | 'semantic') in response.
 * 4. Plan B Intelligent Positioning: when non-exact text/label/named-role has zero deterministic matches,
 *    invokes Native Jev System One with strictly bounded candidates (<=32).
 */
export async function resolveTargetLocation(
  tabId: number,
  options: BrowserLocatorOptions,
): Promise<BrowserLocatorResult> {
  return baseResolveTargetLocation(tabId, options, {
    semanticEnabled: async () => (await import('../../native-host')).isJevSemanticEnabled(),
    executeInPage: (target, fnName, args) => executeInPage(target, fnName as any, args),
    sendJevMatch: async (...args) =>
      (await import('../../native-host')).sendJevMatchToNative(...args),
    coordinateScaler: (tId, x, y) => {
      const ctx = screenshotContextManager.getContext(tId);
      if (ctx) {
        return scaleCoordinates(x, y, ctx);
      }
      return { x: Math.round(x), y: Math.round(y) };
    },
    coordinateContext: (tId) => {
      const ctx = screenshotContextManager.getContext(tId);
      return ctx
        ? { viewportWidth: ctx.viewportWidth, viewportHeight: ctx.viewportHeight }
        : undefined;
    },
    validateScreenshotCoordinateBinding,
    sendCdpCommand: async (tId, method, params) => {
      return cdpSessionManager.withSession(tId, 'validate-coordinate', async () => {
        return cdpSessionManager.sendCommand(tId, method, params);
      });
    },
  });
}
