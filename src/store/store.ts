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
}
