import type { Notifier } from '../connectors/notify/types.js';
import type { Logger } from '../core/logger.js';
import type { Approval, ApprovalDecision, Plan, RejectionReason, Run } from '../core/run.js';
import type { RunStore } from '../core/store.js';
import type { AutonomyLevel } from '../core/types.js';

export interface AutoApprovalPolicy {
  autonomy: AutonomyLevel;
  autonomousRepos: string[];
  maxFilesChanged: number;
  maxLinesChanged: number;
  sensitiveMatch: boolean;
}

/**
 * Approval is asynchronous and durable.
 *
 * `request` posts and returns; the decision arrives later via webhook or CLI and
 * is appended to the run's event log. That is what lets the process restart
 * mid-approval without losing anything (ADR 0003, ADR 0006).
 */
export class ApprovalService {
  constructor(
    private readonly store: RunStore,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
  ) {}

  async request(run: Run, plan: Plan, ttlHours: number, warnings: string[]): Promise<void> {
    const trigger = run.trigger;
    const subtitle =
      trigger.kind === 'work-item' ? trigger.workItem.title : trigger.signal.title;

    await this.notifier.requestApproval({
      runId: run.meta.runId,
      threadKey: run.meta.runId,
      title:
        trigger.kind === 'work-item'
          ? `Plan ready — ${trigger.workItem.key}`
          : `Fix proposed — ${trigger.signal.title}`,
      subtitle,
      repo: run.meta.repo ?? 'unknown',
      risk: plan.risk.level,
      filesChanged: plan.blastRadius.filesChanged,
      linesChanged: plan.blastRadius.linesChanged,
      warnings,
      approach: plan.approach,
      rejectedAlternative: plan.rejectedAlternative,
      assumptions: plan.assumptions.map((a) => `${a.assumption} (${a.basis})`),
      fullPlanUrl: null,
      ttlHours,
    });
    this.logger.info('approval requested', { runId: run.meta.runId, risk: plan.risk.level });
  }

  async record(
    runId: string,
    decision: ApprovalDecision,
    actor: string,
    options: { feedback?: string; rejectionReason?: RejectionReason; editedPlanMarkdown?: string } = {},
  ): Promise<Run> {
    if (decision === 'reject' && !options.rejectionReason) {
      // A free-text-only reject teaches nothing at scale; the taxonomy tells you
      // within a week which stage is failing.
      throw new Error('A rejection reason from the taxonomy is required when rejecting a plan');
    }
    const approval: Approval = {
      decision,
      actor,
      at: new Date().toISOString(),
      feedback: options.feedback ?? null,
      rejectionReason: options.rejectionReason ?? null,
      editedPlanMarkdown: options.editedPlanMarkdown ?? null,
    };
    return this.store.append(runId, {
      type: 'artefact',
      actor: `user:${actor}`,
      artefact: 'approval',
      payload: approval,
    });
  }

  /**
   * Auto-approval for `autonomous` mode.
   *
   * Deliberately narrow: every condition must hold, and anything else falls back
   * to human approval regardless of configured autonomy (docs/08-rollout.md).
   */
  static canAutoApprove(plan: Plan, repo: string | null, policy: AutoApprovalPolicy): { allowed: boolean; reason: string } {
    if (policy.autonomy !== 'autonomous') return { allowed: false, reason: 'autonomy is not autonomous' };
    if (policy.sensitiveMatch) return { allowed: false, reason: 'touches a sensitive path' };
    if (!repo || !policy.autonomousRepos.includes(repo)) {
      return { allowed: false, reason: 'repo is not on the autonomous allowlist' };
    }
    if (plan.risk.level !== 'low') return { allowed: false, reason: `risk is ${plan.risk.level}` };
    if (plan.blastRadius.schemaChange) return { allowed: false, reason: 'changes the schema' };
    if (plan.blastRadius.configChange) return { allowed: false, reason: 'changes configuration' };
    if (plan.blastRadius.publicApiChange) return { allowed: false, reason: 'changes a public API' };
    // Half the normal limit: autonomous changes must be comfortably small, not
    // merely within bounds.
    if (plan.blastRadius.filesChanged > policy.maxFilesChanged / 2) {
      return { allowed: false, reason: 'blast radius above the autonomous threshold' };
    }
    if (plan.blastRadius.linesChanged > policy.maxLinesChanged / 2) {
      return { allowed: false, reason: 'blast radius above the autonomous threshold' };
    }
    return { allowed: true, reason: 'meets every autonomous criterion' };
  }

  /** Runs parked past their TTL. Reminder at 50%, expiry at 100%. */
  static isExpired(run: Run, ttlHours: number, now = Date.now()): boolean {
    const parked = run.events.findLast((e) => e.type === 'transition' && e.to === 'AWAITING_APPROVAL');
    if (!parked) return false;
    return now - Date.parse(parked.at) > ttlHours * 3_600_000;
  }

  static needsReminder(run: Run, ttlHours: number, now = Date.now()): boolean {
    const parked = run.events.findLast((e) => e.type === 'transition' && e.to === 'AWAITING_APPROVAL');
    if (!parked) return false;
    const elapsed = now - Date.parse(parked.at);
    const half = (ttlHours * 3_600_000) / 2;
    const alreadyReminded = run.events.some((e) => e.type === 'note' && e.payload === 'approval-reminder');
    return elapsed > half && !alreadyReminded;
  }
}
