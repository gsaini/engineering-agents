# 0007 — Anomaly detection lives in the query, not the model

**Status:** Accepted · 2026-08-20

## Context

The log-triage agent needs to decide that something is wrong. It could stream logs to the model and ask; it could use a platform's built-in anomaly detection; or it could run an explicit detection query on a schedule.

## Decision

Detection is a **query** the operator writes and owns, configured per log source, in the platform's own language (KQL / Logs Insights / SPL). Three templates ship: `new-fingerprint`, `rate-threshold`, `slo-burn`. The agent's work starts at "here is a cluster above threshold".

Fingerprinting and suppression are deterministic code, not model calls.

## Consequences

- Cost is bounded and predictable. Streaming production log volume through a model is not.
- Detection is deterministic, tunable, and testable — and reviewable by whoever already owns the alerting.
- Teams keep the thresholds they have already tuned instead of relitigating them inside a prompt.
- Novel failure modes that a query does not describe are missed. Accepted: the agent's value is in triage and fix, not in being a better anomaly detector than the platform.
- Query quality becomes an operator responsibility, and a bad query produces confident noise. Mitigated by requiring both a count floor and an affected-user floor, and by shadow mode before anything is posted.
- Platforms differ in what they can express (CloudWatch has no cross-query joins, so novelty is computed client-side). The connector absorbs this.
