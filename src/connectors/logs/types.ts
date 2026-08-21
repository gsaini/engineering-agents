import type { HealthStatus, LogEvent, LogEvidence, LogSignal, TimeWindow } from '../../core/types.js';

export interface GatherOptions {
  maxSamples: number;
  precedingEventLimit: number;
  includeDependencyErrors: boolean;
}

export interface LogQuerySpec {
  /** Provider-native query text. Subject to an allowlist — see docs/05-guardrails.md. */
  query: string;
  window: TimeWindow;
  maxRows: number;
}

export interface LogQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * A log platform.
 *
 * Detection lives in the operator's query, not in the model (ADR 0007). The
 * agent's work starts at "here is a cluster above threshold".
 */
export interface LogSource {
  readonly id: string;
  readonly provider: string;
  readonly service: string;
  readonly environment: string;

  /** Run the configured detection query over the window. */
  detect(window: TimeWindow): Promise<LogSignal[]>;

  /** Widen a signal into full evidence: samples, timeline, spread, correlations. */
  gather(signal: LogSignal, options: GatherOptions): Promise<LogEvidence>;

  /** Escape hatch for agent-issued follow-up queries. */
  query(spec: LogQuerySpec): Promise<LogQueryResult>;

  healthCheck(): Promise<HealthStatus>;
}

/**
 * Substitute `{{placeholder}}` tokens in a detection query template.
 *
 * Values are numeric or come from validated config, never from log content —
 * a detection query is never built from untrusted data.
 */
export function renderQuery(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Parse a stack trace into application frames, dropping framework noise.
 *
 * This is what makes fingerprinting work: the same exception type thrown from
 * two different code paths must not collapse into one signal.
 */
export function extractAppFrames(stackTrace: string | null, appNamespaces: string[]): string[] {
  if (!stackTrace) return [];
  const lines = stackTrace.split('\n').map((l) => l.trim()).filter(Boolean);
  const frames = lines.filter((l) => l.startsWith('at ') || l.includes('.py') || l.includes('.js'));
  const app = appNamespaces.length
    ? frames.filter((f) => appNamespaces.some((ns) => f.includes(ns)))
    : frames;
  return (app.length > 0 ? app : frames).slice(0, 10);
}

/** In-memory log source for tests and `--dry-run`. */
export class MemoryLogSource implements LogSource {
  readonly provider = 'memory';

  constructor(
    readonly id: string,
    readonly service: string,
    readonly environment: string,
    private readonly signals: LogSignal[],
    private readonly precedingEvents: LogEvent[] = [],
  ) {}

  async detect(): Promise<LogSignal[]> {
    return this.signals;
  }

  async gather(signal: LogSignal): Promise<LogEvidence> {
    return {
      signal,
      timeline: [{ bucket: signal.firstSeen, count: signal.count }],
      blast: { affectedUsers: signal.affectedUsers, affectedRequests: signal.count, trafficShare: null },
      spread: { versions: signal.versions, hosts: signal.hosts, regions: signal.regions },
      correlations: [],
      precedingEvents: this.precedingEvents,
      dependencyErrors: [],
    };
  }

  async query(): Promise<LogQueryResult> {
    return { rows: [], truncated: false };
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: `memory source with ${this.signals.length} signals`, checkedAt: new Date().toISOString() };
  }
}
