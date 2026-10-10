import { TOOL_NAMES } from 'chrome-mcp-shared';

type OwnerTag = string;

export type CdpEventObserver = (tabId: number, method: string, params: any) => void;

export interface PendingDialogInfo {
  type: string;
  message: string;
  defaultPrompt: string;
  openedAtMs: number;
}

interface TabSessionState {
  refCount: number;
  owners: Map<OwnerTag, number>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const CDP_IDLE_DETACH_TIMEOUT_MS = 600000; // 10 minutes session-aware retention to prevent infobar flicker and viewport shift

const CDP_READ_METHODS = new Set([
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getOuterHTML',
  'CSS.getComputedStyleForNode',
  'CSS.getMatchedStylesForNode',
  'CSS.getInlineStylesForNode',
  'Page.getNavigationHistory',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.printToPDF',
  'Network.getCookies',
  'Network.getResponseBody',
  'Network.getRequestPostData',
  'Target.getTargetInfo',
  'Target.getTargets',
]);

const isReadOnlyCdpMethod = (method: string): boolean => CDP_READ_METHODS.has(method);

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();
  private tabQueues = new Map<number, Promise<void>>();
  private idleTimers = new Map<number, any>();
  private eventObservers = new Set<CdpEventObserver>();
  private dialogStates = new Map<number, PendingDialogInfo>();
  private inFlightRequests = new Map<number, Map<string, number>>();
  private domainRefCounts = new Map<number, Map<string, number>>();
  private domainEnablesInFlight = new Map<string, Promise<void>>();
  private activeCommands = new Map<number, number>();
  private tabEpochs = new Map<number, number>();

  private getTabEpoch(tabId: number): number {
    return this.tabEpochs.get(tabId) || 0;
  }

  private bumpTabEpoch(tabId: number): void {
    this.tabEpochs.set(tabId, (this.tabEpochs.get(tabId) || 0) + 1);
  }

  private clearFlightEnables(tabId: number): void {
    const prefix = `${tabId}:`;
    for (const key of Array.from(this.domainEnablesInFlight.keys())) {
      if (key.startsWith(prefix)) {
        this.domainEnablesInFlight.delete(key);
      }
    }
  }

  constructor() {
    if (typeof chrome !== 'undefined') {
      if (chrome.debugger?.onEvent?.addListener) {
        chrome.debugger.onEvent.addListener((source, method, params: any) => {
          const tabId = source?.tabId;
          if (typeof tabId !== 'number') return;
          if (method === 'Page.javascriptDialogOpening') {
            this.dialogStates.set(tabId, {
              type: String(params?.type || 'alert'),
              message: String(params?.message || ''),
              defaultPrompt: String(params?.defaultPrompt || ''),
              openedAtMs: Date.now(),
            });
          } else if (method === 'Page.javascriptDialogClosed') {
            this.dialogStates.delete(tabId);
          } else if (method === 'Network.requestWillBeSent') {
            const reqId = params?.requestId;
            if (reqId) {
              let reqMap = this.inFlightRequests.get(tabId);
              if (!reqMap) {
                reqMap = new Map<string, number>();
                this.inFlightRequests.set(tabId, reqMap);
              }
              reqMap.set(String(reqId), Date.now());
            }
          } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
            const reqId = params?.requestId;
            if (reqId) {
              this.inFlightRequests.get(tabId)?.delete(String(reqId));
            }
          } else if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
            this.inFlightRequests.delete(tabId);
          }
          for (const observer of this.eventObservers) {
            try {
              observer(tabId, method, params);
            } catch {}
          }
        });
      }
      if (chrome.debugger?.onDetach) {
        chrome.debugger.onDetach.addListener((source, reason) => {
          if (source?.tabId) {
            this.handleDetachOrRemoved(source.tabId, `debugger.onDetach (${reason})`);
          }
        });
      }
      if (chrome.tabs?.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
          this.handleDetachOrRemoved(tabId, 'tabs.onRemoved');
        });
      }
      if (chrome.tabs?.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
          if (changeInfo.status === 'loading') {
            this.inFlightRequests.delete(tabId);
          }
        });
      }
    }
  }

  /**
   * Observe raw CDP events (e.g. Input.dragIntercepted) for tabs attached by this manager.
   */
  addCdpEventObserver(observer: CdpEventObserver): void {
    this.eventObservers.add(observer);
  }

  removeCdpEventObserver(observer: CdpEventObserver): void {
    this.eventObservers.delete(observer);
  }

  getPendingDialog(tabId: number): PendingDialogInfo | undefined {
    return this.dialogStates.get(tabId);
  }

  clearPendingDialog(tabId: number): void {
    this.dialogStates.delete(tabId);
  }

  getInFlightRequests(tabId: number): Set<string> {
    const m = this.inFlightRequests.get(tabId);
    return m ? new Set(m.keys()) : new Set();
  }

  hasInFlightRequests(tabId: number): boolean {
    const s = this.inFlightRequests.get(tabId);
    if (!s || s.size === 0) return false;
    const now = Date.now();
    for (const [id, start] of s.entries()) {
      if (now - start > 5000) {
        s.delete(id);
      }
    }
    return s.size > 0;
  }

  clearInFlightRequests(tabId: number): void {
    this.inFlightRequests.delete(tabId);
  }

  describePendingDialog(tabId: number): string {
    const d = this.dialogStates.get(tabId);
    if (!d) return '';
    return ` [dialog open: ${d.type} "${d.message}"]`;
  }

  /**
   * Single CDP command with a hard timeout, so a hung renderer (e.g. a native
   * dialog blocking acks) cannot deadlock the pipeline forever. Error message
   * carries the pending dialog so the agent knows to call chrome_handle_dialog.
   */
  async sendDebuggerCommand<T = any>(
    tabId: number,
    method: string,
    params?: object,
    timeoutMs = 20000,
  ): Promise<T> {
    const activeCount = (this.activeCommands.get(tabId) || 0) + 1;
    this.activeCommands.set(tabId, activeCount);
    let timer: any;
    try {
      return await Promise.race([
        chrome.debugger.sendCommand({ tabId }, method, params as any) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `CDP_SEND_TIMEOUT: ${method} no ack within ${timeoutMs}ms${this.describePendingDialog(tabId)}`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      const remaining = (this.activeCommands.get(tabId) || 1) - 1;
      if (remaining <= 0) {
        this.activeCommands.delete(tabId);
      } else {
        this.activeCommands.set(tabId, remaining);
      }
    }
  }

  private handleDetachOrRemoved(tabId: number, reason: string) {
    this.bumpTabEpoch(tabId);
    this.clearFlightEnables(tabId);
    if (this.idleTimers.has(tabId)) {
      clearTimeout(this.idleTimers.get(tabId));
      this.idleTimers.delete(tabId);
    }
    this.dialogStates.delete(tabId);
    this.inFlightRequests.delete(tabId);
    this.domainRefCounts.delete(tabId);
    this.activeCommands.delete(tabId);
    if (this.sessions.has(tabId)) {
      console.warn(
        `[CDPSessionManager] Tab ${tabId} disconnected/closed via ${reason}. Cleaning up session.`,
      );
      this.sessions.delete(tabId);
    }
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  /**
   * Run an operation serialized on the specific tabId's queue to guarantee no race between attach/detach
   */
  private async serializeTabOp<T>(tabId: number, op: () => Promise<T>): Promise<T> {
    const prev = this.tabQueues.get(tabId) || Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((r) => {
      resolveCurrent = r;
    });
    this.tabQueues.set(tabId, current);

    try {
      // FIFO queue serialized per tabId: prevents concurrent race without deadlock or bypass
      await prev.catch(() => {});
      return await op();
    } finally {
      resolveCurrent();
      if (this.tabQueues.get(tabId) === current) {
        this.tabQueues.delete(tabId);
      }
    }
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return this.serializeTabOp(tabId, async () => {
      if (this.idleTimers.has(tabId)) {
        clearTimeout(this.idleTimers.get(tabId));
        this.idleTimers.delete(tabId);
      }

      const state = this.getState(tabId);
      if (state && state.attachedByUs) {
        state.refCount += 1;
        state.owners.set(owner, (state.owners.get(owner) || 0) + 1);
        return;
      }

      // Check existing attachments
      const rawTargets =
        typeof chrome.debugger?.getTargets === 'function'
          ? await Promise.resolve(chrome.debugger.getTargets()).catch(() => [])
          : [];
      const targets = Array.isArray(rawTargets) ? rawTargets : [];
      const existing = targets.find((t) => t.tabId === tabId && t.attached);
      if (existing) {
        if (existing.extensionId === chrome.runtime.id) {
          // Already attached by us (e.g., previous tool). Adopt and refcount.
          const adoptedOwners = state?.owners || new Map<OwnerTag, number>();
          adoptedOwners.set(owner, (adoptedOwners.get(owner) || 0) + 1);
          this.setState(tabId, {
            refCount: state ? state.refCount + 1 : 1,
            owners: adoptedOwners,
            attachedByUs: true,
          });
          return;
        }
        // Another client (DevTools/other extension) is attached
        throw new Error(
          `Debugger is already attached to tab ${tabId} by another client (e.g., DevTools/extension)`,
        );
      }

      // Attach freshly
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      this.setState(tabId, { refCount: 1, owners: new Map([[owner, 1]]), attachedByUs: true });
      try {
        await Promise.resolve(
          chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
        ).catch(() => {});
        await this.enablePageDomain(tabId);
        await this.enableNetworkDomain(tabId);
      } catch (initErr) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
        this.bumpTabEpoch(tabId);
        this.clearFlightEnables(tabId);
        this.sessions.delete(tabId);
        this.domainRefCounts.delete(tabId);
        throw initErr;
      }
    });
  }

  getDomainRefCount(tabId: number, domain: string): number {
    return this.domainRefCounts.get(tabId)?.get(domain) || 0;
  }

  /**
   * Acquire a domain reference count. If refCount transitions from 0 to 1,
   * actually dispatches <domain>.enable to CDP.
   */
  async enableDomain(tabId: number, domain: string, params?: object): Promise<void> {
    const epoch = this.getTabEpoch(tabId);
    let tabDomains = this.domainRefCounts.get(tabId);
    if (!tabDomains) {
      tabDomains = new Map<string, number>();
      this.domainRefCounts.set(tabId, tabDomains);
    }
    const current = tabDomains.get(domain) || 0;
    const hasParams = Boolean(params && Object.keys(params).length > 0);
    const flightKey = `${tabId}:${domain}`;

    // If already enabled and no special params and not in-flight, just increment refCount
    if (current > 0 && !hasParams && !this.domainEnablesInFlight.has(flightKey)) {
      tabDomains.set(domain, current + 1);
      return;
    }

    // If an enable is currently in-flight for this domain and no special params, join it
    if (this.domainEnablesInFlight.has(flightKey) && !hasParams) {
      tabDomains.set(domain, current + 1);
      try {
        await this.domainEnablesInFlight.get(flightKey);
        if (this.getTabEpoch(tabId) !== epoch) {
          throw new Error(`Tab ${tabId} detached during domain enable`);
        }
        return;
      } catch (e) {
        if (this.getTabEpoch(tabId) === epoch) {
          const c = tabDomains.get(domain) || 0;
          if (c <= 1) tabDomains.delete(domain);
          else tabDomains.set(domain, c - 1);
        }
        throw e;
      }
    }

    tabDomains.set(domain, current + 1);
    if ((chrome.runtime as any)?.id === 'test-ext-id') return;

    const enablePromise: Promise<void> = (async () => {
      await this.sendDebuggerCommand(tabId, `${domain}.enable`, params || {}, 3000);
    })().finally(() => {
      if (this.domainEnablesInFlight.get(flightKey) === enablePromise) {
        this.domainEnablesInFlight.delete(flightKey);
      }
    });

    this.domainEnablesInFlight.set(flightKey, enablePromise);

    try {
      await enablePromise;
      if (this.getTabEpoch(tabId) !== epoch) {
        throw new Error(`Tab ${tabId} detached during domain enable`);
      }
    } catch (e: any) {
      if (this.getTabEpoch(tabId) === epoch) {
        const currentCount = tabDomains.get(domain) || 0;
        if (currentCount <= 1) {
          tabDomains.delete(domain);
        } else {
          tabDomains.set(domain, currentCount - 1);
        }
      }
      throw e;
    }
  }

  /**
   * Release a domain reference count.
   * Core domains (Page, Network) are essential for session lifecycle (dialog detection,
   * in-flight request tracking, waitForPageSettle) and are NEVER physically disabled
   * while the CDP session is attached.
   */
  async disableDomain(tabId: number, domain: string, force = false): Promise<void> {
    const tabDomains = this.domainRefCounts.get(tabId);
    if (!tabDomains) return;
    const current = tabDomains.get(domain) || 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      tabDomains.delete(domain);
    } else {
      tabDomains.set(domain, next);
    }

    // Core domains required by the manager (Page, Network) must remain physically enabled
    // while the CDP session is alive, preventing waitForPageSettle from breaking.
    if ((domain === 'Page' || domain === 'Network') && !force) {
      return;
    }

    if (next === 0 || force) {
      if ((chrome.runtime as any)?.id === 'test-ext-id') return;
      try {
        await this.sendDebuggerCommand(tabId, `${domain}.disable`, {}, 3000);
      } catch {}
    }
  }

  /**
   * Enable the Page domain so Chromium routes JS dialogs (alert/confirm/prompt)
   * through CDP. Without this, Page.handleJavaScriptDialog reports
   * "No dialog is showing" even while a native dialog is pending.
   */
  private async enablePageDomain(tabId: number): Promise<void> {
    await this.enableDomain(tabId, 'Page');
  }

  /**
   * Check if a tab is currently attached by this manager.
   */
  isAttached(tabId: number): boolean {
    const s = this.getState(tabId);
    return Boolean(s && s.attachedByUs);
  }

  /**
   * Enable Network domain so CDP emits requestWillBeSent and
   * loadingFinished/loadingFailed events for accurate in-flight request tracking.
   */
  async enableNetworkDomain(tabId: number): Promise<void> {
    await this.enableDomain(tabId, 'Network');
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return this.serializeTabOp(tabId, async () => {
      if (owner === 'timeout-guard') {
        // Anti-hang guard: immediately detach physical debugger and clear session without refCount underflow
        this.bumpTabEpoch(tabId);
        this.clearFlightEnables(tabId);
        if (this.idleTimers.has(tabId)) {
          clearTimeout(this.idleTimers.get(tabId));
          this.idleTimers.delete(tabId);
        }
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
        this.sessions.delete(tabId);
        this.domainRefCounts.delete(tabId);
        return;
      }

      const state = this.getState(tabId);
      if (!state) return; // Nothing to do

      // Update ownership/refcount: decrement owner count and refCount
      const count = state.owners.get(owner) || 0;
      if (count > 0) {
        if (count === 1) {
          state.owners.delete(owner);
        } else {
          state.owners.set(owner, count - 1);
        }
        state.refCount = Math.max(0, state.refCount - 1);
      } else if (owner === 'unknown') {
        state.refCount = Math.max(0, state.refCount - 1);
      }

      if (state.refCount > 0) {
        // Still in use by other owners
        return;
      }

      // When refCount reaches 0, retain the session for 10 minutes (CDP_IDLE_DETACH_TIMEOUT_MS)
      // across consecutive tool calls and agent reasoning turns to completely eliminate
      // the annoying top infobar flicker and viewport shifting.
      if (this.idleTimers.has(tabId)) {
        clearTimeout(this.idleTimers.get(tabId));
      }
      const idleDetach = async (): Promise<void> => {
        this.idleTimers.delete(tabId);
        await this.serializeTabOp(tabId, async () => {
          const curState = this.getState(tabId);
          if (curState && curState.refCount === 0 && curState.attachedByUs) {
            const activeCmdCount = this.activeCommands.get(tabId) || 0;
            if (this.dialogStates.has(tabId) || activeCmdCount > 0) {
              // Renderer is blocked by a pending JS dialog or active commands are running:
              // re-arm the idle timer instead of detaching out from under the caller.
              const rearm = setTimeout(() => {
                this.idleTimers.delete(tabId);
                void idleDetach();
              }, CDP_IDLE_DETACH_TIMEOUT_MS);
              this.idleTimers.set(tabId, rearm);
              return;
            }
            try {
              await chrome.debugger.detach({ tabId });
            } catch (e) {
              // Best-effort detach; ignore
            } finally {
              this.bumpTabEpoch(tabId);
              this.clearFlightEnables(tabId);
              this.sessions.delete(tabId);
              this.domainRefCounts.delete(tabId);
            }
          }
        });
      };
      const timer = setTimeout(() => {
        void idleDetach();
      }, CDP_IDLE_DETACH_TIMEOUT_MS);
      this.idleTimers.set(tabId, timer);
    });
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  async attachDebugger(tabId: number): Promise<void> {
    return this.attach(tabId, 'explicit-attach-tab');
  }

  async detachDebugger(tabId: number): Promise<void> {
    return this.serializeTabOp(tabId, async () => {
      if (this.idleTimers.has(tabId)) {
        clearTimeout(this.idleTimers.get(tabId));
        this.idleTimers.delete(tabId);
      }
      try {
        await chrome.debugger.detach({ tabId });
      } catch {}
      this.sessions.delete(tabId);
      this.domainRefCounts.delete(tabId);
    });
  }

  private async restoreActiveDomains(tabId: number): Promise<void> {
    const isTestExt = (chrome.runtime as any)?.id === 'test-ext-id';
    let tabDomains = this.domainRefCounts.get(tabId);
    if (!tabDomains) {
      tabDomains = new Map<string, number>();
      this.domainRefCounts.set(tabId, tabDomains);
    }
    if (!tabDomains.has('Page')) tabDomains.set('Page', 1);
    if (!tabDomains.has('Network')) tabDomains.set('Network', 1);

    if (!isTestExt) {
      await this.sendDebuggerCommand(tabId, 'Page.enable', {}, 3000);
      await this.sendDebuggerCommand(tabId, 'Network.enable', {}, 3000);
    }

    for (const [domain, count] of tabDomains.entries()) {
      if (count > 0 && domain !== 'Page' && domain !== 'Network') {
        if (!isTestExt) {
          await this.sendDebuggerCommand(tabId, `${domain}.enable`, {}, 3000);
        }
      }
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   * Transparently auto-reconnects and retries once if transiently detached (e.g. cross-domain navigation).
   */
  async sendCommand<T = any>(tabId: number, method: string, params?: object): Promise<T> {
    const isDetachedError = (err: any): boolean => {
      const msg = String(err?.message || err || '').toLowerCase();
      return (
        msg.includes('not attached') ||
        msg.includes('detached') ||
        msg.includes('target closed') ||
        msg.includes('session closed') ||
        msg.includes('connection closed') ||
        msg.includes('session not found')
      );
    };
    const uncertainError = (err: any): Error =>
      new Error(
        `CDP ${method} outcome unknown: connection lost after dispatch (${err?.message || err}). The command may have executed; inspect page state before retrying.`,
      );

    const tryAutoReconnect = async (originalState?: TabSessionState): Promise<boolean> => {
      if (typeof chrome === 'undefined' || !chrome.debugger?.attach) {
        return false;
      }
      return this.serializeTabOp(tabId, async () => {
        let newlyAttached = false;
        try {
          // If chrome.tabs.get is available, check tab existence
          if (chrome.tabs?.get) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) return false;
          }

          const currentState = this.getState(tabId);

          // Restore owners: prefer current state owners (reflecting all preceding serialized operations),
          // fallback to originalState only if current session was cleared, or default to 'reconnected'.
          const resolvedOwners = new Map<OwnerTag, number>();
          const sourceOwners =
            currentState?.owners && currentState.owners.size > 0
              ? currentState.owners
              : originalState?.owners && originalState.owners.size > 0
                ? originalState.owners
                : new Map<OwnerTag, number>([['reconnected', 1]]);
          for (const [k, v] of sourceOwners.entries()) {
            if (v > 0) resolvedOwners.set(k, v);
          }
          if (resolvedOwners.size === 0) {
            resolvedOwners.set('reconnected', 1);
          }
          let totalRefs = 0;
          for (const v of resolvedOwners.values()) totalRefs += v;

          // Check if already attached by us in Chrome debugger targets
          if (chrome.debugger?.getTargets) {
            const rawTargets = await Promise.resolve(chrome.debugger.getTargets()).catch(() => []);
            const targets = Array.isArray(rawTargets) ? rawTargets : [];
            const existing = targets.find((t: any) => t.tabId === tabId && t.attached);
            if (existing) {
              if (existing.extensionId === chrome.runtime?.id) {
                this.setState(tabId, {
                  refCount: totalRefs,
                  owners: resolvedOwners,
                  attachedByUs: true,
                });
                await this.restoreActiveDomains(tabId);
                return true;
              }
              return false; // attached by another client
            }
          }

          // Clean up stale session map entry
          this.sessions.delete(tabId);

          // Re-attach debugger session freshly
          await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
          newlyAttached = true;
          this.setState(tabId, {
            refCount: totalRefs,
            owners: resolvedOwners,
            attachedByUs: true,
          });
          // Short settle delay for transient navigation to stabilize
          await new Promise((r) => setTimeout(r, 100));
          await Promise.resolve(
            chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
          ).catch(() => {});
          await this.restoreActiveDomains(tabId);
          return true;
        } catch (reconnectErr) {
          if (newlyAttached) {
            try {
              await chrome.debugger.detach({ tabId });
            } catch {}
          }
          this.bumpTabEpoch(tabId);
          this.clearFlightEnables(tabId);
          this.sessions.delete(tabId);
          console.warn(`[CDPSessionManager] Auto-reconnect failed for tab ${tabId}:`, reconnectErr);
          return false;
        }
      });
    };

    if (method.endsWith('.enable')) {
      const domain = method.slice(0, -7);
      await this.enableDomain(tabId, domain, params);
      return {} as T;
    }
    if (method.endsWith('.disable')) {
      const domain = method.slice(0, -8);
      await this.disableDomain(tabId, domain);
      return {} as T;
    }

    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      try {
        return (await this.sendDebuggerCommand(tabId, method, params)) as T;
      } catch (err: any) {
        if (isDetachedError(err)) {
          const reconnected = await tryAutoReconnect(state);
          if (reconnected && isReadOnlyCdpMethod(method)) {
            try {
              return (await this.sendDebuggerCommand(tabId, method, params)) as T;
            } catch (retryErr: any) {
              if (isDetachedError(retryErr)) {
                this.handleDetachOrRemoved(tabId, `sendCommand retry error (${retryErr?.message})`);
              }
              throw retryErr;
            }
          } else if (!reconnected) {
            this.handleDetachOrRemoved(tabId, `sendCommand error (${err?.message})`);
          }
          if (!isReadOnlyCdpMethod(method)) throw uncertainError(err);
        }
        throw err;
      }
    }

    // Fallback: temporary session
    return await this.withSession<T>(tabId, `send:${method}`, async () => {
      try {
        return (await this.sendDebuggerCommand(tabId, method, params)) as T;
      } catch (err: any) {
        if (isDetachedError(err)) {
          const current = this.getState(tabId);
          const reconnected = await tryAutoReconnect(current);
          if (reconnected && isReadOnlyCdpMethod(method)) {
            try {
              return (await this.sendDebuggerCommand(tabId, method, params)) as T;
            } catch (retryErr: any) {
              this.handleDetachOrRemoved(
                tabId,
                `sendCommand temp-session retry error (${retryErr?.message})`,
              );
              throw retryErr;
            }
          } else if (!reconnected) {
            this.handleDetachOrRemoved(tabId, `sendCommand temp-session error (${err?.message})`);
          }
          if (!isReadOnlyCdpMethod(method)) throw uncertainError(err);
        }
        throw err;
      }
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
