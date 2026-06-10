import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { buildAdjudicationCards } from "../src/server/cards.js";

describe("buildAdjudicationCards", () => {
  let store: Store;
  let contested: string, confirmed: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("a");
    const r = store.propose({ title: "T", summary: "s", body: "", claims: ["c1", "c2"], author: "a" });
    [contested, confirmed] = r.claimIds;

    store.placeOrder({ claimId: contested, agentId: "a", side: "yes", shares: 30 });
    store.placeOrder({ claimId: contested, agentId: "a", side: "no", shares: 28 });
    store.placeOrder({ claimId: confirmed, agentId: "a", side: "yes", shares: 250 });

    store.addEvidence({ claimId: contested, excerpt: "pro", stance: "supporting", submittedBy: "a" });
    store.addEvidence({ claimId: contested, excerpt: "con", stance: "counter", submittedBy: "a" });
    store.recordVerdict({ claimId: contested, agentId: "a", confidence: 0.6, reasoning: "leans true" });

    store.nominate(contested, "stalled");
    store.nominate(confirmed, "threshold");
  });

  it("builds one card per pending nomination with stance-split evidence", () => {
    const cards = buildAdjudicationCards(store);
    expect(cards).toHaveLength(2);
    const c = cards.find(x => x.claimId === contested)!;
    expect(c.claimText).toBe("c1");
    expect(c.supporting).toEqual(["pro"]);
    expect(c.counter).toEqual(["con"]);
    expect(c.verdicts[0].confidence).toBe(0.6);
    expect(c.reason).toBe("stalled");
    expect(c.orders).toBe(2);
  });

  it("orders contested before confirmed", () => {
    const cards = buildAdjudicationCards(store);
    expect(cards[0].claimId).toBe(contested);
    expect(cards[1].claimId).toBe(confirmed);
  });

  it("ruled claims drop out of the queue", () => {
    store.applyAdjudication(confirmed, true);
    const cards = buildAdjudicationCards(store);
    expect(cards).toHaveLength(1);
    expect(cards[0].claimId).toBe(contested);
  });
});
