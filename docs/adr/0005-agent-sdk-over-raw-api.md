# 0005 — Claude Agent SDK for implementation, structured calls for analysis

**Status:** Accepted · 2026-08-20

## Context

Two very different kinds of model work happen in these pipelines:

- **Analysis, planning, RCA** — one structured output from a well-assembled context. Read-only retrieval, then a schema-validated answer.
- **Implementation** — genuinely open-ended: read, search, edit, run tests, read the failure, edit again, repeat. A loop whose length is not known in advance.

Options: build the agent loop by hand on the Messages API; use the SDK tool runner with hand-written file tools; or use the Claude Agent SDK, which ships the loop, the file/search/bash tools, permissions, hooks, and context management.

## Decision

Use `@anthropic-ai/claude-agent-sdk` (`query()`, model `claude-opus-5`) behind an `AgentRunner` interface, for every stage. The interface exists so that:

- pipelines are testable with `DryRunAgentRunner` and no credentials,
- the analysis stages can move to a plain Messages API call later without touching pipeline code,
- and stages differ only in their tool policy — read-only for analysis, read-write for implementation.

The SDK's `canUseTool`, `allowedTools`, `sandbox`, and `maxBudgetUsd` are the enforcement points for [05-guardrails](../05-guardrails.md).

## Consequences

- The file-editing loop, retries, and context management are not reimplemented. This is the largest single saving in the codebase.
- Tool policy, budget, and permission denial are configuration rather than custom code, and denials are recorded uniformly.
- The dependency is heavier than the plain SDK, and it spawns a subprocess — which is why it is `optionalDependencies` and behind an interface.
- Analysis stages carry slightly more machinery than a bare structured call needs. Accepted for uniformity of budget, logging, and tool enforcement.
- Structured stage outputs are validated with Zod at the boundary; one repair round is allowed before the stage fails.
