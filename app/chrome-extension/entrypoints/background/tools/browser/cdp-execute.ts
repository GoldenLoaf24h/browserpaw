import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { tabFaviconManager } from './tab-favicon';
import { tabGroupManager } from './tab-group-manager';

let cdpExecuteLeaseSequence = 0;

interface SpecificTargetLease {
  refCount: number;
  attachedByUs: boolean;
}

const specificTargetLeases = new Map<string, SpecificTargetLease>();
const specificTargetQueues = new Map<string, Promise<void>>();

async function serializeSpecificTarget<T>(targetId: string, op: () => Promise<T>): Promise<T> {
  const previous = specificTargetQueues.get(targetId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  specificTargetQueues.set(targetId, current);
  try {
    await previous.catch(() => {});
    return await op();
  } finally {
    release();
    if (specificTargetQueues.get(targetId) === current) {
      specificTargetQueues.delete(targetId);
    }
  }
}

async function isTargetManagedBySessionManager(targetId: string): Promise<boolean> {
  if (typeof chrome === 'undefined' || typeof chrome.debugger?.getTargets !== 'function') {
    return false;
  }
  try {
    const targets = await chrome.debugger.getTargets();
    const match = Array.isArray(targets)
      ? targets.find(
          (entry) => (entry as any).id === targetId || (entry as any).targetId === targetId,
        )
      : undefined;
    return typeof match?.tabId === 'number' && cdpSessionManager.isAttached(match.tabId);
  } catch {
    return false;
  }
}

const BLOCKED_CDP_METHODS = new Set([
  'Browser.close',
  'Browser.crash',
  'Browser.crashGpuProcess',
  'Browser.setDownloadBehavior',
  'Page.setDownloadBehavior',
  'Target.disposeBrowserContext',
]);

export interface CdpExecuteTarget {
  tabId?: number;
  targetId?: string;
  sessionId?: string;
}

export interface CdpExecuteParams {
  tabId?: number;
  target?: CdpExecuteTarget;
  method: string;
  params?: Record<string, any>;
  timeoutMs?: number;
  preserveDebuggerOnTimeout?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

/**
 * Industrial-grade raw Chrome DevTools Protocol (CDP) execution tool.
 *
 * Implements 1:1 architecture parity with ChatGPT official extension (Kf.executeCdp + mg engine):
 * 1. Target Polymorphic Routing: handles tabId, iframe targetId, and session-level targets.
 * 2. Target.getTargets Interception: maps directly to chrome.debugger.getTargets().
 * 3. Timeout Guard & Auto-Detach: on command timeout, automatically detaches debugger to prevent
 *    Chromium renderer freeze unless explicitly requested otherwise.
 * 4. Lifecycle Cleanups: intercepts Page.close / Target.closeTarget to cleanly restore favicons
 *    and tear down empty tab groups without orphan residue.
 */
export class CdpExecuteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_EXECUTE;

  async execute(args: CdpExecuteParams): Promise<ToolResult> {
    if (!args || typeof args.method !== 'string' || !args.method.trim()) {
      return createErrorResponse(
        'method is required and must be a valid CDP command string (e.g. "Page.navigate", "Runtime.evaluate")',
      );
    }

    const method = args.method.trim();
    if (BLOCKED_CDP_METHODS.has(method)) {
      return createErrorResponse(
        `Security restriction: Execution of dangerous CDP command "${method}" is blocked`,
      );
    }
    const commandParams = args.params || {};
    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : 10000;

    // Special case 1: Target.getTargets query does not require an attached target
    if (method === 'Target.getTargets') {
      try {
        if (typeof chrome !== 'undefined' && chrome.debugger?.getTargets) {
          const targets = await chrome.debugger.getTargets();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { success: true, method, result: { targetInfos: targets } },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          };
        }
      } catch (error) {
        return createErrorResponse(
          `Target.getTargets failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Resolve target identity
    const sessionAffinityId = args.sessionId || args.sessionContext;
    let targetTabId: number | undefined;

    if (args.target && typeof args.target.tabId === 'number') {
      targetTabId = args.target.tabId;
    } else if (typeof args.tabId === 'number') {
      targetTabId = args.tabId;
    }

    // If targetId is provided without a tabId (e.g. background worker or out-of-process iframe)
    const specificTargetId =
      args.target && typeof args.target.targetId === 'string' ? args.target.targetId : undefined;

    if (targetTabId === undefined && !specificTargetId) {
      try {
        const resolved = await this.resolveAffinityTab({ sessionId: sessionAffinityId });
        targetTabId = resolved.id;
      } catch (error) {
        return createErrorResponse(
          `Failed to resolve target tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (targetTabId !== undefined && typeof targetTabId === 'number') {
      const tab = await this.tryGetTab(targetTabId, sessionAffinityId);
      if (!tab || !tab.id) {
        return createErrorResponse(`Tab with ID ${targetTabId} not found`);
      }
      targetTabId = tab.id;
    }

    // Special case 2: Lifecycle intercept for tab-closing commands
    if (targetTabId !== undefined && (method === 'Page.close' || method === 'Target.closeTarget')) {
      await tabFaviconManager.restoreFavicon(targetTabId).catch(() => {});
    }

    // Build execution target for chrome.debugger
    const debuggee: chrome.debugger.Debuggee = {};
    if (specificTargetId) {
      debuggee.targetId = specificTargetId;
    } else if (targetTabId !== undefined) {
      debuggee.tabId = targetTabId;
    }
    if (args.target?.sessionId) {
      (debuggee as any).sessionId = args.target.sessionId;
    }

    // Execute with timeout and anti-hang guard
    let timeoutTimer: any;
    let isTimedOut = false;
    let specificTargetLeaseHeld = false;
    let standardTabOwner: string | undefined;

    const acquireSpecificTargetLease = async (targetId: string): Promise<void> => {
      await serializeSpecificTarget(targetId, async () => {
        const existing = specificTargetLeases.get(targetId);
        if (existing) {
          existing.refCount += 1;
          specificTargetLeaseHeld = true;
          return;
        }
        let attachedByUs = false;
        if (typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function') {
          try {
            await chrome.debugger.attach({ targetId }, '1.3');
            attachedByUs = true;
          } catch (attErr: any) {
            const attMsg = String(attErr?.message || attErr).toLowerCase();
            if (!attMsg.includes('already attached') && !attMsg.includes('another client')) {
              console.warn('[CdpExecuteTool] attach target warning:', attErr);
            }
          }
        }
        specificTargetLeases.set(targetId, { refCount: 1, attachedByUs });
        specificTargetLeaseHeld = true;
      });
    };

    const releaseSpecificTargetLease = async (
      targetId: string,
      allowPhysicalDetach: boolean,
    ): Promise<void> => {
      if (!specificTargetLeaseHeld) return;
      specificTargetLeaseHeld = false;
      await serializeSpecificTarget(targetId, async () => {
        const lease = specificTargetLeases.get(targetId);
        if (!lease) return;
        lease.refCount = Math.max(0, lease.refCount - 1);
        if (lease.refCount > 0) return;
        specificTargetLeases.delete(targetId);
        if (
          !allowPhysicalDetach ||
          !lease.attachedByUs ||
          typeof chrome === 'undefined' ||
          typeof chrome.debugger?.detach !== 'function'
        ) {
          return;
        }
        if (await isTargetManagedBySessionManager(targetId)) {
          return;
        }
        try {
          await chrome.debugger.detach({ targetId });
        } catch {}
      });
    };

    try {
      const commandPromise = (async () => {
        // Route through cdpSessionManager if targeting a standard tab
        if (targetTabId !== undefined && !specificTargetId) {
          standardTabOwner = `cdp-execute:${targetTabId}:${method}:${++cdpExecuteLeaseSequence}`;
          await cdpSessionManager.attach(targetTabId, standardTabOwner);
          try {
            return await cdpSessionManager.sendCommand(targetTabId, method, commandParams);
          } finally {
            await cdpSessionManager.detach(targetTabId, standardTabOwner).catch(() => {});
          }
        }
        // Direct chrome.debugger fallback for out-of-process targetId
        if (specificTargetId) {
          await acquireSpecificTargetLease(specificTargetId);
        }
        return await chrome.debugger.sendCommand(debuggee, method, commandParams);
      })();

      const timeoutPromise = new Promise((_, reject) => {
        timeoutTimer = setTimeout(async () => {
          isTimedOut = true;
          // Release this call's lease; physical detach is safe only when no other owner remains.
          if (
            targetTabId !== undefined &&
            standardTabOwner &&
            args.preserveDebuggerOnTimeout !== true
          ) {
            try {
              await cdpSessionManager.detach(targetTabId, 'timeout-guard', standardTabOwner);
            } catch {}
          }
          if (specificTargetId && args.preserveDebuggerOnTimeout !== true) {
            await releaseSpecificTargetLease(specificTargetId, true);
          }
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP command "${method}".`));
        }, timeoutMs);
      });

      const result = await Promise.race([commandPromise, timeoutPromise]);
      clearTimeout(timeoutTimer);

      // Post-close cleanup
      if (
        targetTabId !== undefined &&
        (method === 'Page.close' || method === 'Target.closeTarget')
      ) {
        setTimeout(() => {
          tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});
        }, 100);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                target: debuggee,
                method,
                result: result ?? {},
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      clearTimeout(timeoutTimer);
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`CDP execution error (${method}): ${msg}`);
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (specificTargetId && specificTargetLeaseHeld && !isTimedOut) {
        await releaseSpecificTargetLease(specificTargetId, (args as any).preserveDebugger !== true);
      }
    }
  }
}

export const cdpExecuteTool = new CdpExecuteTool();
