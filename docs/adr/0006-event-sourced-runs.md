# 0006 — Event-sourced run state

**Status:** Accepted · 2026-08-20

## Context

A run is long-lived — minutes of work, then potentially days parked at `AWAITING_APPROVAL`. It must survive a process restart, be resumable, and be fully auditable after the fact ("why did the agent do that?" is a question that will be asked).

Options: mutable row per run; event log plus materialised state; or in-memory with periodic snapshots.

## Decision

Append-only `RunEvent` log per run. Current state is a fold over the events. Every transition records timestamp, actor (`agent` / `user:<id>` / `system:<reason>`), and payload.

The reference `FileRunStore` writes `.runs/<runId>/events.jsonl` plus a `state.json` snapshot. The interface is narrow — `append`, `load`, `list`, `findByIdempotencyKey` — so a database implementation is a single file.

## Consequences

- Crash recovery is free: reload non-terminal runs and resume.
- Audit is exact rather than reconstructed. Auto-approved and human-approved runs have identical record shapes.
- Approvals are durable by construction, which is what makes [0003](0003-mandatory-plan-approval.md) practical.
- Slightly more code than a mutable row, and state must always be derived rather than patched.
- The JSONL implementation is single-node. Multi-worker deployments need a real store plus a lease on each run — anticipated in the interface, not implemented here.
