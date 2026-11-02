/**
 * Fast Decision Engine conforming to §4, §5, §6
 * Bounded semantic micro-loop inside Native Server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ActTowardGoalParams,
  ActTowardGoalResult,
  ActTowardGoalStatus,
  DecisionEngineType,
  FallbackReason,
  FastDecisionRunOptions,
  JevHistoryItem,
  JevPageState,
  PausedBeforeAction,
  StepRecord,
  VerificationResult,
} from './types';
import {
  JevClientWrapper,
  buildState,
  extractTextPayload,
  extractVisualTargetDescription,
  parseScreenshotContent,
  validateBoxCoordinates,
  getTop3Probabilities,
  isDestructiveTarget,
  isSessionKeyInvalid,
} from './jev-client';
import { runVerifications } from './verification';
import { classifySemanticAnswer } from './semantic-match';
import { buildStepCandidates } from './step-candidates';
import { tryParseCallResult } from '../browser-tasks';
import { jevModelManager } from '../server/jev-model-manager';

/**
 * Match element text or action against configured safety breakpoints.
 */
export function findMatchingPauseKeyword(targetText: string, keywords?: string[]): string | null {
  if (!targetText || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return null;
  }
  const textLower = targetText.toLowerCase();
  for (const kw of keywords) {
    if (!kw || typeof kw !== 'string') continue;
    const cleanKw = kw.trim();
    if (!cleanKw) continue;

    if (/^[a-zA-Z0-9_-]+$/.test(cleanKw)) {
      const escaped = cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      if (regex.test(targetText)) {
        return cleanKw;
      }
    } else {
      const kwLower = cleanKw.toLowerCase();
      if (textLower.includes(kwLower)) {
        return cleanKw;
      }
    }
  }
  return null;
}

function checkConsecutiveStuck(history: JevHistoryItem[]): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  return last3.every(
    (h) =>
      h.action === last3[0].action &&
      h.outcome.includes('urlChanged:false') &&
      h.outcome.includes('mutated:false'),
  );
}

export class FastDecisionEngine {
  private jevClient: JevClientWrapper;

  constructor(apiKey?: string) {
    this.jevClient = new JevClientWrapper(apiKey);
  }

  /**
   * Run semantic micro-loop toward goal
   */
  public async run(
    params: ActTowardGoalParams,
    internalCaller: (
      toolName: string,
      args: any,
      context?: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<any>,
    server?: Server,
    options?: FastDecisionRunOptions,
  ): Promise<ActTowardGoalResult> {
    jevModelManager.touchActivity();
    const signal = options?.signal;
    const globalMode = jevModelManager.getActiveMode();
    const initialMode = jevModelManager.captureModeToken();

    const steps: StepRecord[] = [];
    const history: JevHistoryItem[] = [];
    let finalPage: JevPageState = { url: '', title: '' };
    let currentElements: string[] = [];

    let jevCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let visionCalls = 0;
    let totalTextLatencyMs = 0;
    let totalVisionLatencyMs = 0;
    let visualClickExecuted = false;
    let visionModelUsed: string | undefined;
    let textModelUsed: string | undefined;
    let inferenceAttempts = 0;
    let successfulRequests = 0;
    let usageIncomplete = false;
    let lastReceipt: any = undefined;

    const finish = (...args: Parameters<typeof this.formatResult>): ActTowardGoalResult => {
      args[11] = {
        visionCalls,
        textLatencyMs: totalTextLatencyMs,
        visionLatencyMs: totalVisionLatencyMs,
        ...(visionModelUsed ? { visionModel: visionModelUsed } : {}),
        attempts: inferenceAttempts,
        successfulRequests,
        outputTokens,
        ...(globalMode !== 'off' ? { backend: globalMode } : {}),
        ...(textModelUsed ? { model: textModelUsed } : {}),
        ...(usageIncomplete ? { usageIncomplete: true } : {}),
      };
      return this.formatResult(...args);
    };

    // Strict mode check: global off blocks immediately
    if (globalMode === 'off') {
      return finish(
        'blocked',
        'jev',
        false,
        'jev_disabled',
        'Jev autonomous micro-loop is disabled (mode is off)',
        steps,
        finalPage,
        currentElements,
        0,
        0,
        undefined,
        undefined,
        { success: false, retry: false, requestDispatched: false },
      );
    }

    // Reject mode mismatch before any service setup or startup occurs
    if (params.mode && params.mode !== globalMode) {
      return finish(
        'blocked',
        'jev',
        false,
        'mode_mismatch',
        'Requested model mode differs from the enabled backend',
        steps,
        finalPage,
        currentElements,
        0,
        0,
        undefined,
        undefined,
        { success: false, retry: false, requestDispatched: false },
      );
    }

    const currentMode = globalMode;

    if (currentMode === 'remote') {
      const hasKey = Boolean(this.jevClient.getRemoteClient());
      if (!hasKey || isSessionKeyInvalid()) {
        const fallbackReason: FallbackReason = isSessionKeyInvalid() ? 'invalid_key' : 'no_api_key';
        jevModelManager.disableIfCurrent(jevModelManager.captureModeToken(), fallbackReason);
        return finish(
          'blocked',
          'jev',
          false,
          fallbackReason,
          isSessionKeyInvalid()
            ? 'Session API key is invalid'
            : 'No TYPESAFE_API_KEY configured for remote Jev',
          steps,
          finalPage,
          currentElements,
          0,
          0,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: false },
        );
      }
    }

    let maxSteps = typeof params.maxSteps === 'number' ? params.maxSteps : 10;
    maxSteps = Math.min(Math.max(1, maxSteps), 60);

    const startTime = Date.now();
    const timeoutMs = Math.min(Math.max(1, Math.floor(params.timeoutMs ?? 90_000)), 300_000);
    const effectiveDeadline =
      typeof params.deadline === 'number'
        ? Math.min(params.deadline, startTime + timeoutMs)
        : startTime + timeoutMs;
    const expired = () => Date.now() >= effectiveDeadline || Boolean(signal?.aborted);
    const confidenceThreshold = Math.max(0.85, params.confidenceThreshold ?? 0.85);

    const sendProgress = (stepNum: number, desc: string) => {
      if (
        server &&
        typeof (server as any).notification === 'function' &&
        params._meta?.progressToken !== undefined
      ) {
        (server as any)
          .notification({
            method: 'notifications/progress',
            params: {
              progressToken: params._meta.progressToken,
              progress: stepNum,
              total: maxSteps,
              message: 'Step ' + stepNum + '/' + maxSteps + ': ' + desc,
            },
          })
          .catch(() => {});
      }
    };

    if (signal?.aborted) {
      return finish(
        'cancelled',
        'jev',
        false,
        null,
        'Execution cancelled by signal before start',
        steps,
        finalPage,
        currentElements,
        jevCalls,
        inputTokens,
        undefined,
        undefined,
        { success: false, retry: false, requestDispatched: false },
      );
    }

    const executionSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, effectiveDeadline - Date.now()))])
      : AbortSignal.timeout(Math.max(1, effectiveDeadline - Date.now()));
    let chainedObservation: any;
    const safeCaller = async (name: string, args: any): Promise<any> => {
      const readOnly = [
        'chrome_read_dom',
        'chrome_screenshot',
        'chrome_get_dropdown_options',
        'chrome_network_request',
      ].includes(name);
      if (jevModelManager.captureModeToken().revision !== initialMode.revision) {
        throw Object.assign(new Error('Decision model configuration changed; execution stopped'), {
          status: 'cancelled',
          requestDispatched: false,
        });
      }
      if (Date.now() >= effectiveDeadline)
        throw Object.assign(new Error('Execution deadline exceeded'), {
          status: 'timeout',
          requestDispatched: false,
        });
      if (signal?.aborted) {
        throw Object.assign(new Error('Operation cancelled by signal'), {
          status: 'cancelled',
          requestDispatched: false,
        });
      }
      let res: any;
      try {
        res = await internalCaller(name, args, {
          signal: executionSignal,
          timeoutMs: Math.max(1, effectiveDeadline - Date.now()),
        });
        lastReceipt = res;
      } catch (err: any) {
        lastReceipt = err;
        if (err?.status === 'cancelled' || signal?.aborted) {
          throw Object.assign(err, { status: 'cancelled' });
        }
        if (err?.status === 'unknown' || err?.requestDispatched === true) {
          throw Object.assign(err, { status: 'unknown', requestDispatched: true });
        }
        if (
          !readOnly &&
          err?.requestDispatched !== false &&
          err?.dispatched !== false &&
          err?.status !== 'blocked'
        ) {
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
            status: 'unknown',
            requestDispatched: true,
          });
        }
        throw err;
      }

      const parsed = tryParseCallResult(res);
      const effStatus = res?.status || parsed?.status;
      const effDispatched =
        typeof res?.requestDispatched === 'boolean'
          ? res.requestDispatched
          : typeof parsed?.requestDispatched === 'boolean'
            ? parsed.requestDispatched
            : typeof (parsed as any)?.dispatched === 'boolean'
              ? (parsed as any).dispatched
              : true;

      if (effStatus === 'cancelled' || (effStatus === 'timeout' && readOnly)) {
        throw Object.assign(new Error(String(parsed?.error || `Tool call ${effStatus}`)), {
          status: effStatus,
          requestDispatched: effDispatched,
          receipt: res,
        });
      }

      if (effStatus === 'unknown') {
        throw Object.assign(
          new Error(String(parsed?.error || 'Tool call returned unknown state')),
          {
            status: 'unknown',
            requestDispatched: effDispatched,
            receipt: res,
          },
        );
      }
      if (res?.isError === true || parsed?.success === false || parsed?.isError === true) {
        const mutation = !readOnly;
        const uncertain =
          mutation && parsed?.dispatched !== false && parsed?.requestDispatched !== false;
        throw Object.assign(
          new Error(String(parsed?.error || parsed?.reason || this.parseOutcome(res))),
          {
            status: uncertain ? 'unknown' : 'blocked',
            requestDispatched: uncertain,
            receipt: res,
          },
        );
      }

      const observation: any = parsed?.goalObservation;
      if (
        ['chrome_interact_index', 'chrome_fill_index'].includes(name) &&
        Array.isArray(args.expectedGuard) &&
        Number.isInteger(params.tabId) &&
        observation?.tabId === params.tabId &&
        Array.isArray(observation?.result?.content)
      ) {
        chainedObservation = observation.result;
      }
      return res;
    };

    const verifyCompletion = () =>
      runVerifications(
        params.verification,
        (name, args) => {
          if (args?.tabId !== undefined && args.tabId !== params.tabId) {
            throw new Error('Verification must observe the current task page');
          }
          return safeCaller(name, {
            ...args,
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
        },
        executionSignal,
      );

    const tryComplete = async (
      source: string,
      checked?: Awaited<ReturnType<typeof runVerifications>>,
    ): Promise<ActTowardGoalResult> => {
      if (
        params.verification &&
        Array.isArray(params.verification) &&
        params.verification.length > 0
      ) {
        const vRes = checked ?? (await verifyCompletion());
        if (vRes.allPassed) {
          return finish(
            'done',
            'jev',
            false,
            null,
            'Goal accomplished and verified (' + source + ')',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            {
              success: true,
              verification: vRes.results,
              lastReceipt: vRes.rawReceipt || lastReceipt,
            },
          );
        } else {
          return finish(
            vRes.status || 'escalate',
            'jev',
            false,
            null,
            'Goal verification failed: ' + vRes.error,
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            {
              success: false,
              retry: false,
              verification: vRes.results,
              lastReceipt: vRes.rawReceipt || lastReceipt,
            },
          );
        }
      }
      return finish(
        'escalate',
        'jev',
        false,
        null,
        'Goal completion requires verification; model or keyword done alone is prohibited (' +
          source +
          ')',
        steps,
        finalPage,
        currentElements,
        jevCalls,
        inputTokens,
        undefined,
        undefined,
        { success: false, lastReceipt },
      );
    };

    const verifyProgress = async () => {
      if (!params.verification?.length) return;
      const checked = await verifyCompletion();
      // Only an unmet assertion permits another step; failed reads must stop.
      if (checked.allPassed || !checked.unmet) return tryComplete('confirmed action', checked);
    };

    const visionAllowed = () =>
      currentMode === 'remote' &&
      jevModelManager.getActiveMode() === 'remote' &&
      Boolean(this.jevClient.getRemoteClient()) &&
      !isSessionKeyInvalid();

    const executeVisionFallback = async (
      currentStep: number,
      reasonTrigger: string,
      proposedAction?: string,
    ): Promise<{ handled: boolean; result?: ActTowardGoalResult }> => {
      if (
        !visionAllowed() ||
        (proposedAction && proposedAction !== 'click' && proposedAction !== 'wait')
      ) {
        return { handled: false };
      }
      const targetDesc = extractVisualTargetDescription(params.goal);
      if (!targetDesc) return { handled: false };
      const halt = (status: ActTowardGoalStatus, reason: string, pause?: PausedBeforeAction) => ({
        handled: true,
        result: finish(
          status,
          'jev',
          false,
          null,
          reason,
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          pause,
          undefined,
          {
            success: false,
            retry: false,
            lastReceipt,
            requestDispatched:
              status === 'unknown' ||
              steps.length > 0 ||
              lastReceipt?.requestDispatched === true ||
              tryParseCallResult(lastReceipt)?.requestDispatched === true,
          },
        ),
      });
      if (visualClickExecuted) {
        return halt(
          'escalate',
          'Visual click already executed; verify the result before acting again',
        );
      }
      if (expired()) return halt('timeout', 'Execution deadline exceeded before vision capture');
      const matchedKeyword = findMatchingPauseKeyword(targetDesc, params.pauseBeforeKeywords);
      if (matchedKeyword) {
        return halt('paused', 'Visual target matches pause keyword "' + matchedKeyword + '"', {
          action: 'click',
          target: targetDesc,
          matchedKeyword,
        });
      }
      if (isDestructiveTarget(targetDesc)) {
        return halt('escalate', 'Visual target matched destructive keyword; requires confirmation');
      }

      const probeRemaining = Math.min(effectiveDeadline - Date.now(), 30_000);
      if (probeRemaining <= 0)
        return halt('timeout', 'Execution deadline exceeded before vision probe');
      const probeSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(probeRemaining)])
        : AbortSignal.timeout(probeRemaining);
      inferenceAttempts++;
      const visionModel = await this.jevClient.resolveBoxCapableModel(
        probeSignal,
        probeRemaining,
        (probeUsage) => {
          successfulRequests++;
          jevCalls++;
          inputTokens += probeUsage.inputTokens;
          usageIncomplete = true;
          totalTextLatencyMs += probeUsage.latencyMs;
        },
      );
      if (probeSignal.aborted || expired()) {
        return halt('timeout', 'Execution deadline exceeded during vision capability probe');
      }
      if (!visionModel) {
        return { handled: false };
      }
      visionModelUsed = visionModel;
      if (!visionAllowed()) {
        return halt('escalate', 'Vision consent or remote mode was revoked');
      }

      sendProgress(currentStep, 'Capturing screenshot for vision fallback (' + reasonTrigger + ')');
      const shotBudget = effectiveDeadline - Date.now();
      if (shotBudget <= 0)
        return halt('timeout', 'Execution deadline exceeded before vision capture');
      let shotRes: any;
      try {
        let shotTimer: NodeJS.Timeout | undefined;
        const shotDeadline = new Promise<null>((resolve) => {
          shotTimer = globalThis.setTimeout(() => resolve(null), shotBudget);
        });
        try {
          shotRes = await Promise.race([
            safeCaller('chrome_screenshot', {
              _jevVision: true,
              tabId: params.tabId,
              sessionId: params.sessionId || params.sessionContext,
              fullPage: false,
              saveToDisk: false,
            }),
            shotDeadline,
          ]);
        } finally {
          globalThis.clearTimeout(shotTimer);
        }
        if (shotRes === null) {
          return halt('timeout', 'Execution deadline exceeded during vision screenshot capture');
        }
      } catch (err: any) {
        return halt(
          expired() ? 'timeout' : 'escalate',
          'Failed to capture vision screenshot: ' + (err?.message || err),
        );
      }
      if (expired()) return halt('timeout', 'Execution deadline exceeded during vision capture');
      if (!visionAllowed()) return halt('escalate', 'Vision consent or remote mode was revoked');
      const parsedShot = parseScreenshotContent(shotRes);
      if (!parsedShot) return halt('escalate', 'Invalid screenshot image or frame metadata');

      const remaining = Math.min(effectiveDeadline - Date.now(), 30_000);
      if (remaining <= 0) return halt('timeout', 'Execution deadline exceeded before vision query');
      const sig = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
        : AbortSignal.timeout(remaining);
      const requestStart = Date.now();
      visionCalls++;
      inferenceAttempts++;
      const visRes = await this.jevClient.queryVision(
        parsedShot.imageBuffer,
        targetDesc,
        currentMode,
        { signal: sig, timeout: remaining },
      );
      totalVisionLatencyMs += Date.now() - requestStart;
      if (visRes.result) {
        successfulRequests++;
        inputTokens += visRes.result.usage?.input_tokens || 0;
        outputTokens += visRes.result.usage?.output_tokens || 0;
        if (visRes.result.usage?.input_tokens == null || visRes.result.usage?.output_tokens == null)
          usageIncomplete = true;
      } else {
        usageIncomplete = true;
      }
      if (expired() || sig.aborted) return halt('timeout', 'Vision request deadline exceeded');
      if (!visionAllowed()) return halt('escalate', 'Vision consent or remote mode was revoked');
      if (visRes.errorReason || !visRes.result) {
        return halt('escalate', 'Vision query failed: ' + (visRes.errorReason || 'empty response'));
      }
      const vision = visRes.result;
      if (vision.destructive)
        return halt('escalate', 'Destructive action detected by vision model');
      if (!vision.exists) return halt('escalate', 'Visual target not found or presence below 0.85');
      if (vision.ambiguous) return halt('escalate', 'Visual target is ambiguous');
      if (
        vision.confidence === null ||
        !Number.isFinite(vision.confidence) ||
        vision.confidence < 0.6 ||
        vision.confidence > 1
      ) {
        return halt('escalate', 'Visual localization confidence is missing or below 0.6');
      }
      if (!vision.box || !validateBoxCoordinates(vision.box)) {
        return halt('escalate', 'Visual target bounding box invalid or out of bounds');
      }
      const b = vision.box;
      const pixelX = Math.round(((b.left + b.right) / 2) * parsedShot.frame.width);
      const pixelY = Math.round(((b.top + b.bottom) / 2) * parsedShot.frame.height);
      if (expired()) return halt('timeout', 'Execution deadline exceeded before visual click');
      let clickRes: any;
      try {
        clickRes = await safeCaller('chrome_interact_index', {
          action: 'click',
          coordinate: { x: pixelX, y: pixelY },
          coordinateSpace: 'screenshot',
          expectedScreenshotId: parsedShot.frame.id,
          expectedDeadlineAt: startTime + timeoutMs,
          tabId: params.tabId,
          includeDelta: true,
          settleTimeoutMs: 600,
          sessionId: params.sessionId || params.sessionContext,
        });
      } catch (err: any) {
        return halt(
          err?.status === 'unknown'
            ? 'unknown'
            : signal?.aborted || err?.status === 'cancelled'
              ? 'cancelled'
              : expired()
                ? 'timeout'
                : 'blocked',
          'Visual click stopped: ' + (err?.message || String(err)),
        );
      }
      const outcome = this.parseOutcome(clickRes);
      steps.push({
        step: currentStep,
        action: 'click',
        target: 'visual:"' + targetDesc + '" (' + pixelX + ', ' + pixelY + ')',
        confidence: vision.confidence,
        outcome,
      });
      history.push({ step: currentStep, action: 'click visual:"' + targetDesc + '"', outcome });
      if (clickRes?.isError || outcome.startsWith('error:')) {
        return halt(
          expired() ? 'timeout' : 'escalate',
          'Visual click execution failed: ' + outcome,
        );
      }
      visualClickExecuted = true;
      const completed = await verifyProgress();
      if (completed) return { handled: true, result: completed };
      return { handled: true };
    };

    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) {
        return finish(
          'cancelled',
          'jev',
          false,
          null,
          'Execution cancelled by signal',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      }
      if (expired()) {
        return finish(
          signal?.aborted ? 'cancelled' : 'timeout',
          'jev',
          false,
          null,
          signal?.aborted
            ? 'Execution cancelled by signal'
            : 'Execution exceeded deadline/timeoutMs (' + timeoutMs + 'ms)',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      }

      let domData: any = {};
      try {
        const observed = chainedObservation;
        chainedObservation = undefined;
        const domResult =
          observed ??
          (await safeCaller('chrome_read_dom', {
            tabId: params.tabId,
            activeViewportOnly: true,
            limit: 100,
            fast: true,
            format: 'fast',
            includeDetails: true,
            sessionId: params.sessionId || params.sessionContext,
          }));
        if (domResult?.isError) {
          throw new Error(this.parseOutcome(domResult));
        }
        const textContent = domResult?.content?.[0]?.text;
        domData = textContent ? JSON.parse(textContent) : {};
        if (domData.success === false) {
          throw new Error(domData.error || domData.reason || 'DOM read failed');
        }
      } catch (err: any) {
        if (err?.status === 'cancelled' || signal?.aborted) {
          return finish(
            'cancelled',
            'jev',
            false,
            null,
            'Execution cancelled during DOM read',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
          );
        }
        if (err?.status === 'unknown' || err?.requestDispatched === true) {
          return finish(
            'unknown',
            'jev',
            false,
            null,
            'Unknown state during DOM read: ' + (err?.message || err),
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: true, lastReceipt },
          );
        }
        return finish(
          'blocked',
          'jev',
          false,
          null,
          'Failed to read page DOM: ' + (err?.message || err),
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }

      if (
        (domData.coverage?.status && domData.coverage.status !== 'complete') ||
        Number(domData.omitted_actions) > 0
      ) {
        return finish(
          'blocked',
          'jev',
          false,
          null,
          'Candidate observation is incomplete; scope the page before continuing',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      }
      finalPage = {
        url: domData.tabUrl || domData.url || '',
        title: domData.tabTitle || domData.title || '',
      };

      const treeString: string = domData.treeString || '';
      currentElements = treeString
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const isWaitOnly =
        (Array.isArray(domData.actions) &&
          domData.actions.length > 0 &&
          domData.actions.every((a: any) => a?.kind === 'wait' || a?.id === 'wait')) ||
        (currentElements.length > 0 && currentElements.every((l) => /^\[\d+\]\s*wait\b/i.test(l)));

      if (currentElements.length === 0 || isWaitOnly) {
        const visFallback = await executeVisionFallback(
          step,
          currentElements.length === 0 ? 'empty DOM elements' : 'wait-only DOM actions',
        );
        if (visFallback.handled) {
          if (visFallback.result) return visFallback.result;
          continue;
        }
      }

      // Step 2: Semantic Decision
      let actionToTake: string = 'escalate';
      let targetIndex: number | undefined;
      let targetLine: string = '';
      let confidence: number = 0;
      let jevSuggestion: any = undefined;

      const observedActions = Array.isArray(domData.actions) ? domData.actions : undefined;
      const valuedInputs = (observedActions || []).filter(
        (action: any) => action.kind === 'fill' && typeof action.value === 'string' && action.value,
      );
      const draftNames = new Set(
        valuedInputs
          .filter((action: any) => action.label?.trim() === action.value.trim())
          .map((action: any) => String(action.node)),
      );
      const decisionElements = currentElements.map((line) => {
        const ref = line.match(/^\[(\d+)\]/)?.[1];
        return ref && draftNames.has(ref) ? `[${ref}] textbox "Editable control"` : line;
      });
      const callerInput = extractTextPayload(params.goal, params.textHint);
      const decisionGoal =
        callerInput &&
        (params.textHint || /\b(?:fill|enter|type|write|input)\b|输入|填写/i.test(params.goal))
          ? params.goal.split(callerInput).join('[caller-provided input]')
          : params.goal;
      const state = buildState(
        decisionGoal,
        finalPage.url,
        finalPage.title,
        decisionElements,
        history,
        domData.modalIsolated ? 'modal dialog active' : undefined,
        valuedInputs.length === 0 && typeof domData.text === 'string' ? domData.text : undefined,
      );
      const stepCandidatesResult = buildStepCandidates(
        state.elements,
        decisionGoal,
        observedActions?.map((action: any) => ({
          node: action.node,
          kind: action.kind,
          label: draftNames.has(String(action.node)) ? 'Editable control' : action.label,
          ...(typeof action.containerIndex === 'number'
            ? { containerIndex: action.containerIndex }
            : {}),
        })),
      );
      if (stepCandidatesResult.omittedCount > 0) {
        return finish(
          'escalate',
          'jev',
          false,
          null,
          'Candidate coverage exceeds the decision budget; scope the observation before continuing',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }
      const questions = stepCandidatesResult.questions;

      const stepRemaining = effectiveDeadline - Date.now();
      if (stepRemaining <= 0) {
        return finish(
          'timeout',
          'jev',
          false,
          null,
          'Execution exceeded deadline/timeoutMs (' + timeoutMs + 'ms)',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }
      const textTimeoutMs = Math.min(stepRemaining, 30_000);
      const textSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(textTimeoutMs)])
        : AbortSignal.timeout(textTimeoutMs);
      const textT0 = Date.now();
      inferenceAttempts++;
      const queryRes = await this.jevClient.query(state, questions, currentMode, {
        signal: textSignal,
        timeout: textTimeoutMs,
        retry: { maxRetries: 0 },
      });
      totalTextLatencyMs += Date.now() - textT0;

      if (signal?.aborted) {
        return finish(
          'cancelled',
          'jev',
          false,
          null,
          'Execution cancelled by signal',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      }
      if (expired() || textSignal.aborted) {
        return finish(
          'timeout',
          'jev',
          false,
          null,
          'Text request deadline exceeded',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      }

      if (queryRes.errorReason || !queryRes.result) {
        usageIncomplete = true;
        const errReason = queryRes.errorReason || 'invalid_response';
        return finish(
          'escalate',
          'jev',
          false,
          errReason,
          'Jev evaluation failed: ' + errReason,
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
        );
      } else {
        successfulRequests++;
        jevCalls++;
        inputTokens += queryRes.result.usage?.input_tokens || 0;
        outputTokens += queryRes.result.usage?.output_tokens || 0;
        if (
          queryRes.result.usage?.input_tokens == null ||
          queryRes.result.usage?.output_tokens == null
        )
          usageIncomplete = true;
        if (queryRes.result.model) textModelUsed = queryRes.result.model;
      }

      const answers = queryRes.result.answers as Record<string, any>;

      if (answers.goal_done?.noul >= 0.85) {
        return tryComplete('Jev goal_done >= 0.85');
      }

      if (answers.stuck?.noul >= 0.85 || checkConsecutiveStuck(history)) {
        return finish(
          'stuck',
          'jev',
          false,
          null,
          answers.stuck?.noul >= 0.85
            ? 'Jev detected execution loop with zero progress'
            : 'Stuck: consecutive actions produced no DOM mutation or URL change',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }

      if (answers.next_step) {
        const nextStepAnswer = answers.next_step;
        const semanticResult = classifySemanticAnswer(
          nextStepAnswer,
          stepCandidatesResult.candidateKeys,
        );

        if (semanticResult.status === 'unavailable') {
          jevModelManager.disableIfCurrent(initialMode, 'invalid_response');
          return finish(
            'blocked',
            'jev',
            false,
            'invalid_response',
            'Jev response invalid: next_step choice structure or distribution invalid',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
          );
        }

        const chosenKey = nextStepAnswer.choice;
        const chosenCandidate = stepCandidatesResult.candidateMap.get(chosenKey);
        confidence = nextStepAnswer.confidence;

        if (chosenKey === 'none' || semanticResult.status === 'none') {
          const visFallback = await executeVisionFallback(
            step,
            'next_step resolved to none',
            'click',
          );
          if (visFallback.handled) {
            if (visFallback.result) return visFallback.result;
            continue;
          }
          return finish(
            'escalate',
            'jev',
            false,
            null,
            'Target element resolved to "none": no matching interactive element found on page',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }

        if (semanticResult.status === 'ambiguous' || confidence < confidenceThreshold) {
          const visFallback = await executeVisionFallback(
            step,
            'next_step confidence ambiguous',
            chosenCandidate?.action || 'click',
          );
          if (visFallback.handled) {
            if (visFallback.result) return visFallback.result;
            continue;
          }
          return finish(
            'escalate',
            'jev',
            false,
            null,
            'Next step confidence ambiguous or below threshold: ' + confidence.toFixed(2),
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }

        if (!chosenCandidate) {
          jevModelManager.disableIfCurrent(initialMode, 'invalid_response');
          return finish(
            'blocked',
            'jev',
            false,
            'invalid_response',
            'Unrecognized next_step candidate key: ' + chosenKey,
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
          );
        }

        actionToTake = chosenCandidate.action;
        targetIndex = chosenCandidate.targetIndex;
        targetLine = chosenCandidate.targetLine || '';

        if (chosenCandidate.isDestructive || isDestructiveTarget(targetLine)) {
          return finish(
            'escalate',
            'jev',
            false,
            null,
            'Target element "' +
              (targetLine || chosenKey) +
              '" matched destructive keyword; requires confirmation',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }

        if (actionToTake === 'done') {
          return tryComplete('Jev decided goal is accomplished via next_step');
        }

        if (
          params.pauseBeforeKeywords &&
          Array.isArray(params.pauseBeforeKeywords) &&
          params.pauseBeforeKeywords.length > 0
        ) {
          const checkTarget = targetLine
            ? targetLine + (actionToTake === 'submit' ? ' submit' : '')
            : targetIndex !== undefined
              ? '[' + targetIndex + ']'
              : actionToTake;
          const matchedKw = findMatchingPauseKeyword(checkTarget, params.pauseBeforeKeywords);
          if (matchedKw) {
            return finish(
              'paused',
              'jev',
              false,
              null,
              'Action execution suspended before committing "' +
                actionToTake +
                '" on target "' +
                (targetLine || 'element') +
                '" matching pause keyword "' +
                matchedKw +
                '"',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
              {
                action: actionToTake,
                target:
                  targetLine || (targetIndex !== undefined ? '[' + targetIndex + ']' : undefined),
                matchedKeyword: matchedKw,
              },
            );
          }
        }

        jevSuggestion = {
          action: actionToTake,
          target: targetIndex !== undefined ? String(targetIndex) : chosenKey,
          confidence,
          probabilities: getTop3Probabilities(nextStepAnswer.probabilities || {}),
        };
      } else {
        return finish(
          'blocked',
          'jev',
          false,
          'invalid_response',
          'Missing next_step decision',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: false, lastReceipt },
        );
      }

      if (visualClickExecuted) {
        return finish(
          'escalate',
          'jev',
          false,
          null,
          'Visual click already executed; verify the result before acting again',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }
      sendProgress(step, actionToTake + ' on ' + (targetLine || 'page'));

      let outcome = 'urlChanged:false, mutated:false';

      try {
        if (
          ['click', 'type', 'select'].includes(actionToTake) &&
          !Array.isArray(domData.guards?.[targetIndex!])
        ) {
          throw Object.assign(new Error('Target observation guard is missing'), {
            status: 'blocked',
            requestDispatched: false,
          });
        }
        if (actionToTake === 'wait') {
          await delay(Math.min(1000, effectiveDeadline - Date.now()), undefined, {
            signal: executionSignal,
          });
          outcome = 'urlChanged:false, mutated:false, waited:1000ms';
        } else if (actionToTake === 'scroll_down') {
          const scrollRes = await safeCaller('chrome_smart_scroll', {
            direction: 'down',
            tabId: params.tabId,
            ...(targetIndex !== undefined ? { index: targetIndex } : {}),
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'scroll_up') {
          const scrollRes = await safeCaller('chrome_smart_scroll', {
            direction: 'up',
            tabId: params.tabId,
            ...(targetIndex !== undefined ? { index: targetIndex } : {}),
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'back') {
          const navRes = await safeCaller('chrome_navigate', {
            url: 'back',
            action: 'back',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(navRes);
        } else if (actionToTake === 'click') {
          if (targetIndex === undefined) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Click action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const clickRes = await safeCaller('chrome_interact_index', {
            action: 'click',
            index: targetIndex,
            expectedGuard: domData.guards?.[targetIndex],
            tabId: params.tabId,
            includeDelta: true,
            settleTimeoutMs: 600,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(clickRes);
        } else if (actionToTake === 'type') {
          if (targetIndex === undefined) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Type action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const textPayload = extractTextPayload(params.goal, params.textHint);
          if (!textPayload) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Text payload unclear from goal and textHint',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const shouldPressEnter = params.pressEnter === true;
          if (
            shouldPressEnter &&
            !(
              /search|搜索|检索|查找/i.test(params.goal) &&
              /\bsearchbox\b|type="search"|"[^"]*(?:search|搜索|检索|查找)[^"]*"/i.test(targetLine)
            )
          ) {
            return finish(
              'paused',
              'jev',
              false,
              null,
              'Only a clearly identified search form may submit automatically',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
              { action: 'type', target: targetLine, matchedKeyword: 'unverified_submission' },
            );
          }
          const fillRes = await safeCaller('chrome_fill_index', {
            index: targetIndex,
            text: textPayload,
            expectedGuard: domData.guards?.[targetIndex],
            tabId: params.tabId,
            pressEnter: shouldPressEnter,
            includeDelta: true,
            settleTimeoutMs: 800,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        } else if (actionToTake === 'select') {
          if (targetIndex === undefined) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Select action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const optionsRes = await safeCaller('chrome_get_dropdown_options', {
            index: targetIndex,
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          const optData = optionsRes?.content?.[0]?.text
            ? JSON.parse(optionsRes.content[0].text)
            : {};
          const optionsList: Array<{ text: string; value: string }> = optData.options || [];

          if (optionsList.length === 0 || optionsList.length > 32) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Dropdown option coverage must contain between 1 and 32 options',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          inferenceAttempts++;
          const scoreRes = await this.jevClient.scoreOptions(
            params.goal,
            optionsList,
            currentMode,
            {
              signal: executionSignal,
              timeout: Math.max(1, effectiveDeadline - Date.now()),
              retry: { maxRetries: 0 },
              onUsage: (usage) => {
                successfulRequests++;
                jevCalls++;
                inputTokens += usage.inputTokens ?? 0;
                outputTokens += usage.outputTokens ?? 0;
                textModelUsed = usage.model;
                if (usage.inputTokens === null || usage.outputTokens === null)
                  usageIncomplete = true;
              },
            },
          );
          if (!scoreRes || scoreRes.confidence < 0.85) {
            return finish(
              'escalate',
              'jev',
              false,
              null,
              'Dropdown option selection has no sufficiently confident match (minimum 0.85)',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const selectedVal = scoreRes.bestOption.value;

          const fillRes = await safeCaller('chrome_fill_index', {
            index: targetIndex,
            value: selectedVal,
            expectedGuard: domData.guards?.[targetIndex],
            tabId: params.tabId,
            includeDelta: true,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        }
      } catch (execErr: any) {
        if (execErr?.status === 'unknown') {
          return finish(
            'unknown',
            'jev',
            false,
            null,
            'Unknown state during action: ' + (execErr?.message || execErr),
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: true, lastReceipt },
          );
        }
        if (expired() && !signal?.aborted) {
          return finish(
            'timeout',
            'jev',
            false,
            null,
            'Execution deadline exceeded',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            { success: false, retry: false, requestDispatched: steps.length > 0, lastReceipt },
          );
        }
        if (execErr?.status === 'cancelled' || signal?.aborted) {
          return finish(
            'cancelled',
            'jev',
            false,
            null,
            'Execution cancelled during action execution',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
            undefined,
            undefined,
            {
              success: false,
              retry: false,
              requestDispatched: execErr?.requestDispatched === true || steps.length > 0,
              lastReceipt,
            },
          );
        }
        return finish(
          'blocked',
          'jev',
          false,
          null,
          String(execErr?.message || execErr),
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          undefined,
          undefined,
          { success: false, retry: false, requestDispatched: false, lastReceipt },
        );
      }

      // Step 4: Record Step
      const record: StepRecord = {
        step,
        action: actionToTake,
        target: targetLine || (targetIndex ? '[' + targetIndex + ']' : 'page'),
        confidence: Math.round(confidence * 100) / 100,
        ...(jevSuggestion ? { jevSuggestion } : {}),
        outcome,
      };
      steps.push(record);

      history.push({
        step,
        action: (actionToTake + ' ' + (targetLine || '')).trim(),
        outcome,
      });
      const completed = await verifyProgress();
      if (completed) return completed;
    }

    return finish(
      'max_steps',
      'jev',
      false,
      null,
      'Reached maximum steps limit (' + maxSteps + ')',
      steps,
      finalPage,
      currentElements,
      jevCalls,
      inputTokens,
    );
  }

  private parseOutcome(res: any): string {
    if (!res) return 'urlChanged:false, mutated:false';
    try {
      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.isError) {
        let errText = data.content?.[0]?.text || data.message || 'tool execution failed';
        if (typeof errText === 'string') {
          try {
            const p = JSON.parse(errText);
            errText = p.error || p.reason || p.message || p.detail || errText;
          } catch {}
        }
        return (
          'error:' +
          String(errText)
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 150)
        );
      }
      const content = data.content?.[0]?.text;
      let parsed = data;
      if (content) {
        try {
          parsed = JSON.parse(content);
        } catch {
          if (typeof content === 'string') {
            if (
              /error|fail|invalid|cannot|unable|timed?\s*out|exception|not\s+found/i.test(content)
            ) {
              return 'error:' + content.replace(/[\r\n]+/g, ' ').slice(0, 150);
            }
          }
        }
      }
      if (parsed.isError || parsed.success === false) {
        const errText =
          parsed.error || parsed.reason || parsed.message || parsed.detail || 'action failed';
        return (
          'error:' +
          String(errText)
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 150)
        );
      }
      if (parsed.error && !parsed.success) {
        return (
          'error:' +
          String(parsed.error)
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 150)
        );
      }

      const urlChanged = Boolean(parsed.urlChanged);
      let mutated = Boolean(parsed.mutated);
      let visualDiff: number | undefined = undefined;

      if (parsed.perceptiveDelta) {
        mutated =
          mutated ||
          Boolean(
            parsed.perceptiveDelta.advanced ||
            parsed.perceptiveDelta.questionChanged ||
            parsed.perceptiveDelta.progressChanged ||
            parsed.perceptiveDelta.mutated,
          );
        if (typeof parsed.perceptiveDelta.visualDiff === 'number') {
          visualDiff = parsed.perceptiveDelta.visualDiff;
        }
      } else if (parsed.delta) {
        mutated =
          mutated ||
          (!parsed.delta.unchanged &&
            ((parsed.delta.added && parsed.delta.added.length > 0) ||
              (parsed.delta.modified && parsed.delta.modified.length > 0) ||
              (parsed.delta.removed && parsed.delta.removed.length > 0)));
      }

      const parts = ['urlChanged:' + urlChanged, 'mutated:' + mutated];
      if (visualDiff !== undefined) {
        parts.push('visualDiff:' + visualDiff.toFixed(2));
      }
      return parts.join(', ');
    } catch {
      return 'urlChanged:false, mutated:false';
    }
  }

  private formatResult(
    status: ActTowardGoalStatus,
    engine: DecisionEngineType,
    engineSwitched: boolean,
    fallbackReason: FallbackReason,
    reason: string | undefined,
    steps: StepRecord[],
    finalPage: JevPageState,
    currentElements: string[],
    jevCalls: number,
    inputTokens: number,
    pausedBeforeAction?: PausedBeforeAction,
    telemetry?: {
      visionCalls?: number;
      textLatencyMs?: number;
      visionLatencyMs?: number;
      visionModel?: string;
      attempts?: number;
      successfulRequests?: number;
      backend?: 'remote' | 'local';
      model?: string;
      usageIncomplete?: boolean;
      outputTokens?: number;
    },
    extra?: {
      success?: boolean;
      retry?: boolean;
      requestDispatched?: boolean;
      verification?: VerificationResult[];
      lastReceipt?: any;
    },
  ): ActTowardGoalResult {
    const vCalls = telemetry?.visionCalls || 0;
    const attempts = Math.max(telemetry?.attempts ?? 0, jevCalls + vCalls);
    const successReqs =
      telemetry?.successfulRequests !== undefined
        ? telemetry.successfulRequests
        : jevCalls + vCalls;
    const backend = telemetry?.backend;
    // A model name cannot establish the endpoint's current billing rate.
    const estCostUsd = null;
    const totalCalls = jevCalls + vCalls;
    const executionStatus =
      status === 'unknown'
        ? 'unknown'
        : extra?.requestDispatched === true ||
            (extra?.requestDispatched === undefined && steps.length > 0)
          ? 'dispatched'
          : 'not_dispatched';
    const verificationStatus = !extra?.verification
      ? 'not_requested'
      : extra.verification.length > 0 && extra.verification.every((item) => item.pass)
        ? 'verified'
        : 'failed';
    const dispatchedCount =
      steps.length + (status === 'unknown' && extra?.requestDispatched === true ? 1 : 0);

    return {
      status,
      engine,
      engineSwitched,
      fallbackReason,
      ...(reason ? { reason } : {}),
      ...(extra?.success !== undefined
        ? { success: extra.success }
        : status === 'done'
          ? { success: true }
          : status === 'cancelled' || status === 'unknown'
            ? { success: false }
            : {}),
      ...(extra?.retry !== undefined
        ? { retry: extra.retry }
        : status === 'cancelled' || status === 'unknown'
          ? { retry: false }
          : {}),
      ...(extra?.requestDispatched !== undefined
        ? { requestDispatched: extra.requestDispatched }
        : {}),
      ...(pausedBeforeAction ? { pausedBeforeAction } : {}),
      steps,
      finalPage,
      ...(status === 'blocked' ||
      status === 'escalate' ||
      status === 'stuck' ||
      status === 'paused' ||
      status === 'unknown'
        ? { currentElements: currentElements.slice(0, 100) }
        : {}),
      ...(extra?.verification ? { verification: extra.verification } : {}),
      ...(extra?.lastReceipt ? { lastReceipt: extra.lastReceipt } : {}),
      interaction: {
        execution: {
          status: executionStatus,
          ...(reason ? { reason } : {}),
          ...(dispatchedCount > 0 ? { dispatchedCount } : {}),
        },
        verification: {
          status: verificationStatus,
          ...(reason && verificationStatus === 'failed' ? { reason } : {}),
        },
      },
      ...(attempts > 0
        ? {
            jevUsage: {
              calls: totalCalls,
              attempts,
              successfulRequests: successReqs,
              inputTokens,
              outputTokens: telemetry?.usageIncomplete ? null : (telemetry?.outputTokens ?? null),
              estCostUsd,
              ...(backend ? { backend } : {}),
              ...(telemetry?.model ? { model: telemetry.model } : {}),
              ...(telemetry?.usageIncomplete ? { usageIncomplete: true } : {}),
              ...(vCalls > 0
                ? {
                    visionCalls: vCalls,
                    ...(telemetry?.visionModel ? { visionModel: telemetry.visionModel } : {}),
                  }
                : {}),
              ...(telemetry?.textLatencyMs !== undefined
                ? { textLatencyMs: telemetry.textLatencyMs }
                : {}),
              ...(telemetry?.visionLatencyMs !== undefined
                ? { visionLatencyMs: telemetry.visionLatencyMs }
                : {}),
            },
          }
        : {}),
    };
  }
}
