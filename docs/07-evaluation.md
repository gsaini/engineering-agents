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

---

## The harness

Everything above is implemented under [`src/eval/`](../src/eval/). It runs with
no credentials and no token spend, because an evaluation harness that only works
against a live tenant is one nobody runs.

| File | What it does |
|---|---|
| [`types.ts`](../src/eval/types.ts) | Golden case schemas and score types. Cases are hand-authorable: only the fields carrying signal are required |
| [`golden.ts`](../src/eval/golden.ts) | Loads and validates `eval/golden/{tickets,logs}/*.json`, one file per case |
| [`replay.ts`](../src/eval/replay.ts) | Drives the **real pipelines** against golden cases with in-memory connectors |
| [`scorers.ts`](../src/eval/scorers.ts) | Per-stage scoring, all pure and all normalised to 0..1 |
| [`judge.ts`](../src/eval/judge.ts) | Rubrics, the model judge, the deterministic fallback, and agreement measurement |
| [`report.ts`](../src/eval/report.ts) | Aggregation and the CI regression gate |
| [`metrics.ts`](../src/eval/metrics.ts) | The online metrics, folded out of the run event log |

### Running it

```bash
npm run eval                       # offline, deterministic, free
npm run eval -- --out eval/baseline.json    # record a baseline
npm run eval:gate                  # compare against the baseline; non-zero exit on a drop
npm run dev -- eval --config config/config.yaml --live --variant retrieval-v3
```

`--live` is the real evaluation: the actual model, the model judge, real spend.
The default is a deterministic replay against fixtures — cheap enough to run on
every pull request, which is what makes it a gate rather than a ritual.

### What the code enforces, rather than asks for

- **Replay cannot reach anything.** `replayConfig` forces `autonomy: observe` and
  `dryRun: true`, so a replay over last year's tickets cannot comment on one of
  them. Connectors are in-memory; the notifier posts nowhere.
- **The judge cannot see the transcript.** `JudgeRequest` has fields for the
  reference and the candidate's conclusion, and no field for the agent's
  reasoning. A judge that reads the reasoning grades the argument, not the answer.
- **Lexical scoring is labelled as such.** The deterministic judge returns
  `modelJudged: false`, and the report prints "treat as a smoke test". A proxy
  score can never be presented as a graded result.
- **An empty reference scores zero, not one.** Missing ground truth must not read
  as a perfect score.
- **The gate compares deltas, not absolutes.** Absolute golden-set scores depend
  on how the set was built; the change between two runs of the same set is the
  part that means something.

### What it cannot do offline

Three of the metrics in this document need facts the run store does not hold, and
they report `null` rather than zero when nobody supplied them:

| Metric | Needs |
|---|---|
| MR merge rate, cost per merged MR | A code-host lookup of each MR's state |
| Escape rate | The revert/hot-fix label, fed back from review |
| RCA accuracy | Human confirmation from the weekly review |

The implementation stage is the fourth. Scoring it means running the repo's own
tests at the pre-fix commit and checking the agent's regression test fails there
— `scoreImplementation` takes those two observations as inputs, because gathering
them needs a real checkout that a golden case does not carry.

### The rolling window

`selectRuns(runs, { limit: 20 })` is the window the demotion triggers in
[08-rollout.md](08-rollout.md) are defined over. A lifetime average takes months
to move, by which point the team has already stopped reading the plans.

```bash
npm run dev -- metrics --agent ticket-to-mr --limit 20 --ladder --weeks 6
```
