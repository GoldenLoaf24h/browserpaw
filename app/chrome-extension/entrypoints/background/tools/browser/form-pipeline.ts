import { type ToolCallContext, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { raceCdp, DialogOpenedError, isCdpOutcomeUncertainError } from '@/utils/race-cdp';
import { computePerceptiveDelta, type PerceptiveSignature } from './dom-indexer';
import { tabFaviconManager } from './tab-favicon';
import { withActionReceipt, attachActionReceipt } from '@/utils/action-receipt';
import { interactIndexTool } from './interact-index';
import { performPhysicalFill } from './fill-core';
import { matchSemantically, type JevSemanticMatchResponse } from '@/utils/form-semantic-matcher';
import { throwIfAborted, waitWithAbort } from '@/utils/action-abort';
import {
  createInteractionErrorResponse,
  makeInteractionOutcome,
} from '@/utils/interaction-outcome';

export interface FormPipelineField {
  query: string;
  value: string;
  type?: 'text' | 'choice' | 'enter';
}

export interface FormPipelineParams {
  fields: FormPipelineField[];
  maxSteps?: number;
  timeoutMs?: number;
  autoAdvance?: boolean;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class FormPipelineTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FORM_PIPELINE;

  /**
   * Delegates physical click to interactIndexTool, reusing unified
   * actionability checks, cross-frame projections, and action receipts.
   * Halts on failure without synthetic replay.
   */
  private async dispatchNativeClick(
    tabId: number,
    index: number,
    deadlineAt?: number,
    signal?: AbortSignal,
    context?: ToolCallContext,
  ): Promise<ToolResult> {
    throwIfAborted(signal, 'before a form click');
    const res = await interactIndexTool.execute(
      {
        tabId,
        index,
        action: 'click',
        skipLock: true,
        includeDelta: false,
        ...(deadlineAt ? { expectedDeadlineAt: deadlineAt } : {}),
      },
      { ...(context ?? {}), signal },
    );
    let parsed: any;
    try {
      const last = res.content?.[res.content.length - 1];
      if (last?.type === 'text' && typeof last.text === 'string') {
        parsed = JSON.parse(last.text);
      }
    } catch {}
    if (res.isError || parsed?.success !== true) {
      const error = new Error(`Form click failed: ${JSON.stringify(parsed ?? res.content)}`);
      const dispatched =
        parsed?.requestDispatched ??
        parsed?.dispatched ??
        !['blocked', 'cancelled'].includes(parsed?.status);
      Object.assign(error, {
        status: dispatched ? 'unknown' : parsed?.status || 'blocked',
        requestDispatched: dispatched,
        receipt: parsed?.receipt,
        lastReceipt: res,
      });
      throw error;
    }
    return res;
  }

  private static readonly MAX_STEPS = 60;
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;
  private static readonly MAX_TIMEOUT_MS = 300_000;

  async execute(args: FormPipelineParams, context?: ToolCallContext): Promise<ToolResult> {
    if (!args || !Array.isArray(args.fields) || args.fields.length === 0) {
      return createInteractionErrorResponse(
        'fields parameter must be a non-empty array of field descriptors',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'invalid_fields', 0),
        { status: 'blocked', requestDispatched: false },
      );
    }
    if (args.autoAdvance === true) {
      return createInteractionErrorResponse(
        'autoAdvance is retired. Fill the current form only, then list the next click or key step explicitly in chrome_batch_actions.',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'migration_required', 0),
        {
          status: 'blocked',
          reason: 'migration_required',
          requestDispatched: false,
        },
      );
    }

    const signal = context?.signal;
    const completedFields: Array<
      FormPipelineField & {
        matchedQuestion?: string;
        step: number;
        verification: 'verified' | 'not_requested';
      }
    > = [];
    const completedIndices = new Set<number>();
    const completedInputIndices = new Set<number>();
    const semanticDecisions: Array<Record<string, unknown>> = [];
    let dispatchedActionCount = 0;
    let lastReceipt: unknown;
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createInteractionErrorResponse(
          'No active tab found for chrome_form_pipeline',
          makeInteractionOutcome('not_dispatched', 'not_requested', 'no_active_tab', 0),
          { status: 'blocked', requestDispatched: false },
        );
      }
      const tabId = tab.id;
      tabFaviconManager.markTabActive(tabId);
      const requestedTimeout =
        typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
          ? Math.floor(args.timeoutMs)
          : FormPipelineTool.DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(FormPipelineTool.MAX_TIMEOUT_MS, Math.max(1, requestedTimeout));
      const deadlineAt = Date.now() + timeoutMs;

      return await sessionTabAffinity.runSerialized(tabId, () =>
        withActionReceipt(
          tabId,
          async () => {
            const requestedSteps =
              typeof args.maxSteps === 'number' ? Math.floor(args.maxSteps) : 20;
            const maxSteps = Math.min(
              FormPipelineTool.MAX_STEPS,
              Math.max(1, Number.isFinite(requestedSteps) ? requestedSteps : 20),
            );
            let status: 'completed' | 'partial' | 'interrupted' | 'timeout' | 'unknown' =
              'completed';
            let reason = 'all_requested_fields_processed';
            let interruptDetails: any = undefined;
            const remainingMs = () => Math.max(0, deadlineAt - Date.now());

            pipelineLoop: for (let step = 1; step <= maxSteps; step++) {
              throwIfAborted(signal, 'before a form pipeline step');
              if (remainingMs() <= 0) {
                status = 'timeout';
                reason = 'deadline_exceeded';
                break;
              }
              if (completedIndices.size >= args.fields.length) {
                status = 'completed';
                reason = 'all_requested_fields_processed';
                break;
              }

              // 1. CAPTCHA guard check
              const captchaRes = await executeInPage(
                { tabId },
                'inPageCheckCaptcha',
                [],
                remainingMs(),
              )
                .then((r) => r?.[0]?.result)
                .catch(() => null);
              if (captchaRes?.detected) {
                status = 'interrupted';
                reason = 'captcha_detected';
                interruptDetails = { captchaType: captchaRes.type };
                break;
              }

              // 2. Capture perceptive signature of active viewport
              const preSigEntry = await executeInPage(
                { tabId },
                'inPageDetectPerceptiveSignature',
                [],
                remainingMs(),
              )
                .then((r) => r?.[0])
                .catch(() => null);
              const preSig = preSigEntry?.result as PerceptiveSignature | null;
              const availableInputs = (preSig?.activeInputs ?? []).filter(
                (input) =>
                  typeof input.index !== 'number' || !completedInputIndices.has(input.index),
              );
              const semanticOptions = {
                signal,
                deadlineAt,
                inferenceBudget: { remaining: 1 },
                onDecision: (decision: JevSemanticMatchResponse) =>
                  semanticDecisions.push({
                    step,
                    status: decision.status,
                    backend: decision.backend,
                    model: decision.model,
                    latencyMs: decision.latencyMs,
                    attempts: decision.attempts,
                    usage: decision.usage,
                    cacheHit: decision.cacheHit,
                  }),
                taskId: context?.taskId,
                pageIdentity: JSON.stringify([
                  tabId,
                  preSigEntry?.documentId,
                  preSig?.question,
                  preSig?.progress,
                ]),
              };
              let semanticUsed = false;
              const semanticTargetUnchanged = async () => {
                if (!semanticUsed) return true;
                throwIfAborted(signal, 'before semantic form verification');
                const fresh = await executeInPage(
                  { tabId },
                  'inPageDetectPerceptiveSignature',
                  [],
                  remainingMs(),
                )
                  .then((rows) => rows?.[0])
                  .catch((error) => {
                    interruptDetails = {
                      error: error instanceof Error ? error.message : String(error),
                    };
                    return null;
                  });
                const identity = (signature: PerceptiveSignature | null | undefined) =>
                  JSON.stringify([
                    signature?.question,
                    signature?.progress,
                    signature?.activeInputs,
                  ]);
                return Boolean(
                  preSigEntry?.documentId &&
                  fresh?.documentId === preSigEntry.documentId &&
                  fresh.result &&
                  identity(fresh.result) === identity(preSig),
                );
              };

              // 3. Validation error check from previous action
              if (step > 1 && preSig?.alerts && preSig.alerts.length > 0) {
                const hasBlockingError = preSig.alerts.some((a) =>
                  /(required|invalid|error|cannot be blank|please enter|必填|错误|请填写|有效)/i.test(
                    a,
                  ),
                );
                if (hasBlockingError) {
                  status = 'interrupted';
                  reason = 'validation_error';
                  interruptDetails = { alerts: preSig.alerts };
                  break;
                }
              }

              // 4. Match active screen to an uncompleted field
              let matchedIndex = -1;
              let matchedInputIndex: number | undefined;

              // Prefer a unique exact field description before a unique partial description.
              if (preSig?.question) {
                const question = preSig.question.trim().toLowerCase();
                const pending = args.fields
                  .map((field, index) => ({ query: field.query.trim().toLowerCase(), index }))
                  .filter((field) => !completedIndices.has(field.index));
                const exact = pending.filter((field) => field.query === question);
                const matches = exact.length
                  ? exact
                  : pending.filter(
                      (field) => question.includes(field.query) || field.query.includes(question),
                    );
                if (matches.length === 1) matchedIndex = matches[0].index;
              }

              // Candidate 1.5: bounded semantic match between question and uncompleted fields
              if (matchedIndex === -1 && preSig?.question && availableInputs.length === 1) {
                const uncompletedCandidates = args.fields
                  .map((f, i) => ({ id: i, text: f.query }))
                  .filter((c) => !completedIndices.has(Number(c.id)));
                if (uncompletedCandidates.length > 1) {
                  const semMatch = await matchSemantically(
                    'field',
                    preSig.question,
                    uncompletedCandidates,
                    undefined,
                    undefined,
                    semanticOptions,
                  );
                  if (semMatch) {
                    semanticUsed ||= semMatch.engine === 'jev';
                    matchedIndex = Number(semMatch.matchedId);
                  }
                }
              }

              // A field may select only one matching input; DOM order is not disambiguation.
              if (matchedIndex === -1 && availableInputs.length) {
                for (let i = 0; i < args.fields.length; i++) {
                  if (completedIndices.has(i)) continue;
                  const query = args.fields[i].query.trim().toLowerCase();
                  const terms = (input: PerceptiveSignature['activeInputs'][number]) =>
                    [input.name, input.placeholder, input.ariaLabel]
                      .filter(Boolean)
                      .map((value) => value!.trim().toLowerCase());
                  const exact = availableInputs.filter((input) => terms(input).includes(query));
                  const matches = exact.length
                    ? exact
                    : availableInputs.filter((input) =>
                        terms(input).some((term) => term.includes(query) || query.includes(term)),
                      );
                  if (matches.length === 1) {
                    matchedIndex = i;
                    matchedInputIndex = matches[0].index;
                    break;
                  }
                }
              }

              // Candidate 2.5: bounded semantic match between active inputs and uncompleted fields
              if (matchedIndex === -1 && availableInputs.length === 1) {
                const uncompletedCandidates = args.fields
                  .map((f, i) => ({ id: i, text: f.query }))
                  .filter((c) => !completedIndices.has(Number(c.id)));

                for (const inp of availableInputs) {
                  const inpDescriptor = [inp.name, inp.placeholder, inp.ariaLabel]
                    .filter(Boolean)
                    .join(' ');
                  if (!inpDescriptor) continue;
                  const semMatch = await matchSemantically(
                    'input',
                    inpDescriptor,
                    uncompletedCandidates,
                    undefined,
                    undefined,
                    semanticOptions,
                  );
                  if (semMatch) {
                    semanticUsed ||= semMatch.engine === 'jev';
                    matchedIndex = Number(semMatch.matchedId);
                    matchedInputIndex = inp.index;
                    break;
                  }
                }
              }

              const fieldIdentified = matchedIndex !== -1;
              // Choose the next requested field for lookup; this does not authorize a default input.
              if (matchedIndex === -1) {
                for (let i = 0; i < args.fields.length; i++) {
                  if (!completedIndices.has(i)) {
                    matchedIndex = i;
                    break;
                  }
                }
              }

              // If no field could be matched or no interactive element found
              if (matchedIndex === -1) {
                if (completedIndices.size > 0) {
                  status = 'partial';
                  reason = 'explicit_continuation_required';
                  interruptDetails = {
                    completedStep: step,
                    message:
                      'No field on the current form matches the remaining fields. Advance with an explicit click or key step in chrome_batch_actions.',
                  };
                } else {
                  status = 'interrupted';
                  reason = 'no_active_inputs';
                }
                break;
              }

              const currentField = args.fields[matchedIndex];
              const fieldType = currentField.type ?? 'text';
              const recordCurrentField = (verification: 'verified' | 'not_requested'): void => {
                if (completedIndices.has(matchedIndex)) return;
                completedIndices.add(matchedIndex);
                completedFields.push({
                  ...currentField,
                  matchedQuestion: preSig?.question,
                  step,
                  verification,
                });
                if (typeof consumedInputIndex === 'number') {
                  completedInputIndices.add(consumedInputIndex);
                }
              };

              // 5. Execute action using native CDP events
              let consumedInputIndex: number | undefined;
              if (fieldType === 'choice') {
                let choiceTargetIndex: number | undefined;
                const loc = (
                  await executeInPage(
                    {
                      tabId,
                    },
                    'inPageLocateByText',
                    [currentField.value, { exact: false, visibleOnly: true, threshold: 0 }],
                    remainingMs(),
                  )
                )?.[0]?.result;

                if (loc && typeof loc.index === 'number') {
                  choiceTargetIndex = loc.index;
                } else {
                  // Semantic search for choice among interactive options or visible elements on page
                  try {
                    const domItems = (
                      await executeInPage(
                        { tabId },
                        'inPageQueryChoiceCandidates',
                        [],
                        remainingMs(),
                      )
                    )?.[0]?.result;
                    if (Array.isArray(domItems) && domItems.length > 0) {
                      const choiceCandidates = domItems
                        .filter(
                          (item: any) =>
                            typeof item.index === 'number' &&
                            (item.text || item.ariaLabel || item.value),
                        )
                        .map((item: any) => ({
                          id: item.index,
                          text: String(item.text || item.ariaLabel || item.value || '').trim(),
                          details: item.ariaLabel || item.value || '',
                        }));
                      const semChoice = await matchSemantically(
                        'choice',
                        currentField.query,
                        choiceCandidates,
                        currentField.value,
                        undefined,
                        semanticOptions,
                      );
                      if (semChoice) {
                        semanticUsed ||= semChoice.engine === 'jev';
                        choiceTargetIndex = Number(semChoice.matchedId);
                      }
                    }
                  } catch {}
                }

                if (remainingMs() <= 0) {
                  status = 'timeout';
                  reason = 'deadline_exceeded';
                  break;
                }
                if (typeof choiceTargetIndex === 'number') {
                  if (!(await semanticTargetUnchanged())) {
                    status = 'interrupted';
                    reason = 'semantic_target_changed';
                    break pipelineLoop;
                  }
                  const clickResult = await this.dispatchNativeClick(
                    tabId,
                    choiceTargetIndex,
                    deadlineAt,
                    signal,
                    context,
                  );
                  dispatchedActionCount += 1;
                  lastReceipt = clickResult;
                } else {
                  status = 'interrupted';
                  reason = 'choice_not_found';
                  interruptDetails = {
                    choiceValue: currentField.value,
                    fieldQuery: currentField.query,
                  };
                  break;
                }
              } else if (fieldType === 'enter') {
                if (remainingMs() <= 0) {
                  status = 'timeout';
                  reason = 'deadline_exceeded';
                  break;
                }
                await cdpSessionManager.withSession(tabId, 'form-pipeline-enter', async () => {
                  await raceCdp(
                    tabId,
                    'Input.dispatchKeyEvent',
                    {
                      type: 'keyDown',
                      key: 'Enter',
                      code: 'Enter',
                      text: '\r',
                      unmodifiedText: '\r',
                      windowsVirtualKeyCode: 13,
                      nativeVirtualKeyCode: 13,
                    },
                    remainingMs(),
                  );
                  await raceCdp(
                    tabId,
                    'Input.dispatchKeyEvent',
                    {
                      type: 'keyUp',
                      key: 'Enter',
                      code: 'Enter',
                      windowsVirtualKeyCode: 13,
                      nativeVirtualKeyCode: 13,
                    },
                    remainingMs(),
                  );
                });
                dispatchedActionCount += 1;
              } else {
                // Text fill with True Input Commitment
                const targetIndex =
                  matchedInputIndex ??
                  (fieldIdentified && availableInputs.length === 1
                    ? availableInputs[0].index
                    : undefined);
                let finalTargetIndex: number | undefined = targetIndex;

                if (typeof finalTargetIndex !== 'number') {
                  const loc = (
                    await executeInPage(
                      {
                        tabId,
                      },
                      'inPageLocateByText',
                      [currentField.query, { exact: false, visibleOnly: true, threshold: 0 }],
                      remainingMs(),
                    )
                  )?.[0]?.result;
                  if (
                    loc &&
                    typeof loc.index === 'number' &&
                    availableInputs.some((input) => input.index === loc.index)
                  ) {
                    finalTargetIndex = loc.index;
                  } else if (availableInputs.length > 0) {
                    // Semantic match field query against active inputs
                    const inputCandidates = availableInputs
                      .filter((inp) => typeof inp.index === 'number')
                      .map((inp) => ({
                        id: inp.index!,
                        text:
                          [inp.name, inp.placeholder, inp.ariaLabel].filter(Boolean).join(' ') ||
                          `input-${inp.index}`,
                      }));
                    const semInput = await matchSemantically(
                      'input',
                      currentField.query,
                      inputCandidates,
                      currentField.value,
                      undefined,
                      semanticOptions,
                    );
                    if (semInput) {
                      semanticUsed ||= semInput.engine === 'jev';
                      finalTargetIndex = Number(semInput.matchedId);
                    }
                  }
                }

                if (remainingMs() <= 0) {
                  status = 'timeout';
                  reason = 'deadline_exceeded';
                  break;
                }
                if (typeof finalTargetIndex === 'number') {
                  if (!(await semanticTargetUnchanged())) {
                    status = 'interrupted';
                    reason = 'semantic_target_changed';
                    break pipelineLoop;
                  }
                  const matchedInput = availableInputs.find(
                    (input) => input.index === finalTargetIndex,
                  );
                  consumedInputIndex = finalTargetIndex;
                  const fillOptions = {
                    tabId,
                    target: finalTargetIndex,
                    text: currentField.value,
                    clear: true,
                    pressEnter: false,
                    preferComposer: true,
                    sessionId: args.sessionId,
                    sessionContext: args.sessionContext,
                    frameId: (matchedInput as any)?.frameId,
                    deadlineAt,
                    signal,
                  } as Parameters<typeof performPhysicalFill>[0] & { deadlineAt?: number };
                  throwIfAborted(signal, 'before a form field fill');
                  const fillResult = await performPhysicalFill(fillOptions);
                  const fillExecutionStatus = fillResult.interaction?.execution.status;
                  if (
                    fillResult.committed === true ||
                    fillExecutionStatus === 'dispatched' ||
                    fillExecutionStatus === 'unknown'
                  ) {
                    dispatchedActionCount += 1;
                  }
                  if (fillResult.committed === true) {
                    // The field value was independently read back and matched.
                    // Record it before timeout/unknown handling so a later
                    // transport failure cannot erase the completed field.
                    recordCurrentField('verified');
                  }
                  if (fillResult.receipt) {
                    lastReceipt = fillResult.receipt;
                  }
                  if (
                    remainingMs() <= 0 ||
                    fillResult.status === 'timeout' ||
                    fillResult.deadlineExceeded
                  ) {
                    status = 'timeout';
                    reason = 'deadline_exceeded';
                    interruptDetails = {
                      fieldQuery: currentField.query,
                      committed: fillResult.committed,
                      message: fillResult.error || 'Fill deadline exceeded',
                    };
                    break;
                  }
                  if (fillResult.status === 'unknown') {
                    status = 'unknown';
                    reason = 'fill_outcome_unknown';
                    interruptDetails = {
                      fieldQuery: currentField.query,
                      error: fillResult.error,
                    };
                    break;
                  }
                  if (!fillResult.success || fillResult.committed === false) {
                    status = 'interrupted';
                    reason = 'fill_failed';
                    interruptDetails = {
                      fieldQuery: currentField.query,
                      error: fillResult.diagnostics || fillResult.error,
                    };
                    break;
                  }
                } else {
                  status = 'interrupted';
                  reason = 'input_not_found';
                  interruptDetails = { fieldQuery: currentField.query };
                  break;
                }
              }

              // 7. Settle, perceive advancement, and guard against stuck loops
              const settleBudget = remainingMs();
              if (settleBudget >= 200) {
                await waitForPageSettle(tabId, {
                  timeoutMs: Math.min(1500, settleBudget),
                  hasActiveRequests: false,
                });
              }

              const postSig = (await executeInPage(
                { tabId },
                'inPageDetectPerceptiveSignature',
                [],
                remainingMs(),
              )
                .then((r) => r?.[0]?.result)
                .catch(() => null)) as PerceptiveSignature | null;

              // Check if postSig reveals blocking validation errors
              if (postSig?.alerts && postSig.alerts.length > 0) {
                const hasBlockingError = postSig.alerts.some((a) =>
                  /(required|invalid|error|cannot be blank|please enter|必填|错误|请填写|有效)/i.test(
                    a,
                  ),
                );
                if (hasBlockingError) {
                  status = 'interrupted';
                  reason = 'validation_error';
                  interruptDetails = { alerts: postSig.alerts };
                  break;
                }
              }

              const delta = computePerceptiveDelta(preSig, postSig);
              const pageStepChanged = Boolean(
                delta?.advanced ||
                (preSig?.question && postSig?.question && preSig.question !== postSig.question) ||
                (preSig?.progress && postSig?.progress && preSig.progress !== postSig.progress) ||
                (step === 1 && postSig?.question && !preSig?.question) ||
                (preSig?.question && !postSig?.question) ||
                delta?.urlChanged,
              );

              // Choice and Enter are explicit actions. Their dispatch is known,
              // but their business effect is not inferred from page change.
              recordCurrentField('not_requested');
              const remainingVisibleInputs = (postSig?.activeInputs ?? []).filter(
                (input) =>
                  typeof input.index !== 'number' || !completedInputIndices.has(input.index),
              );

              if (remainingMs() <= 0) {
                status = 'timeout';
                reason = 'deadline_exceeded';
              } else if (completedIndices.size >= args.fields.length) {
                status = 'completed';
                reason = 'all_fields_completed';
              } else if (pageStepChanged) {
                status = 'partial';
                reason = 'explicit_continuation_required';
                interruptDetails = {
                  completedStep: step,
                  nextQuestion: postSig?.question,
                  message:
                    'The page advanced after an explicit action. Continue with the next click or key step in chrome_batch_actions.',
                };
              } else if (remainingVisibleInputs.length === 0) {
                status = 'partial';
                reason = 'explicit_continuation_required';
                interruptDetails = {
                  completedStep: step,
                  message:
                    'No unused input from the current form matches the remaining fields. Advance the form with an explicit click or key step in chrome_batch_actions.',
                };
                break;
              } else if (step === maxSteps && completedIndices.size < args.fields.length) {
                status = 'partial';
                reason = 'max_steps_reached';
              }
            }

            const finalSig = (await executeInPage(
              { tabId },
              'inPageDetectPerceptiveSignature',
              [],
              remainingMs(),
            )
              .then((r) => r?.[0]?.result)
              .catch(() => null)) as PerceptiveSignature | null;
            const updatedTab = await chrome.tabs.get(tabId).catch(() => null);
            const verificationStatus =
              status === 'completed'
                ? completedFields.every((field) => field.verification === 'verified')
                  ? 'verified'
                  : 'not_requested'
                : 'failed';
            const executionStatus =
              status === 'unknown'
                ? 'unknown'
                : dispatchedActionCount > 0
                  ? 'dispatched'
                  : 'not_dispatched';

            const output = {
              success: status === 'completed',
              status,
              reason,
              completionScope: 'current_step_actions',
              businessOutcome: 'not_verified',
              stepsExecuted: completedFields.length,
              dispatchedActions: dispatchedActionCount,
              completedFields,
              ...(semanticDecisions.length ? { semanticDecisions } : {}),
              remainingFields: args.fields.filter((_, idx) => !completedIndices.has(idx)),
              currentQuestion: finalSig?.question,
              progress: finalSig?.progress,
              url: updatedTab?.url || tab.url || '',
              interaction: makeInteractionOutcome(
                executionStatus,
                verificationStatus,
                reason,
                dispatchedActionCount,
              ),
              ...(interruptDetails ? { interruptDetails } : {}),
              ...(lastReceipt ? { lastReceipt } : {}),
            };

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(output),
                },
              ],
              isError: status !== 'completed',
            };
          },
          { settleMs: Math.min(50, Math.max(0, deadlineAt - Date.now())) },
        ),
      );
    } catch (error) {
      const details = error as any;
      const status =
        error instanceof DialogOpenedError ||
        isCdpOutcomeUncertainError(error) ||
        details?.status === 'unknown'
          ? 'unknown'
          : signal?.aborted || details?.status === 'cancelled'
            ? 'cancelled'
            : details?.status === 'timeout'
              ? 'timeout'
              : 'blocked';
      const unknown = status === 'unknown';
      const dispatched =
        unknown || details?.requestDispatched === true || dispatchedActionCount > 0;
      const effectiveDispatchedCount =
        dispatchedActionCount +
        (details?.requestDispatched === true || (unknown && details?.requestDispatched !== false)
          ? 1
          : 0);
      return attachActionReceipt(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status,
                retry: false,
                completionScope: 'current_step_actions',
                businessOutcome: 'not_verified',
                requestDispatched: dispatched,
                partial: completedFields.length > 0 || dispatched || unknown,
                stepsExecuted: completedFields.length,
                dispatchedActions: effectiveDispatchedCount,
                completedFields,
                ...(semanticDecisions.length ? { semanticDecisions } : {}),
                remainingFields: args.fields.filter((_, index) => !completedIndices.has(index)),
                interaction: makeInteractionOutcome(
                  unknown ? 'unknown' : dispatched ? 'dispatched' : 'not_dispatched',
                  'failed',
                  status,
                  effectiveDispatchedCount,
                ),
                error: error instanceof Error ? error.message : String(error),
                ...((details?.lastReceipt ?? lastReceipt)
                  ? { lastReceipt: details?.lastReceipt ?? lastReceipt }
                  : {}),
                ...(error instanceof DialogOpenedError
                  ? { requiresDialogAction: true, dialog: error.dialog }
                  : {}),
              }),
            },
          ],
          isError: true,
        },
        details?.receipt,
      );
    }
  }
}

export const formPipelineTool = new FormPipelineTool();
