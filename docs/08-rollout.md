# 08 — Rollout

Autonomy is earned per capability, measured, and reversible. The failure mode to avoid is switching on `autonomous` on day one, producing three bad MRs, and having the team disable the whole thing permanently.

## The autonomy ladder

| Rung | Mode | Agent does | Agent does not | Promote when |
|---|---|---|---|---|
| 0 | `observe` | Runs the full pipeline, writes to the run store only | Post anything anywhere | 2–4 weeks of shadow data; 30 runs graded blind; plan acceptance would be > 60% |
| 1 | `comment` | Posts analysis and plan as ticket comments / incident notes | Write code, create branches, open MRs | 4+ weeks; plan acceptance > 70%; team actively reads them |
| 2 | `propose` | Everything through opening a **draft** MR, after approval | Mark MRs ready; merge | Merge rate > 60%; review burden < 1.5× human; escape rate < 5% |
| 3 | `propose` (ready) | Opens review-ready MRs | Merge | 8+ weeks at rung 2 with stable metrics |
| 4 | `autonomous` | Auto-approves plans meeting strict criteria | Merge — ever | Only for narrow, proven classes. See below. |

Configured per agent **and** per repository. A team can be at rung 3 in a well-tested service and rung 1 in the legacy monolith, which is usually the right answer.

## Rung 4 is narrow by design

Auto-approval fires only when **all** of these hold:

- Risk is `low` and blast radius is under half the configured limit
- No schema change, no config change, no public API change
- The repository is on the `autonomousRepos` allowlist
- No sensitive-path match
- The ticket class is on the allowlist — in practice: dependency bumps with green tests, log-level corrections, typo and copy fixes, adding a missing null guard with a test, mechanical refactors with unchanged behaviour
- The repo has meaningful test coverage on the touched paths

Anything else falls back to human approval regardless of mode. Auto-approved runs still open MRs that a human reviews and merges — rung 4 removes the *plan* gate, never the *merge* gate.

## Phased plan

### Phase 0 — Foundations (weeks 1–2)

Service account with least privilege. Branch protection verified — including that the agent cannot approve its own MR. Config, connectors, and health checks green. One repo, one team, one project as the pilot. Kill switch tested end to end *before* the first real run.

Pick the pilot deliberately: good test coverage, a healthy ticket-writing culture, and at least one engineer who wants this to work. A pilot in the worst-documented service proves nothing except that the service is badly documented.

### Phase 1 — Shadow (weeks 3–6)

Both agents at `observe`. Build the golden sets from history in parallel. At the end: 30 runs graded blind, ablations run, retrieval budget tuned.

Expect the biggest wins here to be unglamorous — repo mapping corrections, HTML/ADF conversion fixes, a detection query that was matching noise.

### Phase 2 — Comment (weeks 7–12)

Ticket-to-MR to `comment`; log-triage stays at `observe` one cycle longer, because a wrong RCA posted publicly costs more trust than a wrong plan. Announce it properly: what it does, what it will not do, how to turn it off, and who owns it.

Weekly review starts here and does not stop.

### Phase 3 — Propose, draft MRs (weeks 13–20)

Ticket-to-MR to `propose` with draft MRs. Log-triage to `comment`. Every agent MR labelled. Reviewers briefed that agent MRs need *more* scrutiny, not less — particularly on whether the change addresses the actual requirement, since that is where the failure mode lives.

Add a second repo. The second repo is the real test of whether the design generalises or whether it was tuned to one codebase.

### Phase 4 — Propose, ready MRs (weeks 21+)

Ticket-to-MR to full `propose`. Log-triage to `propose` with draft MRs. Expand to more repos and teams. Cost per merged MR should now be a stable, quotable number.

### Phase 5 — Narrow autonomy (month 6+)

Rung 4 for the allowlisted classes only, in the pilot repo only, for a month before considering expansion.

## Demotion

Promotion is slow; demotion is immediate and needs no meeting. Any of these drops the agent one rung automatically:

- Escape rate > 10% over a rolling 20 MRs
- Plan acceptance < 50% over a rolling 20 plans
- Any secret-scan block or injection-detection hit
- Any blast-radius breach that reached an MR
- Any team member asking for it — no justification required

That last one matters. An agent a team has been told they cannot turn off is an agent the team will route around.

## Organisational preconditions

Technical readiness is the easy half.

| Precondition | Why | If missing |
|---|---|---|
| Tickets have acceptance criteria more often than not | Analysis quality is bounded by input quality | Agent will mostly produce `NEEDS_INFO`. That is still useful — but set expectations, and treat it as a ticket-hygiene programme with an agent attached |
| Repos have runnable tests | Verification is the safety net | Restrict to repos that do; the alternative is unverifiable diffs |
| Code review is already a habit | Agent MRs go through the same gate | Fix the review culture first; an agent will not fix it |
| A named owner | Someone tunes prompts, reads the weekly review, answers "why did it do that?" | It degrades quietly and gets switched off within a quarter |
| Team agreement | Engineers who did not agree to this will resent it | Pilot with volunteers |

## What to tell the team

Be specific and be honest about the limits. Something close to:

> There's an agent watching *this project's* `agent-ready` tickets. When one is filed it reads the ticket and the code, and posts an implementation plan within about 20 minutes.
>
> If you approve the plan, it writes the code and opens a **draft** MR. You review it like any other MR. It cannot merge anything.
>
> If it can't work out what a ticket means, it asks specific questions in the comments. If the questions are dumb, tell us — that's a prompt bug and we fix those weekly.
>
> Turn it off for a ticket with the `no-agent` label. Turn it off entirely with `/agents pause`. It's owned by <name>, and every run is auditable at <link>.

---

## The ladder in code

[`src/runtime/ladder.ts`](../src/runtime/ladder.ts) holds the table above as
data, and the promote/demote gates as functions over the metrics in
[07-evaluation.md](07-evaluation.md).

```bash
npm run dev -- metrics --agent ticket-to-mr --limit 20 --ladder --weeks 6
```

Three properties are enforced there rather than left to good intentions:

- **A metric nobody measured blocks promotion**, and reports differently from a
  metric that failed. Promotion needs every criterion; there is no partial credit
  for a number that was never collected.
- **Demotion needs one trigger and no quorum** — including "a team member asked",
  which takes no justification and records none.
- **There is no rung above 4.** `evaluatePromotion` refuses at the top of the
  ladder. Merge stays human, permanently.

### Rungs 2 and 3 are one config flag apart

Both are `autonomy: propose`. What separates them is
`agents.<agent>.draftMergeRequests`:

```yaml
agents:
  ticketToMr:
    autonomy: propose
    draftMergeRequests: true    # rung 2 — draft MRs
    # draftMergeRequests: false # rung 3 — review-ready MRs
```

It defaults to `true`, because arriving at `propose` should put you on rung 2
rather than skipping one. A code host can pin drafts on for every MR it receives
with the connector-level `forceDraft` option, which is the right control for a
host that must never see a review-ready agent MR — and the wrong place to make
the ladder decision, since it silently overrides whatever the agent asked for.
