import { describe, it, expect } from "vitest";
import { lmsrPrice, lmsrCost, buyCost } from "../src/market/lmsr.js";

describe("lmsrPrice", () => {
  it("is 0.5/0.5 at equal quantities", () => {
    const p = lmsrPrice(0, 0, 100);
    expect(p.yes).toBeCloseTo(0.5);
    expect(p.no).toBeCloseTo(0.5);
  });

  it("yes price rises with yes quantity and stays in (0,1)", () => {
    const p1 = lmsrPrice(50, 0, 100);
    const p2 = lmsrPrice(200, 0, 100);
    expect(p1.yes).toBeGreaterThan(0.5);
    expect(p2.yes).toBeGreaterThan(p1.yes);
    expect(p2.yes).toBeLessThan(1);
    expect(p1.yes + p1.no).toBeCloseTo(1);
  });
});

describe("buyCost", () => {
  it("costs more than shares*startPrice and less than shares*endPrice (convexity)", () => {
    const b = 100;
    const startPrice = lmsrPrice(0, 0, b).yes;
    const cost = buyCost(0, 0, b, "yes", 50);
    const endPrice = lmsrPrice(50, 0, b).yes;
    expect(cost).toBeGreaterThan(50 * startPrice);
    expect(cost).toBeLessThan(50 * endPrice);
  });

  it("buying 'no' raises the cost basis symmetrically", () => {
    const yesCost = buyCost(0, 0, 100, "yes", 30);
    const noCost = buyCost(0, 0, 100, "no", 30);
    expect(yesCost).toBeCloseTo(noCost);
  });

  it("market maker loss is bounded by b*ln2: payout - collected <= b*ln2", () => {
    const b = 100;
    let qYes = 0;
    let collected = 0;
    for (let i = 0; i < 10; i++) {
      collected += buyCost(qYes, 0, b, "yes", 50);
      qYes += 50;
    }
    const payout = qYes * 1;
    expect(payout - collected).toBeLessThanOrEqual(b * Math.log(2) + 1e-9);
  });
});
