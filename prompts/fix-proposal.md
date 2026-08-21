---
id: fix-proposal
version: 1
stage: log-triage/propose-fix
tools: [Read, Grep, Glob]
effort: xhigh
---
Propose a fix for this confirmed root cause.

Root cause:
{{root_cause_json}}

Repository: `{{repo_name}}`
Fix classes this deployment will auto-propose: {{auto_propose_classes}}
Fix classes that are flag-only: {{flag_only_classes}}

# Classify first

The class determines whether an MR is even the right output.

- **defensive** — a missing null/bounds/empty check. The guard is necessary but is **not the whole fix**: also address whatever produced the invalid state. A plan that only adds the guard is incomplete, and you must say which part is the guard and which part is the cause.
- **contract** — API or schema mismatch, bad deserialization, wrong assumption about a payload. Fix the contract or add explicit validation at the boundary.
- **concurrency** — race, deadlock, non-atomic read-modify-write. Propose with reduced confidence and say plainly what you could not verify statically.
- **resource** — leak, pool exhaustion, unbounded growth. Fix the lifecycle and add a bound.
- **logging** — an expected condition logged as an error. The fix is the log level or the handling, plus an adjustment to the detection query. This is a real and useful outcome; do not escalate it into an invented code bug.
- **config** / **dependency** — no code fix. Write the recommendation. The exception is a missing timeout, retry, or circuit breaker, which *is* a code fix — say which.

# The regression test is mandatory

Describe a test that **fails on the current code** and passes after the fix. It will be executed against the pre-fix commit; if it passes there, this plan is rejected, because a test that does not reproduce the bug does not prove anything.

Use `whyTestsMissedIt` from the root cause to place it. If the existing tests pass because they construct objects through a different path than production does, the test belongs on *that* path — not another test alongside the ones that already miss it.

# Then plan

Same structure as an implementation plan: approach and rejected alternative, a change table with each row justified, tests as behaviours, quantified blast radius, assumptions, out of scope, rollback.

Two additions:

- **Lead with the incident.** Occurrences, affected users, first seen, correlated deploy. The reviewer needs to know the severity before they read the diff.
- **A monitoring note.** The concrete query to run after deploy to confirm the fix worked. The fingerprint will be watched for {{verification_window_hours}} hours; say what "confirmed" looks like.

Prefer the smallest correct fix. A production incident is the worst possible moment to also refactor.
