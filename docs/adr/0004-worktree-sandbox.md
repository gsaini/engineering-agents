# 0004 — Git worktree per run as the sandbox

**Status:** Accepted · 2026-08-20

## Context

The agent needs to read a repository, edit files, and run tests. Concurrent runs must not collide. A run that goes wrong must not damage anything outside itself. Options:

1. **Shared checkout with branch switching.** Simple; breaks immediately under concurrency and leaks state between runs.
2. **Full clone per run.** Isolated, but slow and disk-hungry on large repos.
3. **Container per run.** Strongest isolation; requires a container runtime everywhere the agent runs, plus image maintenance per repo toolchain.
4. **Git worktree per run** from a shared bare clone.

## Decision

A git worktree per run at `.worktrees/<runId>`, cut from a cached bare clone at the target base branch. The agent's `cwd` is the worktree and nothing else is reachable. The worktree is removed on terminal state; orphans past TTL are reaped at startup.

Containers remain the right answer where untrusted test execution is a concern, and the interface is drawn so a `ContainerSandbox` can replace `WorktreeSandbox` without touching the pipelines.

## Consequences

- Cheap: worktree creation is near-instant against a warm bare clone, versus a full clone per run.
- Concurrency-safe by construction.
- Cleanup is trivial and auditable.
- **Isolation is filesystem-scoped, not process-scoped.** Running the repo's test command executes repo code with the agent's OS-level privileges. This is mitigated by command allowlisting, network denial, and resource caps — but it is not equivalent to a container. Repos with untrusted contributors should use the container sandbox.
- Requires git ≥ 2.5 and disk for concurrent worktrees.
