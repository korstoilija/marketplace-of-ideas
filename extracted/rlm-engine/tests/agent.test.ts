import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store } from "../src/store/store.js";
import { RlmAgent, type CodeGenerator, type LeafEvaluator } from "../src/engine/agent.js";

const noopLeaf: LeafEvaluator = async () => ({ confidence: 0.5, reasoning: "none" });
const noopLlm = async (p: string) => `re:${p}`;

function scripted(blocks: string[]): CodeGenerator {
  let i = 0;
  return async () => blocks[Math.min(i++, blocks.length - 1)];
}

function baseConfig(store: Store, codegen: CodeGenerator) {
  return {
    agentId: "t1", persona: "skeptic", task: "deliberate",
    store, codegen, leafEvaluator: noopLeaf, llm: noopLlm,
    maxIterations: 10, maxDepth: 2, maxSubAgentCalls: 4, sandboxTimeoutMs: 2000,
  };
}

describe("RlmAgent", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("runs code each iteration and stops when Final is set", async () => {
    const agent = new RlmAgent(baseConfig(store, scripted([
      `ideas.propose({ title: "A", summary: "s", body: "", claims: ["c"] }); print("proposed");`,
      `Final = { summary: "done" };`,
    ])));
    const run = await agent.run();
    expect(run.final).toEqual({ summary: "done" });
    expect(run.iterations).toHaveLength(2);
    expect(store.counters().ideas).toBe(1);
  });

  it("stops at maxIterations without Final", async () => {
    const agent = new RlmAgent({ ...baseConfig(store, scripted([`print("loop");`])), maxIterations: 3 });
    const run = await agent.run();
    expect(run.final).toBeNull();
    expect(run.iterations).toHaveLength(3);
  });

  it("feeds errors back as history so the agent can self-correct", async () => {
    const codegen = vi.fn<CodeGenerator>()
      .mockResolvedValueOnce(`market.buyYes("missing", 5)`)
      .mockResolvedValueOnce(`Final = { recovered: true }`);
    const agent = new RlmAgent(baseConfig(store, codegen));
    await agent.run();
    const secondCallInputs = codegen.mock.calls[1][0];
    expect(secondCallInputs.historyText).toMatch(/ERROR.*no market/i);
  });

  it("subAgent at maxDepth degrades to leaf evaluation, sharing the wallet", async () => {
    store.ensureAgent("t1");
    const leaf = vi.fn<LeafEvaluator>().mockResolvedValue({ confidence: 0.9, reasoning: "leaf" });
    const agent = new RlmAgent({
      ...baseConfig(store, scripted([
        `const v = await subAgent("is this claim true?"); print("conf:" + v.confidence); Final = v;`,
      ])),
      leafEvaluator: leaf,
      maxDepth: 0,
    });
    const run = await agent.run();
    expect(leaf).toHaveBeenCalledOnce();
    expect(run.final).toEqual({ confidence: 0.9, reasoning: "leaf" });
    const n = (store.db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("subAgent below maxDepth spawns a full child agent", async () => {
    const codegen: CodeGenerator = async (inputs) =>
      inputs.task === "child question"
        ? `Final = { fromChild: true };`
        : `const v = await subAgent("child question"); Final = { child: v };`;
    const agent = new RlmAgent({ ...baseConfig(store, codegen), maxDepth: 1 });
    const run = await agent.run();
    expect(run.final).toEqual({ child: { fromChild: true } });
  });

  it("enforces maxSubAgentCalls per iteration", async () => {
    const agent = new RlmAgent({
      ...baseConfig(store, scripted([
        `for (let i = 0; i < 5; i++) await subAgent("q" + i); Final = {done: true};`,
      ])),
      maxDepth: 0, maxSubAgentCalls: 3, maxIterations: 2,
    });
    const run = await agent.run();
    expect(run.iterations[0].result.stdout).toMatch(/sub-agent budget/i);
  });
});
