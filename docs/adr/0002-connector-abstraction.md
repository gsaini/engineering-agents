# 0002 — Normalise providers behind four interfaces

**Status:** Accepted · 2026-08-20

## Context

The requirement is explicitly "Azure DevOps / Jira (any configurable tool)" and "Splunk / CloudWatch / App Insights". Providers differ in field names, auth, query language, and pagination — but not in concepts. A story is a story; an error cluster is an error cluster.

Three options:

1. **Provider-specific pipelines.** Fastest to a working ADO demo, then every new provider is a fork of the whole pipeline.
2. **Pass raw payloads to the model** and let it figure out the shape. Attractive because it looks like zero integration work. In practice it burns tokens on vendor JSON, produces non-deterministic field extraction, and makes every provider a new source of silent failure.
3. **Normalise at a connector boundary.**

## Decision

Four interfaces — `WorkItemSource`, `LogSource`, `CodeHost`, `Notifier` — each with a normalised domain type. The raw provider payload is preserved on the run record for audit, but pipelines never read it.

Adding a provider is one file plus a config schema entry. Pipelines do not change.

## Consequences

- Provider quirks are isolated and testable with fixtures; no live credentials in tests.
- Some fidelity is lost — a provider-specific field with no home in the domain type lives only in `raw`. Accepted: the alternative is a domain type that is the union of every vendor's schema.
- The mapping tables in [04-connectors.md](../04-connectors.md) become the contract, and they must be maintained as vendor APIs move.
- Cross-provider comparison becomes possible: the same fingerprinting logic applies to Splunk and App Insights signals alike.
