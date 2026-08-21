import { z } from 'zod';

import { fingerprintSignal } from '../../core/ids.js';
import type { HealthStatus, LogEvidence, LogSignal, TimeWindow } from '../../core/types.js';
import { redact } from '../redact.js';
import {
  extractAppFrames,
  renderQuery,
  type GatherOptions,
  type LogQueryResult,
  type LogQuerySpec,
  type LogSource,
} from './types.js';

export const splunkOptionsSchema = z.object({
  baseUrl: z.string().url(),
  token: z.string(),
  index: z.string(),
  service: z.string(),
  environment: z.string(),
  detectionQuery: z.string(),
  appNamespaces: z.array(z.string()).default([]),
  /** Splunk field extraction is deployment-specific — never assume names. */
  fieldMap: z
    .object({
      level: z.string().default('log_level'),
      exceptionType: z.string().default('exception_type'),
      stack: z.string().default('stack_trace'),
      user: z.string().default('user_id'),
    })
    .default({}),
  maxSearchSeconds: z.number().int().positive().default(180),
  pollIntervalMs: z.number().int().positive().default(1500),
});

export type SplunkOptions = z.infer<typeof splunkOptionsSchema>;

/**
 * Splunk.
 *
 * Searches can be extremely expensive, so every search is created with an
 * explicit budget and cancelled past `maxSearchSeconds` rather than left to
 * run. Field names come from config, because extraction differs per deployment.
 */
export class SplunkLogSource implements LogSource {
  readonly provider = 'splunk';
  private readonly options: SplunkOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = splunkOptionsSchema.parse(options);
  }

  get service(): string {
    return this.options.service;
  }

  get environment(): string {
    return this.options.environment;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.token}` };
  }

  private async search(spl: string): Promise<Record<string, unknown>[]> {
    const create = await this.fetchImpl(`${this.options.baseUrl}/services/search/jobs`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        search: spl.startsWith('search ') || spl.startsWith('|') ? spl : `search ${spl}`,
        output_mode: 'json',
        max_time: String(this.options.maxSearchSeconds),
      }),
    });
    if (!create.ok) throw new Error(`Splunk job create failed: ${create.status} ${await create.text()}`);
    const { sid } = (await create.json()) as { sid: string };

    const deadline = Date.now() + this.options.maxSearchSeconds * 1000;
    for (;;) {
      const status = await this.fetchImpl(
        `${this.options.baseUrl}/services/search/jobs/${sid}?output_mode=json`,
        { headers: this.headers() },
      );
      const body = (await status.json()) as { entry?: { content?: { isDone?: boolean; isFailed?: boolean } }[] };
      const content = body.entry?.[0]?.content;
      if (content?.isFailed) throw new Error(`Splunk search ${sid} failed`);
      if (content?.isDone) break;
      if (Date.now() > deadline) {
        // Cancel rather than abandon: an orphaned search keeps consuming.
        await this.fetchImpl(`${this.options.baseUrl}/services/search/jobs/${sid}/control`, {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: 'cancel' }),
        }).catch(() => undefined);
        throw new Error(`Splunk search ${sid} exceeded ${this.options.maxSearchSeconds}s and was cancelled`);
      }
      await sleep(this.options.pollIntervalMs);
    }

    const results = await this.fetchImpl(
      `${this.options.baseUrl}/services/search/jobs/${sid}/results?output_mode=json&count=0`,
      { headers: this.headers() },
    );
    const payload = (await results.json()) as { results?: Record<string, unknown>[] };
    return payload.results ?? [];
  }

  async detect(window: TimeWindow): Promise<LogSignal[]> {
    const query = renderQuery(this.options.detectionQuery, {
      windowMinutes: Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / 60_000)),
      minOccurrences: 1,
    });
    const rows = await this.search(query);
    const { fieldMap } = this.options;

    return rows.map((row) => {
      const exceptionType = String(row[fieldMap.exceptionType] ?? 'unknown');
      const stack = String(row['samples'] ?? row[fieldMap.stack] ?? '');
      const frames = extractAppFrames(stack, this.options.appNamespaces);
      const module = String(row['source_module'] ?? this.options.service);
      return {
        id: `${this.id}:${exceptionType}:${module}`,
        sourceId: this.id,
        fingerprint: fingerprintSignal({ exceptionType, message: stack || exceptionType, frames }),
        title: `${exceptionType} in ${module}`,
        service: module,
        environment: this.options.environment,
        level: String(row[fieldMap.level] ?? 'ERROR'),
        count: Number(row['c'] ?? row['count'] ?? 0),
        affectedUsers: row['users'] != null ? Number(row['users']) : null,
        firstSeen: epochToIso(row['first']) ?? window.from,
        lastSeen: epochToIso(row['last']) ?? window.to,
        exceptionType,
        topFrames: frames,
        sampleEvents: [],
        versions: [],
        hosts: [],
        regions: [],
        query,
        dashboardUrl: null,
        raw: row,
      } satisfies LogSignal;
    });
  }

  async gather(signal: LogSignal, options: GatherOptions): Promise<LogEvidence> {
    const { fieldMap } = this.options;
    const rows = await this.search(
      `index=${this.options.index} ${fieldMap.exceptionType}="${signal.exceptionType ?? ''}" earliest=${toSplunkTime(signal.firstSeen)} latest=${toSplunkTime(signal.lastSeen)} | head ${options.maxSamples}`,
    );
    return {
      signal: {
        ...signal,
        sampleEvents: rows.map((row) => ({
          timestamp: String(row['_time'] ?? ''),
          message: redact(String(row['_raw'] ?? '')),
          stackTrace: row[fieldMap.stack] != null ? redact(String(row[fieldMap.stack])) : null,
          traceId: row['trace_id'] != null ? String(row['trace_id']) : null,
          attributes: { host: String(row['host'] ?? '') },
        })),
      },
      timeline: [{ bucket: signal.firstSeen, count: signal.count }],
      blast: { affectedUsers: signal.affectedUsers, affectedRequests: signal.count, trafficShare: null },
      spread: {
        versions: [],
        hosts: [...new Set(rows.map((r) => String(r['host'] ?? '')).filter(Boolean))],
        regions: [],
      },
      correlations: [],
      precedingEvents: [],
      dependencyErrors: [],
    };
  }

  async query(spec: LogQuerySpec): Promise<LogQueryResult> {
    const rows = await this.search(spec.query);
    return { rows: rows.slice(0, spec.maxRows), truncated: rows.length > spec.maxRows };
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl}/services/server/info?output_mode=json`, {
        headers: this.headers(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return { ok: true, detail: this.options.baseUrl, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}

function epochToIso(value: unknown): string | null {
  if (value == null) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return typeof value === 'string' ? value : null;
  return new Date(num * 1000).toISOString();
}

function toSplunkTime(iso: string): string {
  return String(Math.floor(Date.parse(iso) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
