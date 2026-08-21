import { detectInjection, loadPrompt, render, systemPrompt, untrusted } from '../../agent/prompts.js';
import { analysisSchema, planSchema, triageSchema } from '../../agent/schemas.js';
import { newRunId, slugify, workItemIdempotencyKey } from '../../core/ids.js';
import type { Analysis, Plan, Run, SelfReview, TriageResult } from '../../core/run.js';
import { putArtefact, setMeta, transition } from '../../core/store.js';
import type { WorkItem } from '../../core/types.js';
import { ApprovalService } from '../../runtime/approvals.js';
import { invokeStage, touchesSensitivePath, type PipelineDeps } from '../context.js';
import { fail, implementStage, publishStage, verifyStage } from '../shared-stages.js';

/**
 * Ticket-to-MR.
 *
 * triage -> analyze -> plan -> [approval] -> implement -> verify -> publish
 *
 * The pipeline runs up to the approval gate and then returns. It is re-entered
 * by the orchestrator once a decision has been recorded, which is what makes a
 * days-long park at `AWAITING_APPROVAL` survivable across restarts.
 */

export interface TicketPipelineResult {
  run: Run;
  outcome: 'awaiting-approval' | 'needs-info' | 'skipped' | 'completed' | 'failed' | 'rejected';
  detail: string;
}

export async function startTicketRun(deps: PipelineDeps, item: WorkItem): Promise<Run> {
  const agentConfig = deps.config.agents.ticketToMr;
  if (!agentConfig) throw new Error('ticketToMr agent is not configured');

  return deps.store.create({
    meta: {
      runId: newRunId(),
      agent: 'ticket-to-mr',
      sourceId: item.sourceId,
      idempotencyKey: workItemIdempotencyKey(item.sourceId, item.id, item.rev),
      autonomy: agentConfig.autonomy,
      repo: null,
      branch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      promptVersions: {},
    },
    trigger: { kind: 'work-item', workItem: item },
  });
}

/** Deterministic gates. Free, so they run before any model call. */
export function preTriage(
  item: WorkItem,
  config: NonNullable<PipelineDeps['config']['agents']['ticketToMr']>,
): { pass: boolean; reason: string } {
  if (!config.workItemTypes.includes(item.rawType)) {
    return { pass: false, reason: `Work item type "${item.rawType}" is not in scope` };
  }
  const labels = item.labels.map((l) => l.toLowerCase());
  for (const deny of config.denyLabels) {
    if (labels.includes(deny.toLowerCase())) return { pass: false, reason: `Denied by label "${deny}"` };
  }
  if (config.requireLabel && !labels.includes(config.requireLabel.toLowerCase())) {
    return { pass: false, reason: `Missing required label "${config.requireLabel}"` };
  }
  if (item.assignee && !config.claimAssigned) {
    return { pass: false, reason: `Assigned to ${item.assignee}` };
  }
  return { pass: true, reason: '' };
}

export async function runToApproval(deps: PipelineDeps, run: Run): Promise<TicketPipelineResult> {
  const config = deps.config.agents.ticketToMr;
  if (!config) throw new Error('ticketToMr agent is not configured');
  if (run.trigger.kind !== 'work-item') throw new Error('runToApproval requires a work-item trigger');
  const item = run.trigger.workItem;
  const log = deps.logger.child({ runId: run.meta.runId, agent: 'ticket-to-mr', key: item.key });

  try {
    await deps.budget.assertCanContinue(run.meta.runId);

    // -------------------------------------------------------------- triage
    let current = await transition(deps.store, run, 'TRIAGING');

    const gate = preTriage(item, config);
    if (!gate.pass) {
      log.info('skipped before triage', { reason: gate.reason });
      return {
        run: await transition(deps.store, current, 'SKIPPED', 'system:triage'),
        outcome: 'skipped',
        detail: gate.reason,
      };
    }

    // Ticket text is attacker-controllable. A hit flags and downgrades; it does
    // not silently block, because a false positive costs one human glance.
    const injection = detectInjection(`${item.title}\n${item.description}`);
    if (injection.suspected) {
      current = await deps.store.append(run.meta.runId, {
        type: 'note',
        actor: 'system:guardrails',
        payload: { injectionMarkers: injection.markers },
      });
      log.warn('possible prompt injection in work item text', { markers: injection.markers });
    }

    const triagePrompt = await loadPrompt('triage');
    const system = await systemPrompt();
    const triageCall = await invokeStage<TriageResult>(deps, current, {
      stage: 'triage',
      effort: deps.config.model.effort.triage,
      toolPolicy: 'none',
      system: system.text,
      prompt: render(triagePrompt.body, {
        source_id: item.sourceId,
        work_item_key: item.key,
        work_item_type: item.rawType,
        work_item_title: item.title,
        work_item_state: item.state,
        work_item_labels: item.labels.join(', '),
        work_item_area: item.areaPath,
        work_item_description: item.description,
        work_item_acceptance_criteria: item.acceptanceCriteria,
        repo_catalogue: Object.values(config.repoMapping).join(', '),
        repo_mapping: JSON.stringify(config.repoMapping),
      }),
      schema: triageSchema,
      cwd: process.cwd(),
    });
    current = triageCall.run;

    if (!triageCall.result.ok || !triageCall.result.data) {
      return { run: await fail(deps, current, 'triage', triageCall.result.error ?? 'no result'), outcome: 'failed', detail: 'triage failed' };
    }
    const triage = triageCall.result.data;
    current = await putArtefact(deps.store, current, 'triage', triage);

    if (!triage.actionable || !triage.repo || triage.confidence < config.triageConfidenceThreshold) {
      const reason = !triage.actionable
        ? triage.reason
        : !triage.repo
          ? 'Could not resolve the work item to a configured repository'
          : `Triage confidence ${triage.confidence} below threshold ${config.triageConfidenceThreshold}`;
      log.info('skipped at triage', { reason });
      if (!deps.dryRun && deps.workItemSource && config.autonomy !== 'observe') {
        await deps.workItemSource.comment(item.id, `🤖 Not picking this up: ${reason}`);
      }
      return {
        run: await transition(deps.store, current, 'SKIPPED', 'system:triage'),
        outcome: 'skipped',
        detail: reason,
      };
    }

    current = await setMeta(deps.store, current, { repo: triage.repo }, 'system:triage');

    // ------------------------------------------------------------- analyze
    await deps.budget.assertCanContinue(run.meta.runId);
    current = await transition(deps.store, current, 'ANALYZING');

    const repo = await deps.codeHost.getRepo(triage.repo);
    const branch = `agent/${slugify(item.key)}-${slugify(item.title, 30)}`;
    const sandbox = await deps.sandboxes.create({
      runId: run.meta.runId,
      cloneUrl: repo.cloneUrl,
      repo: repo.name,
      baseBranch: repo.defaultBranch,
      branch,
    });
    current = await setMeta(deps.store, current, { branch });

    try {
      const analysisPrompt = await loadPrompt('requirement-analysis');
      const analysisCall = await invokeStage<Analysis>(deps, current, {
        stage: 'analyze',
        effort: deps.config.model.effort.analyze,
        toolPolicy: 'read-only',
        system: system.text,
        prompt: render(analysisPrompt.body, {
          source_id: item.sourceId,
          work_item_full: untrusted(item.sourceId, 'work-item', formatWorkItem(item)),
          work_item_comments: config.evidence.includeComments
            ? untrusted(item.sourceId, 'comments', formatComments(item))
            : '(comments not gathered)',
          linked_items: config.evidence.includeLinkedItems
            ? untrusted(item.sourceId, 'linked-items', item.links.map((l) => `${l.type}: ${l.key} (${l.url})`).join('\n'))
            : '(linked items not gathered)',
          repo_name: repo.name,
          base_branch: repo.defaultBranch,
          repo_conventions: '(read CONTRIBUTING.md, CLAUDE.md, AGENTS.md and docs/ in the worktree)',
          max_files_read: config.evidence.maxFilesRead,
        }),
        schema: analysisSchema,
        cwd: sandbox.path,
      });
      current = analysisCall.run;

      if (!analysisCall.result.ok || !analysisCall.result.data) {
        await sandbox.dispose();
        return { run: await fail(deps, current, 'analyze', analysisCall.result.error ?? 'no result'), outcome: 'failed', detail: 'analysis failed' };
      }
      const analysis = analysisCall.result.data;
      current = await putArtefact(deps.store, current, 'analysis', analysis);

      const blocking = analysis.openQuestions.filter((q) => q.blocking);
      if (blocking.length > 0) {
        await sandbox.dispose();
        const comment = renderQuestions(analysis, item.key);
        if (!deps.dryRun && deps.workItemSource && config.autonomy !== 'observe') {
          await deps.workItemSource.comment(item.id, comment);
        }
        log.info('needs info', { questions: blocking.length });
        return {
          run: await transition(deps.store, current, 'NEEDS_INFO', 'agent'),
          outcome: 'needs-info',
          detail: `${blocking.length} blocking question(s)`,
        };
      }

      // ---------------------------------------------------------------- plan
      await deps.budget.assertCanContinue(run.meta.runId);
      current = await transition(deps.store, current, 'PLANNING');

      const planPrompt = await loadPrompt('implementation-plan');
      const planCall = await invokeStage<Plan>(deps, current, {
        stage: 'plan',
        effort: deps.config.model.effort.plan,
        toolPolicy: 'read-only',
        system: system.text,
        prompt: render(planPrompt.body, {
          work_item_key: item.key,
          work_item_title: item.title,
          repo_name: repo.name,
          analysis_json: JSON.stringify(analysis, null, 2),
          evidence_summary: analysis.affectedAreas.map((a) => `${a.path}: ${a.why}`).join('\n'),
          max_files_changed: deps.config.guardrails.limits.maxFilesChanged,
          max_lines_changed: deps.config.guardrails.limits.maxLinesChanged,
        }),
        schema: planSchema,
        cwd: sandbox.path,
      });
      current = planCall.run;

      if (!planCall.result.ok || !planCall.result.data) {
        await sandbox.dispose();
        return { run: await fail(deps, current, 'plan', planCall.result.error ?? 'no result'), outcome: 'failed', detail: 'planning failed' };
      }
      const plan = planCall.result.data;
      current = await putArtefact(deps.store, current, 'plan', plan);

      // The worktree is not needed again until implementation; releasing it
      // means an approval parked for days does not hold disk.
      await sandbox.dispose();

      // ------------------------------------------------------------ approval
      const sensitive = touchesSensitivePath(
        plan.changes.map((c) => c.file),
        deps.config.guardrails,
      );
      const warnings: string[] = [];
      if (sensitive) warnings.push(`Touches a sensitive path (${sensitive}) — human approval required`);
      if (plan.blastRadius.deployOrderNote) warnings.push(plan.blastRadius.deployOrderNote);
      if (injection.suspected) warnings.push('Work item text contains instruction-like content — review carefully');

      current = await transition(deps.store, current, 'AWAITING_APPROVAL');

      if (config.autonomy === 'observe') {
        log.info('observe mode: plan recorded, nothing posted');
        return { run: current, outcome: 'awaiting-approval', detail: 'observe mode' };
      }

      if (deps.workItemSource && !deps.dryRun) {
        await deps.workItemSource.comment(item.id, plan.markdown);
      }
      await deps.approvals.request(current, plan, config.approvalTtlHours, warnings);

      const auto = ApprovalService.canAutoApprove(plan, triage.repo, {
        autonomy: config.autonomy,
        autonomousRepos: [],
        maxFilesChanged: deps.config.guardrails.limits.maxFilesChanged,
        maxLinesChanged: deps.config.guardrails.limits.maxLinesChanged,
        sensitiveMatch: sensitive !== null,
      });
      if (auto.allowed) {
        current = await deps.store.append(run.meta.runId, {
          type: 'artefact',
          actor: 'system:auto-approve',
          artefact: 'approval',
          payload: {
            decision: 'approve',
            actor: 'system:auto-approve',
            at: new Date().toISOString(),
            feedback: auto.reason,
            rejectionReason: null,
            editedPlanMarkdown: null,
          },
        });
      }

      return { run: current, outcome: 'awaiting-approval', detail: auto.allowed ? 'auto-approved' : 'awaiting human approval' };
    } catch (err) {
      await sandbox.dispose();
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { run: await fail(deps, run, 'pipeline', message), outcome: 'failed', detail: message };
  }
}

/** Re-entered once an approval decision has been recorded on the run. */
export async function continueAfterApproval(deps: PipelineDeps, run: Run): Promise<TicketPipelineResult> {
  const config = deps.config.agents.ticketToMr;
  if (!config) throw new Error('ticketToMr agent is not configured');
  if (run.trigger.kind !== 'work-item') throw new Error('continueAfterApproval requires a work-item trigger');

  const approval = run.artefacts.approval;
  const plan = run.artefacts.plan;
  if (!approval || !plan) return { run, outcome: 'failed', detail: 'run has no approval or plan' };

  const item = run.trigger.workItem;
  const log = deps.logger.child({ runId: run.meta.runId, key: item.key });

  if (approval.decision === 'reject') {
    if (!deps.dryRun && deps.workItemSource) {
      await deps.workItemSource.comment(item.id, `🤖 Plan rejected (${approval.rejectionReason}). Not proceeding.`);
    }
    return {
      run: await transition(deps.store, run, 'REJECTED', `user:${approval.actor}`),
      outcome: 'rejected',
      detail: approval.rejectionReason ?? 'rejected',
    };
  }
  if (approval.decision === 'request-changes') {
    return {
      run: await transition(deps.store, run, 'PLANNING', `user:${approval.actor}`),
      outcome: 'awaiting-approval',
      detail: 'changes requested',
    };
  }

  // Approve-with-edits: the human's plan replaces the agent's and becomes the
  // implementation contract.
  const frozen: Plan = approval.editedPlanMarkdown
    ? { ...plan, markdown: approval.editedPlanMarkdown }
    : plan;

  const repo = await deps.codeHost.getRepo(run.meta.repo ?? '');
  const branch = `agent/${slugify(item.key)}-${slugify(item.title, 30)}`;
  const sandbox = await deps.sandboxes.create({
    runId: run.meta.runId,
    cloneUrl: repo.cloneUrl,
    repo: repo.name,
    baseBranch: repo.defaultBranch,
    branch,
  });

  try {
    let current = await transition(deps.store, run, 'IMPLEMENTING', `user:${approval.actor}`);
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= config.maxFixAttempts; attempt += 1) {
      await deps.budget.assertCanContinue(run.meta.runId);

      const impl = await implementStage(deps, current, sandbox, frozen, {
        workItemKey: item.key,
        repoConventions: '(read the repo docs in the worktree)',
        evidenceSummary: JSON.stringify(run.artefacts.analysis?.affectedAreas ?? []),
        ...(feedback ? { feedback } : {}),
      });
      current = impl.run;

      if (impl.result.status === 'plan_invalid') {
        // The premise moved. Do not improvise — go back to planning with the
        // finding as new evidence.
        await sandbox.dispose();
        log.warn('plan invalid', { summary: impl.result.summary });
        return {
          run: await transition(deps.store, current, 'PLANNING', 'agent'),
          outcome: 'awaiting-approval',
          detail: `plan invalid: ${impl.result.summary}`,
        };
      }

      current = await transition(deps.store, current, 'VERIFYING');
      const verify = await verifyStage(deps, current, sandbox, frozen);
      current = verify.run;

      if (verify.outcome.ok) {
        current = await transition(deps.store, current, 'PUBLISHING');
        const published = await publishStage(deps, current, sandbox, frozen, {
          title: `${item.key}: ${item.title}`,
          workItemKey: item.key,
          triggerSummary: `${item.key} — ${item.title}`,
          implementationSummary: impl.result.summary,
          selfReviewSummary: summariseReview(verify.outcome.review),
          testOutput: verify.outcome.testOutput,
          reviewers: [],
          draft: config.autonomy !== 'propose',
        });
        current = published.run;

        if (!deps.dryRun && deps.workItemSource) {
          await deps.workItemSource.linkMergeRequest(item.id, published.url, item.title);
          await deps.workItemSource.comment(item.id, `🤖 Merge request opened: ${published.url}`);
        }

        await sandbox.dispose();
        return {
          run: await transition(deps.store, current, 'COMPLETED'),
          outcome: 'completed',
          detail: published.url,
        };
      }

      log.warn('verification failed', { attempt, reason: verify.outcome.reason });
      if (attempt === config.maxFixAttempts) break;
      feedback = `${verify.outcome.reason}\n\n${verify.outcome.testOutput.slice(-8000)}`;
      current = await transition(deps.store, current, 'IMPLEMENTING');
    }

    // Branch and diff are preserved so a human can pick the work up.
    await sandbox.dispose();
    return {
      run: await fail(deps, current, 'verify', `Verification failed after ${config.maxFixAttempts} attempts`),
      outcome: 'failed',
      detail: 'verification exhausted',
    };
  } catch (err) {
    await sandbox.dispose();
    const message = err instanceof Error ? err.message : String(err);
    return { run: await fail(deps, run, 'implement', message), outcome: 'failed', detail: message };
  }
}

// ---------------------------------------------------------------- rendering

function formatWorkItem(item: WorkItem): string {
  return [
    `Key: ${item.key}`,
    `Type: ${item.rawType}`,
    `State: ${item.state}`,
    `Priority: ${item.priority ?? '(none)'}`,
    `Labels: ${item.labels.join(', ') || '(none)'}`,
    `Area: ${item.areaPath ?? '(none)'}`,
    '',
    `# ${item.title}`,
    '',
    item.description,
    item.acceptanceCriteria ? `\n## Acceptance criteria\n${item.acceptanceCriteria}` : '',
    item.reproSteps ? `\n## Repro steps\n${item.reproSteps}` : '',
  ].join('\n');
}

function formatComments(item: WorkItem): string {
  if (item.comments.length === 0) return '(no comments)';
  return item.comments
    .map((c) => `[${c.createdAt}] ${c.author}:\n${c.body}`)
    .join('\n\n---\n\n');
}

/**
 * Numbered, with a stated default and the concrete consequence of each choice,
 * so a human can reply by agreeing rather than composing (docs/06).
 */
export function renderQuestions(analysis: Analysis, key: string): string {
  const blocking = analysis.openQuestions.filter((q) => q.blocking);
  const lines = [
    `🤖 I need ${blocking.length === 1 ? 'one decision' : `${blocking.length} decisions`} before I can plan ${key}.`,
    'Suggested defaults are in bold — reply "1: default, 2: yes" and I\'ll proceed.',
    '',
  ];
  blocking.forEach((q, i) => {
    lines.push(`${i + 1}. **${q.question}**`);
    lines.push(`   *Why it matters:* ${q.whyItMatters}`);
    if (q.suggestedDefault) lines.push(`   *Default:* **${q.suggestedDefault}**`);
    lines.push('');
  });
  lines.push(`I've read: ${analysis.affectedAreas.map((a) => a.path).join(', ') || 'the ticket and the repository'}.`);
  return lines.join('\n');
}

export function summariseReview(review: SelfReview | null): string {
  if (!review) return 'No self-review recorded.';
  if (review.findings.length === 0) return 'Self-review found nothing blocking.';
  return review.findings.map((f) => `- [${f.severity}] ${f.summary} (${f.file}:${f.line})`).join('\n');
}
