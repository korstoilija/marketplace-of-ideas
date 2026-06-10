import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { Sandbox } from "../src/engine/sandbox.js";

function makeSandbox(store: Store, timeoutMs = 2000) {
  return new Sandbox({
    store,
    agentId: "trader-1",
    subAgent: async (prompt: string) => ({ echo: prompt }),
    llm: async (prompt: string) => `llm:${prompt}`,
    timeoutMs,
  });
}

describe("Sandbox", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("trader-1");
  });

  it("executes code against the real store", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`
      const { claimIds } = ideas.propose({ title: "Test Idea", summary: "s", body: "b", claims: ["c1"] });
      evidence.submit(claimIds[0], "some proof", "supporting");
      market.buyYes(claimIds[0], 20);
      print("price:", market.price(claimIds[0]).toFixed(2));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toMatch(/price: 0\.5/);
    expect(store.counters().ideas).toBe(1);
    expect(store.getPositions("trader-1")).toHaveLength(1);
  });

  it("has NO escape hatches", async () => {
    const sb = makeSandbox(store);
    for (const code of ["require('fs')", "process.exit(1)", "globalThis.process.exit(1)"]) {
      const r = await sb.execute(code);
      expect(r.error).toMatch(/not defined|Cannot read|undefined/);
    }
  });

  it("returns thrown errors as text, does not crash", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`market.buyYes("no-such-claim", 5)`);
    expect(r.error).toMatch(/no market/i);
  });

  it("supports await of subAgent and llm hooks", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`
      const v = await subAgent("evaluate this");
      const t = await llm("quick question");
      print(JSON.stringify(v), t);
    `);
    expect(r.stdout).toContain('{"echo":"evaluate this"}');
    expect(r.stdout).toContain("llm:quick question");
  });

  it("captures Final and reports hasFinal", async () => {
    const sb = makeSandbox(store);
    const r1 = await sb.execute(`print("working")`);
    expect(r1.hasFinal).toBe(false);
    const r2 = await sb.execute(`Final = { summary: "done" }`);
    expect(r2.hasFinal).toBe(true);
    expect(sb.getFinal()).toEqual({ summary: "done" });
  });

  it("times out runaway code", async () => {
    const sb = makeSandbox(store, 300);
    const r = await sb.execute(`while(true){}`);
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it("state() reports counters and own wallet, never the corpus", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`print(JSON.stringify(state()))`);
    expect(r.stdout).toContain('"balance":1000');
    expect(r.stdout).toContain('"ideas":0');
  });
});
