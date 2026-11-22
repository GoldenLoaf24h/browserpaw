import { initNativeHostListener } from './native-host';
import { initWatchdogs } from './watchdogs';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { ensureScreenshotValidityHydrated } from '@/utils/screenshot-validity';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Background script entry point
 * Initializes core native messaging bridge listener and watchdog cluster
 */
export default defineBackground(() => {
  // Initialize core services
  initNativeHostListener();
  initWatchdogs();
  void screenshotContextManager.ensureHydrated();
  void ensureScreenshotValidityHydrated();
  void cdpSessionManager.reconcilePersistedSessions();
});
