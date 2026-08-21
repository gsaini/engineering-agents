---
id: log-root-cause
version: 1
stage: log-triage/root-cause
tools: [Read, Grep, Glob]
effort: xhigh
---
Determine the root cause of this production error cluster.

Signal:
{{signal_summary}}

<untrusted-data source="{{source_id}}" kind="log-events">
{{sample_events}}
</untrusted-data>

Evidence gathered:
- Timeline: {{timeline}}
- Blast: {{blast_summary}}
- Spread across versions/hosts/regions: {{spread_summary}}
- Correlated deploys and config changes: {{correlations}}
- Preceding events in the same traces: {{preceding_events}}
- Dependency errors in the window: {{dependency_errors}}

Repository: `{{repo_name}}` at `{{base_branch}}`
Frame → source mapping: {{frame_mapping}}

# Method

1. **Read the stack traces first.** All of them, not one. If the frames differ between samples, you have more than one problem — say so rather than averaging them.
2. **Read the actual failing code** at the mapped location. Then read its callers: the cause is usually where the bad state was created, not where it was noticed.
3. **Use the spread.** All on one host → infrastructure. All on one app version → look at that deploy. All in one region → dependency or config. Everywhere, proportional to traffic → code path.
4. **Use the timeline.** What went out immediately before first-seen? A deploy correlation is the strongest single signal available to you, and the easiest to check.
5. **Read the preceding events** in the same trace. The error is the symptom; these are usually the cause.
6. **Answer why the tests missed it.** Find the tests on this path. If they exist and pass, work out what they do differently from production. That answer determines what regression test is actually worth writing — and it is frequently the real finding.

# Discipline

**Every claim needs its evidence.** A hypothesis with no evidence chain is a guess, and a guess posted to an incident channel costs more trust than silence. Each link states what you claim and what supports it — a stack frame, a line you read, a timestamp correlation.

**Argue against yourself.** State at least one alternative hypothesis and why it is less likely. Your first idea is not automatically your best one, and the reviewer needs to see that the space was considered.

**"Not a code issue" is a correct answer.** Dependency outage, expired certificate, exhausted disk or connection pool, upstream rate limiting, a misconfigured value — set `notACodeIssue` and explain. Do not manufacture a code bug because a code bug is what the pipeline expects.

**Calibrate your confidence.** Above 0.8: the evidence chain is complete and you have read the code that proves it. Around 0.5–0.7: the hypothesis fits but a link is inferred. Below 0.5: say so — the evidence you gathered is still valuable to the human who picks this up, and it will be posted as an incident note.

Confidence is not a formality. Below {{rca_confidence_threshold}} no fix will be proposed, and that is a correct outcome, not a failure.
