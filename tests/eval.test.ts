import { describe, expect, it } from 'vitest';

import { DryRunAgentRunner } from '../src/agent/dry-runner.js';
import { configSchema, type Config } from '../src/config/schema.js';
import { createLogger } from '../src/core/logger.js';
import { loadGoldenSet, holdOut, clusterLabels } from '../src/eval/golden.js';
import { judgeAgreement, LexicalJudge, selectSpotCheck, RCA_RUBRIC } from '../src/eval/judge.js';
import { buildReport, checkRegression, renderReport } from '../src/eval/report.js';
import { replayGoldenSet } from '../src/eval/replay.js';
import {
  coverageScore,
  scoreDetection,
  scoreFingerprinting,
  scoreImplementation,
  scorePlan,
  scoreRootCause,
  scoreTriage,
  setScore,
} from '../src/eval/scorers.js';
import type { CaseResult } from '../src/eval/types.js';

const silent = createLogger('error');

function evalConfig(): Config {
  return configSchema.parse({
    agents: {
      ticketToMr: {
        enabled: false,
        autonomy: 'observe',
        sources: ['g'],
        codeHost: 'g',
        notifier: 'g',
        requireLabel: 'agent-ready',
        repoMapping: { 'Payments\\Core': 'demo-service' },
      },
      logTriage: {
        enabled: false,
        autonomy: 'observe',
        sources: ['g'],
        codeHost: 'g',
        notifier: 'g',
        serviceRepoMapping: { 'payments-api': 'demo-service' },
      },
    },
  });
}

const ticketTruth = {
  actionable: true,
  repo: 'demo-service',
  changedFiles: ['src/a.ts', 'src/b.ts'],
  approach: 'Store the key behind a unique index.',
  ambiguities: ['What happens when the same key arrives with a different amount?'],
  testFiles: [],
};

describe('setScore', () => {
  it('reports precision, recall and what was missed', () => {
    const score = setScore(['src/a.ts', 'src/c.ts'], ['src/a.ts', 'src/b.ts']);
    expect(score.precision).toBe(0.5);
    expect(score.recall).toBe(0.5);
    expect(score.missed).toEqual(['src/b.ts']);
    expect(score.spurious).toEqual(['src/c.ts']);
  });

  it('ignores path and case differences that mean the same file', () => {
    expect(setScore(['./src/A.ts'], ['src/a.ts']).recall).toBe(1);
  });

  it('scores zero against an empty reference rather than a perfect one', () => {
    // A missing ground truth must never read as a passing score.
    expect(setScore(['src/a.ts'], []).f1).toBe(0);
  });

  it('credits proposing nothing when nothing was changed', () => {
    expect(setScore([], []).f1).toBe(1);
  });
});

describe('coverageScore', () => {
  it('matches a differently worded statement of the same ambiguity', () => {
    const raised = ['Should a repeated idempotency key with a different amount be rejected?'];
    const reference = ['What happens when the same idempotency key arrives with a different amount?'];
    expect(coverageScore(raised, reference)).toBe(1);
  });

  it('does not match an unrelated question', () => {
    expect(coverageScore(['Which database version are we on?'], ['How long should a key stay valid?'])).toBe(0);
  });
});

describe('scoreTriage', () => {
  it('gives full credit for the right call and the right repo', () => {
    const score = scoreTriage(
      { actionable: true, reason: '', repo: 'demo-service', repoResolvedBy: 'area-mapping', confidence: 0.9 },
      ticketTruth,
    );
    expect(score.score).toBe(1);
  });

  it('halves the score when the repo is wrong', () => {
    const score = scoreTriage(
      { actionable: true, reason: '', repo: 'other-service', repoResolvedBy: 'inference', confidence: 0.9 },
      ticketTruth,
    );
    expect(score.score).toBe(0.5);
  });

  it('scores zero for picking up work a human closed as non-actionable', () => {
    const score = scoreTriage(
      { actionable: true, reason: '', repo: 'demo-service', repoResolvedBy: 'inference', confidence: 0.9 },
      { ...ticketTruth, actionable: false, repo: null },
    );
    expect(score.score).toBe(0);
  });
});

describe('scorePlan', () => {
  const plan = {
    changes: [{ file: 'src/a.ts', change: '', why: '' }],
    tests: ['covers the duplicate key'],
    risk: { level: 'low' as const, factors: [] },
    blastRadius: { filesChanged: 1, linesChanged: 10, publicApiChange: false, schemaChange: false, configChange: false, deployOrderNote: null },
  };

  it('weights recall above precision', () => {
    // Missing half the files must cost more than naming one extra.
    const halfRecall = scorePlan({ ...plan } as never, ticketTruth);
    const halfPrecision = scorePlan(
      { ...plan, changes: [{ file: 'src/a.ts', change: '', why: '' }, { file: 'src/b.ts', change: '', why: '' }, { file: 'src/z.ts', change: '', why: '' }] } as never,
      ticketTruth,
    );
    expect(halfPrecision.score).toBeGreaterThan(halfRecall.score);
  });

  it('folds in the judge score when one is supplied', () => {
    const withJudge = scorePlan({ ...plan } as never, ticketTruth, 1);
    const withoutJudge = scorePlan({ ...plan } as never, ticketTruth);
    expect(withJudge.score).toBeGreaterThan(withoutJudge.score);
    expect(withJudge.detail['approachScore']).toBe(1);
  });
});

describe('scoreDetection', () => {
  const truth = {
    shouldFire: true,
    humanDetectedAt: '2026-05-19T10:00:00.000Z',
    clusterLabel: 'c',
    rootCause: '',
    category: 'defensive' as const,
    changedFiles: [],
  };

  it('gives full credit for firing before the humans noticed', () => {
    expect(scoreDetection(true, '2026-05-19T09:30:00.000Z', truth).score).toBe(1);
  });

  it('decays as the lag grows', () => {
    const late = scoreDetection(true, '2026-05-19T11:00:00.000Z', truth);
    expect(late.score).toBeGreaterThan(0.5);
    expect(late.score).toBeLessThan(1);
  });

  it('scores zero for missing a real incident', () => {
    expect(scoreDetection(false, null, truth).score).toBe(0);
  });

  it('inverts on a noise case, where not firing is correct', () => {
    const noise = { ...truth, shouldFire: false };
    expect(scoreDetection(false, null, noise).score).toBe(1);
    expect(scoreDetection(true, '2026-05-19T09:00:00.000Z', noise).score).toBe(0);
  });
});

describe('scoreFingerprinting', () => {
  it('rewards clustering that matches the hand labels', () => {
    const signals = [
      { id: 'a', fingerprint: 'f1' },
      { id: 'b', fingerprint: 'f1' },
      { id: 'c', fingerprint: 'f2' },
    ];
    const labels = new Map([['a', 'x'], ['b', 'x'], ['c', 'y']]);
    expect(scoreFingerprinting(signals, labels).score).toBe(1);
  });

  it('punishes collapsing two distinct problems into one signal', () => {
    const signals = [
      { id: 'a', fingerprint: 'f1' },
      { id: 'b', fingerprint: 'f1' },
    ];
    const labels = new Map([['a', 'x'], ['b', 'y']]);
    expect(scoreFingerprinting(signals, labels).score).toBe(0);
  });
});

describe('scoreRootCause', () => {
  const truth = {
    shouldFire: true,
    humanDetectedAt: null,
    clusterLabel: 'c',
    rootCause: 'The import path never sets provider metadata, which the refund service dereferences.',
    category: 'defensive' as const,
    changedFiles: ['src/refunds/service.ts'],
  };

  const rootCause = {
    hypothesis: 'The refund service dereferences provider metadata the import path never sets.',
    evidenceChain: [{ claim: 'throws at service.ts:142', evidence: 'stack frame' }],
    confidence: 0.9,
    alternativeHypotheses: [],
    category: 'defensive' as const,
    severity: 'high' as const,
    reproduction: '',
    whyTestsMissedIt: '',
    notACodeIssue: false,
  };

  it('penalises a confident wrong answer through calibration', () => {
    const confidentAndWrong = scoreRootCause({ ...rootCause, confidence: 0.95 }, truth, 0.1);
    const hedgedAndWrong = scoreRootCause({ ...rootCause, confidence: 0.2 }, truth, 0.1);
    expect(hedgedAndWrong.score).toBeGreaterThan(confidentAndWrong.score);
  });

  it('penalises the wrong fix category even when the cause is right', () => {
    const wrongCategory = scoreRootCause({ ...rootCause, category: 'config' }, truth, 1);
    expect(wrongCategory.detail['categoryCorrect']).toBe(false);
    expect(wrongCategory.score).toBeLessThan(scoreRootCause(rootCause, truth, 1).score);
  });
});

describe('scoreImplementation', () => {
  it('requires the regression test to fail before the fix', () => {
    const passing = scoreImplementation({
      existingTestsPass: true,
      agentTestFailsPreFix: true,
      filesChanged: ['src/a.ts', 'src/b.ts'],
      truth: ticketTruth,
    });
    const uselessTest = scoreImplementation({
      existingTestsPass: true,
      agentTestFailsPreFix: false,
      filesChanged: ['src/a.ts', 'src/b.ts'],
      truth: ticketTruth,
    });
    expect(passing.score).toBe(1);
    expect(uselessTest.score).toBeLessThan(1);
  });
});

describe('judge', () => {
  it('labels the lexical proxy as not model-judged', async () => {
    const verdict = await new LexicalJudge().assess({
      rubric: RCA_RUBRIC,
      reference: 'the import path never sets provider metadata',
      candidate: 'provider metadata is never set on the import path',
    });
    expect(verdict.modelJudged).toBe(false);
    expect(verdict.overall).toBeGreaterThan(0.5);
  });

  it('reports agreement with human labels and refuses to trust a small sample', () => {
    const close = Array.from({ length: 25 }, () => ({ judge: 0.8, human: 0.75 }));
    expect(judgeAgreement(close).trustworthy).toBe(true);
    expect(judgeAgreement(close.slice(0, 5)).trustworthy).toBe(false);

    const divergent = Array.from({ length: 25 }, (_, i) => ({ judge: 0.9, human: i % 2 === 0 ? 0.2 : 0.85 }));
    expect(judgeAgreement(divergent).trustworthy).toBe(false);
  });

  it('picks the same spot-check sample every run', () => {
    const results = Array.from({ length: 200 }, (_, i) => ({ caseId: `case-${i}` }));
    const first = selectSpotCheck(results).map((r) => r.caseId);
    expect(selectSpotCheck(results).map((r) => r.caseId)).toEqual(first);
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(40);
  });
});

describe('golden set', () => {
  it('loads the checked-in example set', async () => {
    const set = await loadGoldenSet('eval/golden');
    expect(set.tickets.length).toBeGreaterThan(0);
    expect(set.logs.length).toBeGreaterThan(0);
    // A set of only success cases measures the happy path and nothing else.
    expect(set.tickets.some((t) => !t.truth.actionable)).toBe(true);
    expect(set.logs.some((l) => !l.truth.shouldFire)).toBe(true);
  });

  it('returns an empty set rather than throwing on a missing directory', async () => {
    expect(await loadGoldenSet('eval/does-not-exist')).toEqual({ tickets: [], logs: [] });
  });

  it('never moves an existing case across the hold-out boundary when cases are added', () => {
    const cases = Array.from({ length: 60 }, (_, i) => ({ id: `case-${i}` }));
    const before = new Set(holdOut(cases).held.map((c) => c.id));
    const after = new Set(holdOut([...cases, { id: 'case-new' }]).held.map((c) => c.id));
    for (const id of before) expect(after.has(id)).toBe(true);
    expect(before.size).toBeGreaterThan(3);
    expect(before.size).toBeLessThan(cases.length);
  });

  it('keys cluster labels by the signal id the pipeline will see', async () => {
    const set = await loadGoldenSet('eval/golden');
    const labels = clusterLabels(set.logs, 'golden-logs');
    expect([...labels.keys()][0]).toMatch(/^golden-logs:/);
  });
});

describe('offline replay', () => {
  it('runs the real pipelines against the golden set with no credentials', async () => {
    const set = await loadGoldenSet('eval/golden');
    const results = await replayGoldenSet(
      { config: evalConfig(), runner: new DryRunAgentRunner(), judge: new LexicalJudge(), logger: silent },
      set,
    );

    expect(results).toHaveLength(set.tickets.length + set.logs.length);
    expect(results.every((r) => r.error === null)).toBe(true);
    // Every case is scored on something, including the ones that stop early.
    expect(results.every((r) => r.stages.length > 0)).toBe(true);
  });

  it('scores a correctly skipped case instead of leaving it unscored', async () => {
    const set = await loadGoldenSet('eval/golden');
    const results = await replayGoldenSet(
      { config: evalConfig(), runner: new DryRunAgentRunner(), judge: new LexicalJudge(), logger: silent },
      set,
    );
    const skipped = results.find((r) => r.outcome === 'skipped');
    expect(skipped?.stages.find((s) => s.stage === 'triage')?.score).toBe(1);
  });

  it('never posts anywhere, whatever autonomy the config asks for', async () => {
    const config = configSchema.parse({
      agents: {
        ticketToMr: {
          enabled: true,
          autonomy: 'autonomous',
          sources: ['g'],
          codeHost: 'g',
          notifier: 'g',
          requireLabel: 'agent-ready',
          repoMapping: { 'Payments\\Core': 'demo-service' },
        },
      },
    });
    const set = await loadGoldenSet('eval/golden');
    const results = await replayGoldenSet(
      { config, runner: new DryRunAgentRunner(), judge: new LexicalJudge(), logger: silent },
      { tickets: set.tickets, logs: [] },
    );
    // Nothing reached an MR: replay forces observe and stops at the gate.
    expect(results.every((r) => r.outcome !== 'completed')).toBe(true);
  });
});

describe('report and regression gate', () => {
  const results: CaseResult[] = [
    { caseId: 'a', agent: 'ticket-to-mr', stages: [{ stage: 'plan', score: 0.8, detail: {} }], outcome: 'awaiting-approval', costUsd: 1, durationMs: 10, error: null },
    { caseId: 'b', agent: 'ticket-to-mr', stages: [{ stage: 'plan', score: 0.4, detail: {} }], outcome: 'awaiting-approval', costUsd: 3, durationMs: 20, error: null },
  ];

  it('aggregates per stage and surfaces the weakest cases', () => {
    const report = buildReport(results, { variant: 'v1', generatedAt: '2026-08-01T00:00:00.000Z' });
    const plan = report.stages.find((s) => s.stage === 'plan');
    expect(plan?.mean).toBeCloseTo(0.6);
    expect(plan?.worstCases[0]?.caseId).toBe('b');
    expect(report.cost.meanUsdPerCase).toBe(2);
  });

  it('blocks on a drop beyond tolerance and ignores noise below it', () => {
    const baseline = buildReport(results, { variant: 'v1' });
    const smallDrop = buildReport(
      results.map((r) => ({ ...r, stages: [{ stage: 'plan', score: (r.stages[0]?.score ?? 0) - 0.02, detail: {} }] })),
      { variant: 'v2' },
    );
    const bigDrop = buildReport(
      results.map((r) => ({ ...r, stages: [{ stage: 'plan', score: (r.stages[0]?.score ?? 0) - 0.3, detail: {} }] })),
      { variant: 'v3' },
    );
    expect(checkRegression(smallDrop, baseline).pass).toBe(true);
    expect(checkRegression(bigDrop, baseline).pass).toBe(false);
    expect(checkRegression(bigDrop, baseline).findings[0]?.severity).toBe('blocking');
  });

  it('flags a stage that exists in only one report rather than silently passing', () => {
    const baseline = buildReport(results, { variant: 'v1' });
    const renamed = buildReport(
      results.map((r) => ({ ...r, stages: [{ stage: 'planning', score: 0.9, detail: {} }] })),
      { variant: 'v2' },
    );
    expect(checkRegression(renamed, baseline).unmatched).toContain('plan');
  });

  it('says so when the scores came from the lexical proxy', () => {
    const rendered = renderReport(buildReport(results, { modelJudged: false }));
    expect(rendered).toMatch(/lexical proxy/);
    expect(renderReport(buildReport(results, { modelJudged: true }))).not.toMatch(/lexical proxy/);
  });
});
