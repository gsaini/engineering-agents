import type { ConnectorConfig } from '../config/schema.js';
import { AppInsightsLogSource } from './logs/app-insights.js';
import { CloudWatchLogSource, type CloudWatchClient } from './logs/cloudwatch.js';
import { SplunkLogSource } from './logs/splunk.js';
import type { LogSource } from './logs/types.js';
import { ConsoleNotifier, type Notifier } from './notify/types.js';
import { SlackNotifier } from './notify/slack.js';
import { AzureReposCodeHost } from './scm/azure-repos.js';
import { GitHubCodeHost } from './scm/github.js';
import type { CodeHost } from './scm/types.js';
import { AzureDevOpsWorkItemSource } from './work-items/azure-devops.js';
import { JiraWorkItemSource } from './work-items/jira.js';
import type { WorkItemSource } from './work-items/types.js';

/**
 * Provider construction.
 *
 * Adding a provider is one file plus one case here plus a config schema entry.
 * The pipelines never change — that is the point of the connector layer
 * (ADR 0002).
 */

export class UnknownProviderError extends Error {
  constructor(kind: string, provider: string, known: string[]) {
    super(`Unknown ${kind} provider "${provider}". Known providers: ${known.join(', ')}`);
    this.name = 'UnknownProviderError';
  }
}

export interface RegistryDeps {
  /** Injected so the CloudWatch connector is testable without the AWS SDK. */
  cloudWatchClientFactory?: (region: string) => CloudWatchClient;
}

export function createWorkItemSource(config: ConnectorConfig): WorkItemSource {
  switch (config.provider) {
    case 'azure-devops':
      return new AzureDevOpsWorkItemSource(config.id, config.options);
    case 'jira':
      return new JiraWorkItemSource(config.id, config.options);
    default:
      throw new UnknownProviderError('workItemSource', config.provider, ['azure-devops', 'jira']);
  }
}

export function createLogSource(config: ConnectorConfig, deps: RegistryDeps = {}): LogSource {
  switch (config.provider) {
    case 'app-insights':
      return new AppInsightsLogSource(config.id, config.options);
    case 'splunk':
      return new SplunkLogSource(config.id, config.options);
    case 'cloudwatch': {
      if (!deps.cloudWatchClientFactory) {
        throw new Error(
          'The cloudwatch provider needs a CloudWatch client. Pass cloudWatchClientFactory ' +
            'when building the registry (see src/connectors/logs/cloudwatch.ts).',
        );
      }
      const region = String(config.options['region'] ?? 'us-east-1');
      return new CloudWatchLogSource(config.id, config.options, deps.cloudWatchClientFactory(region));
    }
    default:
      throw new UnknownProviderError('logSource', config.provider, ['app-insights', 'cloudwatch', 'splunk']);
  }
}

export function createCodeHost(config: ConnectorConfig): CodeHost {
  switch (config.provider) {
    case 'azure-repos':
      return new AzureReposCodeHost(config.id, config.options);
    case 'github':
      return new GitHubCodeHost(config.id, config.options);
    default:
      throw new UnknownProviderError('codeHost', config.provider, ['azure-repos', 'github']);
  }
}

export function createNotifier(config: ConnectorConfig): Notifier {
  switch (config.provider) {
    case 'slack':
      return new SlackNotifier(config.id, config.options);
    case 'console':
      return new ConsoleNotifier(config.id);
    default:
      throw new UnknownProviderError('notifier', config.provider, ['slack', 'console']);
  }
}

export interface Connectors {
  workItemSources: Map<string, WorkItemSource>;
  logSources: Map<string, LogSource>;
  codeHosts: Map<string, CodeHost>;
  notifiers: Map<string, Notifier>;
}

export function buildConnectors(
  config: {
    workItemSources: ConnectorConfig[];
    logSources: ConnectorConfig[];
    codeHosts: ConnectorConfig[];
    notifiers: ConnectorConfig[];
  },
  deps: RegistryDeps = {},
): Connectors {
  return {
    workItemSources: new Map(config.workItemSources.map((c) => [c.id, createWorkItemSource(c)])),
    logSources: new Map(config.logSources.map((c) => [c.id, createLogSource(c, deps)])),
    codeHosts: new Map(config.codeHosts.map((c) => [c.id, createCodeHost(c)])),
    notifiers: new Map(config.notifiers.map((c) => [c.id, createNotifier(c)])),
  };
}

/** Fail fast at startup rather than mid-run at 3am. */
export async function checkAllHealth(connectors: Connectors): Promise<{ id: string; kind: string; ok: boolean; detail: string }[]> {
  const checks: Promise<{ id: string; kind: string; ok: boolean; detail: string }>[] = [];
  const add = (kind: string, id: string, check: () => Promise<{ ok: boolean; detail: string }>): void => {
    checks.push(check().then((r) => ({ id, kind, ...r })));
  };
  for (const [id, c] of connectors.workItemSources) add('workItemSource', id, () => c.healthCheck());
  for (const [id, c] of connectors.logSources) add('logSource', id, () => c.healthCheck());
  for (const [id, c] of connectors.codeHosts) add('codeHost', id, () => c.healthCheck());
  for (const [id, c] of connectors.notifiers) add('notifier', id, () => c.healthCheck());
  return Promise.all(checks);
}
