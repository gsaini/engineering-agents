import { z } from 'zod';

import type { LogSignal, WorkItem } from '../core/types.js';

/**
 * Golden sets and scores.
 *
 * A golden case is a piece of your own history: what the agent would have seen,
 * plus what actually happened. Everything here is deliberately hand-authorable —
 * these files are written by an engineer reading a closed ticket, not generated,
 * so the seed schemas require only the fields that carry signal and fill the
 * rest (docs/07-evaluation.md#golden-sets).
 */

// ------------------------------------------------------------------- seeds

const workItemSeedSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  rawType: z.string().default('User Story'),
  acceptanceCriteria: z.string().nullable().default(null),
  reproSteps: z.string().nullable().default(null),
  state: z.string().default('New'),
  priority: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  assignee: z.string().nullable().default(null),
  areaPath: z.string().nullable().default(null),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string(),
        createdAt: z.string().default('1970-01-01T00:00:00.000Z'),
      }),
    )
    .default([]),
  filedAt: z.string().default('1970-01-01T00:00:00.000Z'),
});

const logSignalSeedSchema = z.object({
  fingerprint: z.string(),
  title: z.string(),
  service: z.string(),
  environment: z.string().default('production'),
  exceptionType: z.string().nullable().default(null),
  message: z.string().default(''),
  topFrames: z.array(z.string()).default([]),
  count: z.number().int().nonnegative().default(0),
  affectedUsers: z.number().int().nonnegative().nullable().default(null),
  firstSeen: z.string(),
  lastSeen: z.string(),
  versions: z.array(z.string()).default([]),
  hosts: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
});

export const fixClassSchema = z.enum([
  'defensive',
  'contract',
  'concurrency',
  'resource',
  'logging',
  'config',
  'dependency',
]);

// ------------------------------------------------------------ golden cases

export const goldenTicketSchema = z.object({
  id: z.string(),
  /** The work item as it was when filed — not as it looks after the fix. */
  workItem: workItemSeedSchema,
  truth: z.object({
    /** Did a human ultimately treat this as actionable engineering work? */
    actionable: z.boolean(),
    repo: z.string().nullable(),
    /** Files in the merged MR. The precision/recall reference for planning. */
    changedFiles: z.array(z.string()).default([]),
    /** One-line description of the approach the humans actually took. */
    approach: z.string().default(''),
    /** Questions humans raised in the comments before work started. */
    ambiguities: z.array(z.string()).default([]),
    testFiles: z.array(z.string()).default([]),
  }),
});

export const goldenLogSchema = z.object({
  id: z.string(),
  signal: logSignalSeedSchema,
  truth: z.object({
    /** Should the detection query have fired at all? Noise cases say false. */
    shouldFire: z.boolean(),
    /** When a human first noticed. Detection lag is measured against this. */
    humanDetectedAt: z.string().nullable().default(null),
    /** Hand-labelled cluster. Two cases sharing a label are the same problem. */
    clusterLabel: z.string(),
    /** The post-mortem's root cause. The reference the judge scores against. */
    rootCause: z.string(),
    category: fixClassSchema,
    changedFiles: z.array(z.string()).default([]),
  }),
});

export type GoldenTicketCase = z.infer<typeof goldenTicketSchema>;
export type GoldenLogCase = z.infer<typeof goldenLogSchema>;

export interface GoldenSet {
  tickets: GoldenTicketCase[];
  logs: GoldenLogCase[];
}

// ------------------------------------------------------------------ scores

/**
 * Overlap of two sets of strings.
 *
 * File overlap is a proxy, not truth — a better approach that touches different
 * files scores badly. Treat a drop as a signal to look, not as a verdict.
 */
export interface SetScore {
  precision: number;
  recall: number;
  f1: number;
  matched: string[];
  missed: string[];
  spurious: string[];
}

/** One scored stage of one case. `score` is always 0..1 so stages aggregate. */
export interface StageScore {
  stage: string;
  score: number;
  detail: Record<string, unknown>;
}

export interface CaseResult {
  caseId: string;
  agent: 'ticket-to-mr' | 'log-triage';
  stages: StageScore[];
  /** Where the pipeline actually stopped — a skip is itself a scored outcome. */
  outcome: string;
  costUsd: number;
  durationMs: number;
  error: string | null;
}

// ------------------------------------------------------------- hydration

/** Fill a seed out into the full domain type the pipelines consume. */
export function hydrateWorkItem(seed: GoldenTicketCase['workItem'], sourceId: string): WorkItem {
  return {
    id: seed.key,
    key: seed.key,
    sourceId,
    type: inferType(seed.rawType),
    rawType: seed.rawType,
    title: seed.title,
    description: seed.description,
    acceptanceCriteria: seed.acceptanceCriteria,
    reproSteps: seed.reproSteps,
    state: seed.state,
    priority: seed.priority,
    labels: seed.labels,
    assignee: seed.assignee,
    areaPath: seed.areaPath,
    parent: null,
    links: [],
    comments: seed.comments,
    attachments: [],
    rev: '1',
    url: `golden://${seed.key}`,
    updatedAt: seed.filedAt,
    raw: {},
  };
}

function inferType(rawType: string): WorkItem['type'] {
  const t = rawType.toLowerCase();
  if (t.includes('bug') || t.includes('defect')) return 'bug';
  if (t.includes('story')) return 'story';
  if (t.includes('task')) return 'task';
  return 'other';
}

export function hydrateSignal(seed: GoldenLogCase['signal'], sourceId: string): LogSignal {
  return {
    id: `${sourceId}:${seed.fingerprint}`,
    sourceId,
    fingerprint: seed.fingerprint,
    title: seed.title,
    service: seed.service,
    environment: seed.environment,
    level: 'error',
    count: seed.count,
    affectedUsers: seed.affectedUsers,
    firstSeen: seed.firstSeen,
    lastSeen: seed.lastSeen,
    exceptionType: seed.exceptionType,
    topFrames: seed.topFrames,
    sampleEvents: seed.message
      ? [
          {
            timestamp: seed.firstSeen,
            message: seed.message,
            stackTrace: seed.topFrames.join('\n') || null,
            traceId: null,
            attributes: { service: seed.service },
          },
        ]
      : [],
    versions: seed.versions,
    hosts: seed.hosts,
    regions: seed.regions,
    query: '(golden set: replayed, not queried)',
    dashboardUrl: null,
    raw: {},
  };
}
