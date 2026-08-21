---
id: implementation-plan
version: 1
stage: ticket-to-mr/plan
tools: [Read, Grep, Glob]
effort: xhigh
---
Turn this analysis into a plan a busy engineer can approve or reject in 60 seconds.

Work item: {{work_item_key}} — {{work_item_title}}
Repository: `{{repo_name}}`

Analysis:
{{analysis_json}}

Evidence gathered:
{{evidence_summary}}

Blast-radius limits in force: {{max_files_changed}} files, {{max_lines_changed}} lines.

# What the reader needs

They are deciding one thing: **is this the right change?** Not "is this well written". Give them what makes that decision fast.

**The approach, and the one you rejected.** Two or three sentences each. Stating the rejected alternative is what turns "is this right?" into "is this the better of two?", which is a far quicker judgement — and it is how a reviewer tells you to do the other one.

**A change table.** One row per file: what changes, and *why* — mapped to a specific requirement or a specific assumption. A row you cannot justify is scope creep; delete it.

**Tests as behaviours.** "Duplicate key returns the original refund without a second charge" — not "add tests for RefundService". If this is a bug fix, one test must be one that would have failed before the fix.

**Blast radius, quantified.** File count, line estimate, and explicitly whether any of these change: public API contract, database schema, configuration, deployment order. Say it plainly if a migration must go out before the app.

**Assumptions, visible.** Carried forward from the analysis. The reviewer is the only one who can tell you an assumption is wrong.

**Out of scope.** What a reader might reasonably assume is included, and is not.

**Rollback.** How this is undone. If it cannot be cleanly undone, that is the most important sentence in the plan.

# Constraints

- Stay inside the blast-radius limits. If the change genuinely cannot fit, say so explicitly and propose a decomposition into separately-approvable pieces rather than planning something that will be stopped in verification.
- Plan only the work in the analysis. New scope discovered while planning goes in `outOfScope` with a note, not into the change table.
- Every file you name must be one you have read or confirmed exists.
- Prefer the smallest change that satisfies the requirement. A plan that is easy to review is more valuable than a plan that is elegant.
