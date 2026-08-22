import type { Analysis, Plan, RootCause, TriageResult } from '../core/run.js';
import type { LogSignal } from '../core/types.js';
import type { GoldenLogCase, GoldenTicketCase, SetScore, StageScore } from './types.js';

/**
 * Per-stage scorers.
 *
 * All pure, all deterministic, all 0..1 — so a stage score means the same thing
 * whether it came from a file-overlap metric or an LLM judge, and the aggregate
 * in report.ts can treat them uniformly (docs/07-evaluation.md).
 *
 * Subjective stages (analysis quality, RCA correctness) take a judge score as
 * an input rather than calling one, which keeps this file testable without a
 * model and keeps the judge on one seam.
 */

// ------------------------------------------------------------------- shared

/** Precision/recall/F1 over two sets of strings, compared case-insensitively. */
export function setScore(predicted: readonly string[], actual: readonly string[]): SetScore {
  const norm = (s: string): string => s.trim().replace(/^\.\//, '').toLowerCase();
  const pred = new Set(predicted.map(norm));
  const act = new Set(actual.map(norm));

  if (act.size === 0) {
    // Both empty is agreement: the case changed nothing and the agent proposed
    // nothing. An empty reference with a non-empty prediction is not — report
    // zeroes rather than an F1 of 1, which would quietly turn "we have no
    // ground truth" into a perfect result.
    const agreed = pred.size === 0;
    return { precision: agreed ? 1 : 0, recall: agreed ? 1 : 0, f1: agreed ? 1 : 0, matched: [], missed: [], spurious: [...pred] };
  }

  const matched = [...pred].filter((p) => act.has(p));
  const precision = pred.size === 0 ? 0 : matched.length / pred.size;
  const recall = matched.length / act.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    recall,
    f1,
    matched,
    missed: [...act].filter((a) => !pred.has(a)),
    spurious: [...pred].filter((p) => !act.has(p)),
  };
}

/**
 * Fraction of reference items that have a close-enough match among candidates.
 *
 * Used where the reference is a sentence rather than a path: two people phrase
 * the same ambiguity differently, so exact matching would score honest agreement
 * as a miss. This is a floor, not a judgement — the judge is the real answer.
 */
export function coverageScore(candidates: readonly string[], reference: readonly string[], threshold = 0.4): number {
  if (reference.length === 0) return 1;
  const hits = reference.filter((r) => candidates.some((c) => tokenOverlap(c, r) >= threshold));
  return hits.length / reference.length;
}

export function tokenOverlap(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3 && !STOP_WORDS.has(t)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size);
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'should', 'would', 'when', 'what',
  'which', 'there', 'their', 'been', 'were', 'will', 'does', 'into', 'than',
  'then', 'they', 'them', 'some', 'only', 'also', 'because', 'about',
]);

// ------------------------------------------------------------- ticket stages

/**
 * Triage is scored on the two things it can get wrong in a way that poisons
 * everything downstream: picking up work it should not have, and resolving the
 * wrong repository. Repo match is exact — "close" is wrong.
 */
export function scoreTriage(triage: TriageResult, truth: GoldenTicketCase['truth']): StageScore {
  const actionableCorrect = triage.actionable === truth.actionable;
  // Repo is only judged on cases the agent was right to pick up.
  const repoApplicable = truth.actionable && triage.actionable;
  const repoCorrect = repoApplicable ? triage.repo === truth.repo : null;
  const score = repoCorrect === null ? (actionableCorrect ? 1 : 0) : (actionableCorrect ? 0.5 : 0) + (repoCorrect ? 0.5 : 0);
  return {
    stage: 'triage',
    score,
    detail: {
      actionableCorrect,
      repoCorrect,
      predictedRepo: triage.repo,
      actualRepo: truth.repo,
      resolvedBy: triage.repoResolvedBy,
      confidence: triage.confidence,
    },
  };
}

/**
 * Analysis is scored on whether it surfaced the ambiguities the humans actually
 * raised — the single strongest predictor of whether a plan survives review.
 * `restatementScore` comes from the judge when one is configured.
 */
export function scoreAnalysis(
  analysis: Analysis,
  truth: GoldenTicketCase['truth'],
  restatementScore: number | null = null,
): StageScore {
  const raised = [
    ...analysis.openQuestions.map((q) => q.question),
    ...analysis.assumptions.map((a) => a.assumption),
  ];
  const ambiguityRecall = coverageScore(raised, truth.ambiguities);
  const areaScore = setScore(
    analysis.affectedAreas.map((a) => a.path),
    truth.changedFiles,
  );
  const parts = [ambiguityRecall, areaScore.f1, ...(restatementScore === null ? [] : [restatementScore])];
  return {
    stage: 'analyze',
    score: mean(parts),
    detail: {
      ambiguityRecall,
      ambiguitiesMissed: truth.ambiguities.filter(
        (a) => !raised.some((r) => tokenOverlap(r, a) >= 0.4),
      ),
      affectedAreaF1: areaScore.f1,
      restatementScore,
      blockingQuestions: analysis.openQuestions.filter((q) => q.blocking).length,
    },
  };
}

/**
 * Plan quality: did it name the files the fix actually touched, and did it name
 * the approach the humans took? Recall is weighted above precision — a plan that
 * misses the file where the bug lives is wrong in a way that an extra file is
 * not.
 */
export function scorePlan(
  plan: Plan,
  truth: GoldenTicketCase['truth'],
  approachScore: number | null = null,
): StageScore {
  const files = setScore(
    plan.changes.map((c) => c.file),
    truth.changedFiles,
  );
  const weighted = 0.35 * files.precision + 0.65 * files.recall;
  const parts = [weighted, ...(approachScore === null ? [] : [approachScore])];
  return {
    stage: 'plan',
    score: mean(parts),
    detail: {
      filePrecision: files.precision,
      fileRecall: files.recall,
      fileF1: files.f1,
      missedFiles: files.missed,
      spuriousFiles: files.spurious,
      approachScore,
      plannedTests: plan.tests.length,
      risk: plan.risk.level,
      blastRadius: plan.blastRadius.filesChanged,
    },
  };
}

/**
 * Implementation is the one stage that cannot be scored from artefacts alone:
 * it needs the repo's own tests run at the pre-fix commit. The caller supplies
 * those two facts; scoring them is trivial, gathering them is not.
 */
export function scoreImplementation(observed: {
  existingTestsPass: boolean;
  agentTestFailsPreFix: boolean;
  filesChanged: string[];
  truth: GoldenTicketCase['truth'];
}): StageScore {
  const files = setScore(observed.filesChanged, observed.truth.changedFiles);
  const score = mean([
    observed.existingTestsPass ? 1 : 0,
    // A regression test that passes before the fix proves nothing.
    observed.agentTestFailsPreFix ? 1 : 0,
    files.f1,
  ]);
  return {
    stage: 'implement',
    score,
    detail: {
      existingTestsPass: observed.existingTestsPass,
      agentTestFailsPreFix: observed.agentTestFailsPreFix,
      fileF1: files.f1,
      missedFiles: files.missed,
    },
  };
}

// ---------------------------------------------------------------- log stages

/**
 * Detection: would the configured query have fired, and how far behind the
 * humans? Lag is the number that decides whether triage is worth automating —
 * an agent that notices an hour after the on-call pager is a report, not a tool.
 */
export function scoreDetection(
  fired: boolean,
  firedAt: string | null,
  truth: GoldenLogCase['truth'],
): StageScore {
  if (!truth.shouldFire) {
    // Noise cases invert: not firing is the correct answer.
    return { stage: 'detect', score: fired ? 0 : 1, detail: { falsePositive: fired } };
  }
  if (!fired) return { stage: 'detect', score: 0, detail: { missed: true } };

  const lagMinutes =
    firedAt && truth.humanDetectedAt
      ? (Date.parse(firedAt) - Date.parse(truth.humanDetectedAt)) / 60_000
      : null;
  // Full credit for beating the humans, decaying to zero over two hours behind.
  const lagScore = lagMinutes === null ? 1 : clamp01(1 - Math.max(0, lagMinutes) / 120);
  return { stage: 'detect', score: 0.5 + 0.5 * lagScore, detail: { lagMinutes, beatHumans: (lagMinutes ?? 0) <= 0 } };
}

/**
 * Fingerprinting is a clustering problem, so it is scored like one: pairwise
 * F1 against hand-labelled clusters. Per-case accuracy would hide the failure
 * that matters — one exception type collapsing two distinct code paths into a
 * single signal.
 */
export function scoreFingerprinting(
  signals: readonly Pick<LogSignal, 'id' | 'fingerprint'>[],
  labels: ReadonlyMap<string, string>,
): StageScore {
  const fingerprints = new Map(signals.map((s) => [s.id, s.fingerprint]));
  const ids = signals.map((s) => s.id).filter((id) => labels.has(id));
  let truePos = 0;
  let falsePos = 0;
  let falseNeg = 0;

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      const sameFingerprint = fingerprints.get(a) === fingerprints.get(b);
      const sameCluster = labels.get(a) === labels.get(b);
      if (sameFingerprint && sameCluster) truePos += 1;
      else if (sameFingerprint && !sameCluster) falsePos += 1;
      else if (!sameFingerprint && sameCluster) falseNeg += 1;
    }
  }

  const pairs = truePos + falsePos + falseNeg;
  if (pairs === 0) return { stage: 'fingerprint', score: 1, detail: { pairs: 0, note: 'no comparable pairs' } };
  const precision = truePos + falsePos === 0 ? 1 : truePos / (truePos + falsePos);
  const recall = truePos + falseNeg === 0 ? 1 : truePos / (truePos + falseNeg);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    stage: 'fingerprint',
    score: f1,
    detail: { pairwisePrecision: precision, pairwiseRecall: recall, truePos, falsePos, falseNeg },
  };
}

/**
 * Root cause: category is checkable mechanically, correctness is not. The
 * judge score carries most of the weight, and calibration is scored too — a
 * confident wrong RCA is worse than a hedged one, because it is the one a
 * reader believes.
 */
export function scoreRootCause(
  rootCause: RootCause,
  truth: GoldenLogCase['truth'],
  judgeScore: number | null = null,
): StageScore {
  const categoryCorrect = rootCause.category === truth.category;
  const overlap = tokenOverlap(rootCause.hypothesis, truth.rootCause);
  const correctness = judgeScore ?? overlap;
  // Confidence should track correctness; penalise the gap in either direction.
  const calibration = 1 - Math.abs(rootCause.confidence - correctness);
  return {
    stage: 'rootCause',
    score: mean([correctness, categoryCorrect ? 1 : 0, calibration]),
    detail: {
      correctness,
      judged: judgeScore !== null,
      lexicalOverlap: overlap,
      categoryCorrect,
      predictedCategory: rootCause.category,
      actualCategory: truth.category,
      confidence: rootCause.confidence,
      calibration,
      alternativesConsidered: rootCause.alternativeHypotheses.length,
    },
  };
}

/** The proposed fix, scored against the files the real fix touched. */
export function scoreFix(plan: Plan, truth: GoldenLogCase['truth']): StageScore {
  const files = setScore(
    plan.changes.map((c) => c.file),
    truth.changedFiles,
  );
  return {
    stage: 'fix',
    score: 0.35 * files.precision + 0.65 * files.recall,
    detail: {
      filePrecision: files.precision,
      fileRecall: files.recall,
      missedFiles: files.missed,
      spuriousFiles: files.spurious,
      hasRegressionTest: plan.tests.length > 0,
    },
  };
}

// ------------------------------------------------------------------ helpers

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
