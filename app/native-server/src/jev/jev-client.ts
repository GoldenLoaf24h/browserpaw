import {
  TypeSafeClient,
  choice,
  noul,
  score,
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
  APIConnectionError,
  APIError,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import { JevState, JevPageState, JevHistoryItem, JevUsage, FallbackReason } from './types';
import { jevModelManager, JevMode } from '../server/jev-model-manager';

// 14 Built-in destructive keywords (Iron Rule §2.3)
export const DESTRUCTIVE_KEYWORDS: readonly string[] = [
  'pay',
  '支付',
  '付款',
  '删除',
  'delete',
  'purchase',
  'buy',
  'submit',
  '提交',
  '发送',
  'post',
  '发布',
  'confirm',
  '确认',
];

// Session-level latch for 401 Unauthorized (§4.2)
let isKeyInvalidLatched = false;
let keyInvalidLatchedAt = 0;
const LATCH_EXPIRY_MS = 5 * 60 * 1000; // 5-minute recovery window

export function isSessionKeyInvalid(): boolean {
  if (
    isKeyInvalidLatched &&
    keyInvalidLatchedAt > 0 &&
    Date.now() - keyInvalidLatchedAt > LATCH_EXPIRY_MS
  ) {
    isKeyInvalidLatched = false;
    keyInvalidLatchedAt = 0;
  }
  return isKeyInvalidLatched;
}

export function latchInvalidKey(): void {
  isKeyInvalidLatched = true;
  keyInvalidLatchedAt = Date.now();
}

export function resetInvalidKeyLatch(): void {
  isKeyInvalidLatched = false;
  keyInvalidLatchedAt = 0;
}

/**
 * Filter out sensitive elements (password, file upload) from AX tree
 */
export function isSensitiveElement(line: string): boolean {
  const lower = line.toLowerCase();
  // Only mask actual credential/file INPUT controls; plain links or hints that
  // merely mention "password" (e.g. "Forgot password?") must stay visible.
  return (
    lower.includes('type="password"') ||
    lower.includes('type="file"') ||
    lower.includes('role="file"') ||
    /^\[\d+\]\s*(password|file)\b/.test(lower) ||
    (lower.includes('password') && /\b(textbox|searchbox|input|combobox)\b/.test(lower))
  );
}

/**
 * Build compact AX tree state conforming to §5.1 budget constraints:
 * <=250 lines, <=120 chars/line, <=24,000 total characters, sensitive stripped, recent 5 history.
 */
export function buildState(
  goal: string,
  tabUrl: string,
  tabTitle: string,
  treeLines: string[],
  history: JevHistoryItem[],
  pendingModal?: string,
): JevState {
  const cleanLines: string[] = [];
  for (const rawLine of treeLines) {
    if (cleanLines.length >= 250) break;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (isSensitiveElement(trimmed)) continue;
    cleanLines.push(trimmed.slice(0, 120));
  }

  const state: JevState = {
    task: goal,
    page: {
      url: (tabUrl || '').slice(0, 200),
      title: (tabTitle || '').slice(0, 120),
    },
    elements: cleanLines,
    history: history.slice(-5),
    ...(pendingModal ? { pending_modal: pendingModal.slice(0, 120) } : {}),
  };

  // Enforce overall state character budget <= 24,000 chars
  while (JSON.stringify(state).length > 24000 && state.elements.length > 0) {
    state.elements.pop();
  }

  return state;
}

/**
 * Extract element numeric indices from AX tree element lines
 */
export function extractElementIndices(elements: string[]): string[] {
  const indices: string[] = [];
  for (const line of elements) {
    const match = line.match(/^\[(\d+)\]/);
    if (match && match[1] && !indices.includes(match[1])) {
      indices.push(match[1]);
    }
  }
  return indices;
}

/**
 * Build the 7 parallel System One questions conforming to §5.2
 */
export function buildQuestions(elements: string[], goal: string): Record<string, any> {
  const indices = extractElementIndices(elements);

  const elementSummaryMap = new Map<string, string>();
  for (const line of elements) {
    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (match) {
      const idx = match[1];
      const summary = match[2].slice(0, 60).trim();
      elementSummaryMap.set(idx, summary);
    }
  }

  const targetCriteria: Record<string, string | null> = {};
  for (const idx of indices) {
    targetCriteria[idx] = elementSummaryMap.get(idx) || null;
  }
  targetCriteria['none'] = 'No suitable matching element found on current viewport';

  return {
    action: choice('What is the next single browser action to advance toward the task goal?', {
      click: 'Click a button, link, checkbox, radio, tab, or interactive element',
      type: 'Enter or fill text into an input field or textarea',
      select: 'Select an option from a dropdown or select menu',
      scroll_down: 'Scroll down the page to reveal more content below',
      scroll_up: 'Scroll up the page to reveal content above',
      back: 'Navigate back to the previous page',
      wait: 'Wait for page content to load or changes to settle',
      done: 'The goal has been fully accomplished on the current page',
      escalate:
        'Cannot proceed, ambiguous options, destructive action needed, or requires user intervention',
    }),
    click_target: choice(
      'Which element index [N] should be clicked to advance toward the task goal?',
      targetCriteria,
    ),
    type_target: choice(
      'Which input or textarea element index [N] should receive text entry?',
      targetCriteria,
    ),
    select_target: choice(
      'Which dropdown or select element index [N] should be selected?',
      targetCriteria,
    ),
    goal_done: noul(
      'Has the overall task goal been completely and successfully achieved based on the current page state and history?',
    ),
    stuck: noul('Is the execution stuck in a loop with no progress or change across recent steps?'),
    destructive: noul(
      'Is the proposed action destructive or irreversible (e.g. payment, purchase, deletion, sending, posting, or placing an order)?',
    ),
  };
}

/**
 * Choice validation conforming to §5.5 (validate_choice)
 * Checks: choice in options, probabilities keys equal options, sum = 1 +/- 0.02, all in [0,1], winning choice has max prob.
 */
export function validateChoice(answer: any, expectedKeys: string[]): boolean {
  if (!answer || answer.type !== 'choice') return false;
  if (!expectedKeys.includes(answer.choice)) return false;
  if (!answer.probabilities || typeof answer.probabilities !== 'object') return false;

  const probKeys = Object.keys(answer.probabilities);
  if (probKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (!(key in answer.probabilities)) return false;
  }

  let sum = 0;
  const winningProb = answer.probabilities[answer.choice];
  if (typeof winningProb !== 'number' || winningProb < 0 || winningProb > 1) return false;

  for (const key of probKeys) {
    const val = answer.probabilities[key];
    if (typeof val !== 'number' || isNaN(val) || val < 0 || val > 1) {
      return false;
    }
    if (val > winningProb + 0.0001) {
      return false; // winning choice must have maximum probability
    }
    sum += val;
  }

  if (Math.abs(sum - 1.0) > 0.02) {
    return false;
  }

  return true;
}

/**
 * Text payload extraction conforming to §5.4
 * Deterministic extraction without mini-LLM:
 * 1) Quotes in goal (English "" / '' or Chinese “”)
 * 2) textHint parameter
 * 3) Trailing phrase after 输入/搜索/type/enter/for
 * 4) Fails -> returns null
 */
export function extractTextPayload(goal: string, textHint?: string): string | null {
  if (!goal) return textHint?.trim() || null;

  // 1. Quoted segments
  const quoteMatch = goal.match(/["“'「‘]([^"”'」’]+)["”'」’]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    return quoteMatch[1].trim();
  }

  // 2. textHint parameter
  if (textHint && textHint.trim()) {
    return textHint.trim();
  }

  // 3. Trailing phrase after keyword; stop at common terminators/prepositions
  // instead of the first space so multi-word payloads survive.
  const trailingMatch = goal.match(
    /(?:输入|搜索|键入|填写|填入|type|enter|search for)\s*[:：]?\s*([^,，。;；\n]+?)(?=\s+(?:into|in|on|to)\b|\s*(?:到|进|入|至|并|后|里|中|框|栏)|["“'「‘]|$)/i,
  );
  if (trailingMatch && trailingMatch[1].trim()) {
    return trailingMatch[1].trim();
  }

  return null;
}

const LATIN_DESTRUCTIVE_KEYWORDS = DESTRUCTIVE_KEYWORDS.filter((kw) =>
  /^[a-zA-Z0-9_-]+$/.test(kw.trim()),
);
const NON_LATIN_DESTRUCTIVE_KEYWORDS = DESTRUCTIVE_KEYWORDS.filter(
  (kw) => !/^[a-zA-Z0-9_-]+$/.test(kw.trim()),
);
const LATIN_DESTRUCTIVE_REGEX = new RegExp(
  `(^|[^a-zA-Z0-9])(${LATIN_DESTRUCTIVE_KEYWORDS.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[^a-zA-Z0-9]|$)`,
  'i',
);

/**
 * Check if element text or label hits destructive keywords
 */
/**
 * Extract the human-visible label/text from a compact element line so keyword
 * matching only sees what the user actually reads — never the technical id /
 * class / href attributes. Prevents false positives like the Reddit
 * "Add tags" button whose id is "#reddit-post-flair-button" (kebab-case "post"
 * was matching the destructive keyword and blocking a benign tag action).
 *
 * Compact format: "[index] [flags] role \"text\" #id ..." → returns "text".
 * HTML format:    "<tag ...>\"text\"</tag>" or "<tag ...>text</tag>".
 * Fallback:       strip "#id" and selector attributes, keep the remainder.
 */
function extractTargetVisibleText(raw: string): string {
  if (!raw) return '';
  if (/^\[\d+\]/.test(raw)) {
    const quotedMatch = raw.match(/^\[\d+\](?:\s*\[[\w-]+\])*\s*[a-zA-Z-]+\s*"([^"]+)"/);
    if (quotedMatch) return quotedMatch[1];
    const htmlMatch = raw.match(/>\s*"?([^"<]+)"?\s*</);
    if (htmlMatch) return htmlMatch[1];
    return raw.replace(/#[\w-]+/g, '').replace(/\b(?:href|name|placeholder)="[^"]*"/g, '');
  }
  return raw;
}

export function isDestructiveTarget(text: string): boolean {
  if (!text) return false;
  const targetText = extractTargetVisibleText(text);
  if (LATIN_DESTRUCTIVE_REGEX.test(targetText)) return true;
  const lower = targetText.toLowerCase();
  for (const kw of NON_LATIN_DESTRUCTIVE_KEYWORDS) {
    if (lower.includes(kw.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Top-3 probability distribution extraction conforming to §5.6
 */
export function getTop3Probabilities(
  probabilities: Record<string, number>,
): Record<string, number> {
  if (!probabilities) return {};
  const entries = Object.entries(probabilities);
  entries.sort((a, b) => b[1] - a[1]);
  const top3 = entries.slice(0, 3);
  const result: Record<string, number> = {};
  for (const [k, v] of top3) {
    result[k] = Math.round(v * 1000) / 1000;
  }
  return result;
}

export class JevClientWrapper {
  private client: TypeSafeClient | null = null;
  private localClient: TypeSafeClient | null = null;
  private explicitApiKey?: string;
  private currentKey?: string;

  constructor(apiKey?: string) {
    this.explicitApiKey = apiKey;
    const remoteCfg = jevModelManager.getRemoteConfig();
    const baseUrl = remoteCfg.baseUrl?.trim() || undefined;
    const modelId = remoteCfg.modelId?.trim() || undefined;
    const key = (
      apiKey ||
      remoteCfg.apiKey ||
      process.env.TYPESAFE_API_KEY ||
      process.env.JEV_API_KEY ||
      ''
    ).trim();
    if (key) {
      try {
        this.currentKey = `${key}@${baseUrl || 'default'}@${modelId || 'default'}`;
        this.client = new TypeSafeClient({
          apiKey: key,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(modelId ? { defaultModel: modelId } : {}),
        });
      } catch (e) {
        this.client = null;
      }
    }
  }

  public getLocalClient(): TypeSafeClient {
    if (!this.localClient) {
      this.localClient = new TypeSafeClient({
        apiKey: 'local',
        baseURL: 'http://127.0.0.1:8009',
        timeout: 45000,
      });
    }
    return this.localClient;
  }

  public getRemoteClient(): TypeSafeClient | null {
    return this.getClient();
  }

  public getClient(mode?: JevMode): TypeSafeClient | null {
    const targetMode = mode || jevModelManager.getActiveMode();
    if (targetMode === 'off') {
      return null;
    }
    if (targetMode === 'local') {
      return this.getLocalClient();
    }

    const remoteCfg = jevModelManager.getRemoteConfig();
    const key = (
      this.explicitApiKey ||
      remoteCfg.apiKey ||
      process.env.TYPESAFE_API_KEY ||
      process.env.JEV_API_KEY ||
      ''
    ).trim();
    const baseUrl = remoteCfg.baseUrl?.trim() || undefined;
    const modelId = remoteCfg.modelId?.trim() || undefined;
    const clientKey = `${key}@${baseUrl || 'default'}@${modelId || 'default'}`;

    if (key) {
      if (!this.client || this.currentKey !== clientKey) {
        try {
          this.currentKey = clientKey;
          this.client = new TypeSafeClient({
            apiKey: key,
            ...(baseUrl ? { baseURL: baseUrl } : {}),
            ...(modelId ? { defaultModel: modelId } : {}),
          });
        } catch {
          this.client = null;
        }
      }
    } else {
      this.client = null;
      this.currentKey = undefined;
    }
    return this.client;
  }

  public isAvailable(mode?: JevMode): boolean {
    const targetMode = mode || jevModelManager.getActiveMode();
    if (targetMode === 'off') return false;
    if (targetMode === 'local') return jevModelManager.isModelDownloaded();
    return Boolean(this.getRemoteClient() && !isSessionKeyInvalid());
  }

  /**
   * Execute System One multi-question query with typed error handling and mode dispatch
   */
  public async query(
    state: JevState,
    questions: Record<string, any>,
    mode?: JevMode,
  ): Promise<{
    result: SystemOneResult<any> | null;
    errorReason: FallbackReason;
    rawError?: any;
  }> {
    const targetMode = mode || jevModelManager.getActiveMode();
    if (targetMode === 'off') {
      return {
        result: null,
        errorReason: 'jev_disabled',
      };
    }

    let client: TypeSafeClient | null = null;
    if (targetMode === 'local') {
      await jevModelManager.ensureLocalServiceRunning();
      jevModelManager.touchActivity();
      client = this.getLocalClient();
    } else {
      client = this.getRemoteClient();
      if (!client || isSessionKeyInvalid()) {
        return {
          result: null,
          errorReason: isSessionKeyInvalid() ? 'invalid_key' : 'no_api_key',
        };
      }
    }

    try {
      const remoteCfg = targetMode === 'remote' ? jevModelManager.getRemoteConfig() : undefined;
      const model = remoteCfg?.modelId?.trim() || undefined;
      const response = await client.systemOne({
        state: state as any,
        questions,
        ...(model ? { model } : {}),
      });
      return { result: response, errorReason: null };
    } catch (err: any) {
      if (targetMode === 'local') {
        if (
          err instanceof APITimeoutError ||
          err instanceof APIConnectionError ||
          err?.code === 'ECONNREFUSED' ||
          err?.code === 'ETIMEDOUT' ||
          err?.status === 502 ||
          err?.status === 503 ||
          err?.status === 504
        ) {
          return { result: null, errorReason: 'local_service_offline', rawError: err };
        }
      }

      if (err instanceof AuthenticationError || err?.status === 401) {
        latchInvalidKey();
        return { result: null, errorReason: 'invalid_key', rawError: err };
      }
      if (err instanceof RateLimitError || err?.status === 429) {
        return { result: null, errorReason: 'quota_exhausted', rawError: err };
      }
      if (
        err instanceof APITimeoutError ||
        err instanceof APIConnectionError ||
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ETIMEDOUT'
      ) {
        return { result: null, errorReason: 'network_error', rawError: err };
      }
      if (err instanceof APIError) {
        if (err.status === 401 || err.status === 403) {
          latchInvalidKey();
          return { result: null, errorReason: 'invalid_key', rawError: err };
        }
        if (err.status === 429) {
          return { result: null, errorReason: 'rate_limited', rawError: err };
        }
      }
      return { result: null, errorReason: 'network_error', rawError: err };
    }
  }

  /**
   * Score candidate dropdown options conforming to §2.3, §5.2, §5.3
   */
  public async scoreOptions(
    goal: string,
    options: Array<{ text: string; value: string }>,
    mode?: JevMode,
  ): Promise<{
    bestIndex: number;
    bestOption: { text: string; value: string };
    confidence: number;
    score: number;
    usage?: { inputTokens: number };
  } | null> {
    const targetMode = mode || jevModelManager.getActiveMode();
    if (!this.getClient(targetMode) || options.length === 0) return null;
    if (options.length === 1) {
      return {
        bestIndex: 0,
        bestOption: options[0],
        confidence: 1.0,
        score: 0,
        usage: { inputTokens: 0 },
      };
    }

    // When options exceed 20 (Choice primitive optimal budget), shortlist candidates based on relevance to goal
    let candidateOptions = options;
    if (options.length > 20) {
      const goalLower = goal.toLowerCase();
      const scored = options.map((opt, idx) => {
        const text = `${opt.text} ${opt.value}`.toLowerCase();
        let scoreVal = 0;
        if (goalLower.includes(text) || text.includes(goalLower)) scoreVal += 5;
        for (const word of goalLower.split(/\s+/)) {
          if (word.length >= 2 && text.includes(word)) scoreVal += 2;
        }
        return { opt, idx, scoreVal };
      });
      scored.sort((a, b) => b.scoreVal - a.scoreVal);
      candidateOptions = scored.slice(0, 20).map((s) => s.opt);
    }

    const choiceCriteria: Record<string, string> = {};
    candidateOptions.forEach((opt, idx) => {
      choiceCriteria[String(idx)] = `${opt.text || opt.value || ''}`.trim() || `Option ${idx}`;
    });

    const selectQuestion = choice(
      `Select the option index that best satisfies the selection goal: "${goal}"`,
      choiceCriteria,
    );

    const response = await this.query(
      {
        task: goal,
        page: { url: '', title: '' },
        elements: candidateOptions.map((o, i) => `[${i}] ${o.text} (${o.value})`),
        history: [],
      },
      { select_option: selectQuestion },
      targetMode,
    );

    if (!response.result?.answers?.select_option) {
      return null;
    }

    const answer = (response.result.answers as Record<string, any>).select_option;
    let bestCandidateIndex = 0;
    let confidence = 0;
    let scoreVal = 0;
    const probs = answer.probabilities || {};

    if (answer.type === 'choice') {
      const chosenKey = String(answer.choice ?? '');
      const parsedIdx = parseInt(chosenKey, 10);
      if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < candidateOptions.length) {
        bestCandidateIndex = parsedIdx;
      } else {
        const found = candidateOptions.findIndex(
          (opt) => opt.text === chosenKey || opt.value === chosenKey,
        );
        if (found >= 0) bestCandidateIndex = found;
      }
      confidence =
        typeof answer.confidence === 'number' ? answer.confidence : (probs[chosenKey] ?? 1.0);
      scoreVal = bestCandidateIndex;
    } else {
      // type === 'score' or legacy rubric response
      let maxProb = -1;
      for (let i = 0; i < candidateOptions.length; i++) {
        const p = probs[String(i)] ?? probs[i] ?? 0;
        if (p > maxProb) {
          maxProb = p;
          bestCandidateIndex = i;
        }
      }
      confidence = typeof answer.confidence === 'number' ? answer.confidence : maxProb;
      scoreVal = typeof answer.score === 'number' ? answer.score : bestCandidateIndex;
    }

    const bestOption = candidateOptions[bestCandidateIndex];
    const originalIndex = options.indexOf(bestOption);

    return {
      bestIndex: originalIndex >= 0 ? originalIndex : bestCandidateIndex,
      bestOption,
      confidence,
      score: scoreVal,
      usage: {
        inputTokens: response.result.usage?.input_tokens || 0,
      },
    };
  }
}
