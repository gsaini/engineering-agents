import type { AgentRunner } from '../agent/runner.js';
import type { Config } from '../config/schema.js';
import { MemoryLogSource } from '../connectors/logs/types.js';
import { NullNotifier } from '../connectors/notify/types.js';
import { MemoryCodeHost } from '../connectors/scm/types.js';
import { MemoryWorkItemSource } from '../connectors/work-items/types.js';
import { createLogger, type Logger } from '../core/logger.js';
import { MemoryRunStore } from '../core/store.js';
import type { RepoInfo } from '../core/types.js';
import type { PipelineDeps } from '../agents/context.js';
import * as logTriage from '../agents/log-triage/pipeline.js';
import * as ticketToMr from '../agents/ticket-to-mr/pipeline.js';
import { ApprovalService } from '../runtime/approvals.js';
import { BudgetGuard } from '../runtime/budget.js';
import { MemorySandboxFactory } from '../runtime/sandbox.js';
import { APPROACH_RUBRIC, RCA_RUBRIC, RESTATEMENT_RUBRIC, type Judge, type Rubric } from './judge.js';
import { scoreAnalysis, scoreDetection, scoreFix, scorePlan, scoreRootCause, scoreTriage } from './scorers.js';
import {
  hydrateSignal,
  hydrateWorkItem,
  type CaseResult,
  type GoldenLogCase,
  type GoldenSet,
  type GoldenTicketCase,
  type StageScore,
} from './types.js';

/**
 * Offline replay.
 *
 * Runs the real pipelines against historical cases with every external system
 * replaced by an in-memory one. Two properties are enforced here rather than
 * trusted:
 *
 * - **Autonomy is forced to `observe`** and `dryRun` to true, so a replay
 *   cannot comment on a ticket closed last year or open a merge request.
 * - **Replay stops at the approval gate.** Implementation needs the repository
 *   at the pre-fix commit, which a golden case does not carry; that stage is
 *   scored separately from a real checkout (`scoreImplementation`).
 *
 * Because it drives the actual pipeline rather than a copy of it, a prompt or
 * retrieval change shows up here without the harness being updated — which is
 * the only way a golden set stays honest (docs/07-evaluation.md).
 */

export interface ReplayOptions {
  config: Config;
  runner: AgentRunner;
  /** Omit to score subjective stages by lexical proxy instead of judgement. */
  judge?: Judge;
  logger?: Logger;
  /** Prompt/retrieval variant stamp, recorded on every result (A/B runs). */
  variant?: string;
}

export async function replayGoldenSet(options: ReplayOptions, set: GoldenSet): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  // Sequential on purpose: a replay against a live model is rate-limited, and
  // a golden run is not the place to discover a concurrency limit.
  for (const c of set.tickets) results.push(await replayTicketCase(options, c));
  for (const c of set.logs) results.push(await replayLogCase(options, c));
  return results;
}

export async function replayTicketCase(options: ReplayOptions, goldenCase: GoldenTicketCase): Promise<CaseResult> {
  const started = Date.now();
  const sourceId = 'golden-tickets';
  const item = hydrateWorkItem(goldenCase.workItem, sourceId);
  const config = replayConfig(options.config);

  if (!config.agents.ticketToMr) {
    return emptyResult(goldenCase.id, 'ticket-to-mr', 'ticketToMr agent is not configured');
  }

  const deps = buildReplayDeps(config, options, {
    workItemSource: new MemoryWorkItemSource(sourceId, [item]),
    repos: repoCatalogue(config, [goldenCase.truth.repo]),
  });

  try {
    const run = await ticketToMr.startTicketRun(deps, item);
    const result = await ticketToMr.runToApproval(deps, run);
    const { artefacts } = result.run;
    const stages: StageScore[] = [];

    if (artefacts.triage) {
      stages.push(scoreTriage(artefacts.triage, goldenCase.truth));
    } else if (result.outcome === 'skipped') {
      // Skipped by a deterministic gate before the model was ever called. That
      // is still a triage decision, and on a case whose truth says "do not act"
      // it is the correct one — leaving it unscored would hide the gate's value
      // and hide it firing on work the agent should have picked up.
      stages.push(
        scoreTriage(
          { actionable: false, reason: result.detail, repo: null, repoResolvedBy: 'unresolved', confidence: 1 },
          goldenCase.truth,
        ),
      );
    }
    if (artefacts.analysis) {
      const restatement = await judgeOrNull(options.judge, {
        rubric: RESTATEMENT_RUBRIC,
        reference: referenceForTicket(goldenCase),
        candidate: artefacts.analysis.restatement,
      });
      stages.push(scoreAnalysis(artefacts.analysis, goldenCase.truth, restatement));
    }
    if (artefacts.plan) {
      const approach = await judgeOrNull(options.judge, {
        rubric: APPROACH_RUBRIC,
        reference: goldenCase.truth.approach,
        candidate: artefacts.plan.approach,
      });
      stages.push(scorePlan(artefacts.plan, goldenCase.truth, approach));
    }

    return {
      caseId: goldenCase.id,
      agent: 'ticket-to-mr',
      stages,
      outcome: result.outcome,
      costUsd: result.run.cost.usd,
      durationMs: Date.now() - started,
      error: result.outcome === 'failed' ? result.detail : null,
    };
  } catch (err) {
    return emptyResult(goldenCase.id, 'ticket-to-mr', err instanceof Error ? err.message : String(err));
  }
}

export async function replayLogCase(options: ReplayOptions, goldenCase: GoldenLogCase): Promise<CaseResult> {
  const started = Date.now();
  const sourceId = 'golden-logs';
  const signal = hydrateSignal(goldenCase.signal, sourceId);
  const config = replayConfig(options.config);

  if (!config.agents.logTriage) {
    return emptyResult(goldenCase.id, 'log-triage', 'logTriage agent is not configured');
  }

  const logSource = new MemoryLogSource(sourceId, signal.service, signal.environment, [signal]);
  const deps = buildReplayDeps(config, options, {
    logSource,
    repos: repoCatalogue(config, [config.agents.logTriage.serviceRepoMapping[signal.service] ?? null]),
  });

  try {
    // Detection is scored against the operator's own thresholds, so a case that
    // never clears them is a detection miss rather than a missing score.
    const suppression = await logTriage.shouldSuppress(
      signal,
      config.agents.logTriage,
      deps.store,
      { seenFingerprints: new Set(), runsStartedThisHour: 0 },
      new Date(signal.lastSeen),
    );
    const fired = !suppression.suppress;
    const detection = scoreDetection(fired, fired ? signal.lastSeen : null, goldenCase.truth);
    if (!fired) detection.detail['suppressionReason'] = suppression.reason;
    const stages: StageScore[] = [detection];

    if (!fired) {
      return {
        caseId: goldenCase.id,
        agent: 'log-triage',
        stages,
        outcome: 'suppressed',
        costUsd: 0,
        durationMs: Date.now() - started,
        error: null,
      };
    }

    const run = await logTriage.startLogRun(deps, signal);
    const result = await logTriage.runToApproval(deps, run);
    const { artefacts } = result.run;

    if (artefacts.rootCause) {
      const judged = await judgeOrNull(options.judge, {
        rubric: RCA_RUBRIC,
        reference: goldenCase.truth.rootCause,
        candidate: renderRootCause(artefacts.rootCause),
      });
      stages.push(scoreRootCause(artefacts.rootCause, goldenCase.truth, judged));
    }
    if (artefacts.plan) stages.push(scoreFix(artefacts.plan, goldenCase.truth));

    return {
      caseId: goldenCase.id,
      agent: 'log-triage',
      stages,
      outcome: result.outcome,
      costUsd: result.run.cost.usd,
      durationMs: Date.now() - started,
      error: result.outcome === 'failed' ? result.detail : null,
    };
  } catch (err) {
    return emptyResult(goldenCase.id, 'log-triage', err instanceof Error ? err.message : String(err));
  }
}

// ------------------------------------------------------------------ plumbing

/**
 * Replay config: the operator's real config with everything that can reach
 * outside forced off. Repo mappings are left exactly as configured — a mapping
 * bug is one of the findings a shadow run is for.
 */
export function replayConfig(config: Config): Config {
  const next: Config = structuredClone(config);
  if (next.agents.ticketToMr) next.agents.ticketToMr.autonomy = 'observe';
  if (next.agents.logTriage) next.agents.logTriage.autonomy = 'observe';
  // Replays are not subject to the production daily cap; the per-run ceiling
  // still applies, so one pathological case cannot burn the whole budget.
  next.guardrails.limits.usdPerDay = Number.MAX_SAFE_INTEGER;
  next.guardrails.limits.runsPerDay = Number.MAX_SAFE_INTEGER;
  return next;
}

function repoCatalogue(config: Config, extra: (string | null)[]): RepoInfo[] {
  const names = new Set<string>([
    ...Object.values(config.agents.ticketToMr?.repoMapping ?? {}),
    ...Object.values(config.agents.logTriage?.serviceRepoMapping ?? {}),
    ...extra.filter((n): n is string => Boolean(n)),
  ]);
  return [...names].map((name) => ({
    name,
    cloneUrl: `replay://${name}.git`,
    defaultBranch: 'main',
    testCommand: null,
    buildCommand: null,
    webUrl: `replay://${name}`,
  }));
}

function buildReplayDeps(
  config: Config,
  options: ReplayOptions,
  parts: { workItemSource?: MemoryWorkItemSource; logSource?: MemoryLogSource; repos: RepoInfo[] },
): PipelineDeps {
  const logger = options.logger ?? createLogger('warn');
  const store = new MemoryRunStore();
  const notifier = new NullNotifier('replay');
  return {
    config,
    store,
    runner: options.runner,
    codeHost: new MemoryCodeHost('replay', parts.repos),
    notifier,
    approvals: new ApprovalService(store, notifier, logger),
    budget: new BudgetGuard(store, config.guardrails.limits),
    sandboxes: new MemorySandboxFactory(),
    ...(parts.workItemSource ? { workItemSource: parts.workItemSource } : {}),
    ...(parts.logSource ? { logSource: parts.logSource } : {}),
    logger,
    dryRun: true,
  };
}

async function judgeOrNull(
  judge: Judge | undefined,
  request: { rubric: Rubric; reference: string; candidate: string },
): Promise<number | null> {
  if (!judge) return null;
  const verdict = await judge.assess(request);
  return verdict.overall;
}

/**
 * What the judge is allowed to see for a ticket case: the requirement as the
 * team implemented it. Never the agent's transcript.
 */
function referenceForTicket(goldenCase: GoldenTicketCase): string {
  return [
    goldenCase.workItem.title,
    goldenCase.workItem.acceptanceCriteria ?? '',
    '',
    `Approach taken: ${goldenCase.truth.approach}`,
    `Files changed: ${goldenCase.truth.changedFiles.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderRootCause(rootCause: { hypothesis: string; evidenceChain: { claim: string; evidence: string }[] }): string {
  return [
    rootCause.hypothesis,
    '',
    ...rootCause.evidenceChain.map((e) => `- ${e.claim} (${e.evidence})`),
  ].join('\n');
}

function emptyResult(caseId: string, agent: CaseResult['agent'], error: string): CaseResult {
  return { caseId, agent, stages: [], outcome: 'error', costUsd: 0, durationMs: 0, error };
}
