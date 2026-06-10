import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { evaluateClaim, evaluateClaimMulti, aggregateVerdicts, type ProviderId } from "../evaluate/sub-agent.js";
import { createMarket, buyShares, resolveMarket, computeRentScore } from "../market/lmsr.js";
import type { Idea, Claim, Evidence, Verdict, ClaimMarket, AgentState, MarketOrder, Distillate } from "../types/deliberation.js";

const PORT = parseInt(process.env["MP_PORT"] ?? "9500");

const ideas = new Map<string, Idea>();
const claimsMap = new Map<string, Claim>();
const evidenceMap = new Map<string, Evidence[]>();
const verdictsMap = new Map<string, Verdict[]>();
const markets = new Map<string, ClaimMarket>();
const agents = new Map<string, AgentState>();
const distillates: Distillate[] = [];

function agent(id: string): AgentState {
  const existing = agents.get(id);
  if (existing) return existing;
  const a: AgentState = { agentId: id, reputation: 0.5, tokenBalance: 1000, correctPredictions: 0, totalPredictions: 0 };
  agents.set(id, a);
  return a;
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, msg: string, status = 400) {
  json(res, { error: msg }, status);
}

async function handleEvaluate(res: ServerResponse, body: Record<string, unknown>) {
  const claimId = body["claimId"] as string ?? "unknown";
  const claimText = body["claimText"] as string ?? "";
  const supporting = body["supporting"] as string[] ?? [];
  const counter = body["counter"] as string[] ?? [];
  const providers = (body["providers"] as string[] ?? ["deepseek"]).filter(p =>
    ["deepseek", "anthropic", "openai", "mistral", "openrouter"].includes(p),
  ) as ProviderId[];

  try {
    const results = await evaluateClaimMulti(claimId, claimText, { supporting, counter }, providers);
    const agg = aggregateVerdicts(results);

    for (const r of results) {
      const ev = verdictsMap.get(claimId) ?? [];
      ev.push(r.verdict);
      verdictsMap.set(claimId, ev);
    }

    const ev2 = verdictsMap.get(claimId) ?? [];
    ev2.push(agg.verdict);
    verdictsMap.set(claimId, ev2);

    json(res, {
      individual: results.map(r => ({
        provider: r.provider,
        model: r.model,
        confidence: r.verdict.confidence,
        reasoning: r.verdict.reasoning,
      })),
      aggregate: {
        confidence: agg.verdict.confidence,
        consensus: agg.consensus,
        divergence: agg.divergence,
        reasoning: agg.verdict.reasoning.slice(0, 500),
      },
    });
  } catch (err: unknown) {
    error(res, err instanceof Error ? err.message : String(err), 500);
  }
}

function handlePropose(res: ServerResponse, body: Record<string, unknown>) {
  const title = body["title"] as string ?? "";
  const summary = body["summary"] as string ?? "";
  const claims = body["claims"] as string[] ?? [];
  const author = body["author"] as string ?? "root-agent";

  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const idea: Idea = {
    id, title, summary, body: body["body"] as string ?? "",
    claims: claims.map((_, i) => `claim-${id}-${i + 1}`),
    evidenceLinks: [], author, createdAt: Date.now(), version: 1, status: "proposed",
  };
  ideas.set(id, idea);

  claims.forEach((text, i) => {
    const cid = `${id}-claim-${i + 1}`;
    claimsMap.set(cid, { id: cid, ideaId: id, text, type: "factual" });
    markets.set(cid, createMarket(cid, body["liquidity"] as number ?? 1000, body["b"] as number ?? 100));
    evidenceMap.set(cid, []);
  });

  json(res, { idea_id: id, claim_count: claims.length });
}

function handleEvidence(res: ServerResponse, body: Record<string, unknown>) {
  const claimId = body["claim_id"] as string ?? "";
  const excerpt = body["excerpt"] as string ?? "";
  const relevance = body["relevance"] as number ?? 0.5;
  const submittedBy = body["submitted_by"] as string ?? "unknown";

  const ev: Evidence = {
    id: `ev-${Date.now()}`,
    claimId, sourceUrl: body["source_url"] as string ?? "",
    excerpt, relevance, submittedBy, timestamp: Date.now(),
  };
  const existing = evidenceMap.get(claimId) ?? [];
  existing.push(ev);
  evidenceMap.set(claimId, existing);

  json(res, { evidence_id: ev.id, total: existing.length });
}

function handleMarket(res: ServerResponse, claimId: string) {
  const market = markets.get(claimId);
  if (!market) return error(res, `Market not found: ${claimId}`, 404);

  const vs = verdictsMap.get(claimId) ?? [];
  json(res, {
    claim_id: claimId,
    yes_price: +market.yesPrice.toFixed(4),
    no_price: +market.noPrice.toFixed(4),
    yes_shares: Object.values(market.yesShares).reduce((a, b) => a + b, 0),
    no_shares: Object.values(market.noShares).reduce((a, b) => a + b, 0),
    resolution: market.resolution ?? null,
    verdict_count: vs.length,
    liquidity: market.liquidity,
  });
}

function handleOrder(res: ServerResponse, body: Record<string, unknown>) {
  const claimId = body["claim_id"] as string ?? "";
  const agentId = body["agent_id"] as string ?? "";
  const side = body["side"] as string ?? "";
  const amount = body["amount"] as number ?? 0;

  const market = markets.get(claimId);
  if (!market) return error(res, `Market not found: ${claimId}`, 404);
  if (market.resolution) return error(res, "Market already resolved");
  if (side !== "yes" && side !== "no") return error(res, "Side must be 'yes' or 'no'");

  const a = agent(agentId);
  if (a.tokenBalance < amount) return error(res, `Insufficient balance: ${a.tokenBalance}`);

  a.tokenBalance -= amount;
  const { market: newMarket, avgPrice } = buyShares(market, {
    claimId, agentId, side, amount, timestamp: Date.now(),
  });
  markets.set(claimId, newMarket);

  json(res, {
    claim_id: claimId, side, amount,
    avg_price: +avgPrice.toFixed(4),
    new_yes_price: +newMarket.yesPrice.toFixed(4),
    new_no_price: +newMarket.noPrice.toFixed(4),
    agent_balance: +a.tokenBalance.toFixed(1),
  });
}

function handleSettle(res: ServerResponse, claimId: string, body: Record<string, unknown>) {
  const market = markets.get(claimId);
  if (!market) return error(res, `Market not found: ${claimId}`, 404);
  if (market.resolution) return error(res, "Already resolved");

  const outcome = body["outcome"] as boolean;
  const agentMap: Record<string, AgentState> = {};
  for (const [id, a] of agents) agentMap[id] = { ...a };

  const { market: resolved, agents: updated } = resolveMarket(market, outcome, agentMap);
  markets.set(claimId, resolved);
  for (const [id, a] of Object.entries(updated)) agents.set(id, a);

  json(res, {
    claim_id: claimId,
    outcome,
    final_yes: resolved.yesPrice,
    winners: Object.keys(outcome ? resolved.yesShares : resolved.noShares).length,
  });
}

function handleDivergence(res: ServerResponse) {
  const scored: Array<Record<string, unknown>> = [];
  for (const [cid, vs] of verdictsMap) {
    if (vs.length < 2) continue;
    const confs = vs.map(v => v.confidence);
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    const variance = confs.reduce((s, c) => s + (c - mean) ** 2, 0) / confs.length;
    const claim = claimsMap.get(cid);
    const m = markets.get(cid);
    if (variance > 0) {
      scored.push({
        claim_id: cid,
        claim_text: claim?.text ?? "",
        verdict_count: vs.length,
        confidences: confs.map(c => +c.toFixed(2)),
        mean: +mean.toFixed(3),
        variance: +variance.toFixed(4),
        divergence: +Math.sqrt(variance).toFixed(3),
        yes_price: m ? +m.yesPrice.toFixed(4) : 0.5,
      });
    }
  }
  scored.sort((a, b) => (b["variance"] as number) - (a["variance"] as number));
  json(res, { top: scored });
}

function handleState(res: ServerResponse) {
  const marketStates: Record<string, unknown> = {};
  for (const [id, m] of markets) {
    marketStates[id] = { yes_price: +m.yesPrice.toFixed(4), resolution: m.resolution ?? null };
  }
  json(res, {
    ideas: ideas.size,
    claims: claimsMap.size,
    markets: marketStates,
    agents: Array.from(agents.values()).map(a => ({
      id: a.agentId,
      reputation: +a.reputation.toFixed(3),
      balance: +a.tokenBalance.toFixed(1),
    })),
    distillates: distillates.length,
  });
}

function handleDistill(res: ServerResponse) {
  const winning: Distillate["winningTrajectories"] = [];
  for (const [cid, m] of markets) {
    if (!m.resolution) continue;
    const vs = verdictsMap.get(cid) ?? [];
    const correct = vs.filter(v =>
      m.resolution === "true" ? v.confidence > 0.5 : v.confidence < 0.5,
    );
    if (correct.length > 0) {
      winning.push({
        claimId: cid,
        rootAgent: "root",
        decomposition: `Resolved ${m.resolution}`,
        subCalls: correct.map(v => ({ subAgent: v.agentId, verdict: v })),
        outcome: m.resolution,
      });
    }
  }
  const d: Distillate = {
    round: distillates.length + 1,
    winningTrajectories: winning,
    extractedContexts: [],
    promptMutations: winning.map(w => ({
      target: "sub" as const,
      pattern: w.subCalls[0]?.verdict.reasoning.slice(0, 100) ?? "",
      improvement: `Resolved ${w.outcome} with ${w.subCalls.length} correct verdicts`,
    })),
    distilledAt: Date.now(),
  };
  distillates.push(d);
  json(res, { round: d.round, trajectories: winning.length, mutations: d.promptMutations.length });
}

function route(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (url === "/health") return json(res, { ok: true });

  parseBody(req).then(body => {
    if (url === "/evaluate" && method === "POST") return handleEvaluate(res, body);
    if (url === "/propose" && method === "POST") return handlePropose(res, body);
    if (url === "/evidence" && method === "POST") return handleEvidence(res, body);
    if (url === "/order" && method === "POST") return handleOrder(res, body);
    if (url === "/divergence") return handleDivergence(res);
    if (url === "/state") return handleState(res);
    if (url === "/distill" && method === "POST") return handleDistill(res);

    const marketMatch = url.match(/^\/market\/(.+)/);
    if (marketMatch && method === "GET") return handleMarket(res, marketMatch[1]);

    const settleMatch = url.match(/^\/settle\/(.+)/);
    if (settleMatch && method === "POST") return handleSettle(res, settleMatch[1], body);

    error(res, `Not found: ${method} ${url}`, 404);
  }).catch(err => error(res, String(err), 500));
}

export function startServer(port = PORT): ReturnType<typeof createServer> {
  const server = createServer(route);
  server.listen(port, () => {
    console.error(`Marketplace API server running on http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1]?.endsWith("api.ts") || process.argv[1]?.endsWith("api.js")) {
  startServer();
}
