import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { runSession, scanNominations } from "../src/engine/harness.js";
import type { CodeGenerator } from "../src/engine/agent.js";

const noopLeaf = async () => ({ confidence: 0.5, reasoning: "n" });
const noopLlm = async () => "ok";

describe("scanNominations", () => {
  it("nominates threshold-crossers and stalled markets, never untouched ones", () => {
    const store = new Store(":memory:");
    store.ensureAgent("a");
    const [hot, stale, calm] = store.propose({
      title: "T", summary: "s", body: "", claims: ["c1", "c2", "c3"], author: "a",
    }).claimIds;

    store.currentIteration = 0;
    store.placeOrder({ claimId: hot, agentId: "a", side: "yes", shares: 250 }); // price > 0.85
    store.placeOrder({ claimId: stale, agentId: "a", side: "yes", shares: 10 }); // mild, then silence
    void calm;

    store.currentIteration = 20; // stale has had no orders for >= 10 iterations
    scanNominations(store, { stallIterations: 10 });

    const pending = store.pendingNominations().map(n => n.claimId).sort();
    expect(pending).toEqual([hot, stale].sort());
  });
});

describe("runSession", () => {
  it("runs N agents against one store and returns their runs", async () => {
    const store = new Store(":memory:");
    const mkGen = (title: string): CodeGenerator => {
      let done = false;
      return async () => {
        if (done) return `Final = { ok: true };`;
        done = true;
        return `
          const { claimIds } = ideas.propose({ title: "${title}", summary: "s", body: "", claims: ["claim"] });
          market.buyYes(claimIds[0], 30);
          print("traded");
        `;
      };
    };
    const result = await runSession({
      store,
      topic: "test topic",
      traders: [
        { agentId: "alpha", persona: "skeptic", codegen: mkGen("Idea Alpha") },
        { agentId: "beta", persona: "optimist", codegen: mkGen("Idea Beta") },
      ],
      leafEvaluator: noopLeaf,
      llm: noopLlm,
      maxIterations: 5, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 2000,
      stallIterations: 10,
    });
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every(r => r.final !== null)).toBe(true);
    expect(result.sessionId).toBeGreaterThan(0);
    expect(store.counters().ideas).toBe(2);
    expect(store.getPositions("alpha")).toHaveLength(1);
    expect(store.getPositions("beta")).toHaveLength(1);
  });

  it("an agent whose codegen throws does not sink the session", async () => {
    const store = new Store(":memory:");
    const bad: CodeGenerator = async () => { throw new Error("provider down"); };
    const good: CodeGenerator = async () => `Final = { ok: true };`;
    const result = await runSession({
      store, topic: "t",
      traders: [
        { agentId: "bad", persona: "p", codegen: bad },
        { agentId: "good", persona: "p", codegen: good },
      ],
      leafEvaluator: noopLeaf, llm: noopLlm,
      maxIterations: 3, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 2000,
      stallIterations: 10,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].agentId).toBe("bad");
    expect(result.failures[0].error).toMatch(/provider down/);
  });

  it("runSession persists iterations including recursive children", async () => {
    const store = new Store(":memory:");
    let call = 0;
    const gen: CodeGenerator = async () => {
      call++;
      if (call === 1) return `
        const r = await subAgent("evaluate this sub-question");
        print("sub returned: " + JSON.stringify(r));
        Final = { main: true };
      `;
      return `Final = { sub: true };`;
    };
    const result = await runSession({
      store, topic: "recursive test",
      traders: [{ agentId: "parent", persona: "p", codegen: gen }],
      leafEvaluator: async () => ({ confidence: 0.7, reasoning: "leaf" }),
      llm: noopLlm,
      maxIterations: 3, maxDepth: 3, maxSubAgentCalls: 5, sandboxTimeoutMs: 2000,
      stallIterations: 10,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.sessionId).toBeGreaterThan(0);

    const iters = store.getSessionIterations(result.sessionId);
    expect(iters.length).toBeGreaterThanOrEqual(2);
    const depths = iters.map(i => i.depth);
    expect(depths).toContain(0);
    expect(depths).toContain(1);
  });
});
