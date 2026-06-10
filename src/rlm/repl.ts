import { createContext, runInContext, type Context } from "node:vm";
import { createMarket, buyShares, resolveMarket, computeRentScore } from "../market/lmsr.js";
import type { Idea, Claim, Evidence, Verdict, ClaimMarket, AgentState, Distillate } from "../types/deliberation.js";
import { evaluateClaim, evaluateClaimMulti, aggregateVerdicts, type ProviderId } from "../evaluate/sub-agent.js";

const TRUNCATE_STDOUT = 1200;
const EXEC_TIMEOUT_MS = 20000;

export interface ReplResult {
  stdout: string;
  stdoutTruncated: string;
  timedOut: boolean;
  hasFinal: boolean;
}

function agent(agents: Map<string, AgentState>, id: string): AgentState {
  const existing = agents.get(id);
  if (existing) return existing;
  const a: AgentState = { agentId: id, reputation: 0.5, tokenBalance: 1000, correctPredictions: 0, totalPredictions: 0 };
  agents.set(id, a);
  return a;
}

function buildTools(state: {
  ideas: Map<string, Idea>;
  claimsMap: Map<string, Claim>;
  evidenceMap: Map<string, Evidence[]>;
  verdictsMap: Map<string, Verdict[]>;
  markets: Map<string, ClaimMarket>;
  agents: Map<string, AgentState>;
  distillates: Distillate[];
}) {
  const M = state;

  return {
    propose: (title: string, summary: string, body: string, claimTexts: string[], author = "root-agent", liquidity = 1000, b = 100) => {
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
      const idea: Idea = { id, title, summary, body, claims: claimTexts.map((_, i) => `${id}-claim-${i + 1}`), evidenceLinks: [], author, createdAt: Date.now(), version: 1, status: "proposed" };
      M.ideas.set(id, idea);
      claimTexts.forEach((text, i) => {
        const cid = `${id}-claim-${i + 1}`;
        M.claimsMap.set(cid, { id: cid, ideaId: id, text, type: "factual" });
        M.markets.set(cid, createMarket(cid, liquidity, b));
        M.evidenceMap.set(cid, []);
      });
      return { idea_id: id, claim_count: claimTexts.length };
    },

    addEvidence: (claimId: string, excerpt: string, relevance = 0.5, submittedBy = "repl") => {
      const ev: Evidence = { id: `ev-${Date.now()}`, claimId, sourceUrl: "", excerpt, relevance, submittedBy, timestamp: Date.now() };
      const existing = M.evidenceMap.get(claimId) ?? [];
      existing.push(ev);
      M.evidenceMap.set(claimId, existing);
      return { evidence_id: ev.id, total: existing.length };
    },

    evaluate: async (claimId: string, claimText: string, supporting: string[], counter: string[], providers: string[] = ["deepseek"]) => {
      const validProviders = providers.filter(p => ["deepseek", "anthropic", "openai", "mistral", "openrouter"].includes(p)) as ProviderId[];
      const results = await evaluateClaimMulti(claimId, claimText, { supporting, counter }, validProviders);
      const agg = aggregateVerdicts(results);
      for (const r of results) {
        const ev = M.verdictsMap.get(claimId) ?? [];
        ev.push(r.verdict);
        M.verdictsMap.set(claimId, ev);
      }
      const ev2 = M.verdictsMap.get(claimId) ?? [];
      ev2.push(agg.verdict);
      M.verdictsMap.set(claimId, ev2);
      return {
        individual: results.map(r => ({ provider: r.provider, confidence: r.verdict.confidence, reasoning: r.verdict.reasoning.slice(0, 150) })),
        aggregate: { confidence: agg.verdict.confidence, consensus: agg.consensus, divergence: agg.divergence },
      };
    },

    getMarket: (claimId: string) => {
      const m = M.markets.get(claimId);
      if (!m) return { error: "not found" };
      const vs = M.verdictsMap.get(claimId) ?? [];
      return {
        claim_id: claimId,
        yes_price: +m.yesPrice.toFixed(4),
        no_price: +m.noPrice.toFixed(4),
        yes_shares: Object.values(m.yesShares).reduce((a, b) => a + b, 0),
        no_shares: Object.values(m.noShares).reduce((a, b) => a + b, 0),
        resolution: m.resolution ?? null,
        verdict_count: vs.length,
      };
    },

    placeOrder: (claimId: string, agentId: string, side: string, amount: number) => {
      const m = M.markets.get(claimId);
      if (!m) return { error: "market not found" };
      if (m.resolution) return { error: "already resolved" };
      if (side !== "yes" && side !== "no") return { error: "side must be yes or no" };
      const a = agent(M.agents, agentId);
      if (a.tokenBalance < amount) return { error: `insufficient balance: ${a.tokenBalance}` };
      a.tokenBalance -= amount;
      const { market: newMarket, avgPrice } = buyShares(m, { claimId, agentId, side, amount, timestamp: Date.now() });
      M.markets.set(claimId, newMarket);
      return { claim_id: claimId, side, amount, avg_price: +avgPrice.toFixed(4), new_yes_price: +newMarket.yesPrice.toFixed(4), agent_balance: +a.tokenBalance.toFixed(1) };
    },

    settle: (claimId: string, outcome: boolean) => {
      const m = M.markets.get(claimId);
      if (!m) return { error: "not found" };
      if (m.resolution) return { error: "already resolved" };
      const agentMap: Record<string, AgentState> = {};
      for (const [id, a] of M.agents) agentMap[id] = { ...a };
      const { market: resolved, agents: updated } = resolveMarket(m, outcome, agentMap);
      M.markets.set(claimId, resolved);
      for (const [id, a] of Object.entries(updated)) M.agents.set(id, a);
      return { claim_id: claimId, outcome, final_yes: resolved.yesPrice };
    },

    settleAbove: (threshold = 0.85) => {
      const results: Record<string, unknown>[] = [];
      for (const [cid, m] of M.markets) {
        if (m.resolution) continue;
        if (m.yesPrice >= threshold) {
          results.push({ claim_id: cid, result: buildTools(M).settle(cid, true) });
        } else if (m.yesPrice <= 1 - threshold) {
          results.push({ claim_id: cid, result: buildTools(M).settle(cid, false) });
        }
      }
      return { settled: results.length, results };
    },

    findDivergence: (minVerdicts = 2) => {
      const scored: Record<string, unknown>[] = [];
      for (const [cid, vs] of M.verdictsMap) {
        if (vs.length < minVerdicts) continue;
        const confs = vs.map(v => v.confidence);
        const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
        const variance = confs.reduce((s, c) => s + (c - mean) ** 2, 0) / confs.length;
        if (variance > 0) {
          const claim = M.claimsMap.get(cid);
          const m = M.markets.get(cid);
          scored.push({
            claim_id: cid, claim_text: claim?.text ?? "",
            verdict_count: vs.length, mean: +mean.toFixed(3),
            variance: +variance.toFixed(4), divergence: +Math.sqrt(variance).toFixed(3),
            yes_price: m ? +m.yesPrice.toFixed(4) : 0.5,
          });
        }
      }
      scored.sort((a, b) => (b["variance"] as number) - (a["variance"] as number));
      return scored;
    },

    distill: () => {
      const winning: Distillate["winningTrajectories"] = [];
      for (const [cid, m] of M.markets) {
        if (!m.resolution) continue;
        const vs = M.verdictsMap.get(cid) ?? [];
        const correct = vs.filter(v => m.resolution === "true" ? v.confidence > 0.5 : v.confidence < 0.5);
        if (correct.length > 0) {
          winning.push({ claimId: cid, rootAgent: "root", decomposition: `Resolved ${m.resolution}`, subCalls: correct.map(v => ({ subAgent: v.agentId, verdict: v })), outcome: m.resolution });
        }
      }
      const d: Distillate = { round: M.distillates.length + 1, winningTrajectories: winning, extractedContexts: [], promptMutations: [], distilledAt: Date.now() };
      M.distillates.push(d);
      return { round: d.round, trajectories: winning.length };
    },

    getState: () => {
      const active = Array.from(M.markets.values()).filter(m => !m.resolution).length;
      const settled = Array.from(M.markets.values()).filter(m => m.resolution).length;
      return { ideas: M.ideas.size, claims: M.claimsMap.size, active_markets: active, settled_markets: settled, distillates: M.distillates.length, agents: Array.from(M.agents.values()).map(a => ({ id: a.agentId, reputation: +a.reputation.toFixed(3), balance: +a.tokenBalance.toFixed(1) })) };
    },
  };
}

export class JsRepl {
  private context: Context;
  private sandbox: Record<string, unknown>;
  private captured = "";
  private state: ReturnType<typeof buildTools>;

  constructor(marketState: {
    ideas: Map<string, Idea>;
    claimsMap: Map<string, Claim>;
    evidenceMap: Map<string, Evidence[]>;
    verdictsMap: Map<string, Verdict[]>;
    markets: Map<string, ClaimMarket>;
    agents: Map<string, AgentState>;
    distillates: Distillate[];
  }) {
    this.state = buildTools(marketState);

    this.sandbox = {
      console: {
        log: (...args: unknown[]) => { this.captured += args.map(a => typeof a === "object" ? JSON.stringify(a).slice(0, 300) : String(a)).join(" ") + "\n"; },
      },
      parseFloat,
      isNaN,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Map,
      Set,

      propose: (...args: unknown[]) => {
        const r = this.state.propose(args[0] as string, args[1] as string, args[2] as string, args[3] as string[], args[4] as string, 1000, 100);
        console.log("propose:", JSON.stringify(r));
        return r;
      },
      addEvidence: (...args: unknown[]) => {
        const r = this.state.addEvidence(args[0] as string, args[1] as string, args[2] as number, args[3] as string);
        return r;
      },
      evaluate: async (...args: unknown[]) => {
        const r = await this.state.evaluate(args[0] as string, args[1] as string, args[2] as string[] ?? [], args[3] as string[] ?? [], args[4] as string[] ?? ["deepseek"]);
        console.log("evaluate:", JSON.stringify(r.aggregate));
        return r;
      },
      getMarket: (claimId: string) => this.state.getMarket(claimId),
      placeOrder: (...args: unknown[]) => {
        const r = this.state.placeOrder(args[0] as string, args[1] as string, args[2] as string, args[3] as number);
        if (!r || typeof r !== "object" || !("error" in (r as Record<string, unknown>))) console.log("order:", JSON.stringify(r));
        return r;
      },
      settle: (claimId: string, outcome: boolean) => {
        const r = this.state.settle(claimId, outcome);
        console.log("settle:", JSON.stringify(r));
        return r;
      },
      settleAbove: (threshold?: number) => {
        const r = this.state.settleAbove(threshold);
        console.log("settleAbove:", JSON.stringify(r));
        return r;
      },
      findDivergence: (min?: number) => this.state.findDivergence(min),
      distill: () => {
        const r = this.state.distill();
        console.log("distill:", JSON.stringify(r));
        return r;
      },
      getState: () => this.state.getState(),
    };

    this.sandbox["Final"] = undefined;
    this.context = createContext(this.sandbox);
  }

  async execute(code: string): Promise<ReplResult> {
    this.captured = "";
    const startTime = performance.now();

    const wrappedCode = `
      (async () => {
        try {
          ${code}
        } catch (e) {
          console.log("ERROR: " + (e instanceof Error ? e.message : String(e)));
        }
        console.log("__DONE__");
      })();
    `;

    let timedOut = false;

    try {
      await Promise.race([
        runInContext(wrappedCode, this.context, { timeout: EXEC_TIMEOUT_MS, breakOnSigint: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), EXEC_TIMEOUT_MS + 1000)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("TIMEOUT") || msg.includes("timed out")) {
        timedOut = true;
        this.captured += "\n[TIMEOUT after " + EXEC_TIMEOUT_MS/1000 + "s]\n";
      } else {
        this.captured += "\n[Error: " + msg + "]\n";
      }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    this.captured += `\n[executed in ${elapsed}s]`;

    const hasFinal = this.sandbox["Final"] !== undefined && this.sandbox["Final"] !== null;

    const stdoutTruncated = this.captured.length > TRUNCATE_STDOUT
      ? this.captured.slice(0, TRUNCATE_STDOUT) + `\n... [${this.captured.length} total chars]`
      : this.captured;

    return { stdout: this.captured, stdoutTruncated, timedOut, hasFinal };
  }

  getFinal(): unknown {
    return this.sandbox["Final"];
  }
}
