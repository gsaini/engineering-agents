# 0008 — The agent never merges

**Status:** Accepted · 2026-08-20

## Context

The natural end state of "automate the engineer's daily loop" is the agent merging its own low-risk changes. Dependency bumps with green CI are the standard example, and the argument is reasonable.

## Decision

The agent never merges. Not at any autonomy level, not for any change class. It opens merge requests; humans merge them. Enforced by permissions (the service account cannot merge protected branches and cannot self-approve), not by prompt.

## Consequences

- One human looks at every change that reaches the default branch. That is the last line of defence and by far the cheapest one.
- Some genuinely safe automation is left on the table. Accepted — the cost of an automated merge going wrong is not symmetric with the saving.
- Simplifies the security story enormously: there is no path from prompt injection to production, because there is no code path from the agent to a merge.
- The escape-rate metric stays meaningful. If the agent merged its own work, "reverted after merge" would measure the agent and the reviewer together, and neither number would be actionable.
- Should this be revisited, it would require a separate ADR, a separate permission grant, and a class-by-class case — not a config flag.
