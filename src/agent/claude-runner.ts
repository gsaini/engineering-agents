import { resolve } from 'node:path';

import type { Logger } from '../core/logger.js';
import {
  extractJson,
  TOOLS_BY_POLICY,
  type AgentRunner,
  type AgentRunResult,
  type AgentRunSpec,
  type ToolDenial,
} from './runner.js';

/**
 * Claude Agent SDK runner.
 *
 * The SDK is loaded dynamically so the rest of the system builds, tests, and
 * dry-runs without it installed. It is an optional dependency for exactly this
 * reason.
 *
 * Guardrail enforcement happens here, not in the prompt (docs/05-guardrails.md):
 * `allowedTools` bounds the tool surface, `canUseTool` rejects path escapes and
 * disallowed commands, and `maxBudgetUsd` is a hard stop the model cannot talk
 * its way past.
 */
export class ClaudeCodeAgentRunner implements AgentRunner {
  constructor(private readonly logger: Logger) {}

  async run<T = unknown>(spec: AgentRunSpec): Promise<AgentRunResult<T>> {
    const started = Date.now();
    const denials: ToolDenial[] = [];

    const sdk = await loadAgentSdk();
    if (!sdk) {
      return failure(
        spec,
        started,
        '@anthropic-ai/claude-agent-sdk is not installed. Run `npm install @anthropic-ai/claude-agent-sdk`, or use --dry-run.',
      );
    }

    const allowedTools = TOOLS_BY_POLICY[spec.toolPolicy];
    const worktree = resolve(spec.cwd);

    const response = sdk.query({
      prompt: spec.prompt,
      options: {
        model: spec.model,
        systemPrompt: spec.system,
        cwd: worktree,
        // Empty: the agent sees its worktree and nothing else.
        additionalDirectories: [],
        tools: allowedTools,
        allowedTools,
        maxTurns: spec.maxTurns,
        maxBudgetUsd: spec.budgetUsd,
        permissionMode: 'default',
        // Project settings files are not loaded — the agent's policy comes from
        // this config, not from whatever happens to be in the target repo.
        settingSources: [],
        abortController: toAbortController(spec.abortSignal),
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          const denial = checkTool(toolName, input, {
            worktree,
            allowedCommands: spec.allowedCommands,
            protectedPaths: spec.protectedPaths,
          });
          if (denial) {
            denials.push({ tool: toolName, input, reason: denial });
            this.logger.warn('tool denied', { stage: spec.stage, tool: toolName, reason: denial });
            return { behavior: 'deny', message: denial };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    let result: SdkResultMessage | null = null;
    for await (const message of response) {
      if (isResultMessage(message)) result = message;
    }

    const durationMs = Date.now() - started;
    if (!result) return failure(spec, started, 'Agent produced no result message', denials);

    if (result.subtype !== 'success') {
      return {
        ok: false,
        data: null,
        text: '',
        costUsd: result.total_cost_usd ?? 0,
        inputTokens: usageIn(result),
        outputTokens: usageOut(result),
        durationMs,
        turns: result.num_turns ?? 0,
        denials,
        error: `${result.subtype}: ${(result.errors ?? []).join('; ')}`,
      };
    }

    let data: T | null = null;
    let error: string | null = null;
    if (spec.schema) {
      const parsed = spec.schema.safeParse(safeExtract(result.result));
      if (parsed.success) {
        data = parsed.data as T;
      } else {
        error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      }
    }

    return {
      ok: error === null,
      data,
      text: result.result ?? '',
      costUsd: result.total_cost_usd ?? 0,
      inputTokens: usageIn(result),
      outputTokens: usageOut(result),
      durationMs,
      turns: result.num_turns ?? 0,
      denials,
      error,
    };
  }
}

// ---------------------------------------------------------------- guardrails

export interface ToolCheckContext {
  worktree: string;
  allowedCommands: string[];
  protectedPaths: string[];
}

/**
 * Returns a denial reason, or null to allow.
 *
 * Exported and pure so the policy is unit-testable — this is the enforcement
 * point, and enforcement that is not tested is decoration.
 */
export function checkTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolCheckContext,
): string | null {
  const path = typeof input['file_path'] === 'string' ? input['file_path'] : null;
  if (path) {
    const absolute = resolve(ctx.worktree, path);
    if (!absolute.startsWith(`${ctx.worktree}/`) && absolute !== ctx.worktree) {
      return `Path is outside the run worktree: ${path}`;
    }
    const relative = absolute.slice(ctx.worktree.length + 1);
    for (const pattern of ctx.protectedPaths) {
      if (matchesGlob(relative, pattern)) return `Path is protected by guardrails: ${pattern}`;
    }
  }

  if (toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    if (!command) return 'Empty bash command';
    const allowed = ctx.allowedCommands.some((prefix) => command.trim().startsWith(prefix));
    if (!allowed) {
      return `Command not in the allowlist. Allowed: ${ctx.allowedCommands.join(', ') || '(none)'}`;
    }
    // Belt and braces: the allowlist is prefix-based, so block the operators
    // that would chain something else onto an allowed prefix.
    if (/[;&|]|\$\(|`/.test(command)) {
      return 'Command chaining and substitution are not permitted';
    }
  }

  return null;
}

/**
 * Minimal glob matcher covering the `**`, `*`, and `?` forms used in guardrail
 * config.
 *
 * Built by scanning rather than by chained `replace` calls: chained replaces
 * rewrite the regex syntax they have just inserted (`(?:` becomes `([^/]:`),
 * which silently turns a protected-path pattern into one that matches nothing.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*\\/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char && '.+^${}()|[]\\/'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`).test(path);
}

// ---------------------------------------------------------------- SDK glue

interface SdkResultMessage {
  type: 'result';
  subtype: string;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  errors?: string[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AgentSdk {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<unknown>;
}

async function loadAgentSdk(): Promise<AgentSdk | null> {
  try {
    return (await import('@anthropic-ai/claude-agent-sdk')) as unknown as AgentSdk;
  } catch {
    return null;
  }
}

function isResultMessage(message: unknown): message is SdkResultMessage {
  return typeof message === 'object' && message !== null && (message as { type?: string }).type === 'result';
}

function usageIn(result: SdkResultMessage): number {
  return result.usage?.input_tokens ?? 0;
}

function usageOut(result: SdkResultMessage): number {
  return result.usage?.output_tokens ?? 0;
}

function safeExtract(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

function toAbortController(signal: AbortSignal | undefined): AbortController | undefined {
  if (!signal) return undefined;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

function failure<T>(
  spec: AgentRunSpec,
  started: number,
  error: string,
  denials: ToolDenial[] = [],
): AgentRunResult<T> {
  return {
    ok: false,
    data: null,
    text: '',
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: Date.now() - started,
    turns: 0,
    denials,
    error: `[${spec.stage}] ${error}`,
  };
}
