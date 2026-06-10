import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  IdeaSchema,
  ClaimSchema,
  EvidenceSchema,
  VerdictSchema,
  MarketOrderSchema,
  ClaimMarketSchema,
  AgentStateSchema,
  DistillateSchema,
  PredictiveClaimSchema,
  RentScoreSchema,
  VerificationSchema,
  type Idea,
  type Claim,
  type Evidence,
  type Verdict,
  type MarketOrder,
  type ClaimMarket,
  type AgentState,
  type Distillate,
  type PredictiveClaim,
  type RentScore,
  type Verification,
} from "../../types/deliberation.js";
import {
  createMarket,
  buyShares,
  resolveMarket,
  computeRentScore,
  lmsrPrice,
} from "../../market/lmsr.js";
import { evaluateClaim } from "../../evaluate/sub-agent.js";

const ideas = new Map<string, Idea>();
const claims = new Map<string, Claim>();
const evidence = new Map<string, Evidence>();
const verdicts = new Map<string, Verdict[]>();
const markets = new Map<string, ClaimMarket>();
const agents = new Map<string, AgentState>();
const predictiveClaims = new Map<string, PredictiveClaim>();
const verifications = new Map<string, Verification[]>();
const distillates: Distillate[] = [];
const orders: MarketOrder[] = [];

let roundNumber = 1;

function getOrCreateAgent(agentId: string): AgentState {
  const existing = agents.get(agentId);
  if (existing) return existing;
  const agent: AgentState = {
    agentId,
    reputation: 0.5,
    tokenBalance: 1000,
    correctPredictions: 0,
    totalPredictions: 0,
  };
  agents.set(agentId, agent);
  return agent;
}

const server = new McpServer({
  name: "idea-registry",
  version: "0.1.0",
});

server.tool(
  "propose_idea",
  "Propose a new idea to the marketplace. Ideas are the atomic units of deliberation.",
  {
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    body: z.string(),
    claims: z.array(z.string()),
    evidenceLinks: z.array(z.string().url()),
    author: z.string(),
    parentId: z.string().optional(),
  },
  async (params) => {
    const id = params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const idea: Idea = {
      ...params,
      id,
      createdAt: Date.now(),
      version: 1,
      status: "proposed",
    };
    ideas.set(id, idea);

    for (const claimText of params.claims) {
      const claimId = `${id}-claim-${claims.size + 1}`;
      const claim: Claim = {
        id: claimId,
        ideaId: id,
        text: claimText,
        type: "factual",
      };
      claims.set(claimId, claim);
      markets.set(claimId, createMarket(claimId));
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ idea_id: id, claim_count: params.claims.length }) }],
    };
  },
);

server.tool(
  "search_ideas",
  "Search the idea corpus by keyword.",
  {
    query: z.string().min(1),
  },
  async (params) => {
    const q = params.query.toLowerCase();
    const results: Idea[] = [];
    for (const idea of ideas.values()) {
      if (
        idea.title.toLowerCase().includes(q) ||
        idea.summary.toLowerCase().includes(q) ||
        idea.body.toLowerCase().includes(q)
      ) {
        results.push(idea);
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results.slice(0, 20)) }],
    };
  },
);

server.tool(
  "fork_idea",
  "Fork an existing idea with a variant mutation. Used in the GEPA Propose phase.",
  {
    parentId: z.string(),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    body: z.string(),
    claims: z.array(z.string()),
    evidenceLinks: z.array(z.string().url()),
    author: z.string(),
    mutationDescription: z.string(),
  },
  async (params) => {
    const parent = ideas.get(params.parentId);
    if (!parent) {
      return { content: [{ type: "text", text: `Error: parent idea '${params.parentId}' not found` }] };
    }
    const id = params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const idea: Idea = {
      title: params.title,
      summary: params.summary,
      body: params.body,
      claims: params.claims,
      evidenceLinks: params.evidenceLinks,
      author: params.author,
      id,
      createdAt: Date.now(),
      version: 1,
      status: "proposed",
      parentId: params.parentId,
    };
    ideas.set(id, idea);

    for (const claimText of params.claims) {
      const claimId = `${id}-claim-${claims.size + 1}`;
      const claim: Claim = {
        id: claimId,
        ideaId: id,
        text: claimText,
        type: "factual",
        parentClaimId: `${params.parentId}-claim-1`,
      };
      claims.set(claimId, claim);
      markets.set(claimId, createMarket(claimId));
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ idea_id: id, forked_from: params.parentId, mutation: params.mutationDescription }) }],
    };
  },
);

server.tool(
  "create_claim",
  "Create a claim attached to an idea. Claims are what agents evaluate and bid on.",
  {
    ideaId: z.string(),
    text: z.string(),
    type: z.enum(["factual", "normative", "causal", "predictive"]),
    verificationCriteria: z.string().optional(),
    predictionDate: z.number().optional(),
  },
  async (params) => {
    const idea = ideas.get(params.ideaId);
    if (!idea) {
      return { content: [{ type: "text", text: `Error: idea '${params.ideaId}' not found` }] };
    }
    const claimId = `${params.ideaId}-claim-${claims.size + 1}`;
    const claim: Claim = {
      id: claimId,
      ideaId: params.ideaId,
      text: params.text,
      type: params.type,
    };
    claims.set(claimId, claim);
    markets.set(claimId, createMarket(claimId));

    if (params.type === "predictive" && params.verificationCriteria && params.predictionDate) {
      const pc: PredictiveClaim = {
        claimId,
        prediction: params.text,
        verificationCriteria: params.verificationCriteria,
        predictionDate: params.predictionDate,
        resolved: false,
      };
      predictiveClaims.set(claimId, pc);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ claim_id: claimId, type: params.type }) }],
    };
  },
);

server.tool(
  "submit_evidence",
  "Submit evidence for or against a claim.",
  {
    claimId: z.string(),
    sourceUrl: z.string().url(),
    excerpt: z.string(),
    relevance: z.number().min(0).max(1),
    submittedBy: z.string(),
  },
  async (params) => {
    const ev: Evidence = {
      id: `ev-${evidence.size + 1}`,
      ...params,
      timestamp: Date.now(),
    };
    evidence.set(ev.id, ev);

    const existing = verdicts.get(params.claimId) ?? [];
    verdicts.set(params.claimId, existing);

    return {
      content: [{ type: "text", text: JSON.stringify({ evidence_id: ev.id }) }],
    };
  },
);

server.tool(
  "submit_verdict",
  "Submit a verdict on a claim. Called by sub-agents after evaluating evidence.",
  {
    claimId: z.string(),
    agentId: z.string(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    evidenceReviewed: z.array(z.string()),
  },
  async (params) => {
    const verdict: Verdict = {
      ...params,
      timestamp: Date.now(),
    };
    const existing = verdicts.get(params.claimId) ?? [];
    existing.push(verdict);
    verdicts.set(params.claimId, existing);

    return {
      content: [{ type: "text", text: JSON.stringify({ verdict_count: existing.length }) }],
    };
  },
);

server.tool(
  "evaluate_claim",
  "Evaluate a claim using a REAL LLM. Supports multiple providers. This is the core evaluation engine — not a stub.",
  {
    claimId: z.string(),
    providers: z.array(z.enum(["openai", "anthropic", "deepseek", "mistral", "google-gemini", "grok"])).default(["deepseek"]),
  },
  async (params) => {
    const claim = claims.get(params.claimId);
    if (!claim) {
      return { content: [{ type: "text", text: `Error: claim '${params.claimId}' not found` }] };
    }

    const allEvidence = Array.from(evidence.values()).filter(e => e.claimId === params.claimId);
    const supporting = allEvidence.filter((_, i) => i % 2 === 0).map(e => e.excerpt);
    const counter = allEvidence.filter((_, i) => i % 2 === 1).map(e => e.excerpt);

    try {
      const { evaluateClaimMulti, aggregateVerdicts } = await import("../../evaluate/sub-agent.js");
      const results = await evaluateClaimMulti(params.claimId, claim.text, { supporting, counter }, params.providers);
      const aggregate = aggregateVerdicts(results);

      const aggVerdict = aggregate.verdict;
      aggVerdict.claimId = params.claimId;
      const existing = verdicts.get(params.claimId) ?? [];
      existing.push(aggVerdict);
      verdicts.set(params.claimId, existing);

      for (const r of results) {
        const v = r.verdict;
        v.claimId = params.claimId;
        existing.push(v);
      }
      verdicts.set(params.claimId, existing);

      return {
        content: [{ type: "text", text: JSON.stringify({
          claim_id: params.claimId,
          evaluators: results.length,
          individual: results.map(r => ({
            provider: r.provider,
            confidence: r.verdict.confidence,
            reasoning: r.verdict.reasoning.slice(0, 200),
          })),
          aggregate: {
            confidence: aggregate.verdict.confidence,
            consensus: aggregate.consensus,
            divergence: aggregate.divergence,
            reasoning: aggregate.verdict.reasoning.slice(0, 300),
          },
        })}],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Evaluation error: ${message}` }] };
    }
  },
);

server.tool(
  "place_market_order",
  "Place a market order (buy YES or NO shares) on a claim. Price updates automatically via LMSR.",
  {
    claimId: z.string(),
    agentId: z.string(),
    side: z.enum(["yes", "no"]),
    amount: z.number().positive(),
  },
  async (params) => {
    const market = markets.get(params.claimId);
    if (!market) {
      return { content: [{ type: "text", text: `Error: market for claim '${params.claimId}' not found` }] };
    }
    if (market.resolution) {
      return { content: [{ type: "text", text: `Error: market for claim '${params.claimId}' already resolved as ${market.resolution}` }] };
    }

    const order: MarketOrder = {
      claimId: params.claimId,
      agentId: params.agentId,
      side: params.side,
      amount: params.amount,
      timestamp: Date.now(),
    };

    const agent = getOrCreateAgent(params.agentId);
    if (agent.tokenBalance < params.amount) {
      return { content: [{ type: "text", text: `Error: agent '${params.agentId}' has insufficient balance: ${agent.tokenBalance} < ${params.amount}` }] };
    }

    agent.tokenBalance -= params.amount;
    agents.set(params.agentId, agent);

    const { market: newMarket, avgPrice } = buyShares(market, order);
    markets.set(params.claimId, newMarket);
    orders.push(order);

    return {
      content: [{ type: "text", text: JSON.stringify({
        claim_id: params.claimId,
        side: params.side,
        amount: params.amount,
        avg_price: Math.round(avgPrice * 1000) / 1000,
        new_yes_price: Math.round(newMarket.yesPrice * 1000) / 1000,
        new_no_price: Math.round(newMarket.noPrice * 1000) / 1000,
        agent_balance: Math.round(agent.tokenBalance * 100) / 100,
      })}],
    };
  },
);

server.tool(
  "get_market",
  "Get current market state for a claim. Returns prices, shares, and outstanding orders.",
  {
    claimId: z.string(),
  },
  async (params) => {
    const market = markets.get(params.claimId);
    if (!market) {
      return { content: [{ type: "text", text: `Error: market for claim '${params.claimId}' not found` }] };
    }

    const claimVerdicts = verdicts.get(params.claimId) ?? [];
    const claimOrders = orders.filter(o => o.claimId === params.claimId);

    return {
      content: [{ type: "text", text: JSON.stringify({
        claim_id: params.claimId,
        yes_price: Math.round(market.yesPrice * 10000) / 10000,
        no_price: Math.round(market.noPrice * 10000) / 10000,
        yes_shares_total: Object.values(market.yesShares).reduce((a, b) => a + b, 0),
        no_shares_total: Object.values(market.noShares).reduce((a, b) => a + b, 0),
        resolution: market.resolution ?? null,
        verdict_count: claimVerdicts.length,
        order_count: claimOrders.length,
        liquidity: market.liquidity,
      })}],
    };
  },
);

server.tool(
  "settle_market",
  "Resolve a claim. Called when price crosses threshold or arbiter decides.",
  {
    claimId: z.string(),
    outcome: z.boolean(),
  },
  async (params) => {
    const market = markets.get(params.claimId);
    if (!market) {
      return { content: [{ type: "text", text: `Error: market for claim '${params.claimId}' not found` }] };
    }
    if (market.resolution) {
      return { content: [{ type: "text", text: `Error: market already resolved as ${market.resolution}` }] };
    }

    const agentMap: Record<string, AgentState> = {};
    for (const [id, agent] of agents) {
      agentMap[id] = agent;
    }

    const { market: resolvedMarket, agents: updatedAgents } = resolveMarket(market, params.outcome, agentMap);
    markets.set(params.claimId, resolvedMarket);

    for (const [id, agent] of Object.entries(updatedAgents)) {
      agents.set(id, agent);
    }

    const pc = predictiveClaims.get(params.claimId);
    if (pc) {
      predictiveClaims.set(params.claimId, { ...pc, resolved: true, outcome: params.outcome, resolutionDate: Date.now() });
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        claim_id: params.claimId,
        outcome: params.outcome,
        final_yes_price: params.outcome ? 1 : 0,
        winners: Object.keys(params.outcome ? resolvedMarket.yesShares : resolvedMarket.noShares).length,
        losers: Object.keys(params.outcome ? resolvedMarket.noShares : resolvedMarket.yesShares).length,
      })}],
    };
  },
);

server.tool(
  "get_verdicts",
  "Get all verdicts for a claim. Used by arbiter to review evidence before resolution.",
  {
    claimId: z.string(),
  },
  async (params) => {
    const claimVerdicts = verdicts.get(params.claimId) ?? [];
    return {
      content: [{ type: "text", text: JSON.stringify(claimVerdicts) }],
    };
  },
);

server.tool(
  "distill_trajectories",
  "Extract winning deliberation trajectories from completed rounds. The distillate contains decomposition patterns, evidence context, and prompt mutations for the next generation.",
  {},
  async () => {
    const resolvedClaims: Distillate["winningTrajectories"] = [];
    const extractedContexts: Distillate["extractedContexts"] = [];
    const promptMutations: Distillate["promptMutations"] = [];

    for (const [claimId, market] of markets) {
      if (!market.resolution) continue;

      const claimVerdicts = verdicts.get(claimId) ?? [];
      const successfulVerdicts = claimVerdicts.filter(v => {
        if (market.resolution === "true") return v.confidence > 0.5;
        return v.confidence < 0.5;
      });

      if (successfulVerdicts.length === 0) continue;

      const winningVerdicts = successfulVerdicts.map(v => ({
        subAgent: v.agentId,
        verdict: v,
      }));

      resolvedClaims.push({
        claimId,
        rootAgent: "root",
        decomposition: `Claims for market ${claimId}`,
        subCalls: winningVerdicts,
        outcome: market.resolution,
      });

      const claimEvidence = Array.from(evidence.values())
        .filter(e => e.claimId === claimId);

      extractedContexts.push({
        claimId,
        evidence: claimEvidence.filter((_, i) => i % 2 === 0),
        counterEvidence: claimEvidence.filter((_, i) => i % 2 === 1),
        synthesis: successfulVerdicts.map(v => v.reasoning).join(" | "),
      });

      if (successfulVerdicts.length >= 3) {
        promptMutations.push({
          target: "sub" as const,
          pattern: "Evaluate claim with structured verdict including confidence and reasoning",
          improvement: `Successful pattern from claim ${claimId}: high-confidence verdicts correlated with correct resolution`,
        });
      }
    }

    const distillate: Distillate = {
      round: roundNumber++,
      winningTrajectories: resolvedClaims,
      extractedContexts,
      promptMutations,
      distilledAt: Date.now(),
    };

    distillates.push(distillate);

    return {
      content: [{ type: "text", text: JSON.stringify({
        round: distillate.round,
        trajectories: resolvedClaims.length,
        contexts: extractedContexts.length,
        mutations: promptMutations.length,
      })}],
    };
  },
);

server.tool(
  "compute_rent",
  "Compute the rent score for an idea. An idea pays rent if it enables prediction, generation, or action.",
  {
    ideaId: z.string(),
  },
  async (params) => {
    const idea = ideas.get(params.ideaId);
    if (!idea) {
      return { content: [{ type: "text", text: `Error: idea '${params.ideaId}' not found` }] };
    }

    let predictionsResolved = 0;
    let predictionsCorrect = 0;

    for (const claimId of idea.claims.map((_, i) => `${params.ideaId}-claim-${i + 1}`)) {
      const pc = predictiveClaims.get(claimId);
      if (pc?.resolved) {
        predictionsResolved++;
        if (pc.outcome) predictionsCorrect++;
      }
    }

    let childIdeas = 0;
    let childRent = 0;
    for (const child of ideas.values()) {
      if (child.parentId === params.ideaId) {
        childIdeas++;
        childRent += 0.5;
      }
    }

    const citations = orders.filter(o =>
      o.claimId.startsWith(params.ideaId)
    ).length;

    const problemSolvings = distillates.filter(d =>
      d.winningTrajectories.some(t => t.claimId.startsWith(params.ideaId))
    ).length;

    const agent: AgentState = {
      agentId: `idea-${params.ideaId}`,
      reputation: 0,
      tokenBalance: 0,
      correctPredictions: predictionsCorrect,
      totalPredictions: predictionsResolved,
    };

    const totalRent = computeRentScore(agent, childIdeas, childRent, citations, problemSolvings);

    const rentScore: RentScore = {
      ideaId: params.ideaId,
      predictiveAccuracy: predictionsResolved > 0 ? predictionsCorrect / predictionsResolved : 0,
      generativeValue: childIdeas + childRent,
      compressionRatio: 0,
      utilityScore: problemSolvings > 0 ? Math.min(1, problemSolvings / 10) : 0,
      totalRent: Math.round(totalRent * 10000) / 10000,
      components: {
        predictionsResolved,
        predictionsCorrect,
        childIdeas,
        childRent,
        citations,
        problemSolvings,
      },
      computedAt: Date.now(),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(rentScore) }],
    };
  },
);

server.tool(
  "verify_claim",
  "Verify a claim using a specified method. Verification is how ideas prove they pay rent.",
  {
    claimId: z.string(),
    method: z.enum(["empirical", "logical", "predictive", "consensus", "reproduction"]),
    evidenceHash: z.string(),
    reproducibility: z.number().min(0).max(1),
    verifiedBy: z.string(),
  },
  async (params) => {
    const claim = claims.get(params.claimId);
    if (!claim) {
      return { content: [{ type: "text", text: `Error: claim '${params.claimId}' not found` }] };
    }

    const market = markets.get(params.claimId);
    let status: Verification["status"] = "pending";

    if (params.method === "consensus" && market && market.resolution) {
      status = market.resolution === "true" ? "verified" : "falsified";
    } else if (params.reproducibility > 0.8) {
      status = "verified";
    } else if (params.reproducibility < 0.2) {
      status = "falsified";
    } else {
      status = "inconclusive";
    }

    const verification: Verification = {
      claimId: params.claimId,
      method: params.method,
      status,
      evidenceHash: params.evidenceHash,
      reproducibility: params.reproducibility,
      verifiedAt: Date.now(),
      verifiedBy: params.verifiedBy,
    };

    const existing = verifications.get(params.claimId) ?? [];
    existing.push(verification);
    verifications.set(params.claimId, existing);

    if (status === "verified" && market && !market.resolution) {
      const { market: resolvedMarket, agents: updatedAgents } = resolveMarket(
        market, true,
        Object.fromEntries(Array.from(agents.entries())),
      );
      markets.set(params.claimId, resolvedMarket);
      for (const [id, agent] of Object.entries(updatedAgents)) {
        agents.set(id, agent);
      }
    } else if (status === "falsified" && market && !market.resolution) {
      const { market: resolvedMarket, agents: updatedAgents } = resolveMarket(
        market, false,
        Object.fromEntries(Array.from(agents.entries())),
      );
      markets.set(params.claimId, resolvedMarket);
      for (const [id, agent] of Object.entries(updatedAgents)) {
        agents.set(id, agent);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        claim_id: params.claimId,
        method: params.method,
        status,
        auto_resolved: status === "verified" || status === "falsified",
      })}],
    };
  },
);

server.tool(
  "get_idea_tree",
  "Get the full idea tree including ancestors and descendants.",
  {
    ideaId: z.string(),
  },
  async (params) => {
    const idea = ideas.get(params.ideaId);
    if (!idea) {
      return { content: [{ type: "text", text: `Error: idea '${params.ideaId}' not found` }] };
    }

    const ancestors: Idea[] = [];
    let current: Idea | undefined = idea;
    while (current?.parentId) {
      const parent = ideas.get(current.parentId);
      if (parent) {
        ancestors.push(parent);
        current = parent;
      } else {
        break;
      }
    }

    const descendants: Idea[] = [];
    for (const child of ideas.values()) {
      if (child.parentId === params.ideaId) {
        descendants.push(child);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        idea: { id: idea.id, title: idea.title, status: idea.status },
        ancestors: ancestors.map(a => ({ id: a.id, title: a.title })),
        descendants: descendants.map(d => ({ id: d.id, title: d.title })),
      })}],
    };
  },
);

server.tool(
  "find_divergence",
  "Find claims with highest evaluation variance. Fisher's theorem: variance = evolutionary rate. High-divergence claims are where the market learns fastest.",
  {
    minVerdicts: z.number().int().default(2),
    limit: z.number().int().default(10),
  },
  async (params) => {
    const scored: Array<{
      claimId: string;
      claimText: string;
      verdictCount: number;
      confidences: number[];
      mean: number;
      variance: number;
      divergence: number;
      market: { yesPrice: number; resolution: string | null };
    }> = [];

    for (const [claimId, claimVerdicts] of verdicts) {
      if (claimVerdicts.length < params.minVerdicts) continue;

      const confidences = claimVerdicts.map(v => v.confidence);
      const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
      const divergence = Math.sqrt(variance);

      const claim = claims.get(claimId);
      const market = markets.get(claimId);

      scored.push({
        claimId,
        claimText: claim?.text ?? "unknown",
        verdictCount: claimVerdicts.length,
        confidences,
        mean: Math.round(mean * 1000) / 1000,
        variance: Math.round(variance * 10000) / 10000,
        divergence: Math.round(divergence * 1000) / 1000,
        market: {
          yesPrice: market ? Math.round(market.yesPrice * 10000) / 10000 : 0.5,
          resolution: market?.resolution ?? null,
        },
      });
    }

    scored.sort((a, b) => b.variance - a.variance);

    return {
      content: [{ type: "text", text: JSON.stringify({
        fisher_gradient: "variance = evolutionary rate",
        top_divergent: scored.slice(0, params.limit),
        recommendation: scored.length > 0
          ? `Highest divergence: ${scored[0].claimText.slice(0, 80)}... (variance=${scored[0].variance}). This is where the market has the most to learn.`
          : "No claims with sufficient verdicts yet. Evaluate more claims to create variance.",
      })}],
    };
  },
);

server.tool(
  "get_state",
  "Get full marketplace state: ideas, markets, agents, and rounds.",
  {},
  async () => {
    const marketStates: Record<string, { yesPrice: number; resolution: string | null }> = {};
    for (const [id, m] of markets) {
      marketStates[id] = {
        yesPrice: Math.round(m.yesPrice * 10000) / 10000,
        resolution: m.resolution ?? null,
      };
    }

    const agentStates = Array.from(agents.values()).map(a => ({
      id: a.agentId,
      reputation: Math.round(a.reputation * 10000) / 10000,
      balance: Math.round(a.tokenBalance * 100) / 100,
      accuracy: a.totalPredictions > 0
        ? Math.round((a.correctPredictions / a.totalPredictions) * 10000) / 10000
        : null,
    }));

    const topIdeas: { id: string; title: string; rent: number | null }[] = [];
    for (const [id, idea] of ideas) {
      let predictionsResolved = 0;
      let predictionsCorrect = 0;
      for (const claimId of idea.claims.map((_, i) => `${id}-claim-${i + 1}`)) {
        const pc = predictiveClaims.get(claimId);
        if (pc?.resolved) {
          predictionsResolved++;
          if (pc.outcome) predictionsCorrect++;
        }
      }
      const accuracy = predictionsResolved > 0 ? predictionsCorrect / predictionsResolved : null;
      topIdeas.push({ id, title: idea.title, rent: accuracy });
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        round: roundNumber,
        idea_count: ideas.size,
        claim_count: claims.size,
        market_count: markets.size,
        markets: marketStates,
        agents: agentStates,
        top_ideas: topIdeas
          .filter(i => i.rent !== null)
          .sort((a, b) => (b.rent ?? 0) - (a.rent ?? 0))
          .slice(0, 10),
      })}],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Idea Registry MCP server running on stdio");
}

main().catch(console.error);
