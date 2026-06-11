import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { runGepa } from "../src/optimize/gepa.js";
import { buildProviders } from "../src/engine/codegen.js";

const KEY = process.env.DEEPSEEK_API_KEY;

const FACTS: Array<[string, string, boolean]> = [
  ["Water boils at 100C at sea level", "standard atmospheric physics", true],
  ["The moon is made of cheese", "spectroscopy shows rock", false],
  ["TypeScript compiles to JavaScript", "tsc emits .js files", true],
  ["Humans have three hearts", "anatomy: one heart", false],
  ["SQLite stores data in a single file", "sqlite documentation", true],
  ["The sun orbits the earth", "heliocentrism, Kepler", false],
  ["HTTP/1.1 uses TCP", "RFC 7230", true],
  ["Penguins can fly", "flightless bird", false],
];

describe.skipIf(!KEY)("live GEPA on DeepSeek", () => {
  it("optimizes evaluateClaim against synthetic rulings and reports scores", async () => {
    const store = new Store(":memory:");
    store.ensureAgent("seed");
    for (const [claim, evidence, outcome] of FACTS) {
      const { claimIds } = store.propose({ title: claim.slice(0, 40), summary: "s", body: "", claims: [claim], author: "seed" });
      store.addEvidence({ claimId: claimIds[0], excerpt: evidence, stance: outcome ? "supporting" : "counter", submittedBy: "seed" });
      store.nominate(claimIds[0], "test");
      store.applyAdjudication(claimIds[0], outcome);
    }

    const llm = buildProviders()[0].llm;
    const report = await runGepa({ store, llm, minExamples: 8, maxMetricCalls: 12 });

    expect(report.holdoutSize).toBe(2);
    expect(report.baseline).toBeGreaterThanOrEqual(0);
    expect(report.baseline).toBeLessThanOrEqual(1);
    expect(report.optimized).toBeGreaterThanOrEqual(0);
    expect(store.listOptimizations()).toHaveLength(1);
    // No assertion that optimized > baseline: 6 training examples is not enough to
    // guarantee improvement, and CI must not flake. The MACHINERY is what's under test.
  }, 600_000);
});
