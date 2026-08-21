import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyEvent,
  emptyCost,
  foldEvents,
  IllegalTransitionError,
  canTransition,
  type Run,
  type RunActor,
  type RunArtefacts,
  type RunEvent,
  type RunMeta,
  type RunState,
  type TriggerPayload,
} from './run.js';

export interface RunStore {
  create(input: {
    meta: RunMeta;
    trigger: TriggerPayload;
  }): Promise<Run>;
  load(runId: string): Promise<Run | null>;
  list(filter?: { state?: RunState; agent?: string; limit?: number }): Promise<Run[]>;
  findByIdempotencyKey(key: string): Promise<Run | null>;
  append(runId: string, event: Omit<RunEvent, 'seq' | 'at'>): Promise<Run>;
}

/** Convenience wrappers so pipelines never hand-build events. */
export async function transition(
  store: RunStore,
  run: Run,
  to: RunState,
  actor: RunActor = 'agent',
): Promise<Run> {
  if (!canTransition(run.state, to)) throw new IllegalTransitionError(run.state, to);
  return store.append(run.meta.runId, { type: 'transition', actor, from: run.state, to });
}

export async function putArtefact<K extends keyof RunArtefacts>(
  store: RunStore,
  run: Run,
  key: K,
  value: NonNullable<RunArtefacts[K]>,
  actor: RunActor = 'agent',
): Promise<Run> {
  return store.append(run.meta.runId, { type: 'artefact', actor, artefact: key, payload: value });
}

export async function recordCost(
  store: RunStore,
  run: Run,
  payload: { stage: string; usd: number; ms: number; input: number; output: number },
): Promise<Run> {
  return store.append(run.meta.runId, { type: 'cost', actor: 'agent', payload });
}

/**
 * Append-only JSONL store: `.runs/<runId>/events.jsonl` plus a `state.json`
 * snapshot for fast listing. Dependency-free and greppable, which is the right
 * trade for a single-node deployment. Multi-worker deployments need a real
 * database plus a lease per run — see ADR 0006.
 */
export class FileRunStore implements RunStore {
  constructor(private readonly rootDir: string) {}

  private dir(runId: string): string {
    return join(this.rootDir, runId);
  }

  async create(input: { meta: RunMeta; trigger: TriggerPayload }): Promise<Run> {
    const dir = this.dir(input.meta.runId);
    await mkdir(dir, { recursive: true });
    const seed: Run = {
      meta: input.meta,
      state: 'QUEUED',
      trigger: input.trigger,
      artefacts: {},
      cost: emptyCost(),
      events: [],
      failure: null,
    };
    await writeFile(join(dir, 'trigger.json'), JSON.stringify(input.trigger, null, 2));
    await writeFile(join(dir, 'events.jsonl'), '');
    await this.snapshot(seed);
    return this.append(input.meta.runId, { type: 'created', actor: 'system:watcher' });
  }

  async load(runId: string): Promise<Run | null> {
    const dir = this.dir(runId);
    if (!existsSync(join(dir, 'state.json'))) return null;
    const snapshot = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Run;
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RunEvent);
    const trigger = JSON.parse(await readFile(join(dir, 'trigger.json'), 'utf8')) as TriggerPayload;
    const seed: Run = {
      meta: snapshot.meta,
      state: 'QUEUED',
      trigger,
      artefacts: {},
      cost: emptyCost(),
      events: [],
      failure: null,
    };
    return foldEvents(seed, events);
  }

  async list(filter: { state?: RunState; agent?: string; limit?: number } = {}): Promise<Run[]> {
    if (!existsSync(this.rootDir)) return [];
    const ids = await readdir(this.rootDir);
    const out: Run[] = [];
    for (const id of ids) {
      const run = await this.load(id);
      if (!run) continue;
      if (filter.state && run.state !== filter.state) continue;
      if (filter.agent && run.meta.agent !== filter.agent) continue;
      out.push(run);
    }
    out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  async findByIdempotencyKey(key: string): Promise<Run | null> {
    const runs = await this.list();
    return runs.find((r) => r.meta.idempotencyKey === key) ?? null;
  }

  async append(runId: string, event: Omit<RunEvent, 'seq' | 'at'>): Promise<Run> {
    const current = await this.load(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const full: RunEvent = {
      ...event,
      seq: current.events.length,
      at: new Date().toISOString(),
    };
    await appendFile(join(this.dir(runId), 'events.jsonl'), `${JSON.stringify(full)}\n`);
    const next = applyEvent(current, full);
    await this.snapshot(next);
    return next;
  }

  private async snapshot(run: Run): Promise<void> {
    const { events: _events, ...rest } = run;
    await writeFile(join(this.dir(run.meta.runId), 'state.json'), JSON.stringify(rest, null, 2));
  }
}

/** In-memory store for tests and dry runs. */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();

  async create(input: { meta: RunMeta; trigger: TriggerPayload }): Promise<Run> {
    const seed: Run = {
      meta: input.meta,
      state: 'QUEUED',
      trigger: input.trigger,
      artefacts: {},
      cost: emptyCost(),
      events: [],
      failure: null,
    };
    this.runs.set(input.meta.runId, seed);
    return this.append(input.meta.runId, { type: 'created', actor: 'system:watcher' });
  }

  async load(runId: string): Promise<Run | null> {
    return this.runs.get(runId) ?? null;
  }

  async list(filter: { state?: RunState; agent?: string; limit?: number } = {}): Promise<Run[]> {
    let out = [...this.runs.values()];
    if (filter.state) out = out.filter((r) => r.state === filter.state);
    if (filter.agent) out = out.filter((r) => r.meta.agent === filter.agent);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  async findByIdempotencyKey(key: string): Promise<Run | null> {
    return [...this.runs.values()].find((r) => r.meta.idempotencyKey === key) ?? null;
  }

  async append(runId: string, event: Omit<RunEvent, 'seq' | 'at'>): Promise<Run> {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const full: RunEvent = { ...event, seq: current.events.length, at: new Date().toISOString() };
    const next = applyEvent(current, full);
    this.runs.set(runId, next);
    return next;
  }
}
