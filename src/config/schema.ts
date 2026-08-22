import { z } from 'zod';

/**
 * Config is validated at startup, so a typo in a provider field name fails
 * immediately rather than at 3am in the middle of a run.
 */

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const autonomySchema = z.enum(['observe', 'comment', 'propose', 'autonomous']);

export const runtimeSchema = z.object({
  runStoreDir: z.string().default('.runs'),
  worktreeDir: z.string().default('.worktrees'),
  pollIntervalSeconds: z.number().int().positive().default(120),
  maxConcurrentRuns: z.number().int().positive().default(5),
  resumeOnStartup: z.boolean().default(true),
  worktreeTtlHours: z.number().positive().default(24),
});

export const modelSchema = z.object({
  name: z.string().default('claude-opus-5'),
  effort: z
    .object({
      triage: effortSchema.default('low'),
      analyze: effortSchema.default('high'),
      plan: effortSchema.default('xhigh'),
      rootCause: effortSchema.default('xhigh'),
      implement: effortSchema.default('xhigh'),
      verify: effortSchema.default('high'),
      publish: effortSchema.default('low'),
    })
    .default({}),
  maxTurnsPerStage: z.number().int().positive().default(60),
});

const evidenceSchema = z.object({
  maxFilesRead: z.number().int().positive().default(60),
  maxBytesRead: z.number().int().positive().default(800_000),
  includeGitHistoryDays: z.number().int().nonnegative().default(90),
  includeComments: z.boolean().default(true),
  includeLinkedItems: z.boolean().default(true),
});

export const ticketToMrSchema = z.object({
  enabled: z.boolean().default(false),
  autonomy: autonomySchema.default('observe'),
  sources: z.array(z.string()).min(1),
  codeHost: z.string(),
  notifier: z.string(),
  workItemTypes: z.array(z.string()).default(['Bug', 'User Story', 'Task']),
  requireLabel: z.string().nullable().default(null),
  denyLabels: z.array(z.string()).default(['no-agent']),
  claimAssigned: z.boolean().default(false),
  triageConfidenceThreshold: z.number().min(0).max(1).default(0.6),
  // Rungs 2 and 3 of the ladder are both `propose`; this is what separates
  // them (docs/08-rollout.md). Draft is the safe default: a draft MR is visible
  // without paging reviewers or burning CI on every agent attempt.
  draftMergeRequests: z.boolean().default(true),
  maxPlanRevisions: z.number().int().nonnegative().default(2),
  maxFixAttempts: z.number().int().positive().default(3),
  approvalTtlHours: z.number().positive().default(72),
  evidence: evidenceSchema.default({}),
  repoMapping: z.record(z.string()).default({}),
  budgetUsdPerRun: z.number().positive().default(8),
});

export const logTriageSchema = z.object({
  enabled: z.boolean().default(false),
  autonomy: autonomySchema.default('observe'),
  sources: z.array(z.string()).min(1),
  codeHost: z.string(),
  notifier: z.string(),
  detection: z
    .object({
      mode: z.enum(['new-fingerprint', 'rate-threshold', 'slo-burn']).default('new-fingerprint'),
      windowMinutes: z.number().int().positive().default(15),
      minOccurrences: z.number().int().positive().default(25),
      minAffectedUsers: z.number().int().nonnegative().default(3),
      lookbackDaysForNovelty: z.number().int().positive().default(7),
    })
    .default({}),
  suppression: z
    .object({
      maxNewRunsPerHour: z.number().int().positive().default(3),
      knownIssues: z
        .array(
          z.object({
            fingerprint: z.string(),
            reason: z.string(),
            // Entries must expire, or the list becomes a permanent blind spot.
            expires: z.coerce.date(),
          }),
        )
        .default([]),
    })
    .default({}),
  rcaConfidenceThreshold: z.number().min(0).max(1).default(0.7),
  draftMergeRequests: z.boolean().default(true),
  fixClasses: z
    .object({
      autoPropose: z.array(z.string()).default(['defensive', 'contract', 'logging']),
      flagOnly: z.array(z.string()).default(['concurrency', 'resource']),
      neverPropose: z.array(z.string()).default(['config', 'dependency']),
    })
    .default({}),
  verificationWindowHours: z.number().positive().default(48),
  approvalTtlHours: z.number().positive().default(24),
  maxFixAttempts: z.number().int().positive().default(3),
  serviceRepoMapping: z.record(z.string()).default({}),
  budgetUsdPerRun: z.number().positive().default(10),
});

const connectorSchema = z.object({
  id: z.string(),
  provider: z.string(),
  // Provider options are validated by the provider itself at construction, so
  // an unknown provider fails with its own message rather than a schema error.
  options: z.record(z.unknown()).default({}),
});

export const guardrailsSchema = z.object({
  protectedPaths: z.array(z.string()).default(['.github/workflows/**', '**/*.pem', '**/secrets/**']),
  sensitivePaths: z.array(z.string()).default([]),
  allowedCommands: z.array(z.string()).default([]),
  denyNetworkDuringTests: z.boolean().default(true),
  injectionDetection: z.boolean().default(true),
  redaction: z
    .object({
      enabled: z.boolean().default(true),
      piiCategories: z.array(z.string()).default(['email', 'phone', 'creditcard']),
      extraPatterns: z.array(z.string()).default([]),
    })
    .default({}),
  limits: z
    .object({
      maxFilesChanged: z.number().int().positive().default(15),
      maxLinesChanged: z.number().int().positive().default(600),
      overrunFactor: z.number().positive().default(3),
      concurrentRuns: z.number().int().positive().default(5),
      runsPerDay: z.number().int().positive().default(40),
      usdPerRun: z.number().positive().default(8),
      usdPerDay: z.number().positive().default(200),
    })
    .default({}),
});

export const configSchema = z.object({
  runtime: runtimeSchema.default({}),
  model: modelSchema.default({}),
  agents: z.object({
    ticketToMr: ticketToMrSchema.optional(),
    logTriage: logTriageSchema.optional(),
  }),
  workItemSources: z.array(connectorSchema).default([]),
  logSources: z.array(connectorSchema).default([]),
  codeHosts: z.array(connectorSchema).default([]),
  notifiers: z.array(connectorSchema).default([]),
  guardrails: guardrailsSchema.default({}),
  observability: z
    .object({
      logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      retentionDays: z.number().int().positive().default(90),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type TicketToMrConfig = z.infer<typeof ticketToMrSchema>;
export type LogTriageConfig = z.infer<typeof logTriageSchema>;
export type GuardrailsConfig = z.infer<typeof guardrailsSchema>;
export type ConnectorConfig = z.infer<typeof connectorSchema>;
