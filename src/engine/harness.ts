import { RlmAgent, type AgentRun, type CodeGenerator, type LeafEvaluator } from "./agent.js";
import type { Store } from "../store/store.js";

export interface TraderConfig { agentId: string; persona: string; codegen: CodeGenerator }

export interface SessionConfig {
  store: Store;
  topic: string;
  /** Extra task context for agents (marketplace state, target material). NOT part of the session's stored identity. */
  context?: string;
  traders: TraderConfig[];
  leafEvaluator: LeafEvaluator;
  llm: (prompt: string) => Promise<string>;
  maxIterations: number;
  maxDepth: number;
  maxSubAgentCalls: number;
  sandboxTimeoutMs: number;
  stallIterations: number;
  recall?: (query: string) => Promise<string>;
  target?: import("./target.js").TargetJail;
}

export interface SessionResult {
  runs: AgentRun[];
  failures: Array<{ agentId: string; error: string }>;
  sessionId: number;
}

const PRICE_HI = 0.7;
const PRICE_LO = 0.3;

/** Nominate claims for human adjudication. NEVER settles. Adversarial agents challenge consensus. */
export function scanNominations(store: Store, opts: { stallIterations: number }): void {
  const rows = store.db.prepare(`
    SELECT m.claim_id AS claimId,
           (SELECT MAX(o.iteration) FROM orders o WHERE o.claim_id = m.claim_id) AS lastIteration,
           (SELECT COUNT(*) FROM orders o WHERE o.claim_id = m.claim_id) AS orderCount
    FROM markets m
    WHERE m.resolution IS NULL
  `).all() as Array<{ claimId: string; lastIteration: number | null; orderCount: number }>;

  for (const r of rows) {
    if (r.orderCount === 0) continue;
    const price = store.getMarket(r.claimId)!.yesPrice;
    if (price >= PRICE_HI || price <= PRICE_LO) {
      store.nominate(r.claimId, "threshold");
    } else if (r.lastIteration !== null && store.currentIteration - r.lastIteration >= opts.stallIterations) {
      store.nominate(r.claimId, "stalled");
    }
  }
}

export async function runSession(cfg: SessionConfig): Promise<SessionResult> {
  const { store } = cfg;
  store.currentIteration = 0;
  const sessionId = store.createSession(cfg.topic, JSON.stringify({ traders: cfg.traders.map(t => ({ agentId: t.agentId, persona: t.persona })), maxIterations: cfg.maxIterations, maxDepth: cfg.maxDepth }));
  const recordIteration = (rec: { agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }) => store.recordAgentIteration({ sessionId, ...rec });

  const onIteration = () => {
    store.currentIteration += 1;
    scanNominations(store, { stallIterations: cfg.stallIterations });
  };

  const settled = await Promise.allSettled(
    cfg.traders.map(t =>
      new RlmAgent({
        agentId: t.agentId,
        persona: t.persona,
        task: cfg.context ? `${cfg.topic}\n\n${cfg.context}` : cfg.topic,
        store,
        codegen: t.codegen,
        leafEvaluator: cfg.leafEvaluator,
        llm: cfg.llm,
        maxIterations: cfg.maxIterations,
        maxDepth: cfg.maxDepth,
        maxSubAgentCalls: cfg.maxSubAgentCalls,
        sandboxTimeoutMs: cfg.sandboxTimeoutMs,
        onIteration,
        recordIteration,
        recall: cfg.recall,
        target: cfg.target,
      }).run(),
    ),
  );

  const runs: AgentRun[] = [];
  const failures: Array<{ agentId: string; error: string }> = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") runs.push(s.value);
    else failures.push({ agentId: cfg.traders[i].agentId, error: String(s.reason) });
  });

  scanNominations(store, { stallIterations: cfg.stallIterations });
  store.endSession(sessionId);
  return { runs, failures, sessionId };
}
