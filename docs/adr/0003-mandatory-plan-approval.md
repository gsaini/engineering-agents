# 0003 — A mandatory plan-approval gate

**Status:** Accepted · 2026-08-20

## Context

The obvious product is ticket-in, MR-out with no human in the middle. It demos well. It fails in production for a specific reason: a wrong MR is expensive to review and *emotionally* expensive to reject, so reviewers either rubber-stamp it or stop looking at agent MRs entirely.

Options considered:

1. **No gate** — fully autonomous, review at the MR. Fast, and produces the failure above.
2. **Gate at the MR only** — the same thing with a label.
3. **Gate at the plan.** Costs one round-trip of latency.
4. **Gate at both.** The MR gate already exists as normal code review.

## Decision

A mandatory approval gate between planning and implementation. The plan is the reviewable unit. Implementation runs only from a frozen, approved plan.

In `autonomous` mode the gate auto-fires for narrowly-defined low-risk classes — but the state and its record still exist, attributed to `system:auto-approve`.

## Consequences

- Rejecting a bad idea costs ~60 seconds and ~$1.50 instead of ~20 minutes and ~$6.
- The plan-edit diff is the highest-signal evaluation data the system produces; without this gate it does not exist.
- Latency increases by however long approval takes — mitigated by TTL, reminders, and expiry.
- Approval fatigue is a real risk. Mitigated by making the message scannable in 60 seconds ([06](../06-human-in-the-loop.md)) and by digest mode at low autonomy.
- Requires durable, asynchronous approval handling, which is more machinery than a blocking prompt. Accepted — see [0006](0006-event-sourced-runs.md).
