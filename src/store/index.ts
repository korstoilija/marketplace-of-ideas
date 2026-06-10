import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Idea, Claim, Evidence, Verdict, ClaimMarket, AgentState,
  Consensus, Distillate, PredictiveClaim, RentScore, Verification,
} from "../types/deliberation.js";
import { createMarket, buyShares, resolveMarket, computeRentScore } from "../market/lmsr.js";

const DEFAULT_DB_PATH = join(
  process.env["HOME"] ?? "/tmp",
  ".marketplace",
  "marketplace.db",
);

export class Store {
  db: ReturnType<typeof Database>;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        claims_json TEXT NOT NULL DEFAULT '[]',
        evidence_links_json TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT REFERENCES ideas(id),
        author TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'proposed'
      );

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id),
        text TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'factual',
        parent_claim_id TEXT REFERENCES claims(id)
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        source_url TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL,
        relevance REAL NOT NULL DEFAULT 0.5,
        submitted_by TEXT NOT NULL DEFAULT 'unknown',
        timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS verdicts (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        agent_id TEXT NOT NULL DEFAULT 'unknown',
        confidence REAL NOT NULL DEFAULT 0.5,
        reasoning TEXT NOT NULL DEFAULT '',
        evidence_reviewed_json TEXT NOT NULL DEFAULT '[]',
        timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        agent_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
        amount REAL NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS markets (
        claim_id TEXT PRIMARY KEY REFERENCES claims(id),
        yes_shares_json TEXT NOT NULL DEFAULT '{}',
        no_shares_json TEXT NOT NULL DEFAULT '{}',
        yes_price REAL NOT NULL DEFAULT 0.5,
        no_price REAL NOT NULL DEFAULT 0.5,
        liquidity REAL NOT NULL DEFAULT 1000,
        b REAL NOT NULL DEFAULT 100,
        resolution TEXT,
        resolved_at INTEGER,
        nomination_status TEXT NOT NULL DEFAULT 'none',
        nominated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        reputation REAL NOT NULL DEFAULT 0.5,
        token_balance REAL NOT NULL DEFAULT 1000,
        correct_predictions INTEGER NOT NULL DEFAULT 0,
        total_predictions INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS adjudications (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        outcome TEXT CHECK(outcome IN ('true', 'false', 'skip')),
        adjudicated_by TEXT NOT NULL DEFAULT 'human',
        adjudicated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS distillates (
        id TEXT PRIMARY KEY,
        round INTEGER NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        distilled_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS predictive_claims (
        claim_id TEXT PRIMARY KEY REFERENCES claims(id),
        prediction TEXT NOT NULL,
        verification_criteria TEXT NOT NULL DEFAULT '',
        prediction_date INTEGER NOT NULL,
        resolution_date INTEGER,
        outcome INTEGER,
        resolved INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        evidence_hash TEXT NOT NULL,
        reproducibility REAL NOT NULL DEFAULT 0,
        verified_at INTEGER,
        verified_by TEXT
      );

      CREATE TABLE IF NOT EXISTS training_examples (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id),
        evaluation_json TEXT NOT NULL,
        outcome INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
  }

  // ─── Ideas ───
  upsertIdea(idea: Idea) {
    this.db.prepare(`INSERT OR REPLACE INTO ideas (id, title, summary, body, claims_json, evidence_links_json, parent_id, author, created_at, version, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      idea.id, idea.title, idea.summary, idea.body,
      JSON.stringify(idea.claims), JSON.stringify(idea.evidenceLinks),
      idea.parentId ?? null, idea.author, idea.createdAt, idea.version, idea.status,
    );
    return idea.id;
  }

  getIdea(id: string): Idea | null {
    const row = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row["id"] as string,
      title: row["title"] as string,
      summary: row["summary"] as string,
      body: row["body"] as string,
      claims: JSON.parse(row["claims_json"] as string),
      evidenceLinks: JSON.parse(row["evidence_links_json"] as string),
      parentId: (row["parent_id"] as string) || undefined,
      author: row["author"] as string,
      createdAt: row["created_at"] as number,
      version: row["version"] as number,
      status: row["status"] as Idea["status"],
    };
  }

  searchIdeas(query: string): Idea[] {
    const q = `%${query}%`;
    const rows = this.db.prepare("SELECT * FROM ideas WHERE title LIKE ? OR summary LIKE ? OR body LIKE ? LIMIT 20").all(q, q, q) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r["id"] as string,
      title: r["title"] as string,
      summary: r["summary"] as string,
      body: r["body"] as string,
      claims: JSON.parse(r["claims_json"] as string),
      evidenceLinks: JSON.parse(r["evidence_links_json"] as string),
      parentId: (r["parent_id"] as string) || undefined,
      author: r["author"] as string,
      createdAt: r["created_at"] as number,
      version: r["version"] as number,
      status: r["status"] as Idea["status"],
    }));
  }

  getIdeaChildren(parentId: string): Idea[] {
    const rows = this.db.prepare("SELECT * FROM ideas WHERE parent_id = ?").all(parentId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r["id"] as string,
      title: r["title"] as string,
      summary: r["summary"] as string,
      body: r["body"] as string,
      claims: JSON.parse(r["claims_json"] as string),
      evidenceLinks: JSON.parse(r["evidence_links_json"] as string),
      parentId: parentId,
      author: r["author"] as string,
      createdAt: r["created_at"] as number,
      version: r["version"] as number,
      status: r["status"] as Idea["status"],
    }));
  }

  ideaCount() { return (this.db.prepare("SELECT COUNT(*) as c FROM ideas").get() as { c: number }).c; }

  // ─── Claims ───
  upsertClaim(claim: Claim) {
    this.db.prepare("INSERT OR REPLACE INTO claims (id, idea_id, text, type, parent_claim_id) VALUES (?,?,?,?,?)").run(
      claim.id, claim.ideaId, claim.text, claim.type, claim.parentClaimId ?? null,
    );
    return claim.id;
  }

  getClaim(id: string): Claim | null {
    const row = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row["id"] as string,
      ideaId: row["idea_id"] as string,
      text: row["text"] as string,
      type: row["type"] as Claim["type"],
      parentClaimId: (row["parent_claim_id"] as string) || undefined,
    };
  }

  getClaimsForIdea(ideaId: string): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE idea_id = ?").all(ideaId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r["id"] as string,
      ideaId: r["idea_id"] as string,
      text: r["text"] as string,
      type: r["type"] as Claim["type"],
      parentClaimId: (r["parent_claim_id"] as string) || undefined,
    }));
  }

  claimCount() { return (this.db.prepare("SELECT COUNT(*) as c FROM claims").get() as { c: number }).c; }

  // ─── Evidence ───
  insertEvidence(ev: Evidence) {
    this.db.prepare("INSERT INTO evidence (id, claim_id, source_url, excerpt, relevance, submitted_by, timestamp) VALUES (?,?,?,?,?,?,?)").run(
      ev.id, ev.claimId, ev.sourceUrl, ev.excerpt, ev.relevance, ev.submittedBy, ev.timestamp,
    );
    return ev.id;
  }

  getEvidenceForClaim(claimId: string): Evidence[] {
    const rows = this.db.prepare("SELECT * FROM evidence WHERE claim_id = ? ORDER BY timestamp").all(claimId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r["id"] as string,
      claimId: r["claim_id"] as string,
      sourceUrl: r["source_url"] as string,
      excerpt: r["excerpt"] as string,
      relevance: r["relevance"] as number,
      submittedBy: r["submitted_by"] as string,
      timestamp: r["timestamp"] as number,
    }));
  }

  // ─── Verdicts ───
  insertVerdict(verdict: Verdict) {
    this.db.prepare("INSERT INTO verdicts (id, claim_id, agent_id, confidence, reasoning, evidence_reviewed_json, timestamp) VALUES (?,?,?,?,?,?,?)").run(
      verdict.claimId + "-" + verdict.agentId + "-" + Date.now(),
      verdict.claimId, verdict.agentId, verdict.confidence, verdict.reasoning,
      JSON.stringify(verdict.evidenceReviewed), verdict.timestamp,
    );
  }

  getVerdictsForClaim(claimId: string): Verdict[] {
    const rows = this.db.prepare("SELECT * FROM verdicts WHERE claim_id = ?").all(claimId) as Record<string, unknown>[];
    return rows.map(r => ({
      claimId: r["claim_id"] as string,
      agentId: r["agent_id"] as string,
      confidence: r["confidence"] as number,
      reasoning: r["reasoning"] as string,
      evidenceReviewed: JSON.parse(r["evidence_reviewed_json"] as string),
      timestamp: r["timestamp"] as number,
    }));
  }

  // ─── Markets ───
  ensureMarket(claimId: string, liquidity = 1000, b = 100) {
    const existing = this.db.prepare("SELECT * FROM markets WHERE claim_id = ?").get(claimId);
    if (existing) return this.getMarket(claimId)!;
    const m = createMarket(claimId, liquidity, b);
    this.db.prepare("INSERT INTO markets (claim_id, yes_shares_json, no_shares_json, yes_price, no_price, liquidity, b) VALUES (?,?,?,?,?,?,?)").run(
      m.claimId, JSON.stringify(m.yesShares), JSON.stringify(m.noShares),
      m.yesPrice, m.noPrice, m.liquidity, m.b,
    );
    return m;
  }

  getMarket(claimId: string): ClaimMarket | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE claim_id = ?").get(claimId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      claimId: row["claim_id"] as string,
      yesShares: JSON.parse(row["yes_shares_json"] as string),
      noShares: JSON.parse(row["no_shares_json"] as string),
      yesPrice: row["yes_price"] as number,
      noPrice: row["no_price"] as number,
      liquidity: row["liquidity"] as number,
      b: row["b"] as number,
      resolution: (row["resolution"] as "true" | "false") || undefined,
      resolvedAt: row["resolved_at"] as number,
    };
  }

  saveMarket(market: ClaimMarket) {
    this.db.prepare(`UPDATE markets SET yes_shares_json=?, no_shares_json=?, yes_price=?, no_price=?, liquidity=?, b=?, resolution=?, resolved_at=? WHERE claim_id=?`).run(
      JSON.stringify(market.yesShares), JSON.stringify(market.noShares),
      market.yesPrice, market.noPrice, market.liquidity, market.b,
      market.resolution ?? null, market.resolvedAt ?? null,
      market.claimId,
    );
  }

  placeOrderAndUpdateMarket(claimId: string, agentId: string, side: "yes" | "no", amount: number): { market: ClaimMarket; avgPrice: number; error?: string } {
    const market = this.getMarket(claimId);
    if (!market) return { market: createMarket(claimId), avgPrice: 0, error: "market not found" };
    if (market.resolution) return { market, avgPrice: 0, error: "already resolved" };

    const agent = this.ensureAgent(agentId);
    if (agent.tokenBalance < amount) return { market, avgPrice: 0, error: `insufficient balance: ${agent.tokenBalance}` };

    agent.tokenBalance -= amount;
    this.saveAgent(agent);

    const orderId = `${claimId}-${agentId}-${Date.now()}`;
    this.db.prepare("INSERT INTO orders (id, claim_id, agent_id, side, amount, timestamp) VALUES (?,?,?,?,?,?)").run(
      orderId, claimId, agentId, side, amount, Date.now(),
    );

    const { market: newMarket, avgPrice } = buyShares(market, {
      claimId, agentId, side, amount, timestamp: Date.now(),
    });
    this.saveMarket(newMarket);
    return { market: newMarket, avgPrice };
  }

  settleMarket(claimId: string, outcome: boolean) {
    const market = this.getMarket(claimId);
    if (!market) return { error: "not found" };
    if (market.resolution) return { error: "already resolved" };

    const agentRows = this.db.prepare("SELECT * FROM agents").all() as Record<string, unknown>[];
    const agentMap: Record<string, AgentState> = {};
    for (const row of agentRows) {
      agentMap[row["agent_id"] as string] = {
        agentId: row["agent_id"] as string,
        reputation: row["reputation"] as number,
        tokenBalance: row["token_balance"] as number,
        correctPredictions: row["correct_predictions"] as number,
        totalPredictions: row["total_predictions"] as number,
      };
    }

    const { market: resolved, agents: updated } = resolveMarket(market, outcome, agentMap);
    this.saveMarket(resolved);

    for (const [id, a] of Object.entries(updated)) {
      this.saveAgent(a);
    }

    this.db.prepare("INSERT INTO adjudications (id, claim_id, outcome, adjudicated_at) VALUES (?,?,?,?)").run(
      `${claimId}-adj-${Date.now()}`, claimId, outcome ? "true" : "false", Date.now(),
    );

    const trainingId = `training-${claimId}-${Date.now()}`;
    const verdicts = this.getVerdictsForClaim(claimId);
    this.db.prepare("INSERT INTO training_examples (id, claim_id, evaluation_json, outcome) VALUES (?,?,?,?)").run(
      trainingId, claimId, JSON.stringify({ verdicts }), outcome ? 1 : 0,
    );

    return { market: resolved };
  }

  getMarketSummary(claimId: string) {
    const m = this.getMarket(claimId);
    if (!m) return null;
    const vs = this.getVerdictsForClaim(claimId);
    return {
      claim_id: claimId,
      yes_price: +m.yesPrice.toFixed(4),
      no_price: +m.noPrice.toFixed(4),
      yes_shares: Object.values(m.yesShares).reduce((a, b) => a + b, 0),
      no_shares: Object.values(m.noShares).reduce((a, b) => a + b, 0),
      resolution: m.resolution ?? null,
      verdict_count: vs.length,
      liquidity: m.liquidity,
    };
  }

  getActiveMarkets() {
    const rows = this.db.prepare("SELECT claim_id FROM markets WHERE resolution IS NULL").all() as Record<string, unknown>[];
    return rows.map(r => this.getMarketSummary(r["claim_id"] as string)).filter(Boolean);
  }

  getResolvedMarkets() {
    const rows = this.db.prepare("SELECT claim_id FROM markets WHERE resolution IS NOT NULL").all() as Record<string, unknown>[];
    return rows.map(r => this.getMarketSummary(r["claim_id"] as string)).filter(Boolean);
  }

  // ─── Agents ───
  ensureAgent(agentId: string): AgentState {
    const row = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (row) {
      return {
        agentId: row["agent_id"] as string,
        reputation: row["reputation"] as number,
        tokenBalance: row["token_balance"] as number,
        correctPredictions: row["correct_predictions"] as number,
        totalPredictions: row["total_predictions"] as number,
      };
    }
    const agent: AgentState = {
      agentId,
      reputation: 0.5,
      tokenBalance: 1000,
      correctPredictions: 0,
      totalPredictions: 0,
    };
    this.saveAgent(agent);
    return agent;
  }

  saveAgent(agent: AgentState) {
    this.db.prepare("INSERT OR REPLACE INTO agents (agent_id, reputation, token_balance, correct_predictions, total_predictions) VALUES (?,?,?,?,?)").run(
      agent.agentId, agent.reputation, agent.tokenBalance, agent.correctPredictions, agent.totalPredictions,
    );
  }

  getAllAgents(): AgentState[] {
    const rows = this.db.prepare("SELECT * FROM agents").all() as Record<string, unknown>[];
    return rows.map(r => ({
      agentId: r["agent_id"] as string,
      reputation: r["reputation"] as number,
      tokenBalance: r["token_balance"] as number,
      correctPredictions: r["correct_predictions"] as number,
      totalPredictions: r["total_predictions"] as number,
    }));
  }

  // ─── Divergence ───
  getDivergentClaims(minVerdicts = 2): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT claim_id, COUNT(*) as cnt FROM verdicts GROUP BY claim_id HAVING cnt >= ?").all(minVerdicts) as Record<string, unknown>[];
    const scored: Record<string, unknown>[] = [];
    for (const row of rows) {
      const claimId = row["claim_id"] as string;
      const vs = this.getVerdictsForClaim(claimId);
      const confs = vs.map(v => v.confidence);
      const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
      const variance = confs.reduce((s, c) => s + (c - mean) ** 2, 0) / confs.length;
      if (variance > 0) {
        const claim = this.getClaim(claimId);
        const m = this.getMarketSummary(claimId);
        scored.push({
          claim_id: claimId,
          claim_text: claim?.text ?? "",
          verdict_count: vs.length,
          mean: +mean.toFixed(3),
          variance: +variance.toFixed(4),
          divergence: +Math.sqrt(variance).toFixed(3),
          yes_price: m ? m.yes_price : 0.5,
        });
      }
    }
    scored.sort((a, b) => (b["variance"] as number) - (a["variance"] as number));
    return scored;
  }

  // ─── Distillates ───
  insertDistillate(d: Distillate) {
    const id = `distillate-${d.round}-${Date.now()}`;
    this.db.prepare("INSERT INTO distillates (id, round, data_json, distilled_at) VALUES (?,?,?,?)").run(
      id, d.round, JSON.stringify(d), d.distilledAt,
    );
    return id;
  }

  getDistillates(): Distillate[] {
    const rows = this.db.prepare("SELECT data_json FROM distillates ORDER BY round DESC").all() as Record<string, unknown>[];
    return rows.map(r => JSON.parse(r["data_json"] as string));
  }

  // ─── Training examples ───
  getTrainingExamples(): Array<{ claimId: string; evaluation: Record<string, unknown>; outcome: boolean }> {
    const rows = this.db.prepare("SELECT * FROM training_examples").all() as Record<string, unknown>[];
    return rows.map(r => ({
      claimId: r["claim_id"] as string,
      evaluation: JSON.parse(r["evaluation_json"] as string),
      outcome: (r["outcome"] as number) === 1,
    }));
  }

  // ─── State summary ───
  getSummary() {
    const active = (this.db.prepare("SELECT COUNT(*) as c FROM markets WHERE resolution IS NULL").get() as { c: number }).c;
    const settled = (this.db.prepare("SELECT COUNT(*) as c FROM markets WHERE resolution IS NOT NULL").get() as { c: number }).c;
    return {
      ideas: this.ideaCount(),
      claims: this.claimCount(),
      active_markets: active,
      settled_markets: settled,
      agents: this.getAllAgents().map(a => ({
        id: a.agentId,
        reputation: +a.reputation.toFixed(3),
        balance: +a.tokenBalance.toFixed(1),
        accuracy: a.totalPredictions > 0 ? +(a.correctPredictions / a.totalPredictions).toFixed(3) : null,
      })),
      distillates: (this.db.prepare("SELECT COUNT(*) as c FROM distillates").get() as { c: number }).c,
    };
  }

  close() { this.db.close(); }
}
