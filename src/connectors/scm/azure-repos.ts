import { z } from 'zod';

import type { HealthStatus, MergeRequest, MrFilter, OpenMrInput, RepoInfo } from '../../core/types.js';
import { AGENT_LABEL, type CodeHost } from './types.js';

const repoSchema = z.object({
  name: z.string(),
  defaultBranch: z.string().default('main'),
  testCommand: z.string().nullable().default(null),
  buildCommand: z.string().nullable().default(null),
});

export const azureReposOptionsSchema = z.object({
  organization: z.string(),
  project: z.string(),
  token: z.string(),
  baseUrl: z.string().default('https://dev.azure.com'),
  apiVersion: z.string().default('7.1'),
  /** Pin every MR on this host to draft. See the note in github.ts. */
  forceDraft: z.boolean().default(false),
  repos: z.array(repoSchema).min(1),
});

export type AzureReposOptions = z.infer<typeof azureReposOptionsSchema>;

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  status: string;
  isDraft: boolean;
  description?: string;
  labels?: { name: string }[];
}

export class AzureReposCodeHost implements CodeHost {
  readonly provider = 'azure-repos';
  private readonly options: AzureReposOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = azureReposOptionsSchema.parse(options);
  }

  private get projectUrl(): string {
    return `${this.options.baseUrl}/${this.options.organization}/${encodeURIComponent(this.options.project)}`;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const basic = Buffer.from(`:${this.options.token}`).toString('base64');
    const sep = path.includes('?') ? '&' : '?';
    const res = await this.fetchImpl(`${this.projectUrl}/_apis/${path}${sep}api-version=${this.options.apiVersion}`, {
      ...init,
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!res.ok) {
      throw new Error(`Azure Repos ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private toMergeRequest(pr: AdoPullRequest, repo: string): MergeRequest {
    return {
      id: `${repo}#${pr.pullRequestId}`,
      number: pr.pullRequestId,
      title: pr.title,
      url: `${this.projectUrl}/_git/${repo}/pullrequest/${pr.pullRequestId}`,
      sourceBranch: pr.sourceRefName.replace('refs/heads/', ''),
      targetBranch: pr.targetRefName.replace('refs/heads/', ''),
      state: pr.status === 'completed' ? 'merged' : pr.status === 'active' ? 'open' : 'closed',
      isDraft: pr.isDraft,
      labels: (pr.labels ?? []).map((l) => l.name),
    };
  }

  async getRepo(name: string): Promise<RepoInfo> {
    const configured = this.options.repos.find((r) => r.name === name);
    if (!configured) throw new Error(`Repo "${name}" is not configured on code host "${this.id}"`);
    return {
      name,
      cloneUrl: `https://${this.options.token}@dev.azure.com/${this.options.organization}/${encodeURIComponent(this.options.project)}/_git/${name}`,
      defaultBranch: configured.defaultBranch,
      testCommand: configured.testCommand,
      buildCommand: configured.buildCommand,
      webUrl: `${this.projectUrl}/_git/${name}`,
    };
  }

  async openMergeRequest(input: OpenMrInput): Promise<MergeRequest> {
    // workItemRefs links the ticket at creation — cheaper and more reliable
    // than following up with a comment.
    const body: Record<string, unknown> = {
      sourceRefName: `refs/heads/${input.sourceBranch}`,
      targetRefName: `refs/heads/${input.targetBranch}`,
      title: input.title,
      description: input.description,
      isDraft: input.draft || this.options.forceDraft,
      labels: [...new Set([AGENT_LABEL, ...input.labels])].map((name) => ({ name })),
    };
    if (input.workItemKey) {
      body['workItemRefs'] = [{ id: input.workItemKey.replace(/^\D+-?/, '') }];
    }

    const pr = await this.api<AdoPullRequest>(`git/repositories/${input.repo}/pullrequests`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.toMergeRequest(pr, input.repo);
  }

  async findOpenMergeRequests(filter: MrFilter): Promise<MergeRequest[]> {
    const status = filter.state === 'merged' ? 'completed' : filter.state === 'closed' ? 'abandoned' : 'active';
    const result = await this.api<{ value: AdoPullRequest[] }>(
      `git/repositories/${filter.repo}/pullrequests?searchCriteria.status=${status}&$top=100`,
    );
    const matched = filter.containsMarker
      ? result.value.filter((p) => (p.description ?? '').includes(filter.containsMarker as string))
      : result.value;
    return matched.map((p) => this.toMergeRequest(p, filter.repo));
  }

  async commentOnMergeRequest(id: string, markdown: string): Promise<void> {
    const [repo, number] = id.split('#');
    await this.api(`git/repositories/${repo}/pullRequests/${number}/threads`, {
      method: 'POST',
      body: JSON.stringify({ comments: [{ parentCommentId: 0, content: markdown, commentType: 1 }], status: 1 }),
    });
  }

  async requestReviewers(id: string, reviewers: string[]): Promise<void> {
    const [repo, number] = id.split('#');
    // Azure DevOps addresses reviewers by identity descriptor, not email.
    for (const reviewer of reviewers) {
      await this.api(`git/repositories/${repo}/pullRequests/${number}/reviewers/${reviewer}`, {
        method: 'PUT',
        body: JSON.stringify({ vote: 0 }),
      }).catch(() => undefined);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      await this.api('git/repositories?$top=1');
      return { ok: true, detail: `${this.options.organization}/${this.options.project}`, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}
