import type { HealthStatus, RiskLevel } from '../../core/types.js';

export interface NotifyMessage {
  runId: string;
  /** All updates for one run go in one thread — a message per stage gets muted. */
  threadKey: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'urgent';
  links: { label: string; url: string }[];
}

export interface ApprovalRequest {
  runId: string;
  threadKey: string;
  title: string;
  subtitle: string;
  repo: string;
  risk: RiskLevel;
  filesChanged: number;
  linesChanged: number;
  warnings: string[];
  approach: string;
  rejectedAlternative: string;
  assumptions: string[];
  fullPlanUrl: string | null;
  ttlHours: number;
}

/**
 * Chat.
 *
 * `requestApproval` does NOT block. It posts and returns; the decision arrives
 * later via webhook or CLI and is appended to the run's event log. That is what
 * lets the process restart mid-approval without losing anything (ADR 0006).
 */
export interface Notifier {
  readonly id: string;
  readonly provider: string;

  notify(message: NotifyMessage): Promise<void>;

  requestApproval(request: ApprovalRequest): Promise<{ ticketRef: string }>;

  healthCheck(): Promise<HealthStatus>;
}

/**
 * Render the approval message.
 *
 * Shared across providers because the *content* decisions matter more than the
 * chat platform: risk and blast radius above the fold, the rejected alternative
 * shown, assumptions visible, and no token counts or model names — see
 * docs/06-human-in-the-loop.md.
 */
export function renderApproval(request: ApprovalRequest): string {
  const riskIcon = { low: '🟢', medium: '🟡', high: '🔴' }[request.risk];
  const lines = [
    `*${request.title}*`,
    request.subtitle,
    '',
    `Repo \`${request.repo}\`  ·  Risk ${riskIcon} ${request.risk}  ·  ${request.filesChanged} files, ~${request.linesChanged} lines`,
  ];
  for (const warning of request.warnings) lines.push(`⚠️ ${warning}`);
  lines.push('', '*Approach*', request.approach);
  if (request.rejectedAlternative) {
    lines.push('', `_Rejected:_ ${request.rejectedAlternative}`);
  }
  if (request.assumptions.length > 0) {
    lines.push('', '*Assumptions*');
    request.assumptions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  lines.push('', `_Expires in ${request.ttlHours}h · run ${request.runId}_`);
  return lines.join('\n');
}

/** Console notifier: decisions arrive via `eng-agents approve <runId>`. */
export class ConsoleNotifier implements Notifier {
  readonly provider = 'console';

  constructor(readonly id: string) {}

  async notify(message: NotifyMessage): Promise<void> {
    process.stdout.write(`\n[${message.severity}] ${message.title}\n${message.body}\n`);
    for (const link of message.links) process.stdout.write(`  ${link.label}: ${link.url}\n`);
  }

  async requestApproval(request: ApprovalRequest): Promise<{ ticketRef: string }> {
    process.stdout.write(`\n${'='.repeat(64)}\n${renderApproval(request)}\n`);
    process.stdout.write(`\nApprove with:  eng-agents approve ${request.runId}\n`);
    process.stdout.write(`Reject with:   eng-agents reject ${request.runId} --reason wrong-approach\n`);
    process.stdout.write(`${'='.repeat(64)}\n`);
    return { ticketRef: `console:${request.runId}` };
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: 'console', checkedAt: new Date().toISOString() };
  }
}
