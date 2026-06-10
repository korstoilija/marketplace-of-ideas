import { openDb, type Db } from "./db.js";
import { lmsrPrice, buyCost, type Side } from "../market/lmsr.js";

export interface AgentRow { agentId: string; balance: number; reputation: number; correct: number; total: number }
export interface IdeaRow { id: string; title: string; summary: string; body: string; parentId: string | null; author: string; claimIds: string[] }
export interface ClaimRow { id: string; ideaId: string; text: string }
export interface EvidenceRow { id: number; claimId: string; excerpt: string; stance: "supporting" | "counter"; sourceUrl: string | null; relevance: number; submittedBy: string }
export interface MarketRow { claimId: string; qYes: number; qNo: number; b: number; yesPrice: number; resolution: "true" | "false" | null }

export interface ProposeInput {
  title: string; summary: string; body: string;
  claims: string[]; author: string; parentId?: string; b?: number;
}

const DEFAULT_BALANCE = 1000;
const DEFAULT_B = 100;

export class Store {
  readonly db: Db;
  /** Global session iteration counter, stamped onto orders for stall detection. */
  currentIteration = 0;

  constructor(path: string) {
    this.db = openDb(path);
  }

  // ── agents ──
  ensureAgent(agentId: string, balance = DEFAULT_BALANCE): AgentRow {
    this.db.prepare(
      "INSERT INTO agents (agent_id, balance, reputation) VALUES (?, ?, 0.5) ON CONFLICT(agent_id) DO NOTHING",
    ).run(agentId, balance);
    return this.getAgent(agentId)!;
  }

  getAgent(agentId: string): AgentRow | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
      { agent_id: string; balance: number; reputation: number; correct: number; total: number } | undefined;
    return r ? { agentId: r.agent_id, balance: r.balance, reputation: r.reputation, correct: r.correct, total: r.total } : null;
  }

  adjustBalance(agentId: string, delta: number): void {
    this.db.prepare("UPDATE agents SET balance = balance + ? WHERE agent_id = ?").run(delta, agentId);
  }

  // ── ideas / claims ──
  propose(input: ProposeInput): { ideaId: string; claimIds: string[] } {
    if (input.claims.length === 0) throw new Error("propose: at least one claim required");
    const base = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "idea";
    let ideaId = base;
    for (let n = 2; this.getIdea(ideaId); n++) ideaId = `${base}-${n}`;

    const claimIds = input.claims.map((_, i) => `${ideaId}-claim-${i + 1}`);
    const b = input.b ?? DEFAULT_B;

    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO ideas (id, title, summary, body, parent_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ideaId, input.title, input.summary, input.body, input.parentId ?? null, input.author, Date.now());
      const insClaim = this.db.prepare("INSERT INTO claims (id, idea_id, ord, text) VALUES (?, ?, ?, ?)");
      const insMarket = this.db.prepare("INSERT INTO markets (claim_id, b) VALUES (?, ?)");
      input.claims.forEach((text, i) => {
        insClaim.run(claimIds[i], ideaId, i, text);
        insMarket.run(claimIds[i], b);
      });
    });
    tx();
    return { ideaId, claimIds };
  }

  getIdea(id: string): IdeaRow | null {
    const r = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as
      { id: string; title: string; summary: string; body: string; parent_id: string | null; author: string } | undefined;
    if (!r) return null;
    const claimIds = (this.db.prepare("SELECT id FROM claims WHERE idea_id = ? ORDER BY ord").all(id) as { id: string }[]).map(c => c.id);
    return { id: r.id, title: r.title, summary: r.summary, body: r.body, parentId: r.parent_id, author: r.author, claimIds };
  }

  listIdeas(): Array<{ id: string; title: string; claimIds: string[] }> {
    const rows = this.db.prepare("SELECT id, title FROM ideas ORDER BY created_at").all() as { id: string; title: string }[];
    return rows.map(r => ({ ...r, claimIds: this.getIdea(r.id)!.claimIds }));
  }

  getClaim(id: string): ClaimRow | null {
    const r = this.db.prepare("SELECT id, idea_id, text FROM claims WHERE id = ?").get(id) as
      { id: string; idea_id: string; text: string } | undefined;
    return r ? { id: r.id, ideaId: r.idea_id, text: r.text } : null;
  }

  // ── evidence ──
  addEvidence(e: { claimId: string; excerpt: string; stance: "supporting" | "counter"; submittedBy: string; sourceUrl?: string; relevance?: number }): number {
    if (!this.getClaim(e.claimId)) throw new Error(`addEvidence: unknown claim ${e.claimId}`);
    const r = this.db.prepare(
      "INSERT INTO evidence (claim_id, excerpt, stance, source_url, relevance, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(e.claimId, e.excerpt, e.stance, e.sourceUrl ?? null, e.relevance ?? 0.5, e.submittedBy, Date.now());
    return Number(r.lastInsertRowid);
  }

  listEvidence(claimId: string): EvidenceRow[] {
    const rows = this.db.prepare("SELECT * FROM evidence WHERE claim_id = ? ORDER BY id").all(claimId) as Array<
      { id: number; claim_id: string; excerpt: string; stance: "supporting" | "counter"; source_url: string | null; relevance: number; submitted_by: string }>;
    return rows.map(r => ({ id: r.id, claimId: r.claim_id, excerpt: r.excerpt, stance: r.stance, sourceUrl: r.source_url, relevance: r.relevance, submittedBy: r.submitted_by }));
  }

  // ── verdicts ──
  recordVerdict(v: { claimId: string; agentId: string; confidence: number; reasoning: string }): void {
    this.db.prepare(
      "INSERT INTO verdicts (claim_id, agent_id, confidence, reasoning, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(v.claimId, v.agentId, v.confidence, v.reasoning, Date.now());
  }

  // ── markets (read; trading added in Task 5) ──
  getMarket(claimId: string): MarketRow | null {
    const r = this.db.prepare("SELECT * FROM markets WHERE claim_id = ?").get(claimId) as
      { claim_id: string; q_yes: number; q_no: number; b: number; resolution: "true" | "false" | null } | undefined;
    if (!r) return null;
    const resolved = r.resolution !== null;
    const yesPrice = resolved ? (r.resolution === "true" ? 1 : 0) : lmsrPrice(r.q_yes, r.q_no, r.b).yes;
    return { claimId: r.claim_id, qYes: r.q_yes, qNo: r.q_no, b: r.b, yesPrice, resolution: r.resolution };
  }

  counters(): { ideas: number; claims: number; openMarkets: number; resolvedMarkets: number; pendingNominations: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ideas: one("SELECT COUNT(*) n FROM ideas"),
      claims: one("SELECT COUNT(*) n FROM claims"),
      openMarkets: one("SELECT COUNT(*) n FROM markets WHERE resolution IS NULL"),
      resolvedMarkets: one("SELECT COUNT(*) n FROM markets WHERE resolution IS NOT NULL"),
      pendingNominations: one("SELECT COUNT(*) n FROM nominations WHERE status = 'pending'"),
    };
  }

  close(): void { this.db.close(); }

  placeOrder(o: { claimId: string; agentId: string; side: Side; shares: number }): { cost: number; yesPrice: number } {
    if (o.shares <= 0) throw new Error("placeOrder: shares must be positive");
    const m = this.getMarket(o.claimId);
    if (!m) throw new Error(`placeOrder: no market for ${o.claimId}`);
    if (m.resolution) throw new Error(`placeOrder: market ${o.claimId} already resolved`);
    const agent = this.getAgent(o.agentId);
    if (!agent) throw new Error(`placeOrder: unknown agent ${o.agentId}`);

    const cost = buyCost(m.qYes, m.qNo, m.b, o.side, o.shares);
    if (cost > agent.balance) throw new Error(`placeOrder: insufficient balance (${agent.balance.toFixed(1)} < ${cost.toFixed(1)})`);

    const tx = this.db.transaction(() => {
      this.adjustBalance(o.agentId, -cost);
      const col = o.side === "yes" ? "q_yes" : "q_no";
      this.db.prepare(`UPDATE markets SET ${col} = ${col} + ? WHERE claim_id = ?`).run(o.shares, o.claimId);
      this.db.prepare(
        `INSERT INTO positions (claim_id, agent_id, side, shares) VALUES (?, ?, ?, ?)
         ON CONFLICT(claim_id, agent_id, side) DO UPDATE SET shares = shares + excluded.shares`,
      ).run(o.claimId, o.agentId, o.side, o.shares);
      this.db.prepare(
        "INSERT INTO orders (claim_id, agent_id, side, shares, cost, iteration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(o.claimId, o.agentId, o.side, o.shares, cost, this.currentIteration, Date.now());
    });
    tx();
    return { cost, yesPrice: this.getMarket(o.claimId)!.yesPrice };
  }

  getPositions(agentId: string): Array<{ claimId: string; side: Side; shares: number }> {
    const rows = this.db.prepare(
      "SELECT claim_id, side, shares FROM positions WHERE agent_id = ? AND shares > 0 ORDER BY claim_id",
    ).all(agentId) as Array<{ claim_id: string; side: Side; shares: number }>;
    return rows.map(r => ({ claimId: r.claim_id, side: r.side, shares: r.shares }));
  }

  nominate(claimId: string, reason: string): void {
    if (!this.getClaim(claimId)) throw new Error(`nominate: unknown claim ${claimId}`);
    this.db.prepare(
      "INSERT INTO nominations (claim_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(claim_id) DO NOTHING",
    ).run(claimId, reason, Date.now());
  }

  pendingNominations(): Array<{ claimId: string; reason: string }> {
    const rows = this.db.prepare(
      "SELECT claim_id, reason FROM nominations WHERE status = 'pending' ORDER BY created_at",
    ).all() as Array<{ claim_id: string; reason: string }>;
    return rows.map(r => ({ claimId: r.claim_id, reason: r.reason }));
  }

  skipNomination(claimId: string): void {
    this.db.prepare("UPDATE nominations SET status = 'skipped' WHERE claim_id = ?").run(claimId);
  }

  applyAdjudication(claimId: string, outcome: boolean): void {
    const m = this.getMarket(claimId);
    if (!m) throw new Error(`applyAdjudication: no market for ${claimId}`);
    if (m.resolution) throw new Error(`applyAdjudication: ${claimId} already resolved`);
    const claim = this.getClaim(claimId)!;

    const positions = this.db.prepare(
      "SELECT agent_id, side, shares FROM positions WHERE claim_id = ? AND shares > 0",
    ).all(claimId) as Array<{ agent_id: string; side: "yes" | "no"; shares: number }>;

    const winningSide = outcome ? "yes" : "no";

    const byAgent = new Map<string, { yes: number; no: number }>();
    for (const p of positions) {
      const e = byAgent.get(p.agent_id) ?? { yes: 0, no: 0 };
      e[p.side] += p.shares;
      byAgent.set(p.agent_id, e);
    }

    const tx = this.db.transaction(() => {
      for (const p of positions) {
        if (p.side === winningSide) this.adjustBalance(p.agent_id, p.shares);
      }
      for (const [agentId, pos] of byAgent) {
        if (pos.yes === pos.no) continue;
        const stanceCorrect = (pos.yes > pos.no) === outcome;
        this.db.prepare(
          "UPDATE agents SET total = total + 1, correct = correct + ?, reputation = CAST(correct + ? AS REAL) / (total + 1) WHERE agent_id = ?",
        ).run(stanceCorrect ? 1 : 0, stanceCorrect ? 1 : 0, agentId);
      }
      this.db.prepare("UPDATE markets SET resolution = ?, resolved_at = ? WHERE claim_id = ?")
        .run(outcome ? "true" : "false", Date.now(), claimId);
      this.db.prepare("INSERT INTO adjudications (claim_id, outcome, ruled_at) VALUES (?, ?, ?)")
        .run(claimId, outcome ? 1 : 0, Date.now());
      this.db.prepare("UPDATE nominations SET status = 'ruled' WHERE claim_id = ?").run(claimId);

      const ev = this.listEvidence(claimId);
      this.db.prepare(
        "INSERT INTO training_examples (claim_id, claim_text, supporting_json, counter_json, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        claimId, claim.text,
        JSON.stringify(ev.filter(e => e.stance === "supporting").map(e => e.excerpt)),
        JSON.stringify(ev.filter(e => e.stance === "counter").map(e => e.excerpt)),
        outcome ? 1 : 0, Date.now(),
      );
    });
    tx();
  }

  listTrainingExamples(): Array<{ claimId: string; claimText: string; supporting: string[]; counter: string[]; outcome: boolean }> {
    const rows = this.db.prepare("SELECT * FROM training_examples ORDER BY id").all() as Array<
      { claim_id: string; claim_text: string; supporting_json: string; counter_json: string; outcome: number }>;
    return rows.map(r => ({
      claimId: r.claim_id, claimText: r.claim_text,
      supporting: JSON.parse(r.supporting_json) as string[],
      counter: JSON.parse(r.counter_json) as string[],
      outcome: r.outcome === 1,
    }));
  }
}
