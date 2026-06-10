import type { Store } from "../store/store.js";

export interface AdjudicationCard {
  claimId: string;
  claimText: string;
  ideaTitle: string;
  yesPrice: number;
  orders: number;
  supporting: string[];
  counter: string[];
  verdicts: Array<{ agentId: string; confidence: number; reasoning: string }>;
  reason: string;
}

export function buildAdjudicationCards(store: Store): AdjudicationCard[] {
  const cards: AdjudicationCard[] = [];
  for (const nom of store.pendingNominations()) {
    const claim = store.getClaim(nom.claimId);
    const market = store.getMarket(nom.claimId);
    if (!claim || !market || market.resolution) continue;
    const ev = store.listEvidence(nom.claimId);
    const verdicts = (store.db.prepare(
      "SELECT agent_id, confidence, reasoning FROM verdicts WHERE claim_id = ? ORDER BY id DESC LIMIT 5",
    ).all(nom.claimId) as Array<{ agent_id: string; confidence: number; reasoning: string }>)
      .map(v => ({ agentId: v.agent_id, confidence: v.confidence, reasoning: v.reasoning.slice(0, 300) }));

    cards.push({
      claimId: nom.claimId,
      claimText: claim.text,
      ideaTitle: store.getIdea(claim.ideaId)?.title ?? "",
      yesPrice: +market.yesPrice.toFixed(4),
      orders: store.orderCount(nom.claimId),
      supporting: ev.filter(e => e.stance === "supporting").map(e => e.excerpt),
      counter: ev.filter(e => e.stance === "counter").map(e => e.excerpt),
      verdicts,
      reason: nom.reason,
    });
  }
  cards.sort((a, b) =>
    Math.abs(a.yesPrice - 0.5) - Math.abs(b.yesPrice - 0.5) || b.orders - a.orders,
  );
  return cards;
}
