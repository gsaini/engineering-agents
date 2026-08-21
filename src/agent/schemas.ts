import { z } from 'zod';

/**
 * Stage output schemas.
 *
 * These are the contract between the model and the pipeline. Validation happens
 * at the boundary, so a malformed stage output fails there rather than three
 * stages later with a confusing error.
 */

const riskSchema = z.enum(['low', 'medium', 'high']);

export const triageSchema = z.object({
  actionable: z.boolean(),
  reason: z.string().min(1),
  repo: z.string().nullable(),
  repoResolvedBy: z.enum(['explicit', 'area-mapping', 'inference', 'unresolved']),
  confidence: z.number().min(0).max(1),
});

export const assumptionSchema = z.object({
  assumption: z.string().min(1),
  basis: z.string().min(1),
  risk: riskSchema,
});

export const analysisSchema = z.object({
  restatement: z.string().min(1),
  inScopeBehaviour: z.array(z.string()),
  outOfScope: z.array(z.string()),
  assumptions: z.array(assumptionSchema),
  openQuestions: z.array(
    z.object({
      question: z.string().min(1),
      blocking: z.boolean(),
      whyItMatters: z.string().min(1),
      suggestedDefault: z.string(),
    }),
  ),
  affectedAreas: z.array(
    z.object({ path: z.string().min(1), why: z.string().min(1), confidence: z.number().min(0).max(1) }),
  ),
  existingCoverage: z.object({
    hasTests: z.boolean(),
    testFiles: z.array(z.string()),
    gap: z.string(),
  }),
  risk: z.object({ level: riskSchema, factors: z.array(z.string()) }),
});

export const planSchema = z.object({
  understanding: z.string().min(1),
  approach: z.string().min(1),
  // Required, not optional: the rejected alternative is the fastest signal to a
  // reviewer that the design space was considered.
  rejectedAlternative: z.string().min(1),
  changes: z
    .array(z.object({ file: z.string().min(1), change: z.string().min(1), why: z.string().min(1) }))
    .min(1),
  tests: z.array(z.string()).min(1),
  assumptions: z.array(assumptionSchema),
  risk: z.object({ level: riskSchema, factors: z.array(z.string()) }),
  blastRadius: z.object({
    filesChanged: z.number().int().nonnegative(),
    linesChanged: z.number().int().nonnegative(),
    publicApiChange: z.boolean(),
    schemaChange: z.boolean(),
    configChange: z.boolean(),
    deployOrderNote: z.string().nullable(),
  }),
  outOfScope: z.array(z.string()),
  rollback: z.string().min(1),
  markdown: z.string().min(1),
});

export const rootCauseSchema = z.object({
  hypothesis: z.string().min(1),
  // Required and non-empty: a hypothesis with no evidence chain is a guess, and
  // a guess posted to an incident channel costs more trust than silence.
  evidenceChain: z.array(z.object({ claim: z.string().min(1), evidence: z.string().min(1) })).min(1),
  confidence: z.number().min(0).max(1),
  // Required: the cheapest defence against committing to the first idea.
  alternativeHypotheses: z
    .array(z.object({ hypothesis: z.string().min(1), whyLessLikely: z.string().min(1) }))
    .min(1),
  category: z.enum(['defensive', 'contract', 'concurrency', 'resource', 'logging', 'config', 'dependency']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reproduction: z.string(),
  // Required: it is what places the regression test correctly.
  whyTestsMissedIt: z.string().min(1),
  notACodeIssue: z.boolean(),
});

export const implementationSchema = z.object({
  status: z.enum(['complete', 'partial', 'plan_invalid']),
  summary: z.string().min(1),
  deviations: z.array(z.object({ file: z.string(), reason: z.string() })),
  observations: z.array(z.string()),
  commits: z.array(z.string()),
  filesChanged: z.array(z.string()),
  linesChanged: z.number().int().nonnegative(),
});

export const selfReviewSchema = z.object({
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      severity: z.enum(['blocking', 'important', 'nit']),
      summary: z.string().min(1),
      // Required: a finding without a concrete failure is a style opinion.
      failureScenario: z.string().min(1),
    }),
  ),
  planConformance: z.object({
    followed: z.boolean(),
    missing: z.array(z.string()),
    extra: z.array(z.string()),
  }),
  verdict: z.enum(['ready', 'needs-fixes']),
});

export const STAGE_SCHEMAS = {
  triage: triageSchema,
  analyze: analysisSchema,
  plan: planSchema,
  rootCause: rootCauseSchema,
  implement: implementationSchema,
  verify: selfReviewSchema,
} as const;

export type StageName = keyof typeof STAGE_SCHEMAS;
