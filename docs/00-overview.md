# 00 — Overview

## The problem

An engineer's week contains a large amount of work that is *necessary, well-specified, and repetitive*:

- Reading a newly-filed story, working out what it actually means, hunting down the missing acceptance criteria, and writing an implementation plan.
- Noticing a spike of `NullReferenceException` in production logs, tracing it to a null check that was never added, writing the fix and a regression test.
- Wiring the resulting change through branch → commit → tests → merge request → linking it back to the ticket.

None of this is intellectually hard. All of it is slow, context-heavy, and easy to defer. It is also *exactly* the shape of work an agent can do: bounded, verifiable (tests exist or can be written), and reversible (a merge request is a proposal, not a deployment).

## The two agents

### 1. Ticket-to-MR

**Trigger:** a work item enters a watched state — new story, new bug, or a ticket freshly tagged `agent-ready`.

**Contract:** the agent produces either
- a **plan** for a human to approve, then an **MR** implementing that plan, or
- a **NEEDS_INFO** comment listing the specific ambiguities that block it.

The second outcome is not a failure. A ticket that cannot be planned is a ticket that a human would also have bounced back, and surfacing that within minutes of filing is worth as much as the code.

### 2. Log-Triage

**Trigger:** a log query returns a cluster above threshold — new exception fingerprint, error-rate regression, latency SLO burn.

**Contract:** the agent produces either
- a **root-cause analysis** with the evidence chain, plus a proposed fix for approval, then an **MR**, or
- an **incident note** saying it could not localise the cause, with everything it learned attached.

A correct "I could not find it, here is the evidence I gathered" is a genuinely useful output. Log-triage agents that always produce a fix are the ones that produce wrong fixes.

## Design principles

**1. Plans before patches.** Every pipeline has a hard stop at the plan stage. The plan is small, reviewable, and cheap to reject. Rejecting a plan costs a human 30 seconds; rejecting a 600-line diff costs 20 minutes.

**2. Context retrieval is the product.** The gap between a useless agent and a useful one is almost entirely how much *relevant* context reaches the model. Both pipelines have an explicit evidence-gathering stage whose output is inspectable and cacheable.

**3. Providers are configuration.** Azure DevOps and Jira differ in field names, not in concepts. The same is true of Splunk, CloudWatch Logs, and Application Insights. Normalise once at the connector boundary; the pipelines never see a provider name.

**4. Autonomy is a dial, not a switch.** Four levels — `observe`, `comment`, `propose`, `autonomous` — configured per agent and per repository. New teams start at `comment`.

**5. Everything a human would need to audit is persisted.** Each run writes a durable record: the trigger payload, the evidence bundle, the plan, the approval decision and who made it, the diff, the tool calls, the token cost. If an agent proposes something strange, you can reconstruct why.

**6. The agent gets the same tools a human gets — and no more.** It works in a git worktree, runs the repo's own test command, and reads the repo's own docs. It does not get production credentials, deploy access, or the ability to force-push.

## Explicit non-goals

| Not doing | Why |
|---|---|
| Merging its own MRs | The human review step is the last line of defence and the cheapest one. |
| Deploying, rolling back, or touching production | Blast radius is unbounded and the failure mode is silent. Log-triage *reads* telemetry; it never acts on infrastructure. |
| Editing tickets' scope, priority, or assignment | Ticket hygiene is a social process. The agent comments; humans decide. |
| Cross-repo refactors in one run | Each run targets one repository. Multi-repo changes are decomposed into linked runs, each independently approvable. |
| Replacing code review | Its MRs go through the same review as anyone's — and are labelled so reviewers know to look harder. |
| Handling security-sensitive tickets by default | Anything touching auth, crypto, payments, or PII paths is routed to `comment` mode regardless of global config. See [05-guardrails.md](05-guardrails.md). |

## What "done" looks like

The success measure is not "percentage of tickets fully automated". It is:

- **Plan acceptance rate** — of the plans it proposes, how many does a human approve with no or minor edits?
- **MR acceptance rate** — of the MRs it opens, how many merge (possibly after review feedback) versus get closed?
- **Time-to-first-plan** — how long from ticket filed to a plan sitting in the ticket?
- **Human minutes saved per accepted MR** — measured, not assumed.

These are defined and instrumented in [07-evaluation.md](07-evaluation.md). A team should be able to answer "is this worth the token spend?" from a dashboard, not a feeling.
