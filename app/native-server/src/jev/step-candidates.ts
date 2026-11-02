import { choice, noul } from '@typesafe-ai/sdk';
import { isDestructiveTarget } from './jev-client';

export type CandidateActionType =
  'click' | 'type' | 'select' | 'scroll_down' | 'scroll_up' | 'back' | 'wait' | 'done' | 'none';

export interface StepCandidate {
  key: string;
  action: CandidateActionType;
  targetIndex?: number;
  targetLine?: string;
  description: string;
  isDestructive: boolean;
}

export interface StepCandidatesResult {
  candidates: StepCandidate[];
  candidateKeys: string[];
  candidateMap: Map<string, StepCandidate>;
  questions: Record<string, any>;
  omittedCount: number;
}

/**
 * Builds candidate action steps from page elements and action capabilities.
 * Produces unified 'next_step' choice containing concrete element actions plus
 * none / wait / done / navigation, eliminating freeform action+target mismatch.
 */
export function buildStepCandidates(
  elements: string[],
  goal?: string,
  observedActions?: Array<{
    node?: string | number;
    kind?: string;
    label?: string;
    containerIndex?: number;
  }>,
): StepCandidatesResult {
  const candidates: StepCandidate[] = [];
  const candidateMap = new Map<string, StepCandidate>();

  const descriptions = new Map<string, string>();
  const available: Array<{ index: string; action: 'click' | 'type' | 'select'; line: string }> = [];
  const observedScrolls = new Map<'scroll_down' | 'scroll_up', number | undefined>();
  for (const line of elements) {
    const match = line.match(/^\[(\d+)\](?:\s*\[[^\]]+\])*\s*([a-zA-Z0-9_-]+)(.*)$/);
    if (!match) continue;
    const [, index, role] = match;
    descriptions.set(index, line);
    if (observedActions) continue;
    const action = /^(textbox|input|textarea|searchbox)$/.test(role)
      ? 'type'
      : /^(select|combobox|dropdown)$/.test(role)
        ? 'select'
        : /^(button|link|checkbox|radio|tab|menuitem|switch)$/.test(role)
          ? 'click'
          : null;
    if (action) available.push({ index, action, line });
  }
  if (observedActions) {
    for (const item of observedActions) {
      if (item.kind === 'scroll') {
        const action = item.label?.toLowerCase().includes('up') ? 'scroll_up' : 'scroll_down';
        observedScrolls.set(
          action,
          typeof item.containerIndex === 'number' ? item.containerIndex : undefined,
        );
        continue;
      }
      const index = String(item.node ?? '');
      if (!/^[1-9]\d*$/.test(index)) continue;
      const action =
        item.kind === 'fill'
          ? 'type'
          : item.kind === 'click'
            ? 'click'
            : item.kind === 'select'
              ? 'select'
              : null;
      if (!action) continue;
      const line = descriptions.get(index) || '[' + index + '] ' + (item.label || action);
      available.push({ index, action, line });
    }
  }
  for (const { index, action, line } of available) {
    const key = action + '_' + index;
    if (candidateMap.has(key) || isDestructiveTarget(line)) continue;
    const candidate: StepCandidate = {
      key,
      action,
      targetIndex: Number(index),
      targetLine: line,
      description: action + ': ' + line,
      isDestructive: false,
    };
    candidates.push(candidate);
    candidateMap.set(key, candidate);
  }
  // Never present an arbitrary prefix as complete candidate coverage.
  const omittedCount = candidates.length > 26 ? candidates.length : 0;
  if (omittedCount) {
    candidates.length = 0;
    candidateMap.clear();
  }

  const scrollActions: StepCandidate[] = (['scroll_down', 'scroll_up'] as const).flatMap(
    (action) => {
      if (observedActions && !observedScrolls.has(action)) return [];
      return [
        {
          key: action,
          action,
          ...(observedScrolls.get(action) !== undefined
            ? { targetIndex: observedScrolls.get(action) }
            : {}),
          description:
            action === 'scroll_down'
              ? 'Scroll down to reveal more page content'
              : 'Scroll up to view content above',
          isDestructive: false,
        },
      ];
    },
  );

  const standardActions: StepCandidate[] = [
    ...scrollActions,
    {
      key: 'back',
      action: 'back',
      description: 'Navigate back to the previous page',
      isDestructive: false,
    },
    {
      key: 'wait',
      action: 'wait',
      description: 'Wait for page content to load or settle',
      isDestructive: false,
    },
    {
      key: 'done',
      action: 'done',
      description: 'The task goal has been fully completed',
      isDestructive: false,
    },
    {
      key: 'none',
      action: 'none',
      description: 'No suitable candidate action on current viewport',
      isDestructive: false,
    },
  ];

  for (const std of standardActions) {
    candidates.push(std);
    candidateMap.set(std.key, std);
  }

  const criteria: Record<string, string> = {};
  for (const cand of candidates) {
    criteria[cand.key] = cand.description;
  }

  const candidateKeys = candidates.filter((c) => c.key !== 'none').map((c) => c.key);

  const questions: Record<string, any> = {
    next_step: choice(
      'What is the single best next action step to advance toward the goal?',
      criteria,
    ),
    goal_done: noul(
      'Has the overall task goal been completely and successfully achieved based on the current page state and history?',
    ),
    stuck: noul('Is the execution stuck in a loop with no progress or change across recent steps?'),
  };

  return { candidates, candidateKeys, candidateMap, questions, omittedCount };
}
