import { mean, median } from './scorers.js';
import type { CaseResult } from './types.js';

/**
 * Aggregation and the CI regression gate.
 *
 * A prompt change is a code change, so it gets the same treatment: run the
 * golden set, compare per stage against the recorded baseline, and block on a
 * drop. Absolute thresholds are deliberately *not* the gate — golden-set scores
 * are proxies whose absolute value depends on how the set was built, while the
 * delta between two runs of the same set is meaningful (docs/07-evaluation.md).
 */

export interface StageAggregate {
  stage: string;
  n: number;
  mean: number;
  median: number;
  /** Worst three cases, so a regression points at something to open. */
  worstCases: { caseId: string; score: number }[];
}

export interface EvalReport {
  /** Stamped so a score is attributable to a prompt and retrieval config. */
  variant: string;
  generatedAt: string;
  cases: number;
  errors: number;
  stages: StageAggregate[];
  outcomes: Record<string, number>;
  cost: { totalUsd: number; meanUsdPerCase: number };
  /** True when every judged stage used a real judge rather than the proxy. */
  modelJudged: boolean;
}

export function buildReport(
  results: readonly CaseResult[],
  options: { variant?: string; generatedAt?: string; modelJudged?: boolean } = {},
): EvalReport {
  const stageNames = [...new Set(results.flatMap((r) => r.stages.map((s) => s.stage)))];
  const stages = stageNames.map<StageAggregate>((stage) => {
    const scored = results
      .flatMap((r) => r.stages.filter((s) => s.stage === stage).map((s) => ({ caseId: r.caseId, score: s.score })))
      .sort((a, b) => a.score - b.score);
    return {
      stage,
      n: scored.length,
      mean: mean(scored.map((s) => s.score)),
      median: median(scored.map((s) => s.score)),
      worstCases: scored.slice(0, 3),
    };
  });

  const outcomes: Record<string, number> = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const totalUsd = results.reduce((sum, r) => sum + r.costUsd, 0);

  return {
    variant: options.variant ?? 'default',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    cases: results.length,
    errors: results.filter((r) => r.error !== null).length,
    stages: stages.sort((a, b) => a.stage.localeCompare(b.stage)),
    outcomes,
    cost: { totalUsd, meanUsdPerCase: results.length === 0 ? 0 : totalUsd / results.length },
    modelJudged: options.modelJudged ?? false,
  };
}

// ----------------------------------------------------------- regression gate

export interface RegressionFinding {
  stage: string;
  baseline: number;
  current: number;
  delta: number;
  severity: 'blocking' | 'warning';
}

export interface RegressionVerdict {
  pass: boolean;
  findings: RegressionFinding[];
  /** Stages present in one report but not the other — usually a renamed stage. */
  unmatched: string[];
}

/**
 * Compare against a baseline.
 *
 * `tolerance` is the drop allowed before the gate fails. Stage scores move a
 * little between runs even with a fixed model, so a zero tolerance blocks on
 * noise and gets disabled within a week, which is worse than a loose gate.
 */
export function checkRegression(
  current: EvalReport,
  baseline: EvalReport,
  options: { tolerance?: number; warnAt?: number } = {},
): RegressionVerdict {
  const tolerance = options.tolerance ?? 0.05;
  const warnAt = options.warnAt ?? tolerance / 2;
  const findings: RegressionFinding[] = [];
  const unmatched: string[] = [];

  for (const base of baseline.stages) {
    const now = current.stages.find((s) => s.stage === base.stage);
    if (!now) {
      unmatched.push(base.stage);
      continue;
    }
    const delta = now.mean - base.mean;
    if (delta < -tolerance) {
      findings.push({ stage: base.stage, baseline: base.mean, current: now.mean, delta, severity: 'blocking' });
    } else if (delta < -warnAt) {
      findings.push({ stage: base.stage, baseline: base.mean, current: now.mean, delta, severity: 'warning' });
    }
  }
  for (const now of current.stages) {
    if (!baseline.stages.some((s) => s.stage === now.stage)) unmatched.push(now.stage);
  }

  return { pass: !findings.some((f) => f.severity === 'blocking'), findings, unmatched };
}

// ---------------------------------------------------------------- rendering

export function renderReport(report: EvalReport, verdict?: RegressionVerdict): string {
  const lines = [
    `Golden set — variant "${report.variant}"`,
    `${report.cases} cases, ${report.errors} errors, $${report.cost.totalUsd.toFixed(2)} total ` +
      `($${report.cost.meanUsdPerCase.toFixed(3)}/case)`,
    '',
    'stage'.padEnd(14) + 'n'.padStart(4) + 'mean'.padStart(9) + 'median'.padStart(9),
  ];
  for (const s of report.stages) {
    lines.push(
      s.stage.padEnd(14) + String(s.n).padStart(4) + s.mean.toFixed(3).padStart(9) + s.median.toFixed(3).padStart(9),
    );
  }

  if (!report.modelJudged) {
    lines.push('', 'Subjective stages scored by lexical proxy, not a judge — treat as a smoke test.');
  }

  const outcomes = Object.entries(report.outcomes).sort((a, b) => b[1] - a[1]);
  if (outcomes.length > 0) {
    lines.push('', `outcomes: ${outcomes.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  const worst = report.stages.flatMap((s) => s.worstCases.map((c) => ({ stage: s.stage, ...c })));
  if (worst.length > 0) {
    lines.push('', 'weakest cases:');
    for (const w of worst.sort((a, b) => a.score - b.score).slice(0, 5)) {
      lines.push(`  ${w.score.toFixed(2)}  ${w.stage.padEnd(12)} ${w.caseId}`);
    }
  }

  if (verdict) {
    lines.push('', verdict.pass ? 'Regression gate: PASS' : 'Regression gate: FAIL');
    for (const f of verdict.findings) {
      lines.push(
        `  ${f.severity === 'blocking' ? '✗' : '!'} ${f.stage}: ${f.baseline.toFixed(3)} → ${f.current.toFixed(3)} (${f.delta.toFixed(3)})`,
      );
    }
    for (const stage of verdict.unmatched) lines.push(`  ? ${stage}: present in only one report`);
  }

  return lines.join('\n');
}
