import type { Cursor, HealthStatus, WorkItem } from '../../core/types.js';

/**
 * A tracker. Reads work items; writes only comments, links, and state
 * transitions — never scope, priority, or assignment. See docs/04-connectors.md.
 */
export interface WorkItemSource {
  readonly id: string;
  readonly provider: string;

  /** Items changed since the cursor, plus the cursor to persist for next time. */
  poll(cursor: Cursor | null): Promise<{ items: WorkItem[]; cursor: Cursor }>;

  get(id: string): Promise<WorkItem>;

  comment(id: string, markdown: string): Promise<void>;

  transition(id: string, state: string): Promise<void>;

  linkMergeRequest(id: string, url: string, title: string): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
}

/** In-memory source for tests and `--dry-run`. */
export class MemoryWorkItemSource implements WorkItemSource {
  readonly provider = 'memory';
  readonly comments: { id: string; markdown: string }[] = [];
  readonly transitions: { id: string; state: string }[] = [];
  readonly links: { id: string; url: string }[] = [];

  constructor(
    readonly id: string,
    private readonly items: WorkItem[],
  ) {}

  async poll(cursor: Cursor | null): Promise<{ items: WorkItem[]; cursor: Cursor }> {
    const since = cursor ?? '1970-01-01T00:00:00.000Z';
    const items = this.items.filter((i) => i.updatedAt > since);
    const latest = items.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), since);
    return { items, cursor: latest };
  }

  async get(id: string): Promise<WorkItem> {
    const found = this.items.find((i) => i.id === id || i.key === id);
    if (!found) throw new Error(`Work item not found: ${id}`);
    return found;
  }

  async comment(id: string, markdown: string): Promise<void> {
    this.comments.push({ id, markdown });
  }

  async transition(id: string, state: string): Promise<void> {
    this.transitions.push({ id, state });
  }

  async linkMergeRequest(id: string, url: string): Promise<void> {
    this.links.push({ id, url });
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: `memory source with ${this.items.length} items`, checkedAt: new Date().toISOString() };
  }
}
