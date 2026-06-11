# v5: The Knowledge Refinery — Design

**Date:** 2026-06-11
**Status:** SUPERSEDED by 2026-06-11-v6-enrichment-engine-design.md
**Supersedes the framing of:** 2026-06-10-marketplace-of-ideas-ax-design.md (the machinery it describes remains; its goal statement is revised here)

## Purpose — the inversion

The system exists to **produce and curate knowledge for the human**, not to collect
rulings from him. Ruling claims is a tool. The product is the **vault**: a growing,
git-tracked body of knowledge that survived agent deliberation *and* his explicit
acceptance. The signal flows both ways, but the primary arrow points at him: each
run must hand him something richer than what went in — briefs worth reading on
their own merits. His judgment is captured as a **byproduct of editorial
engagement** (reading, cutting, riffing, accepting), never as a docket of chores.

Two failures this design explicitly guards against, named during brainstorming:

1. **The token burner / slop generator.** A system that spends 500k tokens to
   produce three mediocre briefs trains its user to ignore it. Every token must
   terminate in something he reads or measurably improve something he reads.
2. **The consensus engine.** A pure prediction market pays for calibration, not
   creation — run long enough it converges and produces nothing. The economy must
   pay for *novel accepted value*.

## Theoretical core (Leinster, arXiv 2012.02113)

Creativity is effective variety under a similarity relation. The system optimizes,
per run, the population objective:

```
J(p) = E[V(x)]  +  λ · log D_q^Z(p)  −  β · (incoherence penalty)
```

- **V(x)** — the human's graded editorial judgment (acceptance confidence,
  survival of his cuts). The scarce resource; everything else economizes it.
- **D_q^Z(p)** — similarity-sensitive Hill diversity: with similarity matrix Z
  (embedding cosine) and abundance p, `(Zp)_i = Σ_j Z_ij p_j` and
  `D_q^Z(p) = (Σ_i p_i (Zp)_i^(q−1))^(1/(1−q))` (q≠1; q=1 is the exp-entropy
  limit). Near-duplicates count less. q is a real dial: q=0 counts every mode,
  q=2 punishes redundancy (default for payouts), the profile across
  q ∈ {0, 1, 2, ∞} is an observability metric.
- **The β term** is implemented as gates, not math: Tier-1 coherence screening
  and output caps. Novelty that drifts from competence is trash, not creativity.

Known failure modes, designed against explicitly: bad Z makes style variation
look creative (mitigation: embedding-quality test in the plan; Z from semantic
embeddings, not lexical); bad V makes cliché score high (V is human-only); high
λ yields novelty trash (coherence gate); single-q hides mode collapse (profile
across q in metrics).

## Decisions

| Decision | Choice |
|---|---|
| Primary judgment channel | Freeform riff → agent-compiled ghost interpretations → one-pass batch confirm |
| Ruling shape | Graded: `confidence` (0–1) + optional `reason` text; binary retired |
| The vault | Git-tracked `vault/` markdown; prose-first briefs, market data as appendix |
| Vault entry condition | Deliberated + **explicit human accept** — nothing crosses autonomously |
| Economics | Creation bounties at the vault gate, weighted by marginal diversity, split along idea lineage; prediction market demoted to quality gate / attention router |
| Similarity Z | Local embedding model (no API spend for Z); one module powers dedup, bounties, curation, metrics |
| Pipeline shape | Escalation cascade: free scan → cheap decompose+gate → market (exception) → synthesis (capped) |
| Sources | `inbox/` drop dir + watched source repos, processed **on demand** |
| Autonomy | **Deferred.** Lean core first; the nightly daemon is a later cron line on proven machinery |
| Cut from scope | Vault self-generation, forced-evaluation template, `search()` as-is, TUI work |
| Prerequisites folded in | Fix-list items 1–7 (transcripts, judge-wipe guard, LLM budget ledger, honest search rename, codegen timeout, structured errors, API-doc sync) |

## Architecture — the refinery pipeline

```
 inbox/ + watched repos                     (raw material, on demand)
        │
  Tier 0  scan: what changed? (free — mtime, hashes)
        │
  Tier 1  decompose: one cheap LLM pass → candidate claims + first confidence
        │         + Z-gate: embed, kill near-duplicates of vault/open ideas
        │         + coherence gate (the β term)
        │   most material STOPS here (indexed, not deliberated)
        ▼
  Tier 2  deliberate: existing multi-agent market engine — ONLY for claims
        │   passing the uncertainty × stakes gate; small capped sessions
        ▼
  Tier 3  synthesize: ≤ N briefs (default 3) selected as the population
        │   maximizing J(p) — not top-N by value; routed to flat-rate
        │   subscription CLIs for quality
        ▼
  HUMAN: reads briefs, riffs, cuts, edits, accepts ──► vault/ (.md, git)
        │                                                  │
        └─ riff compiler derives graded rulings,           ├─ bounties paid along
           new claims, taste statements (ghosts,           │  lineage, weighted by
           batch-confirmed) ──► applyAdjudication          │  Δ log D_q^Z(vault)
                                                           └─ canon context for
                                                              future runs
```

Everything runs inside the existing resident service; a run is triggered from the
UI (or `POST /api/refine`), never by a scheduler (deferred).

## Components

### 1. Similarity & diversity module (`src/diversity/`)

- Local embedding model (e.g. MiniLM-class via transformers.js — verify exact
  package at plan time; requirement: no per-call API cost, runs offline).
- `embed(text) → vector` with a persistent `embeddings` table (id, kind
  idea|claim|vault, ref_id, vector blob, model, created_at) — embed once, reuse.
- `similarity(a, b)` cosine; `Z` built on demand over a population.
- `hillDiversity(p, Z, q)` — the D_q^Z formula above; `diversityProfile(pop)`
  across q ∈ {0, 1, 2, ∞}.
- `marginalDiversity(x, population, q=2)` = `log D(pop ∪ x) − log D(pop)`,
  uniform abundance. Used for: Tier-1 dedup gate (reject if max similarity to
  vault/open ideas > threshold), bounty weighting, brief-set selection.
- Embedding-quality guard test: paraphrase pairs must score ≥ threshold
  similarity; unrelated pairs ≤ threshold. If the local model fails this, Z is
  theater — the test pins it.

### 2. Escalation cascade (`src/refinery/cascade.ts`)

- Tier 0: source scan (inbox files + configured repo paths from a `sources`
  table; mtime + content-hash dedup).
- Tier 1: one cheap LLM call per new item → candidate claims, first-pass
  confidence, coherence score. Then the Z-gate and coherence gate. Everything
  is recorded (`tier1_items` table) whether escalated or filed.
- Escalation score = uncertainty × stakes: uncertainty from first-pass
  confidence distance to 0.5; stakes from similarity-to-vault-topics and
  riff-history topics (things he has engaged with score higher).
- Tier 2: reuse `runSession` exactly as is, capped (≤2 sessions per run,
  budget-capped via the ledger).
- Tier 3: brief synthesis (below), ≤3 briefs per run (configurable).
- **Budget ledger** (`src/engine/budget.ts`): a store-backed per-run and per-day
  LLM-call counter that EVERY spend path decrements — codegen, evaluate,
  leaf evaluator, recall (né search), Tier-1, synthesis. Exceeding it stops the
  run cleanly. This subsumes fix-list item 3 and is a hard precondition for any
  future autonomy.

### 3. Riff compiler (`src/refinery/riff.ts`)

- Input: freeform text (UI textarea or `inbox/*.riff.md`).
- One Ax signature pass decomposes the riff **against the live marketplace and
  current briefs** into proposed interpretations, each carrying the quote from
  his text that justifies it:
  - graded rulings on open claims `{claimId, confidence, reason(quote)}`
  - new claims/ideas he implied
  - taste statements (free-text, stored in `taste_statements`)
- Interpretations land as **ghosts** (`interpretations` table, status pending).
  UI shows them quote-by-quote; he confirms/edits/rejects in one batch.
  Confirmation calls `applyAdjudication(claimId, outcome, confidence, reason)`.
  **Settlement remains human-only: the confirm is the ruling.**
- Editorial acts on briefs compile the same way: cutting a claim's section
  proposes a low-confidence ruling; keeping/strengthening proposes high; his
  edits are stored as corrections attached to the claim.

### 4. Brief synthesis & J(p) curation (`src/refinery/brief.ts`)

- For each idea that earned synthesis: a brief drafted by a strong model
  (subscription CLI preferred, API fallback) from the deliberation record —
  the idea in its strongest form, load-bearing claims with market state, best
  evidence AND best counterargument, links to related vault canon (via Z), open
  questions (contested claims) first.
- Brief-set selection: from synthesis candidates, choose the set of ≤N
  maximizing `Σ V̂(x) + λ·log D_q^Z(set)` (greedy is fine at this scale; V̂ =
  market-derived value estimate). The cap is a feature: the system must choose.
- Every brief ends with its own economics line: tokens spent on this brief,
  cumulative tokens per vaulted idea — the system reports whether it is earning
  its keep.

### 5. Vault & creation bounties (`src/refinery/vault.ts`)

- `vault/` in-repo, git-tracked. Entry = one .md: title, his accepted prose
  (the edited brief), claims with final confidences and his reasons, surviving
  evidence with provenance labels, lineage (which agents/operators produced
  it), market history appendix, acceptance date + his graded value (0–1).
- `vault/index.md` regenerated on write. Vault summaries (capped tokens,
  selected by Z-relevance to the current material) are injected into Tier-2
  session prompts as canon agents must respect or explicitly challenge.
- **Bounty on accept:** `K × V_human × max(0, Δnorm)` where Δnorm is normalized
  `marginalDiversity(x, vault, q=2)`. Paid into agent wallets, split along the
  idea's lineage: proposer, mutating/forking agent, evidence contributors
  (weights fixed in the plan; recorded in a `bounties` table). True-but-derivative
  earns ~0; novel-and-accepted earns big; re-deriving canon starves.
- Idea lineage: ideas gain `operator` metadata (generated | mutated-from:<id> |
  recombined-from:<ids>) — `parentId` already exists; this completes the DAG for
  credit assignment and future operator-level learning (the deferred
  writeCode meta-loop finally has a real reward signal; still out of scope).

### 6. Schema changes (`src/store/db.ts` — additive)

- `adjudications`: + `confidence REAL`, `reason TEXT`, `source TEXT`
  (click | riff | editorial).
- New: `embeddings`, `tier1_items`, `interpretations`, `taste_statements`,
  `vault_entries`, `bounties`, `sources`, `budget_ledger`.
- Indexes added alongside (fix-list item 10 lands here).
- `training_examples` gains the graded confidence — GEPA's metric becomes
  graded Brier against his confidence, not binary outcome (machinery exists;
  metric swap only).

### 7. UI changes (web only; TUI out of scope)

- **Briefs view** becomes the home: rendered briefs, inline editorial actions
  (keep/cut per section, edit, accept-to-vault with a value slider, reject,
  redirect-with-comment).
- **Riff box**: always present; submits to the compiler; ghost-confirmation
  panel shows interpretations quote-by-quote with batch confirm.
- **Vault browser**: list + reader for vault entries.
- **Run button**: "Refine now" (sources scan → cascade → briefs), with live
  tier progress and the budget gauge.
- **Diversity profile** added to the metrics panel; bounty feed added to the
  activity log. The adjudication card queue remains as a secondary surface.
- All rendering stays `el()`/safe-DOM; `innerHTML` ban unchanged.

### 8. Structural quality gate (`npm run kiss`)

KISS-pattern (dsweet99/kiss) feedback for the executor, adapted to TypeScript:
LLM coders operate locally and degrade global structure they cannot see — this
repo's own 18-commit unsupervised sprint is the case study. The gate gives the
executor cheap, compact, global feedback in-loop instead of expensive
post-hoc review.

- One script, `npm run kiss`, composed of existing tools (exact packages pinned
  at plan time): duplication detection (jscpd-class), complexity/size limits
  (eslint: max function length, max file length, max nesting, max params),
  dependency-cycle detection (dependency-cruiser-class). Output compact enough
  to paste into an agent context.
- **Clamp then ratchet:** thresholds are initialized FROM the current codebase
  (clamp — the existing debt is the baseline, not an immediate failure), then
  committed to config; the gate fails only on regressions. Tightening is a
  deliberate act, never automatic.
- Runs alongside `typecheck && test` in every plan task's verification step and
  is added to CLAUDE.md conventions. Limits acknowledged: it catches structure,
  not semantics — tests and adversarial review remain the semantic layer; agents
  can game metrics, which the review layer watches for.

## Error handling

- Embedding model load failure → refinery refuses to run (Z is load-bearing;
  no silent fallback to "everything is novel").
- Tier failures degrade gracefully: a failed Tier-2 session still allows
  Tier-3 synthesis from Tier-1 material, marked as un-deliberated in the brief.
- Riff compiler producing zero interpretations is a valid outcome (shown as
  such, never fabricated).
- Budget exhaustion mid-run: clean stop, partial results kept, reported in the
  digest line.
- Vault writes are atomic (tmp + rename); the sqlite row and the .md file are
  written in that order, and an orphan-check on boot reports divergence.

## Testing

- Diversity math: unit tests with hand-computable Z (identity Z = naive Hill
  numbers; all-ones Z = diversity 1; paraphrase-pair embedding guard).
- Bounty: accepted-duplicate earns ~0, accepted-novel earns > 0, lineage split
  sums to the bounty; all with seeded stores and stub embeddings.
- Riff compiler: scripted LLM stub → interpretations with quotes; confirm path
  produces graded adjudications + training examples; reject path produces
  nothing.
- Cascade: fixture inbox → Tier-1 stops duplicates (stub embeddings), escalates
  the contested item, respects budget ledger and brief cap.
- Live (key-gated): one end-to-end refine on a small fixture corpus.
- Prereq regression: the 3 currently-failing transcript tests must pass before
  any v5 task lands.

## Build order (phases of one implementation plan)

1. **Foundations:** fix-list items 1–7 + budget ledger + schema + embeddings/
   diversity module (with quality guard) + the structural quality gate
   (`npm run kiss`, clamped to the current baseline). Suite green, spend
   governed, Z real, structure ratcheted.
2. **Refinery core:** cascade (Tiers 0–1 + escalation gate), riff compiler +
   ghost confirm + graded rulings, reusing the existing engine as Tier 2.
3. **Product surface:** brief synthesis + J(p) selection, vault + bounties +
   lineage, UI (briefs home, riff box, vault browser, diversity profile).

Each phase independently verifiable; the system is usable after phase 2 (riff
against existing markets) and delivers the full refinery after phase 3.

## Out of scope (this milestone)

- The nightly daemon / any scheduler (a later cron line on proven machinery).
- Vault self-generation (frontier-from-canon) — the token-burner failure mode;
  revisit only after the refinery proves brief quality.
- Operator-level optimization (writeCode meta-loop) — the lineage DAG built here
  is its future substrate.
- TUI changes; web feeds as sources; multi-user anything; sell-side market
  (fix-list item 15 remains a separate future design).
