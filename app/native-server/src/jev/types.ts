/**
 * BrowserPaw x Jev Type Definitions
 * Strict contracts for System One state, questions, actions, and decision engines.
 */

import type { InteractionOutcome } from 'chrome-mcp-shared';

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
  page_text?: string;
  pending_modal?: string;
  context?: string;
}

export type JevActionType =
  'click' | 'type' | 'select' | 'scroll_down' | 'scroll_up' | 'back' | 'wait' | 'done' | 'escalate';

export interface JevUsage {
  calls: number;
  attempts?: number;
  successfulRequests?: number;
  inputTokens: number;
  outputTokens?: number | null;
  estCostUsd: number | null;
  backend?: 'remote' | 'local';
  model?: string;
  usageIncomplete?: boolean;
  visionCalls?: number;
  textLatencyMs?: number;
  visionLatencyMs?: number;
  visionModel?: string;
}

export interface VisionFrameInfo {
  id: string;
  width: number;
  height: number;
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
  | 'done'
  | 'escalate'
  | 'stuck'
  | 'blocked'
  | 'max_steps'
  | 'timeout'
  | 'paused'
  | 'cancelled'
  | 'unknown';

export type VerificationTool = 'chrome_read_dom' | 'chrome_network_request';

export interface VerificationSpec {
  tool: VerificationTool;
  args?: Record<string, any>;
  resultPath?: string;
  expect: Record<string, any>;
}

export interface VerificationResult {
  tool: VerificationTool;
  pass: boolean;
  error?: string;
  observed?: any;
  receipt?: any;
}

export interface PausedBeforeAction {
  action: string;
  target?: string;
  matchedKeyword: string;
}

export type FallbackReason =
  | 'no_api_key'
  | 'invalid_key'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'network_error'
  | 'invalid_response'
  | 'jev_disabled'
  | 'local_service_offline'
  | 'vision_model_unsupported'
  | 'mode_mismatch'
  | null;

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
  pressEnter?: boolean;
  mode?: 'off' | 'local' | 'remote';
  deadline?: number;
  verification?: VerificationSpec[];
  _meta?: {
    progressToken?: string | number;
    [key: string]: any;
  };
}

export interface FastDecisionRunOptions {
  signal?: AbortSignal;
}

export interface ActTowardGoalResult {
  status: ActTowardGoalStatus;
  engine: DecisionEngineType;
  engineSwitched: boolean;
  fallbackReason: FallbackReason;
  reason?: string;
  success?: boolean;
  retry?: boolean;
  requestDispatched?: boolean;
  pausedBeforeAction?: PausedBeforeAction;
  steps: StepRecord[];
  finalPage: JevPageState;
  currentElements?: string[];
  jevUsage?: JevUsage;
  verification?: VerificationResult[];
  lastReceipt?: any;
  interaction: InteractionOutcome;
}
