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
    
    // Dedup: check if any claim text already exists in an accepted idea
    const placeholders = input.claims.map(() => "?").join(",");
    const existing = this.db.prepare(
      `SELECT c.id FROM claims c JOIN ideas i ON c.idea_id=i.id WHERE c.text IN (${placeholders}) AND i.status='accepted' LIMIT 1`
    ).all(...input.claims) as Array<{ id: string }>;
    if (existing.length > 0) throw new Error(`propose: duplicate claim — already exists in accepted idea`);
    
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
    if (!v.claimId) return; // Skip verdicts with empty claim IDs
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

  listAgents(): AgentRow[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY agent_id").all() as Array<
      { agent_id: string; balance: number; reputation: number; correct: number; total: number }>;
    return rows.map(r => ({ agentId: r.agent_id, balance: r.balance, reputation: r.reputation, correct: r.correct, total: r.total }));
  }

  recentOrders(limit = 20): Array<{ claimId: string; agentId: string; side: Side; shares: number; cost: number; createdAt: number }> {
    const rows = this.db.prepare(
      "SELECT claim_id, agent_id, side, shares, cost, created_at FROM orders ORDER BY id DESC LIMIT ?",
    ).all(limit) as Array<{ claim_id: string; agent_id: string; side: Side; shares: number; cost: number; created_at: number }>;
    return rows.map(r => ({ claimId: r.claim_id, agentId: r.agent_id, side: r.side, shares: r.shares, cost: r.cost, createdAt: r.created_at }));
  }

  orderCount(claimId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM orders WHERE claim_id = ?").get(claimId) as { n: number }).n;
  }

  priceHistory(claimId: string): Array<{ at: number; yesPrice: number }> {
    const m = this.getMarket(claimId);
    if (!m) return [];
    const rows = this.db.prepare(
      "SELECT side, shares, created_at FROM orders WHERE claim_id = ? ORDER BY id",
    ).all(claimId) as Array<{ side: Side; shares: number; created_at: number }>;
    let qYes = 0, qNo = 0;
    const path = [{ at: 0, yesPrice: 0.5 }];
    for (const r of rows) {
      if (r.side === "yes") qYes += r.shares; else qNo += r.shares;
      path.push({ at: r.created_at, yesPrice: lmsrPrice(qYes, qNo, m.b).yes });
    }
    return path;
  }

  insertOptimization(o: { baseline: number; optimized: number; examplesUsed: number; holdoutSize: number; programJson: string }): void {
    this.db.prepare(
      "INSERT INTO optimizations (baseline, optimized, examples_used, holdout_size, program_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(o.baseline, o.optimized, o.examplesUsed, o.holdoutSize, o.programJson, Date.now());
  }

  listOptimizations(): Array<{ id: number; baseline: number; optimized: number; examplesUsed: number; holdoutSize: number; createdAt: number }> {
    const rows = this.db.prepare(
      "SELECT id, baseline, optimized, examples_used, holdout_size, created_at FROM optimizations ORDER BY id DESC",
    ).all() as Array<{ id: number; baseline: number; optimized: number; examples_used: number; holdout_size: number; created_at: number }>;
    return rows.map(r => ({ id: r.id, baseline: r.baseline, optimized: r.optimized, examplesUsed: r.examples_used, holdoutSize: r.holdout_size, createdAt: r.created_at }));
  }

  latestOptimization(): { programJson: string; createdAt: number } | null {
    const r = this.db.prepare(
      "SELECT program_json, created_at FROM optimizations ORDER BY id DESC LIMIT 1",
    ).get() as { program_json: string; created_at: number } | undefined;
    return r ? { programJson: r.program_json, createdAt: r.created_at } : null;
  }

  trainingExampleCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM training_examples").get() as { n: number }).n;
  }

  createSession(topic: string, configJson = "{}"): number {
    const r = this.db.prepare("INSERT INTO sessions (topic, config_json, started_at) VALUES (?, ?, ?)").run(topic, configJson, Date.now());
    return Number(r.lastInsertRowid);
  }
  endSession(sessionId: number): void {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(Date.now(), sessionId);
  }
  recordAgentIteration(rec: { sessionId: number; agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }): void {
    this.db.prepare("INSERT INTO agent_iterations (session_id, agent_id, depth, iteration, code, stdout, timed_out, has_final, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(rec.sessionId, rec.agentId, rec.depth, rec.iteration, rec.code.slice(0, 10000), rec.stdout.slice(0, 5000), rec.timedOut ? 1 : 0, rec.hasFinal ? 1 : 0, Date.now());
  }
  listSessions(): Array<{ id: number; topic: string; startedAt: number; endedAt: number | null; iterations: number; agents: number }> {
    const rows = this.db.prepare(`SELECT s.id, s.topic, s.started_at, s.ended_at, (SELECT COUNT(*) FROM agent_iterations ai WHERE ai.session_id = s.id) AS iterations, (SELECT COUNT(DISTINCT ai.agent_id) FROM agent_iterations ai WHERE ai.session_id = s.id) AS agents FROM sessions s ORDER BY s.id DESC`).all() as Array<{ id: number; topic: string; started_at: number; ended_at: number | null; iterations: number; agents: number }>;
    return rows.map(r => ({ id: r.id, topic: r.topic, startedAt: r.started_at, endedAt: r.ended_at, iterations: r.iterations, agents: r.agents }));
  }
  getSessionIterations(sessionId: number): Array<{ agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }> {
    const rows = this.db.prepare("SELECT agent_id, depth, iteration, code, stdout, timed_out, has_final FROM agent_iterations WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{ agent_id: string; depth: number; iteration: number; code: string; stdout: string; timed_out: number; has_final: number }>;
    return rows.map(r => ({ agentId: r.agent_id, depth: r.depth, iteration: r.iteration, code: r.code, stdout: r.stdout, timedOut: r.timed_out === 1, hasFinal: r.has_final === 1 }));
  }

  close(): void { this.db.close(); }

  // ── Budget ledger ──
  spendTokens(path: string, tokens = 1, runId = ""): void {
    this.db.prepare("INSERT INTO budget_ledger (path, tokens, run_id, created_at) VALUES (?,?,?,?)").run(path, tokens, runId, Date.now());
  }
  tokensSpent(runId?: string): number {
    const sql = runId ? "SELECT COALESCE(SUM(tokens),0) n FROM budget_ledger WHERE run_id=?" : "SELECT COALESCE(SUM(tokens),0) n FROM budget_ledger";
    return (this.db.prepare(sql).get(runId || undefined) as { n: number }).n;
  }
  tokensSpentToday(): number {
    const start = new Date();
    start.setHours(0,0,0,0);
    return (this.db.prepare("SELECT COALESCE(SUM(tokens),0) n FROM budget_ledger WHERE created_at >= ?").get(start.getTime()) as { n: number }).n;
  }

  // ── Tier 1 items ──
  insertTier1Item(item: { sourceId?: number; text: string; claimsJson: string; maxSimilarity?: number; confidence?: number; coherenceScore?: number; escalated?: boolean; runId?: string }): number {
    const r = this.db.prepare("INSERT INTO tier1_items (source_id, text, claims_json, max_similarity, confidence, coherence_score, escalated, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(item.sourceId||null, item.text, item.claimsJson, item.maxSimilarity||null, item.confidence||null, item.coherenceScore||null, item.escalated?1:0, item.runId||'', Date.now());
    return Number(r.lastInsertRowid);
  }
  listTier1Unescalated(runId: string): Array<{ id: number; text: string; claimsJson: string; confidence: number | null }> {
    return (this.db.prepare("SELECT id, text, claims_json, confidence FROM tier1_items WHERE run_id=? AND escalated=0").all(runId) as any[]).map(r=>({id:r.id, text:r.text, claimsJson:r.claims_json, confidence:r.confidence}));
  }

  // ── Embeddings ──
  storeEmbedding(kind: string, refId: string, vector: Buffer, model = "mini"): void {
    this.db.prepare("INSERT OR REPLACE INTO embeddings (kind, ref_id, vector, model, created_at) VALUES (?,?,?,?,?)").run(kind, refId, vector, model, Date.now());
  }
  getEmbedding(kind: string, refId: string): { vector: Buffer } | null {
    return this.db.prepare("SELECT vector FROM embeddings WHERE kind=? AND ref_id=?").get(kind, refId) as { vector: Buffer } | undefined || null;
  }

  // ── Sources ──
  registerSource(path: string, kind = "file"): number {
    const r = this.db.prepare("INSERT OR IGNORE INTO sources (path, kind, created_at) VALUES (?,?,?)").run(path, kind, Date.now());
    return Number(r.lastInsertRowid || (this.db.prepare("SELECT id FROM sources WHERE path=?").get(path) as { id: number }).id);
  }
  listSources(): Array<{ id: number; path: string; kind: string; lastHash: string | null; lastMtime: number | null }> {
    return (this.db.prepare("SELECT * FROM sources").all() as any[]).map(r=>({id:r.id, path:r.path, kind:r.kind, lastHash:r.last_hash, lastMtime:r.last_mtime}));
  }
  updateSourceScan(id: number, hash: string, mtime: number): void {
    this.db.prepare("UPDATE sources SET last_hash=?, last_mtime=? WHERE id=?").run(hash, mtime, id);
  }

  placeOrder(o: { claimId: string; agentId: string; side: Side; shares: number }): { cost: number; yesPrice: number } {
    if (o.shares <= 0) throw new Error("placeOrder: shares must be positive");
    const m = this.getMarket(o.claimId);
    if (!m) throw new Error(`placeOrder: no market for ${o.claimId}`);
    if (m.resolution) throw new Error(`placeOrder: market ${o.claimId} already resolved`);

    const cost = buyCost(m.qYes, m.qNo, m.b, o.side, o.shares);

    const tx = this.db.transaction(() => {
      // Atomic: check balance AND debit inside transaction to prevent TOCTOU races
      const agent = this.getAgent(o.agentId);
      if (!agent) throw new Error(`placeOrder: unknown agent ${o.agentId}`);
      if (cost > agent.balance) throw new Error(`placeOrder: insufficient balance (${agent.balance.toFixed(1)} < ${cost.toFixed(1)})`);
      this.adjustBalance(o.agentId, -cost);
      // Parameterized column update — no SQL interpolation
      if (o.side === "yes") {
        this.db.prepare("UPDATE markets SET q_yes = q_yes + ? WHERE claim_id = ?").run(o.shares, o.claimId);
      } else {
        this.db.prepare("UPDATE markets SET q_no = q_no + ? WHERE claim_id = ?").run(o.shares, o.claimId);
      }
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

  // ── Ghost lifecycle ──
  approveIdea(ideaId: string, mechanism = "", falsification = ""): void {
    this.db.prepare("INSERT INTO idea_approvals (idea_id, approved, approved_at, mechanism, falsification) VALUES (?, 1, ?, ?, ?) ON CONFLICT(idea_id) DO UPDATE SET approved=1, approved_at=excluded.approved_at, mechanism=excluded.mechanism, falsification=excluded.falsification").run(ideaId, Date.now(), mechanism, falsification);
    this.db.prepare("UPDATE ideas SET status='accepted' WHERE id=?").run(ideaId);
  }
  dismissIdea(ideaId: string): void {
    this.db.prepare("INSERT INTO idea_approvals (idea_id, approved, approved_at) VALUES (?, 0, ?) ON CONFLICT(idea_id) DO UPDATE SET approved=0, approved_at=excluded.approved_at").run(ideaId, Date.now());
    this.db.prepare("UPDATE ideas SET status='rejected' WHERE id=?").run(ideaId);
  }
  getApproval(ideaId: string): { approved: boolean; mechanism: string; falsification: string } | null {
    const r = this.db.prepare("SELECT approved, mechanism, falsification FROM idea_approvals WHERE idea_id=?").get(ideaId) as { approved: number; mechanism: string; falsification: string } | undefined;
    return r ? { approved: r.approved === 1, mechanism: r.mechanism, falsification: r.falsification } : null;
  }
  setJudgeCriteria(criteria: Array<{ criterion: string; weight: number }>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM judge_criteria").run();
      for (const c of criteria) this.db.prepare("INSERT INTO judge_criteria (criterion, weight, created_at) VALUES (?,?,?)").run(c.criterion, c.weight, Date.now());
    });
    tx();
  }
  getJudgeCriteria(): Array<{ criterion: string; weight: number }> {
    return (this.db.prepare("SELECT criterion, weight FROM judge_criteria ORDER BY id").all() as Array<{ criterion: string; weight: number }>);
  }
}
