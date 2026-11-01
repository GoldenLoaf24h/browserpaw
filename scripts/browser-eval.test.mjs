import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SUITE_PATH,
  FAMILIES,
  buildBrowserpawBuildReport,
  buildReport,
  compareProducts,
  compareBrowserpawBuilds,
  compareSkillReuse,
  formatReportText,
  loadRecords,
  loadSuite,
  median,
  p95,
  runEvaluation,
  validateRecord,
  validateSuite,
} from './browser-eval.mjs';

const { suite } = loadSuite(DEFAULT_SUITE_PATH);
const reuseTasks = suite.tasks.filter((task) => task.mode === 'reuse');

let sequence = 0;
function makeRecord(inputId, product, overrides = {}) {
  const task = suite.tasks.find((candidate) => candidate.inputId === inputId);
  assert.ok(task, `missing suite task ${inputId}`);
  const order = sequence++;
  const reuseTask =
    task.mode === 'reuse'
      ? task
      : reuseTasks.find((candidate) => candidate.explorationInputId === task.inputId);
  const defaultAgentToolCalls = product === 'browserpaw' && task.mode === 'reuse' ? 2 : 4;
  const agentToolCalls = Object.hasOwn(overrides, 'agentToolCalls')
    ? overrides.agentToolCalls
    : defaultAgentToolCalls;
  const agentToolCallsProvenance = Object.hasOwn(overrides, 'agentToolCallsProvenance')
    ? overrides.agentToolCallsProvenance
    : {
        source: 'codex-session-jsonl',
        basis: 'unique response_item function_call/custom_tool_call call_id',
        sessionFile: `rollout-${product}-${order}.jsonl`,
        callEvents: agentToolCalls,
        callTypes: { function_call: agentToolCalls, custom_tool_call: 0 },
        uniqueCallIds: agentToolCalls,
      };
  return {
    recordVersion: 1,
    kind: 'agent_e2e',
    product,
    build: `build-${product}`,
    model: 'model-a',
    reasoning: 'high',
    session: `session-${product}-${order}`,
    login: task.requiresLogin ? 'authenticated' : 'anonymous',
    viewport: { width: 1440, height: 900, dpr: 1.5 },
    cache: 'isolated',
    trialId: `trial-${order}`,
    pairId: `pair-${task.inputId}-${task.mode}`,
    ...(reuseTask ? { explorationPairId: `exploration-${reuseTask.inputId}` } : {}),
    batch: task.batch,
    inputId: task.inputId,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, order)).toISOString(),
    mode: task.mode,
    outcome: 'success',
    businessEvidence: {
      summary: `${product} completed ${task.inputId}`,
      sources: [`https://evidence.example/${task.inputId}/${product}`],
    },
    timing: {
      wallMs: product === 'browserpaw' ? 70 : 100,
      toolMs: 20,
      modelMs: 40,
    },
    roundTrips: product === 'browserpaw' ? 2 : 5,
    agentToolCalls,
    agentToolCallsProvenance,
    actualTokens: { input: 100, output: 50 },
    estimatedTextTokens: product === 'browserpaw' ? 60 : 100,
    estimatedInputTokens: product === 'browserpaw' ? 40 : 80,
    tokenizer: 'tokenizer-v1',
    images: { input: product === 'browserpaw' ? 0 : 1, output: 0 },
    seriousFailures: [],
    ...overrides,
  };
}

test('fixed suite has 80 distinct tasks, four families, three rotated batches', () => {
  assert.deepEqual(validateSuite(suite), []);
  assert.equal(suite.tasks.length, 80);
  for (const family of FAMILIES) {
    assert.equal(suite.tasks.filter((task) => task.family === family).length, 20);
  }
  assert.equal(suite.batches.length, 3);
  assert.deepEqual(
    suite.batches.map((batch) => batch.productOrder.join('>')),
    ['browserpaw>ego>aside', 'ego>aside>browserpaw', 'aside>browserpaw>ego'],
  );
});

test('startup failures retain unknown login and zero calls without allowing unverified success', () => {
  const failure = makeRecord('mdn-search-01', 'browserpaw', {
    outcome: 'blocked',
    login: 'unknown',
    viewport: { width: null, height: null, dpr: null },
    roundTrips: 0,
    startupFailure: { stage: 'context', reason: 'Agent context file was unavailable' },
  });
  assert.deepEqual(validateRecord(failure, suite), []);
  assert(validateRecord({ ...failure, outcome: 'success' }, suite).length > 0);
  const missingReason = { ...failure, startupFailure: undefined };
  assert(validateRecord(missingReason, suite).some((error) => error.includes('startup')));
  const xTask = suite.tasks.find((task) => task.requiresLogin);
  const loginBlocked = makeRecord(xTask.inputId, 'browserpaw', {
    outcome: 'blocked',
    login: 'anonymous',
  });
  assert.deepEqual(validateRecord(loginBlocked, suite), []);
  assert(
    validateRecord({ ...loginBlocked, outcome: 'success' }, suite).some((error) =>
      error.includes('authenticated'),
    ),
  );
});

test('every reuse task links one distinct earlier cold exploration input in its family', () => {
  assert.equal(reuseTasks.length, 28);
  const targets = new Set();
  for (const family of FAMILIES) {
    const familyReuse = reuseTasks.filter((task) => task.family === family);
    assert.equal(familyReuse.length, 7);
    for (const task of familyReuse) {
      const target = suite.tasks.find((candidate) => candidate.inputId === task.explorationInputId);
      assert.ok(target, `${task.inputId} needs an exploration target`);
      assert.equal(target.family, task.family);
      assert.equal(target.kind, task.kind);
      assert.equal(target.mode, 'cold');
      assert.notEqual(target.inputId, task.inputId);
      assert.notEqual(target.input, task.input);
      assert.ok(target.batch <= task.batch);
      assert.equal(targets.has(target.inputId), false, 'exploration targets must be one-to-one');
      targets.add(target.inputId);
    }
  }
});

test('suite rejects fake reuse links to recovery, another family, or a reused baseline', () => {
  const recoveryLink = structuredClone(suite);
  recoveryLink.tasks.find((task) => task.inputId === 'mdn-search-02').explorationInputId =
    'mdn-search-03';
  assert.ok(validateSuite(recoveryLink).some((error) => error.includes('must name a cold task')));

  const crossFamilyLink = structuredClone(suite);
  crossFamilyLink.tasks.find((task) => task.inputId === 'mdn-search-02').explorationInputId =
    'github-repo-release-01';
  assert.ok(validateSuite(crossFamilyLink).some((error) => error.includes('same task family')));

  const duplicateBaseline = structuredClone(suite);
  duplicateBaseline.tasks.find((task) => task.inputId === 'mdn-search-05').explorationInputId =
    'mdn-search-01';
  assert.ok(
    validateSuite(duplicateBaseline).some((error) => error.includes('multiple reuse tasks')),
  );
});

test('suite thresholds are the evaluator thresholds rather than dead configuration', () => {
  const configured = structuredClone(suite);
  configured.thresholds.successRate = 0.99;
  assert.deepEqual(validateSuite(configured), []);
  const report = buildReport([], configured);
  assert.equal(report.thresholds.successRate, 0.99);
  configured.thresholds.wallTimeReduction = 2;
  assert.ok(validateSuite(configured).some((error) => error.includes('thresholds')));
});

test('suite below 20 family inputs or three batches is rejected', () => {
  const shortSuite = structuredClone(suite);
  shortSuite.batches = shortSuite.batches.filter((batch) => batch.batch !== 3);
  shortSuite.tasks = shortSuite.tasks.filter(
    (task) => task.batch !== 3 && task.inputId !== 'mdn-search-20',
  );
  const errors = validateSuite(shortSuite);
  assert.ok(errors.some((error) => error.includes('at least 3 batches')));
  assert.ok(errors.some((error) => error.includes('mdn_search requires at least 20')));
});

test('percentile helpers are deterministic and do not shift p95 downward', () => {
  const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(median(values), 550);
  assert.equal(p95(values), 955);
  assert.equal(median([]), null);
  assert.equal(p95([]), null);
});

test('parallel work has a bounded elapsed tool interval, even when summed work exceeds wall time', () => {
  const parallel = makeRecord('mdn-search-01', 'browserpaw', {
    timing: { wallMs: 100, toolMs: 140, toolWallMs: 80, modelMs: null, unattributedMs: 20 },
  });
  assert.deepEqual(validateRecord(parallel, suite), []);
  for (const timing of [
    { ...parallel.timing, toolWallMs: -1 },
    { ...parallel.timing, toolWallMs: 101 },
    { ...parallel.timing, toolMs: 40 },
  ]) {
    assert.ok(
      validateRecord({ ...parallel, timing }, suite).some((error) => error.includes('toolWallMs')),
    );
  }
  const report = buildReport([parallel], suite);
  assert.deepEqual(report.products.browserpaw.toolWallMs, { n: 1, median: 80, p95: 80 });
});

test('missing model timing stays unknown and is excluded from timing statistics', () => {
  const record = makeRecord('mdn-search-01', 'browserpaw', {
    timing: { wallMs: 90, toolMs: 30, modelMs: null, unattributedMs: 60 },
  });
  assert.deepEqual(validateRecord(record, suite), []);
  const report = buildReport([record], suite);
  assert.deepEqual(report.products.browserpaw.modelMs, { n: 0, median: null, p95: null });
});

test('empty records sample is not accepted and creates no fake measurements', () => {
  const report = buildReport([], suite);
  assert.equal(report.input.recordCount, 0);
  assert.equal(report.acceptance.accepted, false);
  assert.ok(report.acceptance.reasons.includes('empty records sample'));
  assert.equal(report.candidateCoverage.successRate, null);
  assert.equal(report.gates.actualUsage, false);
  assert.equal(Object.hasOwn(report.gates, 'unifiedTokenizer'), false);
});

test('missing provider usage blocks acceptance without inventing tokens', () => {
  const record = makeRecord('mdn-search-01', 'browserpaw', {
    actualTokens: { input: null, output: null },
  });
  const report = buildReport([record], suite);
  assert.equal(report.gates.actualUsage, false);
  assert.equal(report.products.browserpaw.actualTokens.n, 0);
  assert.ok(
    report.acceptance.reasons.some((reason) => reason.includes('actual input/output tokens')),
  );
});

test('partial is not success and is excluded from speed ranking', () => {
  const baseline = makeRecord('mdn-search-01', 'ego');
  const partial = makeRecord('mdn-search-01', 'browserpaw', {
    outcome: 'partial',
    timing: { wallMs: 1, toolMs: 1, modelMs: 0 },
    estimatedTextTokens: 1,
  });
  const comparison = compareProducts([baseline, partial], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 0);
  assert.equal(comparison.wallMs.reduction, null);
  const report = buildReport([baseline, partial], suite);
  assert.equal(report.products.browserpaw.success, 0);
  assert.equal(report.products.browserpaw.partial, 1);
});

test('candidate success gate passes at 95% and fails below it', () => {
  const tasks = suite.tasks.filter((task) => task.family === 'mdn_search');
  const passing = tasks.map((task, index) =>
    makeRecord(task.inputId, 'browserpaw', {
      trialId: `success-pass-${index}`,
      outcome: index === 0 ? 'failure' : 'success',
    }),
  );
  const passReport = buildReport(passing, suite);
  assert.equal(passReport.candidateCoverage.successRate, 0.95);
  assert.equal(passReport.gates.successRate, true);

  const failing = tasks.map((task, index) =>
    makeRecord(task.inputId, 'browserpaw', {
      trialId: `success-fail-${index}`,
      outcome: index < 2 ? 'failure' : 'success',
    }),
  );
  const failReport = buildReport(failing, suite);
  assert.equal(failReport.candidateCoverage.successRate, 0.9);
  assert.equal(failReport.gates.successRate, false);
});

test('repeated one input cannot satisfy family coverage and login-required tasks reject anonymous records', () => {
  const task = suite.tasks.find((candidate) => candidate.family === 'mdn_search');
  const repeated = Array.from({ length: 20 }, (_, index) =>
    makeRecord(task.inputId, 'browserpaw', { trialId: `repeat-${index}`, outcome: 'success' }),
  );
  const report = buildReport(repeated, suite);
  assert.equal(report.candidateCoverage.families.mdn_search, 1);
  assert.ok(report.acceptance.reasons.some((reason) => reason.includes('below 20 per family')));

  const xTask = suite.tasks.find((candidate) => candidate.requiresLogin);
  const anonymousX = makeRecord(xTask.inputId, 'browserpaw', { login: 'anonymous' });
  assert.deepEqual(validateRecord(anonymousX, suite), [
    'task requires an authenticated login environment',
  ]);
});

test('model or environment mismatch blocks paired ranking and acceptance', () => {
  const baseline = makeRecord('mdn-search-01', 'ego');
  const candidate = makeRecord('mdn-search-01', 'browserpaw', { model: 'model-b' });
  const report = buildReport([baseline, candidate], suite);
  assert.equal(report.gates.modelConditions, false);
  assert.deepEqual(compareProducts([baseline, candidate], suite, 'ego', 'browserpaw').wallMs, {
    baselineMedian: null,
    candidateMedian: null,
    reduction: null,
    pairedMedianReduction: null,
    baselineP95: null,
    candidateP95: null,
  });
});

test('historical records without DPR remain readable but cannot be paired', () => {
  const historical = makeRecord('mdn-search-01', 'browserpaw');
  delete historical.viewport.dpr;
  assert.deepEqual(validateRecord(historical, suite), []);

  for (const dpr of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.5']) {
    const invalid = makeRecord('mdn-search-01', 'browserpaw', {
      viewport: { width: 1440, height: 900, dpr },
    });
    assert.ok(validateRecord(invalid, suite).some((error) => error.includes('viewport.dpr')));
  }

  const baseline = makeRecord('mdn-search-01', 'ego');
  delete baseline.viewport.dpr;
  const candidate = makeRecord('mdn-search-01', 'browserpaw');
  const report = buildReport([baseline, candidate], suite);
  const comparison = compareProducts([baseline, candidate], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 0);
  assert.equal(comparison.wallMs.pairedMedianReduction, null);
  assert.equal(report.gates.modelConditions, false);
});

test('blocked and failure records may store unobserved viewport but never pair', () => {
  const blocked = makeRecord('mdn-search-01', 'browserpaw', {
    outcome: 'blocked',
    viewport: { width: null, height: null, dpr: null },
  });
  const failure = makeRecord('mdn-search-01', 'browserpaw', {
    outcome: 'failure',
    viewport: { width: 1440, height: null, dpr: null },
  });
  assert.deepEqual(validateRecord(blocked, suite), []);
  assert.deepEqual(validateRecord(failure, suite), []);

  const baseline = makeRecord('mdn-search-01', 'ego');
  const comparison = compareProducts([baseline, blocked], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 0);
  assert.equal(comparison.wallMs.pairedMedianReduction, null);
  const report = buildReport([baseline, blocked], suite);
  assert.equal(report.products.browserpaw.blocked, 1);

  const buildComparisonReport = buildBrowserpawBuildReport(
    [
      makeRecord('mdn-search-01', 'browserpaw', {
        build: 'build-baseline',
        pairId: 'unobserved-viewport-build',
      }),
      makeRecord('mdn-search-01', 'browserpaw', {
        build: 'build-candidate',
        pairId: 'unobserved-viewport-build',
        outcome: 'blocked',
        viewport: { width: null, height: null, dpr: null },
      }),
    ],
    suite,
    { baselineBuild: 'build-baseline', candidateBuild: 'build-candidate' },
  );
  assert.equal(buildComparisonReport.comparison.pairedN, 0);
  assert.equal(buildComparisonReport.candidateCoverage.outcomes.blocked, 1);

  for (const viewport of [
    { width: 0, height: null, dpr: null },
    { width: null, height: -1, dpr: null },
    { width: null, height: null, dpr: Number.NaN },
    { width: null, height: null, dpr: Number.POSITIVE_INFINITY },
  ]) {
    const invalid = makeRecord('mdn-search-01', 'browserpaw', {
      outcome: 'blocked',
      viewport,
    });
    assert.ok(validateRecord(invalid, suite).some((error) => error.includes('viewport')));
  }

  assert.ok(
    validateRecord(
      makeRecord('mdn-search-01', 'browserpaw', {
        viewport: { width: null, height: null, dpr: null },
      }),
      suite,
    ).some((error) => error.includes('viewport')),
  );
  assert.ok(
    validateRecord(
      makeRecord('mdn-search-01', 'browserpaw', {
        outcome: 'partial',
        viewport: { width: null, height: null, dpr: null },
      }),
      suite,
    ).some((error) => error.includes('viewport')),
  );
});

test('DPR must match within 1e-6 and DPR 1 never pairs with 1.5', () => {
  const baseline = makeRecord('mdn-search-01', 'ego', {
    viewport: { width: 1440, height: 900, dpr: 1 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    viewport: { width: 1440, height: 900, dpr: 1.5 },
  });
  const mismatch = compareProducts([baseline, candidate], suite, 'ego', 'browserpaw');
  assert.equal(mismatch.pairedN, 0);
  assert.equal(mismatch.wallMs.pairedMedianReduction, null);
  assert.equal(mismatch.actualInputTokens.pairedMedianReduction, null);

  const measuredBaseline = makeRecord('mdn-search-01', 'ego', {
    viewport: { width: 1440, height: 900, dpr: 1.0000000029 },
  });
  const measuredCandidate = makeRecord('mdn-search-01', 'browserpaw', {
    viewport: { width: 1440, height: 900, dpr: 1 },
  });
  const tolerant = compareProducts(
    [measuredBaseline, measuredCandidate],
    suite,
    'ego',
    'browserpaw',
  );
  assert.equal(tolerant.pairedN, 1);
  assert.equal(tolerant.wallMs.pairedMedianReduction, 0.3);

  const widthMismatch = compareProducts(
    [
      makeRecord('mdn-search-01', 'ego', {
        viewport: { width: 1440, height: 900, dpr: 1.5 },
      }),
      makeRecord('mdn-search-01', 'browserpaw', {
        viewport: { width: 1441, height: 900, dpr: 1.5 },
      }),
    ],
    suite,
    'ego',
    'browserpaw',
  );
  assert.equal(widthMismatch.pairedN, 0);
});

test('cold and reuse records require equal viewport width, height, and DPR', () => {
  const reuseTask = suite.tasks.find((task) => task.mode === 'reuse');
  const cold = makeRecord(reuseTask.explorationInputId, 'browserpaw', {
    viewport: { width: 1440, height: 900, dpr: 1 },
  });
  const reuseMismatch = makeRecord(reuseTask.inputId, 'browserpaw', {
    explorationPairId: cold.explorationPairId,
    viewport: { width: 1440, height: 900, dpr: 1.5 },
    startedAt: new Date(Date.parse(cold.startedAt) + 1000).toISOString(),
  });
  const mismatch = compareSkillReuse([cold, reuseMismatch], suite, 'browserpaw');
  assert.equal(mismatch.n, 0);
  assert.equal(mismatch.gates.sample, false);
  assert.ok(
    mismatch.issues.some((issue) => issue.includes('changes product/build/model/environment')),
  );

  const reuseTolerant = makeRecord(reuseTask.inputId, 'browserpaw', {
    explorationPairId: cold.explorationPairId,
    viewport: { width: 1440, height: 900, dpr: 1.0000000029 },
    startedAt: new Date(Date.parse(cold.startedAt) + 1000).toISOString(),
  });
  assert.equal(compareSkillReuse([cold, reuseTolerant], suite, 'browserpaw').n, 1);
});

test('known mid-trial condition changes cannot be hidden by matching final viewport values', () => {
  const baseline = makeRecord('mdn-search-01', 'ego', {
    conditionIssues: ['Viewport changed to 1116x751 during the task'],
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw');
  assert.deepEqual(validateRecord(baseline, suite), []);
  assert.equal(compareProducts([baseline, candidate], suite, 'ego', 'browserpaw').pairedN, 0);
  const report = buildReport([baseline, candidate], suite);
  assert.equal(report.gates.modelConditions, false);
  assert.ok(report.acceptance.reasons.some((reason) => reason.includes('Viewport changed')));

  const task = suite.tasks.find((item) => item.mode === 'reuse');
  const cold = makeRecord(task.explorationInputId, 'browserpaw');
  const reuse = makeRecord(task.inputId, 'browserpaw', {
    explorationPairId: cold.explorationPairId,
    startedAt: new Date(Date.parse(cold.startedAt) + 1000).toISOString(),
    conditionIssues: ['Skill opened a page at another device pixel ratio'],
  });
  assert.equal(compareSkillReuse([cold, reuse], suite, 'browserpaw').n, 0);
});

test('condition issues must be explicit nonempty strings', () => {
  for (const conditionIssues of [false, 'changed', [null], ['']]) {
    const record = makeRecord('mdn-search-01', 'browserpaw', { conditionIssues });
    assert.ok(validateRecord(record, suite).some((error) => error.includes('conditionIssues')));
  }
});

test('paired thresholds pass at 20% time, 30% Codex input tokens, and 50% skill-reuse call gains', () => {
  const records = [];
  for (const task of suite.tasks) {
    const pairId = `threshold-pass-${task.inputId}`;
    records.push(
      makeRecord(task.inputId, 'ego', {
        pairId,
        trialId: `pass-ego-${task.inputId}`,
        timing: { wallMs: 100, toolMs: 10, modelMs: 20 },
        actualTokens: { input: 100, output: 50 },
        estimatedTextTokens: 100,
        estimatedInputTokens: 100,
        images: { input: 0, output: 0 },
        roundTrips: 4,
      }),
      makeRecord(task.inputId, 'browserpaw', {
        pairId,
        trialId: `pass-paw-${task.inputId}`,
        timing: { wallMs: 80, toolMs: 10, modelMs: 20 },
        actualTokens: { input: 70, output: 50 },
        estimatedTextTokens: 100,
        estimatedInputTokens: 100,
        images: { input: 0, output: 0 },
        roundTrips: 2,
      }),
    );
  }
  const comparison = compareProducts(records, suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 80);
  assert.equal(comparison.actualInputPairs, 80);
  assert.deepEqual(comparison.pairedFamilies, {
    github_repo_release: 20,
    mdn_search: 20,
    npm_compare: 20,
    x_search_thread: 20,
  });
  assert.deepEqual(comparison.gates, {
    sample: true,
    wallTime: true,
    inputTokens: true,
    p95NonRegression: true,
  });
  const skillReuse = compareSkillReuse(records, suite, 'browserpaw');
  assert.equal(skillReuse.n, 28);
  assert.equal(skillReuse.pairedMedianReduction, 0.5);
  assert.deepEqual(skillReuse.gates, { sample: true, agentToolCalls: true });
});

test('estimated-only token reduction cannot pass when Codex actual input is unchanged', () => {
  const pairId = 'actual-input-unchanged';
  const baseline = makeRecord('mdn-search-01', 'ego', {
    pairId,
    actualTokens: { input: 1000, output: 50 },
    estimatedTextTokens: 100,
    estimatedInputTokens: 100,
    images: { input: 0, output: 0 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    pairId,
    actualTokens: { input: 1000, output: 50 },
    estimatedTextTokens: 70,
    estimatedInputTokens: 70,
    images: { input: 0, output: 0 },
  });

  const comparison = compareProducts([baseline, candidate], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 1);
  assert.equal(comparison.actualInputPairs, 1);
  assert.equal(comparison.actualInputTokens.pairedMedianReduction, 0);
  assert.equal(comparison.gates.inputTokens, false);
});

test('Codex actual input reduction passes even when backend text estimates do not fall', () => {
  const pairId = 'actual-input-reduced';
  const baseline = makeRecord('mdn-search-01', 'ego', {
    pairId,
    actualTokens: { input: 100, output: 50 },
    estimatedTextTokens: 100,
    estimatedInputTokens: 100,
    images: { input: 0, output: 0 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    pairId,
    actualTokens: { input: 70, output: 50 },
    estimatedTextTokens: 100,
    estimatedInputTokens: 100,
    images: { input: 0, output: 0 },
  });

  const comparison = compareProducts([baseline, candidate], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 1);
  assert.equal(comparison.actualInputPairs, 1);
  assert.equal(comparison.actualInputTokens.pairedMedianReduction, 0.3);
  assert.equal(comparison.gates.inputTokens, true);
});

test('missing Codex actual input cannot fall back to estimates or pass', () => {
  const pairId = 'actual-input-missing';
  const baseline = makeRecord('mdn-search-01', 'ego', {
    pairId,
    actualTokens: { input: 100, output: 50 },
    estimatedInputTokens: 100,
    images: { input: 0, output: 0 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    pairId,
    actualTokens: { input: null, output: 50 },
    estimatedInputTokens: 70,
    images: { input: 0, output: 0 },
  });

  const comparison = compareProducts([baseline, candidate], suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 1);
  assert.equal(comparison.actualInputPairs, 0);
  assert.equal(comparison.actualInputTokens.pairedMedianReduction, null);
  assert.equal(comparison.gates.inputTokens, false);
});

test('partial actual-input coverage cannot report an input-token pass', () => {
  const records = [];
  for (const inputId of ['mdn-search-01', 'mdn-search-02']) {
    const pairId = `actual-input-coverage-${inputId}`;
    records.push(
      makeRecord(inputId, 'ego', {
        pairId,
        actualTokens: { input: 100, output: 50 },
        images: { input: 0, output: 0 },
      }),
      makeRecord(inputId, 'browserpaw', {
        pairId,
        actualTokens:
          inputId === 'mdn-search-02' ? { input: null, output: 50 } : { input: 70, output: 50 },
        images: { input: 0, output: 0 },
      }),
    );
  }

  const comparison = compareProducts(records, suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 2);
  assert.equal(comparison.actualInputPairs, 1);
  assert.equal(comparison.actualInputTokens.pairedMedianReduction, 0.3);
  assert.equal(comparison.actualInputTokens.imageInputs.countsComplete, false);
  assert.equal(comparison.gates.inputTokens, false);
});

test('image-bearing Agent input is reported as not text-only', () => {
  const pairId = 'actual-input-images';
  const baseline = makeRecord('mdn-search-01', 'ego', {
    pairId,
    actualTokens: { input: 100, output: 50 },
    images: { input: 2, output: 0 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    pairId,
    actualTokens: { input: 70, output: 50 },
    images: { input: 1, output: 0 },
  });

  const report = buildReport([baseline, candidate], suite);
  const comparison = report.comparisons.find(
    (candidateComparison) => candidateComparison.baselineProduct === 'ego',
  );
  assert.deepEqual(comparison.actualInputTokens.imageInputs, {
    baseline: 2,
    candidate: 1,
    countsComplete: true,
    includesImageInput: true,
  });
  assert.match(formatReportText(report), /Agent input is not split by modality; not text-only/);
});

test('zero backend image blocks do not establish image-free Agent input', () => {
  const records = ['ego', 'browserpaw'].map((product) =>
    makeRecord('mdn-search-01', product, { images: { input: 0, output: 0 } }),
  );
  const report = buildReport(records, suite);
  const comparison = report.comparisons.find((item) => item.baselineProduct === 'ego');
  assert.equal(comparison.actualInputTokens.imageInputs.imageFree, undefined);
  assert.match(formatReportText(report), /model-input modality is not established/);
  assert.doesNotMatch(formatReportText(report), /image-free text cohort/);
});

test('BrowserPaw build comparison uses exact builds without mutating product records', () => {
  const baseline = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-baseline',
    pairId: 'browserpaw-build-pair',
    timing: { wallMs: 100, toolMs: 20, modelMs: 40 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-candidate',
    pairId: 'browserpaw-build-pair',
  });
  const ignored = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-other',
    pairId: 'browserpaw-build-pair',
  });
  const comparison = compareBrowserpawBuilds(
    [baseline, candidate, ignored],
    suite,
    'build-baseline',
    'build-candidate',
  );
  assert.equal(comparison.mode, 'browserpaw-builds');
  assert.equal(comparison.product, 'browserpaw');
  assert.equal(comparison.baselineBuild, 'build-baseline');
  assert.equal(comparison.candidateBuild, 'build-candidate');
  assert.equal(comparison.baselineRecordCount, 1);
  assert.equal(comparison.candidateRecordCount, 1);
  assert.equal(comparison.ignoredRecordCount, 1);
  assert.equal(comparison.pairedN, 1);
  assert.equal(comparison.wallMs.pairedMedianReduction, 0.3);
  assert.equal(baseline.product, 'browserpaw');
  assert.equal(baseline.build, 'build-baseline');
  assert.equal(candidate.product, 'browserpaw');
  assert.equal(candidate.build, 'build-candidate');
});

test('BrowserPaw build comparison applies viewport DPR pairing conditions', () => {
  const baseline = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-baseline',
    pairId: 'browserpaw-build-dpr',
    viewport: { width: 1440, height: 900, dpr: 1 },
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-candidate',
    pairId: 'browserpaw-build-dpr',
    viewport: { width: 1440, height: 900, dpr: 1.5 },
  });
  const comparison = compareBrowserpawBuilds(
    [baseline, candidate],
    suite,
    'build-baseline',
    'build-candidate',
  );
  assert.equal(comparison.pairedN, 0);
  assert.equal(comparison.wallMs.pairedMedianReduction, null);
  assert.equal(comparison.familySuccess.families.mdn_search.n, 0);
});

test('BrowserPaw build comparison rejects missing or identical build selectors', () => {
  assert.throws(
    () => compareBrowserpawBuilds([], suite, 'build-a', 'build-a'),
    /must be different/,
  );
  assert.throws(() => compareBrowserpawBuilds([], suite, '', 'build-b'), /baselineBuild/);
  assert.throws(() => compareBrowserpawBuilds([], suite, 'build-a'), /candidateBuild/);
});

test('BrowserPaw build report enforces complete gates and never mixes other builds', () => {
  const records = suite.tasks.flatMap((task) => [
    makeRecord(task.inputId, 'browserpaw', {
      build: 'build-baseline',
      pairId: `browserpaw-build-${task.inputId}`,
      trialId: `browserpaw-build-baseline-${task.inputId}`,
      timing: { wallMs: 100, toolMs: 10, modelMs: 20 },
      actualTokens: { input: 100, output: 50 },
      estimatedTextTokens: 100,
      estimatedInputTokens: 100,
      images: { input: 0, output: 0 },
    }),
    makeRecord(task.inputId, 'browserpaw', {
      build: 'build-candidate',
      pairId: `browserpaw-build-${task.inputId}`,
      trialId: `browserpaw-build-candidate-${task.inputId}`,
      timing: { wallMs: 80, toolMs: 10, modelMs: 20 },
      actualTokens: { input: 70, output: 50 },
      estimatedTextTokens: 100,
      estimatedInputTokens: 100,
      images: { input: 0, output: 0 },
    }),
  ]);
  records.push(
    makeRecord('mdn-search-01', 'browserpaw', {
      build: 'build-other',
      pairId: 'browserpaw-build-mdn-search-01',
      trialId: 'browserpaw-build-other',
      timing: { wallMs: 1, toolMs: 1, modelMs: 1 },
      estimatedTextTokens: 1,
      estimatedInputTokens: 1,
    }),
  );

  const report = buildBrowserpawBuildReport(records, suite, {
    baselineBuild: 'build-baseline',
    candidateBuild: 'build-candidate',
  });
  assert.equal(report.mode, 'browserpaw-builds');
  assert.equal(report.product, 'browserpaw');
  assert.equal(report.input.ignoredRecordCount, 1);
  assert.equal(report.input.browserpawBuildCounts['build-other'], 1);
  assert.equal(report.comparison.pairedN, 80);
  assert.deepEqual(report.comparison.pairedFamilies, {
    github_repo_release: 20,
    mdn_search: 20,
    npm_compare: 20,
    x_search_thread: 20,
  });
  assert.equal(report.acceptance.accepted, true);
});

test('BrowserPaw build report rejects family correctness regression and empty samples', () => {
  const records = suite.tasks.flatMap((task) =>
    ['build-baseline', 'build-candidate'].map((build) =>
      makeRecord(task.inputId, 'browserpaw', {
        build,
        pairId: `browserpaw-build-${task.inputId}`,
        trialId: `browserpaw-build-${build}-${task.inputId}`,
        outcome:
          build === 'build-candidate' && task.inputId === 'mdn-search-01' ? 'failure' : 'success',
      }),
    ),
  );
  const regressed = buildBrowserpawBuildReport(records, suite, {
    baselineBuild: 'build-baseline',
    candidateBuild: 'build-candidate',
  });
  assert.equal(regressed.acceptance.accepted, false);
  assert.equal(regressed.gates.familySuccessNonRegression, false);
  assert.ok(regressed.acceptance.reasons.some((reason) => reason.includes('family success rate')));

  const empty = buildBrowserpawBuildReport([], suite, {
    baselineBuild: 'unavailable-64b',
    candidateBuild: 'build-candidate',
  });
  assert.equal(empty.acceptance.accepted, false);
  assert.ok(empty.acceptance.reasons.includes('no records match both selected BrowserPaw builds'));
});

test('BrowserPaw family non-regression fails closed when unknown viewport skips a failure', () => {
  const records = suite.tasks.flatMap((task) =>
    ['build-baseline', 'build-candidate'].map((build) =>
      makeRecord(task.inputId, 'browserpaw', {
        build,
        pairId: `browserpaw-build-${task.inputId}`,
        trialId: `browserpaw-build-${build}-${task.inputId}`,
        ...(build === 'build-candidate' && task.inputId === 'mdn-search-01'
          ? {
              outcome: 'failure',
              viewport: { width: null, height: null, dpr: null },
            }
          : {}),
      }),
    ),
  );
  const report = buildBrowserpawBuildReport(records, suite, {
    baselineBuild: 'build-baseline',
    candidateBuild: 'build-candidate',
  });
  assert.equal(report.comparison.familySuccess.families.mdn_search.n, 19);
  assert.equal(report.gates.familySuccessNonRegression, false);
  assert.equal(report.acceptance.accepted, false);
});

test('BrowserPaw build report never treats unknown usage or Agent calls as zero', () => {
  const baseline = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-baseline',
    pairId: 'browserpaw-build-unknown',
  });
  const candidate = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-candidate',
    pairId: 'browserpaw-build-unknown',
    actualTokens: { input: null, output: null },
    agentToolCalls: undefined,
    agentToolCallsProvenance: undefined,
  });
  const report = buildBrowserpawBuildReport([baseline, candidate], suite, {
    baselineBuild: 'build-baseline',
    candidateBuild: 'build-candidate',
  });
  assert.equal(report.gates.actualUsage, false);
  assert.equal(report.gates.agentCalls, false);
  assert.equal(report.comparison, null);
  assert.ok(report.acceptance.reasons.includes('actual usage is missing or unverified'));
  assert.ok(report.acceptance.reasons.includes('Agent tool-call count is missing or unverified'));
});

test('BrowserPaw build report rejects malformed selected records without TypeError or fake zero', () => {
  const baseline = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-baseline',
    pairId: 'malformed-build-pair',
  });
  const malformed = makeRecord('mdn-search-01', 'browserpaw', {
    build: 'build-candidate',
    pairId: 'malformed-build-pair',
    timing: undefined,
    seriousFailures: undefined,
  });
  let report;
  assert.doesNotThrow(() => {
    report = buildBrowserpawBuildReport([baseline, malformed], suite, {
      baselineBuild: 'build-baseline',
      candidateBuild: 'build-candidate',
    });
  });
  assert.equal(report.acceptance.accepted, false);
  assert.equal(report.candidateCoverage.seriousFailures, null);
  assert.equal(report.comparison, null);
  assert.ok(report.validation.recordErrors.some((error) => error.includes('timing')));
  assert.ok(report.validation.recordErrors.some((error) => error.includes('seriousFailures')));
});

test('product report rejects malformed records without TypeError or fake zero', () => {
  const malformed = makeRecord('mdn-search-01', 'browserpaw', {
    timing: undefined,
    seriousFailures: undefined,
  });
  let report;
  assert.doesNotThrow(() => {
    report = buildReport([malformed], suite);
  });
  assert.equal(report.acceptance.accepted, false);
  assert.equal(report.products.browserpaw.invalid, 1);
  assert.equal(report.products.browserpaw.seriousFailures, null);
  assert.ok(report.validation.recordErrors.some((error) => error.includes('timing')));
  assert.ok(report.validation.recordErrors.some((error) => error.includes('seriousFailures')));
});

test('paired threshold failure is reported when time and token gains are insufficient', () => {
  const task = suite.tasks.find((candidate) => candidate.mode === 'reuse');
  const records = [];
  for (let index = 0; index < 20; index += 1) {
    const pairId = `threshold-fail-${index}`;
    records.push(
      makeRecord(task.inputId, 'ego', {
        pairId,
        trialId: `fail-ego-${index}`,
        timing: { wallMs: 100, toolMs: 10, modelMs: 20 },
        actualTokens: { input: 100, output: 50 },
        estimatedTextTokens: 100,
        estimatedInputTokens: 100,
        images: { input: 0, output: 0 },
        roundTrips: 4,
      }),
      makeRecord(task.inputId, 'browserpaw', {
        pairId,
        trialId: `fail-paw-${index}`,
        timing: { wallMs: 95, toolMs: 10, modelMs: 20 },
        actualTokens: { input: 95, output: 50 },
        estimatedTextTokens: 95,
        estimatedInputTokens: 95,
        images: { input: 0, output: 0 },
        roundTrips: 4,
      }),
    );
  }
  const comparison = compareProducts(records, suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 20);
  assert.equal(comparison.gates.wallTime, false);
  assert.equal(comparison.gates.inputTokens, false);
});

test('roundTrips cannot stand in for missing Agent tool-call counts', () => {
  const baseline = makeRecord('mdn-search-01', 'ego', { roundTrips: 4 });
  const candidate = makeRecord('mdn-search-02', 'browserpaw', {
    pairId: baseline.pairId,
    roundTrips: 2,
    agentToolCalls: undefined,
    agentToolCallsProvenance: undefined,
  });
  const report = buildReport([baseline, candidate], suite);
  assert.equal(report.products.browserpaw.invalid, 1);
  assert.equal(report.products.browserpaw.roundTrips.median, null);
  assert.equal(report.gates.agentCalls, false);
  assert.equal(report.gates.skillReuse, false);
  assert.ok(report.acceptance.reasons.some((reason) => reason.includes('Agent tool-call count')));
});

test('skill reuse compares a reuse record with its distinct cold exploration input', () => {
  const reuseTask = suite.tasks.find((task) => task.mode === 'reuse');
  const cold = makeRecord(reuseTask.explorationInputId, 'browserpaw', {
    agentToolCalls: 10,
  });
  const reuse = makeRecord(reuseTask.inputId, 'browserpaw', {
    explorationPairId: cold.explorationPairId,
    agentToolCalls: 5,
    startedAt: new Date(Date.parse(cold.startedAt) + 1000).toISOString(),
  });
  const comparison = compareSkillReuse([cold, reuse], suite, 'browserpaw');
  assert.equal(comparison.n, 1);
  assert.equal(comparison.pairedMedianReduction, 0.5);
  assert.equal(comparison.gates.sample, false);

  const competitorOnly = compareSkillReuse(
    [makeRecord(reuseTask.explorationInputId, 'ego'), reuse],
    suite,
    'browserpaw',
  );
  assert.equal(competitorOnly.n, 0);
});

test('paired sample gate requires successful pairs in every family', () => {
  const records = suite.tasks
    .filter((task) => task.family === 'mdn_search')
    .flatMap((task) =>
      ['ego', 'browserpaw'].map((product) => {
        const pairId = `one-family-${task.inputId}`;
        return makeRecord(task.inputId, product, {
          pairId,
          trialId: `one-family-${product}-${task.inputId}`,
        });
      }),
    );

  const comparison = compareProducts(records, suite, 'ego', 'browserpaw');
  assert.equal(comparison.pairedN, 20);
  assert.equal(comparison.pairedFamilies.mdn_search, 20);
  assert.equal(comparison.pairedFamilies.npm_compare, 0);
  assert.equal(comparison.gates.sample, false);
});

test('product execution order is validated against the batch rotation', () => {
  const task = suite.tasks.find((candidate) => candidate.batch === 1);
  const order = suite.batches.find((batch) => batch.batch === 1).productOrder;
  const records = [...order].reverse().map((product, index) =>
    makeRecord(task.inputId, product, {
      trialId: `order-${product}`,
      startedAt: new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString(),
    }),
  );
  const report = buildReport(records, suite);
  assert.equal(report.gates.productOrder, false);
  assert.ok(report.validation.orderIssues.length > 0);
});

test('tokenizer estimates remain summary diagnostics without a formal gate', () => {
  const first = makeRecord('mdn-search-01', 'browserpaw', {
    tokenizer: 'tokenizer-a',
    outcome: 'partial',
  });
  const second = makeRecord('mdn-search-02', 'browserpaw', {
    tokenizer: 'tokenizer-b',
    outcome: 'partial',
  });
  const report = buildReport([first, second], suite);
  assert.equal(Object.hasOwn(report.gates, 'unifiedTokenizer'), false);
  assert.deepEqual(report.input.tokenizers, ['tokenizer-a', 'tokenizer-b']);
  assert.equal(
    report.acceptance.reasons.some((reason) => reason.includes('multiple tokenizers')),
    false,
  );
  assert.deepEqual(
    validateRecord(makeRecord('mdn-search-03', 'browserpaw', { tokenizer: '' }), suite),
    ['tokenizer is required'],
  );
});

test('evaluator only loads explicit records files and reports their digest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-eval-test-'));
  const recordsPath = path.join(dir, 'records.json');
  try {
    fs.writeFileSync(recordsPath, JSON.stringify([makeRecord('mdn-search-01', 'browserpaw')]));
    const loaded = loadRecords(recordsPath);
    assert.equal(loaded.records.length, 1);
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/);

    const report = await runEvaluation({ recordsPath });
    assert.equal(report.input.recordCount, 1);
    assert.equal(report.input.recordsSha256, loaded.sha256);
    assert.equal(report.acceptance.accepted, false);
    assert.ok(
      report.acceptance.reasons.includes('candidate agent_e2e coverage is below 20 per family'),
    );

    const buildReport = await runEvaluation({
      recordsPath,
      baselineBuild: 'build-browserpaw',
      candidateBuild: 'build-other',
    });
    assert.equal(buildReport.mode, 'browserpaw-builds');
    assert.equal(buildReport.comparison.candidateRecordCount, 0);
    assert.equal(buildReport.acceptance.accepted, false);

    await assert.rejects(() => runEvaluation({}), /--records/);
    await assert.rejects(
      () => runEvaluation({ recordsPath, baselineBuild: 'build-browserpaw' }),
      /provided together/,
    );
    await assert.rejects(
      () =>
        runEvaluation({
          recordsPath,
          baselineBuild: 'build-browserpaw',
          candidateBuild: 'build-browserpaw',
        }),
      /must be different/,
    );
    await assert.rejects(
      () => runEvaluation({ recordsPath: path.join(dir, 'missing.json') }),
      /records file not found/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
