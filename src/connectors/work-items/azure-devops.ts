import { z } from 'zod';

import type { Cursor, HealthStatus, WorkItem, WorkItemLink, WorkItemType } from '../../core/types.js';
import { htmlToMarkdown } from '../html.js';
import type { WorkItemSource } from './types.js';

export const azureDevOpsOptionsSchema = z.object({
  organization: z.string(),
  project: z.string(),
  token: z.string(),
  /** Extra WIQL predicate, ANDed with the type and date filters. */
  wiql: z.string().optional(),
  areaPath: z.string().optional(),
  baseUrl: z.string().default('https://dev.azure.com'),
  apiVersion: z.string().default('7.1'),
  workItemTypes: z.array(z.string()).default(['Bug', 'User Story', 'Task']),
});

export type AzureDevOpsOptions = z.infer<typeof azureDevOpsOptionsSchema>;

/** ADO fields we read. Anything else stays in `raw`. */
interface AdoWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[];
  _links?: { html?: { href?: string } };
}

const TYPE_MAP: Record<string, WorkItemType> = {
  Bug: 'bug',
  Defect: 'bug',
  'User Story': 'story',
  'Product Backlog Item': 'story',
  Issue: 'story',
  Task: 'task',
};

const REL_MAP: Record<string, WorkItemLink['type']> = {
  'System.LinkTypes.Hierarchy-Reverse': 'parent',
  'System.LinkTypes.Hierarchy-Forward': 'child',
  'System.LinkTypes.Duplicate-Forward': 'duplicate',
  'System.LinkTypes.Duplicate-Reverse': 'duplicate',
  'System.LinkTypes.Related': 'related',
  ArtifactLink: 'merge-request',
};

function str(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map an ADO work item into the domain type.
 *
 * Pure and exported so it can be tested against captured payloads without
 * credentials — see tests/connectors.test.ts.
 */
export function mapAdoWorkItem(raw: AdoWorkItem, sourceId: string, projectUrl: string): WorkItem {
  const f = raw.fields;
  const rawType = str(f, 'System.WorkItemType') ?? 'Unknown';
  const tags = str(f, 'System.Tags');
  const assignedTo = f['System.AssignedTo'];

  const links: WorkItemLink[] = (raw.relations ?? [])
    .map((rel) => {
      const type = REL_MAP[rel.rel];
      if (!type) return null;
      const name = typeof rel.attributes?.['name'] === 'string' ? rel.attributes['name'] : '';
      // ArtifactLink covers many artefact kinds; only pull request links matter here.
      if (rel.rel === 'ArtifactLink' && !name.includes('Pull Request')) return null;
      return { type, key: rel.url.split('/').pop() ?? rel.url, url: rel.url };
    })
    .filter((l): l is WorkItemLink => l !== null);

  return {
    id: String(raw.id),
    key: `${str(f, 'System.TeamProject') ?? 'ADO'}-${raw.id}`,
    sourceId,
    type: TYPE_MAP[rawType] ?? 'other',
    rawType,
    title: str(f, 'System.Title') ?? '(untitled)',
    // Descriptions are HTML, sometimes with pasted Word markup. Converting is
    // not cosmetic: raw HTML in a prompt is mostly wasted tokens.
    description: htmlToMarkdown(str(f, 'System.Description') ?? ''),
    acceptanceCriteria: (() => {
      const ac = str(f, 'Microsoft.VSTS.Common.AcceptanceCriteria');
      return ac ? htmlToMarkdown(ac) : null;
    })(),
    reproSteps: (() => {
      const rs = str(f, 'Microsoft.VSTS.TCM.ReproSteps');
      return rs ? htmlToMarkdown(rs) : null;
    })(),
    state: str(f, 'System.State') ?? 'Unknown',
    priority: f['Microsoft.VSTS.Common.Priority'] != null ? String(f['Microsoft.VSTS.Common.Priority']) : null,
    labels: tags ? tags.split(';').map((t) => t.trim()).filter(Boolean) : [],
    assignee:
      assignedTo && typeof assignedTo === 'object' && 'displayName' in assignedTo
        ? String((assignedTo as { displayName: unknown }).displayName)
        : null,
    areaPath: str(f, 'System.AreaPath'),
    parent: links.find((l) => l.type === 'parent') ?? null,
    links,
    comments: [],
    attachments: [],
    rev: String(raw.rev),
    url: raw._links?.html?.href ?? `${projectUrl}/_workitems/edit/${raw.id}`,
    updatedAt: str(f, 'System.ChangedDate') ?? new Date().toISOString(),
    raw,
  };
}

/**
 * Build the discovery WIQL.
 *
 * `System.ChangedDate` has second granularity, so this uses `>=` and relies on
 * the caller deduplicating by `System.Rev` — a strict `>` silently drops items
 * that share a timestamp with the cursor.
 */
export function buildWiql(options: AzureDevOpsOptions, cursor: Cursor | null): string {
  const clauses = [`[System.TeamProject] = '${options.project}'`];
  const types = options.workItemTypes.map((t) => `'${t}'`).join(', ');
  clauses.push(`[System.WorkItemType] IN (${types})`);
  if (options.areaPath) clauses.push(`[System.AreaPath] UNDER '${options.areaPath}'`);
  if (cursor) clauses.push(`[System.ChangedDate] >= '${cursor}'`);
  if (options.wiql) clauses.push(`(${options.wiql})`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] ASC`;
}

/**
 * Azure DevOps work item source.
 *
 * Endpoints and field semantics are documented in docs/04-connectors.md. The
 * HTTP surface is deliberately thin: discovery via WIQL, hydration via the
 * batch endpoint (200 ids max), writes via JSON-Patch.
 */
export class AzureDevOpsWorkItemSource implements WorkItemSource {
  readonly provider = 'azure-devops';
  private readonly options: AzureDevOpsOptions;

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = azureDevOpsOptionsSchema.parse(options);
  }

  private get projectUrl(): string {
    const { baseUrl, organization, project } = this.options;
    return `${baseUrl}/${organization}/${encodeURIComponent(project)}`;
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`:${this.options.token}`).toString('base64');
    return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.projectUrl}/_apis/${path}${path.includes('?') ? '&' : '?'}api-version=${this.options.apiVersion}`;
    const res = await this.fetchImpl(url, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!res.ok) {
      throw new Error(`Azure DevOps ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async poll(cursor: Cursor | null): Promise<{ items: WorkItem[]; cursor: Cursor }> {
    const wiql = buildWiql(this.options, cursor);
    const ids = await this.api<{ workItems: { id: number }[] }>('wit/wiql', {
      method: 'POST',
      body: JSON.stringify({ query: wiql }),
    });
    const batch = ids.workItems.slice(0, 200).map((w) => w.id);
    if (batch.length === 0) return { items: [], cursor: cursor ?? new Date().toISOString() };

    const hydrated = await this.api<{ value: AdoWorkItem[] }>('wit/workitemsbatch', {
      method: 'POST',
      body: JSON.stringify({ ids: batch, $expand: 'Relations' }),
    });
    const items = hydrated.value.map((raw) => mapAdoWorkItem(raw, this.id, this.projectUrl));
    const nextCursor = items.reduce(
      (max, i) => (i.updatedAt > max ? i.updatedAt : max),
      cursor ?? '1970-01-01T00:00:00.000Z',
    );
    return { items, cursor: nextCursor };
  }

  async get(id: string): Promise<WorkItem> {
    const raw = await this.api<AdoWorkItem>(`wit/workitems/${id}?$expand=Relations`);
    const item = mapAdoWorkItem(raw, this.id, this.projectUrl);
    const comments = await this.api<{ comments: { createdBy?: { displayName?: string }; text: string; createdDate: string }[] }>(
      `wit/workItems/${id}/comments?api-version=7.1-preview.3`,
    ).catch(() => ({ comments: [] }));
    item.comments = comments.comments.map((c) => ({
      author: c.createdBy?.displayName ?? 'unknown',
      body: htmlToMarkdown(c.text),
      createdAt: c.createdDate,
    }));
    return item;
  }

  async comment(id: string, markdown: string): Promise<void> {
    await this.api(`wit/workitems/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.History', value: markdown }]),
    });
  }

  async transition(id: string, state: string): Promise<void> {
    await this.api(`wit/workitems/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    });
  }

  async linkMergeRequest(id: string, url: string, title: string): Promise<void> {
    await this.api(`wit/workitems/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([
        {
          op: 'add',
          path: '/relations/-',
          value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request', comment: title } },
        },
      ]),
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      await this.api('wit/fields?$top=1');
      return { ok: true, detail: `${this.options.organization}/${this.options.project}`, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}
