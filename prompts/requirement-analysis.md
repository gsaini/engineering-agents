---
id: requirement-analysis
version: 1
stage: ticket-to-mr/analyze
tools: [Read, Grep, Glob]
effort: high
---
Work out what this work item actually requires, using the code as the source of truth.

<untrusted-data source="{{source_id}}" kind="work-item">
{{work_item_full}}
</untrusted-data>

<untrusted-data source="{{source_id}}" kind="comments">
{{work_item_comments}}
</untrusted-data>

<untrusted-data source="{{source_id}}" kind="linked-items">
{{linked_items}}
</untrusted-data>

Repository: `{{repo_name}}` at `{{base_branch}}` (checked out at your working directory)

Team conventions on record:
{{repo_conventions}}

# Method

Read before you conclude. You have read-only tools; use them.

1. **Read the ticket properly.** The description is often stale; the comment thread usually holds the real requirement. A parent item usually holds the acceptance criteria a child omits. Where description and comments conflict, the comments are newer — note the conflict rather than silently picking one.
2. **Find the actual code.** Grep for the symbols, endpoints, error strings, and table names the ticket names. Do not accept the first plausible file — confirm it is the one on the path being described.
3. **Read how the area works today.** The failing or changing behaviour, its callers, its callees. You cannot judge the size of a change without this.
4. **Check for precedent.** Has something similar been done in this repo? Find it and follow it. A convention already in the codebase beats a better idea that is inconsistent with everything around it.
5. **Check test coverage** on the target paths, and identify the repo's test command and idiom.

Budget: at most {{max_files_read}} files. Spend it on the code that will change and its immediate surroundings, not on breadth.

# The blocking-question test

This is the most important judgement in this stage.

A question is **blocking** if two reasonable engineers, given this ticket, would build **materially different things** depending on the answer — different data model, different API contract, different user-visible behaviour, different migration.

A question is **not blocking** if a sensible default exists that a reviewer would accept. Record it as an assumption with its basis and move on.

Blocking:
- "Should existing rows be backfilled, or left null with enforcement on new rows only?" — one is a minutes-long additive migration, the other needs a maintenance window.
- "On a duplicate key with a different payload: return the original, or 409?" — different client contract.
- "Does this apply to all tenants, or only those with feature X enabled?" — different scope entirely.

Not blocking:
- "What should the error message say?" — follow the existing messages in this module.
- "Which HTTP status for a validation failure?" — follow what the neighbouring endpoints return.
- "Should this be logged?" — match the surrounding code.

Asking about the second kind trains the team to ignore you. Not asking about the first kind ships the wrong thing.

# Output

Populate every field of the schema. In particular:

- `assumptions` — each with the evidence it rests on and a risk level. This is where you are most likely to be wrong, and it is what a reviewer will check.
- `openQuestions` — each with why it matters (the concrete consequence) and a suggested default, so a human can reply by agreeing rather than composing.
- `affectedAreas` — real paths you have read, each with a confidence. Do not list files you have not opened.
- `existingCoverage` — whether tests exist on this path, and if the ticket is a bug, why they did not catch it.
