import { createMarket, buyShares, resolveMarket, lmsrPrice, lmsrCost, computeRentScore } from "./src/market/lmsr.js";
import type { ClaimMarket, AgentState, MarketOrder } from "./src/types/deliberation.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function assertClose(a: number, b: number, epsilon: number, label: string) {
  assert(Math.abs(a - b) < epsilon, `${label} (expected ${b}, got ${a})`);
}

console.log("\n=== LMSR Market Maker Tests ===\n");

// Test 1: Initial market
const market = createMarket("claim-1", 1000, 100);
assert(market.yesPrice === 0.5, "initial yes price is 0.5");
assert(market.noPrice === 0.5, "initial no price is 0.5");
assert(market.liquidity === 1000, "liquidity is 1000");
assert(market.b === 100, "b parameter is 100");

// Test 2: Buy YES shares → price should rise
const order1: MarketOrder = {
  claimId: "claim-1",
  agentId: "agent-A",
  side: "yes",
  amount: 100,
  timestamp: Date.now(),
};

const { market: market2, avgPrice } = buyShares(market, order1);
assert(market2.yesPrice > 0.5, "buying YES raises yes price");
assert(market2.noPrice < 0.5, "buying YES lowers no price");
assertClose(market2.yesPrice + market2.noPrice, 1.0, 0.001, "prices sum to 1");
assert(Object.keys(market2.yesShares).includes("agent-A"), "agent-A has YES shares");
assert(market2.yesShares["agent-A"] === 100, "agent-A has exactly 100 YES shares");

console.log(`  Prices after 100 YES: yes=${market2.yesPrice.toFixed(4)}, no=${market2.noPrice.toFixed(4)}`);

// Test 3: Buy NO shares → price should move back
const order2: MarketOrder = {
  claimId: "claim-1",
  agentId: "agent-B",
  side: "no",
  amount: 80,
  timestamp: Date.now(),
};

const { market: market3 } = buyShares(market2, order2);
assert(market3.yesPrice < market2.yesPrice, "buying NO lowers yes price");
assert(market3.noPrice > market2.noPrice, "buying NO raises no price");
assertClose(market3.yesPrice + market3.noPrice, 1.0, 0.001, "prices still sum to 1");
assert(Object.keys(market3.noShares).includes("agent-B"), "agent-B has NO shares");

console.log(`  Prices after 80 NO: yes=${market3.yesPrice.toFixed(4)}, no=${market3.noPrice.toFixed(4)}`);

// Test 4: More YES → push price high
const order3: MarketOrder = {
  claimId: "claim-1",
  agentId: "agent-C",
  side: "yes",
  amount: 500,
  timestamp: Date.now(),
};

const { market: market4 } = buyShares(market3, order3);
assert(market4.yesPrice > 0.85, "heavy YES buying pushes price above 0.85");
console.log(`  Prices after 500 more YES: yes=${market4.yesPrice.toFixed(4)}, no=${market4.noPrice.toFixed(4)}`);

// Test 5: Settlement — resolve as TRUE
const agents: Record<string, AgentState> = {
  "agent-A": {
    agentId: "agent-A",
    reputation: 0.5,
    tokenBalance: 900,
    correctPredictions: 0,
    totalPredictions: 0,
  },
  "agent-B": {
    agentId: "agent-B",
    reputation: 0.5,
    tokenBalance: 920,
    correctPredictions: 0,
    totalPredictions: 0,
  },
  "agent-C": {
    agentId: "agent-C",
    reputation: 0.5,
    tokenBalance: 500,
    correctPredictions: 0,
    totalPredictions: 0,
  },
};

const { market: resolvedMarket, agents: updatedAgents } = resolveMarket(market4, true, agents);

assert(resolvedMarket.resolution === "true", "market resolved as true");
assert(resolvedMarket.yesPrice === 1, "yes price is 1 after TRUE resolution");
assert(resolvedMarket.noPrice === 0, "no price is 0 after TRUE resolution");
assert(updatedAgents["agent-A"].correctPredictions === 1, "agent-A has 1 correct prediction");
assert(updatedAgents["agent-C"].correctPredictions === 1, "agent-C has 1 correct prediction");
assert(updatedAgents["agent-A"].tokenBalance > 900, "winners gain tokens");
assert(updatedAgents["agent-B"].tokenBalance <= 920, "loser loses tokens");
assert(updatedAgents["agent-A"].reputation > 0.5, "winner reputation increases");
assert(updatedAgents["agent-B"].reputation < 0.5, "loser reputation decreases");

console.log(`  After settlement: A balance=${updatedAgents["agent-A"].tokenBalance.toFixed(1)}, B balance=${updatedAgents["agent-B"].tokenBalance.toFixed(1)}`);
console.log(`  Reputations: A=${updatedAgents["agent-A"].reputation.toFixed(3)}, B=${updatedAgents["agent-B"].reputation.toFixed(3)}`);

// Test 6: Multiple agent market
console.log("\n--- Multi-agent market scenario ---");
const m2 = createMarket("claim-2", 2000, 200);

// Three agents express varying confidence via market orders
const agents2: Record<string, AgentState> = {
  "alice": { agentId: "alice", reputation: 0.7, tokenBalance: 500, correctPredictions: 7, totalPredictions: 10 },
  "bob": { agentId: "bob", reputation: 0.5, tokenBalance: 500, correctPredictions: 5, totalPredictions: 10 },
  "carol": { agentId: "carol", reputation: 0.3, tokenBalance: 500, correctPredictions: 3, totalPredictions: 10 },
};

// Alice is confident YES
const { market: mAlice } = buyShares(m2, {
  claimId: "claim-2", agentId: "alice", side: "yes", amount: 300, timestamp: Date.now(),
});
console.log(`  After Alice (YES 300): yes_price=${mAlice.yesPrice.toFixed(4)}`);

// Bob is weakly NO
const { market: mBob } = buyShares(mAlice, {
  claimId: "claim-2", agentId: "bob", side: "no", amount: 100, timestamp: Date.now(),
});
console.log(`  After Bob (NO 100): yes_price=${mBob.yesPrice.toFixed(4)}`);

// Carol is strongly NO
const { market: mCarol } = buyShares(mBob, {
  claimId: "claim-2", agentId: "carol", side: "no", amount: 250, timestamp: Date.now(),
});
console.log(`  After Carol (NO 250): yes_price=${mCarol.yesPrice.toFixed(4)}`);

assert(mCarol.yesPrice < mAlice.yesPrice, "combined NO buying lowers yes price");

// Resolve as FALSE (reality check)
const { market: mResolved, agents: agentsAfter } = resolveMarket(mCarol, false, agents2);
assert(mResolved.resolution === "false", "market resolved as false");
assert(agentsAfter["bob"].correctPredictions === 6, "bob got +1 correct for predicting NO");
assert(agentsAfter["carol"].correctPredictions === 4, "carol got +1 correct for predicting NO");
assert(agentsAfter["alice"].correctPredictions === 7, "alice did NOT get correct for being wrong");
assert(agentsAfter["carol"].tokenBalance > agentsAfter["alice"].tokenBalance, "NO betters profit from FALSE resolution");

console.log(`  After FALSE resolution: bob tokens=${agentsAfter["bob"].tokenBalance.toFixed(1)}, carol tokens=${agentsAfter["carol"].tokenBalance.toFixed(1)}`);

// Test 7: Rent score computation
console.log("\n--- Rent Score Tests ---");
const rentAgent: AgentState = {
  agentId: "idea-7",
  reputation: 0,
  tokenBalance: 0,
  correctPredictions: 8,
  totalPredictions: 10,
};
const highRent = computeRentScore(rentAgent, 5, 2.5, 30, 7);
const lowRent = computeRentScore(
  { ...rentAgent, correctPredictions: 2, totalPredictions: 10 },
  0, 0, 2, 0
);

assert(highRent > lowRent, "ideas with better predictions + children + citations earn higher rent");
assert(highRent > 0.5, "high-performing idea earns substantial rent");
console.log(`  High rent: ${highRent.toFixed(4)}, Low rent: ${lowRent.toFixed(4)}`);

// Test 8: Edge cases
console.log("\n--- Edge Cases ---");
const emptyMarket = createMarket("empty");
const { market: tinyBuy } = buyShares(emptyMarket, {
  claimId: "empty", agentId: "x", side: "yes", amount: 1, timestamp: Date.now(),
});
assertClose(tinyBuy.yesPrice + tinyBuy.noPrice, 1.0, 0.001, "prices sum to 1 even with tiny orders");

const { market: hugeBuy } = buyShares(emptyMarket, {
  claimId: "empty", agentId: "y", side: "yes", amount: 5000, timestamp: Date.now(),
});
assert(hugeBuy.yesPrice > 0.99, "overwhelming YES buying pushes price near 1.0");

console.log(`\n========================================`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
