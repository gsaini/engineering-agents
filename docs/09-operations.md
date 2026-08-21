# 09 — Operations

## Cost model

Cost is dominated by **input tokens in the evidence-heavy stages**, not by generation. This is the single most useful thing to know when tuning.

Rough per-run shape on `claude-opus-5` (1M context, $5/MTok in, $25/MTok out):

| Stage | Input | Output | Effort | Notes |
|---|---|---|---|---|
| Triage | 5–15K | ~1K | `low` | Classification. Cheap by design. |
| Analyze | 80–250K | 3–6K | `high` | Dominated by retrieval. **The main cost lever.** |
| Plan | 30–60K | 3–5K | `xhigh` | Analysis + evidence summary in, plan out |
| Implement | 150–400K | 10–30K | `xhigh` | Multi-turn; grows with fix attempts |
| Verify | 40–80K | 2–5K | `high` | Diff + plan; blind self-review |
| Publish | 5–10K | ~2K | `low` | MR description |

Typical: **$3–8 per ticket-to-MR run**, **$4–10 per log-triage run** (evidence gathering is heavier, implementation lighter). A rejected plan costs ~$1–2 — which is the economic argument for the approval gate, quite apart from the safety one.

### Levers, in order of impact

1. **Cap retrieval.** `maxFilesRead` from 200 → 60 typically costs a few points of plan quality and halves the bill. Measure it on your golden set rather than guessing.
2. **Prompt caching on the stable prefix.** System prompt, tool definitions, and repo conventions are identical across runs in the same repo — put them first and cache them. Volatile content (the ticket, the timestamp) goes after the last breakpoint. Verify with `cache_read_input_tokens`; if it is zero, something in the prefix is varying.
3. **Effort per stage.** `low` for triage and publish, `high`/`xhigh` only where reasoning depth pays.
4. **Fail fast.** Triage gates and the `NEEDS_INFO` path cost cents and prevent full runs on unactionable tickets.
5. **Cap fix attempts.** Attempt 3 rarely succeeds where attempts 1 and 2 failed, and it costs as much as both.
6. **Suppression.** For log-triage, aggressive fingerprint suppression is the difference between $10 and $300 during an incident.

Budgets are enforced, not advisory: `maxBudgetUsd` per agent invocation, plus `BudgetGuard` totals per run and per day.

## Observability

### Structured logs

Every event carries `runId`, `agent`, `stage`, `sourceId`, `repo`, `durationMs`, `costUsd`. Traces span the whole run so a slow stage is visible without correlation work.

### Dashboard

| Panel | Shows |
|---|---|
| Funnel | Triggers → in-scope → planned → approved → MR → merged. Where runs die is where the work is. |
| Stage latency | p50/p95 per stage |
| Cost | Per run, per day, per agent, per repo; cost per merged MR as the headline |
| Quality | Plan acceptance, merge rate, escape rate — rolling windows |
| Guardrails | Denials, budget stops, blast-radius breaches, injection hits |
| Health | Connector health checks, watcher lag, queue depth |
| Backlog | Runs in `AWAITING_APPROVAL` by age — a growing number means the notifications are being ignored |

### Alerts

| Alert | Condition | Priority |
|---|---|---|
| Watcher stalled | No successful poll in 3 intervals | High |
| Connector unhealthy | Health check failing 5 min | High |
| Secret-scan block | Any | High — investigate immediately |
| Injection detected | Any | High |
| Blast-radius breach | Any | Medium |
| Daily budget 80% | — | Medium |
| Failure rate > 20% | Rolling 20 runs | Medium |
| Approval backlog > 10 | Older than 24h | Low |

## Runbook

**Agent opened a bad MR.** Close it, label the run's rejection reason, `eng-agents cancel <runId>`. If it reveals a systemic gap, pause that agent until the prompt or config is fixed. Add the case to the golden set — that is what stops it recurring.

**MR storm during an incident.** `eng-agents pause --agent log-triage` first, investigate second. Close the MRs in bulk; add the fingerprints to known-issues with an expiry. Then fix the suppression config that let it happen — a storm is always a suppression bug, not a model bug.

**Watcher stalled.** Check connector health, then credentials (expired PATs are the usual cause), then rate limits. The high-water mark is not advanced on failure, so nothing is lost; restart and it catches up. If the backlog is large, the freshness gate prevents a stampede.

**Runs stuck in `AWAITING_APPROVAL`.** Check the notifier is delivering and that the approver resolution is finding a real person. A backlog usually means notifications are landing in a channel nobody reads.

**Cost spike.** Break down by agent, repo, and stage. Almost always: retrieval cap raised, a repo far larger than the others, fix-attempt loops, or a log-triage suppression failure.

**Agent committed something it should not have.** Revoke the service account token — that is the fast stop. Then: revert, rotate anything exposed, pull the full run record, and treat it as an incident with a post-mortem. Fix the enforcement point, not the prompt.

## Maintenance

| Cadence | Task |
|---|---|
| Weekly | Review rejected plans, plan edits, MR review comments; check guardrail counters |
| Monthly | Re-run the golden set; review cost per merged MR; check known-issues expiries |
| Quarterly | Rotate credentials; review autonomy levels against metrics; refresh golden sets with recent tickets |
| On model change | Re-run the full golden set before switching; re-tune effort levels; do not assume prompt behaviour carries over |
| On prompt change | Golden set in CI, blocking |

## Deployment checklist

- [ ] Service account created with least privilege ([05](05-guardrails.md#6-identity-and-permissions))
- [ ] Branch protection: agent cannot merge or self-approve
- [ ] Secrets in a real secret store; config has only `${VAR}` references
- [ ] Kill switch tested end to end
- [ ] Health checks green for every configured connector
- [ ] Dashboards and alerts live
- [ ] Budget caps set at every level
- [ ] Retention configured
- [ ] Named owner and an on-call path
- [ ] Team notified with the "what to tell the team" message ([08](08-rollout.md#what-to-tell-the-team))
- [ ] Rollback plan: how to disable, how to close open MRs in bulk
