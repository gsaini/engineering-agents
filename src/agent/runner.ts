import type { z } from 'zod';

import type { Effort } from '../core/types.js';

export type ToolPolicy = 'read-only' | 'read-write' | 'none';

export interface AgentRunSpec {
  /** Stage name — used for cost attribution and logging. */
  stage: string;
  /** Rendered system prompt (shared rules plus stage rules). */
  system: string;
  /** Rendered user prompt, with untrusted content already wrapped. */
  prompt: string;
  /** Working directory. Always a run's own worktree; never the host repo. */
  cwd: string;
  toolPolicy: ToolPolicy;
  effort: Effort;
  model: string;
  maxTurns: number;
  /** Hard USD ceiling for this invocation. */
  budgetUsd: number;
  /** When present, the result is parsed and validated against it. */
  schema?: z.ZodTypeAny;
  /** Commands the agent may run. Empty means bash is unavailable. */
  allowedCommands: string[];
  /** Paths the agent must not touch, relative to cwd. */
  protectedPaths: string[];
  abortSignal?: AbortSignal;
}

export interface ToolDenial {
  tool: string;
  input: unknown;
  reason: string;
}

export interface AgentRunResult<T = unknown> {
  ok: boolean;
  /** Present when the spec carried a schema and validation succeeded. */
  data: T | null;
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
  denials: ToolDenial[];
  error: string | null;
}

/**
 * The single seam between pipelines and the model.
 *
 * Everything above this line is testable with `DryRunAgentRunner` and no
 * credentials; everything below it is where tokens are spent (ADR 0005).
 */
export interface AgentRunner {
  run<T = unknown>(spec: AgentRunSpec): Promise<AgentRunResult<T>>;
}

/** Built-in tools granted per policy. Bash is added separately and allowlisted. */
export const TOOLS_BY_POLICY: Record<ToolPolicy, string[]> = {
  none: [],
  'read-only': ['Read', 'Grep', 'Glob'],
  'read-write': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
};

export class SchemaValidationError extends Error {
  constructor(
    readonly stage: string,
    readonly issues: string,
  ) {
    super(`Stage "${stage}" returned output that does not match its schema:\n${issues}`);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Pull a JSON object out of a model response.
 *
 * Structured output is requested explicitly, but a fenced block or surrounding
 * prose still turns up occasionally; recovering here is cheaper than a repair
 * round-trip.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('No JSON object found in model output');
  }
}
