import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Replace `${VAR}` references with environment values.
 *
 * Config files carry references, never literals, so a checked-in config can
 * never leak a credential. A missing variable is a startup failure rather than
 * an empty string, because an empty token fails much later and much less
 * legibly.
 */
export function interpolateEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing: string[] = [];
  const out = raw.replace(ENV_REF, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing environment variables referenced by config: ${[...new Set(missing)].join(', ')}`,
    );
  }
  return out;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read config file: ${path}`);
  }
  const interpolated = interpolateEnv(raw, env);
  const parsed = parse(interpolated) as unknown;
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config at ${path}:\n${issues}`);
  }
  validateReferences(result.data);
  return result.data;
}

/**
 * Cross-reference check: an agent naming a source, code host, or notifier that
 * does not exist is a config error, not a runtime surprise.
 */
export function validateReferences(config: Config): void {
  const problems: string[] = [];
  const ids = (list: { id: string }[]): Set<string> => new Set(list.map((c) => c.id));
  const workItemIds = ids(config.workItemSources);
  const logIds = ids(config.logSources);
  const hostIds = ids(config.codeHosts);
  const notifierIds = ids(config.notifiers);

  const ticket = config.agents.ticketToMr;
  if (ticket?.enabled) {
    for (const s of ticket.sources) {
      if (!workItemIds.has(s)) problems.push(`agents.ticketToMr.sources: unknown workItemSource "${s}"`);
    }
    if (!hostIds.has(ticket.codeHost)) {
      problems.push(`agents.ticketToMr.codeHost: unknown codeHost "${ticket.codeHost}"`);
    }
    if (!notifierIds.has(ticket.notifier)) {
      problems.push(`agents.ticketToMr.notifier: unknown notifier "${ticket.notifier}"`);
    }
  }

  const logs = config.agents.logTriage;
  if (logs?.enabled) {
    for (const s of logs.sources) {
      if (!logIds.has(s)) problems.push(`agents.logTriage.sources: unknown logSource "${s}"`);
    }
    if (!hostIds.has(logs.codeHost)) {
      problems.push(`agents.logTriage.codeHost: unknown codeHost "${logs.codeHost}"`);
    }
    if (!notifierIds.has(logs.notifier)) {
      problems.push(`agents.logTriage.notifier: unknown notifier "${logs.notifier}"`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid config references:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
