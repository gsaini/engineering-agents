import { MemoryLogSource } from './connectors/logs/types.js';
import { MemoryCodeHost } from './connectors/scm/types.js';
import { MemoryWorkItemSource } from './connectors/work-items/types.js';
import { fingerprintSignal } from './core/ids.js';
import type { LogSignal, RepoInfo, WorkItem } from './core/types.js';

/**
 * Demo data for `--dry-run`.
 *
 * Together with `DryRunAgentRunner` and `MemorySandboxFactory` this makes the
 * whole pipeline runnable on a laptop with no credentials, no repository access,
 * and no token spend — which is what makes the pipelines testable at all.
 */

export const DEMO_REPO = 'demo-service';

export function demoWorkItem(): WorkItem {
  return {
    id: 'DEMO-1',
    key: 'DEMO-1',
    sourceId: 'demo-work-items',
    type: 'story',
    rawType: 'User Story',
    title: 'Add idempotency keys to the refund API',
    description:
      'Clients retry refund requests on timeout. Each retry currently creates a new refund, ' +
      'so a customer can be refunded twice for one transaction.',
    acceptanceCriteria:
      '- A refund request may carry an idempotency key\n' +
      '- Repeating a key returns the original refund and does not charge again\n' +
      '- A request with no key behaves as it does today',
    reproSteps: null,
    state: 'New',
    priority: '2',
    labels: ['agent-ready'],
    assignee: null,
    areaPath: 'Payments\\Core',
    parent: null,
    links: [],
    comments: [
      {
        author: 'Priya',
        body: 'Keys are client-generated UUIDs — same convention as the payments endpoint.',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ],
    attachments: [],
    rev: '3',
    url: 'https://example.invalid/work-items/DEMO-1',
    updatedAt: '2026-08-14T10:05:00.000Z',
    raw: {},
  };
}

export function demoLogSignal(): LogSignal {
  const frames = ['at Demo.Refunds.RefundService.ProcessAsync (RefundService.cs:142)'];
  return {
    id: 'demo-logs:NullReferenceException',
    sourceId: 'demo-logs',
    fingerprint: fingerprintSignal({
      exceptionType: 'NullReferenceException',
      message: 'Object reference not set to an instance of an object',
      frames,
    }),
    title: 'NullReferenceException at RefundService.ProcessAsync',
    service: 'payments-api',
    environment: 'production',
    level: 'error',
    count: 47,
    affectedUsers: 12,
    firstSeen: '2026-08-14T09:12:00.000Z',
    lastSeen: '2026-08-14T09:27:00.000Z',
    exceptionType: 'NullReferenceException',
    topFrames: frames,
    sampleEvents: [
      {
        timestamp: '2026-08-14T09:12:04.000Z',
        message: 'Object reference not set to an instance of an object',
        stackTrace: frames.join('\n'),
        traceId: 'trace-0001',
        attributes: { cloud_RoleName: 'payments-api' },
      },
    ],
    versions: ['2026.8.14'],
    hosts: ['payments-api-7f9c', 'payments-api-2b41'],
    regions: ['westeurope'],
    query: 'exceptions | where timestamp > ago(15m) | summarize count() by problemId',
    dashboardUrl: null,
    raw: {},
  };
}

export function demoRepo(): RepoInfo {
  return {
    name: DEMO_REPO,
    cloneUrl: 'https://example.invalid/demo-service.git',
    defaultBranch: 'main',
    testCommand: 'npm test',
    buildCommand: null,
    webUrl: 'https://example.invalid/demo-service',
  };
}

export function demoConnectors(): {
  workItemSource: MemoryWorkItemSource;
  logSource: MemoryLogSource;
  codeHost: MemoryCodeHost;
} {
  return {
    workItemSource: new MemoryWorkItemSource('demo-work-items', [demoWorkItem()]),
    logSource: new MemoryLogSource('demo-logs', 'payments-api', 'production', [demoLogSignal()]),
    codeHost: new MemoryCodeHost('demo-code-host', [demoRepo()]),
  };
}
