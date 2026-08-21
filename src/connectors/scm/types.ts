import type { HealthStatus, MergeRequest, MrFilter, OpenMrInput, RepoInfo } from '../../core/types.js';

/**
 * A code host.
 *
 * Git operations (clone, branch, commit, push) are deliberately NOT here — they
 * are plain `git` in the sandbox, which is simpler, provider-agnostic, and
 * identical to what a human does. This interface covers only what needs an API.
 */
export interface CodeHost {
  readonly id: string;
  readonly provider: string;

  getRepo(name: string): Promise<RepoInfo>;

  openMergeRequest(input: OpenMrInput): Promise<MergeRequest>;

  /** Used for dedupe and suppression: is there already an MR for this trigger? */
  findOpenMergeRequests(filter: MrFilter): Promise<MergeRequest[]>;

  commentOnMergeRequest(id: string, markdown: string): Promise<void>;

  requestReviewers(id: string, reviewers: string[]): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
}

/** Label applied to every agent-authored MR. Reviewers must know. */
export const AGENT_LABEL = 'agent-authored';

/** Marker embedded in every MR description so runs can be found from the MR. */
export function runMarker(runId: string): string {
  return `<!-- engineering-agents:run:${runId} -->`;
}

/** In-memory code host for tests and `--dry-run`. */
export class MemoryCodeHost implements CodeHost {
  readonly provider = 'memory';
  readonly opened: OpenMrInput[] = [];
  readonly comments: { id: string; markdown: string }[] = [];

  constructor(
    readonly id: string,
    private readonly repos: RepoInfo[],
  ) {}

  async getRepo(name: string): Promise<RepoInfo> {
    const found = this.repos.find((r) => r.name === name);
    if (!found) throw new Error(`Unknown repo: ${name}`);
    return found;
  }

  async openMergeRequest(input: OpenMrInput): Promise<MergeRequest> {
    this.opened.push(input);
    const number = this.opened.length;
    return {
      id: String(number),
      number,
      title: input.title,
      url: `memory://${input.repo}/mr/${number}`,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      state: 'open',
      isDraft: input.draft,
      labels: input.labels,
    };
  }

  async findOpenMergeRequests(): Promise<MergeRequest[]> {
    return [];
  }

  async commentOnMergeRequest(id: string, markdown: string): Promise<void> {
    this.comments.push({ id, markdown });
  }

  async requestReviewers(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: `memory host with ${this.repos.length} repos`, checkedAt: new Date().toISOString() };
  }
}
