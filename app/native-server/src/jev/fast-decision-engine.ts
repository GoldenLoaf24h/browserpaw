/**
 * Fast Decision Engine conforming to §4, §5, §6
 * Semantic micro-loop inside Native Server (~200-400ms/step).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ActTowardGoalParams,
  ActTowardGoalResult,
  ActTowardGoalStatus,
  DecisionEngineType,
  FallbackReason,
  JevHistoryItem,
  JevPageState,
  PausedBeforeAction,
  StepRecord,
} from './types';
import {
  JevClientWrapper,
  buildQuestions,
  buildState,
  extractElementIndices,
  extractTextPayload,
  extractVisualTargetDescription,
  parseScreenshotContent,
  validateBoxCoordinates,
  getTop3Probabilities,
  isDestructiveTarget,
  isSessionKeyInvalid,
  latchInvalidKey,
  validateChoice,
} from './jev-client';
import { HeuristicEngine } from './heuristic-engine';
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
    const kwLower = cleanKw.toLowerCase();

    // If keyword consists of alphanumeric/dash words (Latin/standard token), match on word boundaries
    // to prevent false positives like "postal_code" matching "post" or "deposit" matching "post"
    if (/^[a-zA-Z0-9_-]+$/.test(cleanKw)) {
      const regex = new RegExp(
        `(^|[^a-zA-Z0-9])${cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-zA-Z0-9]|$)`,
        'i',
      );
      if (regex.test(targetText)) {
        return cleanKw;
      }
    } else {
      // Non-Latin/CJK characters (e.g. CJK confirmation/submission keywords) - substring match
      if (textLower.includes(kwLower)) {
        return cleanKw;
      }
    }
  }
  return null;
}

export class FastDecisionEngine {
  private jevClient: JevClientWrapper;
  private heuristicEngine: HeuristicEngine;

  constructor(apiKey?: string) {
    this.jevClient = new JevClientWrapper(apiKey);
    this.heuristicEngine = new HeuristicEngine();
  }

  /**
   * Run semantic micro-loop toward goal
   */
  public async run(
    params: ActTowardGoalParams,
    internalCaller: (toolName: string, args: any) => Promise<any>,
    server?: Server,
  ): Promise<ActTowardGoalResult> {
    jevModelManager.touchActivity();
    const currentMode = params.mode || jevModelManager.getActiveMode();
    let engine: DecisionEngineType = 'heuristic';
    let fallbackReason: FallbackReason = null;
    let engineSwitched = false;

    if (currentMode === 'off') {
      engine = 'heuristic';
      fallbackReason = 'jev_disabled';
    } else if (currentMode === 'local') {
      engine = 'jev';
      fallbackReason = null;
      // Auto-ensure local service is running (hot-load & resident)
      const serviceRes = await jevModelManager.ensureLocalServiceRunning();
      if (!serviceRes.success && !(await jevModelManager.isLocalServiceOnline(8009))) {
        engine = 'heuristic';
        fallbackReason = 'local_service_offline';
        engineSwitched = true;
      }
    } else {
      // Remote cloud mode
      const hasKey = Boolean(this.jevClient.getRemoteClient());
      engine = hasKey && !isSessionKeyInvalid() ? 'jev' : 'heuristic';
      fallbackReason = hasKey ? (isSessionKeyInvalid() ? 'invalid_key' : null) : 'no_api_key';
    }

    // Parameter bounds enforcement (§4.4)
    let maxSteps = typeof params.maxSteps === 'number' ? params.maxSteps : 10;
    maxSteps = Math.min(Math.max(1, maxSteps), 60);
    if ((engine as DecisionEngineType) === 'heuristic') {
      maxSteps = Math.min(maxSteps, 5); // §4.3: heuristic mode maxSteps forced <= 5
    }

    const timeoutMs = Math.min(Math.max(1, Math.floor(params.timeoutMs ?? 90_000)), 300_000);
    const confidenceThreshold = params.confidenceThreshold ?? 0.55;
    const startTime = Date.now();

    const steps: StepRecord[] = [];
    const history: JevHistoryItem[] = [];
    let jevCalls = 0;
    let inputTokens = 0;
    let visionCalls = 0;
    let totalTextLatencyMs = 0;
    let totalVisionLatencyMs = 0;
    let visualClickExecuted = false;
    /** The release upstream reported for the visual call, recorded for telemetry. */
    let visionModelUsed: string | undefined;

    let finalPage: JevPageState = { url: '', title: '' };
    let currentElements: string[] = [];

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
              message: `Step ${stepNum}/${maxSteps}: ${desc}`,
            },
          })
          .catch(() => {});
      }
    };

    const finish = (...args: Parameters<typeof this.formatResult>): ActTowardGoalResult => {
      args[11] = {
        visionCalls,
        textLatencyMs: totalTextLatencyMs,
        visionLatencyMs: totalVisionLatencyMs,
        ...(visionModelUsed ? { visionModel: visionModelUsed } : {}),
      };
      return this.formatResult(...args);
    };
    const expired = () => Date.now() - startTime >= timeoutMs;
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
      if (!visionAllowed() || (proposedAction && proposedAction !== 'click')) {
        return { handled: false };
      }
      const targetDesc = extractVisualTargetDescription(params.goal);
      if (!targetDesc) return { handled: false };
      const halt = (status: ActTowardGoalStatus, reason: string, pause?: PausedBeforeAction) => ({
        handled: true,
        result: finish(
          status,
          engine,
          engineSwitched,
          fallbackReason,
          reason,
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
          pause,
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
        return halt('paused', `Visual target matches pause keyword "${matchedKeyword}"`, {
          action: 'click',
          target: targetDesc,
          matchedKeyword,
        });
      }
      if (isDestructiveTarget(targetDesc)) {
        return halt('escalate', 'Visual target matched destructive keyword; requires confirmation');
      }

      // Resolve box support before capturing: an endpoint whose release cannot answer `box`
      // must not have a screenshot taken for it, let alone sent. Bound the probe by the
      // same deadline as the rest of the run so a stalled endpoint cannot stretch
      // act_toward_goal past its requested timeoutMs.
      const probeRemaining = Math.min(timeoutMs - (Date.now() - startTime), 30_000);
      if (probeRemaining <= 0)
        return halt('timeout', 'Execution deadline exceeded before vision probe');
      const probeSignal = AbortSignal.timeout(probeRemaining);
      const visionModel = await this.jevClient.resolveBoxCapableModel(probeSignal, probeRemaining);
      // A probe that ran into its deadline (or outlived the run's) answered nothing about the
      // endpoint; the run must stop with timeout instead of capturing or acting on stale state.
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

      sendProgress(currentStep, `Capturing screenshot for vision fallback (${reasonTrigger})`);
      const shotBudget = timeoutMs - (Date.now() - startTime);
      if (shotBudget <= 0)
        return halt('timeout', 'Execution deadline exceeded before vision capture');
      let shotRes: any;
      try {
        // Race the capture against the remaining budget. The losing timer is cleared so an
        // in-budget capture leaves no pending handle, and a late result is ignored below.
        let shotTimer: NodeJS.Timeout | undefined;
        const shotDeadline = new Promise<null>((resolve) => {
          shotTimer = globalThis.setTimeout(() => resolve(null), shotBudget);
        });
        try {
          shotRes = await Promise.race([
            internalCaller('chrome_screenshot', {
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
          `Failed to capture vision screenshot: ${err?.message || err}`,
        );
      }
      if (expired()) return halt('timeout', 'Execution deadline exceeded during vision capture');
      if (!visionAllowed()) return halt('escalate', 'Vision consent or remote mode was revoked');
      const parsedShot = parseScreenshotContent(shotRes);
      if (!parsedShot) return halt('escalate', 'Invalid screenshot image or frame metadata');

      const remaining = Math.min(timeoutMs - (Date.now() - startTime), 30_000);
      if (remaining <= 0) return halt('timeout', 'Execution deadline exceeded before vision query');
      const signal = AbortSignal.timeout(remaining);
      const requestStart = Date.now();
      visionCalls++;
      const visRes = await this.jevClient.queryVision(
        parsedShot.imageBuffer,
        targetDesc,
        currentMode,
        { signal, timeout: remaining },
      );
      totalVisionLatencyMs += Date.now() - requestStart;
      inputTokens += visRes.result?.usage?.input_tokens || 0;
      if (expired() || signal.aborted) return halt('timeout', 'Vision request deadline exceeded');
      if (!visionAllowed()) return halt('escalate', 'Vision consent or remote mode was revoked');
      if (visRes.errorReason || !visRes.result) {
        return halt('escalate', `Vision query failed: ${visRes.errorReason || 'empty response'}`);
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
        clickRes = await internalCaller('chrome_interact_index', {
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
        clickRes = { isError: true, message: err?.message || String(err) };
      }
      const outcome = this.parseOutcome(clickRes);
      steps.push({
        step: currentStep,
        action: 'click',
        target: `visual:"${targetDesc}" (${pixelX}, ${pixelY})`,
        confidence: vision.confidence,
        outcome,
      });
      history.push({ step: currentStep, action: `click visual:"${targetDesc}"`, outcome });
      if (clickRes?.isError || outcome.startsWith('error:')) {
        return halt(
          expired() ? 'timeout' : 'escalate',
          `Visual click execution failed: ${outcome}`,
        );
      }
      visualClickExecuted = true;
      return { handled: true };
    };

    for (let step = 1; step <= maxSteps; step++) {
      // Check wall-clock timeout
      if (Date.now() - startTime >= timeoutMs) {
        return finish(
          'timeout',
          engine,
          engineSwitched,
          fallbackReason,
          `Execution exceeded timeoutMs (${timeoutMs}ms)`,
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }

      // Step 1: Perceive via internal chrome_read_dom (compact, active viewport only)
      let domData: any = {};
      try {
        const domResult = await internalCaller('chrome_read_dom', {
          tabId: params.tabId,
          activeViewportOnly: true,
          limit: 100,
          fast: true,
          format: 'fast',
          sessionId: params.sessionId || params.sessionContext,
        });
        if (domResult?.isError) {
          throw new Error(this.parseOutcome(domResult));
        }
        const textContent = domResult?.content?.[0]?.text;
        domData = textContent ? JSON.parse(textContent) : {};
        if (domData.success === false) {
          throw new Error(domData.error || domData.reason || 'DOM read failed');
        }
      } catch (err: any) {
        return finish(
          'blocked',
          engine,
          engineSwitched,
          fallbackReason,
          `Failed to read page DOM: ${err?.message || err}`,
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
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
          continue; // Step executed via vision, observe next page state
        }
      }

      // Check stuck condition for heuristic mode (§4.3)
      if (engine === 'heuristic' && this.heuristicEngine.isStuck(history)) {
        return finish(
          'stuck',
          engine,
          engineSwitched,
          fallbackReason,
          'Stuck: consecutive actions produced no DOM mutation or URL change',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }

      // In Heuristic mode, check goal_done approximation before action (§4.3)
      if (engine === 'heuristic' && step > 1) {
        const lastOutcome = history.length > 0 ? history[history.length - 1].outcome : '';
        const urlChangedInLastStep = /urlChanged:true/i.test(lastOutcome);
        const mutatedInLastStep = /mutated:true/i.test(lastOutcome);
        if (
          this.heuristicEngine.isGoalDone(
            params.goal,
            currentElements,
            urlChangedInLastStep,
            mutatedInLastStep,
          )
        ) {
          return finish(
            'done',
            engine,
            engineSwitched,
            fallbackReason,
            'Goal accomplished (keyword coverage >= 80%)',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }
      }

      // Step 2: Semantic Decision
      let actionToTake: string = 'escalate';
      let targetIndex: number | undefined;
      let targetLine: string = '';
      let confidence: number = 0;
      let jevSuggestion: any = undefined;
      let escalateReason: string | undefined;
      /** Set when Jev judges that a fill should also submit; never inferred from goal keywords. */
      let submitAfterFill = false;

      if (engine === 'jev') {
        const state = buildState(
          params.goal,
          finalPage.url,
          finalPage.title,
          currentElements,
          history,
          domData.modalIsolated ? 'modal dialog active' : undefined,
          // The fast snapshot already carries the viewport's visible text, so no extra read.
          typeof domData.text === 'string' ? domData.text : undefined,
        );
        const questions = buildQuestions(state.elements, params.goal);

        const stepRemaining = timeoutMs - (Date.now() - startTime);
        if (stepRemaining <= 0) {
          return finish(
            'timeout',
            engine,
            engineSwitched,
            fallbackReason,
            `Execution exceeded timeoutMs (${timeoutMs}ms)`,
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }
        const textTimeoutMs = Math.min(stepRemaining, 30_000);
        const textSignal = AbortSignal.timeout(textTimeoutMs);
        const textT0 = Date.now();
        const queryRes = await this.jevClient.query(state, questions, currentMode, {
          signal: textSignal,
          timeout: textTimeoutMs,
        });
        totalTextLatencyMs += Date.now() - textT0;
        if (expired() || textSignal.aborted) {
          return finish(
            'timeout',
            engine,
            engineSwitched,
            fallbackReason,
            'Text request deadline exceeded',
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }
        if (queryRes.errorReason || !queryRes.result) {
          // Runtime fallback (§4.2)
          engine = 'heuristic';
          engineSwitched = true;
          fallbackReason = queryRes.errorReason;
          if (queryRes.errorReason === 'invalid_key') {
            latchInvalidKey();
          }
          maxSteps = Math.min(maxSteps, 5); // cap heuristic steps
        } else {
          jevCalls++;
          inputTokens += queryRes.result.usage?.input_tokens || 0;
          const answers = queryRes.result.answers as Record<string, any>;

          // Check goal_done noul (§5.3: >= 0.85)
          if (answers.goal_done?.noul >= 0.85) {
            return finish(
              'done',
              engine,
              engineSwitched,
              fallbackReason,
              'Goal accomplished (Jev goal_done >= 0.85)',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          // Check stuck noul (§5.3: >= 0.85) or heuristic stuck detection
          if (answers.stuck?.noul >= 0.85 || this.heuristicEngine.isStuck(history)) {
            return finish(
              'stuck',
              engine,
              engineSwitched,
              fallbackReason,
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

          // Check destructive noul (§5.3: >= 0.5)
          if (answers.destructive?.noul >= 0.5) {
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              `Destructive action detected by Jev (confidence: ${answers.destructive.noul.toFixed(2)} >= 0.50)`,
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          // Validate action choice (§5.5)
          const validActionChoice = validateChoice(answers.action, [
            'click',
            'type',
            'select',
            'scroll_down',
            'scroll_up',
            'back',
            'wait',
            'done',
            'escalate',
          ]);
          if (!validActionChoice) {
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Jev response invalid: action choice validation failed',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          actionToTake = answers.action.choice;
          confidence = answers.action.confidence;

          // Action confidence threshold guard (§5.3: >= 0.55)
          if (confidence < confidenceThreshold) {
            const visFallback = await executeVisionFallback(
              step,
              'low text action confidence',
              actionToTake === 'escalate' || actionToTake === 'wait' ? 'click' : actionToTake,
            );
            if (visFallback.handled) {
              if (visFallback.result) return visFallback.result;
              continue;
            }
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              `Action confidence ${confidence.toFixed(2)} < threshold ${confidenceThreshold}`,
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          if (actionToTake === 'done') {
            return finish(
              'done',
              engine,
              engineSwitched,
              fallbackReason,
              'Jev decided goal is accomplished',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          if (actionToTake === 'escalate') {
            const visFallback = await executeVisionFallback(
              step,
              'model escalated (perceptual absence)',
              'click',
            );
            if (visFallback.handled) {
              if (visFallback.result) return visFallback.result;
              continue;
            }
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Jev decided macro escalation is required',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          // Resolve target for click / type / select
          let targetAnswer: any = null;
          if (actionToTake === 'click') targetAnswer = answers.click_target;
          else if (actionToTake === 'type') targetAnswer = answers.type_target;
          else if (actionToTake === 'select') targetAnswer = answers.select_target;

          // Whether a fill should also submit is a separate judgment from which field to fill.
          // Deriving it from keywords in the goal made any goal mentioning "search" press
          // Enter, so a goal that only asked to fill a search box ran the search instead.
          // An explicit pressEnter parameter is the caller's decision: skip the model
          // judgment entirely so an unclear or malformed answer cannot veto it.
          if (actionToTake === 'type' && params.pressEnter === undefined) {
            const submitIntent = answers.submit_intent;
            // Validate the whole answer (choice plus distribution), not just the choice string.
            if (!validateChoice(submitIntent, ['fill_only', 'submit', 'unclear'])) {
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                'Jev response invalid: submit intent choice validation failed',
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }
            const submitConfidence = submitIntent.confidence;
            if (
              typeof submitConfidence !== 'number' ||
              !Number.isFinite(submitConfidence) ||
              submitConfidence < 0 ||
              submitConfidence > 1
            ) {
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                'Jev response invalid: submit intent confidence validation failed',
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }
            if (submitIntent.choice === 'unclear') {
              // The task does not say whether to submit, so leave the decision to the caller
              // rather than guessing: submitting is not reversible by re-filling the field.
              return finish(
                'paused',
                engine,
                engineSwitched,
                fallbackReason,
                'Submit intent unclear; fill the field and confirm whether to submit',
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
                {
                  action: 'type',
                  target: targetAnswer?.choice ? `[${targetAnswer.choice}]` : undefined,
                  matchedKeyword: 'unclear_submit_intent',
                },
              );
            }
            if (submitIntent.choice === 'submit') {
              const submitProb = submitIntent.probabilities['submit'];
              // Enter is not reversible; reuse the target guard so a weak submit escalates.
              if (submitConfidence < 0.45 || submitProb < 0.35) {
                return finish(
                  'escalate',
                  engine,
                  engineSwitched,
                  fallbackReason,
                  `Submit intent confidence ambiguous (${submitConfidence.toFixed(2)} < 0.45 or prob ${submitProb.toFixed(2)} < 0.35)`,
                  steps,
                  finalPage,
                  currentElements,
                  jevCalls,
                  inputTokens,
                );
              }
              submitAfterFill = true;
            }
          }

          if (targetAnswer) {
            const expectedTargetKeys = [...extractElementIndices(state.elements), 'none'];
            const validTargetChoice = validateChoice(targetAnswer, expectedTargetKeys);
            if (!validTargetChoice) {
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                'Jev response invalid: target choice validation failed',
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }

            const chosen = targetAnswer.choice;
            const targetProb = targetAnswer.probabilities[chosen] || 0;
            const targetConf = targetAnswer.confidence;

            // Target confidence threshold guard (§5.3: confidence >= 0.45 && topProb >= 0.35)
            if (chosen === 'none') {
              const visFallback = await executeVisionFallback(
                step,
                'target resolved to none',
                actionToTake,
              );
              if (visFallback.handled) {
                if (visFallback.result) return visFallback.result;
                continue; // Step executed via vision, observe next page state
              }
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                'Target element resolved to "none": no matching interactive element found on page',
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }

            if (targetConf < 0.45 || targetProb < 0.35) {
              const visFallback = await executeVisionFallback(
                step,
                'target confidence ambiguous',
                actionToTake,
              );
              if (visFallback.handled) {
                if (visFallback.result) return visFallback.result;
                continue; // Step executed via vision, observe next page state
              }
              const top3 = getTop3Probabilities(targetAnswer.probabilities);
              const top3Str = Object.entries(top3)
                .map(([k, v]) => `[${k}]: ${v}`)
                .join(', ');
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                `Target confidence ambiguous (${targetConf.toFixed(2)} < 0.45 or prob ${targetProb.toFixed(2)} < 0.35): ${top3Str}`,
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }

            targetIndex = parseInt(chosen, 10);
            targetLine = currentElements.find((l) => l.startsWith(`[${chosen}]`)) || `[${chosen}]`;

            // Safety Breakpoint Guard priority check: if candidate matches pauseBeforeKeywords, pause instead of escalate
            if (
              params.pauseBeforeKeywords &&
              Array.isArray(params.pauseBeforeKeywords) &&
              params.pauseBeforeKeywords.length > 0
            ) {
              const checkTarget = targetLine
                ? `${targetLine}${actionToTake === 'submit' ? ' submit' : ''}`
                : targetIndex !== undefined
                  ? `[${targetIndex}]`
                  : actionToTake;
              const matchedKw = findMatchingPauseKeyword(checkTarget, params.pauseBeforeKeywords);
              if (matchedKw) {
                return finish(
                  'paused',
                  engine,
                  engineSwitched,
                  fallbackReason,
                  `Action execution suspended before committing "${actionToTake}" on target "${targetLine || 'element'}" matching pause keyword "${matchedKw}"`,
                  steps,
                  finalPage,
                  currentElements,
                  jevCalls,
                  inputTokens,
                  {
                    action: actionToTake,
                    target:
                      targetLine || (targetIndex !== undefined ? `[${targetIndex}]` : undefined),
                    matchedKeyword: matchedKw,
                  },
                );
              }
            }

            // Destructive keyword check on target element
            if (isDestructiveTarget(targetLine)) {
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                `Target element "${targetLine}" matched destructive keyword; requires confirmation`,
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }

            jevSuggestion = {
              action: actionToTake,
              target: chosen,
              confidence: targetConf,
              probabilities: getTop3Probabilities(targetAnswer.probabilities),
              speculativeTargets: {
                click: answers.click_target?.choice,
                type: answers.type_target?.choice,
                select: answers.select_target?.choice,
              },
            };
          } else {
            // Non-targeting actions (scroll_down, scroll_up, wait, back) (§5.6)
            jevSuggestion = {
              action: actionToTake,
              confidence,
              probabilities: getTop3Probabilities(answers.action?.probabilities || {}),
              speculativeTargets: {
                click: answers.click_target?.choice,
                type: answers.type_target?.choice,
                select: answers.select_target?.choice,
              },
            };
          }
        }
      }

      // If engine is heuristic (either by default or downgraded)
      if (engine === 'heuristic') {
        const decision = this.heuristicEngine.evaluate(
          params.goal,
          currentElements,
          history,
          Math.min(confidenceThreshold, 0.9),
        );
        actionToTake = decision.action;
        targetIndex = decision.targetIndex;
        targetLine = decision.targetLine || (targetIndex ? `[${targetIndex}]` : '');
        confidence = decision.confidence;

        // Safety Breakpoint Guard priority check: if candidate matches pauseBeforeKeywords, pause instead of escalate
        if (
          params.pauseBeforeKeywords &&
          Array.isArray(params.pauseBeforeKeywords) &&
          params.pauseBeforeKeywords.length > 0
        ) {
          let pauseAction = actionToTake;
          if (pauseAction === 'escalate') {
            if (targetLine && /(textbox|searchbox|input)/i.test(targetLine)) {
              pauseAction = 'type';
            } else if (targetLine && /(select|combobox)/i.test(targetLine)) {
              pauseAction = 'select';
            } else {
              pauseAction = 'click';
            }
          }
          const checkTarget = targetLine
            ? `${targetLine}${pauseAction === 'submit' ? ' submit' : ''}`
            : targetIndex !== undefined
              ? `[${targetIndex}]`
              : pauseAction;
          const matchedKw = findMatchingPauseKeyword(checkTarget, params.pauseBeforeKeywords);
          if (matchedKw) {
            return finish(
              'paused',
              engine,
              engineSwitched,
              fallbackReason,
              `Action execution suspended before committing "${pauseAction}" on target "${targetLine || 'element'}" matching pause keyword "${matchedKw}"`,
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
              {
                action: pauseAction,
                target: targetLine || (targetIndex !== undefined ? `[${targetIndex}]` : undefined),
                matchedKeyword: matchedKw,
              },
            );
          }
        }

        if (decision.shouldEscalate) {
          return finish(
            'escalate',
            engine,
            engineSwitched,
            fallbackReason,
            decision.reason || `Heuristic confidence < threshold or target ambiguous`,
            steps,
            finalPage,
            currentElements,
            jevCalls,
            inputTokens,
          );
        }
      }

      // Step 3: Execute Action
      if (visualClickExecuted) {
        return finish(
          'escalate',
          engine,
          engineSwitched,
          fallbackReason,
          'Visual click already executed; verify the result before acting again',
          steps,
          finalPage,
          currentElements,
          jevCalls,
          inputTokens,
        );
      }
      sendProgress(step, `${actionToTake} on ${targetLine || 'page'}`);

      let outcome = 'urlChanged:false, mutated:false';

      try {
        if (actionToTake === 'wait') {
          await new Promise((r) => setTimeout(r, 1000));
          outcome = 'urlChanged:false, mutated:false, waited:1000ms';
        } else if (actionToTake === 'scroll_down') {
          const scrollRes = await internalCaller('chrome_smart_scroll', {
            direction: 'down',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'scroll_up') {
          const scrollRes = await internalCaller('chrome_smart_scroll', {
            direction: 'up',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'back') {
          const navRes = await internalCaller('chrome_navigate', {
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
              engine,
              engineSwitched,
              fallbackReason,
              'Click action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const clickRes = await internalCaller('chrome_interact_index', {
            action: 'click',
            index: targetIndex,
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
              engine,
              engineSwitched,
              fallbackReason,
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
              engine,
              engineSwitched,
              fallbackReason,
              'Text payload unclear from goal and textHint',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const shouldPressEnter =
            params.pressEnter === true || (params.pressEnter === undefined && submitAfterFill);
          const fillRes = await internalCaller('chrome_fill_index', {
            index: targetIndex,
            text: textPayload,
            tabId: params.tabId,
            pressEnter: shouldPressEnter,
            includeDelta: true,
            settleTimeoutMs: 800,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        } else if (actionToTake === 'select') {
          // Two-stage select (§2.3, §5.2, §5.3)
          if (targetIndex === undefined) {
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Select action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }
          const optionsRes = await internalCaller('chrome_get_dropdown_options', {
            index: targetIndex,
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          const optData = optionsRes?.content?.[0]?.text
            ? JSON.parse(optionsRes.content[0].text)
            : {};
          const options: Array<{ text: string; value: string }> = optData.options || [];

          if (options.length === 0) {
            return finish(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              `No dropdown options retrieved for element [${targetIndex}]`,
              steps,
              finalPage,
              currentElements,
              jevCalls,
              inputTokens,
            );
          }

          let selectedVal = options[0].value;
          if (engine === 'jev') {
            const scoreRes = await this.jevClient.scoreOptions(params.goal, options, currentMode);
            jevCalls++;
            inputTokens += scoreRes?.usage?.inputTokens || 0;
            if (!scoreRes || scoreRes.confidence < 0.4) {
              return finish(
                'escalate',
                engine,
                engineSwitched,
                fallbackReason,
                `Dropdown option selection confidence (${scoreRes?.confidence ?? 0}) < 0.40`,
                steps,
                finalPage,
                currentElements,
                jevCalls,
                inputTokens,
              );
            }
            selectedVal = scoreRes.bestOption.value;
          } else {
            // Heuristic option matching
            const goalLower = params.goal.toLowerCase();
            const matched = options.find(
              (o) =>
                goalLower.includes(o.text.toLowerCase()) ||
                goalLower.includes(o.value.toLowerCase()),
            );
            if (matched) selectedVal = matched.value;
          }

          const fillRes = await internalCaller('chrome_fill_index', {
            index: targetIndex,
            value: selectedVal,
            tabId: params.tabId,
            includeDelta: true,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        }
      } catch (execErr: any) {
        outcome = `error:${execErr?.message || execErr}`;
      }

      // Step 4: Record Step
      const record: StepRecord = {
        step,
        action: actionToTake,
        target: targetLine || (targetIndex ? `[${targetIndex}]` : 'page'),
        confidence: Math.round(confidence * 100) / 100,
        ...(jevSuggestion ? { jevSuggestion } : {}),
        outcome,
      };
      steps.push(record);

      history.push({
        step,
        action: `${actionToTake} ${targetLine || ''}`.trim(),
        outcome,
      });
    }

    return finish(
      'max_steps',
      engine,
      engineSwitched,
      fallbackReason,
      `Reached maximum steps limit (${maxSteps})`,
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
        return `error:${String(errText)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
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
              return `error:${content.replace(/[\r\n]+/g, ' ').slice(0, 150)}`;
            }
          }
        }
      }
      if (parsed.isError || parsed.success === false) {
        const errText =
          parsed.error || parsed.reason || parsed.message || parsed.detail || 'action failed';
        return `error:${String(errText)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
      }
      if (parsed.error && !parsed.success) {
        return `error:${String(parsed.error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
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

      const parts = [`urlChanged:${urlChanged}`, `mutated:${mutated}`];
      if (visualDiff !== undefined) {
        parts.push(`visualDiff:${visualDiff.toFixed(2)}`);
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
    },
  ): ActTowardGoalResult {
    const estCostUsd = (inputTokens / 1_000_000) * 0.042;
    const vCalls = telemetry?.visionCalls || 0;
    const totalCalls = jevCalls + vCalls;

    return {
      status,
      engine,
      engineSwitched,
      fallbackReason,
      ...(reason ? { reason } : {}),
      ...(pausedBeforeAction ? { pausedBeforeAction } : {}),
      steps,
      finalPage,
      ...(status === 'escalate' || status === 'stuck' || status === 'paused'
        ? { currentElements: currentElements.slice(0, 100) }
        : {}),
      ...(totalCalls > 0
        ? {
            jevUsage: {
              calls: totalCalls,
              inputTokens,
              estCostUsd: Math.round(estCostUsd * 100000) / 100000,
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
