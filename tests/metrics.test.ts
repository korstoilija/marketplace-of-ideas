import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { computeMetrics } from "../src/server/metrics.js";

describe("computeMetrics", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("empty store returns nulls", () => {
    const m = computeMetrics(store);
    expect(m.adjudicated).toBe(0);
    expect(m.meanPriceTrue).toBeNull();
    expect(m.meanPriceFalse).toBeNull();
    expect(m.informativeness).toBeNull();
    expect(m.verdictVariance).toBeNull();
    expect(m.reputationSpread).toBe(0);
    expect(m.calibration.every(b => b.n === 0)).toBe(true);
  });

  it("seeded store computes informativeness", () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["true claim", "false claim"], author: "a" });
    // true claim: order yes -> price > 0.5
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 300 });
    store.nominate(claimIds[0], "threshold");
    store.applyAdjudication(claimIds[0], true);

    // false claim: order no -> price < 0.5
    store.placeOrder({ claimId: claimIds[1], agentId: "a", side: "no", shares: 300 });
    store.nominate(claimIds[1], "threshold");
    store.applyAdjudication(claimIds[1], false);

    const m = computeMetrics(store);
    expect(m.adjudicated).toBe(2);
    expect(m.meanPriceTrue).toBeGreaterThan(0.5);
    expect(m.meanPriceFalse).toBeLessThan(0.5);
    expect(m.informativeness).toBeGreaterThan(0);
  });

  it("calibration buckets distribute adjudicated claims", () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c0", "c1", "c2", "c3"], author: "a" });

    // Claim at ~0.95 (true outcome)
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 500 });
    store.nominate(claimIds[0], "threshold");
    store.applyAdjudication(claimIds[0], true);

    // Claim at ~0.05 (false outcome)
    store.placeOrder({ claimId: claimIds[1], agentId: "a", side: "no", shares: 500 });
    store.nominate(claimIds[1], "threshold");
    store.applyAdjudication(claimIds[1], false);

    // Claim at ~0.05 (true outcome)
    store.placeOrder({ claimId: claimIds[2], agentId: "a", side: "no", shares: 500 });
    store.nominate(claimIds[2], "threshold");
    store.applyAdjudication(claimIds[2], true);

    // Claim at ~0.95 (false outcome)
    store.placeOrder({ claimId: claimIds[3], agentId: "a", side: "yes", shares: 500 });
    store.nominate(claimIds[3], "threshold");
    store.applyAdjudication(claimIds[3], false);

    const m = computeMetrics(store);
    expect(m.calibration).toHaveLength(5);
    expect(m.calibration[0].bucket).toBe("0-0.2");
    expect(m.calibration[4].bucket).toBe("0.8-1.0");
    const low = m.calibration[0];
    const high = m.calibration[4];
    expect(low.n).toBeGreaterThanOrEqual(1);
    expect(high.n).toBeGreaterThanOrEqual(1);
  });

  it("verdict variance is null with fewer than 2 verdicts per claim", () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.recordVerdict({ claimId: claimIds[0], agentId: "a", confidence: 0.7, reasoning: "test" });
    const m = computeMetrics(store);
    expect(m.verdictVariance).toBeNull();
  });

  it("verdict variance computes with 2+ verdicts", () => {
    store.ensureAgent("a");
    store.ensureAgent("b");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.recordVerdict({ claimId: claimIds[0], agentId: "a", confidence: 0.7, reasoning: "test" });
    store.recordVerdict({ claimId: claimIds[0], agentId: "b", confidence: 0.3, reasoning: "test" });
    const m = computeMetrics(store);
    expect(m.verdictVariance).not.toBeNull();
    expect(m.verdictVariance!).toBeGreaterThan(0);
  });

  it("reputation spread reflects agent diversity", () => {
    store.ensureAgent("a");
    store.ensureAgent("b");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 100 });
    store.placeOrder({ claimId: claimIds[0], agentId: "b", side: "no", shares: 100 });
    store.nominate(claimIds[0], "threshold");
    store.applyAdjudication(claimIds[0], true);
    const m = computeMetrics(store);
    expect(m.reputationSpread).toBeGreaterThan(0);
  });
});
