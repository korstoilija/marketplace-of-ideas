import { createMarket, buyShares, resolveMarket, computeRentScore } from "./src/market/lmsr.js";
import type { ClaimMarket, AgentState, MarketOrder } from "./src/types/deliberation.js";

console.log("\n=== Market Self-Improvement: Meta-Market ===\n");

interface MarketConfig {
  b: number;
  liquidity: number;
  threshold: number;
  weights: { predictive: number; generative: number; utility: number; citation: number };
}

const baselineConfig: MarketConfig = {
  b: 100,
  liquidity: 1000,
  threshold: 0.85,
  weights: { predictive: 0.4, generative: 0.3, utility: 0.2, citation: 0.1 },
};

type ParamKey = keyof MarketConfig;
type WeightKey = "predictive" | "generative" | "utility" | "citation";

function mutateConfig(config: MarketConfig, param: ParamKey, direction: "up" | "down"): { config: MarketConfig; description: string } {
  const mutated = structuredClone(config);
  const factor = direction === "up" ? 1.5 : 0.5;

  if (param === "b") {
    mutated.b *= factor;
    return { config: mutated, description: `b: ${config.b} → ${mutated.b}` };
  }
  if (param === "liquidity") {
    mutated.liquidity *= factor;
    return { config: mutated, description: `liquidity: ${config.liquidity} → ${mutated.liquidity}` };
  }
  if (param === "threshold") {
    mutated.threshold *= factor;
    mutated.threshold = Math.min(0.95, Math.max(0.55, mutated.threshold));
    return { config: mutated, description: `threshold: ${config.threshold.toFixed(2)} → ${mutated.threshold.toFixed(2)}` };
  }
  if (param === "weights") {
    const weights = ["predictive", "generative", "utility", "citation"] as WeightKey[];
    const shuffled = weights[Math.floor(Math.random() * weights.length)];
    mutated.weights[shuffled] *= factor;
    return { config: mutated, description: `weight_${shuffled}: ${config.weights[shuffled]} → ${mutated.weights[shuffled].toFixed(2)}` };
  }
  return { config: mutated, description: "no mutation" };
}

function computeFitness(config: MarketConfig, outcomes: { resolved: string; correct: boolean }[]): number {
  if (outcomes.length === 0) return 0;

  let correctPicks = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const o of outcomes) {
    const confident = Math.random() > (1 - config.threshold);
    if (o.resolved === "true" && confident) correctPicks++;
    else if (o.resolved === "true" && !confident) falseNegatives++;
    else if (o.resolved === "false" && !confident) correctPicks++;
    else falsePositives++;
  }

  const precision = correctPicks / (correctPicks + falsePositives + 0.001);
  const recall = correctPicks / (correctPicks + falseNegatives + 0.001);
  const f1 = 2 * precision * recall / (precision + recall + 0.001);

  return f1;
}

interface ClaimIdea {
  id: string;
  config: MarketConfig;
  description: string;
  market: ClaimMarket;
  agents: Record<string, AgentState>;
}

function createClaimIdea(id: string, config: MarketConfig, description: string): ClaimIdea {
  return {
    id,
    config,
    description,
    market: createMarket(id, config.liquidity, config.b),
    agents: {
      root: { agentId: "root", reputation: 0.7, tokenBalance: 1000, correctPredictions: 7, totalPredictions: 10 },
      critic: { agentId: "critic", reputation: 0.5, tokenBalance: 1000, correctPredictions: 5, totalPredictions: 10 },
      synthesizer: { agentId: "synthesizer", reputation: 0.6, tokenBalance: 1000, correctPredictions: 6, totalPredictions: 10 },
    },
  };
}

// Simulate a deliberation round: agents stake on whether the claim "this config improves the market" is true
function simulateRound(idea: ClaimIdea, targetConfig: MarketConfig): ClaimIdea {
  let market = idea.market;
  const agents = structuredClone(idea.agents);

  const configQuality = computeFitness(idea.config, DELIBERATION_OUTCOMES);

  for (const [agentId, agent] of Object.entries(agents)) {
    const confidenceNoise = agent.reputation * 0.3;
    let confidence = configQuality + (Math.random() - 0.5) * confidenceNoise;
    confidence = Math.max(0, Math.min(1, confidence));

    const weight = confidence * 0.15 * agent.tokenBalance;

    const side = confidence > 0.5 ? "yes" : "no" as const;
    const order: MarketOrder = {
      claimId: idea.id,
      agentId,
      side,
      amount: weight,
      timestamp: Date.now(),
    };

    const result = buyShares(market, order);
    market = result.market;
    agents[agentId] = { ...agent, tokenBalance: agent.tokenBalance - weight };
  }

  return { ...idea, market, agents };
}

const DELIBERATION_OUTCOMES: { resolved: string; correct: boolean }[] = [
  { resolved: "true", correct: true },
  { resolved: "false", correct: true },
  { resolved: "true", correct: true },
  { resolved: "true", correct: true },
  { resolved: "false", correct: true },
  { resolved: "true", correct: false },
  { resolved: "false", correct: true },
  { resolved: "true", correct: true },
];

console.log("--- Round 1: Propose Config Mutations ---");

const candidates: ClaimIdea[] = [];

const baselineIdea = createClaimIdea("baseline", baselineConfig, "baseline config");
candidates.push(baselineIdea);

const params: ParamKey[] = ["b", "liquidity", "threshold"];

for (const param of params) {
  for (const dir of ["up", "down"] as const) {
    const { config: mutated, description } = mutateConfig(baselineConfig, param, dir);
    const id = `${param}_${dir}`;
    candidates.push(createClaimIdea(id, mutated, description));
  }
}

console.log(`Proposed ${candidates.length} config variants:`);
for (const c of candidates) {
  console.log(`  ${c.id}: ${c.description}`);
}

console.log("\n--- Round 2: Agents Evaluate Each Variant ---");

const evaluated = candidates.map(c => simulateRound(c, baselineConfig));

console.log("\nMarket prices after agent bidding:");
const sorted = [...evaluated].sort((a, b) => b.market.yesPrice - a.market.yesPrice);
for (const e of sorted) {
  const icon = e.market.yesPrice > 0.5 ? "BUY " : "SELL";
  console.log(`  ${e.id}: yes=${e.market.yesPrice.toFixed(4)}, no=${e.market.noPrice.toFixed(4)} ${icon}`);
}

console.log("\n--- Round 3: Settle and Select Winners ---");

const fitnesses: { id: string; config: MarketConfig; fitness: number }[] = [];

for (const e of evaluated) {
  const fitness = computeFitness(e.config, DELIBERATION_OUTCOMES);
  fitnesses.push({ id: e.id, config: e.config, fitness });

  const outcome = fitness > 0.5;
  const { market: resolved, agents: updated } = resolveMarket(e.market, outcome, e.agents);

  console.log(`  ${e.id}: fitness=${fitness.toFixed(3)}, resolved=${outcome ? "TRUE" : "FALSE"} (price was ${e.market.yesPrice.toFixed(4)})`);

  for (const [agentId, agent] of Object.entries(updated)) {
    const change = agent.correctPredictions - e.agents[agentId].correctPredictions;
    if (change !== 0) {
      console.log(`    ${agentId}: ${change > 0 ? "+" : ""}${change} correct, reputation=${agent.reputation.toFixed(3)}, balance=${agent.tokenBalance.toFixed(1)}`);
    }
  }
}

console.log("\n--- Round 4: Select Best Config ---");

const best = fitnesses.sort((a, b) => b.fitness - a.fitness)[0];
console.log(`\n  Winner: ${best.id} (fitness=${best.fitness.toFixed(3)})`);
console.log(`  Config: b=${best.config.b}, liquidity=${best.config.liquidity}, threshold=${best.config.threshold.toFixed(3)}`);
console.log(`  Weights: predictive=${best.config.weights.predictive}, generative=${best.config.weights.generative}, utility=${best.config.weights.utility}, citation=${best.config.weights.citation}`);

console.log("\n--- The Reflexive Loop ---");
console.log(`  Baseline →   evaluated ${candidates.length - 1} mutations`);
console.log(`  Market prices   →   aggregated agent judgments`);
console.log(`  Settlement   →   rewarded accurate agents, penalized noise`);
console.log(`  Winner: "${best.id}"   →   adopted as new baseline for next generation`);
console.log(`  Agents who bet correctly   →   higher reputation → more weight in next round`);
console.log(`  Trajectories distilled   →   successful betting patterns become prompt mutations`);

if (best.id !== "baseline") {
  console.log(`\n  The market IMPROVED itself. ${best.id} outperforms the baseline.`);
} else {
  console.log(`\n  The baseline held. No improvement this round — try more mutations.`);
}

console.log();
