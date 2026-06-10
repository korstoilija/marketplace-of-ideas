import { evaluateClaimMulti, aggregateVerdicts } from "./src/evaluate/sub-agent.js";

const DEEPSEEK_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
const MISTRAL_KEY = process.env["MISTRAL_API_KEY"] ?? "";

if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY not set.");
  process.exit(0);
}

console.log("=== MULTI-PROVIDER DIVERGENCE: Fisher's Variance as Signal ===\n");

const claim = {
  id: "divergence-test",
  text: "Cryptocurrency will replace fiat currency as the dominant medium of exchange by 2040",
  supporting: [
    "Bitcoin market cap has grown from $0 to $1T+ in 15 years — adoption curve matches internet",
    "El Salvador and CAR have adopted Bitcoin as legal tender; 20+ countries exploring CBDCs",
    "Lightning Network enables instant, near-zero-fee transactions — solving scalability",
    "DeFi protocols now handle $50B+ in total value locked without intermediaries",
  ],
  counter: [
    "Bitcoin processes ~7 TPS vs Visa's 65,000 TPS — orders of magnitude too slow",
    "Bitcoin mining consumes more electricity than Argentina annually — environmentally unsustainable",
    "Governments can and do ban crypto: China, India, Nigeria have restricted or banned",
    "Price volatility makes it unusable as medium of exchange: BTC dropped 73% in 2022",
    "SWIFT processes $5T/day across 200+ countries — network effects are enormous",
  ],
};

async function main() {
  const available = [];
  if (DEEPSEEK_KEY) available.push("deepseek" as const);
  if (MISTRAL_KEY) available.push("mistral" as const);

  if (available.length < 2) {
    console.log("Only DeepSeek available — skipping multi-provider test.");
    console.log("Set MISTRAL_API_KEY for cross-model divergence analysis.");
    return;
  }

  console.log(`Evaluating with ${available.length} providers: ${available.join(", ")}...\n`);

  const results = await evaluateClaimMulti(claim.id, claim.text, {
    supporting: claim.supporting,
    counter: claim.counter,
  }, available);

  console.log("Individual verdicts:\n");
  for (const r of results) {
    const v = r.verdict;
    console.log(`  [${r.provider.padEnd(12)} / ${r.model.padEnd(25)}] confidence=${v.confidence.toFixed(3)}`);
    console.log(`    ${v.reasoning.slice(0, 120)}...\n`);
  }

  const aggregate = aggregateVerdicts(results);
  console.log("─────────────────────────────────────────────────");
  console.log(`  AGGREGATE:
    Mean confidence: ${aggregate.verdict.confidence.toFixed(3)}
    Consensus:       ${aggregate.consensus.toFixed(3)}  (1 = perfect agreement)
    Divergence:      ${aggregate.divergence.toFixed(3)}  (0 = perfect agreement)
    Sources:         ${aggregate.sources.join(", ")}
  `);

  if (aggregate.divergence > 0.15) {
    console.log("  ⚡ HIGH DIVERGENCE — this is where the market learns fastest.");
    console.log("  Fisher's theorem: the rate of evolution equals the variance.");
    console.log("  This claim should be prioritized for deeper investigation.");
  } else if (aggregate.divergence > 0.05) {
    console.log("  ℹ️ Moderate divergence — providers see this differently.");
    console.log("  Worth a second round of evaluation with new evidence.");
  } else {
    console.log("  ✓ Low divergence — providers largely agree.");
    console.log("  This claim is cheap to resolve (low information potential).");
  }

  console.log("\n─────────────────────────────────────────────────");
  console.log("  PRICE DISCOVERY SIMULATION:");
  console.log("  If each provider stakes on their verdict in an LMSR market:");
  console.log("  - Mean price would converge to ~" + aggregate.verdict.confidence.toFixed(2));
  console.log("  - Spread reflects genuine uncertainty");
  console.log("  - Agents who bet correctly earn; those who bet wrong lose");
  console.log("  - This IS the price mechanism — no debating needed");
  console.log();
}

main().catch(console.error);
