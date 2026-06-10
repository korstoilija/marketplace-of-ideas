import { evaluateClaim, type EvaluateResult } from "./src/evaluate/sub-agent.js";
import { createMarket, buyShares, resolveMarket } from "./src/market/lmsr.js";
import type { ClaimMarket, AgentState, MarketOrder, Verdict } from "./src/types/deliberation.js";

const DEEPSEEK_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY not set. Skipping real LLM test.");
  process.exit(0);
}

console.log("=== REAL END-TO-END: DeepSeek Evaluation → LMSR Market → Settlement ===\n");

interface TestClaim {
  id: string;
  text: string;
  supporting: string[];
  counter: string[];
  expectedTruth: boolean;
}

const claims: TestClaim[] = [
  {
    id: "climate-human",
    text: "Human activity is the primary driver of climate change since the mid-20th century",
    supporting: [
      "IPCC AR6 (2021): 'It is unequivocal that human influence has warmed the atmosphere, ocean and land.'",
      "Multiple independent temperature reconstructions show warming coinciding with industrial CO2 emissions",
      "Satellite measurements confirm CO2 increase is from fossil fuel burning (carbon isotope ratios)",
    ],
    counter: [
      "Climate has changed naturally throughout Earth's history before humans existed",
      "Some local temperature measurements may be affected by urban heat island effects",
      "Solar activity variations could explain some portion of observed warming",
    ],
    expectedTruth: true,
  },
  {
    id: "remote-work",
    text: "Remote work increases overall productivity compared to office-only work",
    supporting: [
      "Stanford study (2023): remote workers were 13% more productive than office workers",
      "Reduced commute time → 1.5h/day reclaimed for work or rest",
      "Companies report lower real estate costs and access to global talent pools",
    ],
    counter: [
      "Junior employees learn less without in-person mentorship",
      "Creative collaboration suffers without spontaneous in-person interactions",
      "Some Fortune 500 companies (Amazon, JPMorgan) have mandated return to office",
    ],
    expectedTruth: true,
  },
  {
    id: "mars-colony",
    text: "A self-sustaining human colony on Mars is feasible within the next 30 years",
    supporting: [
      "SpaceX Starship reduces launch costs by ~100x, making cargo delivery economically viable",
      "ISRU (In-Situ Resource Utilization) tech exists for water extraction from Martian regolith",
      "NASA Perseverance MOXIE experiment successfully produced oxygen from Mars atmosphere in 2021",
    ],
    counter: [
      "Mars has no magnetosphere — surface radiation levels are lethal without heavy shielding",
      "0.38g gravity effects on human reproduction and development are completely unknown",
      "Political and funding continuity over 30-year timelines is unprecedented for space projects",
    ],
    expectedTruth: false,
  },
  {
    id: "agi-timeline",
    text: "Artificial General Intelligence (human-level across all cognitive tasks) will be achieved by 2030",
    supporting: [
      "Scaling laws show no signs of plateauing; compute and data continue to grow exponentially",
      "Frontier models now score above 90th percentile on PhD-level benchmarks across multiple domains",
      "Multiple AI lab leaders (Anthropic, OpenAI) have stated AGI is likely within 5 years",
    ],
    counter: [
      "Current models still fail at basic reasoning tasks that humans find trivial",
      "Hallucination rates remain high (10-30%) even in state-of-the-art models",
      "Expert surveys (e.g. Grace et al. 2024) show median AGI prediction around 2047, not 2030",
    ],
    expectedTruth: false,
  },
];

interface DeliberationResult {
  claim: TestClaim;
  evaluation: EvaluateResult;
  market: ClaimMarket;
  finalState: { market: ClaimMarket; agents: Record<string, AgentState> };
  priceWasCorrect: boolean;
}

async function runFullDeliberation(claim: TestClaim): Promise<DeliberationResult> {
  console.log(`\n━━━ CLAIM: "${claim.text.slice(0, 80)}..." ━━━`);
  console.log(`  Supporting: ${claim.supporting.length} items, Counter: ${claim.counter.length} items`);

  // STEP 1: Real LLM evaluation
  console.log("  ⏳ Evaluating with DeepSeek...");
  const startTime = Date.now();
  const evaluation = await evaluateClaim(claim.id, claim.text, {
    supporting: claim.supporting,
    counter: claim.counter,
  }, "deepseek");
  const evalTime = Date.now() - startTime;

  const v = evaluation.verdict;
  console.log(`  ✓ DeepSeek verdict: confidence=${v.confidence.toFixed(3)} (${evalTime}ms)`);
  console.log(`    Reasoning: ${v.reasoning.slice(0, 150)}...`);

  // STEP 2: Create LMSR market
  const market = createMarket(claim.id, 1000, 100);
  console.log(`  ✓ Market created: yes=${market.yesPrice.toFixed(3)} no=${market.noPrice.toFixed(3)}`);

  // STEP 3: Agents place orders based on evaluation
  const agents: Record<string, AgentState> = {
    "sub-deepseek": {
      agentId: "sub-deepseek",
      reputation: 0.7,
      tokenBalance: 1000,
      correctPredictions: 7,
      totalPredictions: 10,
    },
    "sub-anthropic": {
      agentId: "sub-anthropic",
      reputation: 0.5,
      tokenBalance: 1000,
      correctPredictions: 5,
      totalPredictions: 10,
    },
  };

  let currentMarket = market;
  const currentAgents = structuredClone(agents);

  // DeepSeek sub-agent trades based on its evaluation
  const dsWeight = Math.abs(v.confidence - 0.5) * 2 * 0.15 * currentAgents["sub-deepseek"].tokenBalance;
  const dsSide: "yes" | "no" = v.confidence > 0.5 ? "yes" : "no";

  if (dsWeight > 0) {
    const dsOrder: MarketOrder = {
      claimId: claim.id,
      agentId: "sub-deepseek",
      side: dsSide,
      amount: dsWeight,
      timestamp: Date.now(),
    };
    const { market: newMarket, avgPrice } = buyShares(currentMarket, dsOrder);
    currentMarket = newMarket;
    currentAgents["sub-deepseek"].tokenBalance -= dsWeight;
    console.log(`  💰 sub-deepseek BUYS ${dsSide.toUpperCase()} ${dsWeight.toFixed(1)} tokens → yes_price=${currentMarket.yesPrice.toFixed(4)} (avg_price=${avgPrice.toFixed(4)})`);
  }

  // Anthropic sub-agent hedges slightly opposite (diversity = value)
  const anthSide: "yes" | "no" = v.confidence > 0.5 ? "no" : "yes";
  const anthWeight = 0.05 * currentAgents["sub-anthropic"].tokenBalance;
  const anthOrder: MarketOrder = {
    claimId: claim.id,
    agentId: "sub-anthropic",
    side: anthSide,
    amount: anthWeight,
    timestamp: Date.now(),
  };
  const { market: marketAfterAnth } = buyShares(currentMarket, anthOrder);
  currentMarket = marketAfterAnth;
  currentAgents["sub-anthropic"].tokenBalance -= anthWeight;
  console.log(`  💰 sub-anthropic BUYS ${anthSide.toUpperCase()} ${anthWeight.toFixed(1)} tokens → yes_price=${currentMarket.yesPrice.toFixed(4)}`);

  // STEP 4: Settle market
  const outcome = claim.expectedTruth;
  const { market: settled, agents: afterAgents } = resolveMarket(currentMarket, outcome, currentAgents);

  const dsGain = afterAgents["sub-deepseek"].tokenBalance - agents["sub-deepseek"].tokenBalance;
  const anthGain = afterAgents["sub-anthropic"].tokenBalance - agents["sub-anthropic"].tokenBalance;

  const priceWasCorrect = outcome
    ? settled.yesPrice === 1
    : settled.noPrice === 1;

  console.log(`  ✓ Settled: outcome=${outcome ? "TRUE" : "FALSE"}, price_was_correct=${priceWasCorrect}`);
  console.log(`    sub-deepseek: ${dsGain > 0 ? "+" : ""}${dsGain.toFixed(1)} tokens, rep=${afterAgents["sub-deepseek"].reputation.toFixed(3)}`);
  console.log(`    sub-anthropic: ${anthGain > 0 ? "+" : ""}${anthGain.toFixed(1)} tokens, rep=${afterAgents["sub-anthropic"].reputation.toFixed(3)}`);

  return {
    claim,
    evaluation,
    market: currentMarket,
    finalState: { market: settled, agents: afterAgents },
    priceWasCorrect,
  };
}

async function main() {
  console.log(`Evaluating ${claims.length} claims with DeepSeek (deepseek-chat)...\n`);

  const results: DeliberationResult[] = [];
  for (const claim of claims) {
    const result = await runFullDeliberation(claim);
    results.push(result);
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════\n");

  let correctEvaluations = 0;
  let correctMarkets = 0;
  let totalConfidence = 0;

  for (const r of results) {
    const verdictCorrect = (r.evaluation.verdict.confidence > 0.5) === r.claim.expectedTruth;
    const marketCorrect = r.priceWasCorrect;

    if (verdictCorrect) correctEvaluations++;
    if (marketCorrect) correctMarkets++;
    totalConfidence += r.evaluation.verdict.confidence;

    const evalIcon = verdictCorrect ? "✓" : "✗";
    const marketIcon = marketCorrect ? "✓" : "✗";

    console.log(`  ${r.claim.id.padEnd(18)} | eval=${evalIcon} conf=${r.evaluation.verdict.confidence.toFixed(2)} | market=${marketIcon} | ${r.evaluation.verdict.reasoning.slice(0, 80)}...`);
  }

  console.log(`\n  Evaluation accuracy: ${correctEvaluations}/${results.length} (${(correctEvaluations / results.length * 100).toFixed(0)}%)`);
  console.log(`  Market correctness:  ${correctMarkets}/${results.length} (${(correctMarkets / results.length * 100).toFixed(0)}%)`);
  console.log(`  Mean confidence:     ${(totalConfidence / results.length).toFixed(3)}`);

  if (correctEvaluations >= 3) {
    console.log("\n  ✓ Market engine + real LLM evaluation is working.");
  }

  console.log();
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
