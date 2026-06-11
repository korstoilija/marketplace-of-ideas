# v6: The Enrichment Engine — Design

**Date:** 2026-06-11
**Status:** Approved (pending final spec review)
**Supersedes:** 2026-06-11-v5-knowledge-refinery-design.md (vault/bounties/briefs retired; cascade, diversity, budget-ledger, and quality-gate concepts carry forward re-targeted)

## Purpose

Point the system at a **folder of context** and it enriches it creatively:

- a codebase → grounded improvement suggestions
- data → analysis and hypotheses
- a task description → decomposition and approaches
- prose/notes → extensions, contradictions, connections

**The marketplace is the valuation mechanism inside the RLM, not the product.**
Prices route the engine's attention — which claims earn evidence-gathering,
which ambiguous ones earn recursive decomposition — and rank the output by
confidence. Markets are never auto-settled: price is a live signal;
`applyAdjudication` remains the only settlement path and remains human-only,
now as *optional steering* (rulings calibrate the instrument and feed GEPA,
they are not a duty the product depends on).

The product of a run is a **dossier**: a per-run output directory of ranked,
diversity-selected, provenance-labeled findings.

## Invocation & output

- `npm run mp -- <folder>` (and REPL command `enrich <path>`, and
  `POST /api/enrich {path}` for the UI). The web UI remains the live
  observatory of a run in progress.
- Output: `enrichments/<ISO-timestamp>/` inside the target folder
  (overridable with `--out`):
  - `DOSSIER.md` — ranked findings: the claim, market confidence, the best
    evidence for and against with **provenance labels** (`[target: src/x.ts:42]`
    vs `[model knowledge]`), contested items flagged as "wants your judgment".
    Findings are selected as a J(p) population (value × diversity), not top-N —
    no five variants of one insight.
  - `claims/<claimId>.md` — per-claim detail: full evidence, price history,
    verdicts, the deliberation lineage.
  - `run.json` — config, tokens/calls spent (the run reports its own
    economics), diversity profile of the finding set, metrics snapshot.

## Pipeline

```
mp <folder>
  │
  SCOUT (Tier 1, cheap model, budget-capped)
  │   classify target kind(s); inventory files (caps: ≤200 files, ≤2MB read,
  │   .gitignore- and dotfile-respecting); mine chunks into ideas + claims;
  │   embed + dedup (Z-gate) against this run's claims
  ▼
  DELIBERATION (Tier 2, existing engine, unchanged invariants)
  │   agents read the TARGET through a jailed API (below), gather evidence
  │   with provenance, evaluate, recurse on ambiguity (0.35–0.65), trade;
  │   prices route recursion; nomination queue = optional human steering
  ▼
  DOSSIER (Tier 3)
      J(p) selection over candidate findings (q=2 default); synthesis of
      DOSSIER.md via strongest available model (subscription CLI preferred);
      per-claim files + run.json written atomically
```

Budget: the existing per-run LLM-call ledger is a hard cap across ALL tiers
(scout, evaluate, recall, subAgent, synthesis). Exhaustion = clean stop,
partial dossier written and labeled partial.

## Target access — the one new security surface

The sandbox stays sealed (no fs/require/network). Agents reach the target
exclusively through two injected, host-implemented functions:

- `target.list(glob?)` → relative paths (respects .gitignore; skips dotfiles,
  `.git/`, binaries, files > 1MB)
- `target.read(path, offset?, maxBytes?)` → text chunk, hard cap 32KB/read

Jail rules (`src/engine/target.ts`, fully unit-tested):
1. Root-jail by `realpath` prefix check on BOTH the root and the resolved
   candidate — symlinks pointing outside the root are refused.
2. Read-only. No write, no exec, ever.
3. Per-iteration read budget (count + bytes) charged to the ledger; exceeding
   it throws the same survivable error pattern as other budget caps.
4. Every read is recorded in the agent's transcript (observability of what
   agents actually looked at).
5. Default deny-list even inside the root: `.env*`, `*.pem`, `*.key`,
   `id_rsa*`, credential-looking files.

`recall()` is unchanged: model knowledge, labeled as such in evidence
provenance. Target reads are the grounded evidence channel; recall is the
ungrounded one; the dossier shows which is which.

## Real embeddings (replacing the hash stub)

- `src/diversity/embed.ts` is rewritten around a real local embedding model
  (exact package pinned at plan time by a live probe, same discipline as the
  CLI probes; requirement: local, no per-call API cost).
- The **paraphrase guard test is mandatory and blocking**: paraphrase pairs ≥
  threshold similarity, unrelated pairs ≤ threshold. If the model can't pass
  it, the build fails — Z is load-bearing for dedup and dossier selection,
  and a fake Z (the hash stub) must be structurally impossible to reintroduce.
- Embeddings persist in the existing `embeddings` table (embed once per text).
- If the embedding model fails to load at runtime, enrichment refuses to run
  (no silent "everything is novel" fallback).

## What carries forward unchanged

Engine (RlmAgent/sandbox/harness/budget), store + human-only settlement,
graded adjudication + GEPA on human rulings, web UI as observatory, REPL,
metrics, transcripts (now actually persisting), CLI traders, the structural
quality gate (`npm run kiss`, clamp-then-ratchet — still to be built, lands in
foundations).

## What dies with v5

Vault, creation bounties, briefs-as-home, riff compiler as a product surface
(the riff endpoint may remain as a cheap way to bulk-steer, but it is not in
this spec's scope), watched sources/inbox, any scheduler.

## Error handling

- Nonexistent/empty/unreadable target → clear CLI error, no run record.
- Scout finds nothing claim-worthy → honest empty dossier ("nothing
  contestable found"), not fabricated findings.
- Tier-2 session failure → dossier from Tier-1 material, findings labeled
  `un-deliberated`.
- Jail violations → survivable per-iteration errors for the agent, loud lines
  in the transcript; three violations in one run = agent parked.
- Dossier writes atomic (tmp + rename); a crashed run leaves no half-dossier.

## Testing

- Jail: traversal (`../`), absolute paths, symlink-out, deny-list, size caps,
  read-budget exhaustion — all refused; in-root reads succeed. No LLM needed.
- Embeddings: paraphrase guard (blocking), persistence round-trip.
- Scout: fixture folders (tiny codebase / CSV / task.md) → expected claim
  kinds, caps respected, budget charged — with a stub LLM.
- Dossier: stub deliberation record → DOSSIER.md structure, provenance labels
  present, J(p) selection prefers diverse set over redundant higher-sum set
  (constructed fixture), atomic write.
- End-to-end live (key-gated): `mp` on a small fixture repo produces a dossier
  with ≥1 target-grounded finding.
- Suite stays green at every task (it finally is — 101/101); kiss gate runs
  per task once built.

## Build order (phases of one implementation plan)

1. **Foundations:** real embeddings + paraphrase guard; jailed target API +
   jail test battery; kiss gate (clamped). 
2. **Pipeline:** scout, enrich orchestration (reusing runSession with
   `context` injection), dossier writer + J(p) selection.
3. **Surface:** `mp` CLI entry + REPL `enrich` + `POST /api/enrich` + minimal
   UI affordance (run progress + link to output path).

## Out of scope

Autonomy/scheduling; web sources; vault/bounty economics; sell-side market;
writeCode meta-loop (the lineage substrate exists when it's wanted); multi-user;
non-local targets (URLs, remote repos).
