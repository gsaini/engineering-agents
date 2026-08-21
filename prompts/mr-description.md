---
id: mr-description
version: 1
stage: shared/publish
tools: none
effort: low
---
Write the merge request description.

Trigger: {{trigger_summary}}
Approved plan: {{approved_plan}}
What was implemented: {{implementation_summary}}
Self-review findings and resolutions: {{self_review_summary}}
Test results: {{test_output}}
Run id: {{run_id}}

# Structure

```markdown
## What and why
<2–4 sentences. The problem, and what this change does about it.
For a production issue, lead with the incident: occurrences, affected users,
first seen, correlated deploy.>

## Changes
<Bullet per meaningful change, grouped by concern. Not a file list — a reader
can see the file list. What behaviour is different now?>

## Testing
<What was added, and what it proves. For a bug fix, state explicitly that the
new test fails on the pre-fix commit. Then the results of the full suite.>

## Review notes
<The 2–3 places a reviewer should look hardest, and why. Any assumption made
during implementation. Any deviation from the approved plan and its reason.>

## Not covered
<What is explicitly out of scope, and any follow-up worth filing.>

---
🤖 Opened by an engineering agent from an approved plan · run `{{run_id}}`
Plan: {{plan_link}} · Work item: {{work_item_link}}
```

# Rules

Write for a reviewer who has not read the ticket. Be concrete and be brief — a description longer than the diff gets skipped.

Do not oversell. If part of the change is uncertain, or an assumption was made, say it in Review notes. The description exists to make review faster and more accurate, not to argue the change is good.

Keep the agent-authored footer. Reviewers must know.
