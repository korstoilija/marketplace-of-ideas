import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("store read-model", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
  });

  it("listAgents returns all agents with wallets", () => {
    const agents = store.listAgents();
    expect(agents.map(a => a.agentId).sort()).toEqual(["alice", "bob"]);
    expect(agents[0].balance).toBe(1000);
  });

  it("recentOrders returns newest first", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 5 });
    const orders = store.recentOrders(10);
    expect(orders).toHaveLength(2);
    expect(orders[0].agentId).toBe("bob");
    expect(orders[0].side).toBe("no");
    expect(orders[0].cost).toBeGreaterThan(0);
  });

  it("orderCount counts per claim", () => {
    expect(store.orderCount(claimId)).toBe(0);
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    expect(store.orderCount(claimId)).toBe(1);
  });

  it("priceHistory folds orders into a price path starting at 0.5", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 50 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 20 });
    const h = store.priceHistory(claimId);
    expect(h).toHaveLength(3);
    expect(h[0].yesPrice).toBeCloseTo(0.5);
    expect(h[1].yesPrice).toBeGreaterThan(0.5);
    expect(h[2].yesPrice).toBeLessThan(h[1].yesPrice);
  });
});
