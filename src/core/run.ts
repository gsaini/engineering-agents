import type { AutonomyLevel, LogEvidence, LogSignal, RiskLevel, WorkItem } from './types.js';

/**
 * Run state machine. See docs/01-architecture.md for the diagram.
 *
 * State is a fold over an append-only event log, which is what makes runs
 * resumable after a crash and exactly auditable afterwards.
 */
export type RunState =
  | 'QUEUED'
  | 'TRIAGING'
  | 'ANALYZING'
  | 'NEEDS_INFO'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'PUBLISHING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SKIPPED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
]);

/** Legal transitions. Anything not listed here is a bug, not a policy choice. */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  QUEUED: ['TRIAGING', 'CANCELLED', 'FAILED'],
  TRIAGING: ['ANALYZING', 'SKIPPED', 'NEEDS_INFO', 'FAILED', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'NEEDS_INFO', 'FAILED', 'CANCELLED'],
  NEEDS_INFO: ['ANALYZING', 'EXPIRED', 'CANCELLED'],
  PLANNING: ['AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['IMPLEMENTING', 'PLANNING', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  IMPLEMENTING: ['VERIFYING', 'PLANNING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['PUBLISHING', 'IMPLEMENTING', 'FAILED', 'CANCELLED'],
  PUBLISHING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  SKIPPED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`Illegal run transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

// ---------------------------------------------------------------- artefacts

export interface TriageResult {
  actionable: boolean;
  reason: string;
  repo: string | null;
  repoResolvedBy: 'explicit' | 'area-mapping' | 'inference' | 'unresolved';
  confidence: number;
}

export interface Assumption {
  assumption: string;
  basis: string;
  risk: RiskLevel;
}

export interface OpenQuestion {
  question: string;
  blocking: boolean;
  whyItMatters: string;
  suggestedDefault: string;
}

export interface Analysis {
  restatement: string;
  inScopeBehaviour: string[];
  outOfScope: string[];
  assumptions: Assumption[];
  openQuestions: OpenQuestion[];
  affectedAreas: { path: string; why: string; confidence: number }[];
  existingCoverage: { hasTests: boolean; testFiles: string[]; gap: string };
  risk: { level: RiskLevel; factors: string[] };
}

export interface PlanChange {
  file: string;
  change: string;
  why: string;
}

export interface Plan {
  understanding: string;
  approach: string;
  rejectedAlternative: string;
  changes: PlanChange[];
  tests: string[];
  assumptions: Assumption[];
  risk: { level: RiskLevel; factors: string[] };
  blastRadius: {
    filesChanged: number;
    linesChanged: number;
    publicApiChange: boolean;
    schemaChange: boolean;
    configChange: boolean;
    deployOrderNote: string | null;
  };
  outOfScope: string[];
  rollback: string;
  /** Markdown rendering posted to the tracker and the chat notification. */
  markdown: string;
}

export type FixClass =
  | 'defensive'
  | 'contract'
  | 'concurrency'
  | 'resource'
  | 'logging'
  | 'config'
  | 'dependency';

export interface RootCause {
  hypothesis: string;
  evidenceChain: { claim: string; evidence: string }[];
  confidence: number;
  alternativeHypotheses: { hypothesis: string; whyLessLikely: string }[];
  category: FixClass;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reproduction: string;
  whyTestsMissedIt: string;
  notACodeIssue: boolean;
}

export type ApprovalDecision = 'approve' | 'approve-with-edits' | 'request-changes' | 'reject';

export type RejectionReason =
  | 'wrong-approach'
  | 'misunderstood-requirement'
  | 'too-risky'
  | 'already-being-done'
  | 'not-worth-doing'
  | 'wrong-repo-or-area'
  | 'other';

export interface Approval {
  decision: ApprovalDecision;
  actor: string;
  at: string;
  feedback: string | null;
  rejectionReason: RejectionReason | null;
  /** Present for approve-with-edits: the human's plan replaces the agent's. */
  editedPlanMarkdown: string | null;
}

export interface ImplementationResult {
  status: 'complete' | 'partial' | 'plan_invalid';
  summary: string;
  deviations: { file: string; reason: string }[];
  observations: string[];
  commits: string[];
  filesChanged: string[];
  linesChanged: number;
}

export interface ReviewFinding {
  file: string;
  line: number;
  severity: 'blocking' | 'important' | 'nit';
  summary: string;
  failureScenario: string;
}

export interface SelfReview {
  findings: ReviewFinding[];
  planConformance: { followed: boolean; missing: string[]; extra: string[] };
  verdict: 'ready' | 'needs-fixes';
}

// ---------------------------------------------------------------- events

export type RunActor = `agent` | `system:${string}` | `user:${string}`;

export interface RunEvent {
  seq: number;
  at: string;
  actor: RunActor;
  type:
    | 'created'
    | 'transition'
    | 'artefact'
    | 'note'
    | 'tool-denied'
    | 'cost'
    | 'error';
  from?: RunState;
  to?: RunState;
  artefact?: keyof RunArtefacts;
  payload?: unknown;
}

export interface RunArtefacts {
  triage?: TriageResult;
  analysis?: Analysis;
  evidence?: LogEvidence;
  rootCause?: RootCause;
  plan?: Plan;
  approval?: Approval;
  implementation?: ImplementationResult;
  selfReview?: SelfReview;
  mergeRequestUrl?: string;
}

export type TriggerPayload =
  | { kind: 'work-item'; workItem: WorkItem }
  | { kind: 'log-signal'; signal: LogSignal };

export interface RunMeta {
  runId: string;
  agent: 'ticket-to-mr' | 'log-triage';
  sourceId: string;
  idempotencyKey: string;
  autonomy: AutonomyLevel;
  repo: string | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  promptVersions: Record<string, number>;
}

export interface RunCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  byStage: Record<string, { usd: number; ms: number }>;
}

export interface Run {
  meta: RunMeta;
  state: RunState;
  trigger: TriggerPayload;
  artefacts: RunArtefacts;
  cost: RunCost;
  events: RunEvent[];
  failure: { stage: string; message: string } | null;
}

export function emptyCost(): RunCost {
  return { usd: 0, inputTokens: 0, outputTokens: 0, byStage: {} };
}

/** Rebuild current run state from its event log. */
export function applyEvent(run: Run, event: RunEvent): Run {
  const next: Run = {
    ...run,
    events: [...run.events, event],
    meta: { ...run.meta, updatedAt: event.at },
  };
  if (event.type === 'transition' && event.to) {
    next.state = event.to;
  }
  if (event.type === 'artefact' && event.artefact) {
    next.artefacts = { ...run.artefacts, [event.artefact]: event.payload };
  }
  if (event.type === 'cost') {
    const p = event.payload as { stage: string; usd: number; ms: number; input: number; output: number };
    next.cost = {
      usd: run.cost.usd + p.usd,
      inputTokens: run.cost.inputTokens + p.input,
      outputTokens: run.cost.outputTokens + p.output,
      byStage: { ...run.cost.byStage, [p.stage]: { usd: p.usd, ms: p.ms } },
    };
  }
  if (event.type === 'error') {
    next.failure = event.payload as { stage: string; message: string };
  }
  return next;
}

export function foldEvents(seed: Run, events: readonly RunEvent[]): Run {
  return events.reduce<Run>(applyEvent, seed);
}
