import { loadPrompt, render, systemPrompt, untrusted } from '../../agent/prompts.js';
import { planSchema, rootCauseSchema } from '../../agent/schemas.js';
import type { LogSource } from '../../connectors/logs/types.js';
import { runMarker } from '../../connectors/scm/types.js';
import { logSignalIdempotencyKey, newRunId, slugify } from '../../core/ids.js';
import type { Plan, RootCause, Run } from '../../core/run.js';
import { putArtefact, transition, type RunStore } from '../../core/store.js';
import type { LogEvidence, LogSignal, TimeWindow } from '../../core/types.js';
import { ApprovalService } from '../../runtime/approvals.js';
import { invokeStage, touchesSensitivePath, type PipelineDeps } from '../context.js';
import { fail, implementStage, publishStage, verifyStage } from '../shared-stages.js';
import { summariseReview } from '../ticket-to-mr/pipeline.js';

/**
 * Log-Triage.
 *
 * detect -> suppress -> gather -> rootCause -> proposeFix -> [approval]
 *   -> implement -> verify -> publish
 *
 * The hard part is not the fix. It is deciding there is something to fix, and
 * not being wrong about why.
 */

export interface SuppressionState {
  /** Fingerprints seen in the novelty lookback window. */
  seenFingerprints: Set<string>;
  runsStartedThisHour: number;
}

export interface SuppressionDecision {
  suppress: boolean;
  reason: string;
}

/**
 * Suppression.
 *
 * Outages produce correlated errors across dozens of fingerprints. Without this,
 * the agent's first real incident is also the incident where it opens thirty
 * merge requests.
 */
export async function shouldSuppress(
  signal: LogSignal,
  config: NonNullable<PipelineDeps['config']['agents']['logTriage']>,
  store: RunStore,
  state: SuppressionState,
  now = new Date(),
): Promise<SuppressionDecision> {
  if (signal.count < config.detection.minOccurrences) {
    return { suppress: true, reason: `Below the occurrence threshold (${signal.count} < ${config.detection.minOccurrences})` };
  }
  if (
    config.detection.minAffectedUsers > 0 &&
    signal.affectedUsers !== null &&
    signal.affectedUsers < config.detection.minAffectedUsers
  ) {
    return { suppress: true, reason: `Below the affected-user floor (${signal.affectedUsers})` };
  }

  const known = config.suppression.knownIssues.find((k) => k.fingerprint === signal.fingerprint);
  if (known && known.expires > now) {
    return { suppress: true, reason: `Known issue: ${known.reason} (expires ${known.expires.toISOString().slice(0, 10)})` };
  }

  if (config.detection.mode === 'new-fingerprint' && state.seenFingerprints.has(signal.fingerprint)) {
    return { suppress: true, reason: 'Fingerprint is not novel in the lookback window' };
  }

  const key = logSignalIdempotencyKey(signal.sourceId, signal.fingerprint, signal.firstSeen);
  if (await store.findByIdempotencyKey(key)) {
    return { suppress: true, reason: 'A run already exists for this signal window' };
  }

  const openRuns = await store.list({ agent: 'log-triage' });
  const active = openRuns.find(
    (r) =>
      r.trigger.kind === 'log-signal' &&
      r.trigger.signal.fingerprint === signal.fingerprint &&
      !['COMPLETED', 'REJECTED', 'FAILED', 'SKIPPED', 'EXPIRED', 'CANCELLED'].includes(r.state),
  );
  if (active) return { suppress: true, reason: `Run ${active.meta.runId} is already handling this fingerprint` };

  if (state.runsStartedThisHour >= config.suppression.maxNewRunsPerHour) {
    return { suppress: true, reason: `Hourly run cap reached (${config.suppression.maxNewRunsPerHour})` };
  }

  return { suppress: false, reason: '' };
}

export async function detectSignals(
  source: LogSource,
  windowMinutes: number,
  now = new Date(),
): Promise<{ signals: LogSignal[]; window: TimeWindow }> {
  const window: TimeWindow = {
    from: new Date(now.getTime() - windowMinutes * 60_000).toISOString(),
    to: now.toISOString(),
  };
  return { signals: await source.detect(window), window };
}

export async function startLogRun(deps: PipelineDeps, signal: LogSignal): Promise<Run> {
  const config = deps.config.agents.logTriage;
  if (!config) throw new Error('logTriage agent is not configured');
  return deps.store.create({
    meta: {
      runId: newRunId(),
      agent: 'log-triage',
      sourceId: signal.sourceId,
      idempotencyKey: logSignalIdempotencyKey(signal.sourceId, signal.fingerprint, signal.firstSeen),
      autonomy: config.autonomy,
      repo: config.serviceRepoMapping[signal.service] ?? null,
      branch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      promptVersions: {},
    },
    trigger: { kind: 'log-signal', signal },
  });
}

export interface LogPipelineResult {
  run: Run;
  outcome: 'awaiting-approval' | 'incident-note' | 'skipped' | 'completed' | 'failed' | 'rejected';
  detail: string;
}

export async function runToApproval(deps: PipelineDeps, run: Run): Promise<LogPipelineResult> {
  const config = deps.config.agents.logTriage;
  if (!config) throw new Error('logTriage agent is not configured');
  if (run.trigger.kind !== 'log-signal') throw new Error('runToApproval requires a log-signal trigger');
  const signal = run.trigger.signal;
  const log = deps.logger.child({ runId: run.meta.runId, agent: 'log-triage', fingerprint: signal.fingerprint });

  try {
    await deps.budget.assertCanContinue(run.meta.runId);
    let current = await transition(deps.store, run, 'TRIAGING');

    const repoName = config.serviceRepoMapping[signal.service];
    if (!repoName) {
      const reason = `No repository mapped for service "${signal.service}"`;
      log.info('skipped', { reason });
      return { run: await transition(deps.store, current, 'SKIPPED', 'system:triage'), outcome: 'skipped', detail: reason };
    }

    // ----------------------------------------------------- gather evidence
    current = await transition(deps.store, current, 'ANALYZING');
    if (!deps.logSource) throw new Error('log source is required for the log-triage pipeline');

    const evidence = await deps.logSource.gather(signal, {
      maxSamples: 10,
      precedingEventLimit: 40,
      includeDependencyErrors: true,
    });
    current = await putArtefact(deps.store, current, 'evidence', evidence);

    const repo = await deps.codeHost.getRepo(repoName);
    const branch = `agent/incident-${signal.fingerprint.slice(0, 8)}-${slugify(signal.exceptionType ?? 'error', 24)}`;
    const sandbox = await deps.sandboxes.create({
      runId: run.meta.runId,
      cloneUrl: repo.cloneUrl,
      repo: repo.name,
      baseBranch: repo.defaultBranch,
      branch,
    });

    try {
      // -------------------------------------------------------- root cause
      const system = await systemPrompt();
      const rcaPrompt = await loadPrompt('log-root-cause');
      const rcaCall = await invokeStage<RootCause>(deps, current, {
        stage: 'rootCause',
        effort: deps.config.model.effort.rootCause,
        toolPolicy: 'read-only',
        system: system.text,
        prompt: render(rcaPrompt.body, {
          source_id: signal.sourceId,
          signal_summary: formatSignal(signal),
          sample_events: untrusted(signal.sourceId, 'log-events', formatSamples(evidence)),
          timeline: evidence.timeline.map((t) => `${t.bucket}: ${t.count}`).join('\n'),
          blast_summary: `users=${evidence.blast.affectedUsers ?? 'unknown'} requests=${evidence.blast.affectedRequests ?? 'unknown'}`,
          spread_summary: `versions=[${evidence.spread.versions.join(', ')}] hosts=[${evidence.spread.hosts.join(', ')}] regions=[${evidence.spread.regions.join(', ')}]`,
          correlations: evidence.correlations.map((c) => `${c.timestamp} ${c.reference}: ${c.description}`).join('\n'),
          preceding_events: untrusted(signal.sourceId, 'preceding-events', evidence.precedingEvents.map((e) => `${e.timestamp} ${e.message}`).join('\n')),
          dependency_errors: evidence.dependencyErrors.map((e) => e.message).join('\n'),
          repo_name: repo.name,
          base_branch: repo.defaultBranch,
          frame_mapping: signal.topFrames.join('\n'),
          rca_confidence_threshold: config.rcaConfidenceThreshold,
        }),
        schema: rootCauseSchema,
        cwd: sandbox.path,
      });
      current = rcaCall.run;

      if (!rcaCall.result.ok || !rcaCall.result.data) {
        await sandbox.dispose();
        return { run: await fail(deps, current, 'rootCause', rcaCall.result.error ?? 'no result'), outcome: 'failed', detail: 'RCA failed' };
      }
      const rca = rcaCall.result.data;
      current = await putArtefact(deps.store, current, 'rootCause', rca);

      // Low confidence, or not a code issue: the incident note *is* the output.
      // A human gets a head start, which is most of the value even when the
      // agent cannot close it.
      if (rca.notACodeIssue || rca.confidence < config.rcaConfidenceThreshold) {
        await sandbox.dispose();
        const note = renderIncidentNote(signal, rca, evidence);
        if (!deps.dryRun && config.autonomy !== 'observe') {
          await deps.notifier.notify({
            runId: run.meta.runId,
            threadKey: run.meta.runId,
            title: `Incident note — ${signal.title}`,
            body: note,
            severity: rca.severity === 'critical' || rca.severity === 'high' ? 'urgent' : 'info',
            links: signal.dashboardUrl ? [{ label: 'Dashboard', url: signal.dashboardUrl }] : [],
          });
        }
        log.info('incident note only', { confidence: rca.confidence, notACodeIssue: rca.notACodeIssue });
        return {
          run: await transition(deps.store, current, 'SKIPPED', 'agent'),
          outcome: 'incident-note',
          detail: rca.notACodeIssue ? 'not a code issue' : `confidence ${rca.confidence}`,
        };
      }

      if (config.fixClasses.neverPropose.includes(rca.category)) {
        await sandbox.dispose();
        return {
          run: await transition(deps.store, current, 'SKIPPED', 'system:policy'),
          outcome: 'incident-note',
          detail: `Fix class "${rca.category}" is never auto-proposed`,
        };
      }

      // -------------------------------------------------------- propose fix
      await deps.budget.assertCanContinue(run.meta.runId);
      current = await transition(deps.store, current, 'PLANNING');

      const fixPrompt = await loadPrompt('fix-proposal');
      const planCall = await invokeStage<Plan>(deps, current, {
        stage: 'plan',
        effort: deps.config.model.effort.plan,
        toolPolicy: 'read-only',
        system: system.text,
        prompt: render(fixPrompt.body, {
          root_cause_json: JSON.stringify(rca, null, 2),
          repo_name: repo.name,
          auto_propose_classes: config.fixClasses.autoPropose.join(', '),
          flag_only_classes: config.fixClasses.flagOnly.join(', '),
          verification_window_hours: config.verificationWindowHours,
        }),
        schema: planSchema,
        cwd: sandbox.path,
      });
      current = planCall.run;

      if (!planCall.result.ok || !planCall.result.data) {
        await sandbox.dispose();
        return { run: await fail(deps, current, 'plan', planCall.result.error ?? 'no result'), outcome: 'failed', detail: 'fix proposal failed' };
      }
      const plan = planCall.result.data;
      current = await putArtefact(deps.store, current, 'plan', plan);
      await sandbox.dispose();

      // ---------------------------------------------------------- approval
      const sensitive = touchesSensitivePath(plan.changes.map((c) => c.file), deps.config.guardrails);
      const warnings: string[] = [`${signal.count} occurrences since ${signal.firstSeen}`];
      if (sensitive) warnings.push(`Touches a sensitive path (${sensitive}) — human approval required`);
      if (config.fixClasses.flagOnly.includes(rca.category)) {
        warnings.push(`Fix class "${rca.category}" is flag-only — never auto-approved`);
      }
      if (plan.blastRadius.deployOrderNote) warnings.push(plan.blastRadius.deployOrderNote);

      current = await transition(deps.store, current, 'AWAITING_APPROVAL');

      if (config.autonomy === 'observe') {
        return { run: current, outcome: 'awaiting-approval', detail: 'observe mode' };
      }
      await deps.approvals.request(current, plan, config.approvalTtlHours, warnings);

      const auto = ApprovalService.canAutoApprove(plan, repoName, {
        autonomy: config.autonomy,
        autonomousRepos: [],
        maxFilesChanged: deps.config.guardrails.limits.maxFilesChanged,
        maxLinesChanged: deps.config.guardrails.limits.maxLinesChanged,
        sensitiveMatch: sensitive !== null || config.fixClasses.flagOnly.includes(rca.category),
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

export async function continueAfterApproval(deps: PipelineDeps, run: Run): Promise<LogPipelineResult> {
  const config = deps.config.agents.logTriage;
  if (!config) throw new Error('logTriage agent is not configured');
  if (run.trigger.kind !== 'log-signal') throw new Error('continueAfterApproval requires a log-signal trigger');

  const approval = run.artefacts.approval;
  const plan = run.artefacts.plan;
  const rca = run.artefacts.rootCause;
  if (!approval || !plan || !rca) return { run, outcome: 'failed', detail: 'run is missing approval, plan, or root cause' };

  const signal = run.trigger.signal;
  if (approval.decision === 'reject') {
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

  const frozen: Plan = approval.editedPlanMarkdown ? { ...plan, markdown: approval.editedPlanMarkdown } : plan;
  const repo = await deps.codeHost.getRepo(run.meta.repo ?? '');
  const branch = `agent/incident-${signal.fingerprint.slice(0, 8)}-${slugify(signal.exceptionType ?? 'error', 24)}`;
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
        workItemKey: `incident-${signal.fingerprint.slice(0, 8)}`,
        repoConventions: '(read the repo docs in the worktree)',
        evidenceSummary: rca.hypothesis,
        ...(feedback ? { feedback } : {}),
      });
      current = impl.run;

      if (impl.result.status === 'plan_invalid') {
        await sandbox.dispose();
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
          title: `fix: ${signal.exceptionType ?? 'production error'} in ${signal.service}`,
          workItemKey: null,
          triggerSummary: formatSignal(signal),
          implementationSummary: impl.result.summary,
          selfReviewSummary: summariseReview(verify.outcome.review),
          testOutput: verify.outcome.testOutput,
          reviewers: [],
          draft: config.autonomy !== 'propose',
        });
        current = published.run;
        await sandbox.dispose();

        deps.logger.info('log-triage merge request opened', {
          runId: run.meta.runId,
          url: published.url,
          marker: runMarker(run.meta.runId),
        });

        // The fingerprint now enters the post-merge watch window: if it
        // reappears within verificationWindowHours, the run is reopened as
        // FIX_INEFFECTIVE. Confirming a fix worked is part of the job.
        return {
          run: await transition(deps.store, current, 'COMPLETED'),
          outcome: 'completed',
          detail: published.url,
        };
      }

      if (attempt === config.maxFixAttempts) break;
      feedback = `${verify.outcome.reason}\n\n${verify.outcome.testOutput.slice(-8000)}`;
      current = await transition(deps.store, current, 'IMPLEMENTING');
    }

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

function formatSignal(signal: LogSignal): string {
  return [
    `${signal.title}`,
    `Service: ${signal.service} (${signal.environment})`,
    `Fingerprint: ${signal.fingerprint}`,
    `Occurrences: ${signal.count}${signal.affectedUsers !== null ? `, affected users: ${signal.affectedUsers}` : ''}`,
    `First seen: ${signal.firstSeen}  Last seen: ${signal.lastSeen}`,
    `Versions: ${signal.versions.join(', ') || 'unknown'}`,
    `Detection query: ${signal.query}`,
  ].join('\n');
}

function formatSamples(evidence: LogEvidence): string {
  return evidence.signal.sampleEvents
    .map((e, i) => `--- sample ${i + 1} (${e.timestamp}) ---\n${e.message}\n${e.stackTrace ?? '(no stack trace)'}`)
    .join('\n\n');
}

/** The output when the agent cannot close the loop — still worth a lot. */
export function renderIncidentNote(signal: LogSignal, rca: RootCause, evidence: LogEvidence): string {
  const lines = [
    `🤖 **${signal.title}**`,
    '',
    `${signal.count} occurrences since ${signal.firstSeen} in ${signal.service} (${signal.environment}).`,
    '',
  ];
  if (rca.notACodeIssue) {
    lines.push('**This does not look like a code issue.**', '', rca.hypothesis, '');
  } else {
    lines.push(
      `**Best hypothesis** (confidence ${rca.confidence.toFixed(2)} — below the threshold to propose a fix)`,
      '',
      rca.hypothesis,
      '',
    );
  }
  lines.push('**Evidence**');
  for (const link of rca.evidenceChain) lines.push(`- ${link.claim} — _${link.evidence}_`);
  if (rca.alternativeHypotheses.length > 0) {
    lines.push('', '**Alternatives considered**');
    for (const alt of rca.alternativeHypotheses) lines.push(`- ${alt.hypothesis} — ${alt.whyLessLikely}`);
  }
  lines.push(
    '',
    `**Spread:** versions ${evidence.spread.versions.join(', ') || 'unknown'}; hosts ${evidence.spread.hosts.length || 'unknown'}`,
    `**Reproduction:** ${rca.reproduction || 'not established'}`,
    '',
    'No fix proposed. Handing over with the evidence above.',
  );
  return lines.join('\n');
}
