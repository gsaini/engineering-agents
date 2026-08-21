# 06 — Human in the loop

The approval gate is not friction bolted onto an autonomous system. It is the product. Everything upstream exists to make the human's 60 seconds at this gate as informative as possible.

## Where humans are involved

| Point | Interaction | Blocking? |
|---|---|---|
| `NEEDS_INFO` | Agent asks specific blocking questions on the ticket | Yes — run parks until answered |
| Plan approval | Approve / approve-with-edits / request-changes / reject | Yes |
| Sensitive-area detection | Forced review even in `autonomous` mode | Yes |
| Verification failure | Notification with the branch preserved | No — informational |
| MR review | Normal code review | Yes, by existing process |
| Post-merge verification (log-triage) | Notified if the error recurs | No |

## The approval message

Optimised for a phone screen and 60 seconds of attention. Everything below the fold is a link.

```
┌───────────────────────────────────────────────────────────┐
│ 🤖 Plan ready — PAY-1423                                  │
│ Add idempotency keys to refund API                        │
├───────────────────────────────────────────────────────────┤
│ Repo      payments-service    Risk  🟡 medium             │
│ Changes   4 files, ~120 lines Tests  3 new                │
│ Touches   refund write path, DB migration (additive)      │
├───────────────────────────────────────────────────────────┤
│ Approach                                                  │
│ Client-supplied UUID stored with a unique index; a repeat │
│ key returns the original refund. Rejected: server-side    │
│ hash of the payload — breaks legitimate retries with a    │
│ changed reason string.                                    │
│                                                           │
│ Assumptions                                               │
│ 1. Keys are client-generated UUIDs (comment #4)           │
│                                                           │
│ ⚠️ Requires migration deploy before app deploy            │
├───────────────────────────────────────────────────────────┤
│ [ ✅ Approve ]  [ ✏️ Changes ]  [ ❌ Reject ]  [ 📄 Full ] │
└───────────────────────────────────────────────────────────┘
```

Design rules that came out of what makes reviewers ignore these:

- **Risk, blast radius, and the migration warning are above the fold.** They are what determines whether this needs 60 seconds or 10 minutes.
- **The rejected alternative is shown.** It converts "is this right?" into "is this the better of two?", which is a much faster judgement.
- **Assumptions are visible, not buried.** The assumption is where the agent is most likely to be wrong, and the human is the only one who can tell.
- **No token counts, model names, or confidence scores.** They are on the run record for operators. They do not help a reviewer decide.

The same content goes on the ticket as a comment, so the decision can be made without leaving the tracker, and so it is preserved where the team already looks.

## Decision handling

Decisions are **asynchronous and durable**. The notifier posts and returns; the decision arrives later by webhook or CLI and is appended to the run's event log. The orchestrator resumes on the event. A restarted process loses nothing.

| Decision | Recorded | Effect |
|---|---|---|
| Approve | actor, timestamp | Plan frozen; `IMPLEMENTING` |
| Approve with edits | actor, timestamp, plan diff | Edited plan becomes the contract; the diff is a first-class eval signal |
| Request changes | actor, feedback text | Back to `PLANNING` with feedback; capped at `maxPlanRevisions` |
| Reject | actor, reason (required) | `REJECTED`; posted to the ticket; reason feeds the improvement loop |
| Snooze | actor, until | Suppressed until the timestamp (log-triage) |
| No response | — | Reminder at 50% of TTL; `EXPIRED` at TTL, analysis left on the ticket |

**Rejection reasons are a required field with a fixed taxonomy** — `wrong-approach`, `misunderstood-requirement`, `too-risky`, `already-being-done`, `not-worth-doing`, `wrong-repo-or-area`, `other`. A free-text-only reject teaches you nothing at scale; a taxonomy tells you within a week which stage is failing.

## Who approves

Resolution order:

1. Ticket assignee, if human and active
2. CODEOWNERS for the touched paths
3. Most frequent recent committer to the touched files
4. The team channel, with `@here` only for `high` severity

For log-triage `high`/`critical`, the service owner is paged directly. Everything else goes to a channel — paging a person for a medium-risk plan is how a team learns to mute the agent.

**Approver identity is verified**, not taken from the payload. Slack signature verification, then a map from the platform user to an authorised approver list. Anyone in the channel can click a button; only authorised approvers count.

## NEEDS_INFO: asking well

Bad:

> Could you clarify the requirements for this ticket?

Good:

```markdown
🤖 I need two decisions before I can plan this. Suggested defaults in bold —
reply "1: default, 2: yes" and I'll proceed.

1. **Existing refunds without idempotency keys** — backfill with generated
   keys, or leave null and only enforce on new rows?
   *Why it matters:* determines whether the migration is additive (minutes)
   or a backfill over ~2M rows (needs a maintenance window).
   *Default:* **leave null, enforce on new rows only**

2. **Duplicate key with a different payload** — return the original refund,
   or 409 Conflict?
   *Why it matters:* changes the client contract. Stripe returns the
   original; our /payments endpoint returns 409. They should probably match,
   but I can't tell which is intended.
   *Default:* **409, matching /payments**

I've read PAY-1401 (parent), the RefundService code, and the /payments
idempotency implementation. Everything else I have.
```

What makes it work: numbered so the reply can be terse, a stated default so the human can agree rather than compose, the *consequence* of each choice, and a closing line showing what was already researched — which is what stops the human assuming the agent is asking because it is lazy.

## Feedback capture

Every human touch is a labelled example:

| Signal | What it tells you |
|---|---|
| Plan approved unedited | Analysis and planning are working for this class of ticket |
| Plan edited before approval | **The most valuable signal.** The diff shows exactly what the agent missed |
| Changes requested + feedback | Named failure in planning |
| Rejected + taxonomy reason | Which stage failed, categorically |
| MR merged as-is | Implementation matched the plan |
| MR merged after review comments | Implementation gaps — comment text is the label |
| MR closed unmerged | Something upstream was wrong; correlate with the plan |
| Time-to-decision | Proxy for how readable the plan was |

These roll into the metrics in [07-evaluation.md](07-evaluation.md). Plan edits and review comments should be reviewed by a human weekly for the first few months — the patterns that appear are almost always fixable in prompts or in the evidence bundle, not in the model.

## Notification hygiene

Agents get muted, and a muted agent is a dead agent.

- **One thread per run.** Every subsequent update goes in-thread — no new top-level message per stage.
- **Quiet hours** per channel; non-urgent notifications queue.
- **Digest mode** for `observe` and `comment` autonomy: one summary post per day instead of per run.
- **No success spam.** A merged MR does not need an announcement.
- **Escalate on silence, not on volume.** One reminder at 50% of TTL, then expire.
