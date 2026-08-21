import { z } from 'zod';

import { fingerprintSignal } from '../../core/ids.js';
import type { HealthStatus, LogEvent, LogEvidence, LogSignal, TimeWindow } from '../../core/types.js';
import { redact } from '../redact.js';
import {
  extractAppFrames,
  renderQuery,
  type GatherOptions,
  type LogQueryResult,
  type LogQuerySpec,
  type LogSource,
} from './types.js';

export const cloudWatchOptionsSchema = z.object({
  region: z.string(),
  logGroupNames: z.array(z.string()).min(1),
  service: z.string(),
  environment: z.string(),
  detectionQuery: z.string(),
  appNamespaces: z.array(z.string()).default([]),
  maxQuerySeconds: z.number().int().positive().default(120),
  pollIntervalMs: z.number().int().positive().default(1000),
  maxRows: z.number().int().positive().default(1000),
});

export type CloudWatchOptions = z.infer<typeof cloudWatchOptionsSchema>;

/**
 * Minimal surface of the CloudWatch Logs Insights client we need. Injected so
 * this connector is testable without the AWS SDK or credentials.
 */
export interface CloudWatchClient {
  startQuery(input: {
    logGroupNames: string[];
    queryString: string;
    startTime: number;
    endTime: number;
    limit: number;
  }): Promise<{ queryId: string }>;
  getQueryResults(queryId: string): Promise<{
    status: 'Scheduled' | 'Running' | 'Complete' | 'Failed' | 'Cancelled' | 'Timeout';
    results: { field: string; value: string }[][];
  }>;
}

/** Insights returns rows as field/value pairs; everything downstream wants records. */
export function resultsToRecords(
  results: { field: string; value: string }[][],
): Record<string, unknown>[] {
  return results.map((row) => {
    const record: Record<string, unknown> = {};
    for (const cell of row) record[cell.field] = cell.value;
    return record;
  });
}

/**
 * CloudWatch Logs.
 *
 * Two things shape this connector:
 *
 * 1. Insights is **asynchronous** — StartQuery then poll GetQueryResults. The
 *    polling loop and its timeout live here so pipelines never see it.
 * 2. There are **no cross-query joins**, so novelty (has this fingerprint been
 *    seen in the last N days?) is computed client-side against the seen-set the
 *    caller passes in, rather than in the query.
 */
export class CloudWatchLogSource implements LogSource {
  readonly provider = 'cloudwatch';
  private readonly options: CloudWatchOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly client: CloudWatchClient,
  ) {
    this.options = cloudWatchOptionsSchema.parse(options);
  }

  get service(): string {
    return this.options.service;
  }

  get environment(): string {
    return this.options.environment;
  }

  private async runInsights(query: string, window: TimeWindow, limit: number): Promise<Record<string, unknown>[]> {
    const { queryId } = await this.client.startQuery({
      logGroupNames: this.options.logGroupNames,
      queryString: query,
      startTime: Math.floor(Date.parse(window.from) / 1000),
      endTime: Math.floor(Date.parse(window.to) / 1000),
      limit,
    });

    const deadline = Date.now() + this.options.maxQuerySeconds * 1000;
    for (;;) {
      const result = await this.client.getQueryResults(queryId);
      if (result.status === 'Complete') return resultsToRecords(result.results);
      if (result.status === 'Failed' || result.status === 'Cancelled' || result.status === 'Timeout') {
        throw new Error(`CloudWatch query ${queryId} ended with status ${result.status}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`CloudWatch query ${queryId} exceeded ${this.options.maxQuerySeconds}s`);
      }
      await sleep(this.options.pollIntervalMs);
    }
  }

  async detect(window: TimeWindow): Promise<LogSignal[]> {
    const query = renderQuery(this.options.detectionQuery, {
      windowMinutes: Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / 60_000)),
      minOccurrences: 1,
    });
    const rows = await this.runInsights(query, window, this.options.maxRows);
    return rows.map((row) => {
      const exceptionType = String(row['errorType'] ?? row['extype'] ?? 'unknown');
      const message = String(row['@message'] ?? row['message'] ?? exceptionType);
      const frames = extractAppFrames(String(row['stack'] ?? row['@message'] ?? ''), this.options.appNamespaces);
      return {
        id: `${this.id}:${exceptionType}`,
        sourceId: this.id,
        fingerprint: fingerprintSignal({ exceptionType, message, frames }),
        title: `${exceptionType} in ${row['service'] ?? this.options.service}`,
        service: String(row['service'] ?? this.options.service),
        environment: this.options.environment,
        level: String(row['level'] ?? 'ERROR'),
        count: Number(row['c'] ?? row['count'] ?? 0),
        affectedUsers: row['users'] != null ? Number(row['users']) : null,
        firstSeen: String(row['first'] ?? window.from),
        lastSeen: String(row['last'] ?? window.to),
        exceptionType,
        topFrames: frames,
        sampleEvents: [],
        versions: [],
        hosts: row['@logStream'] != null ? [String(row['@logStream'])] : [],
        regions: [this.options.region],
        query,
        dashboardUrl: null,
        raw: row,
      } satisfies LogSignal;
    });
  }

  async gather(signal: LogSignal, options: GatherOptions): Promise<LogEvidence> {
    const window: TimeWindow = { from: signal.firstSeen, to: signal.lastSeen };
    const escaped = (signal.exceptionType ?? '').replace(/[/\\]/g, '');

    const samples = await this.runInsights(
      `fields @timestamp, @message, @logStream | filter @message like /${escaped}/ | sort @timestamp desc | limit ${options.maxSamples}`,
      window,
      options.maxSamples,
    );

    const timeline = await this.runInsights(
      `filter @message like /${escaped}/ | stats count() as c by bin(5m)`,
      window,
      500,
    );

    return {
      signal: { ...signal, sampleEvents: samples.map((row) => toLogEvent(row, this.options.appNamespaces)) },
      timeline: timeline.map((t) => ({ bucket: String(t['bin(5m)'] ?? ''), count: Number(t['c'] ?? 0) })),
      blast: { affectedUsers: signal.affectedUsers, affectedRequests: signal.count, trafficShare: null },
      spread: {
        versions: [],
        hosts: [...new Set(samples.map((s) => String(s['@logStream'] ?? '')).filter(Boolean))],
        regions: [this.options.region],
      },
      correlations: [],
      precedingEvents: [],
      dependencyErrors: [],
    };
  }

  async query(spec: LogQuerySpec): Promise<LogQueryResult> {
    const rows = await this.runInsights(spec.query, spec.window, spec.maxRows);
    return { rows, truncated: rows.length >= spec.maxRows };
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const now = Date.now();
    try {
      await this.runInsights(
        'fields @timestamp | limit 1',
        { from: new Date(now - 600_000).toISOString(), to: new Date(now).toISOString() },
        1,
      );
      return { ok: true, detail: this.options.logGroupNames.join(', '), checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}

/**
 * Multi-line stack traces arrive as separate events unless the log driver joins
 * them. Reassembly by log stream and timestamp proximity belongs here; when it
 * cannot be done confidently the connector reports rather than guesses.
 */
function toLogEvent(row: Record<string, unknown>, appNamespaces: string[]): LogEvent {
  const message = redact(String(row['@message'] ?? ''));
  const frames = extractAppFrames(message, appNamespaces);
  return {
    timestamp: String(row['@timestamp'] ?? ''),
    message,
    stackTrace: frames.length > 0 ? frames.join('\n') : null,
    traceId: row['traceId'] != null ? String(row['traceId']) : null,
    attributes: { logStream: String(row['@logStream'] ?? '') },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
