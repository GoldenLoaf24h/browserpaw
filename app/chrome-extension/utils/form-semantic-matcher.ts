/**
 * Semantic Field & Choice Matcher for Form Pipeline & Unified Locator Plan B
 *
 * Implements strict non-heuristic semantic matching contract for locator:
 * 1. Exact / whole-token literal matching with anti-ambiguity (never picks first on duplicates)
 * 2. Native Jev System One matching (status: matched | none | ambiguous | unavailable | cancelled)
 * 3. Strict candidate hard cap (<= 32)
 * 4. Zero upload of user values or sensitive inputs
 */

import { sendJevMatchToNative } from '../entrypoints/background/native-host';

export interface MatchCandidate {
  id: string | number;
  text: string;
  details?: string;
}

export interface MatchResult {
  cacheHit?: boolean;
  matchedId: string | number;
  confidence: number;
  engine: 'jev' | 'heuristic' | 'literal';
  backend?: 'off' | 'local' | 'remote';
  model?: string;
  latencyMs?: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  attempts?: number;
}

export interface JevSemanticCandidate {
  id: string | number;
  text: string;
}

export interface JevSemanticMatchPayload {
  taskId?: string;
  pageIdentity?: string;
  context?: string;
  candidates: JevSemanticCandidate[];
  query: string;
  operation?: string;
  type?: string;
  deadlineAt?: number;
}

export type SemanticMatchStatus = 'matched' | 'none' | 'ambiguous' | 'unavailable' | 'cancelled';

export interface JevSemanticMatchResponse {
  cacheHit?: boolean;
  success: boolean;
  status: SemanticMatchStatus;
  matchedId?: string | number;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  engine?: string;
  error?: string;
  backend?: 'off' | 'local' | 'remote';
  latencyMs?: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  attempts?: number;
}

export const MAX_SEMANTIC_CANDIDATES = 32;

const FIELD_SYNONYMS: Record<string, string[]> = {
  phone: [
    'phone',
    'mobile',
    'tel',
    'telephone',
    'cell',
    '手机',
    '手机号',
    '电话',
    '联系方式',
    '联系电话',
  ],
  email: ['email', 'e-mail', 'mail', '邮箱', '电子邮箱', '邮件'],
  name: [
    'name',
    'username',
    'user',
    'realname',
    'fullname',
    '姓名',
    '用户名',
    '名字',
    '姓名/称呼',
    '昵称',
  ],
  firstname: ['firstname', 'first-name', 'givenname', '名'],
  lastname: ['lastname', 'last-name', 'surname', 'familyname', '姓'],
  gender: ['gender', 'sex', '性别'],
  company: [
    'company',
    'organization',
    'org',
    'enterprise',
    'employer',
    '公司',
    '企业',
    '单位',
    '组织',
    '机构',
  ],
  address: ['address', 'addr', 'location', 'street', '地址', '住址', '所在地', '街道'],
  city: ['city', '城市', '市'],
  country: ['country', 'nation', 'region', '国家', '地区'],
  password: ['password', 'passwd', 'pwd', '密码'],
  age: ['age', '年龄'],
  title: ['title', 'job', 'position', 'role', '职位', '头衔', '职称', '岗位'],
  search: ['search', 'query', 'find', '搜索', '查询', '查找'],
  female: ['female', 'woman', 'girl', 'ms', 'mrs', 'lady', '女', '女士', '女性'],
  male: ['male', 'man', 'boy', 'mr', 'gentleman', '男', '男士', '男性'],
  yes: ['yes', 'true', 'ok', 'agree', 'accept', '是', '确认', '同意', '好的', '正确'],
  no: ['no', 'false', 'cancel', 'reject', 'deny', '否', '取消', '拒绝', '不同意', '错误'],
  submit: ['submit', 'send', 'done', 'finish', 'complete', '提交', '发送', '完成', '确认提交'],
  next: ['next', 'continue', 'proceed', 'forward', '下一步', '继续'],
};

/**
 * Tokenizes text into lowercase alphanumeric words and CJK character bigrams
 */
export function tokenizeText(text: string): string[] {
  if (!text) return [];
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const rawWords = normalized.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];

  for (const word of rawWords) {
    const segments = word.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_-]+/gu,
    );
    if (!segments) continue;
    for (const seg of segments) {
      const cjkChars = seg.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
      if (cjkChars && cjkChars.length >= 2 && cjkChars.length === seg.length) {
        for (let i = 0; i < cjkChars.length - 1; i++) {
          tokens.push(cjkChars[i] + cjkChars[i + 1]);
        }
      } else {
        tokens.push(seg.toLowerCase());
      }
    }
  }
  return tokens.length > 0 ? tokens : rawWords;
}

function findSynonymCategory(term: string): string | null {
  const norm = term.toLowerCase().trim();
  const tokens = tokenizeText(norm);
  for (const [category, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    if (category === norm || synonyms.includes(norm)) {
      return category;
    }
    for (const syn of synonyms) {
      if (syn.length >= 2 && tokens.includes(syn)) {
        return category;
      }
    }
  }
  return null;
}

/**
 * Score candidate text overlap for local evaluation
 */
export function scoreCandidate(query: string, candidateText: string): number {
  if (!query || !candidateText) return 0;
  const normQuery = query.toLowerCase().trim();
  const normCand = candidateText.toLowerCase().trim();

  // 1. Exact match
  if (normQuery === normCand) return 1.0;

  // 2. Exact token / whole-word match
  const queryTokens = tokenizeText(normQuery);
  const candTokens = tokenizeText(normCand);
  if (candTokens.includes(normQuery) || queryTokens.includes(normCand)) {
    return 0.95;
  }

  // 3. Synonym category alignment
  const queryCat = findSynonymCategory(normQuery);
  const candCat = findSynonymCategory(normCand);
  if (queryCat && candCat && queryCat === candCat) {
    return 0.9;
  }

  // 4. Token & CJK bigram overlap
  if (queryTokens.length > 0 && candTokens.length > 0) {
    let intersection = 0;
    for (const qt of queryTokens) {
      if (candTokens.includes(qt)) {
        intersection++;
      }
    }
    const union = queryTokens.length + candTokens.length - intersection;
    const jaccard = intersection / Math.max(1, union);
    const overlapRatio = intersection / Math.max(queryTokens.length, candTokens.length);
    const combinedScore = Math.max(jaccard, overlapRatio) * 0.75;
    if (combinedScore > 0.3) {
      return combinedScore;
    }
  }

  return 0;
}

/**
 * Evaluates semantic match using local heuristic rules
 */
export function heuristicSemanticMatch(
  query: string,
  candidates: MatchCandidate[],
  threshold = 0.4,
): MatchResult | null {
  let bestCandidate: MatchCandidate | null = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const combinedText = `${cand.text} ${cand.details || ''}`.trim();
    const score = scoreCandidate(query, combinedText);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = cand;
    }
  }

  if (bestCandidate && bestScore >= threshold) {
    return {
      matchedId: bestCandidate.id,
      confidence: bestScore,
      engine: 'heuristic',
    };
  }

  return null;
}

/**
 * Executes a semantic match request specifically for locator with strict <= 32 candidate constraint,
 * deadlineAt support, signal cancellation, and no value leakage.
 */
export async function executeLocatorSemanticMatch(options: {
  taskId?: string;
  pageIdentity?: string;
  context?: string;
  query: string;
  candidates: JevSemanticCandidate[];
  type?: string;
  operation?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  sendJevMatch?:
    | typeof sendJevMatchToNative
    | ((payload: any, timeoutMs?: number, options?: any) => Promise<any>);
}): Promise<JevSemanticMatchResponse> {
  const {
    query,
    candidates,
    type = 'locator',
    operation = 'locator',
    deadlineAt,
    signal,
    sendJevMatch = sendJevMatchToNative,
  } = options;

  if (candidates.length > MAX_SEMANTIC_CANDIDATES) {
    return {
      success: false,
      status: 'none',
      error: `Semantic match coverage limit exceeded: found ${candidates.length} candidates (maximum ${MAX_SEMANTIC_CANDIDATES} allowed). Refine locator query or specify frameId/selector.`,
    };
  }

  if (candidates.length === 0) {
    return {
      success: false,
      status: 'none',
    };
  }

  if (signal?.aborted) {
    return {
      success: false,
      status: 'cancelled',
      error: 'Locator semantic matching aborted',
    };
  }

  const effectiveDeadlineAt = Math.min(deadlineAt ?? Infinity, Date.now() + 1500);
  const remainingMs = effectiveDeadlineAt - Date.now();
  if (remainingMs <= 0) {
    return {
      success: false,
      status: 'cancelled',
      error: 'Locator semantic matching deadline reached',
    };
  }

  const payload: JevSemanticMatchPayload = {
    taskId: options.taskId,
    pageIdentity: options.pageIdentity,
    context: options.context,
    candidates,
    query,
    type,
    operation,
    deadlineAt: effectiveDeadlineAt,
  };

  try {
    const rawRes = await (sendJevMatch as any)(payload, Math.max(1, remainingMs), {
      signal,
      deadlineAt: effectiveDeadlineAt,
    });

    if (!rawRes) {
      return {
        success: false,
        status: 'unavailable',
      };
    }

    const baseDiagnostics = {
      ...(rawRes.backend ? { backend: rawRes.backend } : {}),
      ...(typeof rawRes.latencyMs === 'number' ? { latencyMs: rawRes.latencyMs } : {}),
      ...(rawRes.usage !== undefined ? { usage: rawRes.usage } : {}),
      ...(typeof rawRes.attempts === 'number' ? { attempts: rawRes.attempts } : {}),
    };

    const status: SemanticMatchStatus = rawRes.status;
    if (!['matched', 'none', 'ambiguous', 'unavailable', 'cancelled'].includes(status)) {
      return { success: false, status: 'unavailable', ...baseDiagnostics };
    }
    if (
      status === 'matched' &&
      (typeof rawRes.confidence !== 'number' ||
        !Number.isFinite(rawRes.confidence) ||
        rawRes.confidence < 0.85 ||
        rawRes.confidence > 1 ||
        !candidates.some((candidate) => String(candidate.id) === String(rawRes.matchedId)))
    )
      return {
        success: false,
        status: 'unavailable',
        model: rawRes.model,
        engine: rawRes.engine || 'jev',
        ...baseDiagnostics,
      };

    return {
      success: rawRes.success === true && status === 'matched',
      status,
      matchedId: rawRes.matchedId,
      confidence: rawRes.confidence,
      probabilities: rawRes.probabilities,
      model: rawRes.model,
      engine: rawRes.engine || 'jev',
      cacheHit: rawRes.cacheHit,
      ...baseDiagnostics,
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === 'AbortError' || String(err).includes('abort')) {
      return {
        success: false,
        status: 'cancelled',
        error: 'Locator semantic matching aborted',
      };
    }
    return {
      success: false,
      status: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Unified Semantic Matcher for Form Pipeline
 * 1. Strict exact check: Multiple exact matches are ambiguous, never picking the first match.
 * 2. Jev Native System One: Uses status and clean confidence, never uploads input value.
 * 3. An unavailable model never authorizes a guessed target.
 */
export async function matchSemantically(
  type: 'field' | 'choice' | 'input',
  query: string,
  candidates: MatchCandidate[],
  value?: string,
  context?: string,
  options?: {
    signal?: AbortSignal;
    deadlineAt?: number;
    inferenceBudget?: { remaining: number };
    taskId?: string;
    pageIdentity?: string;
    onDecision?: (decision: JevSemanticMatchResponse) => void;
  },
): Promise<MatchResult | null> {
  if (candidates.length === 0) return null;
  if (
    options?.signal?.aborted ||
    (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
  )
    return null;

  const normQuery = (type === 'choice' && value ? value : query).toLowerCase().trim();
  if (normQuery) {
    const exactMatches = candidates.filter(
      (c) => (c.text || '').toLowerCase().trim() === normQuery,
    );
    if (exactMatches.length === 1) {
      return {
        matchedId: exactMatches[0].id,
        confidence: 1.0,
        engine: 'literal',
      };
    }
    if (exactMatches.length > 1) {
      return null;
    }

    const wholeTokenMatches = candidates.filter((c) => {
      const tokens = tokenizeText(c.text || '');
      return tokens.includes(normQuery);
    });
    if (wholeTokenMatches.length === 1) {
      return {
        matchedId: wholeTokenMatches[0].id,
        confidence: 0.95,
        engine: 'literal',
      };
    }
    if (wholeTokenMatches.length > 1) {
      return null;
    }
  }

  // Unobserved choice answers can be secrets; only literal choices stay local.
  if (type === 'choice') return null;
  if (
    candidates.length > MAX_SEMANTIC_CANDIDATES ||
    (options?.inferenceBudget && options.inferenceBudget.remaining <= 0)
  )
    return null;
  if (options?.inferenceBudget) options.inferenceBudget.remaining--;
  try {
    const result = await executeLocatorSemanticMatch({
      type,
      operation: 'fill',
      taskId: options?.taskId,
      pageIdentity: options?.pageIdentity,
      query,
      context,
      candidates: candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
      signal: options?.signal,
      deadlineAt: options?.deadlineAt,
    });
    options?.onDecision?.(result);
    if (
      result?.success &&
      result.status === 'matched' &&
      typeof result.confidence === 'number' &&
      Number.isFinite(result.confidence) &&
      result.confidence >= 0.85 &&
      result.confidence <= 1 &&
      candidates.some((candidate) => String(candidate.id) === String(result.matchedId))
    ) {
      return {
        matchedId: result.matchedId!,
        confidence: result.confidence,
        engine: 'jev',
        ...(result.cacheHit !== undefined ? { cacheHit: result.cacheHit } : {}),
        ...(result.backend ? { backend: result.backend } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(typeof result.latencyMs === 'number' ? { latencyMs: result.latencyMs } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(typeof result.attempts === 'number' ? { attempts: result.attempts } : {}),
      };
    }
  } catch {
    // A transport failure never authorizes another target.
  }

  return null;
}
