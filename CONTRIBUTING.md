# Contributing

## Getting set up

```bash
npm install
cp config/config.example.yaml config/config.yaml
cp .env.example .env
npm run typecheck
npm test          # 65 tests, no credentials needed
npm run dev -- run --work-item DEMO-1 --dry-run
```

Everything runs against `DryRunAgentRunner` and the in-memory connectors, so the
full pipeline is exercisable with zero credentials and zero token spend.

## Adding a provider

Five steps, and no pipeline changes:

1. Implement one interface in `src/connectors/<kind>/<provider>.ts`
   (`WorkItemSource`, `LogSource`, `CodeHost`, or `Notifier`).
2. Normalise into the domain type in [src/core/types.ts](src/core/types.ts). Keep
   the vendor payload in `raw` — it is what makes a run auditable later.
3. Register it in [src/connectors/registry.ts](src/connectors/registry.ts).
4. Add its options schema (a Zod object in the provider file) so a typo in a
   config field fails at startup rather than mid-run.
5. Add a fixture-based test. **No live credentials in tests, ever** — capture a
   real payload, redact it, and assert on the mapping.

Document the field mapping in [docs/04-connectors.md](docs/04-connectors.md).
That table is the contract, and vendor APIs move.

## Changing a prompt

Prompts are code:

1. Bump `version:` in the prompt's front matter.
2. Run the golden set ([docs/07-evaluation.md](docs/07-evaluation.md)). CI blocks
   regressions beyond the threshold.
3. Get it reviewed like a code change.

The version is stamped on every run, so evaluation results stay attributable to
an exact prompt.

## Changing a guardrail

Guardrails are enforced outside the model, and enforcement that is not tested is
decoration. Every change to [src/agent/claude-runner.ts](src/agent/claude-runner.ts)
`checkTool`/`matchesGlob`, [src/connectors/redact.ts](src/connectors/redact.ts),
or the blast-radius checks needs a test that demonstrates the *bypass* it closes.

## Design changes

If you are changing something the docs argue for — the approval gate, the
never-merge rule, where detection lives — write an ADR in
[docs/adr/](docs/adr/) rather than just changing the code. The existing ADRs
record the alternatives that were considered; superseding one should say why the
earlier reasoning no longer holds.

## Style

- Match the surrounding code. It is the same rule the agents are held to.
- `npm run typecheck` must pass; `strict` and `noUncheckedIndexedAccess` are on.
- Comments explain *why*, not *what*. The what is in the code.
