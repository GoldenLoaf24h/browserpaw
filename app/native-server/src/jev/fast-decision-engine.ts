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
      // Non-Latin/CJK characters (e.g. "确认提交", "发布", "付款") - substring match
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

    const timeoutMs = Math.min(Math.max(1, params.timeoutMs ?? 90_000), 300_000);
    const confidenceThreshold = params.confidenceThreshold ?? 0.55;
    const startTime = Date.now();

    const steps: StepRecord[] = [];
    const history: JevHistoryItem[] = [];
    let jevCalls = 0;
    let inputTokens = 0;

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

    for (let step = 1; step <= maxSteps; step++) {
      // Check wall-clock timeout
      if (Date.now() - startTime >= timeoutMs) {
        return this.formatResult(
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
        const textContent = domResult?.content?.[0]?.text;
        domData = textContent ? JSON.parse(textContent) : {};
      } catch (err: any) {
        return this.formatResult(
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
        url: domData.tabUrl || '',
        title: domData.tabTitle || '',
      };

      const treeString: string = domData.treeString || '';
      currentElements = treeString
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      // Check stuck condition for heuristic mode (§4.3)
      if (engine === 'heuristic' && this.heuristicEngine.isStuck(history)) {
        return this.formatResult(
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
          return this.formatResult(
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

      if (engine === 'jev') {
        const state = buildState(
          params.goal,
          finalPage.url,
          finalPage.title,
          currentElements,
          history,
          domData.modalIsolated ? 'modal dialog active' : undefined,
        );
        const questions = buildQuestions(state.elements, params.goal);

        const queryRes = await this.jevClient.query(state, questions, currentMode);
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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

          if (targetAnswer) {
            const expectedTargetKeys = [...extractElementIndices(state.elements), 'none'];
            const validTargetChoice = validateChoice(targetAnswer, expectedTargetKeys);
            if (!validTargetChoice) {
              return this.formatResult(
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
              return this.formatResult(
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
              const top3 = getTop3Probabilities(targetAnswer.probabilities);
              const top3Str = Object.entries(top3)
                .map(([k, v]) => `[${k}]: ${v}`)
                .join(', ');
              return this.formatResult(
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
                return this.formatResult(
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
              return this.formatResult(
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
            return this.formatResult(
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
          return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            return this.formatResult(
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
            params.pressEnter === true ||
            (params.pressEnter === undefined &&
              /(search|搜索|submit|提交|回车|press enter)/i.test(params.goal));
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
            return this.formatResult(
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
            return this.formatResult(
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
              return this.formatResult(
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

    return this.formatResult(
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
  ): ActTowardGoalResult {
    const estCostUsd = (inputTokens / 1_000_000) * 0.042;

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
      ...(jevCalls > 0
        ? {
            jevUsage: {
              calls: jevCalls,
              inputTokens,
              estCostUsd: Math.round(estCostUsd * 100000) / 100000,
            },
          }
        : {}),
    };
  }
}
