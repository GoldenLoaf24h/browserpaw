/**
 * BrowserPaw x Jev Type Definitions
 * Strict contracts for System One state, questions, actions, and decision engines.
 */

export interface JevPageState {
  url: string;
  title: string;
}

export interface JevHistoryItem {
  step: number;
  action: string;
  outcome: string;
}

export interface JevState {
  task: string;
  page: JevPageState;
  elements: string[];
  history: JevHistoryItem[];
  pending_modal?: string;
}

export type JevActionType =
  'click' | 'type' | 'select' | 'scroll_down' | 'scroll_up' | 'back' | 'wait' | 'done' | 'escalate';

export interface JevUsage {
  calls: number;
  inputTokens: number;
  estCostUsd: number;
}

export interface JevSuggestion {
  action: string;
  target?: string;
  confidence: number;
  probabilities: Record<string, number>;
  speculativeTargets?: Record<string, string>;
}

export interface StepRecord {
  step: number;
  action: string;
  target: string;
  confidence: number;
  jevSuggestion?: JevSuggestion;
  outcome: string;
}

export type DecisionEngineType = 'jev' | 'heuristic';

export type ActTowardGoalStatus =
  'done' | 'escalate' | 'stuck' | 'blocked' | 'max_steps' | 'timeout' | 'paused';

export interface PausedBeforeAction {
  action: string;
  target?: string;
  matchedKeyword: string;
}

export type FallbackReason =
  'no_api_key' | 'invalid_key' | 'quota_exhausted' | 'rate_limited' | 'network_error' | null;

export interface ActTowardGoalParams {
  goal: string;
  tabId?: number;
  maxSteps?: number;
  timeoutMs?: number;
  textHint?: string;
  confidenceThreshold?: number;
  pauseBeforeKeywords?: string[];
  sessionId?: string;
  sessionContext?: string;
  _meta?: {
    progressToken?: string | number;
    [key: string]: any;
  };
}

export interface ActTowardGoalResult {
  status: ActTowardGoalStatus;
  engine: DecisionEngineType;
  engineSwitched: boolean;
  fallbackReason: FallbackReason;
  reason?: string;
  pausedBeforeAction?: PausedBeforeAction;
  steps: StepRecord[];
  finalPage: JevPageState;
  currentElements?: string[];
  jevUsage?: JevUsage;
}
