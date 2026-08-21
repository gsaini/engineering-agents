# Prompts

One file per pipeline stage. Every prompt is versioned (`version:` in the front matter) and the version is stamped on each run, so evaluation results are attributable to an exact prompt.

| File | Stage | Tools | Effort | Output |
|---|---|---|---|---|
| [`_system.md`](_system.md) | All | — | — | Shared operating rules, prepended everywhere |
| [`triage.md`](triage.md) | Ticket-to-MR § 1 | none | low | `TriageResult` |
| [`requirement-analysis.md`](requirement-analysis.md) | Ticket-to-MR § 2 | read-only | high | `Analysis` |
| [`implementation-plan.md`](implementation-plan.md) | Ticket-to-MR § 3 | read-only | xhigh | `Plan` |
| [`log-root-cause.md`](log-root-cause.md) | Log-Triage § 3 | read-only | xhigh | `RootCause` |
| [`fix-proposal.md`](fix-proposal.md) | Log-Triage § 4 | read-only | xhigh | `Plan` |
| [`implementation.md`](implementation.md) | Shared | read-write + bash | xhigh | `ImplementationResult` |
| [`self-review.md`](self-review.md) | Shared verify | read-only | high | `SelfReview` |
| [`mr-description.md`](mr-description.md) | Shared publish | none | low | Markdown |

**Rules for changing a prompt**

1. Bump `version`.
2. Run the golden set ([07-evaluation](../docs/07-evaluation.md)). CI blocks regressions.
3. Prompt changes are reviewed like code changes.

**Placeholders** are `{{double_brace}}` and are filled by `src/agent/prompts.ts`. Anything originating outside the team — ticket text, comments, log messages — is wrapped in `<untrusted-data>` by the renderer, never inlined raw.
