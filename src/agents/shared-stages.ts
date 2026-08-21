import { loadPrompt, render, systemPrompt } from '../agent/prompts.js';
import { implementationSchema, selfReviewSchema } from '../agent/schemas.js';
import { containsSecret } from '../connectors/redact.js';
import { AGENT_LABEL, runMarker } from '../connectors/scm/types.js';
import type { ImplementationResult, Plan, Run, SelfReview } from '../core/run.js';
import { putArtefact, transition } from '../core/store.js';
import type { Sandbox } from '../runtime/sandbox.js';
import { checkBlastRadius, invokeStage, type PipelineDeps } from './context.js';

/**
 * Implement, verify, and publish.
 *
 * Shared by both agents: once there is an approved plan naming a repo and a set
 * of files, "make the change and open an MR" is identical work regardless of
 * what triggered it.
 */

export class StageFailure extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = 'StageFailure';
  }
}

export async function implementStage(
  deps: PipelineDeps,
  run: Run,
  sandbox: Sandbox,
  plan: Plan,
  context: { workItemKey: string; repoConventions: string; evidenceSummary: string; feedback?: string },
): Promise<{ run: Run; result: ImplementationResult }> {
  const prompt = await loadPrompt('implementation');
  const system = await systemPrompt();
  const repo = await deps.codeHost.getRepo(run.meta.repo ?? '');

  const body = render(prompt.body, {
    approved_plan: plan.markdown,
    repo_name: repo.name,
    branch_name: sandbox.branch,
    test_command: repo.testCommand,
    build_command: repo.buildCommand,
    evidence_summary: context.evidenceSummary,
    repo_conventions: context.repoConventions,
    work_item_key: context.workItemKey,
  });

  const withFeedback = context.feedback
    ? `${body}\n\n## Previous attempt failed\n\n${context.feedback}\n\nFix the cause, do not weaken the tests.`
    : body;

  const { result, run: afterCost } = await invokeStage<ImplementationResult>(deps, run, {
    stage: 'implement',
    effort: deps.config.model.effort.implement,
    toolPolicy: 'read-write',
    system: system.text,
    prompt: withFeedback,
    schema: implementationSchema,
    cwd: sandbox.path,
  });

  if (!result.ok || !result.data) {
    throw new StageFailure('implement', result.error ?? 'implementation stage produced no result');
  }

  const next = await putArtefact(deps.store, afterCost, 'implementation', result.data);
  return { run: next, result: result.data };
}

export interface VerifyOutcome {
  ok: boolean;
  reason: string;
  review: SelfReview | null;
  testOutput: string;
  diffStat: { files: string[]; lines: number };
}

/**
 * Four checks, all recorded: build and tests, plan conformance, blast radius,
 * and a blind self-review.
 *
 * The self-review is given only the diff and the plan — never the
 * implementation transcript, which contains the reasoning that produced any bug
 * and so reproduces the blind spot.
 */
export async function verifyStage(
  deps: PipelineDeps,
  run: Run,
  sandbox: Sandbox,
  plan: Plan,
): Promise<{ run: Run; outcome: VerifyOutcome }> {
  const repo = await deps.codeHost.getRepo(run.meta.repo ?? '');
  const diffStat = await sandbox.diffStat();

  // 1. Secret scan before anything else. A committed key costs more than the
  //    agent has ever saved.
  const diff = await sandbox.diff();
  const secrets = containsSecret(diff);
  if (secrets.found) {
    return {
      run: await deps.store.append(run.meta.runId, {
        type: 'error',
        actor: 'system:guardrails',
        payload: { stage: 'verify', message: `Secret detected in diff: ${secrets.kinds.join(', ')}` },
      }),
      outcome: {
        ok: false,
        reason: `Secret detected in diff (${secrets.kinds.join(', ')})`,
        review: null,
        testOutput: '',
        diffStat,
      },
    };
  }

  // 2. Blast radius versus the approved plan.
  const blast = checkBlastRadius(diffStat, plan.blastRadius, deps.config.guardrails);
  if (!blast.ok) {
    return { run, outcome: { ok: false, reason: blast.reason, review: null, testOutput: '', diffStat } };
  }

  // 3. Build and tests, using the repo's own commands.
  let testOutput = '';
  if (repo.buildCommand) {
    const build = await sandbox.run(repo.buildCommand);
    testOutput += `$ ${repo.buildCommand}\n${build.stdout}\n${build.stderr}\n`;
    if (build.code !== 0) {
      return { run, outcome: { ok: false, reason: 'Build failed', review: null, testOutput, diffStat } };
    }
  }
  if (repo.testCommand) {
    const tests = await sandbox.run(repo.testCommand);
    testOutput += `$ ${repo.testCommand}\n${tests.stdout}\n${tests.stderr}\n`;
    if (tests.code !== 0) {
      return { run, outcome: { ok: false, reason: 'Tests failed', review: null, testOutput, diffStat } };
    }
  }

  // 4. Blind self-review.
  const prompt = await loadPrompt('self-review');
  const system = await systemPrompt();
  const { result, run: afterCost } = await invokeStage<SelfReview>(deps, run, {
    stage: 'verify',
    effort: deps.config.model.effort.verify,
    toolPolicy: 'read-only',
    system: system.text,
    prompt: render(prompt.body, {
      approved_plan: plan.markdown,
      diff: truncate(diff, 120_000),
      test_output: truncate(testOutput, 20_000),
      repo_name: repo.name,
    }),
    schema: selfReviewSchema,
    cwd: sandbox.path,
  });

  if (!result.ok || !result.data) {
    throw new StageFailure('verify', result.error ?? 'self-review produced no result');
  }

  const review = result.data;
  const withReview = await putArtefact(deps.store, afterCost, 'selfReview', review);
  const blocking = review.findings.filter((f) => f.severity === 'blocking');

  return {
    run: withReview,
    outcome: {
      ok: blocking.length === 0 && review.verdict === 'ready' && review.planConformance.followed,
      reason:
        blocking.length > 0
          ? `${blocking.length} blocking finding(s) in self-review`
          : review.planConformance.followed
            ? ''
            : `Plan not followed: missing ${review.planConformance.missing.join(', ')}`,
      review,
      testOutput,
      diffStat,
    },
  };
}

export async function publishStage(
  deps: PipelineDeps,
  run: Run,
  sandbox: Sandbox,
  plan: Plan,
  context: {
    title: string;
    workItemKey: string | null;
    triggerSummary: string;
    implementationSummary: string;
    selfReviewSummary: string;
    testOutput: string;
    reviewers: string[];
    draft: boolean;
  },
): Promise<{ run: Run; url: string }> {
  const repo = await deps.codeHost.getRepo(run.meta.repo ?? '');
  const prompt = await loadPrompt('mr-description');
  const system = await systemPrompt();

  const { result, run: afterCost } = await invokeStage<string>(deps, run, {
    stage: 'publish',
    effort: deps.config.model.effort.publish,
    toolPolicy: 'none',
    system: system.text,
    prompt: render(prompt.body, {
      trigger_summary: context.triggerSummary,
      approved_plan: plan.markdown,
      implementation_summary: context.implementationSummary,
      self_review_summary: context.selfReviewSummary,
      test_output: truncate(context.testOutput, 8_000),
      run_id: run.meta.runId,
      plan_link: '(attached to the run record)',
      work_item_link: context.workItemKey ?? '(none)',
    }),
    cwd: sandbox.path,
  });

  const description = `${result.text || plan.markdown}\n\n${runMarker(run.meta.runId)}`;

  if (deps.dryRun) {
    deps.logger.info('dry run: skipping push and merge request', { runId: run.meta.runId });
    const url = `dry-run://${repo.name}/${sandbox.branch}`;
    // Still recorded, so a dry run produces a complete, inspectable record.
    return { run: await putArtefact(deps.store, afterCost, 'mergeRequestUrl', url), url };
  }

  // Push is restricted to this run's own branch — enforced here rather than
  // trusted to the agent.
  await sandbox.git('push', '--set-upstream', 'origin', sandbox.branch);

  const mr = await deps.codeHost.openMergeRequest({
    repo: repo.name,
    sourceBranch: sandbox.branch,
    targetBranch: repo.defaultBranch,
    title: context.title,
    description,
    draft: context.draft,
    labels: [AGENT_LABEL],
    ...(context.workItemKey ? { workItemKey: context.workItemKey } : {}),
    reviewers: context.reviewers,
  });

  const next = await putArtefact(deps.store, afterCost, 'mergeRequestUrl', mr.url);
  return { run: next, url: mr.url };
}

export async function fail(deps: PipelineDeps, run: Run, stage: string, message: string): Promise<Run> {
  const withError = await deps.store.append(run.meta.runId, {
    type: 'error',
    actor: 'agent',
    payload: { stage, message },
  });
  deps.logger.error('run failed', { runId: run.meta.runId, stage, message });
  return transition(deps.store, withError, 'FAILED', 'system:orchestrator');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}
