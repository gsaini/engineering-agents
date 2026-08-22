import { describe, expect, it } from 'vitest';

import { emptyCost, type Approval, type Run, type RunEvent, type RunState } from '../src/core/run.js';
import { computeMetrics, planEditDistance, renderMetrics, selectRuns, timeToFirstPlan } from '../src/eval/metrics.js';
import { evaluateDemotion, evaluatePromotion, LADDER, renderLadder, rungOf, specFor } from '../src/runtime/ladder.js';
import { workItem } from './fixtures.js';

/**
 * Runs are built by appending events, the same way the store builds them, so
 * these tests break if the event shape changes rather than quietly passing
 * against a hand-written snapshot.
 */
function run(options: {
  id: string;
  state?: RunState;
  createdAt?: string;
  planPostedAfterMinutes?: number | null;
  approval?: Partial<Approval> | null;
  mergeRequestUrl?: string | null;
  costUsd?: number;
  denials?: number;
  notes?: unknown[];
  failure?: string | null;
  failureGuardrail?: string;
  agent?: 'ticket-to-mr' | 'log-triage';
}): Run {
  const createdAt = options.createdAt ?? '2026-08-01T09:00:00.000Z';
  const events: RunEvent[] = [{ seq: 0, at: createdAt, actor: 'system:watcher', type: 'created' }];
  let seq = 1;

  if (options.planPostedAfterMinutes !== null && options.planPostedAfterMinutes !== undefined) {
    events.push({
      seq: seq++,
      at: new Date(Date.parse(createdAt) + options.planPostedAfterMinutes * 60_000).toISOString(),
      actor: 'agent',
      type: 'transition',
      from: 'PLANNING',
      to: 'AWAITING_APPROVAL',
    });
  }
  for (let i = 0; i < (options.denials ?? 0); i += 1) {
    events.push({ seq: seq++, at: createdAt, actor: 'system:guardrails', type: 'tool-denied', payload: { tool: 'Bash' } });
  }
  for (const note of options.notes ?? []) {
    events.push({ seq: seq++, at: createdAt, actor: 'system:guardrails', type: 'note', payload: note });
  }
  // The store folds an error event into `run.failure`, so build it the same way
  // rather than setting the field directly — the metrics read the event log.
  if (options.failure) {
    events.push({
      seq: seq++,
      at: createdAt,
      actor: 'system:guardrails',
      type: 'error',
      payload: { stage: 'verify', message: options.failure, ...(options.failureGuardrail ? { guardrail: options.failureGuardrail } : {}) },
    });
  }

  const approval: Approval | undefined = options.approval
    ? {
        decision: 'approve',
        actor: 'priya',
        at: createdAt,
        feedback: null,
        rejectionReason: null,
        editedPlanMarkdown: null,
        ...options.approval,
      }
    : undefined;

  return {
    meta: {
      runId: options.id,
      agent: options.agent ?? 'ticket-to-mr',
      sourceId: 'ado',
      idempotencyKey: options.id,
      autonomy: 'propose',
      repo: 'payments-service',
      branch: null,
      createdAt,
      updatedAt: createdAt,
      promptVersions: {},
    },
    state: options.state ?? 'COMPLETED',
    trigger: { kind: 'work-item', workItem: workItem() },
    artefacts: {
      plan: { markdown: '## Plan\nstep one\nstep two\nstep three' } as never,
      ...(approval ? { approval } : {}),
      ...(options.mergeRequestUrl ? { mergeRequestUrl: options.mergeRequestUrl } : {}),
    },
    cost: { ...emptyCost(), usd: options.costUsd ?? 1 },
    events,
    failure: options.failure ? { stage: 'verify', message: options.failure } : null,
  };
}

describe('planEditDistance', () => {
  it('is zero when the human changed nothing', () => {
    expect(planEditDistance('a\nb\nc', 'a\nb\nc')).toBe(0);
  });

  it('counts a rewritten step as one edit, not a whole-plan rewrite', () => {
    expect(planEditDistance('a\nb\nc', 'a\nB2\nc')).toBeCloseTo(2 / 3);
  });

  it('caps at 1 when the plan was replaced outright', () => {
    expect(planEditDistance('a\nb', 'x\ny\nz\nw')).toBe(1);
  });
});

describe('timeToFirstPlan', () => {
  it('measures from the trigger to the plan being parked for approval', () => {
    expect(timeToFirstPlan([run({ id: 'a', planPostedAfterMinutes: 20 })])).toBe(20);
  });

  it('ignores runs that never produced a plan', () => {
    expect(timeToFirstPlan([run({ id: 'a', planPostedAfterMinutes: null })])).toBeNull();
  });
});

describe('computeMetrics', () => {
  it('counts an expired plan against acceptance', () => {
    // A plan nobody looked at for three days is not an accepted plan.
    const runs = [
      run({ id: 'a', planPostedAfterMinutes: 10, approval: { decision: 'approve' } }),
      run({ id: 'b', planPostedAfterMinutes: 10, state: 'EXPIRED', approval: null }),
    ];
    expect(computeMetrics({ runs }).planAcceptanceRate).toBe(0.5);
  });

  it('treats approve-with-edits as acceptance and records the edit distance', () => {
    const runs = [
      run({
        id: 'a',
        planPostedAfterMinutes: 10,
        approval: { decision: 'approve-with-edits', editedPlanMarkdown: '## Plan\nstep one\nstep two rewritten\nstep three' },
      }),
    ];
    const metrics = computeMetrics({ runs });
    expect(metrics.planAcceptanceRate).toBe(1);
    expect(metrics.planEditDistance).toBeGreaterThan(0);
    expect(metrics.planEditDistance).toBeLessThan(1);
  });

  it('reports null rather than zero for anything it cannot measure', () => {
    // No code-host lookup was supplied, so merge and escape rate are unknown —
    // and unknown must not read as "nothing merged".
    const metrics = computeMetrics({ runs: [run({ id: 'a', mergeRequestUrl: 'https://host/mr/1' })] });
    expect(metrics.mrMergeRate).toBeNull();
    expect(metrics.escapeRate).toBeNull();
    expect(metrics.rcaAccuracy).toBeNull();
    expect(renderMetrics(metrics, 'test')).toMatch(/Not measured/);
  });

  it('computes merge rate, escape rate and cost per merged MR when told the MR states', () => {
    const runs = [
      run({ id: 'a', mergeRequestUrl: 'mr/1', costUsd: 2 }),
      run({ id: 'b', mergeRequestUrl: 'mr/2', costUsd: 4 }),
      run({ id: 'c', mergeRequestUrl: 'mr/3', costUsd: 6 }),
    ];
    const metrics = computeMetrics({
      runs,
      mergeStates: new Map([
        ['mr/1', 'merged'],
        ['mr/2', 'merged'],
        ['mr/3', 'closed'],
      ]),
      escapes: new Set(['mr/2']),
    });
    expect(metrics.mrMergeRate).toBeCloseTo(2 / 3);
    expect(metrics.costPerMergedMrUsd).toBe(3);
    expect(metrics.escapeRate).toBe(0.5);
  });

  it('counts guardrail events off the run log', () => {
    const runs = [
      run({ id: 'a', denials: 7, notes: [{ guardrail: 'injection', injectionMarkers: ['ignore previous'] }] }),
      run({ id: 'b', failure: 'Budget exceeded (run): spent $9.00 of $8.00' }),
      run({ id: 'c', failure: 'Secret detected in diff: aws-key', failureGuardrail: 'secret-scan' }),
    ];
    const metrics = computeMetrics({ runs });
    expect(metrics.guardrails.injectionHits).toBe(1);
    expect(metrics.guardrails.runsOverDenialThreshold).toBe(1);
    expect(metrics.guardrails.secretScanBlocks).toBe(1);
    expect(metrics.guardrails.budgetStopRate).toBeCloseTo(1 / 3);
  });

  it('counts a blast-radius breach a retry recovered from', () => {
    // The run completed on attempt two, so nothing reaches `run.failure`. The
    // breach still happened, and it is the counter that blocks promotion.
    const runs = [
      run({
        id: 'a',
        state: 'COMPLETED',
        notes: [{ guardrail: 'blast-radius', reason: '40 files changed, limit is 15' }],
      }),
    ];
    expect(computeMetrics({ runs }).guardrails.blastRadiusBreaches).toBe(1);
  });

  it('still sees a secret block when a later failure overwrote the failure field', () => {
    const runs = [
      run({
        id: 'a',
        failure: 'Verification failed after 3 attempts',
        notes: [{ guardrail: 'secret-scan', message: 'Secret detected in diff: aws-key' }],
      }),
    ];
    const metrics = computeMetrics({ runs });
    expect(metrics.guardrails.secretScanBlocks).toBe(1);
    expect(metrics.guardrails.budgetStopRate).toBe(0);
  });

  it('groups rejections by taxonomy reason', () => {
    const runs = [
      run({ id: 'a', planPostedAfterMinutes: 5, approval: { decision: 'reject', rejectionReason: 'wrong-approach' } }),
      run({ id: 'b', planPostedAfterMinutes: 5, approval: { decision: 'reject', rejectionReason: 'wrong-approach' } }),
      run({ id: 'c', planPostedAfterMinutes: 5, approval: { decision: 'reject', rejectionReason: 'too-risky' } }),
    ];
    expect(computeMetrics({ runs }).rejectionsByReason).toEqual({ 'wrong-approach': 2, 'too-risky': 1 });
  });
});

describe('selectRuns', () => {
  it('returns the most recent n, which is the rolling demotion window', () => {
    const runs = [
      run({ id: 'old', createdAt: '2026-08-01T00:00:00.000Z' }),
      run({ id: 'mid', createdAt: '2026-08-05T00:00:00.000Z' }),
      run({ id: 'new', createdAt: '2026-08-09T00:00:00.000Z' }),
    ];
    expect(selectRuns(runs, { limit: 2 }).map((r) => r.meta.runId)).toEqual(['new', 'mid']);
    expect(selectRuns(runs, { since: '2026-08-04T00:00:00.000Z' })).toHaveLength(2);
    expect(selectRuns(runs, { agent: 'log-triage' })).toHaveLength(0);
  });
});

describe('autonomy ladder', () => {
  const clean = computeMetrics({
    runs: [
      run({ id: 'a', planPostedAfterMinutes: 10, approval: { decision: 'approve' }, mergeRequestUrl: 'mr/1' }),
      run({ id: 'b', planPostedAfterMinutes: 10, approval: { decision: 'approve' }, mergeRequestUrl: 'mr/2' }),
    ],
    mergeStates: new Map([['mr/1', 'merged'], ['mr/2', 'merged']]),
    escapes: new Set(),
  });

  it('separates rung 2 from rung 3 by the draft flag alone', () => {
    expect(rungOf('propose', true)).toBe(2);
    expect(rungOf('propose', false)).toBe(3);
    expect(specFor(2).draftMergeRequests).toBe(true);
    expect(LADDER).toHaveLength(5);
  });

  it('blocks promotion on a metric nobody measured, and says which', () => {
    const unmeasured = computeMetrics({ runs: [run({ id: 'a', planPostedAfterMinutes: 10, approval: { decision: 'approve' } })] });
    const verdict = evaluatePromotion({ rung: 2, metrics: unmeasured, weeksAtRung: 12 });
    expect(verdict.eligible).toBe(false);
    expect(verdict.unmet.some((u) => u.includes('not measured'))).toBe(true);
  });

  it('promotes from rung 2 when every criterion is met', () => {
    const verdict = evaluatePromotion({ rung: 2, metrics: clean, weeksAtRung: 10, reviewBurdenRatio: 1.1 });
    expect(verdict.eligible).toBe(true);
    expect(verdict.to).toBe(3);
  });

  it('refuses to promote past rung 4 — merge stays human', () => {
    expect(evaluatePromotion({ rung: 4, metrics: clean, weeksAtRung: 52 }).eligible).toBe(false);
  });

  it('blocks promotion on a guardrail hit however good the scores are', () => {
    const withInjection = computeMetrics({
      runs: [
        run({ id: 'a', planPostedAfterMinutes: 10, approval: { decision: 'approve' }, mergeRequestUrl: 'mr/1', notes: [{ guardrail: 'injection', injectionMarkers: ['x'] }] }),
      ],
      mergeStates: new Map([['mr/1', 'merged']]),
      escapes: new Set(),
    });
    const verdict = evaluatePromotion({ rung: 2, metrics: withInjection, weeksAtRung: 10, reviewBurdenRatio: 1 });
    expect(verdict.eligible).toBe(false);
  });

  it('demotes immediately on a single trigger, and on request with no metric at all', () => {
    const badAcceptance = computeMetrics({
      runs: [
        run({ id: 'a', planPostedAfterMinutes: 5, approval: { decision: 'reject', rejectionReason: 'wrong-approach' } }),
        run({ id: 'b', planPostedAfterMinutes: 5, approval: { decision: 'reject', rejectionReason: 'too-risky' } }),
        run({ id: 'c', planPostedAfterMinutes: 5, approval: { decision: 'approve' } }),
      ],
    });
    const verdict = evaluateDemotion({ rung: 3, metrics: badAcceptance, weeksAtRung: 4 });
    expect(verdict.demote).toBe(true);
    expect(verdict.to).toBe(2);

    const asked = evaluateDemotion({ rung: 3, metrics: clean, weeksAtRung: 4, teamRequestedDemotion: true });
    expect(asked.demote).toBe(true);
    expect(asked.reasons).toContain('a team member asked for it');
  });

  it('does not demote below rung 0', () => {
    expect(evaluateDemotion({ rung: 0, metrics: clean, weeksAtRung: 1, teamRequestedDemotion: true }).to).toBe(0);
  });

  it('renders demotion instead of promotion when both would fire', () => {
    const input = { rung: 2 as const, metrics: clean, weeksAtRung: 10, reviewBurdenRatio: 1.1, teamRequestedDemotion: true };
    const rendered = renderLadder(evaluatePromotion(input), evaluateDemotion(input));
    expect(rendered).toMatch(/DEMOTE/);
    expect(rendered).not.toMatch(/Eligible for rung/);
  });
});
