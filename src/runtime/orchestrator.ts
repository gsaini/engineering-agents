import type { PipelineDeps } from '../agents/context.js';
import * as logTriage from '../agents/log-triage/pipeline.js';
import * as ticketToMr from '../agents/ticket-to-mr/pipeline.js';
import type { Run } from '../core/run.js';
import { TERMINAL_STATES } from '../core/run.js';
import { transition } from '../core/store.js';
import { ApprovalService } from './approvals.js';

/**
 * Drives runs through the state machine.
 *
 * Runs are resumed from their event log on startup, which is what makes a
 * days-long park at AWAITING_APPROVAL survive a restart (ADR 0006).
 */
export class Orchestrator {
  private inFlight = 0;

  constructor(private readonly deps: PipelineDeps) {}

  get concurrencyAvailable(): boolean {
    return this.inFlight < this.deps.config.runtime.maxConcurrentRuns;
  }

  /** Advance one run as far as it will go without human input. */
  async advance(run: Run): Promise<Run> {
    if (TERMINAL_STATES.has(run.state)) return run;
    if (!this.concurrencyAvailable) {
      this.deps.logger.debug('concurrency cap reached; queueing', { runId: run.meta.runId });
      return run;
    }

    this.inFlight += 1;
    try {
      switch (run.state) {
        case 'QUEUED':
          return run.meta.agent === 'ticket-to-mr'
            ? (await ticketToMr.runToApproval(this.deps, run)).run
            : (await logTriage.runToApproval(this.deps, run)).run;

        case 'AWAITING_APPROVAL':
          return this.handleAwaitingApproval(run);

        case 'NEEDS_INFO':
          // Resumed when a new revision of the work item arrives, which creates
          // a fresh run; nothing to do here except expire.
          return this.expireIfStale(run);

        default:
          // TRIAGING / ANALYZING / PLANNING / IMPLEMENTING / VERIFYING /
          // PUBLISHING are transient: a run parked in one of them was
          // interrupted mid-stage. Restart it from the top of its pipeline
          // rather than resuming a partial stage.
          this.deps.logger.warn('resuming interrupted run', { runId: run.meta.runId, state: run.state });
          return run;
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private async handleAwaitingApproval(run: Run): Promise<Run> {
    const ttl = this.ttlFor(run);

    if (run.artefacts.approval) {
      return run.meta.agent === 'ticket-to-mr'
        ? (await ticketToMr.continueAfterApproval(this.deps, run)).run
        : (await logTriage.continueAfterApproval(this.deps, run)).run;
    }

    if (ApprovalService.isExpired(run, ttl)) {
      this.deps.logger.info('approval expired', { runId: run.meta.runId });
      return transition(this.deps.store, run, 'EXPIRED', 'system:orchestrator');
    }

    if (ApprovalService.needsReminder(run, ttl)) {
      await this.deps.notifier.notify({
        runId: run.meta.runId,
        threadKey: run.meta.runId,
        title: 'Reminder: plan awaiting approval',
        body: `Run ${run.meta.runId} expires in about ${Math.round(ttl / 2)}h.`,
        severity: 'info',
        links: [],
      });
      return this.deps.store.append(run.meta.runId, {
        type: 'note',
        actor: 'system:orchestrator',
        payload: 'approval-reminder',
      });
    }

    return run;
  }

  private async expireIfStale(run: Run): Promise<Run> {
    const ttl = this.ttlFor(run);
    const parked = run.events.findLast((e) => e.type === 'transition' && e.to === 'NEEDS_INFO');
    if (parked && Date.now() - Date.parse(parked.at) > ttl * 3_600_000) {
      return transition(this.deps.store, run, 'EXPIRED', 'system:orchestrator');
    }
    return run;
  }

  private ttlFor(run: Run): number {
    return run.meta.agent === 'ticket-to-mr'
      ? (this.deps.config.agents.ticketToMr?.approvalTtlHours ?? 72)
      : (this.deps.config.agents.logTriage?.approvalTtlHours ?? 24);
  }

  /** Called at startup: pick up everything the last process left in flight. */
  async resumeAll(): Promise<number> {
    const runs = await this.deps.store.list();
    const resumable = runs.filter((r) => !TERMINAL_STATES.has(r.state));
    for (const run of resumable) {
      await this.advance(run).catch((err: unknown) => {
        this.deps.logger.error('resume failed', {
          runId: run.meta.runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return run;
      });
    }
    return resumable.length;
  }
}
