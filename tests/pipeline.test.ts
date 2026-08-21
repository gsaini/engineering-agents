import { describe, expect, it } from 'vitest';

import { DryRunAgentRunner } from '../src/agent/dry-runner.js';
import { STAGE_SCHEMAS } from '../src/agent/schemas.js';
import { defaultFixtures } from '../src/agent/dry-runner.js';
import type { PipelineDeps } from '../src/agents/context.js';
import { shouldSuppress, startLogRun } from '../src/agents/log-triage/pipeline.js';
import {
  continueAfterApproval,
  preTriage,
  renderQuestions,
  runToApproval,
  startTicketRun,
} from '../src/agents/ticket-to-mr/pipeline.js';
import { configSchema, type Config } from '../src/config/schema.js';
import { ConsoleNotifier } from '../src/connectors/notify/types.js';
import { MemoryCodeHost } from '../src/connectors/scm/types.js';
import { MemoryWorkItemSource } from '../src/connectors/work-items/types.js';
import { createLogger } from '../src/core/logger.js';
import { canTransition } from '../src/core/run.js';
import { MemoryRunStore } from '../src/core/store.js';
import { ApprovalService } from '../src/runtime/approvals.js';
import { BudgetGuard } from '../src/runtime/budget.js';
import type { Sandbox, SandboxFactory } from '../src/runtime/sandbox.js';
import { logSignal, repoInfo, workItem } from './fixtures.js';

const silent = createLogger('error');

function testConfig(overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse({
    agents: {
      ticketToMr: {
        enabled: true,
        autonomy: 'observe',
        sources: ['wi'],
        codeHost: 'ch',
        notifier: 'console',
        requireLabel: 'agent-ready',
        repoMapping: { 'Payments\\Core': 'payments-service' },
      },
      logTriage: {
        enabled: true,
        autonomy: 'observe',
        sources: ['ls'],
        codeHost: 'ch',
        notifier: 'console',
        serviceRepoMapping: { 'payments-api': 'payments-service' },
      },
    },
    ...overrides,
  });
}

/** A sandbox that never touches git — the pipeline shape is what is under test. */
class FakeSandboxFactory implements SandboxFactory {
  readonly created: string[] = [];
  readonly disposed: string[] = [];

  async create(input: { runId: string; branch: string }): Promise<Sandbox> {
    this.created.push(input.runId);
    const disposed = this.disposed;
    return {
      path: `/tmp/fake/${input.runId}`,
      branch: input.branch,
      git: async () => '',
      run: async () => ({ stdout: '', stderr: '', code: 0 }),
      diff: async () => '',
      diffStat: async () => ({ files: [], lines: 0 }),
      dispose: async () => {
        disposed.push(input.runId);
      },
    };
  }

  async reapOrphans(): Promise<string[]> {
    return [];
  }
}

function buildDeps(config: Config): { deps: PipelineDeps; sandboxes: FakeSandboxFactory } {
  const store = new MemoryRunStore();
  const notifier = new ConsoleNotifier('console');
  const sandboxes = new FakeSandboxFactory();
  const deps: PipelineDeps = {
    config,
    store,
    runner: new DryRunAgentRunner(),
    codeHost: new MemoryCodeHost('ch', [repoInfo(), repoInfo({ name: 'demo-service' })]),
    notifier,
    approvals: new ApprovalService(store, notifier, silent),
    budget: new BudgetGuard(store, config.guardrails.limits),
    sandboxes,
    workItemSource: new MemoryWorkItemSource('wi', [workItem()]),
    logger: silent,
    dryRun: true,
  };
  return { deps, sandboxes };
}

describe('dry-run fixtures satisfy the real stage schemas', () => {
  // If a schema changes without its fixture, this fails loudly rather than
  // letting every pipeline test pass against stale data.
  for (const [stage, schema] of Object.entries(STAGE_SCHEMAS)) {
    it(`${stage} fixture validates`, () => {
      const fixture = defaultFixtures[stage];
      expect(fixture, `no fixture for stage ${stage}`).toBeDefined();
      const value = fixture?.({ stage } as never);
      expect(schema.safeParse(value).success).toBe(true);
    });
  }
});

describe('run state machine', () => {
  it('permits the documented happy path', () => {
    const path = [
      ['QUEUED', 'TRIAGING'],
      ['TRIAGING', 'ANALYZING'],
      ['ANALYZING', 'PLANNING'],
      ['PLANNING', 'AWAITING_APPROVAL'],
      ['AWAITING_APPROVAL', 'IMPLEMENTING'],
      ['IMPLEMENTING', 'VERIFYING'],
      ['VERIFYING', 'PUBLISHING'],
      ['PUBLISHING', 'COMPLETED'],
    ] as const;
    for (const [from, to] of path) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
  });

  it('forbids skipping the approval gate', () => {
    expect(canTransition('PLANNING', 'IMPLEMENTING')).toBe(false);
    expect(canTransition('ANALYZING', 'IMPLEMENTING')).toBe(false);
  });

  it('treats terminal states as terminal', () => {
    expect(canTransition('COMPLETED', 'IMPLEMENTING')).toBe(false);
    expect(canTransition('REJECTED', 'PLANNING')).toBe(false);
  });
});

describe('ticket pre-triage gates', () => {
  const config = testConfig().agents.ticketToMr!;

  it('accepts a labelled, unassigned story', () => {
    expect(preTriage(workItem(), config).pass).toBe(true);
  });

  it('rejects a missing required label', () => {
    expect(preTriage(workItem({ labels: [] }), config).reason).toMatch(/required label/);
  });

  it('rejects a denied label', () => {
    expect(preTriage(workItem({ labels: ['agent-ready', 'no-agent'] }), config).reason).toMatch(/Denied by label/);
  });

  it('rejects a type that is out of scope', () => {
    expect(preTriage(workItem({ rawType: 'Epic' }), config).reason).toMatch(/not in scope/);
  });

  it('rejects an item assigned to a human', () => {
    expect(preTriage(workItem({ assignee: 'Priya' }), config).reason).toMatch(/Assigned to/);
  });
});

describe('ticket-to-MR pipeline (dry run, no credentials)', () => {
  it('runs triage -> analyze -> plan and parks at approval', async () => {
    const config = testConfig();
    const { deps, sandboxes } = buildDeps(config);
    const run = await startTicketRun(deps, workItem());
    const result = await runToApproval(deps, run);

    expect(result.outcome).toBe('awaiting-approval');
    expect(result.run.state).toBe('AWAITING_APPROVAL');
    expect(result.run.artefacts.triage?.actionable).toBe(true);
    expect(result.run.artefacts.analysis?.restatement).toBeTruthy();
    expect(result.run.artefacts.plan?.changes.length).toBeGreaterThan(0);
    // The worktree is released while parked so a days-long approval holds no disk.
    expect(sandboxes.disposed).toContain(run.meta.runId);
  });

  it('skips an item that fails a deterministic gate before any model call', async () => {
    const { deps } = buildDeps(testConfig());
    const runner = deps.runner as DryRunAgentRunner;
    const run = await startTicketRun(deps, workItem({ labels: [] }));
    const result = await runToApproval(deps, run);

    expect(result.outcome).toBe('skipped');
    expect(runner.calls).toHaveLength(0);
  });

  it('does not auto-approve in observe mode', async () => {
    const { deps } = buildDeps(testConfig());
    const run = await startTicketRun(deps, workItem());
    const result = await runToApproval(deps, run);
    expect(result.run.artefacts.approval).toBeUndefined();
  });
});

describe('log-triage suppression', () => {
  const config = testConfig().agents.logTriage!;

  it('suppresses a signal below the occurrence threshold', async () => {
    const store = new MemoryRunStore();
    const state = { seenFingerprints: new Set<string>(), runsStartedThisHour: 0 };
    const decision = await shouldSuppress(logSignal({ count: 3 }), config, store, state);
    expect(decision.suppress).toBe(true);
    expect(decision.reason).toMatch(/occurrence threshold/);
  });

  it('suppresses a fingerprint already seen in the lookback window', async () => {
    const store = new MemoryRunStore();
    const signal = logSignal();
    const state = { seenFingerprints: new Set([signal.fingerprint]), runsStartedThisHour: 0 };
    expect((await shouldSuppress(signal, config, store, state)).reason).toMatch(/not novel/);
  });

  it('suppresses when a run is already handling the fingerprint', async () => {
    const config2 = testConfig().agents.logTriage!;
    const { deps } = buildDeps(testConfig());
    const signal = logSignal();
    await startLogRun(deps, signal);
    const state = { seenFingerprints: new Set<string>(), runsStartedThisHour: 0 };
    const decision = await shouldSuppress(signal, config2, deps.store, state);
    expect(decision.suppress).toBe(true);
  });

  it('enforces the hourly cap — the defence against an MR storm', async () => {
    const store = new MemoryRunStore();
    const state = { seenFingerprints: new Set<string>(), runsStartedThisHour: 3 };
    const decision = await shouldSuppress(logSignal(), config, store, state);
    expect(decision.reason).toMatch(/Hourly run cap/);
  });

  it('lets a novel, high-volume signal through', async () => {
    const store = new MemoryRunStore();
    const state = { seenFingerprints: new Set<string>(), runsStartedThisHour: 0 };
    expect((await shouldSuppress(logSignal(), config, store, state)).suppress).toBe(false);
  });
});

describe('auto-approval policy', () => {
  const basePlan = defaultFixtures['plan']!({ stage: 'plan' } as never) as ReturnType<typeof structuredClone>;

  const policy = {
    autonomy: 'autonomous' as const,
    autonomousRepos: ['payments-service'],
    maxFilesChanged: 15,
    maxLinesChanged: 600,
    sensitiveMatch: false,
  };

  it('refuses anything that is not low risk', () => {
    const result = ApprovalService.canAutoApprove(basePlan as never, 'payments-service', policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/risk is medium/);
  });

  it('refuses a schema change even at low risk', () => {
    const plan = { ...(basePlan as object), risk: { level: 'low', factors: [] } } as never;
    expect(ApprovalService.canAutoApprove(plan, 'payments-service', policy).reason).toMatch(/schema/);
  });

  it('refuses a repo that is not on the allowlist', () => {
    expect(ApprovalService.canAutoApprove(basePlan as never, 'other-service', policy).reason).toMatch(/allowlist/);
  });

  it('refuses when a sensitive path is touched, regardless of everything else', () => {
    const plan = {
      ...(basePlan as object),
      risk: { level: 'low', factors: [] },
      blastRadius: {
        filesChanged: 1,
        linesChanged: 10,
        publicApiChange: false,
        schemaChange: false,
        configChange: false,
        deployOrderNote: null,
      },
    } as never;
    expect(
      ApprovalService.canAutoApprove(plan, 'payments-service', { ...policy, sensitiveMatch: true }).reason,
    ).toMatch(/sensitive/);
  });

  it('allows a small, low-risk, allowlisted change', () => {
    const plan = {
      ...(basePlan as object),
      risk: { level: 'low', factors: [] },
      blastRadius: {
        filesChanged: 2,
        linesChanged: 40,
        publicApiChange: false,
        schemaChange: false,
        configChange: false,
        deployOrderNote: null,
      },
    } as never;
    expect(ApprovalService.canAutoApprove(plan, 'payments-service', policy).allowed).toBe(true);
  });
});

describe('NEEDS_INFO rendering', () => {
  it('numbers questions and states a default so the reply can be terse', () => {
    const analysis = {
      restatement: '',
      inScopeBehaviour: [],
      outOfScope: [],
      assumptions: [],
      openQuestions: [
        {
          question: 'Backfill existing rows, or enforce on new rows only?',
          blocking: true,
          whyItMatters: 'Determines whether the migration needs a maintenance window.',
          suggestedDefault: 'enforce on new rows only',
        },
      ],
      affectedAreas: [{ path: 'src/refunds/service.ts', why: '', confidence: 1 }],
      existingCoverage: { hasTests: true, testFiles: [], gap: '' },
      risk: { level: 'low' as const, factors: [] },
    };
    const out = renderQuestions(analysis, 'PAY-4412');
    expect(out).toContain('1. **Backfill existing rows');
    expect(out).toContain('*Default:* **enforce on new rows only**');
    expect(out).toContain('*Why it matters:*');
    expect(out).toContain("I've read: src/refunds/service.ts");
  });
});

describe('run reload — event log is the source of truth', () => {
  it('persists the repo and branch resolved mid-run', async () => {
    // Regression: setting run.meta.repo in memory left the reloaded run with
    // repo=null, so the approval message read "Repo `unknown`" and every later
    // getRepo lookup failed. Meta changes have to go through the log.
    const { deps } = buildDeps(testConfig());
    const run = await startTicketRun(deps, workItem());
    await runToApproval(deps, run);

    const reloaded = await deps.store.load(run.meta.runId);
    expect(reloaded?.meta.repo).toBe('demo-service');
    expect(reloaded?.meta.branch).toMatch(/^agent\/pay-4412-/);
  });

  it('reaches COMPLETED with a full artefact set once approved', async () => {
    const { deps } = buildDeps(testConfig());
    const run = await startTicketRun(deps, workItem());
    const parked = await runToApproval(deps, run);
    expect(parked.run.state).toBe('AWAITING_APPROVAL');

    await deps.approvals.record(run.meta.runId, 'approve', 'tester');
    const approved = await deps.store.load(run.meta.runId);
    const finished = await continueAfterApproval(deps, approved!);

    expect(finished.outcome).toBe('completed');
    expect(finished.run.state).toBe('COMPLETED');
    expect(Object.keys(finished.run.artefacts).sort()).toEqual([
      'analysis',
      'approval',
      'implementation',
      'mergeRequestUrl',
      'plan',
      'selfReview',
      'triage',
    ]);

    const transitions = finished.run.events.filter((e) => e.type === 'transition').map((e) => e.to);
    expect(transitions).toEqual([
      'TRIAGING',
      'ANALYZING',
      'PLANNING',
      'AWAITING_APPROVAL',
      'IMPLEMENTING',
      'VERIFYING',
      'PUBLISHING',
      'COMPLETED',
    ]);
  });

  it('rejects without a taxonomy reason', async () => {
    const { deps } = buildDeps(testConfig());
    const run = await startTicketRun(deps, workItem());
    await runToApproval(deps, run);
    await expect(deps.approvals.record(run.meta.runId, 'reject', 'tester')).rejects.toThrow(/taxonomy/);
  });

  it('records a rejection and stops', async () => {
    const { deps } = buildDeps(testConfig());
    const run = await startTicketRun(deps, workItem());
    await runToApproval(deps, run);
    await deps.approvals.record(run.meta.runId, 'reject', 'tester', { rejectionReason: 'wrong-approach' });
    const rejected = await deps.store.load(run.meta.runId);
    const result = await continueAfterApproval(deps, rejected!);
    expect(result.run.state).toBe('REJECTED');
    expect(result.detail).toBe('wrong-approach');
  });
});
