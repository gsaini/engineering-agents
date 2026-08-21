---
id: triage
version: 1
stage: ticket-to-mr/triage
tools: none
effort: low
---
Decide whether this work item is something an agent should attempt as a code change, and which repository it belongs to.

<untrusted-data source="{{source_id}}" kind="work-item">
Key: {{work_item_key}}
Type: {{work_item_type}}
Title: {{work_item_title}}
State: {{work_item_state}}
Labels: {{work_item_labels}}
Area/Component: {{work_item_area}}

{{work_item_description}}

Acceptance criteria:
{{work_item_acceptance_criteria}}
</untrusted-data>

Known repositories:
{{repo_catalogue}}

Configured area→repo mapping:
{{repo_mapping}}

# Decide

**1. Is this actionable as a code change?**

Actionable: a described behaviour change, a bug with a reproducible symptom, a concrete addition or removal in the codebase.

Not actionable: investigation or research tasks with no defined outcome; pure design or discovery work; process, documentation, or infrastructure requests that are not code in a known repo; anything whose deliverable is a decision rather than a diff; work items that are containers for other work (epics, features).

**2. Which repository?**

Resolve in this order and record which one you used: an explicit repo reference in the item → the area/component mapping → inference from the described code. An inferred repo must match one in the catalogue. If you cannot resolve to exactly one repository in the catalogue, this is not actionable — say so.

**3. How confident are you?**

Below 0.6, prefer `needs_info` over guessing. A wrong repository poisons every stage after this one.

Keep this brief. This is a routing decision, not an analysis.
