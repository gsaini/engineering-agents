# 07 — Evaluation

You cannot tune what you do not measure, and "the agent feels useful" does not survive a budget review.

## The metrics that matter

### Primary — is it working?

| Metric | Definition | Target to promote autonomy |
|---|---|---|
| **Plan acceptance rate** | Plans approved (with or without edits) ÷ plans proposed | > 70% |
| **Plan edit distance** | Median fraction of plan lines changed before approval | < 20% |
| **MR merge rate** | MRs merged ÷ MRs opened | > 60% |
| **MR review burden** | Median review comments per agent MR ÷ same for human MRs | < 1.5× |
| **Time to first plan** | Ticket created → plan posted | < 30 min |
| **RCA accuracy** (log-triage) | Confirmed-correct root causes ÷ RCAs proposed | > 75% |

### Secondary — is it worth it?

| Metric | Definition |
|---|---|
| Cost per merged MR | Total USD ÷ merged MRs. The number that decides whether this continues. |
| Human minutes saved | Baseline time for equivalent work − review time spent. Estimated from a sample, not assumed. |
| Coverage | Eligible tickets acted on ÷ eligible tickets |
| Escape rate | Agent MRs later reverted or hot-fixed ÷ merged |

### Guardrail — is it safe?

| Metric | Alert threshold |
|---|---|
| Blast-radius breaches | Any |
| Tool-denial rate per run | > 5 denials |
| Sensitive-path detections | Tracked; a rise means routing is drifting |
| Injection-detection hits | Any — investigate |
| Secret-scan blocks | Any — investigate |
| Budget stops | > 5% of runs |

**Escape rate is the one to watch hardest.** A high merge rate with a high escape rate means reviewers have started rubber-stamping, which is worse than an agent nobody uses.

## Offline evaluation

### Golden sets

Two fixture collections, built from your own history:

**Ticket set** — 50–100 closed tickets with their actual implementing MRs. For each: the work item at the time it was filed, the repo at the commit before the fix, the merged diff, the review comments.

Scored per stage:

| Stage | Scored on |
|---|---|
| Triage | Correct in/out of scope; correct repo (exact match) |
| Analysis | Requirement restatement judged against the real one; did it surface the ambiguities the humans actually raised in comments? |
| Plan | Overlap of planned files vs. actually-changed files (precision/recall); did it name the approach the humans took? |
| Implementation | Do the repo's existing tests pass? Does the agent's own test fail on the pre-fix commit? |

**Log set** — 30–50 historical incidents with their post-mortems, the log window, and the fix MR.

| Stage | Scored on |
|---|---|
| Detection | Would the query have fired, at what lag? |
| Fingerprinting | Correct clustering vs. hand-labelled ground truth |
| RCA | Root cause matches the post-mortem (LLM-judged with the post-mortem as reference, spot-checked by a human) |
| Fix | Same file(s) as the real fix; regression test fails pre-fix |

File-overlap is a proxy, not truth — a better approach that touches different files scores badly. Treat a drop as a signal to look, not as a verdict.

### Ablations worth running

Retrieval is where the money and the quality both are:

- Analysis with and without: comments, linked items, git history, existing tests
- Evidence caps at 20 / 60 / 200 files
- Detection windows at 5 / 15 / 60 minutes
- Effort level per stage (`low` for triage, `high`/`xhigh` for RCA and planning)

The usual finding is that comments and git history are worth far more than raw file count, and that the top of the retrieval budget buys almost nothing. That is a direct cost saving.

### LLM-as-judge

Used for the subjective stages (analysis quality, RCA correctness, plan reasonableness), with the standard precautions:

- The judge sees the reference (real MR, real post-mortem), never the agent's reasoning transcript
- Rubrics are concrete and scored per-criterion, not a single 1–10
- Judge agreement with human labels is measured on a held-out slice; below ~80% agreement the rubric is the problem, not the agent
- A human spot-checks 10% forever

## Online evaluation

### Shadow mode

Before any team sees a plan, run the agent silently for 2–4 weeks against real tickets. Nothing is posted. Everything is recorded. Then sample 30 runs and have an engineer grade the plans blind against what actually happened.

This is the cheapest possible way to find out that your repo mapping is wrong, or that half your tickets lack acceptance criteria, before the agent's first impression is made. First impressions with developer tools are close to permanent.

### A/B on prompts and retrieval

Route a fraction of runs through a variant. Compare plan acceptance rate and cost per merged MR. Keep variants long enough for statistical honesty — at typical volumes that is weeks, not days. Prompts and retrieval configs are versioned and stamped on every run so results are attributable.

### Regression protection

Every prompt change runs the golden set in CI. A drop beyond a threshold on any stage blocks the merge. Prompt changes are code changes, reviewed like code changes.

## The weekly review

For the first few months, a human should spend 30 minutes a week on:

1. Every rejected plan, grouped by taxonomy reason
2. Every plan edit diff
3. Review comments on merged agent MRs
4. Any run with tool denials, budget stops, or a blast-radius breach

Almost everything found here is fixable in the evidence bundle or the prompt. The failure pattern this catches earliest — and the most common one — is not the model reasoning badly. It is the model reasoning correctly about the wrong context.
