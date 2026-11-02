import {
  TypeSafeClient,
  choice,
  noul,
  score,
  box,
  image,
  type BoxCoordinates,
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
  APIConnectionError,
  APIError,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import {
  JevState,
  JevPageState,
  JevHistoryItem,
  JevUsage,
  FallbackReason,
  VisionFrameInfo,
} from './types';
import { jevModelManager, JevMode } from '../server/jev-model-manager';

export const DANGER_ZONE_IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images';

// Box questions require Jev 1.14 or newer. This is read from the model upstream reports
// answering the request rather than from a pinned id: an alias such as `jev-latest` may be
// promoted to a newer release at any time, and the gate follows that automatically.
const BOX_MIN_MAJOR = 1;
const BOX_MIN_MINOR = 14;
const JEV_VERSION_PATTERN = /(?:^|\/)jev-(\d+)\.(\d+)(?:\.\d+)?/i;

/** Whether the model id upstream reported can answer `box` questions. */
export function supportsBoxQuestions(modelId: string | undefined): boolean {
  const match = JEV_VERSION_PATTERN.exec((modelId || '').trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > BOX_MIN_MAJOR || (major === BOX_MIN_MAJOR && minor >= BOX_MIN_MINOR);
}

export interface JevVisionResult {
  exists: boolean;
  ambiguous: boolean;
  destructive: boolean;
  box: BoxCoordinates | null;
  confidence: number | null;
  rawAnswers?: Record<string, any>;
  usage?: { input_tokens: number | null; output_tokens: number | null };
}

// 16 Built-in destructive keywords (Iron Rule §2.3)
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
  'send',
  'post',
  '发布',
  'publish',
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

// An explicit enable/configuration change must not inherit the previous credential failure.
jevModelManager.onModeStateChanged((state) => {
  if (state.activeMode !== 'off') resetInvalidKeyLatch();
});

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
  pageText?: string,
): JevState {
  const cleanLines: string[] = [];
  for (const rawLine of treeLines) {
    if (cleanLines.length >= 250) break;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (isSensitiveElement(trimmed)) continue;
    // Field values are execution data, not evidence for selecting a control.
    cleanLines.push(trimmed.replace(/\s(?:current_)?value=[\s\S]*/, '').slice(0, 120));
  }

  // The result of a control action is usually rendered as page text, not as another control.
  // Without it the model cannot tell that the goal was reached. Kept short because the
  // elements and history share the same 24,000 character budget.
  const cleanText = (pageText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);

  const state: JevState = {
    task: goal,
    page: {
      url: (tabUrl || '').slice(0, 200),
      title: (tabTitle || '').slice(0, 120),
    },
    elements: cleanLines,
    history: history.slice(-5),
    ...(cleanText ? { page_text: cleanText } : {}),
    ...(pendingModal ? { pending_modal: pendingModal.slice(0, 120) } : {}),
  };

  // Enforce overall state character budget <= 24,000 chars. Page text is dropped before
  // elements, since element indices are what every action question refers to.
  while (JSON.stringify(state).length > 24000 && state.page_text) {
    state.page_text = state.page_text.slice(0, Math.max(0, state.page_text.length - 500));
    if (!state.page_text) delete state.page_text;
  }
  while (JSON.stringify(state).length > 24000 && state.elements.length > 0) {
    state.elements.pop();
  }

  return state;
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
 * 3) Trailing phrase after input/search/type/enter keywords
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

/**
 * Visual fallback is limited to a single explicit click goal; textHint is input data.
 */
export function extractVisualTargetDescription(goal: string): string {
  if (
    !goal ||
    /[;\n&]|\b(?:then|after|and|type|fill|select|enter|drag|upload|hold)\b|然后|接着|并|随后|再|输入|填写|选择|拖拽|上传/i.test(
      goal,
    )
  ) {
    return '';
  }
  // Only explicit click/tap phrasing qualifies: `press`/`key` goals ask for a
  // keyboard action, and turning "Press Escape" into the visual target
  // "Escape" would make the fallback click whatever carries that label.
  const target = goal
    .trim()
    .replace(/^(?:please\s+)?(?:click\s+(?:on\s+)?|tap\s+(?:on\s+)?|(?:请)?点击)\s*/i, '');
  if (target === goal.trim() || !target) return '';

  // 1. Quoted segments
  const quoteMatch = target.match(/["“'「‘]([^"”'」’]+)["”'」’]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    return quoteMatch[1].trim().slice(0, 120);
  }

  return target.slice(0, 120);
}

/**
 * Parse chrome_screenshot MCP response into Buffer and VisionFrameInfo.
 * Response must contain:
 * - type === 'image': base64 string
 * - type === 'text': JSON with visionFrame: { id, width, height }
 */
export function parseScreenshotContent(
  res: any,
): { imageBuffer: Buffer; frame: VisionFrameInfo } | null {
  if (!res || res.isError) return null;
  const contentArray: any[] = Array.isArray(res.content) ? res.content : [];
  if (contentArray.length === 0) return null;

  let imageBuffer: Buffer | null = null;
  let frame: VisionFrameInfo | null = null;

  for (const item of contentArray) {
    if (!item) continue;
    if (
      item.type === 'image' &&
      (item.mimeType === 'image/png' || item.mimeType === 'image/jpeg') &&
      typeof item.data === 'string' &&
      item.data.length > 0
    ) {
      try {
        imageBuffer = Buffer.from(item.data, 'base64');
      } catch {
        imageBuffer = null;
      }
    } else if (item.type === 'text' && typeof item.text === 'string') {
      try {
        const parsed = JSON.parse(item.text);
        const vf = parsed.visionFrame || parsed;
        if (
          vf &&
          typeof vf.id === 'string' &&
          vf.id.trim().length > 0 &&
          Number.isInteger(vf.width) &&
          vf.width >= 280 &&
          vf.width <= 1568 &&
          Number.isInteger(vf.height) &&
          vf.height >= 280 &&
          vf.height <= 1568
        ) {
          frame = {
            id: vf.id.trim(),
            width: vf.width,
            height: vf.height,
          };
        }
      } catch {
        // Ignore non-json text
      }
    }
  }

  if (imageBuffer?.length && frame) {
    return { imageBuffer, frame };
  }
  return null;
}

/**
 * Validate BoxCoordinates bounds and sanity.
 * Values must be numbers in [0, 1] with left < right and top < bottom.
 */
export function validateBoxCoordinates(boxCoords: any): boxCoords is BoxCoordinates {
  if (!boxCoords || typeof boxCoords !== 'object') return false;
  const { top, bottom, left, right } = boxCoords;
  if (
    typeof top !== 'number' ||
    typeof bottom !== 'number' ||
    typeof left !== 'number' ||
    typeof right !== 'number' ||
    isNaN(top) ||
    isNaN(bottom) ||
    isNaN(left) ||
    isNaN(right)
  ) {
    return false;
  }
  if (left < 0 || right > 1 || left >= right) {
    return false;
  }
  if (top < 0 || bottom > 1 || top >= bottom) {
    return false;
  }
  return true;
}

export class JevClientWrapper {
  private client: TypeSafeClient | null = null;
  private localClient: TypeSafeClient | null = null;
  private explicitApiKey?: string;
  private currentKey?: string;
  /**
   * The concrete model id upstream reported answering this endpoint, cached for the life of
   * the current credentials/endpoint/model combination. `undefined` means "not resolved yet".
   */
  private resolvedModelId?: string;

  constructor(apiKey?: string) {
    this.explicitApiKey = apiKey;
    const { key, baseUrl, modelId, identity } = this.resolveRemoteConfig();
    if (key) {
      try {
        this.currentKey = identity;
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

  /** The credential/endpoint/model the remote configuration selects, plus a collision-free identity for it. */
  private resolveRemoteConfig(): {
    key: string;
    baseUrl?: string;
    modelId?: string;
    identity: string;
  } {
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
    return {
      key,
      baseUrl,
      modelId,
      identity: JSON.stringify([key, baseUrl ?? null, modelId ?? null]),
    };
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

    const { key, baseUrl, modelId, identity } = this.resolveRemoteConfig();

    if (key) {
      if (!this.client || this.currentKey !== identity) {
        try {
          this.currentKey = identity;
          this.resolvedModelId = undefined;
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
      this.resolvedModelId = undefined;
    }
    return this.client;
  }

  /**
   * Resolve the concrete model upstream serves for this endpoint and report whether it can
   * answer `box` questions, which is what the visual fallback depends on.
   *
   * The configured id may be an alias (`jev-latest` currently resolves to Jev 1.13) or a
   * custom gateway model we cannot place; upstream's `response.model` is the only authority,
   * so this asks it once per credentials/endpoint/model combination and caches the answer.
   *
   * A process that reaches the visual fallback before any text query has run needs one
   * text-only request to learn the release. That probe carries no image and no danger-zone
   * header, so the decision to send a screenshot is still made before any capture leaves
   * the machine.
   */
  public async resolveBoxCapableModel(
    signal?: AbortSignal,
    timeout?: number,
    onProbeUsage?: (usage: { inputTokens: number; latencyMs: number }) => void,
  ): Promise<string | null> {
    // Never probe the local service client that `getRemoteClient()` returns in local mode.
    if (jevModelManager.getActiveMode() !== 'remote') return null;
    // Attribute the awaited answer by configuration identity, not by the `client` field:
    // `getClient()` may not have refreshed yet, and a concurrent request may already have
    // cached the new configuration's release.
    const identity = this.resolveRemoteConfig().identity;
    const client = this.getRemoteClient();
    if (!client || isSessionKeyInvalid()) return null;

    if (this.resolvedModelId === undefined) {
      const configured = jevModelManager.getRemoteConfig().modelId?.trim() || undefined;
      const probeStart = Date.now();
      try {
        const probe = await client.systemOne(
          {
            state: 'ready' as any,
            questions: { ready: noul('Is the state a non-empty value?') },
            ...(configured ? { model: configured } : {}),
          },
          { signal, timeout },
        );
        // The probe is a real billed request; report it so run telemetry counts the
        // cold-probe cases instead of undercounting them.
        onProbeUsage?.({
          inputTokens: probe?.usage?.input_tokens || 0,
          latencyMs: Date.now() - probeStart,
        });
        // A probe that straddled a switch reports on the old endpoint: drop it. Mode is
        // checked first so a revocation short-circuits before `getRemoteClient()` can rebuild.
        if (
          jevModelManager.getActiveMode() === 'remote' &&
          probe?.model &&
          this.resolveRemoteConfig().identity === identity &&
          this.getRemoteClient() === client
        ) {
          this.resolvedModelId = probe.model;
        }
      } catch {
        return null;
      }
    }
    // Exit guard: never return a cache that now belongs to another configuration or client.
    if (
      jevModelManager.getActiveMode() !== 'remote' ||
      this.resolveRemoteConfig().identity !== identity ||
      this.getRemoteClient() !== client
    ) {
      return null;
    }
    return this.resolvedModelId && supportsBoxQuestions(this.resolvedModelId)
      ? this.resolvedModelId
      : null;
  }

  /** The concrete model upstream last reported answering this endpoint, if known. */
  public getResolvedModelId(): string | undefined {
    return this.resolvedModelId;
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
    options?: { signal?: AbortSignal; timeout?: number; retry?: { maxRetries: number } },
  ): Promise<{
    result: SystemOneResult<any> | null;
    errorReason: FallbackReason;
    rawError?: any;
  }> {
    const enabledMode = jevModelManager.getActiveMode();
    const targetMode =
      enabledMode === 'off' || (mode && mode !== enabledMode) ? 'off' : enabledMode;
    const modeToken = jevModelManager.captureModeToken();
    const failure = (errorReason: FallbackReason, rawError?: unknown) => {
      const cancelled = options?.signal?.aborted && options.signal.reason?.name !== 'TimeoutError';
      if (!cancelled)
        jevModelManager.disableIfCurrent(modeToken, errorReason || 'invalid_model_response');
      return { result: null, errorReason, ...(rawError ? { rawError } : {}) };
    };
    if (targetMode === 'off') {
      return {
        result: null,
        errorReason: 'jev_disabled',
      };
    }
    if (options?.signal?.aborted) return { result: null, errorReason: 'jev_disabled' };

    let client: TypeSafeClient | null = null;
    // Capture the configuration before selecting the client; a switch in between must not be
    // attributed to the new configuration.
    const identity = targetMode === 'remote' ? this.resolveRemoteConfig().identity : undefined;
    if (targetMode === 'local') {
      let abortStartup: (() => void) | undefined;
      try {
        const startup = jevModelManager.ensureLocalServiceRunning();
        const service = options?.signal
          ? await Promise.race([
              startup,
              new Promise<never>((_resolve, reject) => {
                abortStartup = () => reject(options.signal!.reason);
                options.signal!.addEventListener('abort', abortStartup, { once: true });
                if (options.signal!.aborted) abortStartup();
              }),
            ])
          : await startup;
        if (!service.success) return failure('local_service_offline');
      } catch (error) {
        return failure('local_service_offline', error);
      } finally {
        if (abortStartup) options?.signal?.removeEventListener('abort', abortStartup);
      }
      jevModelManager.touchActivity();
      client = this.getLocalClient();
    } else {
      client = this.getRemoteClient();
      if (!client || isSessionKeyInvalid()) {
        return failure(isSessionKeyInvalid() ? 'invalid_key' : 'no_api_key');
      }
    }

    try {
      const remoteCfg = targetMode === 'remote' ? jevModelManager.getRemoteConfig() : undefined;
      const model = remoteCfg?.modelId?.trim() || undefined;
      const response = await client.systemOne(
        {
          state: state as any,
          questions,
          ...(model ? { model } : {}),
        },
        options,
      );
      if (options?.signal?.aborted) return failure('network_error');
      // Cache the reported release only if it still describes the configuration that sent
      // this request; `client === this.client` also rejects the local service client.
      if (
        targetMode === 'remote' &&
        response?.model &&
        client === this.client &&
        this.resolveRemoteConfig().identity === identity
      ) {
        this.resolvedModelId = response.model;
      }
      if (!response?.answers || typeof response.answers !== 'object')
        return failure('network_error');
      for (const [id, question] of Object.entries(questions)) {
        const answer = (response.answers as any)[id];
        const valid =
          question.type === 'choice'
            ? validateChoice(answer, Object.keys(question.criteria)) &&
              Number.isFinite(answer.confidence) &&
              answer.confidence >= 0 &&
              answer.confidence <= 1
            : question.type === 'noul'
              ? answer?.type === 'noul' &&
                Number.isFinite(answer.noul) &&
                answer.noul >= 0 &&
                answer.noul <= 1
              : answer?.type === question.type;
        if (!valid) return failure('invalid_response');
      }
      if (jevModelManager.captureModeToken().revision !== modeToken.revision)
        return { result: null, errorReason: 'jev_disabled' };
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
          return failure('local_service_offline', err);
        }
      }

      if (err instanceof AuthenticationError || err?.status === 401) {
        if (
          jevModelManager.captureModeToken().revision === modeToken.revision &&
          (targetMode !== 'remote' || this.resolveRemoteConfig().identity === identity)
        )
          latchInvalidKey();
        return failure('invalid_key', err);
      }
      if (err instanceof RateLimitError || err?.status === 429) {
        return failure('quota_exhausted', err);
      }
      if (
        err instanceof APITimeoutError ||
        err instanceof APIConnectionError ||
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ETIMEDOUT'
      ) {
        return failure('network_error', err);
      }
      if (err instanceof APIError) {
        if (err.status === 401 || err.status === 403) {
          if (
            jevModelManager.captureModeToken().revision === modeToken.revision &&
            (targetMode !== 'remote' || this.resolveRemoteConfig().identity === identity)
          )
            latchInvalidKey();
          return failure('invalid_key', err);
        }
        if (err.status === 429) {
          return failure('rate_limited', err);
        }
      }
      return failure('network_error', err);
    }
  }

  /**
   * Execute visual System One query with image asset and 4-question defensive fan-out.
   * Hard gated: Remote mode only, and the model upstream serves for this endpoint must be
   * able to answer `box`. Local/off strictly prohibited.
   */
  public async queryVision(
    imageBuffer: Buffer,
    targetDescription: string,
    mode?: JevMode,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{
    result: JevVisionResult | null;
    errorReason: FallbackReason;
    rawError?: any;
  }> {
    const targetMode = mode || jevModelManager.getActiveMode();
    // HARD GATE: Vision is strictly remote-only. Local or off must never capture or send images.
    if (targetMode !== 'remote' || jevModelManager.getActiveMode() !== 'remote') {
      return {
        result: null,
        errorReason: 'jev_disabled',
      };
    }

    const modeToken = jevModelManager.captureModeToken();
    const failure = (errorReason: FallbackReason, rawError?: unknown) => {
      if (!options?.signal?.aborted || options.signal.reason?.name === 'TimeoutError')
        jevModelManager.disableIfCurrent(modeToken, errorReason || 'invalid_response');
      return { result: null, errorReason, ...(rawError ? { rawError } : {}) };
    };
    if (options?.signal?.aborted) return { result: null, errorReason: 'jev_disabled' };
    const client = this.getRemoteClient();
    if (!client || isSessionKeyInvalid()) {
      return failure(isSessionKeyInvalid() ? 'invalid_key' : 'no_api_key');
    }
    const identity = this.resolveRemoteConfig().identity;

    // Ask upstream which release answers here; `box` needs Jev 1.14+, so anything else must
    // fail closed rather than send a screenshot the request cannot use.
    const visionModel = await this.resolveBoxCapableModel(options?.signal, options?.timeout);
    if (!visionModel) {
      return {
        result: null,
        errorReason: 'vision_model_unsupported',
      };
    }

    // The probe awaited: re-select the client and fail closed if the configuration, mode, or
    // client changed, so the screenshot only goes to the endpoint whose release was verified.
    const currentClient = this.getRemoteClient();
    if (
      jevModelManager.getActiveMode() !== 'remote' ||
      !currentClient ||
      this.resolveRemoteConfig().identity !== identity ||
      currentClient !== client
    ) {
      return {
        result: null,
        errorReason: 'vision_model_unsupported',
      };
    }

    try {
      const imgAsset = image(imageBuffer);
      const state = {
        task: targetDescription,
        screenshot: imgAsset,
      };
      const questions = {
        target_exists: noul(
          `Does the visual element described by "${targetDescription}" exist and is it clearly distinguishable in \`screenshot\`?`,
        ),
        target_ambiguous: noul(
          `Are there multiple candidate elements matching "${targetDescription}" creating visual ambiguity in \`screenshot\`?`,
        ),
        target_box: box(`Locate the bounding box of "${targetDescription}" in \`screenshot\``),
        destructive: noul(
          `Is interacting with "${targetDescription}" in \`screenshot\` destructive, irreversible, or requiring financial payment/deletion/order submission?`,
        ),
      };

      const response = await currentClient.systemOne(
        {
          state: state as any,
          questions,
          model: visionModel,
        },
        {
          signal: options?.signal,
          timeout: options?.timeout,
          retry: { maxRetries: 0 },
          headers: {
            [DANGER_ZONE_IMAGES_HEADER]: 'true',
          },
        },
      );
      if (options?.signal?.aborted) return failure('network_error');
      if (
        jevModelManager.captureModeToken().revision !== modeToken.revision ||
        jevModelManager.getActiveMode() !== 'remote' ||
        this.resolveRemoteConfig().identity !== identity
      )
        return { result: null, errorReason: 'jev_disabled' };
      // Same attribution rule as `query`, plus the mode guard: a revoked vision consent must
      // not refresh the cache.
      if (
        jevModelManager.getActiveMode() === 'remote' &&
        response?.model &&
        this.resolveRemoteConfig().identity === identity &&
        currentClient === this.client
      ) {
        this.resolvedModelId = response.model;
      }

      const answers = (response.answers || {}) as Record<string, any>;
      const probability = (answer: any, fallback: number): number =>
        answer?.type === 'noul' &&
        Number.isFinite(answer.noul) &&
        answer.noul >= 0 &&
        answer.noul <= 1
          ? answer.noul
          : fallback;
      const existsNoul = probability(answers.target_exists, 0);
      const ambiguousNoul = probability(answers.target_ambiguous, 1);
      const destructiveNoul = probability(answers.destructive, 1);

      // Conservative experimental defaults (not proven zero-risk; requires cautious evaluation)
      const exists = existsNoul >= 0.85;
      const ambiguous = ambiguousNoul >= 0.5;
      const destructive = destructiveNoul >= 0.5;

      const rawBox = answers.target_box?.box;
      const validBox =
        answers.target_box?.type === 'box' && validateBoxCoordinates(rawBox) ? rawBox : null;
      const confidence =
        Number.isFinite(answers.target_box?.confidence) &&
        answers.target_box.confidence >= 0 &&
        answers.target_box.confidence <= 1
          ? answers.target_box.confidence
          : null;

      return {
        result: {
          exists,
          ambiguous,
          destructive,
          box: validBox,
          confidence,
          rawAnswers: answers,
          usage: response.usage
            ? {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
              }
            : undefined,
        },
        errorReason: null,
      };
    } catch (err: any) {
      if (options?.signal?.aborted) return failure('network_error', err);
      const latchCurrent = () => {
        if (
          jevModelManager.captureModeToken().revision === modeToken.revision &&
          this.resolveRemoteConfig().identity === identity
        )
          latchInvalidKey();
      };
      if (err instanceof AuthenticationError || err?.status === 401) {
        latchCurrent();
        return failure('invalid_key', err);
      }
      if (err instanceof RateLimitError || err?.status === 429) {
        return failure('quota_exhausted', err);
      }
      if (
        err instanceof APITimeoutError ||
        err instanceof APIConnectionError ||
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ETIMEDOUT'
      ) {
        return failure('network_error', err);
      }
      if (err instanceof APIError) {
        if (err.status === 401 || err.status === 403) {
          latchCurrent();
          return failure('invalid_key', err);
        }
        if (err.status === 429) {
          return failure('rate_limited', err);
        }
      }
      return failure('network_error', err);
    }
  }

  /** Score candidate dropdown options conforming to §2.3, §5.2, §5.3. */
  public async scoreOptions(
    goal: string,
    options: Array<{ text: string; value: string }>,
    mode?: JevMode,
    requestOptions?: {
      signal?: AbortSignal;
      timeout?: number;
      retry?: { maxRetries: number };
      onUsage?: (usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        model: string;
      }) => void;
    },
  ): Promise<{
    bestIndex: number;
    bestOption: { text: string; value: string };
    confidence: number;
    score: number;
    usage?: {
      inputTokens: number | null;
      outputTokens?: number | null;
    } | null;
  } | null> {
    if (!Array.isArray(options) || options.length === 0 || options.length > 32) {
      return null;
    }

    const enabledMode = jevModelManager.getActiveMode();
    if (enabledMode === 'off' || (mode && mode !== enabledMode)) {
      return null;
    }
    if (requestOptions?.signal?.aborted) {
      return null;
    }
    const timeoutMs = Math.min(
      1500,
      typeof requestOptions?.timeout === 'number' ? requestOptions.timeout : 1500,
    );
    if (timeoutMs <= 0) {
      return null;
    }

    const choiceCriteria: Record<string, string> = {};
    options.forEach((opt, idx) => {
      choiceCriteria[String(idx)] = opt.text.trim() || 'Option ' + idx;
    });
    choiceCriteria['none'] = 'None of the above options matches the goal';

    const selectQuestion = choice(
      'Select the option index that best satisfies the selection goal: ' +
        JSON.stringify(goal) +
        '. Return none if no option is a suitable match.',
      choiceCriteria,
    );

    const effectiveSignal = requestOptions?.signal
      ? AbortSignal.any([requestOptions.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const { onUsage, ...transportOptions } = requestOptions || {};
    const mergedRequestOptions = {
      ...transportOptions,
      signal: effectiveSignal,
      timeout: timeoutMs,
      retry: { maxRetries: 0 },
    };

    const modeToken = jevModelManager.captureModeToken();
    const response = await this.query(
      {
        task: goal,
        page: { url: '', title: '' },
        elements: options.map((o, i) => '[' + i + '] ' + o.text),
        history: [],
      },
      { select_option: selectQuestion },
      enabledMode,
      mergedRequestOptions,
    );

    if (response.result)
      onUsage?.({
        inputTokens: response.result.usage?.input_tokens ?? null,
        outputTokens: response.result.usage?.output_tokens ?? null,
        model: response.result.model,
      });
    if (!response.result?.answers?.select_option) {
      return null;
    }

    const answer = (response.result.answers as Record<string, any>).select_option;
    const expectedKeys = [...options.map((_, i) => String(i)), 'none'];

    if (!validateChoice(answer, expectedKeys)) {
      jevModelManager.disableIfCurrent(modeToken, 'invalid_response');
      return null;
    }

    if (
      typeof answer.confidence !== 'number' ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      jevModelManager.disableIfCurrent(modeToken, 'invalid_response');
      return null;
    }

    if (answer.confidence < 0.85) return null;

    if (answer.choice === 'none') {
      return null;
    }

    const bestIndex = parseInt(answer.choice, 10);
    if (isNaN(bestIndex) || bestIndex < 0 || bestIndex >= options.length) {
      return null;
    }

    const sortedProbs = Object.values(answer.probabilities as Record<string, number>).sort(
      (a, b) => b - a,
    );
    const topProb = sortedProbs[0] ?? 0;
    const runnerUpProb = sortedProbs[1] ?? 0;
    if (topProb - runnerUpProb < 0.2) {
      return null;
    }

    const bestOption = options[bestIndex];

    const inputTokens =
      typeof response.result.usage?.input_tokens === 'number'
        ? response.result.usage.input_tokens
        : null;
    const outputTokens =
      typeof response.result.usage?.output_tokens === 'number'
        ? response.result.usage.output_tokens
        : null;

    return {
      bestIndex,
      bestOption,
      confidence: answer.confidence,
      score: bestIndex,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }
}
