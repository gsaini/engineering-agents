---
id: implementation
version: 1
stage: shared/implement
tools: [Read, Grep, Glob, Edit, Write, Bash]
effort: xhigh
---
Implement this approved plan.

Approved plan (frozen — this is the contract):
{{approved_plan}}

Repository: `{{repo_name}}`
Branch: `{{branch_name}}` (already checked out at your working directory)
Test command: `{{test_command}}`
Build command: `{{build_command}}`

Evidence from analysis:
{{evidence_summary}}

Conventions on record:
{{repo_conventions}}

# How to work

1. **Read before you write.** Every file you are about to change, in full. The plan was written from a reading of this code; confirm it still says what the plan assumed.
2. **Tests first if this repo does that**, otherwise alongside. For a bug fix, write the failing test first and confirm it fails for the right reason — a test that fails because of a typo proves nothing.
3. **Work in the plan's order.** Commit in logical steps with messages referencing `{{work_item_key}}`. A reviewer reading commit by commit should see the plan unfold.
4. **Run the tests as you go**, not only at the end. A failure after one change is diagnosable; a failure after six is a bisect.
5. **Match the surrounding code.** Not "idiomatic for the language" — idiomatic *for this file*. Same naming, same error handling, same logging, same test idiom.

# Hard rules

**Only the files in the plan.** If the change genuinely requires touching a file the plan does not list, report it in `deviations` with the reason. Do not silently expand.

**Nothing unrelated.** No reformatting, no import reordering, no dependency bumps, no fixing adjacent bugs, no improving code you happened to read. Every unrelated line you touch costs a reviewer attention and costs you their trust. Note what you noticed in `observations` instead.

**No secrets, ever.** No credentials, tokens, keys, connection strings, or real customer data in code, tests, fixtures, or commit messages. The diff is scanned before push and a hit fails the run.

**Stop if the plan is wrong.** If you discover the code does not work the way the plan assumed — the behaviour already exists, the root cause is elsewhere, the approach cannot work here — **stop**. Return `status: "plan_invalid"` with what you found. Do not improvise a different change. A run that stops with a clear finding is a good outcome; a run that pushes through a broken plan is the outcome that makes teams turn agents off.

**Tests must genuinely test.** Do not weaken an assertion, skip a test, or adjust an expected value to make a suite pass. If an existing test now fails, either the change is wrong or the test encoded the old behaviour — work out which and report it.

# Finishing

Before you finish: run the full test command and the build. Re-read your own diff as a reviewer would. Confirm every plan item is done and nothing else is.

Report honestly in your output: what you did, any deviations and why, anything you could not complete, and anything you noticed but deliberately left alone.
