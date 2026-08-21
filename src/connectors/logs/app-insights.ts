import { z } from 'zod';

import { fingerprintSignal } from '../../core/ids.js';
import type { HealthStatus, LogEvent, LogEvidence, LogSignal, TimeWindow } from '../../core/types.js';
import { redact } from '../redact.js';
import { renderQuery, type GatherOptions, type LogQueryResult, type LogQuerySpec, type LogSource } from './types.js';

export const appInsightsOptionsSchema = z.object({
  appId: z.string(),
  apiKey: z.string(),
  service: z.string(),
  environment: z.string(),
  detectionQuery: z.string(),
  baseUrl: z.string().default('https://api.applicationinsights.io/v1'),
  appNamespaces: z.array(z.string()).default([]),
  maxRows: z.number().int().positive().default(500),
});

export type AppInsightsOptions = z.infer<typeof appInsightsOptionsSchema>;

/** The Log Analytics query response shape: columns plus row arrays. */
interface KqlTable {
  name: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}

/** Turn column-and-row tables into records, which is what everything downstream wants. */
export function tableToRecords(table: KqlTable): Record<string, unknown>[] {
  return table.rows.map((row) => {
    const record: Record<string, unknown> = {};
    table.columns.forEach((col, index) => {
      record[col.name] = row[index];
    });
    return record;
  });
}

/**
 * Application Insights.
 *
 * The best of the three providers for frame-to-source mapping:
 * `details[0].parsedStack[]` is structured, with assembly, method, file, and
 * line — no regex parsing of free text required.
 */
export class AppInsightsLogSource implements LogSource {
  readonly provider = 'app-insights';
  private readonly options: AppInsightsOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = appInsightsOptionsSchema.parse(options);
  }

  get service(): string {
    return this.options.service;
  }

  get environment(): string {
    return this.options.environment;
  }

  private async runKql(query: string, window: TimeWindow): Promise<Record<string, unknown>[]> {
    const url = `${this.options.baseUrl}/apps/${this.options.appId}/query`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'X-Api-Key': this.options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        timespan: `${window.from}/${window.to}`,
      }),
    });
    if (!res.ok) {
      throw new Error(`App Insights query failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { tables: KqlTable[] };
    const primary = body.tables[0];
    return primary ? tableToRecords(primary) : [];
  }

  async detect(window: TimeWindow): Promise<LogSignal[]> {
    const query = renderQuery(this.options.detectionQuery, {
      windowMinutes: minutesBetween(window),
      minOccurrences: 1,
    });
    const rows = await this.runKql(query, window);
    return rows.map((row) => this.rowToSignal(row, query, window));
  }

  private rowToSignal(row: Record<string, unknown>, query: string, window: TimeWindow): LogSignal {
    const problemId = String(row['problemId'] ?? row['type'] ?? 'unknown');
    const details = row['any_details'] ?? row['details'];
    const frames = parseParsedStack(details);
    const exceptionType = problemId.split(' at ')[0] ?? problemId;
    const message = String(row['outerMessage'] ?? problemId);

    const versions = toStringArray(row['set_application_Version']);
    return {
      id: `${this.id}:${problemId}`,
      sourceId: this.id,
      fingerprint: fingerprintSignal({ exceptionType, message, frames }),
      title: problemId,
      service: String(row['cloud_RoleName'] ?? this.options.service),
      environment: this.options.environment,
      level: 'error',
      count: Number(row['count_'] ?? row['count'] ?? 0),
      affectedUsers: row['dcount_user_Id'] != null ? Number(row['dcount_user_Id']) : null,
      firstSeen: String(row['min_timestamp'] ?? window.from),
      lastSeen: String(row['max_timestamp'] ?? window.to),
      exceptionType,
      topFrames: frames,
      sampleEvents: [],
      versions,
      hosts: toStringArray(row['set_cloud_RoleInstance']),
      regions: toStringArray(row['set_client_CountryOrRegion']),
      query,
      dashboardUrl: null,
      raw: row,
    };
  }

  async gather(signal: LogSignal, options: GatherOptions): Promise<LogEvidence> {
    const window: TimeWindow = { from: signal.firstSeen, to: signal.lastSeen };
    const problemId = signal.title.replace(/'/g, "\\'");

    const samples = await this.runKql(
      `exceptions | where problemId == '${problemId}' | take ${options.maxSamples} | project timestamp, outerMessage, details, operation_Id, cloud_RoleInstance, application_Version`,
      window,
    );

    const timeline = await this.runKql(
      `exceptions | where problemId == '${problemId}' | summarize count() by bin(timestamp, 5m) | order by timestamp asc`,
      window,
    );

    // operation_Id joins exceptions, requests, dependencies and traces, which is
    // what gives preceding events for free on this platform.
    const operationIds = samples
      .map((s) => String(s['operation_Id'] ?? ''))
      .filter(Boolean)
      .slice(0, 5);
    const preceding = operationIds.length
      ? await this.runKql(
          `traces | where operation_Id in (${operationIds.map((o) => `'${o}'`).join(',')}) | order by timestamp asc | take ${options.precedingEventLimit} | project timestamp, message, operation_Id`,
          window,
        )
      : [];

    const dependencyErrors = options.includeDependencyErrors
      ? await this.runKql(
          `dependencies | where success == false | summarize count() by target, resultCode | top 10 by count_`,
          window,
        )
      : [];

    return {
      signal: { ...signal, sampleEvents: samples.map(toLogEvent) },
      timeline: timeline.map((t) => ({ bucket: String(t['timestamp']), count: Number(t['count_'] ?? 0) })),
      blast: {
        affectedUsers: signal.affectedUsers,
        affectedRequests: signal.count,
        trafficShare: null,
      },
      spread: {
        versions: unique(samples.map((s) => String(s['application_Version'] ?? ''))),
        hosts: unique(samples.map((s) => String(s['cloud_RoleInstance'] ?? ''))),
        regions: signal.regions,
      },
      correlations: [],
      precedingEvents: preceding.map(toLogEvent),
      dependencyErrors: dependencyErrors.map(toLogEvent),
    };
  }

  async query(spec: LogQuerySpec): Promise<LogQueryResult> {
    const rows = await this.runKql(spec.query, spec.window);
    return { rows: rows.slice(0, spec.maxRows), truncated: rows.length > spec.maxRows };
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const now = new Date();
    try {
      await this.runKql('exceptions | take 1', {
        from: new Date(now.getTime() - 3_600_000).toISOString(),
        to: now.toISOString(),
      });
      return { ok: true, detail: `appId ${this.options.appId.slice(0, 8)}...`, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}

function toLogEvent(row: Record<string, unknown>): LogEvent {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'details' || value == null) continue;
    attributes[key] = redact(String(value));
  }
  return {
    timestamp: String(row['timestamp'] ?? ''),
    message: redact(String(row['outerMessage'] ?? row['message'] ?? '')),
    stackTrace: parseParsedStack(row['details']).join('\n') || null,
    traceId: row['operation_Id'] != null ? String(row['operation_Id']) : null,
    attributes,
  };
}

/** App Insights ships parsed stacks as structured JSON — use it rather than regex. */
export function parseParsedStack(details: unknown): string[] {
  if (typeof details === 'string') {
    try {
      return parseParsedStack(JSON.parse(details));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(details)) return [];
  const first = details[0] as { parsedStack?: { assembly?: string; method?: string; fileName?: string; line?: number }[] } | undefined;
  return (first?.parsedStack ?? []).map((frame) => {
    const location = frame.fileName ? ` (${frame.fileName}:${frame.line ?? 0})` : '';
    return `at ${frame.method ?? 'unknown'}${location}`;
  });
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      return (JSON.parse(value) as unknown[]).map(String);
    } catch {
      return [];
    }
  }
  return value == null ? [] : [String(value)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function minutesBetween(window: TimeWindow): number {
  return Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / 60_000));
}
