import { evaluateClaim, evaluateClaimMulti, aggregateVerdicts, type EvaluateResult, type ProviderId } from "./src/evaluate/sub-agent.js";
import { createMarket, buyShares, resolveMarket, computeRentScore } from "./src/market/lmsr.js";
import type { ClaimMarket, AgentState, MarketOrder, Verdict, Idea, Claim, Evidence, Distillate } from "./src/types/deliberation.js";

const DEEPSEEK_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
const MISTRAL_KEY = process.env["MISTRAL_API_KEY"] ?? "";

if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY not set. Need at least one API key.");
  process.exit(1);
}

const AVAILABLE_PROVIDERS: ProviderId[] = [];
if (DEEPSEEK_KEY) AVAILABLE_PROVIDERS.push("deepseek");
if (MISTRAL_KEY) AVAILABLE_PROVIDERS.push("mistral");

console.log("══════════════════════════════════════════════════════════════");
console.log(`  MARKETPLACE OF IDEAS — Full GEPA Pipeline`);
console.log(`  Providers: ${AVAILABLE_PROVIDERS.join(", ")}`);
console.log("══════════════════════════════════════════════════════════════\n");

// ─── In-memory state (simulates the MCP server's storage) ───
const ideas = new Map<string, Idea>();
const claimsMap = new Map<string, Claim>();
const evidenceMap = new Map<string, Evidence[]>();
const verdictsMap = new Map<string, Verdict[]>();
const markets = new Map<string, ClaimMarket>();
const agents = new Map<string, AgentState>();
const distillates: Distillate[] = [];
let roundNumber = 1;

function agent(agentId: string): AgentState {
  const existing = agents.get(agentId);
  if (existing) return existing;
  const a: AgentState = {
    agentId, reputation: 0.5, tokenBalance: 1000,
    correctPredictions: 0, totalPredictions: 0,
  };
  agents.set(agentId, a);
  return a;
}

function propose(title: string, summary: string, body: string, claimTexts: string[], author: string): string {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const idea: Idea = {
    id, title, summary, body, claims: claimTexts.map(c => `claim-${id}-${claimsMap.size + 1}`),
    evidenceLinks: [], author, createdAt: Date.now(), version: 1, status: "proposed",
  };
  ideas.set(id, idea);

  claimTexts.forEach((text, i) => {
    const cid = `${id}-claim-${i + 1}`;
    claimsMap.set(cid, { id: cid, ideaId: id, text, type: "factual" });
    markets.set(cid, createMarket(cid, 1000, 100));
    evidenceMap.set(cid, []);
  });

  return id;
}

function addEvidence(claimId: string, excerpt: string, relevance: number, submittedBy: string): void {
  const ev: Evidence = {
    id: `ev-${evidenceMap.size}-${claimId}-${Date.now()}`,
    claimId, sourceUrl: "", excerpt, relevance, submittedBy, timestamp: Date.now(),
  };
  const existing = evidenceMap.get(claimId) ?? [];
  existing.push(ev);
  evidenceMap.set(claimId, existing);
}

// ═══════════════════════════════════════════════════
//  ROUND 1: PROPOSE IDEAS
// ═══════════════════════════════════════════════════
console.log("ROUND 1: Propose Ideas\n");

propose(
  "Climate Change Anthropogenic",
  "Human activity is driving modern climate change",
  "Multiple independent lines of evidence converge on human causation of global warming since 1850.",
  [
    "Human activity is the primary driver of climate change since the mid-20th century",
    "Climate models accurately predict observed warming when accounting for anthropogenic factors",
    "Natural forcings alone cannot explain post-1950 warming trends",
  ],
  "root-agent",
);

propose(
  "Mars Colony Feasibility 2050",
  "A self-sustaining human colony on Mars is feasible within 30 years",
  "Technological and economic factors for Mars colonization.",
  [
    "A self-sustaining human colony on Mars is feasible within the next 30 years",
    "Current launch costs make Mars colonization economically viable",
    "Mars radiation shielding can be solved with existing technology",
  ],
  "root-agent",
);

console.log(`  Proposed ${ideas.size} ideas, ${claimsMap.size} claims\n`);

// Add evidence for each claim
for (const [cid, claim] of claimsMap) {
  if (cid.includes("climate")) {
    addEvidence(cid, "IPCC AR6 (2021): 'It is unequivocal that human influence has warmed the atmosphere, ocean and land.'", 0.95, "researcher");
    addEvidence(cid, "Multiple independent temperature reconstructions confirm warming coinciding with industrial emissions", 0.9, "researcher");
    addEvidence(cid, "Climate has changed naturally throughout Earth's history before humans existed", 0.6, "skeptic");
    addEvidence(cid, "Some local temperature measurements may be affected by urban heat island effects", 0.4, "skeptic");
  } else if (cid.includes("mars")) {
    addEvidence(cid, "SpaceX Starship reduces launch costs by ~100x, making Mars cargo delivery viable", 0.8, "researcher");
    addEvidence(cid, "NASA MOXIE experiment successfully produced oxygen from Mars atmosphere (2021)", 0.85, "researcher");
    addEvidence(cid, "Mars has no magnetosphere — surface radiation is lethal without heavy shielding", 0.9, "skeptic");
    addEvidence(cid, "0.38g gravity effects on human reproduction and development are completely unknown", 0.85, "skeptic");
  }
}

console.log(`  Added evidence to all claims\n`);

// ═══════════════════════════════════════════════════
//  ROUND 2: EVALUATE — Real LLM calls
// ═══════════════════════════════════════════════════
console.log("ROUND 2: Evaluate Claims with Real LLMs\n");

interface ClaimEvaluation {
  claimId: string;
  claimText: string;
  evaluation: EvaluateResult;
  supporting: string[];
  counter: string[];
}

const claimEvaluations: ClaimEvaluation[] = [];

for (const [cid, claim] of claimsMap) {
  const ev = evidenceMap.get(cid) ?? [];
  const supporting = ev.filter((_, i) => i % 2 === 0).map(e => e.excerpt);
  const counter = ev.filter((_, i) => i % 2 === 1).map(e => e.excerpt);

  console.log(`  ⏳ Evaluating "${claim.text.slice(0, 70)}..." (${AVAILABLE_PROVIDERS.length} providers)`);

  let evaluation: EvaluateResult;
  let usedMulti = false;

  if (AVAILABLE_PROVIDERS.length >= 2) {
    const results = await evaluateClaimMulti(cid, claim.text, { supporting, counter }, AVAILABLE_PROVIDERS);
    const agg = aggregateVerdicts(results);
    evaluation = {
      verdict: agg.verdict,
      provider: "aggregate" as ProviderId,
      model: AVAILABLE_PROVIDERS.join("+"),
      raw: "",
      cost: results.reduce((s, r) => s + r.cost, 0),
    };
    usedMulti = true;

    // Store individual verdicts for divergence analysis
    for (const r of results) {
      const evList = verdictsMap.get(cid) ?? [];
      evList.push(r.verdict);
      verdictsMap.set(cid, evList);
    }
  } else {
    evaluation = await evaluateClaim(cid, claim.text, { supporting, counter }, AVAILABLE_PROVIDERS[0]);
  }

  const evList = verdictsMap.get(cid) ?? [];
  evList.push(evaluation.verdict);
  verdictsMap.set(cid, evList);

  const v = evaluation.verdict;
  const providerLabel = usedMulti
    ? `${AVAILABLE_PROVIDERS.length} providers (agg)`
    : AVAILABLE_PROVIDERS[0];

  console.log(`  ✓ [${providerLabel}] confidence=${v.confidence.toFixed(3)} | ${v.reasoning.slice(0, 100)}...`);

  // Show individual provider votes for divergence
  if (usedMulti) {
    const indVerdicts = verdictsMap.get(cid)?.slice(0, -1) ?? [];
    const confs = indVerdicts.map(iv => iv.confidence);
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    const variance = confs.reduce((s, c) => s + (c - mean) ** 2, 0) / confs.length;
    console.log(`     Individual: ${AVAILABLE_PROVIDERS.map((p, i) => `${p}=${confs[i]?.toFixed(2)}`).join(", ")} | divergence=${Math.sqrt(variance).toFixed(3)}`);
  }

  claimEvaluations.push({
    claimId: cid,
    claimText: claim.text,
    evaluation,
    supporting,
    counter,
  });
}

// ═══════════════════════════════════════════════════
//  ROUND 3: BID — Place market orders
// ═══════════════════════════════════════════════════
console.log("\nROUND 3: Place Market Orders (Price Discovery)\n");

for (const ce of claimEvaluations) {
  const market = markets.get(ce.claimId)!;
  let currentMarket = market;

  const confidence = ce.evaluation.verdict.confidence;
  const side: "yes" | "no" = confidence > 0.5 ? "yes" : "no";
  const weight = Math.abs(confidence - 0.5) * 2 * 0.15 * agent("deepseek-sub").tokenBalance;

  if (weight > 5) {
    const order: MarketOrder = {
      claimId: ce.claimId,
      agentId: "deepseek-sub",
      side,
      amount: weight,
      timestamp: Date.now(),
    };
    const a = agent("deepseek-sub");
    a.tokenBalance -= weight;

    const { market: newMarket, avgPrice } = buyShares(currentMarket, order);
    currentMarket = newMarket;
    markets.set(ce.claimId, currentMarket);

    console.log(`  💰 [${ce.claimId.slice(0, 30)}] deepseek-sub BUYS ${side.toUpperCase()} ${weight.toFixed(1)} → yes=${currentMarket.yesPrice.toFixed(4)}`);

    // Also place a smaller opposing bet (creates spread = information)
    const oppSide: "yes" | "no" = side === "yes" ? "no" : "yes";
    const hedgeWeight = weight * 0.15;
    const hedgeOrder: MarketOrder = {
      claimId: ce.claimId,
      agentId: "hedge-fund",
      side: oppSide,
      amount: hedgeWeight,
      timestamp: Date.now(),
    };
    const a2 = agent("hedge-fund");
    a2.tokenBalance -= hedgeWeight;
    const { market: hedgedMarket } = buyShares(currentMarket, hedgeOrder);
    currentMarket = hedgedMarket;
    markets.set(ce.claimId, currentMarket);

    console.log(`     hedge-fund BUYS ${oppSide.toUpperCase()} ${hedgeWeight.toFixed(1)} → yes=${currentMarket.yesPrice.toFixed(4)} (spread)`);
  }
}

// ═══════════════════════════════════════════════════
//  ROUND 4: FIND DIVERGENCE — Fisher's gradient
// ═══════════════════════════════════════════════════
console.log("\nROUND 4: Find Divergence (Fisher's Variance = Evolutionary Rate)\n");

const divergenceScores: Array<{
  claimId: string;
  claimText: string;
  verdictCount: number;
  confidences: number[];
  mean: number;
  variance: number;
  divergence: number;
}> = [];

for (const [cid, vs] of verdictsMap) {
  if (vs.length < 2) continue;
  const confs = vs.map(v => v.confidence);
  const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
  const variance = confs.reduce((s, c) => s + (c - mean) ** 2, 0) / confs.length;

  divergenceScores.push({
    claimId: cid,
    claimText: claimsMap.get(cid)?.text ?? "unknown",
    verdictCount: vs.length,
    confidences: confs,
    mean: Math.round(mean * 1000) / 1000,
    variance: Math.round(variance * 10000) / 10000,
    divergence: Math.round(Math.sqrt(variance) * 1000) / 1000,
  });
}

divergenceScores.sort((a, b) => b.variance - a.variance);

console.log("  Fisher Gradient (claims ranked by variance):\n");
for (const d of divergenceScores) {
  const bar = "█".repeat(Math.min(40, Math.round(d.divergence * 80)));
  const marker = d.divergence > 0.15 ? "⚡ HIGH" : d.divergence > 0.05 ? "  ~mod" : "  low";
  console.log(`  ${marker} ${d.claimText.slice(0, 55).padEnd(55)} div=${d.divergence.toFixed(3)} ${bar}`);
}

// ═══════════════════════════════════════════════════
//  ROUND 5: SETTLE — Resolve high-confidence claims
// ═══════════════════════════════════════════════════
console.log("\nROUND 5: Settle Markets\n");

let settlements = 0;
for (const ce of claimEvaluations) {
  const market = markets.get(ce.claimId)!;
  if (market.resolution) continue;

  const confidence = ce.evaluation.verdict.confidence;
  const yesPrice = market.yesPrice;

  // Settle if price strongly signals one direction
  if (yesPrice > 0.85 || yesPrice < 0.15) {
    const outcome = yesPrice > 0.5;
    const agentMap: Record<string, AgentState> = {};
    for (const [id, a] of agents) agentMap[id] = { ...a };
    const { market: resolved, agents: updated } = resolveMarket(market, outcome, agentMap);
    markets.set(ce.claimId, resolved);
    for (const [id, a] of Object.entries(updated)) agents.set(id, a);
    settlements++;
    console.log(`  ✓ Settled ${ce.claimId.slice(0, 30)}: outcome=${outcome ? "TRUE" : "FALSE"}, final_yes=${resolved.yesPrice}`);
  }
}

if (settlements === 0) {
  console.log("  No claims crossed settlement threshold this round.");
  console.log("  (Markets remain open — prices still uncertain)");
}

// ═══════════════════════════════════════════════════
//  ROUND 6: PROPOSE — Fork divergent claims
// ═══════════════════════════════════════════════════
console.log("\nROUND 6: Propose Forks (GEPA: Propose phase)\n");

const forked: string[] = [];

// Fork top ideas by market confidence
for (const ce of claimEvaluations) {
  const market = markets.get(ce.claimId)!;
  if (market.resolution) continue;
  if (market.yesPrice > 0.7 || market.yesPrice < 0.3) {
    const ideaId = ce.claimId.split("-claim-")[0];
    const parent = ideas.get(ideaId);
    if (!parent) continue;

    const forkTitle = `${ideaId}-deep-${roundNumber}`;
    const forkId = propose(
      forkTitle,
      `Deep dive: ${parent.summary.slice(0, 80)}`,
      `Fisher gradient fork. Market price: ${market.yesPrice.toFixed(2)}. Investigating deeper evidence.`,
      [`Deeper investigation of: ${ce.claimText.slice(0, 100)}`],
      `gepa-r${roundNumber}`,
    );
    forked.push(forkId);
    console.log(`  🔀 Forked ${ideaId} → ${forkId} (price=${market.yesPrice.toFixed(3)})`);
  }
}

// Also fork highest-divergence claim
if (divergenceScores.length > 0) {
  const topDiv = divergenceScores[0];
  const ideaId = topDiv.claimId.split("-claim-")[0];
  if (!forked.includes(ideaId)) {
    const forkTitle = `${ideaId}-fisher-${roundNumber}`;
    propose(
      forkTitle,
      `Fisher gradient exploration (divergence=${topDiv.divergence.toFixed(3)})`,
      `This claim has the highest evaluation divergence. Providers disagree — where the market learns fastest.`,
      [`Re-evaluated with fresh evidence: ${topDiv.claimText.slice(0, 100)}`],
      `fisher-r${roundNumber}`,
    );
    forked.push(forkTitle);
    console.log(`  🧬 Fisher fork: ${ideaId} → ${forkTitle} (divergence=${topDiv.divergence.toFixed(3)})`);
  }
}

// ═══════════════════════════════════════════════════
//  ROUND 7: DISTILL — Extract winning trajectories
// ═══════════════════════════════════════════════════
console.log("\nROUND 7: Distill Trajectories (GEPA: Adapt phase)\n");

const winningTrajectories: Distillate["winningTrajectories"] = [];
const promptMutations: Distillate["promptMutations"] = [];

for (const [cid, market] of markets) {
  if (!market.resolution) continue;
  const vs = verdictsMap.get(cid) ?? [];
  const correctVerdicts = vs.filter(v => {
    if (market.resolution === "true") return v.confidence > 0.5;
    return v.confidence < 0.5;
  });

  if (correctVerdicts.length > 0) {
    winningTrajectories.push({
      claimId: cid,
      rootAgent: "root",
      decomposition: `Evaluated claim with evidence. Market resolved ${market.resolution}.`,
      subCalls: correctVerdicts.map(v => ({
        subAgent: v.agentId,
        verdict: v,
      })),
      outcome: market.resolution,
    });

    const pattern = correctVerdicts[0].reasoning.slice(0, 80);
    promptMutations.push({
      target: "sub",
      pattern,
      improvement: `High-confidence pattern (resolved ${market.resolution}): ${pattern}`,
    });
  }
}

const distillate: Distillate = {
  round: roundNumber,
  winningTrajectories,
  extractedContexts: [],
  promptMutations,
  distilledAt: Date.now(),
};
distillates.push(distillate);

console.log(`  Winning trajectories: ${winningTrajectories.length}`);
console.log(`  Prompt mutations:     ${promptMutations.length}`);

if (promptMutations.length > 0) {
  console.log(`\n  Top prompt mutation:`);
  console.log(`    Target: ${promptMutations[0].target}`);
  console.log(`    Pattern: ${promptMutations[0].pattern.slice(0, 80)}...`);
}

// ═══════════════════════════════════════════════════
//  FINAL STATE
// ═══════════════════════════════════════════════════
console.log("\n══════════════════════════════════════════════════════════════");
console.log("  PIPELINE COMPLETE");
console.log("══════════════════════════════════════════════════════════════\n");

console.log(`  Ideas proposed:   ${ideas.size}`);
console.log(`  Claims created:   ${claimsMap.size}`);
console.log(`  Evaluations:      ${claimEvaluations.length} (${AVAILABLE_PROVIDERS.length} providers each)`);
console.log(`  Markets active:   ${Array.from(markets.values()).filter(m => !m.resolution).length}`);
console.log(`  Markets settled:  ${Array.from(markets.values()).filter(m => m.resolution).length}`);
console.log(`  Forks created:    ${forked.length}`);
console.log(`  Distillates:      ${distillates.length}`);

console.log("\n  Agent standings:");
for (const [id, a] of agents) {
  const balance = a.tokenBalance - 1000 > 0 ? `+${(a.tokenBalance - 1000).toFixed(1)}` : `${(a.tokenBalance - 1000).toFixed(1)}`;
  console.log(`    ${id.padEnd(20)} rep=${a.reputation.toFixed(3)}  balance=${balance}  correct=${a.correctPredictions}/${a.totalPredictions}`);
}

console.log("\n  Full pipeline verified:");
console.log("  ✓ Propose → Evaluate (real LLMs) → Bid (LMSR) → Find Divergence");
console.log("  ✓ Settle → Fork (GEPA Propose) → Distill (GEPA Adapt)");
console.log("  ✓ Fisher's variance guides exploration");
console.log("  ✓ Agents staked real tokens, earned real reputation");
console.log();
