import { execFile } from 'node:child_process';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from '../core/logger.js';

const exec = promisify(execFile);

export interface Sandbox {
  readonly path: string;
  readonly branch: string;
  git(...args: string[]): Promise<string>;
  run(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  diff(): Promise<string>;
  diffStat(): Promise<{ files: string[]; lines: number }>;
  dispose(): Promise<void>;
}

export interface SandboxFactory {
  create(input: {
    runId: string;
    cloneUrl: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<Sandbox>;
  reapOrphans(ttlHours: number): Promise<string[]>;
}

/**
 * Git worktree per run, cut from a cached bare clone (ADR 0004).
 *
 * Cheap enough to create per run, concurrency-safe by construction, and trivial
 * to clean up. Isolation is filesystem-scoped, not process-scoped — running the
 * repo's own test command executes repo code with this process's privileges.
 * Command allowlisting, network denial and resource caps mitigate that; a
 * container sandbox is the right answer for repos with untrusted contributors.
 */
export class WorktreeSandboxFactory implements SandboxFactory {
  constructor(
    private readonly rootDir: string,
    private readonly logger: Logger,
    private readonly commandTimeoutMs = 600_000,
  ) {}

  private get cacheDir(): string {
    return join(this.rootDir, '.cache');
  }

  private async bareClone(repo: string, cloneUrl: string): Promise<string> {
    const path = join(this.cacheDir, `${repo}.git`);
    if (existsSync(path)) {
      await exec('git', ['--git-dir', path, 'fetch', '--prune', 'origin'], { timeout: this.commandTimeoutMs });
      return path;
    }
    await mkdir(this.cacheDir, { recursive: true });
    await exec('git', ['clone', '--bare', cloneUrl, path], { timeout: this.commandTimeoutMs });
    return path;
  }

  async create(input: {
    runId: string;
    cloneUrl: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<Sandbox> {
    const gitDir = await this.bareClone(input.repo, input.cloneUrl);
    const path = resolve(join(this.rootDir, input.runId));
    await mkdir(this.rootDir, { recursive: true });
    await exec(
      'git',
      ['--git-dir', gitDir, 'worktree', 'add', '-b', input.branch, path, `origin/${input.baseBranch}`],
      { timeout: this.commandTimeoutMs },
    );
    this.logger.info('worktree created', { runId: input.runId, repo: input.repo, path });
    return new WorktreeSandbox(path, input.branch, gitDir, this.commandTimeoutMs, this.logger);
  }

  /** Delete worktrees left behind by a crash. Called at startup. */
  async reapOrphans(ttlHours: number): Promise<string[]> {
    if (!existsSync(this.rootDir)) return [];
    const cutoff = Date.now() - ttlHours * 3_600_000;
    const reaped: string[] = [];
    for (const entry of await readdir(this.rootDir)) {
      if (entry === '.cache') continue;
      const path = join(this.rootDir, entry);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        reaped.push(entry);
      }
    }
    if (reaped.length > 0) this.logger.warn('reaped orphaned worktrees', { count: reaped.length });
    return reaped;
  }
}

class WorktreeSandbox implements Sandbox {
  constructor(
    readonly path: string,
    readonly branch: string,
    private readonly gitDir: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd: this.path, timeout: this.timeoutMs });
    return stdout;
  }

  /**
   * Run a build or test command.
   *
   * The command must already have passed the guardrail allowlist — this runs
   * what it is given. Network egress denial is applied by the caller's sandbox
   * settings; here we only bound time and capture output.
   */
  async run(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const [bin, ...args] = command.split(/\s+/);
    if (!bin) return { stdout: '', stderr: 'Empty command', code: 1 };
    try {
      const { stdout, stderr } = await exec(bin, args, { cwd: this.path, timeout: this.timeoutMs });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? 'unknown error', code: e.code ?? 1 };
    }
  }

  async diff(): Promise<string> {
    return this.git('diff', 'HEAD');
  }

  async diffStat(): Promise<{ files: string[]; lines: number }> {
    const raw = await this.git('diff', '--numstat', 'HEAD');
    const files: string[] = [];
    let lines = 0;
    for (const row of raw.split('\n').filter(Boolean)) {
      const [added, removed, file] = row.split('\t');
      if (!file) continue;
      files.push(file);
      lines += Number(added ?? 0) + Number(removed ?? 0);
    }
    return { files, lines };
  }

  async dispose(): Promise<void> {
    await exec('git', ['--git-dir', this.gitDir, 'worktree', 'remove', '--force', this.path]).catch(
      async () => {
        await rm(this.path, { recursive: true, force: true });
      },
    );
    this.logger.debug('worktree disposed', { path: this.path });
  }
}
