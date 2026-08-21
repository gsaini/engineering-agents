# 0001 — Record architecture decisions

**Status:** Accepted · 2026-08-20

## Context

This repository is primarily a design artefact. Its value is in the reasoning, not the code. Design docs describe *what* the system does; they tend to lose *why* it does it that way and what was rejected. Six months on, the rejected options get re-proposed.

## Decision

Record significant decisions as ADRs in `docs/adr/`, numbered, with the alternatives considered and the consequences accepted. Superseded ADRs are marked, not deleted.

## Consequences

- Reviewers can challenge a decision without reverse-engineering it.
- Re-litigating a settled choice requires arguing with a written trade-off.
- Small overhead per decision; only decisions with real alternatives get one.
