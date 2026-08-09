import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("nomination + adjudication", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
    store.addEvidence({ claimId, excerpt: "pro", stance: "supporting", submittedBy: "alice" });
    store.addEvidence({ claimId, excerpt: "con", stance: "counter", submittedBy: "bob" });
  });

  it("nominate queues once, idempotently", () => {
    store.nominate(claimId, "threshold");
    store.nominate(claimId, "threshold");
    expect(store.pendingNominations()).toHaveLength(1);
  });

  it("adjudication pays winners 1 token per share, updates reputation, emits training example", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 40 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 30 });
    const aliceBefore = store.getAgent("alice")!.balance;
    const bobBefore = store.getAgent("bob")!.balance;

    store.nominate(claimId, "threshold");
    store.applyAdjudication(claimId, true);

    expect(store.getAgent("alice")!.balance).toBeCloseTo(aliceBefore + 40);
    expect(store.getAgent("bob")!.balance).toBeCloseTo(bobBefore);
    expect(store.getAgent("alice")!.reputation).toBe(1);
    expect(store.getAgent("bob")!.reputation).toBe(0);
    expect(store.getMarket(claimId)!.resolution).toBe("true");
    expect(store.getMarket(claimId)!.yesPrice).toBe(1);

    const ex = store.listTrainingExamples();
    expect(ex).toHaveLength(1);
    expect(ex[0].outcome).toBe(true);
    expect(ex[0].supporting).toEqual(["pro"]);
    expect(ex[0].counter).toEqual(["con"]);

    expect(store.pendingNominations()).toHaveLength(0);
  });

  it("skip leaves the market open and emits no training data", () => {
    store.nominate(claimId, "threshold");
    store.skipNomination(claimId);
    expect(store.getMarket(claimId)!.resolution).toBeNull();
    expect(store.listTrainingExamples()).toHaveLength(0);
    expect(store.pendingNominations()).toHaveLength(0);
  });

  it("adjudicating twice throws", () => {
    store.nominate(claimId, "x");
    store.applyAdjudication(claimId, true);
    expect(() => store.applyAdjudication(claimId, false)).toThrow(/resolved/i);
  });

  it("rejects new orders on resolved markets", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.nominate(claimId, "x");
    store.applyAdjudication(claimId, true);
    expect(() => store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 5 }))
      .toThrow(/resolved/i);
  });
});
