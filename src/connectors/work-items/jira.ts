import { z } from 'zod';

import type { Cursor, HealthStatus, WorkItem, WorkItemLink, WorkItemType } from '../../core/types.js';
import { adfToMarkdown } from '../html.js';
import type { WorkItemSource } from './types.js';

export const jiraOptionsSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string(),
  token: z.string(),
  jql: z.string().default(''),
  /** Acceptance criteria is a custom field whose id differs per instance. */
  acceptanceCriteriaField: z.string().optional(),
  /** Cloud uses /rest/api/3 with ADF bodies; Server/DC uses /rest/api/2. */
  apiVersion: z.enum(['2', '3']).default('3'),
  /** JQL has minute granularity, so the poll window always overlaps. */
  overlapMinutes: z.number().int().positive().default(2),
});

export type JiraOptions = z.infer<typeof jiraOptionsSchema>;

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
}

const TYPE_MAP: Record<string, WorkItemType> = {
  Bug: 'bug',
  Defect: 'bug',
  Story: 'story',
  Task: 'task',
  'Sub-task': 'task',
  Subtask: 'task',
};

function textOf(value: unknown, apiVersion: '2' | '3'): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  // Server/DC returns wiki markup as a string; Cloud returns an ADF tree.
  return apiVersion === '3' ? adfToMarkdown(value).trim() : JSON.stringify(value);
}

/**
 * Map a Jira issue into the domain type.
 *
 * Pure and exported so it can be tested against captured payloads.
 */
export function mapJiraIssue(raw: JiraIssue, sourceId: string, options: JiraOptions): WorkItem {
  const f = raw.fields;
  const issuetype = f['issuetype'] as { name?: string } | undefined;
  const rawType = issuetype?.name ?? 'Unknown';
  const status = f['status'] as { name?: string } | undefined;
  const priority = f['priority'] as { name?: string } | undefined;
  const assignee = f['assignee'] as { displayName?: string } | null | undefined;
  const components = (f['components'] as { name?: string }[] | undefined) ?? [];
  const parentRaw = f['parent'] as { key?: string } | undefined;

  const links: WorkItemLink[] = [];
  for (const link of (f['issuelinks'] as
    | { type?: { name?: string }; inwardIssue?: { key: string }; outwardIssue?: { key: string } }[]
    | undefined) ?? []) {
    const other = link.inwardIssue ?? link.outwardIssue;
    if (!other) continue;
    // Link type names are instance-configurable; match on the type name rather
    // than assuming the default inward/outward wording.
    const name = (link.type?.name ?? '').toLowerCase();
    const type: WorkItemLink['type'] = name.includes('duplicate') ? 'duplicate' : 'related';
    links.push({ type, key: other.key, url: `${options.baseUrl}/browse/${other.key}` });
  }
  if (parentRaw?.key) {
    links.push({ type: 'parent', key: parentRaw.key, url: `${options.baseUrl}/browse/${parentRaw.key}` });
  }

  const acField = options.acceptanceCriteriaField ? f[options.acceptanceCriteriaField] : null;
  const commentContainer = f['comment'] as
    | { comments?: { author?: { displayName?: string }; body?: unknown; created: string }[] }
    | undefined;

  return {
    id: raw.id,
    key: raw.key,
    sourceId,
    type: TYPE_MAP[rawType] ?? 'other',
    rawType,
    title: typeof f['summary'] === 'string' ? f['summary'] : '(untitled)',
    description: textOf(f['description'], options.apiVersion),
    acceptanceCriteria: acField ? textOf(acField, options.apiVersion) || null : null,
    reproSteps: null,
    state: status?.name ?? 'Unknown',
    priority: priority?.name ?? null,
    labels: (f['labels'] as string[] | undefined) ?? [],
    assignee: assignee?.displayName ?? null,
    areaPath: components[0]?.name ?? null,
    parent: links.find((l) => l.type === 'parent') ?? null,
    links,
    comments: (commentContainer?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? 'unknown',
      body: textOf(c.body, options.apiVersion),
      createdAt: c.created,
    })),
    attachments: [],
    rev: typeof f['updated'] === 'string' ? f['updated'] : new Date().toISOString(),
    url: `${options.baseUrl}/browse/${raw.key}`,
    updatedAt: typeof f['updated'] === 'string' ? f['updated'] : new Date().toISOString(),
    raw,
  } as WorkItem;
}

/**
 * Jira work item source.
 *
 * JQL `updated` has minute granularity, so the poll window overlaps by
 * `overlapMinutes` and the caller deduplicates on the idempotency key. Without
 * the overlap, issues updated inside the boundary minute are silently lost.
 */
export class JiraWorkItemSource implements WorkItemSource {
  readonly provider = 'jira';
  private readonly options: JiraOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = jiraOptionsSchema.parse(options);
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.options.email}:${this.options.token}`).toString('base64');
    return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.options.baseUrl}/rest/api/${this.options.apiVersion}${path}`;
    const res = await this.fetchImpl(url, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!res.ok) {
      throw new Error(`Jira ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  buildJql(cursor: Cursor | null): string {
    const clauses: string[] = [];
    if (this.options.jql) clauses.push(`(${this.options.jql})`);
    if (cursor) {
      const since = new Date(new Date(cursor).getTime() - this.options.overlapMinutes * 60_000);
      clauses.push(`updated >= "${toJqlDate(since)}"`);
    }
    return `${clauses.join(' AND ')} ORDER BY updated ASC`;
  }

  async poll(cursor: Cursor | null): Promise<{ items: WorkItem[]; cursor: Cursor }> {
    const body = {
      jql: this.buildJql(cursor),
      maxResults: 50,
      fields: ['*navigable', 'comment', 'issuelinks', 'parent'],
    };
    const result = await this.api<{ issues: JiraIssue[] }>('/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const items = (result.issues ?? []).map((i) => mapJiraIssue(i, this.id, this.options));
    const nextCursor = items.reduce(
      (max, i) => (i.updatedAt > max ? i.updatedAt : max),
      cursor ?? '1970-01-01T00:00:00.000Z',
    );
    return { items, cursor: nextCursor };
  }

  async get(id: string): Promise<WorkItem> {
    const raw = await this.api<JiraIssue>(`/issue/${id}?expand=renderedFields`);
    return mapJiraIssue(raw, this.id, this.options);
  }

  async comment(id: string, markdown: string): Promise<void> {
    const body =
      this.options.apiVersion === '3'
        ? { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }] } }
        : { body: markdown };
    await this.api(`/issue/${id}/comment`, { method: 'POST', body: JSON.stringify(body) });
  }

  async transition(id: string, state: string): Promise<void> {
    // Jira transitions are by id, not by state name — resolve first.
    const available = await this.api<{ transitions: { id: string; name: string; to?: { name?: string } }[] }>(
      `/issue/${id}/transitions`,
    );
    const match = available.transitions.find(
      (t) => t.name.toLowerCase() === state.toLowerCase() || t.to?.name?.toLowerCase() === state.toLowerCase(),
    );
    if (!match) {
      throw new Error(`No transition to "${state}" available on ${id}; have: ${available.transitions.map((t) => t.name).join(', ')}`);
    }
    await this.api(`/issue/${id}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  async linkMergeRequest(id: string, url: string, title: string): Promise<void> {
    await this.fetchImpl(`${this.options.baseUrl}/rest/api/${this.options.apiVersion}/issue/${id}/remotelink`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ object: { url, title, icon: { title: 'Merge request' } } }),
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      await this.api('/myself');
      return { ok: true, detail: this.options.baseUrl, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}

/** JQL wants `yyyy/MM/dd HH:mm`, not ISO-8601. */
export function toJqlDate(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${p(date.getUTCMonth() + 1)}/${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}
