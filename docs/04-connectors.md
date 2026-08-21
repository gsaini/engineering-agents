# 04 — Connectors

Everything provider-specific lives here. The pipelines never see the word "Jira".

Four interfaces, defined in [`src/connectors`](../src/connectors). Each has one job: translate a vendor's model into the domain model, and translate the domain model's write operations back.

---

## `WorkItemSource`

```ts
export interface WorkItemSource {
  readonly id: string;
  readonly provider: string;
  /** Items changed since the cursor. Returns a new cursor to persist. */
  poll(cursor: Cursor | null): Promise<{ items: WorkItem[]; cursor: Cursor }>;
  get(id: string): Promise<WorkItem>;
  /** Comments and links — the only writes. Never edits scope, priority, or assignment. */
  comment(id: string, markdown: string): Promise<void>;
  transition(id: string, state: string): Promise<void>;
  linkMergeRequest(id: string, url: string, title: string): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

### Normalised `WorkItem`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Provider-native id |
| `key` | string | Human-facing key (`PAY-1423`, `#4412`) |
| `type` | `'bug' \| 'story' \| 'task' \| 'other'` | Normalised; `rawType` preserved |
| `title`, `description` | string | Description converted to Markdown |
| `acceptanceCriteria` | string \| null | Provider-specific field, extracted |
| `reproSteps` | string \| null | Bugs only |
| `state`, `priority`, `labels[]`, `assignee` | | |
| `parent`, `links[]` | | `{ type: 'parent'\|'child'\|'duplicate'\|'related', key, url }` |
| `comments[]` | | `{ author, body, createdAt }`, chronological |
| `attachments[]` | | Text-extractable only; binaries listed, not fetched |
| `areaPath` / `component` | string \| null | Feeds repo resolution |
| `rev` | string | Revision/version — the idempotency input |
| `url`, `updatedAt` | | |
| `raw` | unknown | Verbatim provider payload, kept on the run for audit |

### Azure DevOps

| Concern | Detail |
|---|---|
| Auth | PAT (`Authorization: Basic base64(":" + pat)`) or Entra ID token. Scopes: `Work Items (Read & Write)`. |
| Discovery | `POST /_apis/wit/wiql?api-version=7.1` with a WIQL query returning ids, then `GET /_apis/wit/workitemsbatch` (200 ids max per batch) with `$expand=Relations`. |
| Cursor | `System.ChangedDate > @cursor` in the WIQL. Store as ISO-8601. ADO's `ChangedDate` has second granularity — use `>=` with a dedupe on `System.Rev` to avoid dropping items that share a timestamp. |
| Field mapping | `System.Title`, `System.Description` (HTML → Markdown), `Microsoft.VSTS.Common.AcceptanceCriteria`, `Microsoft.VSTS.TCM.ReproSteps`, `System.State`, `Microsoft.VSTS.Common.Priority`, `System.Tags` (`; `-separated), `System.AreaPath`, `System.Rev` |
| Type mapping | `Bug → bug`, `User Story`/`Product Backlog Item` → `story`, `Task` → `task`, else `other` |
| Comments | `GET /_apis/wit/workItems/{id}/comments?api-version=7.1-preview.3` |
| Links | `relations[]` — `System.LinkTypes.Hierarchy-Reverse` = parent, `-Forward` = child, `ArtifactLink` with `Git PullRequest` = existing MR (used for dedupe) |
| Writes | `PATCH` with JSON-Patch `add` on `/fields/System.History` for a comment; `/fields/System.State` for transition; `relations/-` with `ArtifactLink` for MR links |
| Webhook | Service hook `workitem.created` / `workitem.updated` → re-read the item; never trust the payload |
| Gotcha | Descriptions are HTML, sometimes with pasted Word markup. Convert and strip aggressively — raw HTML in a prompt is mostly wasted tokens. |

### Jira

| Concern | Detail |
|---|---|
| Auth | Cloud: email + API token as Basic. Server/DC: PAT bearer. |
| Discovery | `POST /rest/api/3/search/jql` (Cloud, token-paginated) or `GET /rest/api/2/search` (DC, `startAt`) with JQL + `expand=renderedFields,changelog` |
| Cursor | `updated >= "-Xm"` — JQL has **minute** granularity, so always overlap the window and dedupe on the issue's `updated` timestamp plus a seen-set. Store `nextPageToken` for in-progress pages. |
| Field mapping | `summary`, `description` (ADF → Markdown on Cloud; wiki markup on DC), acceptance criteria is a **custom field** — configure `acceptanceCriteriaField: customfield_10042` per instance, `status.name`, `priority.name`, `labels`, `components[0].name` |
| Type mapping | `Bug`/`Defect` → `bug`, `Story` → `story`, `Task`/`Sub-task` → `task` |
| Comments | `expand=renderedFields` or `GET /issue/{key}/comment` |
| Links | `issuelinks[]` (`type.inward`/`outward` naming varies per instance — map by `type.name`), `parent`, `subtasks` |
| Writes | `POST /issue/{key}/comment` (ADF body on Cloud), `POST /issue/{key}/transitions` (**transition id, not state name** — fetch `GET /issue/{key}/transitions` first and match by name), remote link for MR |
| Gotcha | ADF (Atlassian Document Format) is a JSON tree, not text. Convert it properly; naive extraction loses tables and code blocks, which is exactly where requirements hide. |

---

## `LogSource`

```ts
export interface LogSource {
  readonly id: string;
  readonly provider: string;
  /** Run the configured detection query over the window. */
  detect(window: TimeWindow): Promise<LogSignal[]>;
  /** Widen a signal into full evidence: samples, timeline, spread, correlations. */
  gather(signal: LogSignal, options: GatherOptions): Promise<LogEvidence>;
  /** Escape hatch for agent-issued follow-up queries, subject to an allowlist. */
  query(spec: LogQuerySpec): Promise<LogQueryResult>;
  healthCheck(): Promise<HealthStatus>;
}
```

### Normalised `LogSignal`

| Field | Notes |
|---|---|
| `id`, `sourceId` | |
| `fingerprint` | Computed by the connector — see [03](03-agent-log-triage.md#fingerprinting) |
| `title` | `"NullReferenceException in RefundService.ProcessAsync"` |
| `service`, `environment` | Feeds `serviceRepoMapping` |
| `level`, `count`, `affectedUsers` | |
| `firstSeen`, `lastSeen` | |
| `sampleEvents[]` | `{ timestamp, message, stackTrace, attributes, traceId }` |
| `exceptionType`, `topFrames[]` | Parsed, framework frames dropped |
| `versions[]`, `hosts[]`, `regions[]` | Spread analysis |
| `query`, `dashboardUrl` | So a human can jump straight to the source |
| `raw` | Verbatim |

### Application Insights

| Concern | Detail |
|---|---|
| Auth | API key header `X-Api-Key`, or Entra ID for the Log Analytics workspace |
| Endpoint | `POST https://api.applicationinsights.io/v1/apps/{appId}/query` (or the workspace-based Log Analytics endpoint, preferred for new resources) |
| Language | KQL |
| Detection | `exceptions \| where timestamp > ago(15m) \| summarize count(), dcount(user_Id), min(timestamp), max(timestamp), any(details) by problemId, cloud_RoleName \| where count_ > 25` |
| Novelty | Join against a lookback: `... \| join kind=leftanti (exceptions \| where timestamp between (ago(7d) .. ago(15m)) \| distinct problemId) on problemId` |
| Fingerprint input | `problemId` is already a decent signature — combine with `cloud_RoleName`; still re-hash through the normaliser so fingerprints are comparable across providers |
| Stack traces | `details[0].parsedStack[]` — structured, with `assembly`, `method`, `fileName`, `line`. The best of the three providers for frame→source mapping. |
| Correlation | `operation_Id` joins `exceptions`, `requests`, `dependencies`, `traces` — this is what gives you preceding events for free |
| Spread | `application_Version`, `cloud_RoleInstance`, `client_CountryOrRegion` |
| Limits | 500,000 rows / 64 MB / 10 min per query. Detection queries must aggregate, never return raw rows. |

### CloudWatch Logs

| Concern | Detail |
|---|---|
| Auth | SigV4 via the standard AWS credential chain; IAM needs `logs:StartQuery`, `logs:GetQueryResults`, `logs:DescribeLogGroups` |
| API | Logs Insights: `StartQuery` → poll `GetQueryResults` until `status == Complete`. **Asynchronous** — the connector owns the polling loop and a timeout. |
| Language | Logs Insights query syntax |
| Detection | `filter @message like /Exception/ \| parse @message "*Exception" as extype \| stats count() as c, earliest(@timestamp) as first, latest(@timestamp) as last by extype, @logStream \| filter c > 25` |
| Novelty | No cross-query joins — the connector keeps its own seen-fingerprints table in the run store and computes novelty client-side |
| Structured logs | If the app emits JSON, query fields directly (`filter level = "ERROR" \| stats count() by errorType, service`) — an order of magnitude more reliable than regex over free text |
| Gotcha | Query cost scales with **bytes scanned**. Always bound `logGroupNames` and the time range; never run a detection query over `@message` across all groups. |
| Gotcha | Multi-line stack traces arrive as separate events unless the log driver is configured to join them. The connector reassembles by `@logStream` + timestamp proximity, and reports when it could not. |

### Splunk

| Concern | Detail |
|---|---|
| Auth | Bearer token (`Authorization: Bearer <token>`) or session key from `/services/auth/login` |
| API | `POST /services/search/jobs` (`exec_mode=blocking` for short searches, otherwise poll `/services/search/jobs/{sid}`), results via `output_mode=json` |
| Language | SPL |
| Detection | `index=app_prod level=ERROR earliest=-15m \| stats count as c, dc(user_id) as users, min(_time) as first, max(_time) as last, values(stack) as samples by exception_type, source_module \| where c > 25` |
| Novelty | `\| search NOT [ search index=app_prod level=ERROR earliest=-7d latest=-15m \| stats count by exception_type \| fields exception_type ]` — subsearches are capped, so keep the lookback aggregated |
| Fingerprint input | `exception_type` + normalised message + frames from the `stack` field |
| Gotcha | Field extraction is deployment-specific. The connector takes a `fieldMap` in config rather than assuming `level`/`exception_type` exist. |
| Gotcha | Splunk searches can be extremely expensive. Config carries a `maxSearchSeconds` and the connector cancels the job past it. |

---

## `CodeHost`

```ts
export interface CodeHost {
  readonly id: string;
  readonly provider: string;
  getRepo(name: string): Promise<RepoInfo>;             // clone url, default branch, protections
  openMergeRequest(input: OpenMrInput): Promise<MergeRequest>;
  findOpenMergeRequests(filter: MrFilter): Promise<MergeRequest[]>;  // dedupe + suppression
  commentOnMergeRequest(id: string, markdown: string): Promise<void>;
  requestReviewers(id: string, reviewers: string[]): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

Git operations (clone, branch, commit, push) are **not** on this interface — they are plain `git` in the sandbox, which is simpler, provider-agnostic, and identical to what a human does. `CodeHost` covers only what needs the API.

| Provider | MR endpoint | Notes |
|---|---|---|
| Azure Repos | `POST /_apis/git/repositories/{repo}/pullrequests?api-version=7.1` | `workItemRefs` links the ticket at creation — do this rather than commenting. Reviewers by descriptor, not email. |
| GitHub | `POST /repos/{o}/{r}/pulls` then `POST .../issues/{n}/labels`, `.../requested_reviewers` | Draft PRs are useful for `comment` autonomy: the change is visible, but CI and reviewers are not paged. |
| GitLab | `POST /projects/{id}/merge_requests` | `Closes #123` in the description auto-links. `remove_source_branch: true` keeps the namespace clean. |

Common rules for every provider:

- Branch name: `agent/<workItemId-or-fingerprint8>-<slug>`, always under the `agent/` prefix so branch protection can target it.
- Every MR is **labelled agent-authored** and carries the run id in the description.
- Push is restricted to the run's own branch — enforced in the sandbox, not by trusting the agent.
- The agent identity is a dedicated service account with no merge permission on protected branches.

---

## `Notifier`

```ts
export interface Notifier {
  readonly id: string;
  notify(message: NotifyMessage): Promise<void>;
  requestApproval(request: ApprovalRequest): Promise<{ ticketRef: string }>;  // fire-and-forget
  healthCheck(): Promise<HealthStatus>;
}
```

`requestApproval` **does not block**. It posts an interactive message and returns. The decision arrives later through a webhook or a CLI command and is written to the run store, which is what lets the process restart mid-approval without losing anything. See [06-human-in-the-loop.md](06-human-in-the-loop.md).

| Provider | Mechanism |
|---|---|
| Slack | `chat.postMessage` with Block Kit buttons carrying `run:<id>:approve\|changes\|reject`; decisions arrive on the Interactivity endpoint. Signature verification is mandatory. |
| Teams | Adaptive Card with `Action.Execute`; decisions arrive via the bot endpoint. |
| Console | Prints the request; decisions via `eng-agents approve <runId>`. Used for local development and for the dry-run path. |

---

## Adding a provider

1. Implement one interface in `src/connectors/<kind>/<provider>.ts`.
2. Map into the normalised type; keep the vendor payload in `raw`.
3. Register it in `src/connectors/registry.ts`.
4. Add its options schema to `src/config/schema.ts` — config is validated at startup, so a typo in a field name fails fast rather than at 3am.
5. Add a fixture-based test. No live credentials in tests, ever.

The pipelines require no change. That is the point of the layer.
