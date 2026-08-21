import { z } from 'zod';

import type { HealthStatus, MergeRequest, MrFilter, OpenMrInput, RepoInfo } from '../../core/types.js';
import { AGENT_LABEL, type CodeHost } from './types.js';

const repoSchema = z.object({
  name: z.string(),
  defaultBranch: z.string().default('main'),
  testCommand: z.string().nullable().default(null),
  buildCommand: z.string().nullable().default(null),
});

export const githubOptionsSchema = z.object({
  owner: z.string(),
  token: z.string(),
  baseUrl: z.string().default('https://api.github.com'),
  /** Draft PRs are the right default at `comment` autonomy: visible, but no CI or reviewer paging. */
  draftMergeRequests: z.boolean().default(true),
  repos: z.array(repoSchema).min(1),
});

export type GitHubOptions = z.infer<typeof githubOptionsSchema>;

interface GhPull {
  id: number;
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  state: string;
  merged_at: string | null;
  draft: boolean;
  labels: { name: string }[];
  body: string | null;
}

function toMergeRequest(pr: GhPull): MergeRequest {
  return {
    id: String(pr.number),
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    isDraft: pr.draft,
    labels: pr.labels.map((l) => l.name),
  };
}

export class GitHubCodeHost implements CodeHost {
  readonly provider = 'github';
  private readonly options: GitHubOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = githubOptionsSchema.parse(options);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async getRepo(name: string): Promise<RepoInfo> {
    const configured = this.options.repos.find((r) => r.name === name);
    if (!configured) throw new Error(`Repo "${name}" is not configured on code host "${this.id}"`);
    return {
      name,
      cloneUrl: `https://x-access-token:${this.options.token}@github.com/${this.options.owner}/${name}.git`,
      defaultBranch: configured.defaultBranch,
      testCommand: configured.testCommand,
      buildCommand: configured.buildCommand,
      webUrl: `https://github.com/${this.options.owner}/${name}`,
    };
  }

  async openMergeRequest(input: OpenMrInput): Promise<MergeRequest> {
    const pr = await this.api<GhPull>(`/repos/${this.options.owner}/${input.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.description,
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft || this.options.draftMergeRequests,
      }),
    });

    const labels = [...new Set([AGENT_LABEL, ...input.labels])];
    await this.api(`/repos/${this.options.owner}/${input.repo}/issues/${pr.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });

    if (input.reviewers?.length) {
      await this.requestReviewers(`${input.repo}#${pr.number}`, input.reviewers).catch(() => undefined);
    }

    return { ...toMergeRequest(pr), labels };
  }

  async findOpenMergeRequests(filter: MrFilter): Promise<MergeRequest[]> {
    const prs = await this.api<GhPull[]>(
      `/repos/${this.options.owner}/${filter.repo}/pulls?state=${filter.state ?? 'open'}&per_page=100`,
    );
    const matched = filter.containsMarker
      ? prs.filter((p) => (p.body ?? '').includes(filter.containsMarker as string))
      : prs;
    return matched.map(toMergeRequest);
  }

  async commentOnMergeRequest(id: string, markdown: string): Promise<void> {
    const [repo, number] = id.split('#');
    await this.api(`/repos/${this.options.owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: markdown }),
    });
  }

  async requestReviewers(id: string, reviewers: string[]): Promise<void> {
    const [repo, number] = id.split('#');
    await this.api(`/repos/${this.options.owner}/${repo}/pulls/${number}/requested_reviewers`, {
      method: 'POST',
      body: JSON.stringify({ reviewers }),
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      await this.api('/user');
      return { ok: true, detail: `github.com/${this.options.owner}`, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}
