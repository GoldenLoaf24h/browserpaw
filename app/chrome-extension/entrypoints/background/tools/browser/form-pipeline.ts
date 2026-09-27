import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { raceCdp, DialogOpenedError, createDialogInterruptResponse } from '@/utils/race-cdp';
import { computePerceptiveDelta, type PerceptiveSignature } from './dom-indexer';
import { tabFaviconManager } from './tab-favicon';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import { performPhysicalFill } from './fill-core';
import { matchSemantically } from '@/utils/form-semantic-matcher';

export interface FormPipelineField {
  query: string;
  value: string;
  type?: 'text' | 'choice' | 'enter';
}

export interface FormPipelineParams {
  fields: FormPipelineField[];
  maxSteps?: number;
  autoAdvance?: boolean;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class FormPipelineTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FORM_PIPELINE;

  /**
   * Dispatches a native CDP mouse click with virtual cursor animation.
   * Falls back to in-page synthetic click if CDP coordinates are unavailable.
   */
  private async dispatchNativeClick(tabId: number, index: number): Promise<boolean> {
    try {
      const coordRes = await executeInPage({ tabId }, 'inPageGetElementCoordinates', [index]);
      const coords = coordRes?.[0]?.result;
      if (coords?.success && typeof coords.x === 'number' && typeof coords.y === 'number') {
        const clickNote = `Clicking [${index}]`;
        await animateAgentCursor(tabId, coords.x, coords.y, {
          waitForArrival: true,
          timeoutMs: 350,
          actionNote: clickNote,
        });

        await cdpSessionManager.withSession(tabId, 'form-pipeline-click', async () => {
          await animateAgentCursorClick(tabId, coords.x, coords.y, clickNote);
          await raceCdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: coords.x,
            y: coords.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          await new Promise((r) => setTimeout(r, 35));
          await raceCdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: coords.x,
            y: coords.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });
        });
        return true;
      }
    } catch {}

    const fallbackRes = await executeInPage({ tabId }, 'inPageInteractIndex', [index, 'click']);
    return Boolean(fallbackRes?.[0]?.result?.success);
  }

  async execute(args: FormPipelineParams): Promise<ToolResult> {
    if (!args || !Array.isArray(args.fields) || args.fields.length === 0) {
      return createErrorResponse('fields parameter must be a non-empty array of field descriptors');
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_form_pipeline');
      }
      const tabId = tab.id;
      tabFaviconManager.markTabActive(tabId);

      return await sessionTabAffinity.runSerialized(tabId, async () => {
        const maxSteps =
          typeof args.maxSteps === 'number' && args.maxSteps > 0 ? args.maxSteps : 20;
        const autoAdvance = args.autoAdvance !== false;

        const completedFields: Array<
          FormPipelineField & { matchedQuestion?: string; step: number }
        > = [];
        const completedIndices = new Set<number>();
        let status: 'completed' | 'partial' | 'interrupted' = 'completed';
        let reason = 'all_fields_completed';
        let interruptDetails: any = undefined;
        let consecutiveStuck = 0;

        for (let step = 1; step <= maxSteps; step++) {
          if (completedIndices.size >= args.fields.length) {
            status = 'completed';
            reason = 'all_fields_completed';
            break;
          }

          // 1. CAPTCHA guard check
          const captchaRes = await executeInPage({ tabId }, 'inPageCheckCaptcha', [])
            .then((r) => r?.[0]?.result)
            .catch(() => null);
          if (captchaRes?.detected) {
            status = 'interrupted';
            reason = 'captcha_detected';
            interruptDetails = { captchaType: captchaRes.type };
            break;
          }

          // 2. Capture perceptive signature of active viewport
          const preSig = (await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
            .then((r) => r?.[0]?.result)
            .catch(() => null)) as PerceptiveSignature | null;

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

          // Candidate 1: match by question text
          if (preSig?.question) {
            const normQ = preSig.question.toLowerCase();
            for (let i = 0; i < args.fields.length; i++) {
              if (completedIndices.has(i)) continue;
              const normQuery = args.fields[i].query.toLowerCase();
              if (normQ.includes(normQuery) || normQuery.includes(normQ)) {
                matchedIndex = i;
                break;
              }
            }
          }

          // Candidate 1.5: Jev / heuristic semantic match between question and uncompleted fields
          if (matchedIndex === -1 && preSig?.question) {
            const uncompletedCandidates = args.fields
              .map((f, i) => ({ id: i, text: f.query, details: f.value }))
              .filter((c) => !completedIndices.has(Number(c.id)));
            if (uncompletedCandidates.length > 0) {
              const semMatch = await matchSemantically(
                'field',
                preSig.question,
                uncompletedCandidates,
              );
              if (semMatch) {
                matchedIndex = Number(semMatch.matchedId);
              }
            }
          }

          // Candidate 2: match by active inputs in current viewport
          if (matchedIndex === -1 && preSig?.activeInputs?.length) {
            for (const inp of preSig.activeInputs) {
              const inputTerms = [inp.name, inp.placeholder, inp.ariaLabel]
                .filter(Boolean)
                .map((t) => t!.toLowerCase());

              for (let i = 0; i < args.fields.length; i++) {
                if (completedIndices.has(i)) continue;
                const normQuery = args.fields[i].query.toLowerCase();
                if (inputTerms.some((t) => t.includes(normQuery) || normQuery.includes(t))) {
                  matchedIndex = i;
                  matchedInputIndex = inp.index;
                  break;
                }
              }
              if (matchedIndex !== -1) break;
            }
          }

          // Candidate 2.5: Jev / heuristic semantic match between active inputs and uncompleted fields
          if (matchedIndex === -1 && preSig?.activeInputs?.length) {
            const uncompletedCandidates = args.fields
              .map((f, i) => ({ id: i, text: f.query, details: f.value }))
              .filter((c) => !completedIndices.has(Number(c.id)));

            for (const inp of preSig.activeInputs) {
              const inpDescriptor = [inp.name, inp.placeholder, inp.ariaLabel]
                .filter(Boolean)
                .join(' ');
              if (!inpDescriptor) continue;
              const semMatch = await matchSemantically(
                'input',
                inpDescriptor,
                uncompletedCandidates,
              );
              if (semMatch) {
                matchedIndex = Number(semMatch.matchedId);
                matchedInputIndex = inp.index;
                break;
              }
            }
          }

          // Candidate 3: sequential fallback to next uncompleted field
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
              status = 'completed';
              reason = 'all_fields_completed';
            } else {
              status = 'interrupted';
              reason = 'no_active_inputs';
            }
            break;
          }

          const currentField = args.fields[matchedIndex];
          const fieldType = currentField.type ?? 'text';

          // 5. Execute action using native CDP events
          if (fieldType === 'choice') {
            let choiceTargetIndex: number | undefined;
            const loc = (
              await executeInPage({ tabId }, 'inPageLocateByText', [
                currentField.value,
                { exact: false, visibleOnly: true, threshold: 0 },
              ])
            )?.[0]?.result;

            if (loc && typeof loc.index === 'number') {
              choiceTargetIndex = loc.index;
            } else {
              // Semantic search for choice among interactive options or visible elements on page
              try {
                const domItems = (
                  await executeInPage({ tabId }, 'inPageQueryChoiceCandidates', [])
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
                  );
                  if (semChoice) {
                    choiceTargetIndex = Number(semChoice.matchedId);
                  }
                }
              } catch {}
            }

            if (typeof choiceTargetIndex === 'number') {
              const clicked = await this.dispatchNativeClick(tabId, choiceTargetIndex);
              if (!clicked) {
                status = 'interrupted';
                reason = 'choice_click_failed';
                interruptDetails = {
                  choiceValue: currentField.value,
                  fieldQuery: currentField.query,
                };
                break;
              }
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
            await cdpSessionManager.withSession(tabId, 'form-pipeline-enter', async () => {
              await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'Enter',
                code: 'Enter',
                text: '\r',
                unmodifiedText: '\r',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13,
              });
              await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13,
              });
            });
          } else {
            // Text fill with True Input Commitment
            const targetIndex = matchedInputIndex ?? preSig?.activeInputs?.[0]?.index;
            let finalTargetIndex: number | undefined = targetIndex;

            if (typeof finalTargetIndex !== 'number') {
              const loc = (
                await executeInPage({ tabId }, 'inPageLocateByText', [
                  currentField.query,
                  { exact: false, visibleOnly: true, threshold: 0 },
                ])
              )?.[0]?.result;
              if (loc && typeof loc.index === 'number') {
                finalTargetIndex = loc.index;
              } else if (preSig?.activeInputs && preSig.activeInputs.length > 0) {
                // Semantic match field query against active inputs
                const inputCandidates = preSig.activeInputs
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
                );
                if (semInput) {
                  finalTargetIndex = Number(semInput.matchedId);
                }
              }
            }

            if (typeof finalTargetIndex === 'number') {
              const fillResult = await performPhysicalFill({
                tabId,
                target: finalTargetIndex,
                text: currentField.value,
                clear: true,
                pressEnter: false,
                preferComposer: true,
                sessionId: args.sessionId,
                sessionContext: args.sessionContext,
              });
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

          // 6. Auto-advance if requested
          if (autoAdvance) {
            // Brief pause to observe if choice selection triggered instant SPA transition
            await new Promise((r) => setTimeout(r, 120));
            const midSig = (await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
              .then((r) => r?.[0]?.result)
              .catch(() => null)) as PerceptiveSignature | null;
            const midDelta = computePerceptiveDelta(preSig, midSig);

            if (!midDelta?.advanced) {
              let advanceClicked = false;
              const isLastField = completedIndices.size + 1 >= args.fields.length;
              const nextBtnCandidates = isLastField
                ? [
                    'Submit',
                    'Done',
                    'Finish',
                    'Complete',
                    'Send',
                    'OK',
                    'Next',
                    'Continue',
                    '提交',
                    '完成',
                    '下一步',
                    '确认',
                  ]
                : ['OK', 'Next', 'Continue', '下一步', '确认'];

              for (const kw of nextBtnCandidates) {
                const loc = (
                  await executeInPage({ tabId }, 'inPageLocateByText', [
                    kw,
                    { exact: false, visibleOnly: true, threshold: 0 },
                  ])
                )?.[0]?.result;
                if (
                  loc &&
                  typeof loc.index === 'number' &&
                  (loc.tagName === 'button' || loc.isClickable || loc.role === 'button')
                ) {
                  advanceClicked = await this.dispatchNativeClick(tabId, loc.index);
                  if (advanceClicked) break;
                }
              }

              if (!advanceClicked) {
                await cdpSessionManager.withSession(tabId, 'form-pipeline-advance', async () => {
                  await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    key: 'Enter',
                    code: 'Enter',
                    text: '\r',
                    unmodifiedText: '\r',
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13,
                  });
                  await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: 'Enter',
                    code: 'Enter',
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13,
                  });
                });
              }
            }
          }

          // 7. Settle, perceive advancement, and guard against stuck loops
          await waitForPageSettle(tabId, { timeoutMs: 1500 });

          const postSig = (await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
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
          const isLastField = completedIndices.size + 1 >= args.fields.length;

          const didAdvance = Boolean(
            delta?.advanced ||
            (preSig?.question && postSig?.question && preSig.question !== postSig.question) ||
            (preSig?.progress && postSig?.progress && preSig.progress !== postSig.progress) ||
            (step === 1 && postSig?.question && !preSig?.question) ||
            (preSig?.question && !postSig?.question) ||
            delta?.urlChanged ||
            isLastField,
          );

          if (autoAdvance && !didAdvance) {
            consecutiveStuck++;
            if (consecutiveStuck >= 2) {
              status = 'interrupted';
              reason = 'advance_stuck';
              interruptDetails = {
                stuckQuestion: preSig?.question || postSig?.question,
                fieldQuery: currentField.query,
                message: `Form failed to advance after fulfilling field "${currentField.query}". Guard triggered after 2 consecutive non-advancing steps.`,
              };
              break;
            }
          } else {
            consecutiveStuck = 0;
            completedIndices.add(matchedIndex);
            completedFields.push({
              ...currentField,
              matchedQuestion: preSig?.question || postSig?.question,
              step,
            });
          }

          if (step === maxSteps && completedIndices.size < args.fields.length) {
            status = 'partial';
            reason = 'max_steps_reached';
          }
        }

        const finalSig = (await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null)) as PerceptiveSignature | null;
        const updatedTab = await chrome.tabs.get(tabId).catch(() => null);

        const output = {
          status,
          reason,
          stepsExecuted: completedFields.length,
          completedFields,
          remainingFields: args.fields.filter((_, idx) => !completedIndices.has(idx)),
          currentQuestion: finalSig?.question,
          progress: finalSig?.progress,
          url: updatedTab?.url || tab.url || '',
          ...(interruptDetails ? { interruptDetails } : {}),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output),
            },
          ],
          isError: status === 'interrupted',
        };
      });
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing chrome_form_pipeline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const formPipelineTool = new FormPipelineTool();
