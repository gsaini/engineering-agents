import type { Run } from '../core/run.js';
import type { AutonomyLevel } from '../core/types.js';
import { mean, median } from './scorers.js';

/**
 * Online metrics, computed from the run store.
 *
 * Everything here is a fold over the event log, which is why the log is
 * append-only: these numbers are reconstructible for any past window without a
 * separate analytics pipeline, and they cannot drift from what actually
 * happened (ADR 0006, docs/07-evaluation.md).
 *
 * Three metrics need facts the run store cannot know — whether an MR merged,
 * whether it was later reverted, whether an RCA was right. Those arrive as
 * explicit inputs rather than being guessed, and report `null` when absent. A
 * metric that quietly reports 0 for "we did not measure this" is worse than no
 * metric.
 */

export interface MetricsInput {
  runs: readonly Run[];
  /** Merge-request state by URL. Populated from a code-host lookup. */
  mergeStates?: ReadonlyMap<string, 'open' | 'merged' | 'closed'>;
  /** MRs later reverted or hot-fixed, by URL. From the escape-tracking label. */
  escapes?: ReadonlySet<string>;
  /** Run ids whose root cause a human confirmed. From the weekly review. */
  confirmedRootCauses?: ReadonlySet<string>;
  /** Run ids whose root cause a human rejected. */
  rejectedRootCauses?: ReadonlySet<string>;
}

export interface AgentMetrics {
  window: { from: string | null; to: string | null };
  runs: number;

  // ---- primary
  planAcceptanceRate: number | null;
  planEditDistance: number | null;
  mrMergeRate: number | null;
  timeToFirstPlanMinutes: number | null;
  rcaAccuracy: number | null;

  // ---- secondary
  costPerMergedMrUsd: number | null;
  costPerRunUsd: number;
  coverage: number | null;
  escapeRate: number | null;

  // ---- guardrail
  guardrails: {
    blastRadiusBreaches: number;
    toolDenialsPerRun: number;
    runsOverDenialThreshold: number;
    sensitivePathDetections: number;
    injectionHits: number;
    secretScanBlocks: number;
    budgetStopRate: number;
  };

  /** Why plans were rejected. The fastest route to the failing stage. */
  rejectionsByReason: Record<string, number>;
  outcomes: Record<string, number>;
}

export function computeMetrics(input: MetricsInput): AgentMetrics {
  const { runs } = input;
  const dates = runs.map((r) => r.meta.createdAt).sort();

  const proposed = runs.filter(reachedApproval);
  const decided = proposed.filter((r) => r.artefacts.approval !== undefined || r.state === 'EXPIRED');
  // An expired plan is not an accepted plan. Counting only explicit rejections
  // would flatter an agent whose plans everyone ignores.
  const accepted = decided.filter((r) => {
    const d = r.artefacts.approval?.decision;
    return d === 'approve' || d === 'approve-with-edits';
  });

  const editDistances = proposed
    .filter((r) => r.artefacts.approval?.decision === 'approve-with-edits')
    .map((r) => planEditDistance(r.artefacts.plan?.markdown ?? '', r.artefacts.approval?.editedPlanMarkdown ?? ''));

  const mrUrls = runs
    .map((r) => r.artefacts.mergeRequestUrl)
    .filter((u): u is string => typeof u === 'string');
  const merged = input.mergeStates
    ? mrUrls.filter((u) => input.mergeStates?.get(u) === 'merged')
    : null;

  const mergedCost = merged
    ? runs
        .filter((r) => r.artefacts.mergeRequestUrl && merged.includes(r.artefacts.mergeRequestUrl))
        .reduce((sum, r) => sum + r.cost.usd, 0)
    : null;

  const rcaJudged =
    (input.confirmedRootCauses?.size ?? 0) + (input.rejectedRootCauses?.size ?? 0);

  const denials = runs.map((r) => r.events.filter((e) => e.type === 'tool-denied').length);

  return {
    window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    runs: runs.length,

    planAcceptanceRate: decided.length === 0 ? null : accepted.length / decided.length,
    planEditDistance: editDistances.length === 0 ? null : median(editDistances),
    mrMergeRate: merged === null || mrUrls.length === 0 ? null : merged.length / mrUrls.length,
    timeToFirstPlanMinutes: timeToFirstPlan(proposed),
    rcaAccuracy: rcaJudged === 0 ? null : (input.confirmedRootCauses?.size ?? 0) / rcaJudged,

    costPerMergedMrUsd: merged === null || merged.length === 0 ? null : (mergedCost ?? 0) / merged.length,
    costPerRunUsd: runs.length === 0 ? 0 : runs.reduce((sum, r) => sum + r.cost.usd, 0) / runs.length,
    coverage: runs.length === 0 ? null : runs.filter((r) => r.state !== 'SKIPPED').length / runs.length,
    escapeRate:
      input.escapes === undefined || merged === null || merged.length === 0
        ? null
        : merged.filter((u) => input.escapes?.has(u)).length / merged.length,

    guardrails: {
      blastRadiusBreaches: countGuardrail(runs, 'blast-radius'),
      toolDenialsPerRun: mean(denials),
      runsOverDenialThreshold: denials.filter((d) => d > 5).length,
      sensitivePathDetections: countGuardrail(runs, 'sensitive-path'),
      injectionHits: countGuardrail(runs, 'injection'),
      secretScanBlocks: countGuardrail(runs, 'secret-scan'),
      budgetStopRate: runs.length === 0 ? 0 : countBudgetStops(runs) / runs.length,
    },

    rejectionsByReason: countBy(
      runs
        .map((r) => r.artefacts.approval)
        .filter((a) => a?.decision === 'reject')
        .map((a) => a?.rejectionReason ?? 'other'),
    ),
    outcomes: countBy(runs.map((r) => r.state)),
  };
}

/**
 * Fraction of plan lines a human changed before approving.
 *
 * Line-level rather than character-level: a reviewer rewriting one step of a
 * plan has made one edit, and a character diff would score that the same as
 * rewriting the whole thing in different words.
 */
export function planEditDistance(original: string, edited: string): number {
  const before = original.split('\n').map((l) => l.trim()).filter(Boolean);
  const after = edited.split('\n').map((l) => l.trim()).filter(Boolean);
  if (before.length === 0) return after.length === 0 ? 0 : 1;
  const kept = new Set(after);
  const unchanged = before.filter((l) => kept.has(l)).length;
  const changed = before.length - unchanged;
  const added = after.filter((l) => !new Set(before).has(l)).length;
  return Math.min(1, (changed + added) / before.length);
}

/** Trigger arrived to plan posted. The number a team feels most directly. */
export function timeToFirstPlan(runs: readonly Run[]): number | null {
  const durations: number[] = [];
  for (const run of runs) {
    const created = run.events.find((e) => e.type === 'created');
    const parked = run.events.find((e) => e.type === 'transition' && e.to === 'AWAITING_APPROVAL');
    if (!created || !parked) continue;
    durations.push((Date.parse(parked.at) - Date.parse(created.at)) / 60_000);
  }
  return durations.length === 0 ? null : median(durations);
}

export function reachedApproval(run: Run): boolean {
  return run.events.some((e) => e.type === 'transition' && e.to === 'AWAITING_APPROVAL');
}

/** Filter to one agent and one window before computing. */
export function selectRuns(
  runs: readonly Run[],
  filter: { agent?: string; since?: string; autonomy?: AutonomyLevel; limit?: number } = {},
): Run[] {
  let out = [...runs];
  if (filter.agent) out = out.filter((r) => r.meta.agent === filter.agent);
  if (filter.since) out = out.filter((r) => r.meta.createdAt >= (filter.since as string));
  if (filter.autonomy) out = out.filter((r) => r.meta.autonomy === filter.autonomy);
  out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  return filter.limit ? out.slice(0, filter.limit) : out;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * Runs carrying at least one event tagged with this guardrail.
 *
 * Counted off the structured `guardrail` marker the enforcement points write,
 * not off the prose of a failure message: a breach that a retry recovered from
 * never reaches `run.failure`, and a later failure overwrites an earlier one.
 * Both would silently report zero, which for a counter whose alert threshold is
 * "any" is worse than having no counter at all.
 */
function countGuardrail(runs: readonly Run[], kind: string): number {
  return runs.filter((r) =>
    r.events.some((e) => {
      const payload = e.payload;
      return typeof payload === 'object' && payload !== null && (payload as { guardrail?: string }).guardrail === kind;
    }),
  ).length;
}

/** Budget stops surface as a thrown guard, so the failure message is the record. */
function countBudgetStops(runs: readonly Run[]): number {
  return runs.filter((r) =>
    r.events.some(
      (e) => e.type === 'error' && String((e.payload as { message?: string })?.message ?? '').includes('Budget exceeded'),
    ),
  ).length;
}

export function renderMetrics(metrics: AgentMetrics, label: string): string {
  const pct = (v: number | null): string => (v === null ? '     —' : `${(v * 100).toFixed(1)}%`.padStart(6));
  const num = (v: number | null, digits = 1): string => (v === null ? '     —' : v.toFixed(digits).padStart(6));
  const lines = [
    `${label} — ${metrics.runs} runs${metrics.window.from ? ` since ${metrics.window.from.slice(0, 10)}` : ''}`,
    '',
    'primary',
    `  plan acceptance      ${pct(metrics.planAcceptanceRate)}   (promote above 70%)`,
    `  plan edit distance   ${pct(metrics.planEditDistance)}   (promote below 20%)`,
    `  MR merge rate        ${pct(metrics.mrMergeRate)}   (promote above 60%)`,
    `  time to first plan   ${num(metrics.timeToFirstPlanMinutes)}m  (target under 30m)`,
    `  RCA accuracy         ${pct(metrics.rcaAccuracy)}   (promote above 75%)`,
    '',
    'secondary',
    `  cost per merged MR   ${metrics.costPerMergedMrUsd === null ? '     —' : `$${metrics.costPerMergedMrUsd.toFixed(2)}`}`,
    `  cost per run         $${metrics.costPerRunUsd.toFixed(2)}`,
    `  coverage             ${pct(metrics.coverage)}`,
    `  escape rate          ${pct(metrics.escapeRate)}   (demote above 10%)`,
    '',
    'guardrail',
    `  blast-radius breaches ${metrics.guardrails.blastRadiusBreaches}`,
    `  tool denials per run  ${metrics.guardrails.toolDenialsPerRun.toFixed(2)} (${metrics.guardrails.runsOverDenialThreshold} runs above 5)`,
    `  sensitive-path hits   ${metrics.guardrails.sensitivePathDetections}`,
    `  injection hits        ${metrics.guardrails.injectionHits}`,
    `  secret-scan blocks    ${metrics.guardrails.secretScanBlocks}`,
    `  budget stops          ${pct(metrics.guardrails.budgetStopRate)}   (alert above 5%)`,
  ];

  const rejections = Object.entries(metrics.rejectionsByReason).sort((a, b) => b[1] - a[1]);
  if (rejections.length > 0) {
    lines.push('', `rejections: ${rejections.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  const nulls = [
    metrics.mrMergeRate === null ? 'merge rate' : null,
    metrics.escapeRate === null ? 'escape rate' : null,
    metrics.rcaAccuracy === null ? 'RCA accuracy' : null,
  ].filter(Boolean);
  if (nulls.length > 0) {
    lines.push('', `Not measured (needs code-host and weekly-review input): ${nulls.join(', ')}.`);
  }
  return lines.join('\n');
}
