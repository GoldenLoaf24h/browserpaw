import { actionHistoryManager } from '@/utils/action-history-manager';
import { executeInPage } from './in-page-engine';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  raceCdp,
  DialogOpenedError,
  StalePageError,
  createMousePressGuard,
  isCdpOutcomeUncertainError,
} from '@/utils/race-cdp';
import {
  animateAgentCursor,
  animateAgentCursorClick,
  formatAgentCursorAction,
} from './agent-cursor';
import { projectFramePoint } from '@/utils/frame-coordinates';
import { withActionReceipt, type ActionReceipt } from '@/utils/action-receipt';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import { resolveTargetLocation } from './unified-locator';
import { sessionTabAffinity, type TabHandoverInfo } from '@/utils/session-tab-affinity';
import { resolveToolName } from 'chrome-mcp-shared';
import { dispatchNativeSelectAll } from './keyboard';
import { snapshotCacheManager } from '@/utils/snapshot-cache-manager';
import { throwIfAborted, TaskCancelledError } from '@/utils/action-abort';
import { assertObservedTarget } from '@/utils/observed-target-guard';
import { inferFillInteraction } from '@/utils/interaction-outcome';
import type { InteractionOutcome } from 'chrome-mcp-shared';
export { getNativeValueSetter, getNativeCheckedSetter } from './fast-snapshot';

export class FocusVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FocusVerificationError';
  }
}

export interface PhysicalFillOptions {
  expectedGuard?: unknown[];
  tabId: number;
  /** Numeric index from read_dom, or string ref, or CSS selector */
  target: number | string;
  text: string;
  selector?: string;
  ref?: string | number;
  coordinate?: { x: number; y: number };
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
  submitTarget?: {
    index?: number;
    frameId?: number;
    ref?: string | number;
    selector?: string;
    text?: string;
    role?: string;
    label?: string;
    exact?: boolean;
  };
  taskId?: string;
  preferComposer?: boolean;
  sessionId?: string;
  sessionContext?: string;
  frameId?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface PhysicalFillResult {
  interaction?: InteractionOutcome;
  success: boolean;
  committed: boolean;
  index?: number;
  ref?: string | number;
  selector?: string;
  filledText: string;
  isTrusted: boolean;
  method: 'cdp_native' | 'synthetic_inpage' | 'widget_native';
  tagName?: string;
  inputType?: string;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  submitButtonState?: {
    found: boolean;
    text?: string;
    index?: number;
  };
  submitted?: boolean;
  submitMethod?: 'click' | 'pressEnter';
  submittedButtonIndex?: number;
  submitResult?: any;
  pressEnterDispatched?: boolean;
  disambiguationWarning?: string;
  diagnostics?: string;
  error?: string;
  resolutionPath?: string;
  tabHandover?: TabHandoverInfo;
  autoSubmitHandled?: boolean;
  status?: 'success' | 'blocked' | 'timeout' | 'unknown';
  timedOut?: boolean;
  deadlineExceeded?: boolean;
  retry?: false;
  receipt?: ActionReceipt;
}

type DeadlineOutcome = 'not_started' | 'unknown' | 'committed';

class FillDeadlineExceededError extends Error {
  readonly deadlineExceeded = true;
  readonly outcome: DeadlineOutcome;

  constructor(message: string, outcome: DeadlineOutcome = 'not_started') {
    super(message);
    this.name = 'FillDeadlineExceededError';
    this.outcome = outcome;
  }
}

class PostDispatchCommitmentError extends Error {
  constructor(
    message: string,
    readonly verification?: {
      committed?: boolean;
      currentValue?: string;
    },
  ) {
    super(message);
    this.name = 'PostDispatchCommitmentError';
  }
}

function remainingBudget(deadlineAt?: number): number | undefined {
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) return undefined;
  return deadlineAt - Date.now();
}

function nestedTimeout(deadlineAt?: number): number | undefined {
  const remaining = remainingBudget(deadlineAt);
  return remaining === undefined ? undefined : Math.max(1, remaining);
}

function assertBudget(
  deadlineAt: number | undefined,
  phase: string,
  outcome: DeadlineOutcome = 'not_started',
): void {
  const remaining = remainingBudget(deadlineAt);
  if (remaining !== undefined && remaining <= 0) {
    throw new FillDeadlineExceededError(`Fill deadline exceeded ${phase}`, outcome);
  }
}

function rethrowIfDeadlineOrUncertain(
  error: unknown,
  deadlineAt: number | undefined,
  phase: string,
): void {
  if (error instanceof FillDeadlineExceededError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const deadlineExpired =
    typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt;
  if (
    deadlineExpired ||
    isCdpOutcomeUncertainError(error) ||
    /executeScript timeout|not acking|outcome unknown|deadline exceeded/i.test(message)
  ) {
    throw new FillDeadlineExceededError(`${phase}: ${message}`, 'unknown');
  }
}

async function delayWithinBudget(ms: number, deadlineAt?: number): Promise<void> {
  const remaining = remainingBudget(deadlineAt);
  const waitMs = remaining === undefined ? ms : Math.min(ms, Math.max(0, remaining));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
  phase: string,
): Promise<T> {
  const remaining = remainingBudget(deadlineAt);
  if (remaining === undefined) return promise;
  if (remaining <= 0) {
    throw new FillDeadlineExceededError(`Fill deadline exceeded ${phase}`, 'not_started');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FillDeadlineExceededError(`Fill deadline exceeded ${phase}`, 'unknown'));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Unified Physical Typing Engine Core
 *
 * Harmonizes fill-index, fill-form, form-pipeline, and batch fill onto a single
 * industrial-grade typing primitive. Supports:
 * - Humanized micro-trajectory cursor animation
 * - Native selection and replacement, with Backspace only for clearing
 * - Multiline paragraph break preservation
 * - True Input Commitment verification with reactive debounce
 * - Post-dispatch commitment checks without replaying unconfirmed edits
 * - Special HTML5 widget native dispatch (select/date/color/checkbox/radio/file)
 * - 1-Turn auto-submit execution
 */
export async function performPhysicalFill(
  options: PhysicalFillOptions,
): Promise<PhysicalFillResult> {
  const pressEnter = options.pressEnter === true;
  const submit = options.submit === true;
  if (submit && pressEnter) {
    const message =
      'pressEnter:true and submit:true are conflicting submit actions; no field mutation was dispatched';
    return {
      success: false,
      committed: false,
      filledText: '',
      isTrusted: false,
      method: 'cdp_native',
      submitted: false,
      status: 'blocked',
      timedOut: false,
      interaction: inferFillInteraction({
        success: false,
        committed: false,
        status: 'blocked',
        error: message,
      }),
      error: message,
      diagnostics: message,
    };
  }
  if (submit && !options.submitTarget) {
    return {
      success: false,
      committed: false,
      filledText: '',
      isTrusted: false,
      method: 'cdp_native',
      submitted: false,
      status: 'blocked',
      timedOut: false,
      interaction: inferFillInteraction({
        success: false,
        committed: false,
        status: 'blocked',
        error: 'submit:true requires an explicit submitTarget; no field mutation was dispatched',
      }),
      error: 'submit:true requires an explicit submitTarget; no field mutation was dispatched',
      diagnostics:
        'submit:true requires an explicit submitTarget; no field mutation was dispatched',
    };
  }

  // Arm handover tracker at the very start of physical fill so any navigation/tab derivation
  // triggered by pressEnter, typing, or auto-submit is reliably captured without races.
  const handoverTracker =
    pressEnter || (submit && Boolean(options.submitTarget))
      ? sessionTabAffinity.startHandoverTracking(
          options.tabId,
          options.sessionId || options.sessionContext,
        )
      : null;

  try {
    const result = await withActionReceipt(options.tabId, () =>
      runPhysicalFill(options, handoverTracker),
    );
    return { ...result, interaction: inferFillInteraction(result) };
  } catch (error) {
    if (!(error instanceof FillDeadlineExceededError)) throw error;
    const committed = error.outcome === 'committed';
    const result: PhysicalFillResult = {
      success: false,
      committed,
      filledText: committed ? String(options.text ?? '') : '',
      isTrusted: committed,
      method: 'cdp_native',
      status: error.outcome === 'unknown' ? 'unknown' : 'timeout',
      timedOut: true,
      deadlineExceeded: true,
      ...(error.outcome === 'unknown' ? { retry: false as const } : {}),
      error: error.message,
      diagnostics: error.message,
      ...((error as any).receipt ? { receipt: (error as any).receipt } : {}),
    };
    return { ...result, interaction: inferFillInteraction(result) };
  } finally {
    // Every exit path - normal return, early return, or throw - must release the
    // tracker, otherwise its listeners leak for the life of the extension.
    handoverTracker?.cancel();
  }
}

async function runPhysicalFill(
  options: PhysicalFillOptions,
  handoverTracker: ReturnType<typeof sessionTabAffinity.startHandoverTracking> | null,
): Promise<PhysicalFillResult> {
  const { tabId, target, preferComposer } = options;
  const textToFill = String(options.text ?? '');
  const clear = options.clear;
  const pressEnter = options.pressEnter === true;
  const submit = options.submit === true;
  const sessionId = options.sessionId || options.sessionContext;
  const deadlineAt = options.deadlineAt;
  const signal = options.signal;
  throwIfAborted(signal, 'before physical fill');
  const executeWithBudget = <R = any>(
    target: chrome.scripting.InjectionTarget,
    fnName: string,
    args: unknown[],
  ) => {
    const timeout = nestedTimeout(deadlineAt);
    return timeout === undefined
      ? executeInPage<R>(target, fnName, args)
      : executeInPage<R>(target, fnName, args, timeout);
  };
  const raceInput = <T = any>(_targetTabId: number, method: string, params: object) => {
    throwIfAborted(signal, `before ${method}`);
    assertBudget(deadlineAt, `before ${method}`);
    return raceCdp<T>(tabId, method, params, nestedTimeout(deadlineAt));
  };
  throwIfAborted(signal, 'before fill resolution');
  assertBudget(deadlineAt, 'before fill resolution');

  const isNumericIndex =
    typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target));
  let numericIndex = isNumericIndex
    ? typeof target === 'number'
      ? target
      : parseInt(target, 10)
    : undefined;
  const explicitSelector = options.selector;
  const isExplicitRef = typeof target === 'string' && /^(?:ref_|e)\d+$/i.test(target);
  const effectiveSelector =
    explicitSelector || (!isNumericIndex && !isExplicitRef ? String(target) : undefined);
  const selectorOrRef = !isNumericIndex ? String(target) : effectiveSelector;

  let targetX: number | undefined;
  let targetY: number | undefined;
  let targetFrameId = options.frameId ?? 0;
  let coords: any = null;
  let resolutionPath: string | undefined;
  let resolutionError: string | undefined;
  let disambiguationWarning: string | undefined;

  if (numericIndex === undefined && !selectorOrRef && !effectiveSelector && options.coordinate) {
    const hitScope =
      options.frameId !== undefined
        ? { tabId, frameIds: [options.frameId] }
        : { tabId, allFrames: true };
    const hitResults = await executeWithBudget(hitScope, 'inPageSnapCoordinate', [
      Math.round(options.coordinate.x),
      Math.round(options.coordinate.y),
      0,
      true,
      true,
    ]);
    const editableHits = (hitResults ?? []).filter(
      (entry: any) =>
        entry?.result?.targetEditable === true &&
        typeof entry.result.targetIndex === 'number' &&
        entry.result.targetIndex > 0,
    );
    if (editableHits.length === 0) {
      return {
        success: false,
        committed: false,
        filledText: '',
        isTrusted: false,
        method: 'cdp_native',
        error: 'No editable element found at the supplied coordinate',
        resolutionPath: 'coordinate_hit_test',
      };
    }
    if (options.frameId === undefined && editableHits.length > 1) {
      return {
        success: false,
        committed: false,
        filledText: '',
        isTrusted: false,
        method: 'cdp_native',
        error: 'Coordinate hit multiple editable elements across frames; rescan and pass frameId',
        resolutionPath: 'coordinate_hit_test',
      };
    }
    const hit = editableHits[0];
    if (options.frameId !== undefined && (hit.frameId ?? 0) !== options.frameId) {
      return {
        success: false,
        committed: false,
        filledText: '',
        isTrusted: false,
        method: 'cdp_native',
        error: `Coordinate hit-test returned frameId ${hit.frameId ?? 0}, expected ${options.frameId}`,
        resolutionPath: 'coordinate_hit_test',
      };
    }
    numericIndex = hit.result.targetIndex;
    targetFrameId = hit.frameId ?? options.frameId ?? 0;
    resolutionPath = 'coordinate_hit_test';
  }

  // 1. Resolve target coordinates and metadata
  if (numericIndex !== undefined && numericIndex > 0) {
    const scopedTarget =
      options.frameId !== undefined
        ? { tabId, frameIds: [options.frameId] }
        : targetFrameId
          ? { tabId, frameIds: [targetFrameId] }
          : { tabId };
    const coordRes = await executeWithBudget(scopedTarget, 'inPageGetElementCoordinates', [
      numericIndex,
    ]);
    coords = coordRes?.[0]?.result;
    if (!coords?.success && options.frameId === undefined && targetFrameId === 0) {
      const frameResults = await executeWithBudget(
        { tabId, allFrames: true },
        'inPageGetElementCoordinates',
        [numericIndex],
      );
      const match = frameResults.find((r) => r.result?.success);
      if (match?.result) {
        coords = match.result;
        targetFrameId = match.frameId ?? 0;
        if (coords.warning) {
          disambiguationWarning = disambiguationWarning
            ? `${disambiguationWarning}; ${coords.warning}`
            : coords.warning;
        }
        if (coords.scopeHash && typeof numericIndex === 'number') {
          snapshotCacheManager.isScopeValid(tabId, numericIndex, coords.scopeHash);
        }
      }
    }
    // If numeric index lookup failed on dynamic page, fallback to selector resolution
    if (!coords?.success && effectiveSelector) {
      const loc = await resolveTargetLocation(tabId, {
        ref: isExplicitRef ? selectorOrRef : undefined,
        selector: effectiveSelector,
        preferComposer,
        frameId: options.frameId,
      });
      resolutionError = loc.error;
      if (loc.success) {
        if (typeof loc.index === 'number' && loc.index > 0) {
          numericIndex = loc.index;
        }
        coords = {
          success: true,
          x: loc.x,
          y: loc.y,
          value: loc.value,
          tagName: loc.tagName,
          inputType: loc.inputType,
          role: loc.role,
          isComposer: loc.isComposer,
          isEditor: loc.isEditor,
          isSearch: loc.isSearch,
          attributes: loc.attributes,
          frameId: loc.frameId,
        };
        targetFrameId = loc.frameId ?? 0;
        resolutionPath = 'selector_drift_recovery';
      }
    }

    if (coords?.success && typeof coords.x === 'number' && typeof coords.y === 'number') {
      targetX = coords.x;
      targetY = coords.y;
    }
    resolutionPath = resolutionPath || 'numeric_index';
  } else if (selectorOrRef || effectiveSelector) {
    const loc = await resolveTargetLocation(tabId, {
      ref: isExplicitRef ? selectorOrRef : undefined,
      selector: effectiveSelector,
      preferComposer,
      frameId: options.frameId,
    });
    resolutionError = loc.error;
    if (loc.success) {
      if (typeof loc.index === 'number' && loc.index > 0) {
        numericIndex = loc.index;
      }
      coords = {
        success: true,
        x: loc.x,
        y: loc.y,
        value: loc.value,
        tagName: loc.tagName,
        inputType: loc.inputType,
        role: loc.role,
        isComposer: loc.isComposer,
        isEditor: loc.isEditor,
        isSearch: loc.isSearch,
        attributes: loc.attributes,
        frameId: loc.frameId,
      };
      targetFrameId = loc.frameId ?? 0;
      targetX = loc.x;
      targetY = loc.y;
      resolutionPath = loc.resolutionPath || 'unified_locator';
    }
  }

  if (!coords?.success) {
    return {
      success: false,
      committed: false,
      filledText: '',
      isTrusted: false,
      method: 'cdp_native',
      error: resolutionError || coords?.error || 'Cannot resolve fill target',
    };
  }

  if (coords?.success && typeof numericIndex === 'number') {
    const ready = (
      await executeWithBudget(
        targetFrameId ? { tabId, frameIds: [targetFrameId] } : { tabId },
        'inPageWaitForActionable',
        [numericIndex, 'fill'],
      )
    )?.[0]?.result;
    if (!ready?.success) {
      return {
        success: false,
        committed: false,
        filledText: '',
        isTrusted: false,
        method: 'cdp_native',
        error: ready?.error || 'Target is not actionable',
      };
    }
    coords = { ...coords, ...ready };
    targetX = coords.x;
    targetY = coords.y;
    if (targetFrameId !== 0) {
      ({ x: targetX, y: targetY } = await projectFramePoint(tabId, targetFrameId, {
        x: coords.x - (coords.frameOffsetX || 0),
        y: coords.y - (coords.frameOffsetY || 0),
      }));
    }
  }

  // 2. Special widget handling (select, custom combobox/listbox, color, date, range, time, checkbox, radio, file)
  await assertObservedTarget(tabId, numericIndex, targetFrameId, options.expectedGuard);
  const isInput = coords?.tagName?.toLowerCase() === 'input';
  const inputType = coords?.inputType || coords?.attributes?.type;
  const isSearchInput =
    isInput && (inputType === 'text' || inputType === 'search' || !inputType || coords?.isSearch);

  const isCustomCombobox =
    !isSearchInput &&
    (coords?.role === 'combobox' ||
      coords?.role === 'listbox' ||
      coords?.attributes?.role === 'combobox' ||
      coords?.attributes?.role === 'listbox' ||
      coords?.attributes?.['aria-haspopup'] === 'listbox');

  const isSpecialWidget =
    coords?.tagName === 'select' ||
    isCustomCombobox ||
    coords?.inputType === 'color' ||
    coords?.inputType === 'date' ||
    coords?.inputType === 'range' ||
    coords?.inputType === 'time' ||
    coords?.inputType === 'datetime-local' ||
    coords?.inputType === 'month' ||
    coords?.inputType === 'week' ||
    coords?.inputType === 'checkbox' ||
    coords?.inputType === 'radio' ||
    coords?.inputType === 'file';

  if (isSpecialWidget) {
    if (isCustomCombobox) {
      throwIfAborted(signal, 'before custom combobox mutation');
      assertBudget(deadlineAt, 'before custom combobox mutation');
      let comboRes: any = null;
      if (numericIndex !== undefined && numericIndex > 0) {
        const res = await executeWithBudget(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageSelectCustomCombobox',
          [numericIndex, undefined, textToFill],
        );
        comboRes = res?.[0]?.result;
      } else if (selectorOrRef) {
        const res = await executeWithBudget(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageSelectCustomCombobox',
          [undefined, selectorOrRef, textToFill],
        );
        comboRes = res?.[0]?.result;
      }

      const resObj: PhysicalFillResult = {
        success: comboRes?.success !== false && comboRes?.committed !== false,
        committed: comboRes?.committed ?? comboRes?.success !== false,
        index: numericIndex,
        ref: options.target,
        selector: selectorOrRef,
        filledText: comboRes?.selectedText || textToFill,
        isTrusted: false,
        method: 'widget_native',
        tagName: coords?.tagName || 'div',
        inputType: 'combobox',
        resolutionPath,
        diagnostics: comboRes?.error || comboRes?.diagnostics,
        error:
          comboRes?.success === false
            ? comboRes?.error || 'Custom combobox selection failed'
            : undefined,
      };

      if (submit && resObj.success) {
        await handleAutoSubmit(
          tabId,
          resObj,
          options.submitTarget!,
          sessionId,
          deadlineAt,
          signal,
          options.taskId,
        );
      }
      if (handoverTracker) {
        const handover = await handoverTracker.waitForHandover(
          Math.min(800, Math.max(0, remainingBudget(deadlineAt) ?? 800)),
        );
        if (handover) {
          resObj.tabHandover = handover;
        }
      }
      return resObj;
    }

    let outcome: any = null;
    throwIfAborted(signal, 'before widget fill mutation');
    assertBudget(deadlineAt, 'before widget fill mutation');
    if (numericIndex !== undefined && numericIndex > 0) {
      const res = await executeWithBudget(
        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
        'inPageFillIndex',
        [numericIndex, textToFill, clear !== false],
      );
      outcome = res?.[0]?.result;

      // Verification
      let vRes: any = null;
      try {
        const verify = await executeWithBudget(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageVerifyInputCommitment',
          [numericIndex, textToFill],
        );
        vRes = verify?.[0]?.result;
      } catch (verifyErr) {
        rethrowIfDeadlineOrUncertain(
          verifyErr,
          deadlineAt,
          'during widget commitment verification',
        );
      }

      if (vRes?.submitButtonState) {
        outcome = outcome || {};
        outcome.submitButtonState = vRes.submitButtonState;
      }
    } else if (selectorOrRef) {
      const selRes = await executeWithBudget(
        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
        'inPageFillSelectorWidget',
        [selectorOrRef, textToFill, clear !== false],
      ).catch(async (widgetErr) => {
        if (widgetErr instanceof TaskCancelledError) throw widgetErr;
        rethrowIfDeadlineOrUncertain(widgetErr, deadlineAt, 'during selector widget primary fill');
        // Fallback for selector widget
        throwIfAborted(signal, 'before selector widget fallback');
        assertBudget(deadlineAt, 'before selector widget fallback');
        return await withDeadline(
          chrome.scripting.executeScript({
            target: targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            func: (sel: string, val: string, shouldClear: boolean) => {
              const el = document.querySelector(sel);
              if (!el) return { success: false, error: `Selector "${sel}" not found` };
              if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement?.prototype || {},
                'value',
              )?.set;
              const nativeCheckboxSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement?.prototype || {},
                'checked',
              )?.set;
              const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement?.prototype || {},
                'value',
              )?.set;

              if (
                el instanceof HTMLInputElement &&
                (el.type === 'checkbox' || el.type === 'radio')
              ) {
                const isTruthy =
                  val === 'true' ||
                  val === '1' ||
                  val === 'checked' ||
                  val === 'on' ||
                  (val !== 'false' && val !== '0' && val !== 'off' && Boolean(val));
                if (nativeCheckboxSetter) nativeCheckboxSetter.call(el, isTruthy);
                else el.checked = isTruthy;
              } else if (el instanceof HTMLInputElement && nativeInputValueSetter) {
                if (shouldClear) nativeInputValueSetter.call(el, '');
                nativeInputValueSetter.call(el, val);
              } else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
                if (shouldClear) nativeTextAreaValueSetter.call(el, '');
                nativeTextAreaValueSetter.call(el, val);
              } else if (el instanceof HTMLSelectElement) {
                let matched = false;
                for (const opt of Array.from(el.options)) {
                  if (opt.value === val || opt.text === val || opt.text.trim() === val.trim()) {
                    el.value = opt.value;
                    matched = true;
                    break;
                  }
                }
                if (!matched) el.value = val;
              } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                if (shouldClear) (el as any).value = '';
                (el as any).value = val;
              } else {
                (el as any).value = val;
              }

              el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              return { success: true, filledText: val };
            },
            args: [selectorOrRef, textToFill, clear !== false],
          }),
          deadlineAt,
          'during selector widget fallback',
        );
      });
      outcome = selRes?.[0]?.result;
    }

    const resObj: PhysicalFillResult = {
      success: outcome?.success !== false,
      committed: outcome?.committed ?? outcome?.success !== false,
      index: numericIndex,
      ref: options.target,
      selector: selectorOrRef,
      filledText: textToFill,
      isTrusted: false,
      method: 'widget_native',
      tagName: coords?.tagName,
      inputType: coords?.inputType,
      submitButtonState: outcome?.submitButtonState,
      resolutionPath,
      diagnostics: outcome?.diagnostics || outcome?.error,
    };

    if (submit && resObj.success) {
      await handleAutoSubmit(
        tabId,
        resObj,
        options.submitTarget!,
        sessionId,
        deadlineAt,
        signal,
        options.taskId,
      );
    }
    if (handoverTracker) {
      const handover = await handoverTracker.waitForHandover(
        Math.min(800, Math.max(0, remainingBudget(deadlineAt) ?? 800)),
      );
      if (handover) {
        resObj.tabHandover = handover;
      }
    }
    return resObj;
  }

  // 3. Disambiguation check (Search input vs multi-line post text)
  const isSearchTarget = Boolean(
    coords?.isSearch ||
    coords?.inputType === 'search' ||
    /(search|query|find|sousuo|搜索|查找)/i.test(
      `${coords?.attributes?.name || ''} ${coords?.attributes?.id || ''} ${coords?.attributes?.['aria-label'] || ''} ${coords?.attributes?.placeholder || ''}`,
    ),
  );
  const isMultiLineOrPostText =
    textToFill.includes('\n') ||
    textToFill.length > 60 ||
    /(http|#|@|tweet|post|reply|thread)/i.test(textToFill);

  if (isSearchTarget && isMultiLineOrPostText) {
    const searchNotice = `[Input Disambiguation Notice] Targeted element [${target}] appears to be a search input (searchbox), but the filled text looks like a multi-line post or comment. If you intended to post or reply, verify with ${resolveToolName('read_dom')} to target the [composer] element instead.`;
    disambiguationWarning = disambiguationWarning
      ? `${disambiguationWarning}; ${searchNotice}`
      : searchNotice;
    console.warn(`[performPhysicalFill] ${disambiguationWarning}`);
  }

  // 4. Try CDP native mouse click + Input.insertText (isTrusted: true)
  let outcome: any = null;
  let filledViaCdp = false;
  let appendBaseValue: string | undefined =
    clear === false
      ? typeof coords?.value === 'string'
        ? coords.value
        : typeof coords?.text === 'string'
          ? coords.text
          : ''
      : undefined;
  let expectedCommitment = clear === false ? `${appendBaseValue ?? ''}${textToFill}` : textToFill;

  if (coords?.success && typeof targetX === 'number' && typeof targetY === 'number') {
    throwIfAborted(signal, 'before CDP focus click');
    assertBudget(deadlineAt, 'before CDP focus click');
    const fillNote = formatAgentCursorAction('fill', coords);
    await animateAgentCursor(tabId, targetX, targetY, {
      waitForArrival: true,
      timeoutMs: 350,
      actionNote: fillNote,
    });

    const isKnownEmpty =
      (typeof coords.value === 'string' && coords.value === '') ||
      (coords.value === undefined && (!coords.text || coords.text.trim() === ''));

    let verification: any = null;
    let textWasDispatched = false;

    // Phase M1 Instantaneous Occlusion Circuit Breaker & Live Target Re-resolution
    if (numericIndex !== undefined && numericIndex > 0) {
      const occResult = (
        await executeWithBudget(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageCheckOcclusion',
          [{ node: numericIndex, kind: 'fill' }],
        )
      )?.[0];
      if (occResult && !occResult.result) {
        // If occlusion check failed on index, attempt selector re-resolution if available
        if (effectiveSelector) {
          try {
            const freshLoc = await resolveTargetLocation(tabId, {
              ref: isExplicitRef ? selectorOrRef : undefined,
              selector: effectiveSelector,
              preferComposer,
              frameId: options.frameId,
            });
            if (
              freshLoc.success &&
              typeof freshLoc.x === 'number' &&
              typeof freshLoc.y === 'number'
            ) {
              targetX = freshLoc.x;
              targetY = freshLoc.y;
              if (typeof freshLoc.index === 'number') numericIndex = freshLoc.index;
            } else {
              throw new StalePageError(
                `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
              );
            }
          } catch (e) {
            if (e instanceof StalePageError) throw e;
            throw new StalePageError(
              `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
            );
          }
        } else {
          throw new StalePageError(
            `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
          );
        }
      }
      const occRes = occResult?.result;
      if (occRes && typeof occRes.x === 'number' && typeof occRes.y === 'number') {
        const occX: number = occRes.x;
        const occY: number = occRes.y;
        if (targetX !== occX || targetY !== occY) {
          targetX = occX;
          targetY = occY;
          await animateAgentCursor(tabId, occX, occY, {
            waitForArrival: true,
            timeoutMs: 350,
            immediate: false,
          });
        }
      }
    } else if (effectiveSelector || selectorOrRef) {
      try {
        const freshLoc = await resolveTargetLocation(tabId, {
          ref: isExplicitRef ? selectorOrRef : undefined,
          selector: effectiveSelector,
          preferComposer,
          frameId: options.frameId,
        });
        if (freshLoc.success && typeof freshLoc.x === 'number' && typeof freshLoc.y === 'number') {
          if (targetX !== freshLoc.x || targetY !== freshLoc.y) {
            targetX = freshLoc.x;
            targetY = freshLoc.y;
            await animateAgentCursor(tabId, targetX, targetY, {
              waitForArrival: true,
              timeoutMs: 350,
              immediate: false,
            });
          }
          if (typeof freshLoc.index === 'number') numericIndex = freshLoc.index;
        }
      } catch {}
    }

    try {
      throwIfAborted(signal, 'before CDP fill mutation');
      assertBudget(deadlineAt, 'before CDP fill mutation');
      await cdpSessionManager.withSession(tabId, 'fill-core', async () => {
        // Humanized micro-trajectory (bounded tightly within proximity window)
        const startX = Math.max(0, targetX! - (15 + Math.floor(Math.random() * 15)));
        const startY = Math.max(0, targetY! - (10 + Math.floor(Math.random() * 12)));
        const points = computeHumanizedPoints(startX, startY, targetX!, targetY!, 3);
        for (const pt of points) {
          await raceInput(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: pt.x,
            y: pt.y,
          });
          await delayWithinBudget(10, deadlineAt);
        }

        // Mouse click to focus
        await animateAgentCursorClick(tabId, targetX, targetY, fillNote);
        let focusPressDispatched = false;
        const focusGuard = createMousePressGuard(
          async (eventParams) => {
            if (eventParams.type === 'mousePressed') {
              await assertObservedTarget(tabId, numericIndex, targetFrameId, options.expectedGuard);
              throwIfAborted(signal, 'after observed fill target validation');
              focusPressDispatched = true;
            }
            if (options.expectedGuard !== undefined && !focusPressDispatched) return;
            return raceInput(tabId, 'Input.dispatchMouseEvent', eventParams);
          },
          {
            type: 'mouseReleased',
            x: targetX,
            y: targetY,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          },
        );
        try {
          await focusGuard.press({
            type: 'mousePressed',
            x: targetX,
            y: targetY,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          await delayWithinBudget(35, deadlineAt);
          await focusGuard.release();
        } finally {
          await focusGuard.compensate();
        }

        // Click settling pause for composers
        await delayWithinBudget(50, deadlineAt);

        // Active Element Focus Guard: strictly verify via in-page check that document.activeElement is target
        const focusCheck = (
          await executeWithBudget(
            targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            'inPageVerifyActiveElement',
            [numericIndex, effectiveSelector || selectorOrRef],
          )
        )?.[0]?.result;

        if (focusCheck && focusCheck.isFocused === false) {
          throw new FocusVerificationError(
            focusCheck.error ||
              `Focus verification failed: target element [${target}] could not be focused (activeElement is <${focusCheck.activeTag || 'unknown'}>). Aborting typing to prevent misdirected input.`,
          );
        }

        if (clear === false && numericIndex !== undefined) {
          if (coords?.inputType === 'number') {
            throw new Error('Number inputs require the synthetic append path');
          }
          const prepared = (
            await executeWithBudget(
              targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
              'inPagePrepareAppend',
              [numericIndex],
            )
          )?.[0]?.result;
          if (!prepared?.success) {
            throw new Error(
              prepared?.error || `Cannot prepare element [${numericIndex}] for append`,
            );
          }
          appendBaseValue = String(prepared.currentValue ?? '');
          expectedCommitment = `${appendBaseValue}${textToFill}`;
        }

        if (clear === true || (clear !== false && !isKnownEmpty)) {
          await dispatchNativeSelectAll(tabId, nestedTimeout(deadlineAt));
          if (!textToFill) {
            await raceInput(tabId, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 8,
              key: 'Backspace',
              code: 'Backspace',
            });
            textWasDispatched = true;
            await raceInput(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              windowsVirtualKeyCode: 8,
              key: 'Backspace',
              code: 'Backspace',
            });
          }
        }

        // Whole-text insertion preserves linebreaks without triggering Enter handlers.
        if (textToFill) {
          await raceInput(tabId, 'Input.insertText', { text: String(textToFill) });
          textWasDispatched = true;
        }

        // Settle React/Vue microtasks
        await delayWithinBudget(40, deadlineAt);

        // True Input Commitment verification
        if (numericIndex !== undefined) {
          try {
            const vRes = await executeWithBudget(
              targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
              'inPageVerifyInputCommitment',
              [numericIndex, expectedCommitment],
            );
            verification = vRes?.[0]?.result;
          } catch (verifyErr) {
            rethrowIfDeadlineOrUncertain(
              verifyErr,
              deadlineAt,
              'during initial commitment verification',
            );
          }

          if (!verification || typeof verification.committed !== 'boolean') {
            throw new PostDispatchCommitmentError(
              'Input verification returned no committed state after native editing; not retrying',
              verification,
            );
          }

          if (verification && verification.committed === false) {
            await new Promise((r) => setTimeout(r, 60));
            try {
              const retryRes = await executeWithBudget(
                targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
                'inPageVerifyInputCommitment',
                [numericIndex, expectedCommitment],
              );
              if (retryRes?.[0]?.result) {
                verification = retryRes[0].result;
              }
            } catch (retryErr) {
              rethrowIfDeadlineOrUncertain(
                retryErr,
                deadlineAt,
                'during commitment verification retry',
              );
            }
          }

          if (verification && verification.committed === false) {
            throw new PostDispatchCommitmentError(
              `Input commitment failed after native editing (observed length ${verification.currentValue?.length ?? 0}, expected length ${expectedCommitment.length}, committed=false); not retrying`,
              verification,
            );
          }
        }

        // pressEnter if requested
        if (pressEnter) {
          assertBudget(deadlineAt, 'before pressEnter mutation');
          await raceInput(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            text: '\r',
            unmodifiedText: '\r',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await raceInput(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        }
      });

      outcome = {
        success: true,
        committed: true,
        index: numericIndex,
        ref: options.target,
        selector: selectorOrRef,
        filledText: textToFill,
        isTrusted: true,
        method: 'cdp_native',
        tagName: coords?.tagName,
        inputType: coords?.inputType,
        isComposer: coords?.isComposer,
        isEditor: coords?.isEditor,
        isSearch: coords?.isSearch,
        submitButtonState: verification?.submitButtonState,
        disambiguationWarning,
        resolutionPath,
        ...(pressEnter ? { pressEnterDispatched: true } : {}),
      };
      filledViaCdp = true;
    } catch (cdpErr) {
      if (cdpErr instanceof TaskCancelledError) {
        throw cdpErr;
      }
      if (cdpErr instanceof FillDeadlineExceededError) {
        throw cdpErr;
      }
      if (cdpErr instanceof FocusVerificationError) {
        return {
          success: false,
          committed: false,
          index: numericIndex,
          ref: options.target,
          selector: selectorOrRef,
          filledText: textToFill,
          isTrusted: false,
          method: 'cdp_native',
          error: cdpErr.message,
          diagnostics: cdpErr.message,
          resolutionPath,
        };
      }
      if (cdpErr instanceof PostDispatchCommitmentError) {
        const diagnostics = cdpErr.message;
        return {
          success: false,
          committed: false,
          index: numericIndex,
          ref: options.target,
          selector: selectorOrRef,
          filledText: textToFill,
          isTrusted: false,
          method: 'cdp_native',
          status: 'unknown',
          retry: false,
          error: cdpErr.message,
          diagnostics,
          resolutionPath,
        };
      }
      if (cdpErr instanceof DialogOpenedError) {
        throw cdpErr;
      }
      if (cdpErr instanceof StalePageError) {
        throw cdpErr;
      }
      if (isCdpOutcomeUncertainError(cdpErr)) {
        // The native fill may already have committed; a synthetic retry could
        // concatenate the same text, so fail closed instead.
        if (clear === false) {
          const message =
            'Append input outcome is unknown after dispatch; inspect the field and do not retry';
          return {
            success: false,
            committed: false,
            index: numericIndex,
            ref: options.target,
            selector: selectorOrRef,
            filledText: textToFill,
            isTrusted: false,
            method: 'cdp_native',
            status: 'unknown',
            retry: false,
            error: message,
            diagnostics: message,
            resolutionPath,
          };
        }
        throw cdpErr;
      }
      if (textWasDispatched) {
        const observedLength =
          typeof verification?.currentValue === 'string'
            ? verification.currentValue.length
            : 'unknown';
        return {
          success: false,
          committed: false,
          index: numericIndex,
          ref: options.target,
          selector: selectorOrRef,
          filledText: textToFill,
          isTrusted: false,
          method: 'cdp_native',
          status: 'unknown',
          retry: false,
          error: `Text was dispatched, but post-dispatch validation failed (observed length ${observedLength}, expected length ${expectedCommitment.length}); not retrying`,
          diagnostics: `Text was dispatched, but post-dispatch validation failed (observed length ${observedLength}, expected length ${expectedCommitment.length}); not retrying`,
          resolutionPath,
        };
      }
      console.warn(
        `[performPhysicalFill] CDP native fill failed on target [${target}], falling back to inPageFillIndex:`,
        cdpErr,
      );
    }
  }

  // 5. Fallback to in-page synthetic fill
  if (!filledViaCdp) {
    throwIfAborted(signal, 'before synthetic fill fallback');
    assertBudget(deadlineAt, 'before synthetic fill fallback');
    if (numericIndex !== undefined && numericIndex > 0) {
      const scopedTarget =
        options.frameId !== undefined
          ? { tabId, frameIds: [options.frameId] }
          : targetFrameId
            ? { tabId, frameIds: [targetFrameId] }
            : { tabId };
      const results = await executeWithBudget(scopedTarget, 'inPageFillIndex', [
        numericIndex,
        textToFill,
        clear !== false,
        pressEnter,
      ]);
      outcome = results?.[0]?.result;
      if ((!outcome || !outcome.success) && options.frameId === undefined && targetFrameId === 0) {
        const frameResults = await executeWithBudget(
          { tabId, allFrames: true },
          'inPageFillIndex',
          [numericIndex, textToFill, clear !== false, pressEnter],
        );
        const match = frameResults.find((r) => r.result?.success);
        if (match?.result) outcome = match.result;
      }
      if (outcome && typeof outcome === 'object') {
        outcome.index = numericIndex;
        outcome.ref = options.target;
        outcome.filledText = textToFill;
        outcome.method = 'synthetic_inpage';
        outcome.isTrusted = false;
        outcome.resolutionPath = resolutionPath;

        let fallbackVerify: any = null;
        try {
          const vRes = await executeWithBudget(
            targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            'inPageVerifyInputCommitment',
            [numericIndex, expectedCommitment],
          );
          fallbackVerify = vRes?.[0]?.result;
        } catch (fallbackVerifyErr) {
          rethrowIfDeadlineOrUncertain(
            fallbackVerifyErr,
            deadlineAt,
            'during synthetic fallback verification',
          );
        }

        if (textToFill && fallbackVerify && fallbackVerify.committed === false) {
          outcome.committed = false;
          outcome.diagnostics = fallbackVerify.diagnostics;
          outcome.submitButtonState = fallbackVerify.submitButtonState;
        } else {
          outcome.committed = true;
          if (fallbackVerify?.submitButtonState) {
            outcome.submitButtonState = fallbackVerify.submitButtonState;
          }
        }
      }
    } else if (selectorOrRef) {
      // In-page synthetic fallback for selector/ref targets
      try {
        const selRes = await withDeadline(
          chrome.scripting.executeScript({
            target: targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            func: (sel: string, val: string, shouldClear: boolean) => {
              const el = document.querySelector(sel);
              if (!el) return { success: false, error: `Selector "${sel}" not found` };
              if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

              const isContentEditable =
                (el as HTMLElement).isContentEditable ||
                el.getAttribute('contenteditable') === 'true' ||
                el.getAttribute('contenteditable') === '';

              if (isContentEditable) {
                const editEl = el as HTMLElement;
                editEl.focus();
                if (shouldClear) {
                  const doc = editEl.ownerDocument || document;
                  const selObj = (doc.defaultView || window).getSelection();
                  const range = doc.createRange();
                  range.selectNodeContents(editEl);
                  selObj?.removeAllRanges();
                  selObj?.addRange(range);
                  try {
                    doc.execCommand('delete', false);
                  } catch {}
                  editEl.innerText = '';
                }
                if (!shouldClear) {
                  const doc = editEl.ownerDocument || document;
                  const selection = (doc.defaultView || window).getSelection();
                  if (selection) {
                    const range = doc.createRange();
                    range.selectNodeContents(editEl);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                  }
                }
                const beforeText = String(editEl.innerText ?? editEl.textContent ?? '');
                let inserted = false;
                try {
                  inserted = document.execCommand('insertText', false, val);
                } catch {}
                if (!inserted) {
                  const afterText = String(editEl.innerText ?? editEl.textContent ?? '');
                  if (shouldClear) {
                    editEl.innerText = val;
                  } else if (afterText === beforeText) {
                    editEl.appendChild(document.createTextNode(val));
                  }
                }
                editEl.dispatchEvent(
                  new InputEvent('input', {
                    bubbles: true,
                    composed: true,
                    inputType: 'insertText',
                    data: val,
                  }),
                );
                editEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                return { success: true, filledText: val };
              }

              const getNativeSetter = (element: any, prop: string) => {
                let proto = Object.getPrototypeOf(element);
                while (proto) {
                  const desc = Object.getOwnPropertyDescriptor(proto, prop);
                  if (desc?.set) return desc.set;
                  proto = Object.getPrototypeOf(proto);
                }
                return null;
              };

              const nativeValSetter = getNativeSetter(el, 'value');
              const nativeChkSetter = getNativeSetter(el, 'checked');

              if (
                el instanceof HTMLInputElement &&
                (el.type === 'checkbox' || el.type === 'radio')
              ) {
                const isTruthy =
                  val === 'true' ||
                  val === '1' ||
                  val === 'checked' ||
                  val === 'on' ||
                  (val !== 'false' && val !== '0' && val !== 'off' && Boolean(val));
                if (nativeChkSetter) nativeChkSetter.call(el, isTruthy);
                else el.checked = isTruthy;
              } else if (el instanceof HTMLSelectElement) {
                let matched = false;
                for (const opt of Array.from(el.options)) {
                  if (opt.value === val || opt.text === val || opt.text.trim() === val.trim()) {
                    el.value = opt.value;
                    matched = true;
                    break;
                  }
                }
                if (!matched) el.value = val;
              } else if (nativeValSetter) {
                const currentValue = String((el as any).value ?? '');
                nativeValSetter.call(el, shouldClear ? val : `${currentValue}${val}`);
              } else {
                const currentValue = String((el as any).value ?? '');
                (el as any).value = shouldClear ? val : `${currentValue}${val}`;
              }

              el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              return { success: true, filledText: val };
            },
            args: [selectorOrRef, textToFill, clear !== false],
          }),
          deadlineAt,
          'during synthetic selector fill',
        );
        const scriptResult = selRes?.[0]?.result;
        if (scriptResult && typeof scriptResult === 'object') {
          outcome = {
            ...scriptResult,
            ref: options.target,
            selector: selectorOrRef,
            filledText: textToFill,
            method: 'synthetic_inpage',
            isTrusted: false,
            resolutionPath: resolutionPath || 'synthetic_selector',
            committed: scriptResult.success === true,
          };
        }
      } catch (selErr) {
        if (selErr instanceof TaskCancelledError) throw selErr;
        if (selErr instanceof FillDeadlineExceededError) throw selErr;
        outcome = {
          success: false,
          error: `Selector fill error: ${selErr instanceof Error ? selErr.message : String(selErr)}`,
        };
      }
    }
  }

  if (!outcome || !outcome.success || outcome.committed === false) {
    return {
      success: false,
      committed: false,
      index: numericIndex,
      ref: options.target,
      selector: selectorOrRef,
      filledText: textToFill,
      isTrusted: false,
      method: 'synthetic_inpage',
      error:
        outcome?.error ||
        outcome?.diagnostics ||
        `Failed to commit text into element target [${target}]`,
      diagnostics: outcome?.diagnostics,
      resolutionPath,
    };
  }

  const resObj: PhysicalFillResult = {
    success: true,
    committed: true,
    index: numericIndex,
    ref: options.target,
    selector: selectorOrRef,
    filledText: textToFill,
    isTrusted: Boolean(outcome.isTrusted),
    method: outcome.method || 'cdp_native',
    tagName: coords?.tagName || outcome.tagName,
    inputType: coords?.inputType || outcome.inputType,
    isComposer: coords?.isComposer || outcome.isComposer,
    isEditor: coords?.isEditor || outcome.isEditor,
    isSearch: coords?.isSearch || outcome.isSearch,
    submitButtonState: outcome.submitButtonState,
    submitted: outcome.submitted,
    submitMethod: outcome.submitMethod,
    submitResult: outcome.submitResult,
    pressEnterDispatched: outcome.pressEnterDispatched,
    disambiguationWarning,
    resolutionPath,
  };

  // Record successful mutating action in history for undo capability
  if (resObj.success && typeof coords?.value === 'string' && numericIndex !== undefined) {
    actionHistoryManager.pushAction(tabId, {
      type: 'fill',
      frameId: targetFrameId,
      index: numericIndex,
      selector: typeof options.target === 'string' && !isNumericIndex ? options.target : undefined,
      prevValue: coords.value,
      timestamp: Date.now(),
    });
  }

  // 6. Handle auto-submit if requested (and not already submitted via pressEnter)
  if (submit && resObj.success && !resObj.submitted) {
    await handleAutoSubmit(
      tabId,
      resObj,
      options.submitTarget!,
      sessionId,
      deadlineAt,
      signal,
      options.taskId,
    );
  }

  if (handoverTracker) {
    const handover = await handoverTracker.waitForHandover(
      Math.min(800, Math.max(0, remainingBudget(deadlineAt) ?? 800)),
    );
    if (handover) {
      resObj.tabHandover = handover;
    }
  }

  return resObj;
}

/**
 * Dispatches the caller-specified submit target through the normal trusted
 * click path. A failed or unknown click is never converted into Enter.
 */
async function handleAutoSubmit(
  tabId: number,
  result: PhysicalFillResult,
  submitTarget: NonNullable<PhysicalFillOptions['submitTarget']>,
  sessionId?: string,
  deadlineAt?: number,
  signal?: AbortSignal,
  taskId?: string,
): Promise<void> {
  result.autoSubmitHandled = true;
  if (result.submitted) return;

  try {
    throwIfAborted(signal, 'before explicit submit');
    assertBudget(deadlineAt, 'before explicit submit');
    const { clickTool } = await import('./interaction');
    const { ref, ...submitArgs } = submitTarget;
    const explicitTarget: Record<string, unknown> =
      typeof ref === 'number' && submitArgs.index === undefined
        ? { ...submitArgs, index: ref }
        : { ...submitTarget };
    const clickResult = await withDeadline(
      clickTool.execute(
        {
          ...explicitTarget,
          tabId,
          sessionId,
          ...(typeof deadlineAt === 'number' ? { expectedDeadlineAt: deadlineAt } : {}),
        },
        { signal, taskId },
      ),
      deadlineAt,
      'during explicit submit click',
    );

    const rawText = clickResult.content[0]?.type === 'text' ? clickResult.content[0].text : '';
    let submitSummary: any = rawText;
    try {
      submitSummary = JSON.parse(rawText);
    } catch {}
    const outcomeUnknown =
      submitSummary &&
      typeof submitSummary === 'object' &&
      (submitSummary.status === 'unknown' ||
        (submitSummary.requestDispatched === true &&
          submitSummary.success === false &&
          submitSummary.status !== 'blocked' &&
          submitSummary.status !== 'cancelled'));
    const outcomeFailed =
      clickResult.isError ||
      (submitSummary &&
        typeof submitSummary === 'object' &&
        (submitSummary.success === false || submitSummary.status === 'blocked'));

    result.submitMethod = 'click';
    result.submittedButtonIndex = submitTarget.index;
    result.submitResult = submitSummary || clickResult;
    if (typeof (clickResult as any).receipt !== 'undefined') {
      (result as any).submitReceipt = (clickResult as any).receipt;
    }

    if (outcomeUnknown) {
      result.success = false;
      result.status = 'unknown';
      result.retry = false;
      result.submitted = false;
      result.submitResult = {
        ...(submitSummary && typeof submitSummary === 'object' ? submitSummary : {}),
        success: false,
        status: 'unknown',
        retry: false,
      };
      return;
    }

    if (outcomeFailed) {
      result.success = false;
      result.status = 'blocked';
      result.submitted = false;
      result.submitResult = {
        ...(submitSummary && typeof submitSummary === 'object'
          ? submitSummary
          : { message: rawText }),
        success: false,
        status: 'blocked',
      };
      return;
    }

    // Click dispatch is known. This still does not claim server-side or
    // business acceptance; callers must verify the resulting page state.
    result.submitted = true;
  } catch (error) {
    if (error instanceof FillDeadlineExceededError) {
      result.success = false;
      result.status = error.outcome === 'not_started' ? 'timeout' : 'unknown';
      result.timedOut = true;
      result.deadlineExceeded = true;
      result.submitted = false;
      result.retry = false;
      result.submitMethod = 'click';
      result.submitResult = {
        success: false,
        status: result.status,
        retry: false,
        timedOut: true,
        message: error.message,
      };
      return;
    }
    throw error;
  }
}
