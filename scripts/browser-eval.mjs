import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const DEFAULT_SUITE_PATH = path.join(
  repoRoot,
  'docs',
  'development',
  'browser-task-suite.json',
);
export const FAMILIES = Object.freeze([
  'mdn_search',
  'github_repo_release',
  'npm_compare',
  'x_search_thread',
]);
export const OUTCOMES = Object.freeze(['success', 'partial', 'blocked', 'failure']);
export const MODES = Object.freeze(['cold', 'reuse', 'recovery']);
export const KINDS = Object.freeze(['mechanism', 'agent_e2e']);
export const THRESHOLDS = Object.freeze({
  minFamilyTrials: 20,
  minBatches: 3,
  successRate: 0.95,
  wallTimeReduction: 0.2,
  inputTokenReduction: 0.3,
  reuseAgentToolCallReduction: 0.5,
  seriousFailures: 0,
});

const AGENT_TOOL_CALL_SOURCE = 'codex-session-jsonl';
const AGENT_TOOL_CALL_BASIS = 'unique response_item function_call/custom_tool_call call_id';
const DPR_TOLERANCE = 1e-6;
const BASELINE_BUILD_GROUP = 'browserpaw-build-baseline';
const CANDIDATE_BUILD_GROUP = 'browserpaw-build-candidate';

function thresholdsFor(suite) {
  return suite?.thresholds && typeof suite.thresholds === 'object' ? suite.thresholds : THRESHOLDS;
}

function validThresholds(value) {
  return (
    value &&
    Number.isSafeInteger(value.minFamilyTrials) &&
    value.minFamilyTrials > 0 &&
    Number.isSafeInteger(value.minBatches) &&
    value.minBatches > 0 &&
    isNonNegativeNumber(value.successRate) &&
    value.successRate <= 1 &&
    isNonNegativeNumber(value.wallTimeReduction) &&
    value.wallTimeReduction <= 1 &&
    isNonNegativeNumber(value.inputTokenReduction) &&
    value.inputTokenReduction <= 1 &&
    isNonNegativeNumber(value.reuseAgentToolCallReduction) &&
    value.reuseAgentToolCallReduction <= 1 &&
    Number.isSafeInteger(value.seriousFailures) &&
    value.seriousFailures >= 0
  );
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function verifiedAgentToolCallCount(record) {
  const provenance = record.agentToolCallsProvenance;
  const callTypes = provenance?.callTypes;
  if (
    !isNonNegativeInteger(record.agentToolCalls) ||
    provenance?.source !== AGENT_TOOL_CALL_SOURCE ||
    provenance?.basis !== AGENT_TOOL_CALL_BASIS ||
    typeof provenance.sessionFile !== 'string' ||
    !provenance.sessionFile.trim() ||
    !isNonNegativeInteger(provenance.callEvents) ||
    !isNonNegativeInteger(provenance.uniqueCallIds) ||
    provenance.uniqueCallIds !== record.agentToolCalls ||
    provenance.callEvents < record.agentToolCalls ||
    !callTypes ||
    !isNonNegativeInteger(callTypes.function_call) ||
    !isNonNegativeInteger(callTypes.custom_tool_call)
  ) {
    return null;
  }
  const typedCalls = callTypes.function_call + callTypes.custom_tool_call;
  if (typedCalls !== provenance.callEvents || typedCalls < record.agentToolCalls) return null;
  return record.agentToolCalls;
}

function percentile(values, percent) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (percent / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value =
    lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return Math.round(value * 1e6) / 1e6;
}

export function median(values) {
  return percentile(values, 50);
}

export function p95(values) {
  return percentile(values, 95);
}

function reduction(baseline, candidate) {
  if (baseline === null || candidate === null) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return Math.round((1 - candidate / baseline) * 1e6) / 1e6;
}

export function summarizeValues(values) {
  const valid = values.filter(isFiniteNumber);
  return {
    n: valid.length,
    median: median(valid),
    p95: p95(valid),
  };
}

function unique(values) {
  return [...new Set(values)];
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateSuite(suite) {
  const errors = [];
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    return ['suite must be an object'];
  }
  if (suite.version !== 1) errors.push('suite.version must be 1');
  if (!Array.isArray(suite.products) || suite.products.length < 2) {
    errors.push('suite.products must contain at least two products');
  }
  const productIds = Array.isArray(suite.products)
    ? suite.products.map((product) => product?.id).filter((id) => typeof id === 'string')
    : [];
  if (productIds.length !== (suite.products?.length || 0)) {
    errors.push('every suite product must have a string id');
  }
  if (unique(productIds).length !== productIds.length) {
    errors.push('suite product ids must be unique');
  }
  const candidate = suite.comparison?.candidateProduct;
  if (!productIds.includes(candidate)) {
    errors.push('suite.comparison.candidateProduct must name a suite product');
  }
  const baselines = Array.isArray(suite.comparison?.baselineProducts)
    ? suite.comparison.baselineProducts
    : [];
  if (baselines.length === 0 || baselines.some((id) => !productIds.includes(id))) {
    errors.push('suite.comparison.baselineProducts must name suite products');
  }
  if (baselines.includes(candidate)) {
    errors.push('candidate product cannot also be a baseline product');
  }
  if (!validThresholds(thresholdsFor(suite))) {
    errors.push('suite.thresholds is invalid');
  }
  const thresholds = thresholdsFor(suite);

  const batches = Array.isArray(suite.batches) ? suite.batches : [];
  if (batches.length < thresholds.minBatches) {
    errors.push(`suite requires at least ${thresholds.minBatches} batches`);
  }
  const batchIds = [];
  const orderSignatures = [];
  for (const batch of batches) {
    if (!Number.isSafeInteger(batch?.batch) || batch.batch <= 0) {
      errors.push('each batch must have a positive integer batch id');
      continue;
    }
    batchIds.push(batch.batch);
    const order = Array.isArray(batch.productOrder) ? batch.productOrder : [];
    if (
      order.length !== productIds.length ||
      unique(order).length !== order.length ||
      productIds.some((id) => !order.includes(id))
    ) {
      errors.push(`batch ${batch.batch} productOrder must include every product exactly once`);
    }
    orderSignatures.push(order.join('>'));
  }
  if (unique(batchIds).length !== batchIds.length) errors.push('batch ids must be unique');
  if (unique(orderSignatures).length !== orderSignatures.length) {
    errors.push('batch product order must be rotated rather than duplicated');
  }

  const tasks = Array.isArray(suite.tasks) ? suite.tasks : [];
  const taskIds = new Set();
  const taskById = new Map();
  const inputsByFamily = new Map(FAMILIES.map((family) => [family, new Set()]));
  const familyCounts = new Map(FAMILIES.map((family) => [family, 0]));
  const batchFamilyCounts = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      errors.push('every suite task must be an object');
      continue;
    }
    if (!task.inputId || taskIds.has(task.inputId)) {
      errors.push(`task inputId must be present and unique: ${task.inputId || '<missing>'}`);
    } else {
      taskIds.add(task.inputId);
      taskById.set(task.inputId, task);
    }
    if (!FAMILIES.includes(task.family)) {
      errors.push(`task ${task.inputId || '<missing>'} has unknown family`);
      continue;
    }
    familyCounts.set(task.family, (familyCounts.get(task.family) || 0) + 1);
    if (typeof task.input !== 'string' || !task.input.trim()) {
      errors.push(`task ${task.inputId || '<missing>'} input must be non-empty`);
    } else if (inputsByFamily.get(task.family).has(task.input.trim())) {
      errors.push(`task ${task.inputId || '<missing>'} duplicates input in ${task.family}`);
    } else {
      inputsByFamily.get(task.family).add(task.input.trim());
    }
    if (!KINDS.includes(task.kind)) {
      errors.push(`task ${task.inputId || '<missing>'} kind is invalid`);
    }
    if (!batchIds.includes(task.batch)) {
      errors.push(`task ${task.inputId || '<missing>'} batch does not exist`);
    }
    if (!Array.isArray(task.successCriteria) || task.successCriteria.length === 0) {
      errors.push(`task ${task.inputId || '<missing>'} needs successCriteria`);
    }
    if (!Array.isArray(task.evidenceRequirements) || task.evidenceRequirements.length === 0) {
      errors.push(`task ${task.inputId || '<missing>'} needs evidenceRequirements`);
    }
    const batchFamilyKey = `${task.batch}:${task.family}`;
    batchFamilyCounts.set(batchFamilyKey, (batchFamilyCounts.get(batchFamilyKey) || 0) + 1);
  }
  const reuseTargets = new Map();
  for (const task of tasks) {
    if (task?.mode !== 'reuse') continue;
    const targetId = task.explorationInputId;
    const target = taskById.get(targetId);
    if (typeof targetId !== 'string' || !targetId.trim() || !target) {
      errors.push(`reuse task ${task.inputId || '<missing>'} needs a valid explorationInputId`);
      continue;
    }
    if (targetId === task.inputId) {
      errors.push(`reuse task ${task.inputId} cannot explore itself`);
    }
    if (target.mode !== 'cold') {
      errors.push(`reuse task ${task.inputId} explorationInputId must name a cold task`);
    }
    if (target.family !== task.family || target.kind !== task.kind) {
      errors.push(
        `reuse task ${task.inputId} explorationInputId must stay in the same task family`,
      );
    }
    if (target.input === task.input) {
      errors.push(`reuse task ${task.inputId} needs a distinct exploration input`);
    }
    if (target.batch > task.batch) {
      errors.push(`reuse task ${task.inputId} exploration cannot come from a later batch`);
    }
    if (reuseTargets.has(targetId)) {
      errors.push(
        `cold task ${targetId} is linked to multiple reuse tasks: ${reuseTargets.get(targetId)}, ${task.inputId}`,
      );
    } else {
      reuseTargets.set(targetId, task.inputId);
    }
  }
  for (const family of FAMILIES) {
    if ((familyCounts.get(family) || 0) < thresholds.minFamilyTrials) {
      errors.push(`${family} requires at least ${thresholds.minFamilyTrials} distinct inputs`);
    }
    for (const batch of batchIds) {
      if ((batchFamilyCounts.get(`${batch}:${family}`) || 0) === 0) {
        errors.push(`batch ${batch} must interleave at least one ${family} task`);
      }
    }
  }
  return errors;
}

export function loadSuite(filePath = DEFAULT_SUITE_PATH) {
  const suite = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { suite, errors: validateSuite(suite), filePath };
}

export function validateRecord(record, suite, taskById = null) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['record must be an object'];
  }
  if (record.recordVersion !== 1) errors.push('recordVersion must be 1');
  if (!KINDS.includes(record.kind)) errors.push('kind must be mechanism or agent_e2e');
  const products = new Set((suite.products || []).map((product) => product.id));
  if (!products.has(record.product)) errors.push('product must name a suite product');
  if (typeof record.build !== 'string' || !record.build.trim()) errors.push('build is required');
  if (typeof record.model !== 'string' || !record.model.trim()) errors.push('model is required');
  if (typeof record.reasoning !== 'string' || !record.reasoning.trim()) {
    errors.push('reasoning is required');
  }
  if (typeof record.session !== 'string' || !record.session.trim()) {
    errors.push('session is required');
  }
  const allowUnknownConditions =
    record.kind === 'agent_e2e' && (record.outcome === 'blocked' || record.outcome === 'failure');
  if (
    record.login !== 'anonymous' &&
    record.login !== 'authenticated' &&
    !(allowUnknownConditions && record.login === 'unknown')
  ) {
    errors.push(
      'login must be anonymous or authenticated, or unknown for blocked/failure agent_e2e records',
    );
  }
  const viewport = record.viewport;
  const validWidth = Number.isSafeInteger(viewport?.width) && viewport.width > 0;
  const validHeight = Number.isSafeInteger(viewport?.height) && viewport.height > 0;
  if (
    !viewport ||
    typeof viewport !== 'object' ||
    Array.isArray(viewport) ||
    (!validWidth && !(allowUnknownConditions && viewport.width === null)) ||
    (!validHeight && !(allowUnknownConditions && viewport.height === null))
  ) {
    errors.push(
      'viewport width/height must be positive integers, or null only for blocked/failure agent_e2e records',
    );
  }
  if (
    viewport?.dpr !== undefined &&
    !(isFiniteNumber(viewport.dpr) && viewport.dpr > 0) &&
    !(allowUnknownConditions && viewport.dpr === null)
  ) {
    errors.push(
      'viewport.dpr must be a finite positive number, or null only for blocked/failure agent_e2e records',
    );
  }
  if (typeof record.cache !== 'string' || !record.cache.trim()) errors.push('cache is required');
  if (
    record.conditionIssues !== undefined &&
    (!Array.isArray(record.conditionIssues) ||
      record.conditionIssues.some((issue) => typeof issue !== 'string' || !issue.trim()))
  ) {
    errors.push('conditionIssues must be an array of nonempty strings');
  }
  if (typeof record.trialId !== 'string' || !record.trialId.trim()) {
    errors.push('trialId is required');
  }
  if (typeof record.pairId !== 'string' || !record.pairId.trim()) {
    errors.push('pairId is required');
  }
  if (!Number.isSafeInteger(record.batch) || record.batch <= 0) {
    errors.push('batch must be a positive integer');
  } else if (!(suite.batches || []).some((batch) => batch.batch === record.batch)) {
    errors.push('batch does not exist in suite');
  }
  if (!MODES.includes(record.mode)) errors.push('mode is invalid');
  if (!OUTCOMES.includes(record.outcome)) errors.push('outcome is invalid');
  const tasks = taskById || new Map((suite.tasks || []).map((task) => [task.inputId, task]));
  const task = tasks.get(record.inputId);
  if (!task) errors.push('inputId does not exist in suite');
  if (task && record.batch !== task.batch) errors.push('record batch does not match suite task');
  if (task && record.mode !== task.mode) errors.push('record mode does not match suite task');
  if (task && record.kind !== task.kind) {
    errors.push('record kind does not match suite task kind');
  }
  if (task?.requiresLogin === true && record.login !== 'authenticated' && !allowUnknownConditions) {
    errors.push('task requires an authenticated login environment');
  }
  const candidateProduct = suite.comparison?.candidateProduct;
  const explorationTarget = (suite.tasks || []).some(
    (candidate) => candidate.mode === 'reuse' && candidate.explorationInputId === record.inputId,
  );
  if (
    record.product === candidateProduct &&
    (task?.mode === 'reuse' || explorationTarget) &&
    (typeof record.explorationPairId !== 'string' || !record.explorationPairId.trim())
  ) {
    errors.push('candidate cold/reuse records require explorationPairId');
  }
  if (!validIsoDate(record.startedAt)) errors.push('startedAt must be an ISO timestamp');
  if (
    !record.businessEvidence ||
    typeof record.businessEvidence.summary !== 'string' ||
    !Array.isArray(record.businessEvidence.sources) ||
    record.businessEvidence.sources.some(
      (source) => typeof source !== 'string' || !/^https?:\/\/[^/\s]+/i.test(source.trim()),
    )
  ) {
    errors.push('businessEvidence requires summary and HTTP(S) source URLs');
  } else if (
    (record.outcome === 'success' || record.outcome === 'partial') &&
    (!record.businessEvidence.summary.trim() || record.businessEvidence.sources.length === 0)
  ) {
    errors.push('successful or partial records require business evidence and sources');
  }
  if (
    !record.timing ||
    !isNonNegativeNumber(record.timing.wallMs) ||
    !isNonNegativeNumber(record.timing.toolMs) ||
    !(record.timing.modelMs === null || isNonNegativeNumber(record.timing.modelMs)) ||
    (record.timing.unattributedMs !== undefined &&
      !isNonNegativeNumber(record.timing.unattributedMs))
  ) {
    errors.push('timing requires non-negative wallMs/toolMs and a measured modelMs or null');
  }
  if (
    record.timing?.toolWallMs !== undefined &&
    (!isNonNegativeNumber(record.timing.toolWallMs) ||
      record.timing.toolWallMs > record.timing.wallMs ||
      record.timing.toolWallMs > record.timing.toolMs)
  ) {
    errors.push('toolWallMs must be non-negative and cannot exceed wallMs or summed toolMs');
  }
  if (
    !record.actualTokens ||
    !(record.actualTokens.input === null || isNonNegativeNumber(record.actualTokens.input)) ||
    !(record.actualTokens.output === null || isNonNegativeNumber(record.actualTokens.output))
  ) {
    errors.push('actualTokens input/output must be non-negative numbers or null');
  }
  if (!isNonNegativeNumber(record.estimatedTextTokens)) {
    errors.push('estimatedTextTokens must be a non-negative number');
  }
  if (!isNonNegativeNumber(record.estimatedInputTokens)) {
    errors.push('estimatedInputTokens must be a non-negative number');
  }
  if (typeof record.tokenizer !== 'string' || !record.tokenizer.trim()) {
    errors.push('tokenizer is required');
  }
  if (
    !record.images ||
    !isNonNegativeInteger(record.images.input) ||
    !isNonNegativeInteger(record.images.output)
  ) {
    errors.push('images input/output counts must be non-negative integers');
  }
  if (!isNonNegativeInteger(record.roundTrips)) {
    errors.push('roundTrips must be a non-negative integer');
  }
  if (
    record.roundTrips === 0 &&
    !(
      allowUnknownConditions &&
      typeof record.startupFailure?.reason === 'string' &&
      record.startupFailure.reason.trim()
    )
  ) {
    errors.push('zero-call records require a blocked/failure agent_e2e startup reason');
  }
  if (record.kind === 'agent_e2e' && verifiedAgentToolCallCount(record) === null) {
    errors.push('Agent tool-call count and codex-session-jsonl provenance are required');
  }
  if (!Array.isArray(record.seriousFailures)) {
    errors.push('seriousFailures must be an array');
  }
  return errors;
}

export function loadRecords(filePath) {
  if (!filePath) throw new Error('records path is required');
  if (!fs.existsSync(filePath)) throw new Error(`records file not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  let records;
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    records = raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid JSONL record at line ${index + 1}: ${error.message}`);
        }
      });
  } else {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : parsed?.records;
  }
  if (!Array.isArray(records)) throw new Error('records file must contain an array or records[]');
  return {
    records,
    filePath,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

function pairKey(record) {
  return `${record.pairId}\u0000${record.mode}`;
}

function sameViewportConditions(left, right) {
  return (
    [left, right].every(
      (record) =>
        record.conditionIssues === undefined ||
        (Array.isArray(record.conditionIssues) && record.conditionIssues.length === 0),
    ) &&
    left.viewport?.width === right.viewport?.width &&
    left.viewport?.height === right.viewport?.height &&
    isFiniteNumber(left.viewport?.dpr) &&
    left.viewport.dpr > 0 &&
    isFiniteNumber(right.viewport?.dpr) &&
    right.viewport.dpr > 0 &&
    Math.abs(left.viewport.dpr - right.viewport.dpr) <= DPR_TOLERANCE
  );
}

function samePairConditions(left, right) {
  return (
    left.inputId === right.inputId &&
    left.batch === right.batch &&
    left.model === right.model &&
    left.reasoning === right.reasoning &&
    left.login === right.login &&
    left.cache === right.cache &&
    left.mode === right.mode &&
    sameViewportConditions(left, right)
  );
}

function productOrderIssues(records, suite) {
  const issues = [];
  const batchById = new Map((suite.batches || []).map((batch) => [batch.batch, batch]));
  const groups = new Map();
  for (const record of records) {
    if (record.kind !== 'agent_e2e') continue;
    const key = `${record.pairId}\u0000${record.mode}\u0000${record.batch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const group of groups.values()) {
    if (group.length !== (suite.products || []).length) continue;
    const expected = batchById.get(group[0].batch)?.productOrder || [];
    const actual = [...group]
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      .map((record) => record.product);
    if (actual.join('>') !== expected.join('>')) {
      issues.push(`pair ${group[0].pairId} product order does not match batch rotation`);
    }
  }
  return issues;
}

function qualityIssues(records) {
  const issues = [];
  const agentRecords = records.filter((record) => record.kind === 'agent_e2e');
  for (const record of agentRecords) {
    for (const issue of record.conditionIssues || []) {
      issues.push(`${record.trialId} conditions: ${issue}`);
    }
  }
  const missingAgentCalls = agentRecords.filter(
    (record) => verifiedAgentToolCallCount(record) === null,
  );
  if (missingAgentCalls.length > 0) {
    issues.push(
      `Agent tool-call counts are missing or unverified in ${missingAgentCalls.length} records`,
    );
  }
  const measured = agentRecords.filter(
    (record) => record.outcome === 'success' || record.outcome === 'partial',
  );
  const missingActual = measured.filter(
    (record) => record.actualTokens.input === null || record.actualTokens.output === null,
  );
  if (missingActual.length > 0) {
    issues.push(
      `${missingActual.length} measured agent records are missing actual input/output tokens`,
    );
  }
  const tokenizers = unique(
    measured
      .map((record) => record.tokenizer)
      .filter((tokenizer) => typeof tokenizer === 'string' && tokenizer.trim()),
  );

  const trialIds = records.map((record) => record.trialId);
  if (unique(trialIds).length !== trialIds.length) issues.push('trialId values must be unique');

  const pairs = new Map();
  for (const record of agentRecords) {
    const key = pairKey(record);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(record);
  }
  for (const pair of pairs.values()) {
    for (let index = 1; index < pair.length; index += 1) {
      if (!samePairConditions(pair[0], pair[index])) {
        issues.push(`pair ${pair[0].pairId} mixes model/environment conditions`);
        break;
      }
    }
    if (unique(pair.map((record) => record.product)).length !== pair.length) {
      issues.push(`pair ${pair[0].pairId} has duplicate product records`);
    }
  }
  return { issues: unique(issues), tokenizers, measuredN: measured.length };
}

function summarizeProduct(records, product, invalid = 0) {
  const selected = records.filter(
    (record) => record.kind === 'agent_e2e' && record.product === product,
  );
  const successful = selected.filter((record) => record.outcome === 'success');
  const partial = selected.filter((record) => record.outcome === 'partial');
  const blocked = selected.filter((record) => record.outcome === 'blocked');
  const failure = selected.filter((record) => record.outcome === 'failure');
  const actualTotals = selected
    .filter((record) => record.actualTokens.input !== null && record.actualTokens.output !== null)
    .map((record) => record.actualTokens.input + record.actualTokens.output);
  const actualInputs = selected
    .filter((record) => record.actualTokens.input !== null)
    .map((record) => record.actualTokens.input);
  const actualOutputs = selected
    .filter((record) => record.actualTokens.output !== null)
    .map((record) => record.actualTokens.output);
  const families = Object.fromEntries(
    FAMILIES.map((family) => {
      const familyRecords = selected.filter((record) => record.inputFamily === family);
      const familySuccess = familyRecords.filter((record) => record.outcome === 'success').length;
      return [
        family,
        {
          n: familyRecords.length,
          success: familySuccess,
          successRate: familyRecords.length ? familySuccess / familyRecords.length : null,
        },
      ];
    }),
  );
  return {
    n: selected.length,
    success: successful.length,
    partial: partial.length,
    blocked: blocked.length,
    failure: failure.length,
    successRate: selected.length ? successful.length / selected.length : null,
    wallMs: summarizeValues(selected.map((record) => record.timing.wallMs)),
    toolMs: summarizeValues(selected.map((record) => record.timing.toolMs)),
    toolWallMs: summarizeValues(selected.map((record) => record.timing.toolWallMs)),
    modelMs: summarizeValues(selected.map((record) => record.timing.modelMs)),
    estimatedTextTokens: summarizeValues(selected.map((record) => record.estimatedTextTokens)),
    estimatedInputTokens: summarizeValues(selected.map((record) => record.estimatedInputTokens)),
    actualTokens: summarizeValues(actualTotals),
    actualInputTokens: summarizeValues(actualInputs),
    actualOutputTokens: summarizeValues(actualOutputs),
    roundTrips: summarizeValues(selected.map((record) => record.roundTrips)),
    agentToolCalls: summarizeValues(selected.map((record) => verifiedAgentToolCallCount(record))),
    images: {
      input: selected.reduce((total, record) => total + record.images.input, 0),
      output: selected.reduce((total, record) => total + record.images.output, 0),
    },
    invalid,
    seriousFailures:
      invalid > 0 || selected.length === 0
        ? null
        : selected.reduce((total, record) => total + record.seriousFailures.length, 0),
    family: families,
  };
}

function sameSkillReuseConditions(exploration, reuse) {
  return (
    exploration.product === reuse.product &&
    exploration.build === reuse.build &&
    exploration.model === reuse.model &&
    exploration.reasoning === reuse.reasoning &&
    exploration.login === reuse.login &&
    sameViewportConditions(exploration, reuse) &&
    exploration.session !== reuse.session
  );
}

export function compareSkillReuse(records, suite, product) {
  const reuseTasks = (suite.tasks || []).filter((task) => task.mode === 'reuse');
  const selected = records.filter(
    (record) => record.kind === 'agent_e2e' && record.product === product,
  );
  const byExplorationPair = new Map();
  for (const record of selected) {
    if (typeof record.explorationPairId !== 'string' || !record.explorationPairId.trim()) {
      continue;
    }
    if (!byExplorationPair.has(record.explorationPairId)) {
      byExplorationPair.set(record.explorationPairId, []);
    }
    byExplorationPair.get(record.explorationPairId).push(record);
  }

  const pairs = [];
  const issues = [];
  const familyCounts = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
  const batches = new Set();
  for (const task of reuseTasks) {
    const reuseRecords = selected.filter((record) => record.inputId === task.inputId);
    if (reuseRecords.length !== 1) {
      issues.push(
        `reuse task ${task.inputId} requires exactly one ${product} record, found ${reuseRecords.length}`,
      );
      continue;
    }
    const reuse = reuseRecords[0];
    const group = byExplorationPair.get(reuse.explorationPairId) || [];
    const explorations = group.filter((record) => record.inputId === task.explorationInputId);
    if (group.length !== 2 || explorations.length !== 1) {
      issues.push(
        `reuse task ${task.inputId} needs one explorationPairId linked to ${task.explorationInputId}`,
      );
      continue;
    }
    const exploration = explorations[0];
    if (exploration.mode !== 'cold' || reuse.mode !== 'reuse') {
      issues.push(`reuse task ${task.inputId} does not pair cold exploration with reuse mode`);
      continue;
    }
    if (exploration.outcome !== 'success' || reuse.outcome !== 'success') {
      continue;
    }
    const explorationMs = Date.parse(exploration.startedAt);
    const reuseMs = Date.parse(reuse.startedAt);
    if (!(explorationMs < reuseMs)) {
      issues.push(`reuse task ${task.inputId} did not start after its cold exploration`);
      continue;
    }
    if (!sameSkillReuseConditions(exploration, reuse)) {
      issues.push(`reuse task ${task.inputId} changes product/build/model/environment`);
      continue;
    }
    const explorationCalls = verifiedAgentToolCallCount(exploration);
    const reuseCalls = verifiedAgentToolCallCount(reuse);
    if (explorationCalls === null || reuseCalls === null) {
      issues.push(`reuse task ${task.inputId} has no verified Agent tool-call count`);
      continue;
    }
    pairs.push({
      task,
      exploration,
      reuse,
      explorationCalls,
      reuseCalls,
      reduction: reduction(explorationCalls, reuseCalls),
    });
    familyCounts[task.family] += 1;
    batches.add(reuse.batch);
  }

  const expectedFamilyCounts = Object.fromEntries(
    FAMILIES.map((family) => [family, reuseTasks.filter((task) => task.family === family).length]),
  );
  const baselineCalls = pairs.map((pair) => pair.explorationCalls);
  const candidateCalls = pairs.map((pair) => pair.reuseCalls);
  const pairedMedianReduction = median(pairs.map((pair) => pair.reduction).filter(isFiniteNumber));
  const thresholds = thresholdsFor(suite);
  const sample =
    pairs.length === reuseTasks.length &&
    reuseTasks.length > 0 &&
    FAMILIES.every((family) => familyCounts[family] === expectedFamilyCounts[family]);
  return {
    product,
    expectedPairs: reuseTasks.length,
    n: pairs.length,
    families: familyCounts,
    batches: [...batches].sort((left, right) => left - right),
    baselineAgentToolCalls: median(baselineCalls),
    candidateAgentToolCalls: median(candidateCalls),
    pairedMedianReduction,
    gates: {
      sample,
      agentToolCalls:
        pairedMedianReduction !== null &&
        pairedMedianReduction >= thresholds.reuseAgentToolCallReduction,
    },
    issues: unique(issues),
  };
}

export function compareProducts(records, suite, baselineProduct, candidateProduct) {
  const baseline = new Map();
  const candidate = new Map();
  const taskById = new Map((suite.tasks || []).map((task) => [task.inputId, task]));
  for (const record of records) {
    if (record.kind !== 'agent_e2e') continue;
    if (record.product === baselineProduct) baseline.set(pairKey(record), record);
    if (record.product === candidateProduct) candidate.set(pairKey(record), record);
  }

  const wallsBaseline = [];
  const wallsCandidate = [];
  const inputTokensBaseline = [];
  const inputTokensCandidate = [];
  const pairedWallReductions = [];
  const pairedInputTokenReductions = [];
  let imageInputsBaseline = 0;
  let imageInputsCandidate = 0;
  let imageCountsKnown = true;
  const pairedFamilies = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
  for (const [key, candidateRecord] of candidate.entries()) {
    const baselineRecord = baseline.get(key);
    if (
      !baselineRecord ||
      baselineRecord.outcome !== 'success' ||
      candidateRecord.outcome !== 'success' ||
      !samePairConditions(baselineRecord, candidateRecord)
    ) {
      continue;
    }
    const family = candidateRecord.inputFamily || taskById.get(candidateRecord.inputId)?.family;
    if (FAMILIES.includes(family)) pairedFamilies[family] += 1;
    wallsBaseline.push(baselineRecord.timing.wallMs);
    wallsCandidate.push(candidateRecord.timing.wallMs);
    const wallPairReduction = reduction(
      baselineRecord.timing.wallMs,
      candidateRecord.timing.wallMs,
    );
    if (wallPairReduction !== null) pairedWallReductions.push(wallPairReduction);
    const baselineInput = baselineRecord.actualTokens?.input;
    const candidateInput = candidateRecord.actualTokens?.input;
    if (!isNonNegativeNumber(baselineInput) || !isNonNegativeNumber(candidateInput)) {
      continue;
    }
    inputTokensBaseline.push(baselineInput);
    inputTokensCandidate.push(candidateInput);
    const inputPairReduction = reduction(baselineInput, candidateInput);
    if (inputPairReduction !== null) pairedInputTokenReductions.push(inputPairReduction);
    const baselineImages = baselineRecord.images?.input;
    const candidateImages = candidateRecord.images?.input;
    if (!isNonNegativeInteger(baselineImages) || !isNonNegativeInteger(candidateImages)) {
      imageCountsKnown = false;
    } else {
      imageInputsBaseline += baselineImages;
      imageInputsCandidate += candidateImages;
    }
  }

  const baselineWall = median(wallsBaseline);
  const candidateWall = median(wallsCandidate);
  const baselineInputTokens = median(inputTokensBaseline);
  const candidateInputTokens = median(inputTokensCandidate);
  const wallReduction = reduction(baselineWall, candidateWall);
  const inputTokenReduction = reduction(baselineInputTokens, candidateInputTokens);
  const pairedWallReduction = median(pairedWallReductions);
  const pairedInputTokenReduction = median(pairedInputTokenReductions);
  const pairedN = wallsBaseline.length;
  const actualInputPairs = inputTokensBaseline.length;
  const thresholds = thresholdsFor(suite);
  const sampleSufficient =
    pairedN >= thresholds.minFamilyTrials &&
    FAMILIES.every((family) => pairedFamilies[family] >= thresholds.minFamilyTrials);
  const baselineWallP95 = p95(wallsBaseline);
  const candidateWallP95 = p95(wallsCandidate);
  const baselineInputTokenP95 = p95(inputTokensBaseline);
  const candidateInputTokenP95 = p95(inputTokensCandidate);
  const p95WallNonRegression =
    baselineWallP95 !== null &&
    candidateWallP95 !== null &&
    candidateWallP95 <= baselineWallP95 * 1.2;
  const p95InputTokenNonRegression =
    actualInputPairs === pairedN &&
    pairedN > 0 &&
    baselineInputTokenP95 !== null &&
    candidateInputTokenP95 !== null &&
    candidateInputTokenP95 <= baselineInputTokenP95 * 1.2;
  const includesImageInput = imageInputsBaseline + imageInputsCandidate > 0;
  return {
    baselineProduct,
    candidateProduct,
    pairedN,
    actualInputPairs,
    pairedFamilies,
    sampleSufficient,
    wallMs: {
      baselineMedian: baselineWall,
      candidateMedian: candidateWall,
      reduction: wallReduction,
      pairedMedianReduction: pairedWallReduction,
      baselineP95: baselineWallP95,
      candidateP95: candidateWallP95,
    },
    actualInputTokens: {
      basis:
        'Codex-reported cumulative input tokens; includes cached input and image tokens when present',
      baselineMedian: baselineInputTokens,
      candidateMedian: candidateInputTokens,
      reduction: inputTokenReduction,
      pairedMedianReduction: pairedInputTokenReduction,
      baselineP95: baselineInputTokenP95,
      candidateP95: candidateInputTokenP95,
      imageInputs: {
        baseline: imageInputsBaseline,
        candidate: imageInputsCandidate,
        countsComplete: imageCountsKnown && actualInputPairs === pairedN && pairedN > 0,
        includesImageInput,
      },
    },
    gates: {
      sample: sampleSufficient,
      wallTime: pairedWallReduction !== null && pairedWallReduction >= thresholds.wallTimeReduction,
      inputTokens:
        actualInputPairs === pairedN &&
        actualInputPairs > 0 &&
        pairedInputTokenReduction !== null &&
        pairedInputTokenReduction >= thresholds.inputTokenReduction,
      p95NonRegression: p95WallNonRegression && p95InputTokenNonRegression,
    },
  };
}

function validatedBuildSelectors(baselineBuild, candidateBuild) {
  if (typeof baselineBuild !== 'string' || !baselineBuild.trim()) {
    throw new Error('baselineBuild is required');
  }
  if (typeof candidateBuild !== 'string' || !candidateBuild.trim()) {
    throw new Error('candidateBuild is required');
  }
  if (baselineBuild === candidateBuild) {
    throw new Error('baselineBuild and candidateBuild must be different');
  }
}

function browserpawBuildSelection(records, baselineBuild, candidateBuild) {
  const agentRecords = records.filter(
    (record) => record?.kind === 'agent_e2e' && record.product === 'browserpaw',
  );
  const baseline = agentRecords.filter((record) => record.build === baselineBuild);
  const candidate = agentRecords.filter((record) => record.build === candidateBuild);
  return {
    baseline,
    candidate,
    ignoredRecordCount: records.length - baseline.length - candidate.length,
    comparisonRecords: [
      ...baseline.map((record) => ({ ...record, product: BASELINE_BUILD_GROUP })),
      ...candidate.map((record) => ({ ...record, product: CANDIDATE_BUILD_GROUP })),
    ],
  };
}

function pairedFamilySuccess(baselineRecords, candidateRecords, suite) {
  const taskById = new Map((suite.tasks || []).map((task) => [task.inputId, task]));
  const baseline = new Map(baselineRecords.map((record) => [pairKey(record), record]));
  const candidate = new Map(candidateRecords.map((record) => [pairKey(record), record]));
  const expectedTasks = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      new Set(
        (suite.tasks || []).filter((task) => task.family === family).map((task) => task.inputId),
      ),
    ]),
  );
  const completedTasks = Object.fromEntries(FAMILIES.map((family) => [family, new Set()]));
  const families = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      {
        expectedN: expectedTasks[family].size,
        n: 0,
        baselineSuccess: 0,
        candidateSuccess: 0,
      },
    ]),
  );
  for (const [key, candidateRecord] of candidate) {
    const baselineRecord = baseline.get(key);
    if (!baselineRecord || !samePairConditions(baselineRecord, candidateRecord)) continue;
    const family = candidateRecord.inputFamily || taskById.get(candidateRecord.inputId)?.family;
    if (!FAMILIES.includes(family)) continue;
    families[family].n += 1;
    completedTasks[family].add(candidateRecord.inputId);
    if (baselineRecord.outcome === 'success') families[family].baselineSuccess += 1;
    if (candidateRecord.outcome === 'success') families[family].candidateSuccess += 1;
  }
  const result = Object.fromEntries(
    Object.entries(families).map(([family, stats]) => [
      family,
      {
        ...stats,
        complete: stats.expectedN > 0 && completedTasks[family].size === stats.expectedN,
        baselineSuccessRate: stats.n ? stats.baselineSuccess / stats.n : null,
        candidateSuccessRate: stats.n ? stats.candidateSuccess / stats.n : null,
      },
    ]),
  );
  return {
    families: result,
    nonRegression: FAMILIES.every(
      (family) =>
        result[family].complete &&
        result[family].candidateSuccessRate >= result[family].baselineSuccessRate,
    ),
  };
}

export function compareBrowserpawBuilds(records, suite, baselineBuild, candidateBuild) {
  validatedBuildSelectors(baselineBuild, candidateBuild);
  const selection = browserpawBuildSelection(records, baselineBuild, candidateBuild);
  const comparison = compareProducts(
    selection.comparisonRecords,
    suite,
    BASELINE_BUILD_GROUP,
    CANDIDATE_BUILD_GROUP,
  );
  return {
    ...comparison,
    mode: 'browserpaw-builds',
    product: 'browserpaw',
    baselineBuild,
    candidateBuild,
    baselineRecordCount: selection.baseline.length,
    candidateRecordCount: selection.candidate.length,
    ignoredRecordCount: selection.ignoredRecordCount,
    baselineProduct: 'browserpaw',
    candidateProduct: 'browserpaw',
    familySuccess: pairedFamilySuccess(selection.baseline, selection.candidate, suite),
  };
}

export function buildBrowserpawBuildReport(records, suite, options = {}) {
  const baselineBuild = options.baselineBuild;
  const candidateBuild = options.candidateBuild;
  validatedBuildSelectors(baselineBuild, candidateBuild);
  const selection = browserpawBuildSelection(records, baselineBuild, candidateBuild);
  const selected = [...selection.baseline, ...selection.candidate];
  const taskById = new Map((suite.tasks || []).map((task) => [task.inputId, task]));
  const normalizedSelected = selected.map((record) => ({
    ...record,
    inputFamily: taskById.get(record.inputId)?.family,
  }));
  const comparisonRecords = selection.comparisonRecords.map((record) => ({
    ...record,
    inputFamily: taskById.get(record.inputId)?.family,
  }));
  const recordErrors = [];
  for (let index = 0; index < normalizedSelected.length; index += 1) {
    const errors = validateRecord(normalizedSelected[index], suite, taskById);
    for (const error of errors) recordErrors.push(`record ${index}: ${error}`);
  }
  const quality =
    recordErrors.length === 0
      ? qualityIssues(comparisonRecords)
      : { issues: [], tokenizers: [], measuredN: 0 };
  const comparison =
    recordErrors.length === 0
      ? compareBrowserpawBuilds(records, suite, baselineBuild, candidateBuild)
      : null;
  const candidateRecords = normalizedSelected.filter((record) => record.build === candidateBuild);
  const candidateFamilies = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      new Set(
        candidateRecords
          .filter((record) => record.inputFamily === family)
          .map((record) => record.inputId),
      ).size,
    ]),
  );
  const candidateBatches = unique(candidateRecords.map((record) => record.batch));
  const candidateSuccess = candidateRecords.filter((record) => record.outcome === 'success').length;
  const candidateSuccessRate = candidateRecords.length
    ? candidateSuccess / candidateRecords.length
    : null;
  const seriousFailures =
    candidateRecords.length > 0 &&
    candidateRecords.every((record) => Array.isArray(record.seriousFailures))
      ? candidateRecords.reduce((total, record) => total + record.seriousFailures.length, 0)
      : null;
  const candidateOutcomes = Object.fromEntries(
    OUTCOMES.map((outcome) => [
      outcome,
      candidateRecords.filter((record) => record.outcome === outcome).length,
    ]),
  );
  const browserpawBuildCounts = {};
  for (const record of records) {
    if (record?.kind !== 'agent_e2e' || record.product !== 'browserpaw') continue;
    browserpawBuildCounts[record.build] = (browserpawBuildCounts[record.build] || 0) + 1;
  }
  const thresholds = thresholdsFor(suite);
  const suiteErrors = validateSuite(suite);
  const noSample = selection.baseline.length === 0 || selection.candidate.length === 0;
  const gates = {
    suite: suiteErrors.length === 0,
    records: recordErrors.length === 0,
    actualUsage:
      quality.measuredN > 0 &&
      !quality.issues.some((issue) => issue.includes('actual input/output tokens')),
    conditions: !quality.issues.some((issue) => issue.includes('conditions')),
    agentCalls:
      normalizedSelected.length > 0 &&
      normalizedSelected.every((record) => verifiedAgentToolCallCount(record) !== null),
    sample:
      candidateBatches.length >= thresholds.minBatches &&
      FAMILIES.every((family) => candidateFamilies[family] >= thresholds.minFamilyTrials),
    pairedSample: comparison?.gates.sample ?? false,
    successRate: candidateSuccessRate !== null && candidateSuccessRate >= thresholds.successRate,
    seriousFailures: seriousFailures !== null && seriousFailures <= thresholds.seriousFailures,
    familySuccessNonRegression: comparison?.familySuccess.nonRegression ?? false,
    wallTime: comparison?.gates.wallTime ?? false,
    inputTokens: comparison?.gates.inputTokens ?? false,
    p95NonRegression: comparison?.gates.p95NonRegression ?? false,
  };
  const reasons = [];
  if (noSample) reasons.push('no records match both selected BrowserPaw builds');
  if (suiteErrors.length > 0) reasons.push('suite validation failed');
  if (recordErrors.length > 0) reasons.push('record validation failed');
  if (quality.issues.length > 0) reasons.push(...quality.issues);
  if (!gates.actualUsage) reasons.push('actual usage is missing or unverified');
  if (!gates.agentCalls) reasons.push('Agent tool-call count is missing or unverified');
  if (candidateBatches.length < thresholds.minBatches) {
    reasons.push(`candidate build covers fewer than ${thresholds.minBatches} batches`);
  }
  if (FAMILIES.some((family) => candidateFamilies[family] < thresholds.minFamilyTrials)) {
    reasons.push(`candidate build coverage is below ${thresholds.minFamilyTrials} per family`);
  }
  if (!gates.successRate) {
    reasons.push(`candidate build success rate is below ${thresholds.successRate * 100}%`);
  }
  if (seriousFailures === null) {
    reasons.push('candidate build seriousFailures count is unavailable');
  } else if (!gates.seriousFailures) {
    reasons.push('candidate build has serious failures');
  }
  if (!gates.familySuccessNonRegression) {
    reasons.push(
      'candidate build family success rate non-regression is not verified or is below the baseline build',
    );
  }
  if (!comparison) {
    reasons.push(
      'BrowserPaw build comparison is unavailable because selected records failed validation',
    );
  } else if (!gates.pairedSample) {
    reasons.push(
      `BrowserPaw build comparison has fewer than ${thresholds.minFamilyTrials} successful pairs per family`,
    );
  }
  if (comparison && !gates.wallTime) {
    reasons.push('BrowserPaw build wall-time reduction gate failed');
  }
  if (comparison && !gates.inputTokens) {
    reasons.push('BrowserPaw build Codex input-token reduction gate failed');
  }
  if (comparison && !gates.p95NonRegression) {
    reasons.push('BrowserPaw build P95 non-regression gate failed');
  }

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'browserpaw-builds',
    product: 'browserpaw',
    baselineBuild,
    candidateBuild,
    input: {
      recordsPath: options.recordsPath ? path.resolve(options.recordsPath) : null,
      recordsSha256: options.recordsSha256 || null,
      recordCount: selected.length,
      totalRecordCount: records.length,
      ignoredRecordCount: records.length - selected.length,
      browserpawBuildCounts,
    },
    acceptance: {
      accepted: reasons.length === 0,
      reasons: unique(reasons),
    },
    gates,
    candidateCoverage: {
      product: 'browserpaw',
      build: candidateBuild,
      n: candidateRecords.length,
      families: candidateFamilies,
      batches: candidateBatches,
      success: candidateSuccess,
      successRate: candidateSuccessRate,
      seriousFailures,
      outcomes: candidateOutcomes,
    },
    comparison,
    suite: {
      version: suite.version,
      taskCount: suite.tasks?.length || 0,
      errors: suiteErrors,
    },
    validation: {
      recordErrors,
      qualityIssues: quality.issues,
    },
    thresholds,
  };
}

export function buildReport(records, suite, options = {}) {
  const suiteErrors = validateSuite(suite);
  const taskById = new Map((suite.tasks || []).map((task) => [task.inputId, task]));
  const normalized = records.map((record) => {
    const candidate = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    return {
      ...candidate,
      inputFamily: taskById.get(candidate.inputId)?.family,
    };
  });
  const recordValidation = normalized.map((record) => validateRecord(record, suite, taskById));
  const recordErrors = [];
  for (let index = 0; index < normalized.length; index += 1) {
    for (const error of recordValidation[index]) recordErrors.push(`record ${index}: ${error}`);
  }
  const analyzed = normalized.filter((_record, index) => recordValidation[index].length === 0);
  const quality = qualityIssues(analyzed);
  const orderIssues = productOrderIssues(analyzed, suite);
  const agentRecords = analyzed.filter((record) => record.kind === 'agent_e2e');
  const products = Object.fromEntries(
    (suite.products || []).map((product) => [
      product.id,
      summarizeProduct(
        analyzed,
        product.id,
        normalized.filter(
          (record, index) => record.product === product.id && recordValidation[index].length > 0,
        ).length,
      ),
    ]),
  );
  const candidate = suite.comparison?.candidateProduct;
  const candidateRecords = agentRecords.filter((record) => record.product === candidate);
  const invalidCandidateRecords = normalized.filter(
    (record, index) => record.product === candidate && recordValidation[index].length > 0,
  ).length;
  const candidateFamilies = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      new Set(
        candidateRecords
          .filter((record) => record.inputFamily === family)
          .map((record) => record.inputId),
      ).size,
    ]),
  );
  const candidateBatches = unique(candidateRecords.map((record) => record.batch));
  const candidateSuccess = candidateRecords.filter((record) => record.outcome === 'success').length;
  const candidateSuccessRate = candidateRecords.length
    ? candidateSuccess / candidateRecords.length
    : null;
  const comparisons = (suite.comparison?.baselineProducts || []).map((baseline) =>
    compareProducts(analyzed, suite, baseline, candidate),
  );
  const skillReuse = compareSkillReuse(analyzed, suite, candidate);
  const agentCallCountsVerified =
    recordErrors.length === 0 &&
    normalized.some((record) => record.kind === 'agent_e2e') &&
    normalized
      .filter((record) => record.kind === 'agent_e2e')
      .every((record) => verifiedAgentToolCallCount(record) !== null);
  const reasons = [];
  const thresholds = thresholdsFor(suite);
  if (suiteErrors.length > 0) reasons.push('suite validation failed');
  if (normalized.length === 0) reasons.push('empty records sample');
  if (recordErrors.length > 0) reasons.push('record validation failed');
  if (quality.issues.length > 0) reasons.push(...quality.issues);
  if (orderIssues.length > 0) reasons.push(...orderIssues);
  if (!agentCallCountsVerified) reasons.push('Agent tool-call count is missing or unverified');
  if (FAMILIES.some((family) => candidateFamilies[family] < thresholds.minFamilyTrials)) {
    reasons.push(`candidate agent_e2e coverage is below ${thresholds.minFamilyTrials} per family`);
  }
  if (candidateBatches.length < thresholds.minBatches) {
    reasons.push(`candidate records cover fewer than ${thresholds.minBatches} batches`);
  }
  if (candidateSuccessRate === null || candidateSuccessRate < thresholds.successRate) {
    reasons.push(`candidate success rate is below ${thresholds.successRate * 100}%`);
  }
  if (products[candidate]?.seriousFailures === null) {
    reasons.push('candidate seriousFailures count is unavailable');
  } else if (products[candidate]?.seriousFailures > thresholds.seriousFailures) {
    reasons.push('candidate has serious failures');
  }
  for (const comparison of comparisons) {
    if (!comparison.gates.sample) {
      reasons.push(
        `${comparison.baselineProduct} comparison has fewer than ${thresholds.minFamilyTrials} successful pairs`,
      );
    }
    if (!comparison.gates.wallTime) {
      reasons.push(`${comparison.baselineProduct} wall-time reduction gate failed`);
    }
    if (!comparison.gates.inputTokens) {
      reasons.push(`${comparison.baselineProduct} Codex input-token reduction gate failed`);
    }
    if (!comparison.gates.p95NonRegression) {
      reasons.push(`${comparison.baselineProduct} P95 non-regression gate failed`);
    }
  }
  if (!skillReuse.gates.sample) {
    reasons.push('candidate skill reuse pairs are incomplete or condition-mismatched');
  }
  if (!skillReuse.gates.agentToolCalls) {
    reasons.push('candidate skill reuse Agent tool-call reduction gate failed');
  }

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    suite: {
      version: suite.version,
      taskCount: suite.tasks?.length || 0,
      familyCounts: Object.fromEntries(
        FAMILIES.map((family) => [
          family,
          (suite.tasks || []).filter((task) => task.family === family).length,
        ]),
      ),
      batches: suite.batches || [],
      errors: suiteErrors,
    },
    input: {
      recordsPath: options.recordsPath ? path.resolve(options.recordsPath) : null,
      recordsSha256: options.recordsSha256 || null,
      recordCount: normalized.length,
      tokenizers: quality.tokenizers,
    },
    acceptance: {
      accepted: reasons.length === 0,
      reasons: unique(reasons),
    },
    gates: {
      suite: suiteErrors.length === 0,
      records: recordErrors.length === 0,
      actualUsage:
        recordErrors.length === 0 &&
        quality.measuredN > 0 &&
        !quality.issues.some((issue) => issue.includes('actual input/output tokens')),
      modelConditions:
        recordErrors.length === 0 && !quality.issues.some((issue) => issue.includes('conditions')),
      productOrder: recordErrors.length === 0 && orderIssues.length === 0,
      agentCalls: agentCallCountsVerified,
      sample:
        recordErrors.length === 0 &&
        candidateBatches.length >= thresholds.minBatches &&
        FAMILIES.every((family) => candidateFamilies[family] >= thresholds.minFamilyTrials),
      successRate:
        recordErrors.length === 0 &&
        candidateSuccessRate !== null &&
        candidateSuccessRate >= thresholds.successRate,
      seriousFailures:
        recordErrors.length === 0 &&
        products[candidate]?.seriousFailures !== null &&
        products[candidate]?.seriousFailures !== undefined &&
        products[candidate].seriousFailures <= thresholds.seriousFailures,
      skillReuseSample: recordErrors.length === 0 && skillReuse.gates.sample,
      skillReuseReduction: recordErrors.length === 0 && skillReuse.gates.agentToolCalls,
      skillReuse:
        recordErrors.length === 0 && skillReuse.gates.sample && skillReuse.gates.agentToolCalls,
      efficiency:
        recordErrors.length === 0 &&
        comparisons.every(
          (comparison) =>
            comparison.gates.sample &&
            comparison.gates.wallTime &&
            comparison.gates.inputTokens &&
            comparison.gates.p95NonRegression,
        ) &&
        skillReuse.gates.sample &&
        skillReuse.gates.agentToolCalls,
    },
    candidateCoverage: {
      product: candidate,
      n: candidateRecords.length,
      invalid: invalidCandidateRecords,
      families: candidateFamilies,
      batches: candidateBatches,
      success: candidateSuccess,
      successRate: candidateSuccessRate,
    },
    products,
    comparisons,
    skillReuse,
    validation: {
      recordErrors,
      qualityIssues: quality.issues,
      orderIssues,
    },
    thresholds,
  };
}

function formatImageInput(tokenStats) {
  const images = tokenStats.imageInputs;
  if (images.includesImageInput) {
    return `pairedBackendImageInput=baseline:${images.baseline}/candidate:${images.candidate}; Agent input is not split by modality; not text-only`;
  }
  if (images.countsComplete)
    return 'pairedBackendImageInput=0; model-input modality is not established';
  return 'pairedBackendImageInput=unknown; model-input modality is not established';
}

export function formatReportText(report) {
  const lines = [];
  if (report.mode === 'browserpaw-builds') {
    lines.push(`BrowserPaw build eval: ${report.acceptance.accepted ? 'PASS' : 'NOT ACCEPTED'}`);
    lines.push(
      `Product: ${report.product}; baseline: ${report.baselineBuild}; candidate: ${report.candidateBuild}; records: ${report.comparison.baselineRecordCount}+${report.comparison.candidateRecordCount}; ignored: ${report.input.ignoredRecordCount}`,
    );
    lines.push(
      `Candidate: n=${report.candidateCoverage.n}; success=${report.candidateCoverage.successRate === null ? 'n/a' : `${(report.candidateCoverage.successRate * 100).toFixed(1)}%`}; seriousFailures=${report.candidateCoverage.seriousFailures ?? 'n/a'}`,
    );
    lines.push(
      report.comparison
        ? `Pairs: ${report.comparison.pairedN}; actualInputPairs=${report.comparison.actualInputPairs}/${report.comparison.pairedN}; wallReduction=${report.comparison.wallMs.pairedMedianReduction === null ? 'n/a' : `${(report.comparison.wallMs.pairedMedianReduction * 100).toFixed(1)}%`}; inputReduction=${report.comparison.actualInputTokens.pairedMedianReduction === null ? 'n/a' : `${(report.comparison.actualInputTokens.pairedMedianReduction * 100).toFixed(1)}%`}; wallP95=${report.comparison.wallMs.candidateP95 ?? 'n/a'}; inputP95=${report.comparison.actualInputTokens.candidateP95 ?? 'n/a'}; ${formatImageInput(report.comparison.actualInputTokens)}`
        : 'Pairs: n/a; selected records failed validation',
    );
    if (report.acceptance.reasons.length > 0) {
      lines.push(`Reasons: ${report.acceptance.reasons.join('; ')}`);
    }
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Browser eval: ${report.acceptance.accepted ? 'PASS' : 'NOT ACCEPTED'}`);
  lines.push(
    `Records: ${report.input.recordCount}; candidate: ${report.candidateCoverage.n}; success: ${
      report.candidateCoverage.successRate === null
        ? 'n/a'
        : `${(report.candidateCoverage.successRate * 100).toFixed(1)}%`
    }`,
  );
  for (const [product, stats] of Object.entries(report.products)) {
    lines.push(
      `${product}: n=${stats.n}, success=${stats.success}, partial=${stats.partial}, blocked=${stats.blocked}, failure=${stats.failure}, wallP95=${stats.wallMs.p95 ?? 'n/a'}, estimatedTokensP95=${
        stats.estimatedTextTokens.p95 ?? 'n/a'
      }, actualInputTokensP95=${stats.actualInputTokens.p95 ?? 'n/a'}, imageInput=${stats.images.input}, agentCallsP50=${
        stats.agentToolCalls.median ?? 'n/a'
      }, backendRoundTripsP50=${stats.roundTrips.median ?? 'n/a'}`,
    );
  }
  for (const comparison of report.comparisons) {
    lines.push(
      `${comparison.candidateProduct} vs ${comparison.baselineProduct}: pairs=${comparison.pairedN}, actualInputPairs=${comparison.actualInputPairs}, wallReduction=${
        comparison.wallMs.pairedMedianReduction === null
          ? 'n/a'
          : `${(comparison.wallMs.pairedMedianReduction * 100).toFixed(1)}%`
      }, inputReduction=${
        comparison.actualInputTokens.pairedMedianReduction === null
          ? 'n/a'
          : `${(comparison.actualInputTokens.pairedMedianReduction * 100).toFixed(1)}%`
      }, ${formatImageInput(comparison.actualInputTokens)}`,
    );
  }
  lines.push(
    `${report.skillReuse.product} skill reuse: pairs=${report.skillReuse.n}/${report.skillReuse.expectedPairs}, agentToolCallReduction=${
      report.skillReuse.pairedMedianReduction === null
        ? 'n/a'
        : `${(report.skillReuse.pairedMedianReduction * 100).toFixed(1)}%`
    }`,
  );
  if (report.acceptance.reasons.length > 0) {
    lines.push(`Reasons: ${report.acceptance.reasons.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runEvaluation(options) {
  if (!options?.recordsPath) throw new Error('--records <records.json|jsonl> is required');
  const hasBaselineBuild = options.baselineBuild !== undefined;
  const hasCandidateBuild = options.candidateBuild !== undefined;
  if (hasBaselineBuild !== hasCandidateBuild) {
    throw new Error('--baseline-build and --candidate-build must be provided together');
  }
  if (hasBaselineBuild && options.baselineBuild === options.candidateBuild) {
    throw new Error('--baseline-build and --candidate-build must be different');
  }
  const suiteFile = options.suitePath || DEFAULT_SUITE_PATH;
  const { suite, errors } = loadSuite(suiteFile);
  const loaded = loadRecords(options.recordsPath);
  const reportOptions = {
    recordsPath: loaded.filePath,
    recordsSha256: loaded.sha256,
  };
  const report = hasBaselineBuild
    ? buildBrowserpawBuildReport(loaded.records, suite, {
        ...reportOptions,
        baselineBuild: options.baselineBuild,
        candidateBuild: options.candidateBuild,
      })
    : buildReport(loaded.records, suite, reportOptions);
  if (errors.length > 0) report.suite.errors = unique([...report.suite.errors, ...errors]);
  if (options.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--records') options.recordsPath = argv[++index];
    else if (arg === '--suite') options.suitePath = argv[++index];
    else if (arg === '--out') options.outPath = argv[++index];
    else if (arg === '--baseline-build') options.baselineBuild = argv[++index];
    else if (arg === '--candidate-build') options.candidateBuild = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runEvaluation(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReportText(report),
    );
    if (!report.acceptance.accepted) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(
      'Usage: node scripts/browser-eval.mjs --records <records.json|jsonl> [--suite file] [--out report.json] [--json] [--baseline-build id --candidate-build id]\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
