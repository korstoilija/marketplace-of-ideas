import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { runSession } from "../src/engine/harness.js";
import { buildProviders, makeCodeGenerator, makeLeafEvaluator, makeLlm } from "../src/engine/codegen.js";

const KEY = process.env.DEEPSEEK_API_KEY;

describe.skipIf(!KEY)("live smoke: one tiny session on DeepSeek", () => {
  it("agents propose, trade, and the store fills up", async () => {
    const providers = buildProviders();
    const llm = providers[0].llm;
    const store = new Store(":memory:");

    const result = await runSession({
      store,
      topic: "Deliberate: 'TypeScript is a better choice than Python for new agent frameworks in 2026.' " +
        "Propose 1 idea with 2 claims, submit one piece of evidence per claim, then place market orders sized by your confidence, then set Final.",
      traders: [
        { agentId: "live-skeptic", persona: "ruthless skeptic; you demand evidence", codegen: makeCodeGenerator(llm) },
        { agentId: "live-optimist", persona: "enthusiastic generalist; you look for upside", codegen: makeCodeGenerator(llm) },
      ],
      leafEvaluator: makeLeafEvaluator(llm),
      llm: makeLlm(llm),
      maxIterations: 6, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 30_000,
      stallIterations: 10,
    });

    // The engine must produce real state even if agents are imperfect.
    expect(result.runs.length + result.failures.length).toBe(2);
    expect(store.counters().ideas).toBeGreaterThanOrEqual(1);
    const orders = store.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number };
    expect(orders.n).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
