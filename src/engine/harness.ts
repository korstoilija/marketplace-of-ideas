import { Store } from "../store/index.js";
import { RlmAgent, type AgentConfig, type AgentRun } from "../engine/rlm-agent.js";
import type { ProviderId } from "../evaluate/sub-agent.js";

export interface HarnessConfig {
  maxIterationsPerAgent: number;
  maxDepth: number;
  subAgentSpawnCapPerIteration: number;
  nominationThreshold: number;
  stallIterations: number;
}

const DEFAULT_HARNESS: HarnessConfig = {
  maxIterationsPerAgent: 15,
  maxDepth: 2,
  subAgentSpawnCapPerIteration: 5,
  nominationThreshold: 0.85,
  stallIterations: 10,
};

export interface SessionConfig {
  topic: string;
  agents: AgentConfig[];
  harness?: Partial<HarnessConfig>;
}

export interface AdjudicationCard {
  claimId: string;
  claimText: string;
  yesPrice: number;
  noPrice: number;
  totalOrders: number;
  supportingEvidence: string[];
  counterEvidence: string[];
  verdicts: Array<{ agentId: string; confidence: number; reasoning: string }>;
  nominatedAt: number;
  nominationReason: string;
}

export interface SessionResult {
  agentRuns: AgentRun[];
  adjudicationQueue: AdjudicationCard[];
  error: string | null;
}

export async function runSession(config: SessionConfig): Promise<SessionResult> {
  const hc = { ...DEFAULT_HARNESS, ...config.harness };

  const dbPath = `${process.env["HOME"] ?? "/tmp"}/.marketplace/marketplace.db`;
  const store = new Store(dbPath);

  const agents = config.agents.map(cfg => {
    store.ensureAgent(cfg.agentId);
    return new RlmAgent(cfg, store, 0);
  });

  const agentPromises = agents.map(agent =>
    agent.run(hc.maxIterationsPerAgent).then(run => run).catch(err => {
      return { agentId: agent.agentId, depth: 0, iterations: [], finalValue: null, success: false, error: String(err) };
    }),
  );

  const agentRuns = await Promise.all(agentPromises);

  // Nomination: detect claims that crossed threshold or stalled
  const queue = nominate(store, hc);

  store.close();
  return { agentRuns, adjudicationQueue: queue, error: null };
}

function nominate(store: Store, hc: HarnessConfig): AdjudicationCard[] {
  const cards: AdjudicationCard[] = [];
  const now = Date.now();

  const activeMarkets = store.db.prepare(
    "SELECT claim_id, yes_price, nomination_status FROM markets WHERE resolution IS NULL",
  ).all() as Record<string, unknown>[];

  for (const m of activeMarkets) {
    const claimId = m["claim_id"] as string;
    const yesPrice = m["yes_price"] as number;
    const status = m["nomination_status"] as string;

    let reason = "";

    // Price threshold nomination
    if (yesPrice >= hc.nominationThreshold) {
      reason = `yes_price=${yesPrice.toFixed(2)} >= ${hc.nominationThreshold}`;
    } else if (yesPrice <= 1 - hc.nominationThreshold) {
      reason = `yes_price=${yesPrice.toFixed(2)} <= ${1 - hc.nominationThreshold}`;
    }

    // Stall detection: orders count
    const orderCount = (store.db.prepare(
      "SELECT COUNT(*) as c FROM orders WHERE claim_id = ?",
    ).get(claimId) as { c: number }).c;

    if (!reason && orderCount > 0) {
      const lastOrder = store.db.prepare(
        "SELECT MAX(timestamp) as ts FROM orders WHERE claim_id = ?",
      ).get(claimId) as { ts: number } | undefined;
      if (lastOrder && (now - lastOrder.ts) > hc.stallIterations * 60000) {
        reason = `trading stalled (last order ${Math.round((now - lastOrder.ts) / 60000)} min ago, ${orderCount} orders)`;
      }
    }

    if (!reason && status === "nominated") continue;
    if (!reason) continue;

    // Mark nominated
    if (status === "none") {
      store.db.prepare("UPDATE markets SET nomination_status = 'nominated', nominated_at = ? WHERE claim_id = ?").run(now, claimId);
    }

    const claim = store.getClaim(claimId);
    const ev = store.getEvidenceForClaim(claimId);
    const vs = store.getVerdictsForClaim(claimId);

    cards.push({
      claimId,
      claimText: claim?.text ?? "",
      yesPrice: +yesPrice.toFixed(4),
      noPrice: +(1 - yesPrice).toFixed(4),
      totalOrders: orderCount,
      supportingEvidence: ev.filter((_, i) => i % 2 === 0).map(e => e.excerpt),
      counterEvidence: ev.filter((_, i) => i % 2 === 1).map(e => e.excerpt),
      verdicts: vs.map(v => ({ agentId: v.agentId, confidence: v.confidence, reasoning: v.reasoning.slice(0, 200) })),
      nominatedAt: now,
      nominationReason: reason,
    });
  }

  cards.sort((a, b) => {
    const aScore = Math.abs(a.yesPrice - 0.5) * a.totalOrders;
    const bScore = Math.abs(b.yesPrice - 0.5) * b.totalOrders;
    return bScore - aScore;
  });

  return cards;
}

export function adjudicate(store: Store, claimId: string, outcome: boolean): void {
  store.settleMarket(claimId, outcome);
}
