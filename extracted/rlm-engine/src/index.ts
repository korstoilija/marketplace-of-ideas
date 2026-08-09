// RLM engine: capability-identical recursive agents that WRITE AND RUN JavaScript
// against a persistent shared world, with LMSR-priced claims and budget caps.
export * from "./engine/agent.js";       // RlmAgent — the recursive loop
export * from "./engine/sandbox.js";     // node:vm sandbox (no fs/require/network)
export * from "./engine/harness.js";     // runSession — concurrent agents, one store
export * from "./engine/budget.js";      // per-run LLM call ledger
export * from "./engine/codegen.js";     // Ax signatures, providers, code extraction
export * from "./engine/cli-provider.js";// claude -p / codex exec as code generators
export * from "./store/store.js";        // SQLite store — the shared world
export * from "./market/lmsr.js";        // LMSR math (cost, price, 1:1 redemption)
