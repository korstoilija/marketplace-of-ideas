# rlm-engine

Recursive, capability-identical LLM agents that **write and run JavaScript** against a
persistent shared world, with LMSR-priced claims, budget caps, and full transcripts.

Extracted from the Marketplace of Ideas experiment (June 2026) — the substrate that
survived six product pivots because it is reusable independent of any of them. See
`../../FINDINGS.md` for what the experiment established.

**Verified at extraction: 64/64 tests passing, `tsc --noEmit` clean.**

```bash
npm install     # required: better-sqlite3 compiles natively
npm test
npm run typecheck
```

## What it is

An agent gets a task, a persona, and a sealed sandbox. Each iteration an LLM writes
JavaScript; the sandbox executes it against a SQLite-backed world; truncated stdout
becomes the next iteration's context — so the agent's context stays constant-size no
matter how large the world grows. `subAgent()` spawns a capability-identical child
(same wallet, depth+1) until a depth cap, where it degrades to a single structured
evaluation call. That's the RLM shape: code is the action space, recursion is the
decomposition mechanism.

```ts
import { Store, runSession, buildProviders, makeCodeGenerator,
         makeLeafEvaluator, makeLlm } from "rlm-engine";

const store = new Store("data/world.sqlite");
const llm = buildProviders()[0].llm;          // from DEEPSEEK_API_KEY etc.

const result = await runSession({
  store,
  topic: "Deliberate: <your question>",
  context: "optional extra task context (not part of session identity)",
  traders: [
    { agentId: "skeptic",  persona: "demands evidence", codegen: makeCodeGenerator(llm) },
    { agentId: "optimist", persona: "hunts upside",     codegen: makeCodeGenerator(llm) },
  ],
  leafEvaluator: makeLeafEvaluator(llm),
  llm: makeLlm(llm),
  maxIterations: 8, maxDepth: 1, maxSubAgentCalls: 3,
  sandboxTimeoutMs: 30_000, stallIterations: 10,
});

store.getSessionIterations(result.sessionId);  // full transcripts: code + stdout
```

## Sandbox API (the agent's entire world)

`ideas.propose/list/get`, `evidence.submit/list`, `market.buyYes/buyNo/price/positions`,
`state()`, `await subAgent(prompt)`, `await llm(prompt)`, `await evaluate(...)`,
`await recall(query)`, `print(...)`, `Final = {...}`.

No `require`, no `process`, no filesystem, no network. Host-implemented hooks are the
only way out. Thrown errors return to the agent as text so it can self-correct.

## Modules

| Path | Role |
|---|---|
| `engine/agent.ts` | `RlmAgent` — the recursive iteration loop, budgets, transcripts |
| `engine/sandbox.ts` | `node:vm` context with the injected world API |
| `engine/harness.ts` | `runSession` — concurrent agents, one store, nomination scan |
| `engine/codegen.ts` | Ax signatures, provider factory, fenced-code extraction |
| `engine/cli-provider.ts` | `claude -p` / `codex exec` as code generators (subscriptions as providers) |
| `engine/budget.ts` | per-run LLM-call ledger |
| `store/` | SQLite schema + the only writer; `applyAdjudication` is the only settlement path |
| `market/lmsr.ts` | LMSR cost/price; winning shares redeem 1:1, maker loss ≤ `b·ln2` |

## Deliberately excluded

- **`diversity/`** — the "embeddings" were `sha256(text)` bytes reshaped into a vector:
  zero semantic content. Any similarity or diversity feature must start from a real
  local embedding model **plus a blocking paraphrase-guard test** (FINDINGS §3.3).
- **`server/`, `optimize/gepa.ts`, `repl.ts`** — application layer, not substrate.
  GEPA additionally mutates a module-level generator singleton with no rollback.

## Known limitations (carried over, documented not hidden)

- **Buy-only market.** No sell/exit; agents cannot take profits or correct positions.
- **`evaluateClaimSig` is a module-level singleton** — optimizing it mutates it
  globally for every consumer.
- **Error detection is string-matching** on stdout (`includes("ERROR")`) while a
  structured `result.error` field exists and is ignored.
- **No timeout on the codegen call** — a hung provider wedges an agent (CLI providers
  have their own timeout; the API path does not).
- **`recall()` is model knowledge, not retrieval.** Anything it returns must be labeled
  as such wherever it becomes evidence.
- **No schema migrations.** `CREATE TABLE IF NOT EXISTS` only. Add migrations before
  this store holds anything you cannot regenerate — that omission cost this project 29
  human rulings.

## Provenance

`git tag engine-green-101` in the parent repository marks the last commit where the
full application suite was green (101/101). This library is extracted from that commit.
