import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '../core/ids.js';

import type { z } from 'zod';

import {
  goldenLogSchema,
  goldenTicketSchema,
  type GoldenLogCase,
  type GoldenSet,
  type GoldenTicketCase,
} from './types.js';

/**
 * Golden sets live on disk as one JSON file per case, under
 * `<dir>/tickets/*.json` and `<dir>/logs/*.json`.
 *
 * One file per case rather than one big file: cases are added a few at a time
 * by different people, and a per-case file makes the diff readable and the
 * merge conflict-free.
 */

export class GoldenSetError extends Error {
  constructor(file: string, issues: string) {
    super(`Invalid golden case ${file}:\n${issues}`);
    this.name = 'GoldenSetError';
  }
}

export async function loadGoldenSet(dir: string): Promise<GoldenSet> {
  const [tickets, logs] = await Promise.all([
    loadDir(join(dir, 'tickets'), goldenTicketSchema),
    loadDir(join(dir, 'logs'), goldenLogSchema),
  ]);
  assertUniqueIds([...tickets.map((t) => t.id), ...logs.map((l) => l.id)]);
  return { tickets, logs };
}

async function loadDir<S extends z.ZodTypeAny>(dir: string, schema: S): Promise<z.infer<S>[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: z.infer<S>[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown;
    // A file holding an array is allowed, so a batch exported from history can
    // be dropped in without splitting it by hand first.
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const result = schema.safeParse(entry);
      if (!result.success) {
        throw new GoldenSetError(file, result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
      }
      out.push(result.data);
    }
  }
  return out;
}

function assertUniqueIds(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    // Duplicate ids silently halve a score by counting one case twice.
    if (seen.has(id)) throw new Error(`Duplicate golden case id: ${id}`);
    seen.add(id);
  }
}

/** Hand-labelled clusters, keyed by the signal id the pipeline will see. */
export function clusterLabels(logs: readonly GoldenLogCase[], sourceId: string): Map<string, string> {
  return new Map(logs.map((c) => [`${sourceId}:${c.signal.fingerprint}`, c.truth.clusterLabel]));
}

/**
 * Split for judge calibration.
 *
 * Membership is decided by a hash of the case id, not by position in a sorted
 * list: adding a case must never move an existing one across the boundary, or
 * every calibration number recorded before the addition becomes incomparable
 * with every number recorded after it.
 */
export function holdOut<T extends { id: string }>(cases: readonly T[], fraction = 0.2): { train: T[]; held: T[] } {
  const threshold = Math.floor(fraction * 0xffff);
  const isHeld = (id: string): boolean => parseInt(sha256('hold-out', id).slice(0, 4), 16) <= threshold;
  const sorted = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  return { train: sorted.filter((c) => !isHeld(c.id)), held: sorted.filter((c) => isHeld(c.id)) };
}

export type { GoldenLogCase, GoldenTicketCase, GoldenSet };
