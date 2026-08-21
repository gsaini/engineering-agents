/**
 * Domain types. Everything a pipeline sees is defined here — no provider ever
 * leaks past the connector boundary.
 */

// ---------------------------------------------------------------- work items

export type WorkItemType = 'bug' | 'story' | 'task' | 'other';

export interface WorkItemLink {
  type: 'parent' | 'child' | 'duplicate' | 'related' | 'merge-request';
  key: string;
  url: string;
}

export interface WorkItemComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface WorkItemAttachment {
  name: string;
  url: string;
  /** Populated only for text-extractable attachments; binaries are listed, not fetched. */
  text?: string;
}

export interface WorkItem {
  id: string;
  key: string;
  sourceId: string;
  type: WorkItemType;
  rawType: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  reproSteps: string | null;
  state: string;
  priority: string | null;
  labels: string[];
  assignee: string | null;
  areaPath: string | null;
  parent: WorkItemLink | null;
  links: WorkItemLink[];
  comments: WorkItemComment[];
  attachments: WorkItemAttachment[];
  /** Provider revision. Part of the idempotency key, so an edit re-triggers. */
  rev: string;
  url: string;
  updatedAt: string;
  raw: unknown;
}

// ---------------------------------------------------------------- log signals

export interface LogEvent {
  timestamp: string;
  message: string;
  stackTrace: string | null;
  traceId: string | null;
  attributes: Record<string, string>;
}

export interface LogSignal {
  id: string;
  sourceId: string;
  /** Normalised signature — see docs/03-agent-log-triage.md#fingerprinting */
  fingerprint: string;
  title: string;
  service: string;
  environment: string;
  level: string;
  count: number;
  affectedUsers: number | null;
  firstSeen: string;
  lastSeen: string;
  exceptionType: string | null;
  topFrames: string[];
  sampleEvents: LogEvent[];
  versions: string[];
  hosts: string[];
  regions: string[];
  query: string;
  dashboardUrl: string | null;
  raw: unknown;
}

export interface DeployMarker {
  timestamp: string;
  reference: string;
  description: string;
}

/** Everything gathered when widening a signal into an investigable incident. */
export interface LogEvidence {
  signal: LogSignal;
  timeline: { bucket: string; count: number }[];
  blast: {
    affectedUsers: number | null;
    affectedRequests: number | null;
    trafficShare: number | null;
  };
  spread: { versions: string[]; hosts: string[]; regions: string[] };
  correlations: DeployMarker[];
  precedingEvents: LogEvent[];
  dependencyErrors: LogEvent[];
}

// ---------------------------------------------------------------- code hosts

export interface RepoInfo {
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  testCommand: string | null;
  buildCommand: string | null;
  webUrl: string;
}

export interface MergeRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  labels: string[];
}

export interface OpenMrInput {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft: boolean;
  labels: string[];
  workItemKey?: string;
  reviewers?: string[];
}

export interface MrFilter {
  repo: string;
  /** Match on the run marker embedded in agent-authored MR descriptions. */
  containsMarker?: string;
  state?: 'open' | 'merged' | 'closed';
}

// ---------------------------------------------------------------- shared

export interface HealthStatus {
  ok: boolean;
  detail: string;
  checkedAt: string;
}

export interface TimeWindow {
  from: string;
  to: string;
}

export type Cursor = string;

export type AutonomyLevel = 'observe' | 'comment' | 'propose' | 'autonomous';

export type RiskLevel = 'low' | 'medium' | 'high';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
