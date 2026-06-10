import { Store } from "./src/store/index.js";

const dbPath = process.env["HOME"] + "/.marketplace/test-marketplace.db";
import { unlinkSync } from "node:fs";
try { unlinkSync(dbPath); } catch {}

const store = new Store(dbPath);

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) { if (cond) { pass++; console.log("  PASS:", msg); } else { fail++; console.log("  FAIL:", msg); } }

console.log("=== Deterministic Pipeline: Store + LMSR + Harness ===\n");

// 1. Create agents
const alice = store.ensureAgent("alice");
const bob = store.ensureAgent("bob");
assert(alice.tokenBalance === 1000, "alice starts with 1000 tokens");
assert(bob.reputation === 0.5, "bob starts with 0.5 reputation");

// 2. Propose idea with claims
const ideaId = store.upsertIdea({
  id: "climate-change",
  title: "Climate Change Anthropogenic",
  summary: "Is human activity driving climate change?",
  body: "Multiple lines of evidence...",
  claims: ["climate-change-claim-1", "climate-change-claim-2", "climate-change-claim-3"],
  evidenceLinks: [],
  author: "alice",
  createdAt: Date.now(),
  version: 1,
  status: "proposed",
});
assert(ideaId === "climate-change", "propose idea works");

// Create claims
store.upsertClaim({ id: "climate-change-claim-1", ideaId, text: "Human activity is the primary driver of climate change", type: "factual" });
store.upsertClaim({ id: "climate-change-claim-2", ideaId, text: "Climate models accurately predict observed warming", type: "factual" });
store.upsertClaim({ id: "climate-change-claim-3", ideaId, text: "Natural forcings alone cannot explain warming", type: "factual" });

["climate-change-claim-1", "climate-change-claim-2", "climate-change-claim-3"].forEach(cid => {
  store.ensureMarket(cid);
});

assert(store.ideaCount() === 1, "1 idea stored");
assert(store.claimCount() === 3, "3 claims stored");

// 3. Add evidence
store.insertEvidence({
  id: "ev-1", claimId: "climate-change-claim-1",
  sourceUrl: "", excerpt: "IPCC AR6: human influence is unequivocal", relevance: 0.95, submittedBy: "alice", timestamp: Date.now(),
});
store.insertEvidence({
  id: "ev-2", claimId: "climate-change-claim-1",
  sourceUrl: "", excerpt: "Climate changed naturally before humans", relevance: 0.4, submittedBy: "bob", timestamp: Date.now(),
});

const ev = store.getEvidenceForClaim("climate-change-claim-1");
assert(ev.length === 2, "evidence stored and retrieved");

// 4. Verdicts
store.insertVerdict({
  claimId: "climate-change-claim-1", agentId: "alice",
  confidence: 0.85, reasoning: "IPCC evidence is overwhelming", evidenceReviewed: [], timestamp: Date.now(),
});
store.insertVerdict({
  claimId: "climate-change-claim-1", agentId: "bob",
  confidence: 0.3, reasoning: "Natural variability is undersold", evidenceReviewed: [], timestamp: Date.now(),
});

const vs = store.getVerdictsForClaim("climate-change-claim-1");
assert(vs.length === 2, "verdicts stored");
assert(vs[0].confidence === 0.85, "alice confidence stored");
assert(vs[1].confidence === 0.3, "bob confidence stored");

// 5. Divergence
const div = store.getDivergentClaims(2);
assert(div.length === 1, "divergence detected");
assert(div[0].variance > 0, `variance > 0 (got ${div[0].variance})`);

// 6. Place orders
const r1 = store.placeOrderAndUpdateMarket("climate-change-claim-1", "alice", "yes", 50);
assert(r1.error === undefined, "alice places YES order");
assert(r1.market.yesPrice > 0.5, `price moved above 0.5 (got ${r1.market.yesPrice.toFixed(3)})`);

const r2 = store.placeOrderAndUpdateMarket("climate-change-claim-1", "bob", "no", 30);
assert(r2.error === undefined, "bob places NO order");
assert(r2.market.yesPrice < r1.market.yesPrice, `NO order lowered price`);

// 7. Check balances changed
const alice2 = store.ensureAgent("alice");
const bob2 = store.ensureAgent("bob");
assert(alice2.tokenBalance === 950, `alice paid 50 (got ${alice2.tokenBalance})`);
assert(bob2.tokenBalance === 970, `bob paid 30 (got ${bob2.tokenBalance})`);

// 8. Settle market (human adjudication)
const settle = store.settleMarket("climate-change-claim-1", true);
assert("error" in (settle as Record<string, unknown>) === false || !settle["error"], "settlement succeeds");

const alice3 = store.ensureAgent("alice");
const bob3 = store.ensureAgent("bob");
assert(alice3.tokenBalance > 950, `alice profits from correct bet (got ${alice3.tokenBalance.toFixed(0)})`);
assert(alice3.correctPredictions === 1, "alice has 1 correct prediction");
assert(bob3.correctPredictions === 0, "bob has 0 correct predictions");
assert(alice3.reputation > 0.5, "alice reputation increased");
assert(bob3.reputation < 0.5, "bob reputation decreased");

// 9. Market resolution state
const market = store.getMarket("climate-change-claim-1");
assert(market?.resolution === "true", "market resolved as true");
assert(market?.yesPrice === 1, "yes price is 1 after TRUE resolution");

// 10. Summary
const summary = store.getSummary();
assert(summary.ideas === 1, "summary: 1 idea");
assert(summary.claims === 3, "summary: 3 claims");
assert(summary.settled_markets === 1, "summary: 1 settled");

// 11. Persistence — reopen
const dbPath2 = dbPath;
store.close();
const store2 = new Store(dbPath2);
assert(store2.ideaCount() === 1, "persistence: 1 idea after reopen");
assert(store2.claimCount() === 3, "persistence: 3 claims after reopen");
const m2 = store2.getMarket("climate-change-claim-1");
assert(m2?.resolution === "true", "persistence: market still resolved");
store2.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
