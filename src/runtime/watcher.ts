import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { PipelineDeps } from '../agents/context.js';
import { detectSignals, shouldSuppress, startLogRun, type SuppressionState } from '../agents/log-triage/pipeline.js';
import { preTriage, startTicketRun } from '../agents/ticket-to-mr/pipeline.js';
import type { LogSource } from '../connectors/logs/types.js';
import type { WorkItemSource } from '../connectors/work-items/types.js';
import { workItemIdempotencyKey } from '../core/ids.js';
import type { Cursor } from '../core/types.js';
import type { BudgetGuard } from './budget.js';
import type { Orchestrator } from './orchestrator.js';

/**
 * Turns "the outside world changed" into a deduplicated stream of runs.
 *
 * Polling is the default and the only mode that works everywhere. Webhooks are
 * an optimisation: where a provider supports them, the payload triggers a
 * re-read from the API rather than being trusted, because webhooks are lossy,
 * replayed, and out of order.
 */
export class Watcher {
  private readonly suppression: SuppressionState = {
    seenFingerprints: new Set(),
    runsStartedThisHour: 0,
  };
  private hourBucket = currentHourBucket();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly orchestrator: Orchestrator,
    private readonly budget: BudgetGuard,
    private readonly cursors: CursorStore,
  ) {}

  /** One poll of every enabled source. */
  async tick(): Promise<{ triggered: number; suppressed: number }> {
    if (process.env['KILL_SWITCH'] === '1') {
      this.deps.logger.warn('kill switch set; skipping poll');
      return { triggered: 0, suppressed: 0 };
    }

    this.rollHourBucket();

    const gate = await this.budget.canStartNewRun();
    if (!gate.allowed) {
      this.deps.logger.warn('not starting new runs', { reason: gate.reason });
      return { triggered: 0, suppressed: 0 };
    }

    let triggered = 0;
    let suppressed = 0;

    const ticket = this.deps.config.agents.ticketToMr;
    if (ticket?.enabled && this.deps.workItemSource) {
      const result = await this.pollWorkItems(this.deps.workItemSource, ticket);
      triggered += result.triggered;
      suppressed += result.suppressed;
    }

    const logs = this.deps.config.agents.logTriage;
    if (logs?.enabled && this.deps.logSource) {
      const result = await this.pollLogs(this.deps.logSource, logs);
      triggered += result.triggered;
      suppressed += result.suppressed;
    }

    return { triggered, suppressed };
  }

  private async pollWorkItems(
    source: WorkItemSource,
    config: NonNullable<PipelineDeps['config']['agents']['ticketToMr']>,
  ): Promise<{ triggered: number; suppressed: number }> {
    const cursor = await this.cursors.get(source.id);
    let triggered = 0;
    let suppressed = 0;

    let batch: { items: Awaited<ReturnType<WorkItemSource['poll']>>['items']; cursor: Cursor };
    try {
      batch = await source.poll(cursor);
    } catch (err) {
      // The high-water mark is deliberately not advanced on failure, so nothing
      // is lost and the next tick catches up.
      this.deps.logger.error('work item poll failed', {
        sourceId: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { triggered: 0, suppressed: 0 };
    }

    for (const item of batch.items) {
      const key = workItemIdempotencyKey(item.sourceId, item.id, item.rev);
      if (await this.deps.store.findByIdempotencyKey(key)) {
        suppressed += 1;
        continue;
      }
      const gate = preTriage(item, config);
      if (!gate.pass) {
        this.deps.logger.debug('work item filtered before run creation', { key: item.key, reason: gate.reason });
        suppressed += 1;
        continue;
      }
      // Hydrate: poll returns a summary, and comments carry the real requirement.
      const full = await source.get(item.id).catch(() => item);
      const run = await startTicketRun(this.deps, full);
      await this.orchestrator.advance(run);
      triggered += 1;
    }

    await this.cursors.set(source.id, batch.cursor);
    return { triggered, suppressed };
  }

  private async pollLogs(
    source: LogSource,
    config: NonNullable<PipelineDeps['config']['agents']['logTriage']>,
  ): Promise<{ triggered: number; suppressed: number }> {
    let triggered = 0;
    let suppressed = 0;

    let detected: Awaited<ReturnType<typeof detectSignals>>;
    try {
      detected = await detectSignals(source, config.detection.windowMinutes);
    } catch (err) {
      this.deps.logger.error('log detection failed', {
        sourceId: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { triggered: 0, suppressed: 0 };
    }

    for (const signal of detected.signals) {
      const decision = await shouldSuppress(signal, config, this.deps.store, this.suppression);
      if (decision.suppress) {
        this.deps.logger.debug('signal suppressed', {
          fingerprint: signal.fingerprint,
          reason: decision.reason,
        });
        this.suppression.seenFingerprints.add(signal.fingerprint);
        suppressed += 1;
        continue;
      }
      const run = await startLogRun(this.deps, signal);
      this.suppression.seenFingerprints.add(signal.fingerprint);
      this.suppression.runsStartedThisHour += 1;
      await this.orchestrator.advance(run);
      triggered += 1;
    }

    return { triggered, suppressed };
  }

  private rollHourBucket(): void {
    const bucket = currentHourBucket();
    if (bucket !== this.hourBucket) {
      this.hourBucket = bucket;
      this.suppression.runsStartedThisHour = 0;
    }
  }
}

/** High-water marks, persisted so a restart does not replay or skip. */
export interface CursorStore {
  get(sourceId: string): Promise<Cursor | null>;
  set(sourceId: string, cursor: Cursor): Promise<void>;
}

export class FileCursorStore implements CursorStore {
  constructor(private readonly dir: string) {}

  private path(sourceId: string): string {
    return join(this.dir, `cursor-${sourceId.replace(/[^\w.-]/g, '_')}.txt`);
  }

  async get(sourceId: string): Promise<Cursor | null> {
    const path = this.path(sourceId);
    if (!existsSync(path)) return null;
    return (await readFile(path, 'utf8')).trim() || null;
  }

  async set(sourceId: string, cursor: Cursor): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(sourceId), cursor);
  }
}

export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, Cursor>();

  async get(sourceId: string): Promise<Cursor | null> {
    return this.cursors.get(sourceId) ?? null;
  }

  async set(sourceId: string, cursor: Cursor): Promise<void> {
    this.cursors.set(sourceId, cursor);
  }
}

function currentHourBucket(): string {
  return new Date().toISOString().slice(0, 13);
}
