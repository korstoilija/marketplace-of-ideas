# Marketplace of Ideas on Ax — Design

**Date:** 2026-06-10
**Status:** Approved (pending final spec review)

## Purpose

An RLM-style multi-agent deliberation system: LLM agents write and execute code to
create ideas, decompose them into claims, gather evidence, spawn sub-agents, and bid
in LMSR prediction markets. The human owner adjudicates outcomes; adjudications drive
payouts, reputation, and GEPA prompt optimization. Built on `@ax-llm/ax` (DSPy for
TypeScript).

The system is a **taste-alignment loop**: agents deliberate cheaply at scale, market
prices compress their disagreement into "settled vs. contested," and the human's
adjudications are the only ground truth. GEPA optimizes the evaluator toward the
human's judgment.

## Current state (what exists before this work)

A working hand-rolled prototype, preserved in the initial git commit:

- `src/types/deliberation.ts` — 14 Zod schemas (Idea, Claim, Verdict, ClaimMarket,
  Distillate, RentScore, PredictiveClaim, Verification…). **Keep, evolve.**
- `src/market/lmsr.ts` — LMSR price/cost/buy/resolve + rent scoring. **Keep, fix bugs.**
- `src/rlm/repl.ts` — `JsRepl`: a `node:vm` sandbox with injected marketplace tools
  over an in-memory state object. **Precursor of the new sandbox; superseded.**
- `src/rlm/loop.ts` — `runRlm()`: single-root RLM loop, DeepSeek via raw `fetch`,
  in-memory state. **Superseded by the multi-agent Ax engine.**
- `src/evaluate/sub-agent.ts` — multi-provider claim evaluator via raw `fetch`
  (DeepSeek, Anthropic, OpenAI, Mistral, OpenRouter). **Replaced by Ax signatures.**
- `src/server/api.ts` — hand-rolled HTTP API (existed to serve a Python REPL that no
  longer exists). **Delete.**
- `src/tools/marketplace_tools.py` + `src/rlm/` Python remnants. **Delete.**
- `src/mcp/idea-registry/server.ts` — stdio MCP server with its own duplicate state.
  **Keep, rewire to the shared store.**
- `test-*.ts` (6 files at repo root) — hand-scripted pipeline runs. **Replaced by
  real tests.**

Known bugs fixed as part of migration:

1. **Claim-ID mismatch** — `Idea.claims` gets IDs like `claim-${id}-1` but claims and
   markets are keyed `${id}-claim-1` (duplicated propose logic diverged).
2. **LMSR payout double-pays** — winners receive losers' stakes *plus* shares back.
   Standard LMSR: each winning share redeems for exactly 1 token; the subsidy is the
   market maker's `b·ln2`-bounded loss. The current rule rewards late piling-on to
   high-priced claims; the fix restores the incentive to be early and right.
3. **Triplicated state stores** — HTTP API, MCP server, and tests each maintain their
   own Maps. Consolidated into one store module.

## Decisions (made during brainstorming)

| Decision | Choice |
|---|---|
| LLM framework | `@ax-llm/ax` (DSPy-style signatures + optimizers) |
| Agent action space | Agents write JavaScript, executed in a `node:vm` sandbox |
| Agent model | One recursive `RlmAgent` class; no root/sub capability distinction |
| Traders per session | N capability-identical agents (3–5), persona/provider-diverse |
| Sub-agent economics | Sub-agents share the parent's wallet (delegates, not participants) |
| Settlement | Human adjudication only — agents and harness never settle |
| GEPA signal | Human-adjudicated outcomes (calibration-weighted correctness) |
| State consolidation | One in-process store; MCP server is the external agent window |
| Persistence | SQLite via `better-sqlite3` |
| Human interface | Local web app (HTTP + WebSocket), served by the same process |
| Milestone | Full loop end-to-end including a GEPA pass with before/after metrics |

## Architecture: a resident marketplace

One long-running Node process (`npm start`) containing three layers around one
SQLite store:

```
┌────────────────────────────────────────────────────────┐
│  Node process                                          │
│                                                        │
│  ENGINE                 HUMAN INTERFACE                │
│  RlmAgent × N           HTTP + WebSocket server        │
│  (Ax codeWriter →       serving the local web app:     │
│   vm sandbox →          live idea/claim graph, prices, │
│   store API)            agent feed, adjudication cards │
│  LMSR market math                                      │
│  Harness (budgets,            ┌──────────────┐         │
│   nomination, payouts)  ◄──── │ SQLite store │ ────►   │
│                               └──────────────┘         │
│  AGENT INTERFACE (separate entry point, same DB):      │
│  MCP idea-registry server (stdio) for external agents  │
└────────────────────────────────────────────────────────┘
```

The old HTTP API sat *between agents and state* (plumbing tax on every agent action).
The new server sits *between the human and state* (the product surface). Agents stay
in-process with typed access.

### Component 1: The agent — one class, fully recursive

```
RlmAgent {
  agentId   // store-backed identity: balance, reputation, holdings
  ai        // AxAI instance (provider/model); persona in the task prompt
  depth     // recursion depth, starts at 0
  context   // task prompt + private history of (code, stdout-metadata) pairs
}
```

Per iteration:

1. Ax **codeWriter** signature `(task, persona, stateMetadata, history) → code`
   produces JavaScript.
2. The sandbox executes it against the live store API.
3. Truncated stdout (≤ ~1000 chars) becomes the next history entry.
4. Loop until the code sets `Final = {...}` or the iteration cap is hit.

The corpus never enters the context window — only counters and truncated prints.
Constant context size regardless of corpus size is the core RLM mechanism.

**Sandbox globals** (the agent's whole world):

- `ideas.propose(…) / fork(…) / search(…)`
- `market.buyYes(claimId, amount) / buyNo(…) / price(claimId) / positions()`
- `evidence.submit(…) / search(…)`
- `state()` — counters + own balance/reputation, never full corpus
- `subAgent(prompt)` — the recursion (see below)
- `llm(prompt)` — plain one-shot LM call
- `print(…)` — captured stdout
- `Final = {...}` — terminates the agent's loop

**`subAgent(prompt)` semantics:** at `depth < MAX_DEPTH` (default 2), spawns a full
`RlmAgent` — same environment and store, fresh context, **same agentId/wallet as the
parent** — and returns the child's `Final`. At max depth it degrades to a single
structured Ax call (`evaluateClaim`), matching the RLM paper's "leaf calls are plain
LM calls." Agents are capability-identical; they differ only by context and depth.

### Component 2: Marketplace session

A session = topic + N agents (3–5) seeded with different providers/personas (e.g.
DeepSeek skeptic, Mistral generalist), each with its own wallet, running their loops
concurrently against the shared store. Sessions are launched from the web UI.

**Trading is the agents' decision** (they write the code that places orders), but the
suggested pattern in the codeWriter prompt remains confidence-proportional staking.

**The harness** (deterministic TS, no LLM) does only what must be neutral:

- Enforce budgets: per-agent iteration cap, sub-agent depth cap (2), sub-agent spawn
  cap per iteration, per-session cost cap.
- **Nominate** claims into the adjudication queue when price crosses 0.85/0.15, or
  when trading stalls (no new orders on the claim for a configurable number of
  agent iterations, default 10, while volume is nonzero). Nomination is not
  settlement.
- Apply LMSR payouts and reputation updates *after human adjudication*.
- Compute rent scores; run distillation; persist everything.

### Component 3: Settlement = human adjudication

- Agents never settle; the harness never settles. Only the human does.
- The adjudication queue lives in SQLite. The web UI surfaces each item as a card:
  claim text, price trajectory, best supporting/counter evidence, strongest reasoning
  from each side — compressed for a ~30-second decision.
- Ruling **true / false** triggers LMSR payout, reputation updates, and emits a GEPA
  training example `(claim, evidence) → verdict`. **Skip** leaves the claim
  unresolved: price stays live as a belief signal, but it never pays out and never
  becomes training data.
- Queue ordering: contested claims (price ≈ 0.5, high volume) first — they are the
  most informative per click — mixed with cheap high-confidence confirmations.
- Constraint, stated plainly: **the human adjudication rate bounds the learning
  rate.** The first GEPA pass requires ~30–50 rulings.

### Component 4: The Ax layer

- One `AxAI` instance per provider, filtered by available env keys. DeepSeek is the
  cheap default.
- Three signatures:
  - `writeCode` — the agent step (task, persona, metadata, history → JS code)
  - `evaluateClaim` — leaf evaluation (claim, supporting evidence, counter evidence →
    confidence, reasoning, strengths, weaknesses)
  - `arbiterResolve` — optional pre-digest for adjudication cards (claim, verdicts,
    market state → summary for the human; never settles anything)
- **GEPA pass (in scope for this milestone):** training examples come exclusively
  from human-adjudicated claims. Metric: calibration-weighted agreement with the
  human (penalize confident-and-wrong more than uncertain-and-wrong; a proper scoring
  rule such as Brier score on the human's verdict). Run Ax's GEPA optimizer on
  `evaluateClaim` against a held-out slice; report before/after scores in the UI.
- Optimizing `writeCode` from distillates is **out of scope** (next milestone).
- Exact Ax API names (signature syntax, optimizer entry points) are verified against
  current axllm.dev docs at implementation time; the framework moves fast.

### Component 5: Store & persistence

One `src/store/` module on `better-sqlite3`. Tables: `ideas`, `claims`, `evidence`,
`verdicts`, `orders`, `markets`, `agents`, `adjudications`, `distillates`,
`training_examples` (derivable view over adjudications, materialized for GEPA).

Used in-process by engine and harness. The MCP idea-registry server is rewired to
read the same DB file (external agents' window into a running marketplace). The web
server reads it and pushes deltas over WebSocket.

### Component 6: Sandbox & safety

`node:vm` context exposing the injected API only — no `require`, `process`, `fs`, or
network. Per-execution timeout. `print()` captures stdout. Thrown errors are returned
to the agent as text so it can self-correct next iteration (real stack traces, no
serialization boundary). This extends the existing `JsRepl` approach with: store
backing (not in-memory Maps), per-agent identity, `subAgent()` recursion, and
removal of settlement tools from the sandbox.

### Component 7: Web app

Served by the same process at localhost. Views:

1. **Market view** — idea/claim graph with live prices, price trajectories, agent
   activity feed, balances and reputations. WebSocket-pushed: watching prices move
   while agents trade is what makes the market legible as a market.
2. **Adjudication surface** — pending cards (ghost-proposal pattern: visible, pending,
   not real until the human acts). True/false/skip per card; payout and reputation
   changes ripple visibly after each ruling.
3. **Session controls** — launch a deliberation session (topic, agent count, budget),
   watch its progress, see GEPA before/after metrics once available.

No terminal interaction after `npm start`.

## Error handling

- Agent code throws → error text fed back as stdout; iteration counted.
- Provider call fails → agent skips the iteration; repeated failures park the agent
  for the session (`Promise.allSettled` semantics everywhere; no silent drops —
  failures appear in the activity feed).
- Sandbox timeout → captured as `[TIMEOUT]` in stdout metadata; iteration counted.
- Budget exhausted → agent's loop ends gracefully; whatever it staked stands.
- Process restart → all state is in SQLite; markets, queues, and balances resume.
  In-flight agent iterations are lost (acceptable: history is metadata, agents are
  restartable).

## Testing

- **Unit:** LMSR invariants (price bounds, cost monotonicity, payout conservation:
  total payouts ≤ stakes + b·ln2 subsidy), store round-trips, sandbox isolation
  (no `require`/`process` escape), claim-ID consistency.
- **Deterministic loop tests:** mock LM emitting scripted code drives a full agent
  loop and a full session without network.
- **Live smoke test:** one short session, DeepSeek only, gated on `DEEPSEEK_API_KEY`.
- **GEPA eval:** held-out adjudicated claims; assert the metric is computed and
  reported (improvement itself is not assertable in CI).

## Build order (phases of one implementation plan)

1. **Engine** — store, sandbox, `RlmAgent`, market fixes, harness; headless,
   fully testable without UI.
2. **Service + web UI** — resident process, WebSocket state, adjudication surface,
   session controls; MCP server rewired.
3. **GEPA** — training-example extraction, metric, optimizer run, before/after
   reporting in the UI.

Each phase is independently verifiable. Work is tracked as `bd` issues.

## Out of scope (this milestone)

- Optimizing the `writeCode` signature from distillates (GEPA meta-loop on strategy).
- Predictive-claim auto-resolution by future verification (`PredictiveClaimSchema`
  stays in the types; wiring it to settlement is future work).
- Mechanical verification (running code/math to check claims) as a settlement input.
- Multi-human adjudication; auth on the web app (localhost, single user).
- Distributing agents across processes/machines.
