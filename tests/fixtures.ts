import type { LogSignal, RepoInfo, WorkItem } from '../src/core/types.js';

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: '4412',
    key: 'PAY-4412',
    sourceId: 'ado-test',
    type: 'story',
    rawType: 'User Story',
    title: 'Add idempotency keys to the refund API',
    description: 'Retried refund requests currently create duplicate refunds.',
    acceptanceCriteria: 'A repeated idempotency key returns the original refund.',
    reproSteps: null,
    state: 'New',
    priority: '2',
    labels: ['agent-ready'],
    assignee: null,
    areaPath: 'Payments\\Core',
    parent: null,
    links: [],
    comments: [
      { author: 'Priya', body: 'Keys are client-generated UUIDs.', createdAt: '2026-08-14T10:00:00.000Z' },
    ],
    attachments: [],
    rev: '3',
    url: 'https://dev.azure.com/contoso/Payments/_workitems/edit/4412',
    updatedAt: '2026-08-14T10:05:00.000Z',
    raw: {},
    ...overrides,
  };
}

export function logSignal(overrides: Partial<LogSignal> = {}): LogSignal {
  return {
    id: 'appinsights-prod:NullReferenceException',
    sourceId: 'appinsights-prod',
    fingerprint: 'a3f9c1de00000000000000000000000f',
    title: 'NullReferenceException at RefundService.ProcessAsync',
    service: 'payments-api',
    environment: 'production',
    level: 'error',
    count: 47,
    affectedUsers: 12,
    firstSeen: '2026-08-14T09:12:00.000Z',
    lastSeen: '2026-08-14T09:27:00.000Z',
    exceptionType: 'NullReferenceException',
    topFrames: ['at RefundService.ProcessAsync (RefundService.cs:142)'],
    sampleEvents: [],
    versions: ['2026.8.14'],
    hosts: ['payments-api-7f9c'],
    regions: ['westeurope'],
    query: 'exceptions | where timestamp > ago(15m)',
    dashboardUrl: null,
    raw: {},
    ...overrides,
  };
}

export function repoInfo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    name: 'payments-service',
    cloneUrl: 'https://example.invalid/payments-service.git',
    defaultBranch: 'main',
    testCommand: 'npm test',
    buildCommand: null,
    webUrl: 'https://example.invalid/payments-service',
    ...overrides,
  };
}
