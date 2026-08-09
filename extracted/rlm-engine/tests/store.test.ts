import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("Store: agents, ideas, evidence", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("ensureAgent creates with defaults and is idempotent", () => {
    const a = store.ensureAgent("trader-1");
    expect(a.balance).toBe(1000);
    expect(a.reputation).toBe(0.5);
    store.adjustBalance("trader-1", -100);
    expect(store.ensureAgent("trader-1").balance).toBe(900);
  });

  it("propose creates idea + claims + markets with CONSISTENT ids", () => {
    const r = store.propose({
      title: "Remote Work Is Net Positive",
      summary: "s", body: "b",
      claims: ["productivity rises", "collaboration suffers"],
      author: "trader-1",
    });
    expect(r.claimIds).toHaveLength(2);
    const idea = store.getIdea(r.ideaId)!;
    expect(idea.claimIds).toEqual(r.claimIds);
    for (const cid of r.claimIds) {
      expect(store.getClaim(cid)).toBeTruthy();
      expect(store.getMarket(cid)).toBeTruthy();
    }
  });

  it("propose disambiguates duplicate titles", () => {
    const a = store.propose({ title: "Same", summary: "s", body: "", claims: ["c"], author: "x" });
    const b = store.propose({ title: "Same", summary: "s", body: "", claims: ["c"], author: "x" });
    expect(a.ideaId).not.toBe(b.ideaId);
  });

  it("evidence has a stance and lists per claim", () => {
    const r = store.propose({ title: "T", summary: "s", body: "", claims: ["c1"], author: "x" });
    store.addEvidence({ claimId: r.claimIds[0], excerpt: "for it", stance: "supporting", submittedBy: "x" });
    store.addEvidence({ claimId: r.claimIds[0], excerpt: "against it", stance: "counter", submittedBy: "x" });
    const ev = store.listEvidence(r.claimIds[0]);
    expect(ev.map(e => e.stance).sort()).toEqual(["counter", "supporting"]);
  });

  it("counters() reports state sizes", () => {
    store.propose({ title: "T", summary: "s", body: "", claims: ["c1", "c2"], author: "x" });
    const c = store.counters();
    expect(c.ideas).toBe(1);
    expect(c.claims).toBe(2);
    expect(c.openMarkets).toBe(2);
  });
});

describe("Store: trading", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
  });

  it("placeOrder deducts LMSR cost (not share count) and moves price", () => {
    const before = store.getAgent("alice")!.balance;
    const r = store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 50 });
    expect(r.cost).toBeGreaterThan(0);
    expect(r.cost).not.toBeCloseTo(50);
    expect(store.getAgent("alice")!.balance).toBeCloseTo(before - r.cost);
    expect(store.getMarket(claimId)!.yesPrice).toBeGreaterThan(0.5);
  });

  it("rejects orders the agent cannot afford", () => {
    expect(() => store.placeOrder({ claimId, agentId: "bob", side: "yes", shares: 1_000_000 }))
      .toThrow(/insufficient/i);
  });

  it("accumulates positions per agent and side", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 15 });
    const pos = store.getPositions("alice");
    expect(pos).toEqual([{ claimId, side: "yes", shares: 25 }]);
  });
});
