# What the Marketplace of Ideas experiment established

**Run:** 2026-06-08 → 2026-06-14 (six days, ~60 commits, six product definitions)
**Status:** experiment concluded; findings below are the deliverable.

This document exists because the most valuable output of the project was not code.
Code was the cheapest thing produced. What follows is what is now known that was
not known before, stated so it transfers to the next project.

---

## 1. The one measured result

On 29 human rulings over agent-generated claims about the author's own ideas:

| Metric | Value | Meaning |
|---|---|---|
| Informativeness | **0.44** | mean pre-ruling price of claims ruled TRUE (0.61) minus those ruled FALSE (0.18) |
| Calibration | monotone above 0.4 | every claim priced > 0.4 that was ruled came out TRUE (17/17) |
| Reputation spread | 0.83 | agents genuinely separated into reliably-right and reliably-wrong |
| Verdict variance | null | **no claim ever received two independent verdicts** |

**Reading it honestly:** an LMSR market driven by LLM agents, settled exclusively by
one human's judgment, produced a real signal — prices predicted rulings well above
chance. The market was not decoration.

**Caveats that matter as much as the number:** all traders ran on one model family
(DeepSeek), so disagreement was persona-deep, not structural. `verdictVariance = null`
means the aggregation machinery went unused — prices reflected single-evaluator
confidence, not resolved dissent. And some "evidence" behind those prices was the
model quoting itself (see failure 2). The 0.44 measures a weaker system than the one
designed.

**The data behind this number was destroyed** (see failure 4). The result is not
reproducible from this repository. Treat it as a directional finding, not a citation.

---

## 2. What demonstrably works

**Code-writing agents over a persistent shared world.** Agents that emit JavaScript
executed in a `node:vm` sandbox, acting on a SQLite store through an injected API,
work reliably enough to be a foundation. Evidence: `workspace/` contains 300–350 line
browser games (a forest FPS, tree climbers, ball games) written by agents from
market-selected priorities, plus a Snake implementation at 108 lines. Errors fed back
as stdout let agents self-correct across iterations.

**LMSR with human-only settlement.** Once the economics were fixed (trades charge
`C(q_after) − C(q_before)`; winning shares redeem 1:1; the market maker's loss bounded
by `b·ln2`), the mechanism behaved correctly and the "only `applyAdjudication` settles"
invariant survived every subsequent pivot including unsupervised sprints. Architectural
invariants stated as single chokepoints do hold.

**Subscription CLIs as model providers.** `claude -p "<prompt>" --max-turns 1` and
`codex exec --skip-git-repo-check -s read-only -o <file> "<prompt>"` both work as
non-interactive completion sources via `execFile` (argument arrays, never a shell).
This makes flat-rate subscription models usable as agents in local applications —
metered API keys are not required for bulk work.

**Spec → plan-with-complete-code → cheap executor → verified review.** Phases 1–4 were
built by a weaker model from plans containing complete code, pinned external APIs, and
per-task verification commands. All four landed green. The same executor, handed a
*spec* instead of a plan, produced confident structure with hollow centers. The plan is
not ceremony; it is the mechanism that converts intent into verifiable steps.

---

## 3. Failure modes observed, with their signatures

1. **No diversity metric → near-duplicate output.** `workspace/` holds four
   tree-climber variants and five ball-game variants. Without a similarity measure,
   the system pays full price — in tokens and in human attention — for redundancy.
   This is the concrete argument for Leinster-style effective-variety scoring (§5).

2. **A knowledge tool that looks like retrieval → fabricated evidence.** A `search()`
   function that actually prompted the LLM was wired to submit its output as
   "supporting" evidence for every claim, unconditionally. Provenance labels
   (`computed` > `target-file` > `model-knowledge`) are not documentation niceties;
   without them, a deliberation system launders hallucination into priced evidence.

3. **Spec without plan → hollow implementation.** Asked for embeddings, the executor
   shipped `sha256(text)` bytes expanded into a 64-dim vector: a similarity matrix with
   zero semantic content, and every downstream diversity computation was therefore
   noise. The spec had explicitly named this failure and mandated a paraphrase-guard
   test. Prose warnings do not execute; failing tests do.

4. **No migrations + agent velocity → data loss.** `CREATE TABLE IF NOT EXISTS` gives
   no schema-evolution path, so a schema change was applied by recreating the database
   file. That destroyed 29 human rulings and 29 training examples — the only
   irreplaceable asset in the project, and the basis of §1. It had been flagged as a
   HIGH-severity finding three days earlier and left unfixed. **Any store holding
   human judgment needs migrations and backups before it holds anything.**

5. **Unbudgeted spend paths.** `subAgent()` was carefully capped; the later-added
   `search()` and `evaluate()` were not, and the iteration-0 template looped
   `evaluate()` over every claim. Budget enforcement must live at the single point
   where LLM calls are issued, not per-feature.

6. **Prediction-only rewards → a consensus engine.** Agents earned exclusively by
   betting correctly on claims. Proposing an idea or contributing evidence paid
   nothing. A market with that reward surface discovers what the oracle will accept
   but has no structural pressure to *create*, and its safest strategy is betting on
   the obvious.

7. **Structural gates catch structure, not semantics.** Duplication/complexity/cycle
   metrics (the KISS pattern) would have caught the god-class store and the duplicated
   async machinery. They would not have caught the fake `search()`, the missing
   `recordIteration` wiring, or the judge-criteria wipe. Both layers are needed.

8. **Environment drift reads as code rot.** A Node major-version change left
   `better-sqlite3` compiled against the wrong ABI, presenting as 75 failing tests.
   `npm rebuild` restored 175/179. Verify the environment before diagnosing the code.

---

## 4. The meta-pattern (the most transferable finding)

Six product definitions in six days: marketplace of ideas → RLM deliberation engine →
knowledge refinery (vault + briefs) → folder-enrichment engine → corporations with
capital that build software. **Each pivot deleted the previous product before it had
been used a second time.** The one session of genuine use — ninety minutes, 29 rulings
— produced the only result in §1, and was immediately followed by more building rather
than a second session.

Building was never the bottleneck; it was the fastest and most comfortable part of the
loop. The scarce input was sustained use and judgment, and it was the input the project
never scaled. A system whose value depends on repeated human engagement cannot be
validated by building more of it.

---

## 5. Ideas worth carrying forward (designed, not built)

- **Diversity economics (Leinster, arXiv 2012.02113).** Reward
  `E[V(x)] + λ·log D_q^Z(p) − β·incoherence`: pay for *marginal effective variety*
  under a similarity relation, not for prediction accuracy. Derivative work then
  starves; novel accepted work earns. Requires real embeddings with a blocking
  paraphrase guard. Specs: `docs/superpowers/specs/2026-06-11-v5-*.md`.
- **Jailed read-only target access** — `target.list()` / `target.read()` with
  realpath jailing, symlink refusal, deny-lists, byte/count budgets, and every read
  logged in the transcript: how to let sandboxed agents analyze a real folder without
  unsealing the sandbox. Spec: `2026-06-11-v6-enrichment-engine-design.md`.
- **Sandboxed compute as the strongest evidence class** — Pyodide-hosted `pyrun` so
  quantitative claims can be *computed* rather than asserted.
- **Human-only settlement as a chokepoint invariant** — it survived six pivots and
  two unsupervised sprints. Worth copying as a pattern: name the single function
  through which irreversible state changes must pass, and test that nothing else can.

---

## 6. Recovery points

| Artifact | Where | State |
|---|---|---|
| Last fully green app | tag `engine-green-101` (`1c1c0b7`) | 101/101 at the time |
| Reusable engine library | `extracted/rlm-engine/` | 64/64 tests, typecheck clean |
| Agent-built games | `workspace/*.html` | playable, committed |
| Design specs | `docs/superpowers/specs/` | v1, v5 (superseded), v6 |
| Implementation plans | `docs/superpowers/plans/` | phases 1–4 (all executed green) |
| Verified fix list | `docs/superpowers/plans/2026-06-11-fixlist.md` | includes a "do not fix" section of refuted claims |
