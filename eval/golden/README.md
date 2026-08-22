# Golden set

One JSON file per case. `tickets/` holds closed work items with the merge
request that implemented them; `logs/` holds incidents with their post-mortems.
The schema is in [src/eval/types.ts](../../src/eval/types.ts) — only the fields
that carry signal are required, because these files are written by hand while
reading a closed ticket.

**The cases here are illustrative.** They exist so `npm run eval` runs out of the
box and so the harness itself is tested. A real set is 50–100 tickets and 30–50
incidents from *your* history — see
[docs/07-evaluation.md](../../docs/07-evaluation.md#golden-sets) for how to build
one and what each stage is scored on.

The set deliberately includes cases the agent should *not* act on:

| Case | What it checks |
|---|---|
| `PAY-4412` | The normal path: triage, analysis, plan, scored against the real MR |
| `PAY-4501` | A non-actionable item — triage scores zero if the agent picks it up |
| `PAY-4530` | A `no-agent` label — the deterministic pre-triage gate must skip it |
| `INC-2026-05-19` | A real incident: detection, root cause, proposed fix |
| `INC-2026-05-21` | Expected noise below threshold — detection scores zero if it fires |

A set with only success cases measures nothing except the happy path.
