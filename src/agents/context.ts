import type { z } from 'zod';

import type { AgentRunner, AgentRunResult, ToolPolicy } from '../agent/runner.js';
import type { CodeHost } from '../connectors/scm/types.js';
import type { Notifier } from '../connectors/notify/types.js';
import type { WorkItemSource } from '../connectors/work-items/types.js';
import type { LogSource } from '../connectors/logs/types.js';
import type { Config, GuardrailsConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { Run } from '../core/run.js';
import { recordCost, type RunStore } from '../core/store.js';
import type { Effort } from '../core/types.js';
import type { ApprovalService } from '../runtime/approvals.js';
import type { BudgetGuard } from '../runtime/budget.js';
import type { Sandbox, SandboxFactory } from '../runtime/sandbox.js';
import { matchesGlob } from '../agent/claude-runner.js';

export interface PipelineDeps {
  config: Config;
  store: RunStore;
  runner: AgentRunner;
  codeHost: CodeHost;
  notifier: Notifier;
  approvals: ApprovalService;
  budget: BudgetGuard;
  sandboxes: SandboxFactory;
  workItemSource?: WorkItemSource;
  logSource?: LogSource;
  logger: Logger;
  /** When true, nothing is written to any external system. */
  dryRun: boolean;
}

export interface StageInvocation {
  stage: string;
  effort: Effort;
  toolPolicy: ToolPolicy;
  system: string;
  prompt: string;
  schema?: z.ZodTypeAny;
  cwd: string;
}

/**
 * Invoke one stage, record its cost on the run, and return the validated
 * output. Cost recording happens here rather than in each pipeline so no stage
 * can spend without it showing up on the run record.
 */
export async function invokeStage<T>(
  deps: PipelineDeps,
  run: Run,
  invocation: StageInvocation,
): Promise<{ result: AgentRunResult<T>; run: Run }> {
  const budgetUsd = await deps.budget.remainingForRun(run.meta.runId);
  const result = await deps.runner.run<T>({
    stage: invocation.stage,
    system: invocation.system,
    prompt: invocation.prompt,
    cwd: invocation.cwd,
    toolPolicy: invocation.toolPolicy,
    effort: invocation.effort,
    model: deps.config.model.name,
    maxTurns: deps.config.model.maxTurnsPerStage,
    budgetUsd,
    schema: invocation.schema,
    allowedCommands: deps.config.guardrails.allowedCommands,
    protectedPaths: deps.config.guardrails.protectedPaths,
  });

  let next = await recordCost(deps.store, run, {
    stage: invocation.stage,
    usd: result.costUsd,
    ms: result.durationMs,
    input: result.inputTokens,
    output: result.outputTokens,
  });

  for (const denial of result.denials) {
    next = await deps.store.append(run.meta.runId, {
      type: 'tool-denied',
      actor: 'system:guardrails',
      payload: denial,
    });
  }

  return { result, run: next };
}

/**
 * Blast-radius check.
 *
 * Enforced in code rather than requested in a prompt: an overrun means the plan
 * was wrong, which means the code cannot be right (docs/05-guardrails.md).
 */
export function checkBlastRadius(
  actual: { files: string[]; lines: number },
  estimate: { filesChanged: number; linesChanged: number },
  guardrails: GuardrailsConfig,
): { ok: boolean; reason: string } {
  const { limits } = guardrails;
  if (actual.files.length > limits.maxFilesChanged) {
    return { ok: false, reason: `${actual.files.length} files changed, limit is ${limits.maxFilesChanged}` };
  }
  if (actual.lines > limits.maxLinesChanged) {
    return { ok: false, reason: `${actual.lines} lines changed, limit is ${limits.maxLinesChanged}` };
  }
  const fileOverrun = estimate.filesChanged > 0 && actual.files.length > estimate.filesChanged * limits.overrunFactor;
  const lineOverrun = estimate.linesChanged > 0 && actual.lines > estimate.linesChanged * limits.overrunFactor;
  if (fileOverrun || lineOverrun) {
    return {
      ok: false,
      reason: `Diff exceeds the plan estimate by more than ${limits.overrunFactor}x (planned ${estimate.filesChanged} files / ${estimate.linesChanged} lines, actual ${actual.files.length} / ${actual.lines})`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Sensitive-area detection.
 *
 * Deliberately over-inclusive: a false positive costs one human glance, a false
 * negative costs an incident.
 */
export function touchesSensitivePath(paths: string[], guardrails: GuardrailsConfig): string | null {
  for (const path of paths) {
    for (const pattern of guardrails.sensitivePaths) {
      if (matchesGlob(path, pattern)) return pattern;
    }
  }
  return null;
}

/** Which files the agent may not touch at all, versus merely flagging. */
export function touchesProtectedPath(paths: string[], guardrails: GuardrailsConfig): string | null {
  for (const path of paths) {
    for (const pattern of guardrails.protectedPaths) {
      if (matchesGlob(path, pattern)) return pattern;
    }
  }
  return null;
}

export type { Sandbox };
