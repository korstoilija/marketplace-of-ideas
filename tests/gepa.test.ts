import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { AxGEPA, axSerializeOptimizedProgram, axDeserializeOptimizedProgram, ai } from "@ax-llm/ax";
import { toExamples, splitHoldout, brier, gepaMetric, type GepaExample } from "../src/optimize/gepa.js";
import { runGepa, InsufficientExamplesError, loadLatestOptimization } from "../src/optimize/gepa.js";

describe("ax GEPA API pinning", () => {
  it("AxGEPA constructs with a studentAI and exposes compile", () => {
    const llm = ai({ name: "deepseek", apiKey: "never-used" });
    const opt = new AxGEPA({ studentAI: llm });
    expect(typeof opt.compile).toBe("function");
    expect(typeof axSerializeOptimizedProgram).toBe("function");
    expect(typeof axDeserializeOptimizedProgram).toBe("function");
  });
});

describe("store: optimizations", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("insert + list + latest round-trip", () => {
    store.insertOptimization({ baseline: 0.61, optimized: 0.74, examplesUsed: 24, holdoutSize: 8, programJson: '{"v":1}' });
    store.insertOptimization({ baseline: 0.74, optimized: 0.79, examplesUsed: 40, holdoutSize: 13, programJson: '{"v":2}' });
    const all = store.listOptimizations();
    expect(all).toHaveLength(2);
    expect(all[0].optimized).toBe(0.79);
    expect(store.latestOptimization()!.programJson).toBe('{"v":2}');
  });

  it("latestOptimization is null when none exist", () => {
    expect(store.latestOptimization()).toBeNull();
  });

  it("trainingExampleCount matches adjudications", () => {
    expect(store.trainingExampleCount()).toBe(0);
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.nominate(claimIds[0], "x");
    store.applyAdjudication(claimIds[0], true);
    expect(store.trainingExampleCount()).toBe(1);
  });
});

describe("gepa pure pieces", () => {
  it("toExamples flattens training examples into signature inputs + outcome", () => {
    const store = new Store(":memory:");
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c-text"], author: "a" });
    store.addEvidence({ claimId: claimIds[0], excerpt: "pro1", stance: "supporting", submittedBy: "a" });
    store.addEvidence({ claimId: claimIds[0], excerpt: "con1", stance: "counter", submittedBy: "a" });
    store.nominate(claimIds[0], "x");
    store.applyAdjudication(claimIds[0], true);

    const ex = toExamples(store);
    expect(ex).toHaveLength(1);
    expect(ex[0].claimText).toBe("c-text");
    expect(ex[0].supportingEvidence).toBe("pro1");
    expect(ex[0].counterEvidence).toBe("con1");
    expect(ex[0].outcome).toBe(true);
  });

  it("splitHoldout is deterministic: every 4th example (index 0,4,8...) goes to holdout", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { train, holdout } = splitHoldout(items);
    expect(holdout).toEqual([0, 4, 8]);
    expect(train).toEqual([1, 2, 3, 5, 6, 7, 9]);
  });

  it("brier penalizes confident wrongness most", () => {
    expect(brier(1.0, true)).toBe(0);     // confident and right
    expect(brier(1.0, false)).toBe(1);    // confident and wrong
    expect(brier(0.5, true)).toBeCloseTo(0.25); // fence-sitting
    expect(brier(1.7, true)).toBe(0);     // clamped
  });

  it("gepaMetric = 1 - brier(prediction.confidence, example.outcome)", async () => {
    const score = await gepaMetric({ prediction: { confidence: 0.9 }, example: { outcome: true } as never });
    expect(score).toBeCloseTo(1 - 0.01);
    const bad = await gepaMetric({ prediction: { confidence: 0.9 }, example: { outcome: false } as never });
    expect(bad).toBeCloseTo(1 - 0.81);
  });
});

function seedAdjudications(store: Store, n: number): void {
  store.ensureAgent("seed");
  for (let i = 0; i < n; i++) {
    const { claimIds } = store.propose({
      title: `Seed ${i}`, summary: "s", body: "",
      claims: [`claim number ${i}`], author: "seed",
    });
    store.addEvidence({ claimId: claimIds[0], excerpt: `evidence ${i}`, stance: i % 2 ? "supporting" : "counter", submittedBy: "seed" });
    store.nominate(claimIds[0], "test");
    store.applyAdjudication(claimIds[0], i % 2 === 0);
  }
}

describe("runGepa with fakes", () => {
  const fakeLlm = ai({ name: "deepseek", apiKey: "never-used" });

  it("refuses below minExamples with a typed error carrying the count", async () => {
    const store = new Store(":memory:");
    seedAdjudications(store, 3);
    await expect(runGepa({ store, llm: fakeLlm, minExamples: 30 }))
      .rejects.toThrow(InsufficientExamplesError);
    await expect(runGepa({ store, llm: fakeLlm, minExamples: 30 }))
      .rejects.toThrow(/have 3/);
  });

  it("computes baseline and after, persists a report row", async () => {
    const store = new Store(":memory:");
    seedAdjudications(store, 8);
    const scores = [0.55, 0.7]; // baseline, then post-optimization
    let call = 0;
    const report = await runGepa({
      store, llm: fakeLlm, minExamples: 8,
      score: async () => scores[call++],
      optimize: async () => ({ optimizedProgram: undefined }), // optimizer found nothing better
    });
    expect(report.baseline).toBe(0.55);
    expect(report.optimized).toBe(0.7);
    expect(report.applied).toBe(false);
    expect(report.holdoutSize).toBe(2); // indices 0,4 of 8
    expect(store.listOptimizations()).toHaveLength(1);
    expect(store.listOptimizations()[0].baseline).toBe(0.55);
  });

  it("loadLatestOptimization is safe on empty store and on garbage", () => {
    const store = new Store(":memory:");
    expect(loadLatestOptimization(store)).toBe(false);
    store.insertOptimization({ baseline: 0, optimized: 0, examplesUsed: 0, holdoutSize: 0, programJson: "not-json{" });
    expect(loadLatestOptimization(store)).toBe(false); // logs and continues
    store.insertOptimization({ baseline: 0, optimized: 0, examplesUsed: 0, holdoutSize: 0, programJson: "{}" });
    expect(loadLatestOptimization(store)).toBe(false); // empty program = nothing applied
  });
});
