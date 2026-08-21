#!/usr/bin/env node
import { resolve } from 'node:path';

import { DryRunAgentRunner } from './agent/dry-runner.js';
import { ClaudeCodeAgentRunner } from './agent/claude-runner.js';
import type { AgentRunner } from './agent/runner.js';
import type { PipelineDeps } from './agents/context.js';
import * as logTriage from './agents/log-triage/pipeline.js';
import * as ticketToMr from './agents/ticket-to-mr/pipeline.js';
import { loadConfig, ConfigError } from './config/load.js';
import type { Config } from './config/schema.js';
import { buildConnectors, checkAllHealth, type Connectors } from './connectors/registry.js';
import { ConsoleNotifier } from './connectors/notify/types.js';
import { createLogger, type Logger } from './core/logger.js';
import { FileRunStore } from './core/store.js';
import type { RejectionReason } from './core/run.js';
import { ApprovalService } from './runtime/approvals.js';
import { BudgetGuard } from './runtime/budget.js';
import { Orchestrator } from './runtime/orchestrator.js';
import { MemorySandboxFactory, WorktreeSandboxFactory } from './runtime/sandbox.js';
import { FileCursorStore, Watcher } from './runtime/watcher.js';
import { DEMO_REPO, demoConnectors } from './demo.js';

const USAGE = `
engineering-agents

  eng-agents validate [--config path]        Validate config and check connector health
  eng-agents watch [--once] [--dry-run]      Poll enabled sources and drive runs
  eng-agents run --work-item <key>           Run the ticket-to-MR pipeline for one item
  eng-agents run --signal <fingerprint>      Run the log-triage pipeline for one signal
  eng-agents status [--state STATE]          List runs
  eng-agents show <runId>                    Print a run record
  eng-agents approve <runId> [--as name]     Record an approval
  eng-agents reject <runId> --reason <r>     Record a rejection (reason required)
  eng-agents pause [--agent name]            Set the kill switch for this process
  eng-agents cancel <runId>                  Cancel a run

Options:
  --config <path>   Config file (default: config/config.yaml)
  --dry-run         No API calls, no external writes
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  // A leading flag (`eng-agents --help`) is not a command.
  const first = argv[0];
  const command = first && !first.startsWith('-') ? first : 'help';
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token) continue;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

async function buildDeps(config: Config, logger: Logger, dryRun: boolean): Promise<{ deps: PipelineDeps; connectors: Connectors }> {
  const store = new FileRunStore(resolve(config.runtime.runStoreDir));
  const budget = new BudgetGuard(store, config.guardrails.limits);
  const ticket = config.agents.ticketToMr;
  const logs = config.agents.logTriage;

  // Dry run: in-memory everything. No credentials, no repository access, no
  // tokens — the full pipeline is still exercised end to end.
  if (dryRun) {
    const demo = demoConnectors();
    const notifier = new ConsoleNotifier('console');
    const deps: PipelineDeps = {
      config: withDemoMappings(config),
      store,
      runner: new DryRunAgentRunner(),
      codeHost: demo.codeHost,
      notifier,
      approvals: new ApprovalService(store, notifier, logger),
      budget,
      sandboxes: new MemorySandboxFactory(resolve(config.runtime.worktreeDir)),
      workItemSource: demo.workItemSource,
      logSource: demo.logSource,
      logger,
      dryRun: true,
    };
    const empty: Connectors = {
      workItemSources: new Map(),
      logSources: new Map(),
      codeHosts: new Map(),
      notifiers: new Map(),
    };
    return { deps, connectors: empty };
  }

  const connectors = buildConnectors(config);
  const notifierId = ticket?.notifier ?? logs?.notifier ?? 'console';
  const notifier = connectors.notifiers.get(notifierId) ?? new ConsoleNotifier('console');
  const codeHostId = ticket?.codeHost ?? logs?.codeHost ?? '';
  const codeHost = connectors.codeHosts.get(codeHostId);
  if (!codeHost) throw new ConfigError(`Code host "${codeHostId}" is not configured`);

  const deps: PipelineDeps = {
    config,
    store,
    runner: new ClaudeCodeAgentRunner(logger) satisfies AgentRunner,
    codeHost,
    notifier,
    approvals: new ApprovalService(store, notifier, logger),
    budget,
    sandboxes: new WorktreeSandboxFactory(resolve(config.runtime.worktreeDir), logger),
    logger,
    dryRun: false,
  };

  const firstWorkItemSource = ticket?.sources[0];
  if (firstWorkItemSource) deps.workItemSource = connectors.workItemSources.get(firstWorkItemSource);
  const firstLogSource = logs?.sources[0];
  if (firstLogSource) deps.logSource = connectors.logSources.get(firstLogSource);

  return { deps, connectors };
}

/**
 * Point the configured agents at the demo repo and service, so a dry run works
 * against any config file rather than only against one written for the demo.
 */
function withDemoMappings(config: Config): Config {
  const next: Config = structuredClone(config);
  if (next.agents.ticketToMr) {
    next.agents.ticketToMr.repoMapping = { ...next.agents.ticketToMr.repoMapping, 'Payments\\Core': DEMO_REPO };
  }
  if (next.agents.logTriage) {
    next.agents.logTriage.serviceRepoMapping = {
      ...next.agents.logTriage.serviceRepoMapping,
      'payments-api': DEMO_REPO,
    };
  }
  return next;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags['help']) {
    process.stdout.write(USAGE);
    return 0;
  }

  const configPath = String(args.flags['config'] ?? 'config/config.yaml');
  const dryRun = args.flags['dry-run'] === true;

  let config: Config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const logger = createLogger(config.observability.logLevel);

  switch (args.command) {
    case 'validate': {
      const { connectors } = await buildDeps(config, logger, false);
      const results = await checkAllHealth(connectors);
      let ok = true;
      for (const r of results) {
        process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.kind} ${r.id}: ${r.detail}\n`);
        if (!r.ok) ok = false;
      }
      process.stdout.write(ok ? '\nConfig valid, all connectors healthy.\n' : '\nSome connectors are unhealthy.\n');
      return ok ? 0 : 1;
    }

    case 'watch': {
      const { deps } = await buildDeps(config, logger, dryRun);
      const orchestrator = new Orchestrator(deps);
      const cursors = new FileCursorStore(resolve(config.runtime.runStoreDir));
      const watcher = new Watcher(deps, orchestrator, deps.budget, cursors);

      await deps.sandboxes.reapOrphans(config.runtime.worktreeTtlHours);
      if (config.runtime.resumeOnStartup) {
        const resumed = await orchestrator.resumeAll();
        logger.info('resumed runs', { count: resumed });
      }

      const once = args.flags['once'] === true;
      for (;;) {
        const result = await watcher.tick();
        logger.info('poll complete', result);
        if (once) return 0;
        await sleep(config.runtime.pollIntervalSeconds * 1000);
      }
    }

    case 'run': {
      const { deps } = await buildDeps(config, logger, dryRun);
      const orchestrator = new Orchestrator(deps);
      const workItemKey = args.flags['work-item'];

      if (typeof workItemKey === 'string') {
        if (!deps.workItemSource) {
          process.stderr.write('No work item source configured (or running with --dry-run).\n');
          return 1;
        }
        const item = await deps.workItemSource.get(workItemKey);
        const run = await ticketToMr.startTicketRun(deps, item);
        const advanced = await orchestrator.advance(run);
        process.stdout.write(`${advanced.meta.runId}: ${advanced.state}\n`);
        return 0;
      }

      const fingerprint = args.flags['signal'];
      if (typeof fingerprint === 'string') {
        if (!deps.logSource) {
          process.stderr.write('No log source configured (or running with --dry-run).\n');
          return 1;
        }
        const windowMinutes = config.agents.logTriage?.detection.windowMinutes ?? 15;
        const detected = await logTriage.detectSignals(deps.logSource, windowMinutes);
        const signal = detected.signals.find((s) => s.fingerprint.startsWith(fingerprint));
        if (!signal) {
          process.stderr.write(`No signal matching "${fingerprint}" in the last ${windowMinutes}m.\n`);
          if (detected.signals.length > 0) {
            process.stderr.write('Available:\n');
            for (const s of detected.signals) {
              process.stderr.write(`  ${s.fingerprint.slice(0, 12)}  ${s.title} (${s.count} occurrences)\n`);
            }
          }
          return 1;
        }
        const run = await logTriage.startLogRun(deps, signal);
        const advanced = await orchestrator.advance(run);
        process.stdout.write(`${advanced.meta.runId}: ${advanced.state}\n`);
        return 0;
      }

      process.stderr.write('Specify --work-item <key> or --signal <fingerprint>.\n');
      return 1;
    }

    case 'status': {
      const store = new FileRunStore(resolve(config.runtime.runStoreDir));
      const state = typeof args.flags['state'] === 'string' ? args.flags['state'] : undefined;
      const runs = await store.list({ ...(state ? { state: state as never } : {}), limit: 50 });
      for (const run of runs) {
        const trigger = run.trigger.kind === 'work-item' ? run.trigger.workItem.key : run.trigger.signal.fingerprint.slice(0, 8);
        process.stdout.write(
          `${run.meta.runId}  ${run.state.padEnd(18)} ${run.meta.agent.padEnd(13)} ${trigger.padEnd(14)} $${run.cost.usd.toFixed(2)}\n`,
        );
      }
      if (runs.length === 0) process.stdout.write('No runs.\n');
      return 0;
    }

    case 'show': {
      const runId = args.positional[0];
      if (!runId) {
        process.stderr.write('Usage: eng-agents show <runId>\n');
        return 1;
      }
      const store = new FileRunStore(resolve(config.runtime.runStoreDir));
      const run = await store.load(runId);
      if (!run) {
        process.stderr.write(`Run not found: ${runId}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      return 0;
    }

    case 'approve':
    case 'reject': {
      const runId = args.positional[0];
      if (!runId) {
        process.stderr.write(`Usage: eng-agents ${args.command} <runId>\n`);
        return 1;
      }
      const { deps } = await buildDeps(config, logger, dryRun);
      const actor = String(args.flags['as'] ?? process.env['USER'] ?? 'cli');

      if (args.command === 'reject') {
        const reason = args.flags['reason'];
        if (typeof reason !== 'string') {
          process.stderr.write(
            'A rejection reason is required: wrong-approach | misunderstood-requirement | too-risky |\n' +
              'already-being-done | not-worth-doing | wrong-repo-or-area | other\n',
          );
          return 1;
        }
        await deps.approvals.record(runId, 'reject', actor, { rejectionReason: reason as RejectionReason });
      } else {
        await deps.approvals.record(runId, 'approve', actor);
      }

      const run = await deps.store.load(runId);
      if (!run) return 1;
      const advanced = await new Orchestrator(deps).advance(run);
      process.stdout.write(`${advanced.meta.runId}: ${advanced.state}\n`);
      return 0;
    }

    case 'cancel': {
      const runId = args.positional[0];
      if (!runId) {
        process.stderr.write('Usage: eng-agents cancel <runId>\n');
        return 1;
      }
      const store = new FileRunStore(resolve(config.runtime.runStoreDir));
      const run = await store.load(runId);
      if (!run) {
        process.stderr.write(`Run not found: ${runId}\n`);
        return 1;
      }
      await store.append(runId, {
        type: 'transition',
        actor: 'user:cli',
        from: run.state,
        to: 'CANCELLED',
      });
      process.stdout.write(`${runId}: CANCELLED\n`);
      return 0;
    }

    case 'pause': {
      // Process-local. The durable kill switch is the KILL_SWITCH env var, or
      // revoking the service account token — see docs/09-operations.md.
      process.env['KILL_SWITCH'] = '1';
      process.stdout.write('Kill switch set for this process. Set KILL_SWITCH=1 in the environment to make it durable.\n');
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${args.command}\n${USAGE}`);
      return 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
