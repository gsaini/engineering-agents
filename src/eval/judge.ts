import { z } from 'zod';

import type { AgentRunner } from '../agent/runner.js';
import { sha256 } from '../core/ids.js';
import { mean, tokenOverlap } from './scorers.js';

/**
 * LLM-as-judge for the stages no metric can score: was the requirement
 * restated faithfully, is this root cause the one the post-mortem found.
 *
 * Three precautions from docs/07-evaluation.md are built into the types rather
 * than left to discipline:
 *
 * 1. The judge sees the reference and the candidate's *conclusion* — there is
 *    no field on `JudgeRequest` for the agent's reasoning transcript, because a
 *    judge that reads the reasoning grades the argument instead of the answer.
 * 2. Rubrics are per-criterion. A single 1-10 is not reproducible between two
 *    judges, let alone between a judge and a human.
 * 3. Agreement with human labels is measurable (`judgeAgreement`), because a
 *    judge nobody has checked is an opinion with a cost per token.
 */

export interface RubricCriterion {
  id: string;
  question: string;
  /** Relative weight within the rubric. Normalised at scoring time. */
  weight: number;
}

export interface Rubric {
  id: string;
  /** What the reference is, in the judge's own terms. */
  referenceLabel: string;
  candidateLabel: string;
  criteria: RubricCriterion[];
}

export interface JudgeRequest {
  rubric: Rubric;
  /** Ground truth: the merged MR's description, the post-mortem, the real plan. */
  reference: string;
  /** The agent's conclusion only. Never its transcript. */
  candidate: string;
}

export interface JudgeVerdict {
  /** Per-criterion, 0..1. */
  scores: Record<string, number>;
  /** Weighted mean of the criteria. */
  overall: number;
  notes: string;
  /** False when the judge was a deterministic proxy rather than a model. */
  modelJudged: boolean;
}

export interface Judge {
  assess(request: JudgeRequest): Promise<JudgeVerdict>;
}

// ------------------------------------------------------------------ rubrics

export const RESTATEMENT_RUBRIC: Rubric = {
  id: 'restatement',
  referenceLabel: 'the requirement as the team actually implemented it',
  candidateLabel: "the agent's restatement of the requirement",
  criteria: [
    { id: 'captures-intent', question: 'Does the restatement capture the same user-visible outcome?', weight: 3 },
    { id: 'no-invention', question: 'Is the restatement free of requirements nobody asked for?', weight: 2 },
    { id: 'scope-boundary', question: 'Does it draw the same in-scope/out-of-scope line?', weight: 2 },
    { id: 'specific', question: 'Is it specific enough to plan against, rather than a paraphrase of the title?', weight: 1 },
  ],
};

export const APPROACH_RUBRIC: Rubric = {
  id: 'approach',
  referenceLabel: 'the approach the engineers took in the merged change',
  candidateLabel: "the agent's proposed approach",
  criteria: [
    { id: 'same-mechanism', question: 'Does it propose the same mechanism, or an equally sound alternative?', weight: 3 },
    { id: 'right-layer', question: 'Does it change the same layer of the system?', weight: 2 },
    { id: 'handles-edges', question: 'Does it address the edge cases the real change handled?', weight: 2 },
  ],
};

export const RCA_RUBRIC: Rubric = {
  id: 'rca',
  referenceLabel: 'the root cause recorded in the post-mortem',
  candidateLabel: "the agent's root-cause hypothesis",
  criteria: [
    { id: 'same-cause', question: 'Does the hypothesis identify the same underlying cause?', weight: 4 },
    { id: 'mechanism', question: 'Does it explain the mechanism, not just the symptom?', weight: 2 },
    { id: 'evidence', question: 'Is each claim in the chain supported by the evidence cited?', weight: 2 },
    { id: 'no-overreach', question: 'Does it avoid asserting causes the evidence does not support?', weight: 1 },
  ],
};

// ------------------------------------------------------------------- judges

const verdictSchema = z.object({
  scores: z.record(z.number().min(0).max(1)),
  notes: z.string(),
});

/**
 * Model-backed judge.
 *
 * Runs with no tools and no working directory: judging is a reading task, and
 * a judge that can read the repository can talk itself into agreeing.
 */
export class AgentJudge implements Judge {
  constructor(
    private readonly runner: AgentRunner,
    private readonly model: string,
    private readonly budgetUsd = 0.5,
  ) {}

  async assess(request: JudgeRequest): Promise<JudgeVerdict> {
    const { rubric } = request;
    const result = await this.runner.run<z.infer<typeof verdictSchema>>({
      stage: `judge:${rubric.id}`,
      system:
        'You are grading one output against a reference. Score each criterion independently ' +
        'from 0 to 1. Judge only what is written; do not reward confident phrasing, and do not ' +
        'penalise a different but equally sound solution. Return JSON only.',
      prompt: renderRubricPrompt(request),
      cwd: process.cwd(),
      toolPolicy: 'none',
      effort: 'high',
      model: this.model,
      maxTurns: 1,
      budgetUsd: this.budgetUsd,
      schema: verdictSchema,
      allowedCommands: [],
      protectedPaths: [],
    });

    if (!result.ok || !result.data) {
      return { scores: {}, overall: 0, notes: result.error ?? 'judge returned no verdict', modelJudged: false };
    }
    return {
      scores: result.data.scores,
      overall: weightedOverall(rubric, result.data.scores),
      notes: result.data.notes,
      modelJudged: true,
    };
  }
}

/**
 * Deterministic stand-in used in CI and tests.
 *
 * Lexical overlap is a weak proxy for agreement and is labelled as such
 * (`modelJudged: false`) so a report can never present it as a graded result.
 * Its job is to keep the harness runnable with no credentials, which is what
 * makes the harness itself testable.
 */
export class LexicalJudge implements Judge {
  async assess(request: JudgeRequest): Promise<JudgeVerdict> {
    const overlap = tokenOverlap(request.candidate, request.reference);
    const scores = Object.fromEntries(request.rubric.criteria.map((c) => [c.id, overlap]));
    return {
      scores,
      overall: overlap,
      notes: 'Lexical overlap only — not a graded judgement.',
      modelJudged: false,
    };
  }
}

export function renderRubricPrompt(request: JudgeRequest): string {
  const criteria = request.rubric.criteria
    .map((c) => `- "${c.id}": ${c.question}`)
    .join('\n');
  return [
    `## Reference — ${request.rubric.referenceLabel}`,
    request.reference,
    '',
    `## Candidate — ${request.rubric.candidateLabel}`,
    request.candidate,
    '',
    '## Criteria',
    criteria,
    '',
    'Return JSON: {"scores": {"<criterion-id>": 0.0-1.0, ...}, "notes": "one sentence per criterion below 0.7"}',
  ].join('\n');
}

function weightedOverall(rubric: Rubric, scores: Record<string, number>): number {
  const total = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  if (total === 0) return 0;
  return rubric.criteria.reduce((sum, c) => sum + c.weight * (scores[c.id] ?? 0), 0) / total;
}

// -------------------------------------------------------------- calibration

/**
 * Agreement between judge scores and human labels on a held-out slice.
 *
 * Below roughly 0.8 the rubric is the problem, not the agent — which is why
 * this is reported next to every judged metric rather than kept in a notebook.
 */
export function judgeAgreement(
  pairs: readonly { judge: number; human: number }[],
  tolerance = 0.25,
): { agreement: number; meanAbsoluteError: number; n: number; trustworthy: boolean } {
  if (pairs.length === 0) return { agreement: 0, meanAbsoluteError: 0, n: 0, trustworthy: false };
  const errors = pairs.map((p) => Math.abs(p.judge - p.human));
  const agreement = errors.filter((e) => e <= tolerance).length / pairs.length;
  return {
    agreement,
    meanAbsoluteError: mean(errors),
    n: pairs.length,
    trustworthy: agreement >= 0.8 && pairs.length >= 20,
  };
}

/**
 * The 10% a human reads forever.
 *
 * Chosen by hash of the case id rather than at random, so the same cases are
 * sampled across runs and a reviewer can see whether a case they flagged moved.
 */
export function selectSpotCheck<T extends { caseId: string }>(results: readonly T[], fraction = 0.1): T[] {
  if (fraction <= 0) return [];
  const threshold = Math.floor(fraction * 0xffff);
  return results.filter((r) => parseInt(sha256('spot-check', r.caseId).slice(0, 4), 16) <= threshold);
}
