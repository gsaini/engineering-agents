import type { RunStore } from '../core/store.js';

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: 'run' | 'day',
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(`Budget exceeded (${scope}): spent $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetLimits {
  usdPerRun: number;
  usdPerDay: number;
  runsPerDay: number;
}

/**
 * Budgets are enforced, not advisory.
 *
 * Checks happen at stage boundaries: stopping mid-stage wastes what has already
 * been spent without producing a usable artefact, so the guard lets the current
 * stage finish and refuses the next one.
 */
export class BudgetGuard {
  constructor(
    private readonly store: RunStore,
    private readonly limits: BudgetLimits,
  ) {}

  /** Throws if the run may not proceed to another stage. */
  async assertCanContinue(runId: string): Promise<void> {
    const run = await this.store.load(runId);
    if (!run) return;
    if (run.cost.usd >= this.limits.usdPerRun) {
      throw new BudgetExceededError('run', this.limits.usdPerRun, run.cost.usd);
    }
    const spentToday = await this.spentToday();
    if (spentToday >= this.limits.usdPerDay) {
      throw new BudgetExceededError('day', this.limits.usdPerDay, spentToday);
    }
  }

  /** Remaining headroom for this run — passed to the model as a hard ceiling. */
  async remainingForRun(runId: string): Promise<number> {
    const run = await this.store.load(runId);
    const spent = run?.cost.usd ?? 0;
    return Math.max(0, this.limits.usdPerRun - spent);
  }

  async spentToday(): Promise<number> {
    const since = startOfToday();
    const runs = await this.store.list();
    return runs
      .filter((r) => r.meta.createdAt >= since)
      .reduce((total, r) => total + r.cost.usd, 0);
  }

  /** A new-run gate, distinct from the per-stage gate above. */
  async canStartNewRun(): Promise<{ allowed: boolean; reason: string }> {
    const since = startOfToday();
    const runs = await this.store.list();
    const today = runs.filter((r) => r.meta.createdAt >= since);
    if (today.length >= this.limits.runsPerDay) {
      return { allowed: false, reason: `Daily run cap reached (${this.limits.runsPerDay})` };
    }
    const spent = today.reduce((total, r) => total + r.cost.usd, 0);
    if (spent >= this.limits.usdPerDay) {
      return { allowed: false, reason: `Daily budget reached ($${this.limits.usdPerDay})` };
    }
    return { allowed: true, reason: '' };
  }
}

function startOfToday(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
