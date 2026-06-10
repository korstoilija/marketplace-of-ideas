import { type ClaimMarket, type MarketOrder, type AgentState } from "../types/deliberation.js";

export function createMarket(claimId: string, liquidity = 1000, b = 100): ClaimMarket {
  const q = liquidity / 2;
  return {
    claimId,
    yesShares: {},
    noShares: {},
    yesPrice: 0.5,
    noPrice: 0.5,
    liquidity,
    b,
  };
}

export function lmsrPrice(qYes: number, qNo: number, b: number): { yes: number; no: number } {
  const expYes = Math.exp(qYes / b);
  const expNo = Math.exp(qNo / b);
  const total = expYes + expNo;
  return {
    yes: expYes / total,
    no: expNo / total,
  };
}

export function lmsrCost(qYes: number, qNo: number, b: number): number {
  return b * Math.log(Math.exp(qYes / b) + Math.exp(qNo / b));
}

export function buyShares(
  market: ClaimMarket,
  order: MarketOrder,
): { market: ClaimMarket; avgPrice: number } {
  const isYes = order.side === "yes";
  const shares = isYes ? { ...market.yesShares } : { ...market.noShares };
  const otherShares = isYes ? { ...market.noShares } : { ...market.yesShares };

  const agentId = order.agentId;
  const currentAgentShares = shares[agentId] ?? 0;
  const currentOther = Object.values(otherShares).reduce((a, b) => a + b, 0);
  const currentAllies = Object.values(shares).reduce((a, b) => a + b, 0);

  const qStart = isYes ? currentAllies : currentOther;
  const qOppStart = isYes ? currentOther : currentAllies;
  const costStart = lmsrCost(qStart, qOppStart, market.b);

  const qEnd = qStart + order.amount;
  const costEnd = lmsrCost(qEnd, qOppStart, market.b);

  const cost = costEnd - costStart;
  const avgPrice = cost / order.amount;

  shares[agentId] = currentAgentShares + order.amount;

  const newQYes = isYes ? qEnd : currentOther;
  const newQNo = isYes ? currentOther : qEnd;
  const prices = lmsrPrice(newQYes, newQNo, market.b);

  const newMarket: ClaimMarket = {
    ...market,
    yesShares: isYes ? shares : market.yesShares,
    noShares: isYes ? market.noShares : shares,
    yesPrice: prices.yes,
    noPrice: prices.no,
  };

  return { market: newMarket, avgPrice };
}

export function resolveMarket(
  market: ClaimMarket,
  outcome: boolean,
  agents: Record<string, AgentState>,
): { market: ClaimMarket; agents: Record<string, AgentState> } {
  const winningShares = outcome ? market.yesShares : market.noShares;
  const losingShares = outcome ? market.noShares : market.yesShares;

  const updatedAgents = { ...agents };

  for (const [agentId, shares] of Object.entries(winningShares)) {
    const agent = updatedAgents[agentId] ?? {
      agentId, reputation: 0, tokenBalance: 0,
      correctPredictions: 0, totalPredictions: 0,
    };
    updatedAgents[agentId] = {
      ...agent,
      agentId,
      tokenBalance: agent.tokenBalance + shares,
      correctPredictions: agent.correctPredictions + 1,
      totalPredictions: agent.totalPredictions + 1,
      reputation: (agent.correctPredictions + 1) / (agent.totalPredictions + 1),
    };
  }

  for (const agentId of Object.keys(losingShares)) {
    const agent = updatedAgents[agentId] ?? {
      agentId, reputation: 0, tokenBalance: 0,
      correctPredictions: 0, totalPredictions: 0,
    };
    updatedAgents[agentId] = {
      ...agent,
      agentId,
      totalPredictions: agent.totalPredictions + 1,
      reputation: agent.correctPredictions / (agent.totalPredictions + 1),
    };
  }

  const resolvedMarket: ClaimMarket = {
    ...market,
    resolution: outcome ? "true" : "false",
    resolvedAt: Date.now(),
    yesPrice: outcome ? 1 : 0,
    noPrice: outcome ? 0 : 1,
  };

  return { market: resolvedMarket, agents: updatedAgents };
}

export function computeRentScore(
  agent: AgentState,
  childIdeas: number,
  childRent: number,
  citations: number,
  problemSolvings: number,
): number {
  const predictiveAccuracy = agent.totalPredictions > 0
    ? agent.correctPredictions / agent.totalPredictions
    : 0;
  const generativeValue = childIdeas + childRent;
  const utilityScore = problemSolvings > 0 ? Math.min(1, problemSolvings / 10) : 0;
  const total = (
    predictiveAccuracy * 0.4 +
    Math.min(1, generativeValue / 20) * 0.3 +
    utilityScore * 0.2 +
    Math.min(1, citations / 50) * 0.1
  );
  return Math.min(1, total);
}
